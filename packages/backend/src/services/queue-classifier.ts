import { z } from 'zod';
import { analyzeWithLLM } from './llm-api.js';
import { getPromptById } from './prompts.js';
import { runWithConcurrency } from '../utils/concurrency.js';
import {
  PROCESS_CATALOG,
  getProcessType,
  catalogForPrompt,
  isWrongQueue,
  type ProcessType,
} from './queue-process-catalog.js';
import type { EnrichedTaskRow } from './queue-analyser-query.js';

export type TaskStatus =
  | 'ready'
  | 'waiting_customer'
  | 'waiting_third_party'
  | 'needs_info'
  | 'actionable_now';

const STATUSES: TaskStatus[] = [
  'ready',
  'waiting_customer',
  'waiting_third_party',
  'needs_info',
  'actionable_now',
];

/** Per-task triage assignment (what the route persists per task). */
export interface TaskAssignment {
  kind: string;
  group_name: string;
  is_new_kind: boolean;
  the_work: string;
  destination: string | null;
  disposition: string;
  urgency: string;
  quick_win: boolean;
  sla_days: number | null;
  sla_status: string; // overdue | within | none
  status: TaskStatus;
  wrong_queue: boolean;
  suggested_queue: string | null;
  kb_ref: string | null;
}

/** One work group (catalog kind or LLM-proposed emergent kind). */
export interface WorkGroup {
  kind: string;
  name: string;
  is_new_kind: boolean;
  the_work: string;
  destination: string | null;
  disposition: string;
  urgency: string;
  quick_win: boolean;
  sla_days: number | null;
  kb_ref: string | null;
  member_task_ids: number[];
}

export interface QueueAnalysis {
  queue_summary: string;
  groups: WorkGroup[];
  byTask: Map<number, TaskAssignment>;
  promptContent: string;
  error: string | null;
}

const DEFINE_PROMPT_ID = 'queue-analyse-v2';
const ASSIGN_PROMPT_ID = 'queue-analyse-assign-v2';
const ASSIGN_BATCH = 25;
const MAX_NEW_KINDS = 4;

const NewKindSchema = z.object({ kind: z.string(), name: z.string(), the_work: z.string() });
const DefineSchema = z.object({ new_kinds: z.array(NewKindSchema) });

const URGENCY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

// ---- LLM JSON parse (3-tier) ----
function parseLlmJson(text: string): unknown {
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (jsonMatch) return JSON.parse(jsonMatch[1]);
  try {
    return JSON.parse(text);
  } catch {
    const extracted = extractJsonObject(text);
    if (extracted !== null) return extracted;
    throw new Error('No JSON object found in LLM response');
  }
}
function extractJsonObject(text: string): unknown | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return JSON.parse(text.substring(start, i + 1)); }
  }
  return null;
}

function fmtMoney(v: number | null): string {
  return v === null ? 'unknown' : `£${v.toFixed(2)}`;
}

/** Compact one-line-per-task dump fed to the LLM. */
function buildTaskLines(tasks: EnrichedTaskRow[]): string {
  return tasks
    .map((t) =>
      [
        `#${t.task_id}`,
        `type=${t.task_type ?? '?'}`,
        `age=${t.age_days}d`,
        `bal=${fmtMoney(t.total_balance)}`,
        `company=${t.company_status ?? 'unknown'}`,
        t.days_since_cessation != null ? `ceased=${t.days_since_cessation}d` : null,
        `cases=${t.case_statuses ?? 'none'}`,
        `attach=${t.has_attachments ? 'yes' : 'no'}`,
        t.multi_task_alias ? `alias_open=${t.n_alias_open}` : null,
        `title=${JSON.stringify(t.title ?? '')}`,
        t.description && t.description !== t.title ? `desc=${JSON.stringify(t.description.slice(0, 200))}` : null,
      ]
        .filter(Boolean)
        .join(' | '),
    )
    .join('\n');
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Parse compact "taskId:kind:status" lines. */
function parseAssignments(text: string): Map<number, { kind: string; status: string }> {
  const map = new Map<number, { kind: string; status: string }>();
  const re = /(\d{4,})\s*:\s*([a-z0-9_]+)\s*:\s*([a-z_]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    map.set(Number(m[1]), { kind: m[2].toLowerCase(), status: m[3].toLowerCase() });
  }
  return map;
}

/** The dissolved/liquidation/safe-close guardrails — financial truth overrides the LLM. */
function guardrailKind(t: EnrichedTaskRow): string | null {
  const cs = (t.company_status ?? '').toLowerCase();
  if (t.company_inactive && t.has_residual_balance) {
    if (/dissolv|struck|strike/.test(cs)) return 'dissolved_to_crown';
    if (/liquidat|administ/.test(cs)) return 'liquidation_to_practitioner';
    // inactive + balance but unknown subtype → treat as Crown (residual on an inactive co)
    return 'dissolved_to_crown';
  }
  if (t.safe_close_candidate) return 'safe_close';
  return null;
}

function slaStatus(ageDays: number, slaDays: number | null): string {
  if (slaDays == null) return 'none';
  return ageDays > slaDays ? 'overdue' : 'within';
}

function buildAssignment(
  t: EnrichedTaskRow,
  kind: string,
  status: TaskStatus,
  queueName: string,
  newKinds: Map<string, { name: string; the_work: string }>,
): TaskAssignment {
  const cat: ProcessType | undefined = getProcessType(kind);
  const isNew = !cat;
  const name = cat?.name ?? newKinds.get(kind)?.name ?? kind;
  const the_work = cat?.the_work ?? newKinds.get(kind)?.the_work ?? 'Review individually.';
  const urgency = cat?.urgency ?? 'medium';
  const quick_win = cat?.quick_win ?? false;
  const sla_days = cat?.sla_days ?? null;
  const destination = cat?.destination ?? null;
  const kb_ref = cat?.kb_refs[0] ?? null;
  const { wrong, suggested } = isWrongQueue(kind, queueName);
  return {
    kind,
    group_name: name,
    is_new_kind: isNew,
    the_work,
    destination,
    disposition: cat?.disposition ?? 'investigate',
    urgency,
    quick_win,
    sla_days,
    sla_status: slaStatus(t.age_days, sla_days),
    status,
    wrong_queue: wrong,
    suggested_queue: suggested,
    kb_ref,
  };
}

function buildGroups(tasks: EnrichedTaskRow[], byTask: Map<number, TaskAssignment>): WorkGroup[] {
  const byKind = new Map<string, WorkGroup>();
  for (const t of tasks) {
    const a = byTask.get(t.task_id);
    if (!a) continue;
    let g = byKind.get(a.kind);
    if (!g) {
      g = {
        kind: a.kind,
        name: a.group_name,
        is_new_kind: a.is_new_kind,
        the_work: a.the_work,
        destination: a.destination,
        disposition: a.disposition,
        urgency: a.urgency,
        quick_win: a.quick_win,
        sla_days: a.sla_days,
        kb_ref: a.kb_ref,
        member_task_ids: [],
      };
      byKind.set(a.kind, g);
    }
    g.member_task_ids.push(t.task_id);
  }
  return [...byKind.values()].sort(
    (x, y) =>
      (URGENCY_RANK[x.urgency] ?? 1) - (URGENCY_RANK[y.urgency] ?? 1) ||
      y.member_task_ids.length - x.member_task_ids.length,
  );
}

function fmtSummary(tasks: EnrichedTaskRow[], groups: WorkGroup[], byTask: Map<number, TaskAssignment>): string {
  const a = [...byTask.values()];
  const high = a.filter((x) => x.urgency === 'high').length;
  const quick = a.filter((x) => x.quick_win).length;
  const overdue = a.filter((x) => x.sla_status === 'overdue').length;
  const wrong = a.filter((x) => x.wrong_queue).length;
  const crown = tasks
    .filter((t) => t.company_inactive && (t.total_balance ?? 0) > 0.005)
    .reduce((s, t) => s + (t.total_balance ?? 0), 0);
  return `${tasks.length} open tasks across ${groups.length} work groups · ${high} high-urgency · ${quick} quick-win · ${overdue} overdue · ${wrong} wrong-queue · ${fmtMoney(Math.round(crown * 100) / 100)} to return to the Crown.`;
}

/** Deterministic fallback when the LLM is unavailable: guardrails + heuristic catalog match. */
function fallbackAssign(t: EnrichedTaskRow): { kind: string; status: TaskStatus } {
  const g = guardrailKind(t);
  if (g) return { kind: g, status: g === 'safe_close' || g === 'dissolved_to_crown' ? 'actionable_now' : 'needs_info' };
  if (t.multi_task_alias) return { kind: 'consolidate_duplicates', status: 'needs_info' };
  const text = `${t.title ?? ''} ${t.description ?? ''}`.toLowerCase();
  if (/mt103|gpi|swift|sepa|international|missing payment/.test(text)) return { kind: 'missing_intl_payment', status: t.has_attachments ? 'ready' : 'needs_info' };
  if (/retriev|recall/.test(text)) return { kind: 'retrieval_request', status: 'needs_info' };
  if (/decline|3ds|3d secure|pos|card/.test(text)) return { kind: 'pos_card_decline', status: 'needs_info' };
  if (/negative balance/.test(text)) return { kind: 'negative_balance', status: 'needs_info' };
  if (/closed account/.test(text)) return { kind: 'closed_account_return', status: 'needs_info' };
  return { kind: 'reroute_other_team', status: 'needs_info' };
}

/**
 * Stage 2 — KB-grounded hybrid analyst. Maps each task to a catalog work-type (the
 * authoritative process/SLA/urgency layer) or an LLM-proposed emergent kind, sets a
 * per-task status, and derives sla_status + wrong_queue in code. Financial guardrails
 * override the LLM so dissolved/liquidation/safe-close are always correct.
 * Two LLM passes to fit the proxy's tight output cap.
 */
export async function analyseQueue(
  tasks: EnrichedTaskRow[],
  queueName: string,
  model?: string,
): Promise<QueueAnalysis> {
  const definePrompt = await getPromptById(DEFINE_PROMPT_ID);
  const assignPrompt = await getPromptById(ASSIGN_PROMPT_ID);
  if (!definePrompt || !assignPrompt) throw new Error('Queue analyse prompts not found');
  const promptContent = `${definePrompt.content}\n---\n${assignPrompt.content}`;

  if (tasks.length === 0) {
    return { queue_summary: 'Queue is empty.', groups: [], byTask: new Map(), promptContent, error: null };
  }

  const opts = { ...(model ? { model } : {}), maxTokens: 8192 };
  const catalogText = catalogForPrompt();
  const newKinds = new Map<string, { name: string; the_work: string }>();

  try {
    // Pass 1 — define emergent kinds for tasks that fit no catalog kind
    const defineRes = await analyzeWithLLM(
      [
        { role: 'system', content: definePrompt.content },
        {
          role: 'user',
          content: `Queue: ${queueName}\n\nCATALOG:\n${catalogText}\n\nTASKS (${tasks.length}):\n${buildTaskLines(tasks)}`,
        },
      ],
      opts,
    );
    const defined = DefineSchema.parse(parseLlmJson(defineRes.content));
    for (const nk of defined.new_kinds.slice(0, MAX_NEW_KINDS)) {
      if (!getProcessType(nk.kind)) newKinds.set(nk.kind, { name: nk.name, the_work: nk.the_work });
    }

    // Pass 2 — assign each task to a kind + status, batched
    const kindList = [
      ...PROCESS_CATALOG.map((p) => `${p.kind} | ${p.name}`),
      ...[...newKinds.entries()].map(([k, v]) => `${k} | ${v.name}`),
    ].join('\n');
    const validKinds = new Set([...PROCESS_CATALOG.map((p) => p.kind), ...newKinds.keys()]);

    const batchMaps = await runWithConcurrency(
      chunk(tasks, ASSIGN_BATCH).map((batch) => async () => {
        const r = await analyzeWithLLM(
          [
            { role: 'system', content: assignPrompt.content },
            {
              role: 'user',
              content: `Queue: ${queueName}\n\nKINDS:\n${kindList}\n\nTASKS:\n${buildTaskLines(batch)}\n\nReturn one "task_id:kind:status" line per task.`,
            },
          ],
          opts,
        );
        return parseAssignments(r.content);
      }),
      3,
    );
    const llmAssign = new Map<number, { kind: string; status: string }>();
    for (const m of batchMaps) for (const [id, v] of m) llmAssign.set(id, v);

    const byTask = new Map<number, TaskAssignment>();
    for (const t of tasks) {
      const forced = guardrailKind(t);
      const llm = llmAssign.get(t.task_id);
      let kind = forced ?? (llm && validKinds.has(llm.kind) ? llm.kind : null) ?? fallbackAssign(t).kind;
      if (!validKinds.has(kind) && !getProcessType(kind)) kind = fallbackAssign(t).kind;
      let status: TaskStatus =
        llm && (STATUSES as string[]).includes(llm.status) ? (llm.status as TaskStatus) : 'needs_info';
      if (forced === 'safe_close' || forced === 'dissolved_to_crown') status = 'actionable_now';
      byTask.set(t.task_id, buildAssignment(t, kind, status, queueName, newKinds));
    }

    const groups = buildGroups(tasks, byTask);
    return { queue_summary: fmtSummary(tasks, groups, byTask), groups, byTask, promptContent, error: null };
  } catch (err) {
    const byTask = new Map<number, TaskAssignment>();
    for (const t of tasks) {
      const { kind, status } = fallbackAssign(t);
      byTask.set(t.task_id, buildAssignment(t, kind, status, queueName, newKinds));
    }
    const groups = buildGroups(tasks, byTask);
    return {
      queue_summary: `${fmtSummary(tasks, groups, byTask)} (deterministic — LLM analyst unavailable)`,
      groups,
      byTask,
      promptContent,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export { DEFINE_PROMPT_ID as QUEUE_ANALYSE_PROMPT_ID };

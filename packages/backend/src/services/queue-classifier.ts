import fs from 'node:fs';
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
import { type EnrichedTaskRow } from './queue-analyser-query.js';
import { fetchCaseActions } from './case-api.js';
import type { CaseAction } from '../types/dispute-pipeline.js';
import { runPhaseCheck } from './dispute-phase.js';

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
  /** Concrete next step for this specific task (free text, tight). */
  next_step: string | null;
  /** Evidence behind the kind/status/step (free text, tight). */
  rationale: string | null;
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
// Small batches: the stage proxy hard-kills requests at ~60s, and generation over real
// case-context runs ~4x slower than normal (~12 tok/s) — 8 tasks ≈ 400 output tokens ≈ 35s.
const ASSIGN_BATCH = 8;
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

const CTX_SECTION_MAX_CHARS = 250;
// Messages get a bigger budget AND keep the TAIL — the newest messages carry the
// who-spoke-last status signal; a head slice would cut exactly those.
const CTX_MESSAGES_MAX_CHARS = 600;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/**
 * Pack a case_context block (newline-separated sections) into one LLM line, capping each
 * SECTION instead of the whole block — a whole-block head slice always sacrificed the
 * trailing sections (messages, events) on context-heavy tasks. The per-section budgets
 * keep the line bounded for the slow stage proxy while every signal survives.
 */
function packCtxForLlm(caseContext: string): string {
  return caseContext
    .split('\n')
    .map((section) => {
      const s = section.trim();
      if (s.startsWith('messages=')) {
        return s.length <= CTX_MESSAGES_MAX_CHARS
          ? s
          : `messages=…${s.slice(-CTX_MESSAGES_MAX_CHARS)}`;
      }
      return truncate(s, CTX_SECTION_MAX_CHARS);
    })
    .join(' · ');
}

// TEMP diagnostics — remove once the stage-proxy 408s are understood.
function logLlm(line: string): void {
  try {
    fs.appendFileSync('/tmp/queue-llm.log', `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* diagnostics only */
  }
}

async function timedLlm(
  label: string,
  messages: Parameters<typeof analyzeWithLLM>[0],
  opts: Parameters<typeof analyzeWithLLM>[1],
): Promise<Awaited<ReturnType<typeof analyzeWithLLM>>> {
  const inChars = messages.reduce((s, m) => s + m.content.length, 0);
  const t = Date.now();
  try {
    const r = await analyzeWithLLM(messages, opts);
    logLlm(`${label} OK in=${inChars}ch out=${r.content.length}ch ${Date.now() - t}ms`);
    return r;
  } catch (err) {
    logLlm(`${label} FAIL in=${inChars}ch ${Date.now() - t}ms ${err instanceof Error ? err.message.slice(0, 120) : err}`);
    throw err;
  }
}

/**
 * Assign one batch; on failure bisect and retry the halves so one slow/poison task can't
 * sink its whole batch (the stage proxy 408s requests whose generation crawls on certain
 * case-context content). Tasks whose minimal sub-batch still fails are dropped — they get
 * the deterministic fallback assignment and the run carries on.
 */
async function assignBatch(
  batch: EnrichedTaskRow[],
  buildMessages: (batch: EnrichedTaskRow[]) => Parameters<typeof analyzeWithLLM>[0],
  opts: Parameters<typeof analyzeWithLLM>[1],
  label: string,
  dropped: number[],
): Promise<Map<number, ParsedAssignment>> {
  try {
    const r = await timedLlm(label, buildMessages(batch), opts);
    return parseAssignments(r.content);
  } catch {
    if (batch.length <= 4) {
      logLlm(`${label} dropped ${batch.length} task(s): ${batch.map((t) => t.task_id).join(',')}`);
      dropped.push(...batch.map((t) => t.task_id));
      return new Map();
    }
    const mid = Math.ceil(batch.length / 2);
    const [ma, mb] = await Promise.all([
      assignBatch(batch.slice(0, mid), buildMessages, opts, `${label}.a`, dropped),
      assignBatch(batch.slice(mid), buildMessages, opts, `${label}.b`, dropped),
    ]);
    return new Map([...ma, ...mb]);
  }
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
        // Case context (operator notes / history / assessment / comments / messages),
        // flattened to one line so each task stays on a single line for the assign parser.
        // Per-section caps: outliers run to 20KB+ and a batch of those pushes the proxy
        // past its ~60s internal limit (408).
        t.case_context ? `ctx=${JSON.stringify(packCtxForLlm(t.case_context))}` : null,
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

interface ParsedAssignment {
  kind: string;
  status: string;
  next_step: string | null;
  rationale: string | null;
}

/** Parse "taskId:kind:status | do=… | why=…" lines (do/why optional for robustness). */
function parseAssignments(text: string): Map<number, ParsedAssignment> {
  const map = new Map<number, ParsedAssignment>();
  for (const line of text.split('\n')) {
    const m = line.match(/(\d{4,})\s*:\s*([a-z0-9_]+)\s*:\s*([a-z_]+)(.*)/i);
    if (!m) continue;
    const tail = m[4] ?? '';
    const doM = tail.match(/\bdo=([^|]+)/i);
    const whyM = tail.match(/\bwhy=(.+)$/i);
    map.set(Number(m[1]), {
      kind: m[2].toLowerCase(),
      status: m[3].toLowerCase(),
      next_step: doM?.[1]?.trim() || null,
      rationale: whyM?.[1]?.trim() || null,
    });
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

/** Deterministic next_step/rationale for guardrail-forced kinds (the LLM never sees these). */
function guardrailNote(t: EnrichedTaskRow, kind: string): { next_step: string; rationale: string } | null {
  const bal = fmtMoney(t.total_balance);
  if (kind === 'dissolved_to_crown') {
    return {
      next_step: `Return ${bal} residual balance to the Crown (bona vacantia) and close the account`,
      rationale: `Company ${t.company_status ?? 'inactive'} with residual balance ${bal} — financial guardrail`,
    };
  }
  if (kind === 'liquidation_to_practitioner') {
    return {
      next_step: `Send ${bal} to the insolvency practitioner and close the account`,
      rationale: `Company in ${t.company_status ?? 'liquidation'} with residual balance ${bal} — financial guardrail`,
    };
  }
  if (kind === 'safe_close') {
    return {
      next_step: 'Close the task — nothing left to action',
      rationale: 'Zero balance and all cases done — safe-close guardrail',
    };
  }
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
  nextStep: string | null = null,
  rationale: string | null = null,
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
    next_step: nextStep,
    rationale,
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

  let defineError: string | null = null;
  try {
    // Pass 1 — define emergent kinds for tasks that fit no catalog kind. This is the one
    // request carrying ALL tasks with full ctx, so it's the slowest call of the run — if it
    // times out, proceed catalog-only rather than abandoning the batched assign pass too.
    try {
      const defineRes = await timedLlm(
        'define',
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
    } catch (err) {
      defineError = err instanceof Error ? err.message : String(err);
    }

    // Pass 2 — assign each task to a kind + status, batched
    const kindList = [
      ...PROCESS_CATALOG.map((p) => `${p.kind} | ${p.name}`),
      ...[...newKinds.entries()].map(([k, v]) => `${k} | ${v.name}`),
    ].join('\n');
    const validKinds = new Set([...PROCESS_CATALOG.map((p) => p.kind), ...newKinds.keys()]);

    const buildMessages = (batch: EnrichedTaskRow[]): Parameters<typeof analyzeWithLLM>[0] => [
      { role: 'system', content: assignPrompt.content },
      {
        role: 'user',
        content: `Queue: ${queueName}\n\nKINDS:\n${kindList}\n\nTASKS:\n${buildTaskLines(batch)}\n\nReturn one "task_id:kind:status | do=… | why=…" line per task.`,
      },
    ];
    const droppedTaskIds: number[] = [];
    const batchMaps = await runWithConcurrency(
      chunk(tasks, ASSIGN_BATCH).map((batch, bi) => () =>
        assignBatch(batch, buildMessages, opts, `assign[${bi}]`, droppedTaskIds),
      ),
      3,
    );
    const llmAssign = new Map<number, ParsedAssignment>();
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
      // Guardrail-forced kinds get deterministic text; otherwise the LLM's do/why.
      const note = forced ? guardrailNote(t, forced) : null;
      byTask.set(
        t.task_id,
        buildAssignment(t, kind, status, queueName, newKinds, note?.next_step ?? llm?.next_step ?? null, note?.rationale ?? llm?.rationale ?? null),
      );
    }

    const groups = buildGroups(tasks, byTask);
    return {
      queue_summary: fmtSummary(tasks, groups, byTask),
      groups,
      byTask,
      promptContent,
      error:
        [
          defineError ? `define pass failed (catalog kinds only): ${defineError}` : null,
          droppedTaskIds.length
            ? `${droppedTaskIds.length} task(s) fell back to deterministic assignment after LLM timeouts: ${droppedTaskIds.join(', ')}`
            : null,
        ]
          .filter(Boolean)
          .join(' · ') || null,
    };
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

// =====================================================================================
// Disputes group — phase-based classification (not catalog kinds).
// Each dispute task's case is run through the dispute-phase-check Timeline Analyzer, and
// the structured dispute case actions (task_manager_case_actions) provide a deterministic
// phase floor that cross-checks the LLM. Work groups become phases.
// =====================================================================================

const DISPUTE_PHASE_CONCURRENCY = 4;

interface PhaseSpec {
  title: string;
  status: TaskStatus;
  urgency: Urgency;
  sla_days: number | null;
  the_work: string;
}

type Urgency = 'high' | 'medium' | 'low';

/** Ordered phase keys; index = rank (higher = further along). */
const PHASE_ORDER = ['0', '1', '2a', '2b', '3', '4', '5'] as const;
type PhaseKey = (typeof PHASE_ORDER)[number] | 'NEW';

const PHASE_SPECS: Record<PhaseKey, PhaseSpec> = {
  '0': { title: 'Phase 0: Initial Contact', status: 'needs_info', urgency: 'medium', sla_days: 14, the_work: 'Engage the customer; gather initial dispute info.' },
  '1': { title: 'Phase 1: Assessment', status: 'actionable_now', urgency: 'high', sla_days: 14, the_work: 'Assess eligibility and dispute timeframe; issue the form or advise.' },
  '2a': { title: 'Phase 2a: Dispute form sent', status: 'waiting_customer', urgency: 'low', sla_days: 14, the_work: 'Awaiting the customer to complete and return the dispute form.' },
  '2b': { title: 'Phase 2b: Awaiting signature', status: 'waiting_customer', urgency: 'low', sla_days: 14, the_work: 'Form filled; awaiting the customer signature.' },
  '3': { title: 'Phase 3: Review & Preparation', status: 'actionable_now', urgency: 'high', sla_days: null, the_work: 'Review the submitted form/evidence and raise the dispute.' },
  '4': { title: 'Phase 4: Raised with Provider', status: 'waiting_third_party', urgency: 'low', sla_days: 45, the_work: 'Raised with the provider; awaiting their response (up to 45 days).' },
  '5': { title: 'Phase 5: Merchant Challenge', status: 'waiting_third_party', urgency: 'medium', sla_days: null, the_work: 'Merchant challenged; review next steps (re-present / pre-arbitration).' },
  NEW: { title: 'Dispute — phase unknown', status: 'needs_info', urgency: 'medium', sla_days: null, the_work: 'Review individually — insufficient timeline data to place a phase.' },
};

function phaseRank(key: PhaseKey): number {
  const i = (PHASE_ORDER as readonly string[]).indexOf(key);
  return i === -1 ? -1 : i; // NEW → -1 (weakest)
}

/** Normalise the LLM's current_phase string ("Phase 2a", "Phase 4", "NEW", …) to a PhaseKey. */
function parsePhaseKey(raw: string | undefined): PhaseKey {
  if (!raw) return 'NEW';
  const m = raw.match(/phase\s*([0-5][ab]?)/i);
  if (!m) return 'NEW';
  const k = m[1].toLowerCase();
  return (PHASE_ORDER as readonly string[]).includes(k) ? (k as PhaseKey) : 'NEW';
}

/** Deterministic phase floor from the structured case actions. */
function actionPhaseFloor(actions: CaseAction[]): PhaseKey | null {
  if (actions.some((a) => a.action_type === 'HANDOVER')) return '4';
  if (actions.some((a) => a.action_type === 'DISPUTE_FORM_FILLED' && a.status === 'CLOSED')) return '3';
  if (actions.some((a) => a.action_type === 'DISPUTE_FORM_FILLED' && a.status === 'OPEN')) return '2a';
  return null;
}

function fmtActions(actions: CaseAction[]): string {
  // created_at arrives as a full ISO timestamp from the live API; the day is enough here.
  return actions.map((a) => `${a.created_at.slice(0, 10)} ${a.action_type} ${a.status}`).join(' | ');
}

function disputeAssignment(
  t: EnrichedTaskRow,
  key: PhaseKey,
  nextAction: string | null,
  rationale: string | null,
): TaskAssignment {
  const spec = PHASE_SPECS[key];
  return {
    kind: `dispute_phase_${key.toLowerCase()}`,
    group_name: spec.title,
    is_new_kind: false,
    // the_work stays the phase-level description (it labels the group); the per-task
    // LLM next action goes to next_step so one task's step doesn't name the whole phase.
    the_work: spec.the_work,
    destination: null,
    disposition: 'investigate',
    urgency: spec.urgency,
    quick_win: false,
    sla_days: spec.sla_days,
    sla_status: slaStatus(t.age_days, spec.sla_days),
    status: spec.status,
    wrong_queue: false,
    suggested_queue: null,
    kb_ref: null,
    next_step: nextAction?.trim() || null,
    rationale,
  };
}

/**
 * Stage 2 for the Disputes group. Runs the dispute phase-check per linked case (grounded by the
 * structured case actions), derives a phase (LLM ∨ deterministic action floor — whichever is
 * further along), and groups tasks by phase. Financial guardrails still override (a dissolved
 * company with residual balance is return-to-Crown regardless of dispute phase).
 */
export async function analyseDisputeQueue(
  tasks: EnrichedTaskRow[],
  queueName: string,
  casesByTask: Map<number, number[]>,
  _model?: string,
): Promise<QueueAnalysis> {
  const promptContent = (await getPromptById('dispute-phase-check'))?.content ?? 'dispute-phase-check';
  if (tasks.length === 0) {
    return { queue_summary: 'Queue is empty.', groups: [], byTask: new Map(), promptContent, error: null };
  }

  // Primary case per task = first entry (queue-live-content sorts IN_PROGRESS-first,
  // newest-first). Case actions come live from the tasks service.
  const taskCase = new Map<number, number>();
  for (const t of tasks) {
    const ids = casesByTask.get(t.task_id);
    if (ids && ids.length > 0) taskCase.set(t.task_id, ids[0]);
  }
  const caseIds = [...new Set([...taskCase.values()])];
  const actionsByCase = new Map<number, CaseAction[]>();
  await runWithConcurrency(
    caseIds.map((caseId) => async () => {
      const actions = await fetchCaseActions(caseId).catch(() => [] as CaseAction[]);
      actionsByCase.set(
        caseId,
        actions.filter((a) => a.action_type),
      );
    }),
    DISPUTE_PHASE_CONCURRENCY,
  );

  const byTask = new Map<number, TaskAssignment>();
  let llmError: string | null = null;

  const empty = new Map<string, { name: string; the_work: string }>();

  await runWithConcurrency(
    tasks.map((t) => async () => {
      // Financial guardrail wins over phase (rare for disputes, but correct).
      const forced = guardrailKind(t);
      if (forced) {
        const status: TaskStatus = forced === 'safe_close' || forced === 'dissolved_to_crown' ? 'actionable_now' : 'needs_info';
        const note = guardrailNote(t, forced);
        byTask.set(t.task_id, buildAssignment(t, forced, status, queueName, empty, note?.next_step ?? null, note?.rationale ?? null));
        return;
      }

      const caseId = taskCase.get(t.task_id);
      const actions = caseId ? (actionsByCase.get(caseId) ?? []) : [];
      if (actions.length > 0) {
        const line = `case_actions=${fmtActions(actions)}`;
        t.case_context = t.case_context ? `${t.case_context}\n${line}` : line;
      }

      let key: PhaseKey = 'NEW';
      let nextAction: string | null = null;
      let rationale: string | null = null;
      if (caseId) {
        try {
          const phase = await runPhaseCheck(caseId, { extraContext: actions.length ? fmtActions(actions) : undefined });
          const llmKey = parsePhaseKey(phase?.current_phase);
          const floor = actionPhaseFloor(actions);
          key = floor && phaseRank(floor) > phaseRank(llmKey) ? floor : llmKey;
          nextAction = typeof phase?.next_action === 'string' ? phase.next_action : null;
          rationale = typeof phase?.notes === 'string' && phase.notes.trim() ? phase.notes.trim() : null;
          if (floor && phaseRank(floor) > phaseRank(llmKey)) {
            rationale = [`Phase floor ${floor} from case actions overrides LLM ${llmKey}`, rationale].filter(Boolean).join(' — ');
          }
        } catch (err) {
          llmError = err instanceof Error ? err.message : String(err);
          key = actionPhaseFloor(actions) ?? 'NEW';
          rationale = actions.length ? `Phase from case actions (phase-check failed): ${fmtActions(actions)}` : null;
        }
      } else {
        // No case raised yet → Phase 0.
        key = '0';
        rationale = 'No dispute case raised yet for this task';
      }

      byTask.set(t.task_id, disputeAssignment(t, key, nextAction, rationale));
    }),
    DISPUTE_PHASE_CONCURRENCY,
  );

  const groups = buildGroups(tasks, byTask);
  const a = [...byTask.values()];
  const waitC = a.filter((x) => x.status === 'waiting_customer').length;
  const waitT = a.filter((x) => x.status === 'waiting_third_party').length;
  const actionable = a.filter((x) => x.status === 'actionable_now' || x.status === 'ready').length;
  const summary = `${tasks.length} dispute tasks across ${groups.length} phases · ${actionable} actionable now · ${waitC} waiting on customer · ${waitT} waiting on provider${llmError ? ' (some phase-checks failed)' : ''}`;

  return { queue_summary: summary, groups, byTask, promptContent, error: llmError };
}

export { DEFINE_PROMPT_ID as QUEUE_ANALYSE_PROMPT_ID };

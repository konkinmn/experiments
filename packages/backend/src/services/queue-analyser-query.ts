import { getBigQueryService } from './bigquery.js';
import type { WsAgentTask } from './case-api.js';

/** The id/alias/created_at triple the per-task queries key off. */
export interface TaskRef {
  task_id: number;
  alias: string | null;
  created_at: string;
  /** Case-action queue items carry their case directly and have no agent-task activity. */
  direct_case_id?: number | null;
  is_case_action?: boolean;
}

/**
 * One open task enriched with the financial / company / relational facts that
 * determine the REAL work — independent of case status. No verdict is assigned
 * here; Stage 2 (the LLM analyst) groups and decides from these facts.
 *
 * Validated live 2026-06-04: of 82 open PAS tasks, 70 carry a balance, 10 are on
 * inactive (dissolved/liquidation/administration) companies and ALL 10 still hold
 * residual money — i.e. "return to Crown" real work, not closeable.
 */
export interface EnrichedTaskRow {
  task_id: number;
  alias: string | null;
  title: string | null;
  description: string | null;
  task_type: string | null;
  rb_jira_sync: boolean | null;
  created_by: string | null;
  taken_by: string | null;
  created_at: string;
  age_days: number;
  // Cases — context only, NOT a verdict
  n_cases: number;
  n_active: number;
  n_done: number;
  case_statuses: string | null;
  // Money
  total_balance: number | null;
  currency: string | null;
  account_statuses: string | null;
  account_closed: boolean;
  // Company
  company_status: string | null;
  date_ceased_on: string | null;
  days_since_cessation: number | null;
  company_number: string | null;
  company_title: string | null;
  // Same-alias siblings (across all statuses / groups)
  n_alias_open: number;
  n_alias_closed: number;
  // Readiness signal: does the task carry attachments (e.g. MT103 / GPI doc)?
  n_attachments: number;
  has_attachments: boolean;
  // Soft flags — hints for Stage 2, not the answer
  has_residual_balance: boolean;
  company_inactive: boolean;
  multi_task_alias: boolean;
  safe_close_candidate: boolean;
  // Compact case-content block assembled from fetchCaseAggregates (case-framed comments /
  // events / assessment) + fetchRecentMessages (alias-latest chat). Null when nothing inside.
  // Full case-content block — persisted, shown in the drawer, and fed to the LLM classifier.
  case_context: string | null;
}

/** Per-task aggregate of operator notes (task_manager_comments) + case-framed content. */
export interface CaseAggregate {
  task_id: number;
  task_notes_text: string | null;
  history_text: string | null;
  comments_text: string | null;
  events_text: string | null;
  assessment_text: string | null;
}

// Messages: per-task window [task.created_at − lead, now] — the conversation that led to
// the task plus everything since, regardless of how old the task is.
export const TASK_WINDOW_LEAD_DAYS = 5;
export const RAW_MSGS_PER_TASK = 60; // fetched per dialogue before dedupe
const MSGS_PER_TASK = 25; // kept after collapsing consecutive duplicates
export const DIALOGUES_PER_TASK = 3; // dialogues considered per task

// The open-task LIST comes live from the workstation tasks API (fetchOpenAgentTasks) —
// the export table lags. This query only computes the analytical joins (cases, balances,
// company, alias siblings) for the task ids/aliases handed in as parallel arrays.
export const QUEUE_ENRICH_QUERY = `
WITH open_tasks AS (
  SELECT ids AS task_id, NULLIF(als, '') AS alias
  FROM UNNEST(@taskIds) AS ids WITH OFFSET o1
  JOIN UNNEST(@aliases) AS als WITH OFFSET o2 ON o1 = o2
),
ba AS (
  SELECT alias, public_id, company_id, status AS acct_status, currency
  FROM \`anna-money.export.balance_account\`
  WHERE alias IN (SELECT alias FROM open_tasks)
),
latest_bal AS (
  SELECT balance_account__public_id, balance FROM (
    SELECT balance_account__public_id, balance,
      ROW_NUMBER() OVER (PARTITION BY balance_account__public_id ORDER BY date DESC) AS rn
    FROM \`anna-money.trusted.int_business_account__daily_accounts_balances\`
    WHERE balance_account__public_id IN (SELECT public_id FROM ba)
      AND date >= DATE_SUB(CURRENT_DATE(), INTERVAL 21 DAY)
  ) WHERE rn = 1
),
acct AS (
  SELECT
    ba.alias,
    CAST(ROUND(SUM(COALESCE(lb.balance, 0)), 2) AS FLOAT64) AS total_balance,
    STRING_AGG(DISTINCT ba.acct_status) AS account_statuses,
    STRING_AGG(DISTINCT ba.currency) AS currency,
    LOGICAL_OR(ba.acct_status = 'CLOSED') AS account_closed,
    ANY_VALUE(ba.company_id) AS company_id
  FROM ba LEFT JOIN latest_bal lb ON lb.balance_account__public_id = ba.public_id
  GROUP BY ba.alias
),
comp AS (
  SELECT
    public_id AS company_id,
    ANY_VALUE(status) AS company_status,
    CAST(ANY_VALUE(date_ceased_on) AS STRING) AS date_ceased_on,
    ANY_VALUE(company_number) AS company_number,
    ANY_VALUE(title) AS company_title
  FROM \`anna-money.export.account_company\`
  WHERE public_id IN (SELECT company_id FROM acct)
  GROUP BY public_id
),
alias_tasks AS (
  SELECT alias,
    COUNTIF(status = 'OPEN') AS n_open,
    COUNTIF(status != 'OPEN') AS n_closed
  FROM \`anna-money.export.task_manager_agent_tasks\`
  WHERE alias IN (SELECT alias FROM open_tasks)
  GROUP BY alias
)
SELECT
  t.task_id, t.alias,
  a.total_balance,
  a.currency,
  a.account_statuses,
  COALESCE(a.account_closed, FALSE) AS account_closed,
  c.company_status,
  c.date_ceased_on,
  CASE WHEN c.date_ceased_on IS NOT NULL
       THEN DATE_DIFF(CURRENT_DATE(), DATE(c.date_ceased_on), DAY) END AS days_since_cessation,
  c.company_number,
  c.company_title,
  COALESCE(al.n_open, 1) AS n_alias_open,
  COALESCE(al.n_closed, 0) AS n_alias_closed,
  COALESCE(a.total_balance, 0) > 0.005 AS has_residual_balance,
  LOWER(COALESCE(c.company_status, '')) IN ('dissolved', 'liquidation', 'administration', 'closed', 'struck_off', 'strike_off', 'in_administration') AS company_inactive,
  COALESCE(al.n_open, 1) > 1 AS multi_task_alias
FROM open_tasks t
LEFT JOIN acct a ON a.alias = t.alias
LEFT JOIN comp c ON c.company_id = a.company_id
LEFT JOIN alias_tasks al ON al.alias = t.alias
`;

// The daily-balances table is ~190M rows; this query bills ~12 GB on a PAS-sized
// queue. Cap generously. Follow-up: evaluate a cheaper current-balance source.
const MAX_BYTES_BILLED = '32212254720'; // 30 GB

type EnrichContextRow = Omit<
  EnrichedTaskRow,
  | 'title' | 'description' | 'task_type' | 'rb_jira_sync' | 'created_by' | 'taken_by'
  | 'created_at' | 'age_days' | 'n_attachments' | 'has_attachments' | 'case_context'
  // Case stats come live from the WS case service (queue-live-content); the route fills
  // them and derives safe_close_candidate after both sources resolve.
  | 'n_cases' | 'n_active' | 'n_done' | 'case_statuses' | 'safe_close_candidate'
>;

/**
 * Merge the live WS task list with the BigQuery analytical context. WS is authoritative
 * for which tasks are open and their own fields; BQ supplies cases/balances/company/
 * sibling stats keyed by the WS-provided ids and aliases.
 */
export async function fetchQueueEnriched(wsTasks: WsAgentTask[]): Promise<EnrichedTaskRow[]> {
  if (wsTasks.length === 0) return [];
  const bq = getBigQueryService();
  const rows = await bq.query<EnrichContextRow>(
    QUEUE_ENRICH_QUERY,
    {
      taskIds: wsTasks.map((t) => t.id),
      aliases: wsTasks.map((t) => t.alias ?? ''),
    },
    { maximumBytesBilled: MAX_BYTES_BILLED },
  );
  const ctxByTask = new Map(rows.map((r) => [r.task_id, r]));
  const now = Date.now();
  return wsTasks
    .map((ws) => {
      const ctx = ctxByTask.get(ws.id);
      const nAttachments = Array.isArray(ws.attachments) ? ws.attachments.length : 0;
      return {
        task_id: ws.id,
        alias: ws.alias,
        title: ws.title,
        description: ws.description,
        task_type: ws.task_type,
        rb_jira_sync: ws.rb_jira_sync,
        created_by: ws.created_by,
        taken_by: ws.taken_by,
        created_at: ws.created_at,
        age_days: Math.max(0, Math.floor((now - new Date(ws.created_at).getTime()) / 86_400_000)),
        // Filled by the route from live WS case data (queue-live-content).
        n_cases: 0,
        n_active: 0,
        n_done: 0,
        case_statuses: null,
        total_balance: ctx?.total_balance ?? null,
        currency: ctx?.currency ?? null,
        account_statuses: ctx?.account_statuses ?? null,
        account_closed: ctx?.account_closed ?? false,
        company_status: ctx?.company_status ?? null,
        date_ceased_on: ctx?.date_ceased_on ?? null,
        days_since_cessation: ctx?.days_since_cessation ?? null,
        company_number: ctx?.company_number ?? null,
        company_title: ctx?.company_title ?? null,
        n_alias_open: ctx?.n_alias_open ?? 1,
        n_alias_closed: ctx?.n_alias_closed ?? 0,
        n_attachments: nAttachments,
        has_attachments: nAttachments > 0,
        has_residual_balance: ctx?.has_residual_balance ?? false,
        company_inactive: ctx?.company_inactive ?? false,
        multi_task_alias: ctx?.multi_task_alias ?? false,
        safe_close_candidate: false, // derived by the route once live case stats land
        case_context: null,
      } satisfies EnrichedTaskRow;
    })
    .sort((a, b) => b.age_days - a.age_days);
}

/** WorkStation deep link for a CASE (used for case-action queue items). */
export function buildCaseWsLink(alias: string | null, caseId: number): string | null {
  if (!alias) return null;
  return `https://chat-workstation.k1.anna.money/${alias}/tasks/cases?chatWindow=chat&caseId=${caseId}`;
}

/** Build a WorkStation deep link for a task (null when no alias). With a taskId, links straight to the task chat. */
export function buildTaskWsLink(alias: string | null, taskId?: number | null): string | null {
  if (!alias) return null;
  if (taskId == null) return `https://chat-workstation.k1.anna.money/${alias}/tasks`;
  return `https://chat-workstation.k1.anna.money/${alias}/tasks/agent-tasks?chatWindow=chat&taskId=${taskId}`;
}

// ---- Case comments (the one context piece without a live API) ---------------------------
// comment_comment belongs to a separate comments service with no read API in scope;
// everything else (notes, history, events, assessments, messages) now comes live from WS.
const QUEUE_CASE_COMMENTS_QUERY = `
SELECT CAST(REGEXP_EXTRACT(cm.page_id, r'case:(\\d+)') AS INT64) AS case_id,
  STRING_AGG(
    CONCAT(FORMAT_TIMESTAMP('%Y-%m-%d', cm.created_at), ' ', COALESCE(cm.author_alias, '?'), ': ',
           TRIM(REGEXP_REPLACE(cm.body, r'\\s+', ' '))),
    ' | ' ORDER BY cm.created_at ASC) AS comments_text
FROM \`anna-money.export.comment_comment\` cm
WHERE cm.page_id IN UNNEST(@pageIds)
  AND cm.deleted_at IS NULL AND cm.body IS NOT NULL AND cm.body != ''
GROUP BY case_id
`;

/** Case comments keyed by case_id (oldest→newest one-liner per case). */
export async function fetchCaseCommentsByCaseIds(caseIds: number[]): Promise<Map<number, string>> {
  if (caseIds.length === 0) return new Map();
  const bq = getBigQueryService();
  const rows = await bq.query<{ case_id: number; comments_text: string }>(
    QUEUE_CASE_COMMENTS_QUERY,
    { pageIds: caseIds.map((id) => `case:${id}`) },
    { maximumBytesBilled: MAX_BYTES_BILLED },
  );
  return new Map(rows.map((r) => [r.case_id, r.comments_text]));
}

// ---- Alias-latest chat messages ----------------------------------------------------------
// Messages hang off dialogues (task_manager_tasks), which hang off the business alias. We
// take the most-recent dialogues per alias and their latest messages — "who spoke last" is
// the status signal. Partition-pruned on DATE(timestamp); given the table size this is the
// cost driver, so it gets a dedicated cap.
/** Per-task chat summary: collapsed one-liner + who spoke last (the status signal). */
export interface TaskMessages {
  text: string; // oldest→newest, consecutive duplicates collapsed to "… (×N)"
  lastDay: string; // YYYY-MM-DD of the newest message
  lastSender: string; // customer | operator | bot
}

export interface TaskMessageRow {
  task_id: number;
  day: string;
  sender: string;
  text: string;
}

/**
 * Rows arrive oldest-first per task (ORDER BY rn DESC, rn 1 = newest). Collapse
 * consecutive duplicates (bot retry spam: "transaction declined" ×3), keep the newest
 * MSGS_PER_TASK lines, and record who spoke last.
 */
export function buildTaskMessages(rows: TaskMessageRow[]): Map<number, TaskMessages> {
  const byTask = new Map<number, TaskMessageRow[]>();
  for (const r of rows) {
    const list = byTask.get(r.task_id) ?? [];
    list.push(r);
    byTask.set(r.task_id, list);
  }
  const out = new Map<number, TaskMessages>();
  for (const [taskId, msgs] of byTask) {
    const collapsed: { line: string; count: number; key: string }[] = [];
    for (const m of msgs) {
      const key = `${m.sender}|${m.text}`;
      const prev = collapsed[collapsed.length - 1];
      if (prev && prev.key === key) prev.count++;
      else collapsed.push({ line: `${m.day} ${m.sender}: ${m.text}`, count: 1, key });
    }
    const lines = collapsed
      .slice(-MSGS_PER_TASK)
      .map((c) => (c.count > 1 ? `${c.line} (×${c.count})` : c.line));
    const last = msgs[msgs.length - 1];
    out.set(taskId, { text: lines.join(' | '), lastDay: last.day, lastSender: last.sender });
  }
  return out;
}

/** Stitch the case-framed aggregate + chat messages into one compact block. */
export function assembleCaseContext(
  agg: CaseAggregate | undefined,
  messages: TaskMessages | undefined,
): string | null {
  const parts: string[] = [];
  if (agg?.task_notes_text) parts.push(`task_notes=${agg.task_notes_text}`);
  if (agg?.history_text) parts.push(`task_history=${agg.history_text}`);
  if (agg?.assessment_text) parts.push(`assessment=${agg.assessment_text}`);
  if (agg?.comments_text) parts.push(`case_comments=${agg.comments_text}`);
  if (agg?.events_text) parts.push(`events=${agg.events_text}`);
  if (messages) {
    const silentDays = Math.max(
      0,
      Math.floor((Date.now() - new Date(`${messages.lastDay}T00:00:00Z`).getTime()) / 86_400_000),
    );
    // Tiny and ahead of messages= so it survives any truncation — the explicit
    // who-spoke-last / how-long-silent status signal.
    parts.push(`last_msg=${messages.lastSender} ${messages.lastDay} (${silentDays}d silent)`);
    parts.push(`messages=${messages.text}`);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}


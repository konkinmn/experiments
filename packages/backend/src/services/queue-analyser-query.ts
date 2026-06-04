import { getBigQueryService } from './bigquery.js';

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
}

export const QUEUE_ENRICH_QUERY = `
WITH open_tasks AS (
  SELECT
    t.id AS task_id, t.alias, t.title, t.description, t.task_type, t.rb_jira_sync,
    t.created_by, t.taken_by, t.created_at,
    ARRAY_LENGTH(t.attachments) AS n_attachments,
    DATE_DIFF(CURRENT_DATE(), DATE(t.created_at), DAY) AS age_days
  FROM \`anna-money.export.task_manager_agent_tasks\` t
  WHERE t.status = 'OPEN' AND t.group_id = @group_id
),
task_cases AS (
  SELECT
    SAFE_CAST(a.artifact_id AS INT64) AS task_id_int,
    COUNT(DISTINCT c.id) AS n_cases,
    COUNTIF(c.status = 'IN_PROGRESS') AS n_active,
    COUNTIF(c.status IN ('DISMISSED', 'RESOLVED')) AS n_done,
    STRING_AGG(DISTINCT c.status, ', ') AS case_statuses
  FROM \`anna-money.export.case_case_artifact\` a
  JOIN \`anna-money.export.case_case\` c ON c.id = a.case_id
  WHERE a.artifact_type = 'AGENT_TASK'
  GROUP BY task_id_int
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
  t.task_id, t.alias, t.title, t.description, t.task_type, t.rb_jira_sync,
  t.created_by, t.taken_by, CAST(t.created_at AS STRING) AS created_at, t.age_days,
  COALESCE(tc.n_cases, 0) AS n_cases,
  COALESCE(tc.n_active, 0) AS n_active,
  COALESCE(tc.n_done, 0) AS n_done,
  tc.case_statuses,
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
  COALESCE(t.n_attachments, 0) AS n_attachments,
  COALESCE(t.n_attachments, 0) > 0 AS has_attachments,
  COALESCE(a.total_balance, 0) > 0.005 AS has_residual_balance,
  LOWER(COALESCE(c.company_status, '')) IN ('dissolved', 'liquidation', 'administration', 'closed', 'struck_off', 'strike_off', 'in_administration') AS company_inactive,
  COALESCE(al.n_open, 1) > 1 AS multi_task_alias,
  (COALESCE(a.total_balance, 0) <= 0.005 AND COALESCE(tc.n_active, 0) = 0 AND COALESCE(tc.n_done, 0) > 0) AS safe_close_candidate
FROM open_tasks t
LEFT JOIN task_cases tc ON tc.task_id_int = t.task_id
LEFT JOIN acct a ON a.alias = t.alias
LEFT JOIN comp c ON c.company_id = a.company_id
LEFT JOIN alias_tasks al ON al.alias = t.alias
ORDER BY t.age_days DESC
`;

// The daily-balances table is ~190M rows; this query bills ~12 GB on a PAS-sized
// queue. Cap generously. Follow-up: evaluate a cheaper current-balance source.
const MAX_BYTES_BILLED = '32212254720'; // 30 GB

export async function fetchQueueEnriched(groupId: string): Promise<EnrichedTaskRow[]> {
  const bq = getBigQueryService();
  return bq.query<EnrichedTaskRow>(
    QUEUE_ENRICH_QUERY,
    { group_id: groupId },
    { maximumBytesBilled: MAX_BYTES_BILLED },
  );
}

/** Build a WorkStation deep link for a task's alias (null when no alias). */
export function buildTaskWsLink(alias: string | null): string | null {
  if (!alias) return null;
  return `https://chat-workstation.k1.anna.money/${alias}/tasks`;
}

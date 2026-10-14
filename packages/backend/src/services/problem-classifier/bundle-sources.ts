import { getBigQueryService, type QueryParamTypeMap } from '../bigquery.js';

/**
 * Payment problem classifier — M2: the eight BigQuery pulls behind a thread bundle.
 *
 * Every pull is snapshot-wide: one query per source table with `IN UNNEST(@list)`
 * over all aliases / dialogue ids / transaction ids in the snapshot, split per
 * thread later in `bundle.ts`. Two of these tables are unpartitioned and 8-43 GB,
 * so a per-thread query pattern is not affordable.
 *
 * Long id lists are chunked only to keep a single request body sane; the chunk
 * sizes are large enough that a month-sized snapshot stays at one query per source.
 */

/** Automation actor. Appears in taken_by / last_agent / message alias; not a person. */
export const SYSTEM_ALIAS = '3B4F5Poa4b9Zae22I7bS';

const TASKS_TABLE = 'anna-money.export.task_manager_tasks';
const MESSAGES_TABLE = 'anna-money.verified_tables.assistance_processed_message';
const AGENT_TASKS_TABLE = 'anna-money.export.task_manager_agent_tasks';
const COMMENTS_TABLE = 'anna-money.export.task_manager_comments';
const ACCOUNTS_TABLE = 'anna-money.export.balance_account';
const LEDGER_TABLE = 'anna-money.export.balance_virtual_transaction';
const ORDERS_TABLE = 'anna-money.export.payment_payment';
const FRAUD_LOG_TABLE = 'anna-money.export.anti_fraud_transaction_log';
const FRAUD_M2M_TABLE = 'anna-money.export.anti_fraud_alert_agent_task_m2m';
const FRAUD_RULES_TABLE = 'anna-money.export.anti_fraud_rule_config';

/** RM hold tasks are reached by id; this floor keeps the partition scan bounded. */
const RM_TASK_UPDATED_FLOOR = '2026-01-01';

const GB = 1024 * 1024 * 1024;

/** Per-query maximumBytesBilled, in GB. */
export const BYTE_CAPS_GB = {
  containers: 2,
  messages: 20,
  agent_tasks: 5,
  rm_tasks: 5,
  comments: 5,
  accounts: 2,
  ledger: 60,
  orders: 15,
  fraud_log: 10,
  fraud_m2m: 2,
  fraud_rules: 2,
} as const;

export type SourceName = keyof typeof BYTE_CAPS_GB;

/**
 * Date bounds are passed as plain strings and cast with `date()` in SQL. Declaring
 * a query-parameter type of DATE for a string value makes this client send NULL,
 * which silently matches nothing.
 */
const STRING_CHUNK = 20000;
const INT_CHUNK = 50000;

export interface Pull<T> {
  rows: T[];
  bytes: number;
  queries: number;
}

function emptyPull<T>(): Pull<T> {
  return { rows: [], bytes: 0, queries: 0 };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** BigQuery returns TIMESTAMP/DATE/DATETIME as `{ value: string }`; flatten to ISO string. */
export function bqIso(val: unknown): string | null {
  if (val == null) return null;
  if (typeof val === 'string') return val;
  if (typeof val === 'object' && 'value' in val) {
    const inner = (val as { value: unknown }).value;
    return typeof inner === 'string' ? inner : null;
  }
  return null;
}

/** NUMERIC comes back as a big.js value; keep the exact decimal as a string. */
export function bqNumeric(val: unknown): string | null {
  if (val == null) return null;
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return String(val);
  if (typeof val === 'object') {
    if ('value' in val) return String((val as { value: unknown }).value);
    return String(val);
  }
  return null;
}

export function bqInt(val: unknown): number | null {
  if (val == null) return null;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') return Number(val);
  if (typeof val === 'object' && 'value' in val) return Number((val as { value: unknown }).value);
  return null;
}

export function bqFloat(val: unknown): number | null {
  return bqInt(val);
}

export function bqBool(val: unknown): boolean | null {
  if (val == null) return null;
  return Boolean(val);
}

export function bqString(val: unknown): string | null {
  if (val == null) return null;
  return typeof val === 'string' ? val : String(val);
}

async function runPull<T>(
  source: SourceName,
  sql: string,
  params: Record<string, unknown>,
  types: QueryParamTypeMap,
  map: (row: Record<string, unknown>) => T,
): Promise<Pull<T>> {
  const { rows, totalBytesProcessed } = await getBigQueryService().queryWithStats<
    Record<string, unknown>
  >(sql, params, {
    maximumBytesBilled: String(BYTE_CAPS_GB[source] * GB),
    types,
  });
  return { rows: rows.map(map), bytes: totalBytesProcessed, queries: 1 };
}

/** Run the same query once per id chunk and concatenate. */
async function runChunkedPull<T>(
  source: SourceName,
  ids: Array<string | number>,
  chunkSize: number,
  build: (idsParamName: string) => string,
  extraParams: Record<string, unknown>,
  extraTypes: QueryParamTypeMap,
  idType: 'STRING' | 'INT64',
  map: (row: Record<string, unknown>) => T,
): Promise<Pull<T>> {
  if (ids.length === 0) return emptyPull<T>();
  const out: Pull<T> = emptyPull<T>();
  for (const part of chunk(ids, chunkSize)) {
    const pull = await runPull<T>(
      source,
      build('ids'),
      { ...extraParams, ids: part },
      { ...extraTypes, ids: [idType] },
      map,
    );
    for (const row of pull.rows) out.rows.push(row);
    out.bytes += pull.bytes;
    out.queries += pull.queries;
  }
  return out;
}

/* ---------------------------------------------------------------- A. containers */

export interface ContainerRow {
  id: string;
  alias: string | null;
  type: string | null;
  status: string | null;
  channel: string | null;
  created_at: string | null;
  closed_at: string | null;
  taken_by: string | null;
  last_agent: string | null;
}

function mapContainer(r: Record<string, unknown>): ContainerRow {
  return {
    id: String(bqInt(r.id)),
    alias: bqString(r.alias),
    type: bqString(r.type),
    status: bqString(r.status),
    channel: bqString(r.channel),
    created_at: bqIso(r.created_at),
    closed_at: bqIso(r.closed_at),
    taken_by: bqString(r.taken_by),
    last_agent: bqString(r.last_agent),
  };
}

/**
 * `dateFrom` is the earliest dialogue date in scope. The table is partitioned on
 * `updated_at` and a dialogue is always updated at or after creation, so
 * `updated_at >= created_at - 1 day` is a safe prune.
 */
export function pullContainers(dialogueIds: number[], dateFrom: string): Promise<Pull<ContainerRow>> {
  return runChunkedPull<ContainerRow>(
    'containers',
    dialogueIds,
    INT_CHUNK,
    (ids) => `
select id, alias, type, status, channel, created_at, closed_at, taken_by, last_agent
from \`${TASKS_TABLE}\`
where id in unnest(@${ids})
  and date(updated_at) >= date_sub(date(@date_from), interval 1 day)
`.trim(),
    { date_from: dateFrom },
    {},
    'INT64',
    mapContainer,
  );
}

/* ------------------------------------------------------------------ B. messages */

export interface MessageRow {
  task_id: string;
  message_id: string | null;
  message_num: number | null;
  timestamp: string | null;
  channel: string | null;
  is_user: boolean | null;
  is_bot: boolean | null;
  is_llm: boolean | null;
  is_hidden: boolean | null;
  has_payload: boolean | null;
  payload_type: string | null;
  payload_fallback_text: string | null;
  text: string | null;
  files: string[];
  alias: string | null;
}

function mapMessage(r: Record<string, unknown>): MessageRow {
  return {
    task_id: String(bqInt(r.task_id)),
    message_id: bqString(r.message_id),
    message_num: bqInt(r.message_num),
    timestamp: bqIso(r.timestamp),
    channel: bqString(r.channel),
    is_user: bqBool(r.is_user),
    is_bot: bqBool(r.is_bot),
    is_llm: bqBool(r.is_llm),
    is_hidden: bqBool(r.is_hidden),
    has_payload: bqBool(r.has_payload),
    payload_type: bqString(r.payload_type),
    payload_fallback_text: bqString(r.payload_fallback_text),
    text: bqString(r.text),
    files: Array.isArray(r.files) ? (r.files as unknown[]).map((f) => String(f)) : [],
    alias: bqString(r.alias),
  };
}

export function pullMessages(
  dialogueIds: number[],
  winFrom: string,
  winTo: string,
): Promise<Pull<MessageRow>> {
  return runChunkedPull<MessageRow>(
    'messages',
    dialogueIds,
    INT_CHUNK,
    (ids) => `
select task_id, message_id, message_num, timestamp, channel,
       is_user, is_bot, is_llm, is_hidden, has_payload,
       payload_type, payload_fallback_text, text, files, alias
from \`${MESSAGES_TABLE}\`
where task_id in unnest(@${ids})
  and date(timestamp) between date(@win_from) and date(@win_to)
`.trim(),
    { win_from: winFrom, win_to: winTo },
    {},
    'INT64',
    mapMessage,
  );
}

/* --------------------------------------------------------------- C. agent tasks */

export interface AgentTaskRow {
  id: string;
  alias: string | null;
  title: string | null;
  task_type: string | null;
  status: string | null;
  group_id: string | null;
  priority: string | null;
  created_at: string | null;
  closed_at: string | null;
  created_by: string | null;
  closed_by: string | null;
  taken_by: string | null;
  description: string | null;
  rb_jira_link: string | null;
  n_attachments: number | null;
}

const AGENT_TASK_COLUMNS = `
select id, alias, title, task_type, status, group_id, priority,
       created_at, closed_at, created_by, closed_by, taken_by,
       description, rb_jira_link, array_length(attachments) as n_attachments
`.trim();

function mapAgentTask(r: Record<string, unknown>): AgentTaskRow {
  return {
    id: String(bqInt(r.id)),
    alias: bqString(r.alias),
    title: bqString(r.title),
    task_type: bqString(r.task_type),
    status: bqString(r.status),
    group_id: bqString(r.group_id),
    priority: bqString(r.priority),
    created_at: bqIso(r.created_at),
    closed_at: bqIso(r.closed_at),
    created_by: bqString(r.created_by),
    closed_by: bqString(r.closed_by),
    taken_by: bqString(r.taken_by),
    description: bqString(r.description),
    rb_jira_link: bqString(r.rb_jira_link),
    n_attachments: bqInt(r.n_attachments),
  };
}

/**
 * No date filter on purpose: the point is to see tasks opened long before or long
 * after the conversation. The table is 468 MB, one full scan per run is fine.
 */
export function pullAgentTasksByAlias(aliases: string[]): Promise<Pull<AgentTaskRow>> {
  return runChunkedPull<AgentTaskRow>(
    'agent_tasks',
    aliases,
    STRING_CHUNK,
    (ids) => `${AGENT_TASK_COLUMNS}\nfrom \`${AGENT_TASKS_TABLE}\`\nwhere alias in unnest(@${ids})`,
    {},
    {},
    'STRING',
    mapAgentTask,
  );
}

/**
 * Hold (RM) tasks, reached by id only — a hold task can sit on another account of
 * the company group, so an alias filter would silently drop it.
 */
export function pullAgentTasksById(taskIds: number[]): Promise<Pull<AgentTaskRow>> {
  return runChunkedPull<AgentTaskRow>(
    'rm_tasks',
    taskIds,
    INT_CHUNK,
    (ids) => `
${AGENT_TASK_COLUMNS}
from \`${AGENT_TASKS_TABLE}\`
where id in unnest(@${ids}) and updated_at >= timestamp('${RM_TASK_UPDATED_FLOOR}')
`.trim(),
    {},
    {},
    'INT64',
    mapAgentTask,
  );
}

/* ------------------------------------------------------------------ D. comments */

export interface CommentRow {
  id: string;
  agent_task_id: string;
  author: string | null;
  created_at: string | null;
  description: string | null;
}

function mapComment(r: Record<string, unknown>): CommentRow {
  return {
    id: String(bqInt(r.id)),
    agent_task_id: String(bqInt(r.agent_task_id)),
    author: bqString(r.author),
    created_at: bqIso(r.created_at),
    description: bqString(r.description),
  };
}

/** Joined on `agent_task_id`. The table's `task_id` column is something else entirely. */
export function pullComments(taskIds: number[]): Promise<Pull<CommentRow>> {
  return runChunkedPull<CommentRow>(
    'comments',
    taskIds,
    INT_CHUNK,
    (ids) => `
select id, agent_task_id, author, created_at, description
from \`${COMMENTS_TABLE}\`
where agent_task_id in unnest(@${ids})
`.trim(),
    {},
    {},
    'INT64',
    mapComment,
  );
}

/* ------------------------------------------------------------------ E. accounts */

export interface AccountRow {
  public_id: string | null;
  alias: string | null;
  status: string | null;
  type: string | null;
  provider: string | null;
  currency: string | null;
  created_at: string | null;
  closed_at: string | null;
  is_default: boolean | null;
}

function mapAccount(r: Record<string, unknown>): AccountRow {
  return {
    public_id: bqString(r.public_id),
    alias: bqString(r.alias),
    status: bqString(r.status),
    type: bqString(r.type),
    provider: bqString(r.provider),
    currency: bqString(r.currency),
    created_at: bqIso(r.created_at),
    closed_at: bqIso(r.closed_at),
    is_default: bqBool(r.is_default),
  };
}

/**
 * Needed as a join key, not just as context: `balance_virtual_transaction.alias`
 * is NULL on inbound bank transfers, which are only reachable through
 * `account_id = balance_account.public_id`.
 */
export function pullAccounts(aliases: string[]): Promise<Pull<AccountRow>> {
  return runChunkedPull<AccountRow>(
    'accounts',
    aliases,
    STRING_CHUNK,
    (ids) => `
select public_id, alias, status, type, provider, currency, created_at, closed_at, is_default
from \`${ACCOUNTS_TABLE}\`
where alias in unnest(@${ids})
`.trim(),
    {},
    {},
    'STRING',
    mapAccount,
  );
}

/* -------------------------------------------------------------------- F. ledger */

export interface LedgerRow {
  id: string;
  date: string | null;
  post_date: string | null;
  account_id: string | null;
  alias: string | null;
  type: string | null;
  status: string | null;
  amount: string | null;
  currency: string | null;
  transaction_amount: string | null;
  transaction_currency: string | null;
  description: string | null;
  original_payee_account_name: string | null;
  transfer_details_account_name: string | null;
  transfer_details_reference: string | null;
  transfer_details_sort_code: string | null;
  transfer_details_account_number: string | null;
  transfer_details_iban: string | null;
  transfer_details_bic_swift: string | null;
  transfer_details_bank_country: string | null;
  account_details_account_name: string | null;
  decline_reason: string | null;
  declined_by: string | null;
  estimated_processed_at: string | null;
  has_mt103: boolean | null;
  initial_transaction_id: string | null;
  merged_into: string | null;
  is_technical: boolean | null;
}

function mapLedger(r: Record<string, unknown>): LedgerRow {
  return {
    id: String(r.id),
    date: bqIso(r.date),
    post_date: bqIso(r.post_date),
    account_id: bqString(r.account_id),
    alias: bqString(r.alias),
    type: bqString(r.type),
    status: bqString(r.status),
    amount: bqNumeric(r.amount),
    currency: bqString(r.currency),
    transaction_amount: bqNumeric(r.transaction_amount),
    transaction_currency: bqString(r.transaction_currency),
    description: bqString(r.description),
    original_payee_account_name: bqString(r.original_payee_account_name),
    transfer_details_account_name: bqString(r.transfer_details_account_name),
    transfer_details_reference: bqString(r.transfer_details_reference),
    transfer_details_sort_code: bqString(r.transfer_details_sort_code),
    transfer_details_account_number: bqString(r.transfer_details_account_number),
    transfer_details_iban: bqString(r.transfer_details_iban),
    transfer_details_bic_swift: bqString(r.transfer_details_bic_swift),
    transfer_details_bank_country: bqString(r.transfer_details_bank_country),
    account_details_account_name: bqString(r.account_details_account_name),
    decline_reason: bqString(r.decline_reason),
    declined_by: bqString(r.declined_by),
    estimated_processed_at: bqIso(r.estimated_processed_at),
    has_mt103: bqBool(r.has_mt103),
    initial_transaction_id: bqString(r.initial_transaction_id),
    merged_into: bqString(r.merged_into),
    is_technical: bqBool(r.is_technical),
  };
}

/**
 * The unpartitioned 43 GB table. Exactly one scan per run: both match legs
 * (`alias` for outbound, `account_id` for inbound) are in the same predicate.
 */
export async function pullLedger(
  aliases: string[],
  accountIds: string[],
  ledFrom: string,
  ledTo: string,
): Promise<Pull<LedgerRow>> {
  if (aliases.length === 0 && accountIds.length === 0) return emptyPull<LedgerRow>();
  const sql = `
select id, date, post_date, account_id, alias, type, status,
       amount, currency, transaction_amount, transaction_currency, description,
       original_payee_account_name, transfer_details_account_name, transfer_details_reference,
       transfer_details_sort_code, transfer_details_account_number, transfer_details_iban,
       transfer_details_bic_swift, transfer_details_bank_country, account_details_account_name,
       decline_reason, declined_by, estimated_processed_at,
       transport_details_mt103 is not null as has_mt103,
       initial_transaction_id, merged_into, is_technical
from \`${LEDGER_TABLE}\`
where (alias in unnest(@aliases) or account_id in unnest(@account_ids))
  and date(date) between date(@led_from) and date(@led_to)
`.trim();
  return runPull<LedgerRow>(
    'ledger',
    sql,
    { aliases, account_ids: accountIds, led_from: ledFrom, led_to: ledTo },
    { aliases: ['STRING'], account_ids: ['STRING'] },
    mapLedger,
  );
}

/* ------------------------------------------------------------ G. payment orders */

export interface OrderRow {
  public_id: string | null;
  alias: string | null;
  status: string | null;
  amount: string | null;
  currency: string | null;
  to_account_name: string | null;
  payee_payment_type: string | null;
  payee_bank_country: string | null;
  reference: string | null;
  created: string | null;
  sent_at: string | null;
  processed_as_transaction: boolean | null;
  confirmation_of_payee_verification_result: string | null;
  questionnaire_status: string | null;
  scheduled: boolean | null;
  source: string | null;
}

function mapOrder(r: Record<string, unknown>): OrderRow {
  return {
    public_id: bqString(r.public_id),
    alias: bqString(r.alias),
    status: bqString(r.status),
    amount: bqNumeric(r.amount),
    currency: bqString(r.currency),
    to_account_name: bqString(r.to_account_name),
    payee_payment_type: bqString(r.payee_payment_type),
    payee_bank_country: bqString(r.payee_bank_country),
    reference: bqString(r.reference),
    created: bqIso(r.created),
    sent_at: bqIso(r.sent_at),
    processed_as_transaction: bqBool(r.processed_as_transaction),
    confirmation_of_payee_verification_result: bqString(
      r.confirmation_of_payee_verification_result,
    ),
    questionnaire_status: bqString(r.questionnaire_status),
    scheduled: bqBool(r.scheduled),
    source: bqString(r.source),
  };
}

/** `payment_payment.public_id` = `balance_virtual_transaction.id` is the verified key. */
export function pullOrders(
  aliases: string[],
  ledFrom: string,
  ledTo: string,
): Promise<Pull<OrderRow>> {
  return runChunkedPull<OrderRow>(
    'orders',
    aliases,
    STRING_CHUNK,
    (ids) => `
select public_id, alias, status, amount, currency, to_account_name,
       payee_payment_type, payee_bank_country, reference, created, sent_at,
       processed_as_transaction, confirmation_of_payee_verification_result,
       questionnaire_status, scheduled, source
from \`${ORDERS_TABLE}\`
where alias in unnest(@${ids}) and date(created) between date(@led_from) and date(@led_to)
`.trim(),
    { led_from: ledFrom, led_to: ledTo },
    {},
    'STRING',
    mapOrder,
  );
}

/* ---------------------------------------------------------------- H. hold chain */

export interface FraudLogRow {
  id: string;
  alert_id: string | null;
  rule_id: string | null;
  event_dt: string | null;
  message: string | null;
  amount: number | null;
  transaction_status: string | null;
  rule_restriction: string | null;
  was_blocked_or_declined: boolean | null;
  is_full_block_active: boolean | null;
  moved_to_review_required: boolean | null;
  action_type: string | null;
  transaction_public_chain_id: string | null;
}

function mapFraudLog(r: Record<string, unknown>): FraudLogRow {
  const alertId = bqInt(r.alert_id);
  const ruleId = bqInt(r.rule_id);
  return {
    id: String(bqInt(r.id)),
    alert_id: alertId == null ? null : String(alertId),
    rule_id: ruleId == null ? null : String(ruleId),
    event_dt: bqIso(r.event_dt),
    message: bqString(r.message),
    amount: bqFloat(r.amount),
    transaction_status: bqString(r.transaction_status),
    rule_restriction: bqString(r.rule_restriction),
    was_blocked_or_declined: bqBool(r.was_blocked_or_declined),
    is_full_block_active: bqBool(r.is_full_block_active),
    moved_to_review_required: bqBool(r.moved_to_review_required),
    action_type: bqString(r.action_type),
    transaction_public_chain_id: bqString(r.transaction_public_chain_id),
  };
}

/**
 * `transaction_public_chain_id` is the direct key from a ledger row to its holds.
 * Holds are never matched on amount or time.
 */
export function pullFraudLog(
  candidateIds: string[],
  ledFrom: string,
  ledTo: string,
): Promise<Pull<FraudLogRow>> {
  return runChunkedPull<FraudLogRow>(
    'fraud_log',
    candidateIds,
    STRING_CHUNK,
    (ids) => `
select id, alert_id, rule_id, event_dt, message, amount, transaction_status,
       rule_restriction, was_blocked_or_declined, is_full_block_active,
       moved_to_review_required, action_type, transaction_public_chain_id
from \`${FRAUD_LOG_TABLE}\`
where transaction_public_chain_id in unnest(@${ids})
  and date(event_dt) between date(@led_from) and date(@led_to)
`.trim(),
    { led_from: ledFrom, led_to: ledTo },
    {},
    'STRING',
    mapFraudLog,
  );
}

export interface AlertTaskRow {
  agent_task_id: string;
  agent_task_type: string | null;
  alert_id: string;
}

export function pullAlertTasks(alertIds: number[]): Promise<Pull<AlertTaskRow>> {
  return runChunkedPull<AlertTaskRow>(
    'fraud_m2m',
    alertIds,
    INT_CHUNK,
    (ids) => `
select agent_task_id, agent_task_type, alert_id
from \`${FRAUD_M2M_TABLE}\`
where alert_id in unnest(@${ids})
`.trim(),
    {},
    {},
    'INT64',
    (r) => ({
      agent_task_id: String(bqInt(r.agent_task_id)),
      agent_task_type: bqString(r.agent_task_type),
      alert_id: String(bqInt(r.alert_id)),
    }),
  );
}

export interface RuleConfigRow {
  rule_id: string;
  title: string | null;
  restriction: string | null;
  ws_task_first_group_name: string | null;
  categories: string[];
}

/** All 81 rows, once per run. */
export function pullRuleConfig(): Promise<Pull<RuleConfigRow>> {
  return runPull<RuleConfigRow>(
    'fraud_rules',
    `select rule_id, title, restriction, ws_task_first_group_name, categories\nfrom \`${FRAUD_RULES_TABLE}\``,
    {},
    {},
    (r) => ({
      rule_id: String(bqInt(r.rule_id)),
      title: bqString(r.title),
      restriction: bqString(r.restriction),
      ws_task_first_group_name: bqString(r.ws_task_first_group_name),
      categories: Array.isArray(r.categories)
        ? (r.categories as unknown[]).map((c) => String(c))
        : [],
    }),
  );
}

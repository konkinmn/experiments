import type { PopulationThread } from './population.js';
import {
  SYSTEM_ALIAS,
  type AccountRow,
  type AgentTaskRow,
  type AlertTaskRow,
  type CommentRow,
  type ContainerRow,
  type FraudLogRow,
  type LedgerRow,
  type MessageRow,
  type OrderRow,
  type RuleConfigRow,
} from './bundle-sources.js';
/* Type-only: `shortlist.ts` imports `isCardLike` from here, so this must not be a
 * value import or the two modules would form a runtime cycle. */
import type { ShortlistResult } from './shortlist.js';

/**
 * Payment problem classifier — M2: per-thread bundles and their text renderings.
 *
 * A bundle is everything a reader needs to say which payment a conversation is
 * about and what happened to it. Three later LLM inputs are rendered from it:
 *
 *  - `extract` (pass 1a) — dialogues + the tasks around the thread, no candidates.
 *    The model reports what the text says about the payment (`extraction.ts`).
 *  - `pick`    (pass 1b) — the same, plus a shortlist of at most forty of the
 *    customer's own records, built deterministically from the 1a extraction
 *    (`shortlist.ts`). The model returns one handle or NOT_FOUND.
 *  - `read`    (pass 2)  — dialogues + all tasks + the identified payment with its
 *    hold chain + a fortnight of ledger context. No 180-day list.
 *
 * Pass 1 used to be one call over the customer's whole 180-day ledger. Measured on
 * the pilot that rendering ran to a median of ~90k chars and a max of 1.4 MB, so it
 * was split into `extract` + `pick` with the shortlist in between.
 *
 * Rules this file keeps:
 *  - no text is ever truncated, filtered or keyword-matched;
 *  - every thread in the snapshot gets every stage, empty ledger included;
 *  - threads stay in the snapshot's order (a seeded shuffle) everywhere.
 */

/** Titles that mean the hold is on the partner's side (Railsr), which never writes to the fraud log. */
const PARTNER_SIDE_RE = /railsr|quarantine|greylist|offboard/i;

/** A card presentment. Rendered on the short card line rather than the transfer line. */
const CARD_TYPES = new Set(['POS', 'ATM']);

/**
 * Not a bank transfer: card presentments plus the row types that are the bank's own
 * bookkeeping. None of these is ever what a "where is my payment" thread is about,
 * so they are kept out of the proximity floor, the counterparty match and the
 * ledger-context listing — reachable by an explicit id or an amount match only.
 */
const CARD_LIKE_TYPES = new Set([...CARD_TYPES, 'CASH', 'CASHBACK', 'FEE', 'FX']);

const LEDGER_LOOKBACK_DAYS = 180;
const LEDGER_LOOKAHEAD_DAYS = 30;

/** `extract` and `pick` show the tasks around the thread, not the customer's whole history. */
const TASK_WINDOW_BEFORE_DAYS = 90;
const TASK_WINDOW_AFTER_DAYS = 60;

/** `read` shows this much ledger either side of the thread instead of the 180-day list. */
const LEDGER_CONTEXT_DAYS = 14;

export type Speaker = 'customer' | 'agent' | 'bot' | 'system';

export interface BundleMessage {
  message_id: string | null;
  message_num: number | null;
  timestamp: string | null;
  speaker: Speaker;
  speaker_alias: string | null;
  text: string;
  files: number;
  is_hidden: boolean | null;
  payload_type: string | null;
}

export interface BundleDialogue {
  dialogue_id: string;
  thread_position: number;
  kind: string;
  container: {
    type: string | null;
    status: string | null;
    channel: string | null;
    created_at: string | null;
    closed_at: string | null;
    taken_by: string | null;
    last_agent: string | null;
  } | null;
  messages: BundleMessage[];
  dropped_empty_system_rows: number;
}

export interface BundleTask extends AgentTaskRow {
  partner_side: boolean;
  comments: CommentRow[];
}

export interface LedgerCandidate extends LedgerRow {
  handle: string;
  /** The payment order that produced this ledger row, when there is one. */
  order: OrderRow | null;
}

export interface OrderCandidate extends OrderRow {
  handle: string;
}

export interface HoldAlert {
  alert_id: string;
  rm_tasks: BundleTask[];
}

export interface HoldChain {
  log_rows: FraudLogRow[];
  alerts: HoldAlert[];
}

export interface ThreadBundleMeta {
  thread_id: string;
  path_key: string;
  category: string;
  customer_alias: string;
  alias_namespace: 'an_' | 'normal';
  first_dialogue_at: string;
  last_dialogue_at: string;
  snapshot: string;
  built_at: string;
  message_window: { from: string; to: string; extensions: number };
  ledger_window: { from: string; to: string };
}

export interface ThreadBundleStats {
  n_dialogues: number;
  n_messages: number;
  n_customer_messages: number;
  n_tasks: number;
  n_comments: number;
  n_ledger_candidates: number;
  n_order_only: number;
  n_hold_log_rows: number;
}

export interface ThreadBundle {
  meta: ThreadBundleMeta;
  dialogues: BundleDialogue[];
  accounts: AccountRow[];
  tasks: BundleTask[];
  candidates: {
    ledger: LedgerCandidate[];
    orders_without_ledger: OrderCandidate[];
  };
  holds: {
    by_transaction_id: Record<string, HoldChain>;
    rules: Record<string, RuleConfigRow>;
  };
  stats: ThreadBundleStats;
}

export interface PulledData {
  containers: ContainerRow[];
  messages: MessageRow[];
  tasks: AgentTaskRow[];
  rmTasks: AgentTaskRow[];
  comments: CommentRow[];
  accounts: AccountRow[];
  ledger: LedgerRow[];
  orders: OrderRow[];
  fraudLog: FraudLogRow[];
  alertTasks: AlertTaskRow[];
  rules: RuleConfigRow[];
}

export interface SnapshotInput {
  name: string;
  built_at: string;
  threads: PopulationThread[];
  message_window: { from: string; to: string; extensions: number };
}

/* ------------------------------------------------------------------- helpers */

function isoDate(iso: string): string {
  return iso.slice(0, 10);
}

export function shiftDays(isoOrDate: string, days: number): string {
  const d = new Date(`${isoDate(isoOrDate)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function groupBy<T, K extends string>(rows: T[], key: (row: T) => K | null): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    if (k == null) continue;
    const bucket = out.get(k);
    if (bucket) bucket.push(row);
    else out.set(k, [row]);
  }
  return out;
}

function byIso(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a < b ? -1 : 1;
}

function messageOrder(a: MessageRow, b: MessageRow): number {
  if (a.message_num != null && b.message_num != null && a.message_num !== b.message_num) {
    return a.message_num - b.message_num;
  }
  const byTime = byIso(a.timestamp, b.timestamp);
  if (byTime !== 0) return byTime;
  return (a.message_num ?? 0) - (b.message_num ?? 0);
}

function speakerOf(row: MessageRow): Speaker {
  if (row.is_user) return 'customer';
  if (row.alias === SYSTEM_ALIAS) return 'system';
  if (row.is_bot || row.is_llm) return 'bot';
  return 'agent';
}

function effectiveText(row: MessageRow): string {
  const text = row.text?.trim() ? row.text : '';
  if (text) return text;
  return row.payload_fallback_text?.trim() ? row.payload_fallback_text : '';
}

/**
 * A row is dropped only when it is a hidden automation row with no text of its own
 * and no files. In practice these are Gemma's trace rows ("Thinking", "Tool call",
 * "Tool result", "Preparing a reply..."), which carry that boilerplate in
 * `payload_fallback_text` and nothing in `text`. Anything with real `text`, any
 * file, or any visible row survives.
 */
function isEmptyAutomationRow(row: MessageRow): boolean {
  const automation =
    Boolean(row.is_hidden) &&
    (row.is_bot === true || row.is_llm === true || row.alias === SYSTEM_ALIAS);
  const noOwnText = !row.text?.trim();
  return automation && noOwnText && row.files.length === 0;
}

export function isCardType(type: string | null): boolean {
  return type != null && CARD_TYPES.has(type);
}

/** True for anything that is not a bank transfer — see `CARD_LIKE_TYPES`. */
export function isCardLike(type: string | null): boolean {
  return type != null && CARD_LIKE_TYPES.has(type);
}

/**
 * A thread from one of the card leaves. There the card presentment IS the payment the
 * customer is writing about, so the three places that keep card rows out of the way —
 * the proximity floor, the counterparty match and the ledger context below — have to
 * let them through instead.
 */
export function isCardThread(pathKey: string): boolean {
  return pathKey.includes(' > Cards > ');
}

export function isPartnerSideTitle(title: string | null): boolean {
  return title != null && PARTNER_SIDE_RE.test(title);
}

/**
 * Last segment of the path key, with the direction added when it is not already there.
 * Card leaves are suffixed instead: `Blocked or declined payment` is a leaf under both
 * Cards and Outgoing payments, and the two are different problems.
 */
export function categoryLabel(pathKey: string): string {
  const segments = pathKey.split(' > ');
  const leaf = segments[segments.length - 1] ?? pathKey;
  if (isCardThread(pathKey)) return /card/i.test(leaf) ? leaf : `${leaf} (card)`;
  if (/incoming|outgoing/i.test(leaf)) return leaf;
  if (segments.some((s) => /outgoing payments/i.test(s))) return `${leaf} (outgoing)`;
  if (segments.some((s) => /incoming payments/i.test(s))) return `${leaf} (incoming)`;
  return leaf;
}

/* ------------------------------------------------------------------ assembly */

export function assembleBundles(snapshot: SnapshotInput, pulled: PulledData): ThreadBundle[] {
  const containersById = new Map(pulled.containers.map((c) => [c.id, c]));
  const messagesByDialogue = groupBy(pulled.messages, (m) => m.task_id);
  const tasksByAlias = groupBy(pulled.tasks, (t) => t.alias);
  const accountsByAlias = groupBy(pulled.accounts, (a) => a.alias);
  const commentsByTask = groupBy(pulled.comments, (c) => c.agent_task_id);
  const rmTaskById = new Map(pulled.rmTasks.map((t) => [t.id, t]));
  const rulesById = new Map(pulled.rules.map((r) => [r.rule_id, r]));
  const fraudByTransaction = groupBy(pulled.fraudLog, (f) => f.transaction_public_chain_id);
  const alertTasksByAlert = groupBy(pulled.alertTasks, (m) => m.alert_id);

  const ledgerById = new Map(pulled.ledger.map((l) => [l.id, l]));
  const orderByPublicId = new Map(
    pulled.orders.filter((o) => o.public_id != null).map((o) => [o.public_id as string, o]),
  );
  const ledgerByAlias = groupBy(pulled.ledger, (l) => l.alias);
  const ledgerByAccount = groupBy(pulled.ledger, (l) => l.account_id);
  const ordersByAlias = groupBy(pulled.orders, (o) => o.alias);

  const withComments = (task: AgentTaskRow): BundleTask => ({
    ...task,
    partner_side: isPartnerSideTitle(task.title),
    comments: (commentsByTask.get(task.id) ?? [])
      .slice()
      .sort((a, b) => byIso(a.created_at, b.created_at)),
  });

  return snapshot.threads.map((thread) => {
    const alias = thread.customer_alias;
    const dialogueTimes = thread.dialogues.map((d) => d.created_at).filter((t) => t !== '');
    const firstAt = thread.first_dialogue_at || dialogueTimes.slice().sort(byIso)[0] || '';
    const lastAt = dialogueTimes.slice().sort(byIso).reverse()[0] || firstAt;

    const ledgerWindow = {
      from: shiftDays(firstAt, -LEDGER_LOOKBACK_DAYS),
      to: shiftDays(lastAt, LEDGER_LOOKAHEAD_DAYS),
    };

    /* dialogues, in the snapshot's own order */
    const dialogues: BundleDialogue[] = thread.dialogues.map((d) => {
      const container = containersById.get(d.dialogue_id) ?? null;
      const raw = (messagesByDialogue.get(d.dialogue_id) ?? []).slice();
      const seen = new Set<string>();
      const deduped = raw.filter((m) => {
        const key = m.message_id ?? `${m.task_id}#${m.message_num}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const dropped = deduped.filter(isEmptyAutomationRow).length;
      const messages = deduped
        .filter((m) => !isEmptyAutomationRow(m))
        .sort(messageOrder)
        .map<BundleMessage>((m) => ({
          message_id: m.message_id,
          message_num: m.message_num,
          timestamp: m.timestamp,
          speaker: speakerOf(m),
          speaker_alias: m.alias,
          text: effectiveText(m),
          files: m.files.length,
          is_hidden: m.is_hidden,
          payload_type: m.payload_type,
        }));
      return {
        dialogue_id: d.dialogue_id,
        thread_position: d.thread_position,
        kind: d.kind,
        container: container
          ? {
              type: container.type,
              status: container.status,
              channel: container.channel,
              created_at: container.created_at,
              closed_at: container.closed_at,
              taken_by: container.taken_by,
              last_agent: container.last_agent,
            }
          : null,
        messages,
        dropped_empty_system_rows: dropped,
      };
    });

    /* customer tasks: all time, chronological */
    const tasks = (tasksByAlias.get(alias) ?? [])
      .slice()
      .sort((a, b) => byIso(a.created_at, b.created_at) || (Number(a.id) - Number(b.id)))
      .map(withComments);

    const accounts = (accountsByAlias.get(alias) ?? [])
      .slice()
      .sort((a, b) => byIso(a.created_at, b.created_at));
    /**
     * `balance_account.alias` is the account owner's alias, which is not always the
     * alias on the ledger row (20 of the 113 pilot aliases have no `balance_account`
     * row at all). So the account ids for a thread are the ones `balance_account`
     * gives us plus every account id seen on a ledger row that already carries this
     * alias — that second set is what reaches the alias-NULL inbound rows.
     */
    const accountIds = new Set(
      accounts.map((a) => a.public_id).filter((id): id is string => id != null),
    );
    for (const row of ledgerByAlias.get(alias) ?? []) {
      if (row.account_id) accountIds.add(row.account_id);
    }

    /* ledger candidates: the alias's own rows plus inbound rows on its accounts */
    const inWindow = (iso: string | null) =>
      iso != null && isoDate(iso) >= ledgerWindow.from && isoDate(iso) <= ledgerWindow.to;
    const ledgerRows = new Map<string, LedgerRow>();
    for (const row of ledgerByAlias.get(alias) ?? []) {
      if (inWindow(row.date)) ledgerRows.set(row.id, row);
    }
    for (const accountId of accountIds) {
      for (const row of ledgerByAccount.get(accountId) ?? []) {
        if (inWindow(row.date)) ledgerRows.set(row.id, row);
      }
    }
    const ledger: LedgerCandidate[] = [...ledgerRows.values()]
      .sort((a, b) => byIso(a.date, b.date) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((row, i) => ({
        handle: `C${String(i + 1).padStart(2, '0')}`,
        ...row,
        order: orderByPublicId.get(row.id) ?? null,
      }));

    /* orders that never reached the ledger */
    const ordersWithoutLedger: OrderCandidate[] = (ordersByAlias.get(alias) ?? [])
      .filter((o) => inWindow(o.created) && (o.public_id == null || !ledgerById.has(o.public_id)))
      .sort((a, b) => byIso(a.created, b.created))
      .map((row, i) => ({ handle: `O${String(i + 1).padStart(2, '0')}`, ...row }));

    /* hold chain, for every candidate that has one */
    const byTransactionId: Record<string, HoldChain> = {};
    const rules: Record<string, RuleConfigRow> = {};
    let holdLogRows = 0;
    for (const candidate of ledger) {
      const logRows = (fraudByTransaction.get(candidate.id) ?? [])
        .slice()
        .sort((a, b) => byIso(a.event_dt, b.event_dt));
      if (logRows.length === 0) continue;
      holdLogRows += logRows.length;
      for (const row of logRows) {
        if (row.rule_id != null) {
          const rule = rulesById.get(row.rule_id);
          if (rule) rules[row.rule_id] = rule;
        }
      }
      const alertIds = [
        ...new Set(logRows.map((r) => r.alert_id).filter((id): id is string => id != null)),
      ];
      const alerts: HoldAlert[] = alertIds.map((alertId) => ({
        alert_id: alertId,
        rm_tasks: (alertTasksByAlert.get(alertId) ?? [])
          .map((m) => rmTaskById.get(m.agent_task_id))
          .filter((t): t is AgentTaskRow => t != null)
          .sort((a, b) => byIso(a.created_at, b.created_at))
          .map(withComments),
      }));
      byTransactionId[candidate.id] = { log_rows: logRows, alerts };
    }

    const nMessages = dialogues.reduce((sum, d) => sum + d.messages.length, 0);
    const nCustomerMessages = dialogues.reduce(
      (sum, d) => sum + d.messages.filter((m) => m.speaker === 'customer').length,
      0,
    );

    return {
      meta: {
        thread_id: thread.thread_id,
        path_key: thread.path_key,
        category: thread.path_key.split(' > ').slice(-1)[0] ?? thread.path_key,
        customer_alias: alias,
        alias_namespace: alias.startsWith('an_') ? 'an_' : 'normal',
        first_dialogue_at: firstAt,
        last_dialogue_at: lastAt,
        snapshot: snapshot.name,
        built_at: snapshot.built_at,
        message_window: snapshot.message_window,
        ledger_window: ledgerWindow,
      },
      dialogues,
      accounts,
      tasks,
      candidates: { ledger, orders_without_ledger: ordersWithoutLedger },
      holds: { by_transaction_id: byTransactionId, rules },
      stats: {
        n_dialogues: dialogues.length,
        n_messages: nMessages,
        n_customer_messages: nCustomerMessages,
        n_tasks: tasks.length,
        n_comments: tasks.reduce((sum, t) => sum + t.comments.length, 0),
        n_ledger_candidates: ledger.length,
        n_order_only: ordersWithoutLedger.length,
        n_hold_log_rows: holdLogRows,
      },
    };
  });
}

/** All ids from the snapshot that the pulls need, gathered in one place. */
export function collectPullKeys(threads: PopulationThread[]): {
  aliases: string[];
  dialogueIds: number[];
  earliestDialogueDate: string;
  latestDialogueDate: string;
} {
  const aliases = new Set<string>();
  const dialogueIds = new Set<number>();
  let earliest = '';
  let latest = '';
  for (const thread of threads) {
    if (thread.customer_alias) aliases.add(thread.customer_alias);
    for (const d of thread.dialogues) {
      dialogueIds.add(Number(d.dialogue_id));
      if (d.created_at) {
        if (earliest === '' || d.created_at < earliest) earliest = d.created_at;
        if (latest === '' || d.created_at > latest) latest = d.created_at;
      }
    }
    if (thread.first_dialogue_at) {
      if (earliest === '' || thread.first_dialogue_at < earliest) earliest = thread.first_dialogue_at;
    }
  }
  return {
    aliases: [...aliases],
    dialogueIds: [...dialogueIds],
    earliestDialogueDate: isoDate(earliest),
    latestDialogueDate: isoDate(latest),
  };
}

export const LEDGER_WINDOW_DAYS = {
  lookback: LEDGER_LOOKBACK_DAYS,
  lookahead: LEDGER_LOOKAHEAD_DAYS,
};

/* ----------------------------------------------------------------- rendering */

const LONDON = 'Europe/London';
const DASH = '—';

function fmt(iso: string | null, opts: Intl.DateTimeFormatOptions): string {
  if (!iso) return DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', { timeZone: LONDON, hourCycle: 'h23', ...opts })
    .format(d)
    .replace(/,/g, '')
    // en-GB abbreviates September as "Sept"; every other month is three letters.
    .replace(/\bSept\b/, 'Sep');
}

/** "19 Aug 2026" */
function fmtDate(iso: string | null): string {
  return fmt(iso, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "19 Aug 2026 09:02" */
function fmtDateTime(iso: string | null): string {
  return fmt(iso, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "19 Aug 09:02" — inside a dialogue, whose header already carries the year. */
function fmtMessageTime(iso: string | null): string {
  return fmt(iso, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** "16 Aug 2026 18:55:50" */
function fmtSeconds(iso: string | null): string {
  return fmt(iso, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function money(amount: string | null, currency: string | null): string {
  if (amount == null) return `${DASH} ${currency ?? ''}`.trim();
  const n = Number(amount);
  const shown = Number.isFinite(n) ? n.toFixed(2) : amount;
  return `${shown} ${currency ?? ''}`.trim();
}

function direction(amount: string | null): string {
  const n = Number(amount ?? '0');
  return n < 0 ? 'out' : 'in';
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function agentLabel(alias: string | null): string {
  if (alias == null || alias === '') return 'nobody';
  return alias === SYSTEM_ALIAS ? 'SYSTEM' : `agent ${alias}`;
}

function counterpartyName(row: LedgerRow): string | null {
  const inbound = direction(row.amount) === 'in';
  const order = inbound
    ? [row.original_payee_account_name, row.transfer_details_account_name]
    : [row.transfer_details_account_name, row.original_payee_account_name];
  for (const value of [...order, row.account_details_account_name, row.description]) {
    if (value != null && value.trim() !== '') return value;
  }
  return null;
}

/**
 * `DECLINED · decline OTHER by anti-fraud`, or either half on its own. A row can
 * carry `declined_by` with no `decline_reason` — that is the anti-fraud hold shape,
 * so the reason column being empty must not swallow who declined it.
 */
function declineBit(row: LedgerRow): string | null {
  if (row.decline_reason && row.declined_by) {
    return `decline ${row.decline_reason} by ${row.declined_by}`;
  }
  if (row.decline_reason) return `decline ${row.decline_reason}`;
  if (row.declined_by) return `declined by ${row.declined_by}`;
  return null;
}

function ledgerBankLine(candidate: LedgerCandidate, handle: string | null): string {
  const dir = direction(candidate.amount);
  const name = counterpartyName(candidate);
  const bits = [
    ...(handle == null ? [] : [handle]),
    `id ${candidate.id}`,
    fmtDateTime(candidate.date),
    candidate.type ?? DASH,
    dir,
    money(candidate.amount, candidate.currency),
    `${dir === 'in' ? 'from' : 'to'} ${name ?? DASH}`,
    `ref ${candidate.transfer_details_reference ?? DASH}`,
    candidate.status ?? DASH,
  ];
  if (candidate.estimated_processed_at) {
    bits.push(`est. processed ${fmtDateTime(candidate.estimated_processed_at)}`);
  }
  if (candidate.description && candidate.description !== name) {
    bits.push(`desc ${candidate.description}`);
  }
  if (candidate.transaction_currency && candidate.transaction_currency !== candidate.currency) {
    bits.push(`orig ${money(candidate.transaction_amount, candidate.transaction_currency)}`);
  }
  const decline = declineBit(candidate);
  if (decline) bits.push(decline);
  if (candidate.has_mt103) bits.push('has MT103');
  if (candidate.is_technical) bits.push('technical');
  if (candidate.merged_into) bits.push(`merged into ${candidate.merged_into}`);
  if (candidate.order) bits.push(`order status ${candidate.order.status ?? DASH}`);
  return bits.join(' · ');
}

function ledgerCardLine(candidate: LedgerCandidate, handle: string | null): string {
  const bits = [
    ...(handle == null ? [] : [handle]),
    `id ${candidate.id}`,
    fmtDateTime(candidate.date),
    candidate.type ?? DASH,
    money(candidate.amount, candidate.currency),
    counterpartyName(candidate) ?? DASH,
    candidate.status ?? DASH,
  ];
  const decline = declineBit(candidate);
  if (decline) bits.push(decline);
  if (candidate.transaction_currency && candidate.transaction_currency !== candidate.currency) {
    bits.push(`orig ${money(candidate.transaction_amount, candidate.transaction_currency)}`);
  }
  return bits.join(' · ');
}

function orderLine(order: OrderCandidate, handle: string | null): string {
  const bits = [
    ...(handle == null ? [] : [handle]),
    `id ${order.public_id ?? DASH}`,
    '[order, never posted]',
    `created ${fmtDateTime(order.created)}`,
    order.payee_payment_type ?? DASH,
    money(order.amount, order.currency),
    `to ${order.to_account_name ?? DASH}`,
    `status ${order.status ?? DASH}`,
    `CoP ${order.confirmation_of_payee_verification_result ?? DASH}`,
    `questionnaire ${order.questionnaire_status ?? DASH}`,
  ];
  if (order.reference) bits.push(`ref ${order.reference}`);
  if (order.sent_at) bits.push(`sent ${fmtDateTime(order.sent_at)}`);
  if (order.scheduled) bits.push('scheduled');
  if (order.source) bits.push(`source ${order.source}`);
  if (order.payee_bank_country) bits.push(`payee country ${order.payee_bank_country}`);
  return bits.join(' · ');
}

/**
 * What one rendering has already printed in full, so the second copy of it can be a
 * reference instead.
 *
 * The templates are the reason: an RM alert task carries an identical ~600-character
 * description on every alert it raises, and a thread with five of them pays for that text
 * five times. Verbatim repeats of ordinary task descriptions, comment bodies and fraud-log
 * messages happen for the same reason — a template, a copy-paste, or the same task shown
 * once under the customer's tasks and again under the alert that raised it.
 *
 * The replacement is lossless: the first occurrence is always printed whole, and every
 * later one names where to read it. Nothing is shortened, summarised or dropped, so a
 * reader (and a model) can still recover the exact text of every repeat. One registry per
 * `renderBundleText` call, never shared between renderings — a reference that pointed
 * outside its own prompt would be unresolvable.
 */
interface RenderDedupe {
  /** trimmed description → the id of the task that printed it. */
  descriptions: Map<string, string>;
  /** trimmed comment body → the task and timestamp it was printed under. */
  comments: Map<string, { taskId: string; ts: string }>;
  /** trimmed fraud-log message → the timestamp of the row that printed it. */
  logMessages: Map<string, string>;
}

function newDedupe(): RenderDedupe {
  return { descriptions: new Map(), comments: new Map(), logMessages: new Map() };
}

/**
 * A repeat is only worth referencing when the reference is shorter than the text.
 *
 * Without this the change is a loss on short repeats: a one-word comment repeated a
 * hundred times becomes a hundred copies of `same as comment on task #744762 at 31 May
 * 2023 14:20`, and measured on the pilot that alone added 2,471 chars to one thread and
 * made 8 of the 122 longer than they were before. Keeping the shorter of the two costs
 * nothing — the registry still records the first occurrence either way, so a later long
 * repeat of the same text still collapses.
 */
function preferShorter(text: string, reference: string): string {
  return reference.length < text.length ? reference : text;
}

function taskBlock(task: BundleTask, indent: string, dedupe: RenderDedupe): string[] {
  const lines: string[] = [];
  const head = [
    `#${task.id}`,
    task.title ?? DASH,
    task.task_type ?? DASH,
    task.status ?? DASH,
    `opened ${fmtDateTime(task.created_at)}`,
    `closed ${task.closed_at ? fmtDateTime(task.closed_at) : DASH}`,
    `by ${task.created_by ?? DASH}`,
  ];
  if (task.group_id) head.push(`group ${task.group_id}`);
  if (task.taken_by) head.push(`taken by ${agentLabel(task.taken_by)}`);
  if (task.n_attachments) head.push(plural(task.n_attachments, 'attachment', 'attachments'));
  if (task.rb_jira_link) head.push(`jira ${task.rb_jira_link}`);
  lines.push(`${indent}${head.join(' · ')}${task.partner_side ? ' [partner-side]' : ''}`);
  if (task.description?.trim()) {
    const key = task.description.trim();
    const first = dedupe.descriptions.get(key);
    if (first === undefined) {
      dedupe.descriptions.set(key, task.id);
      lines.push(`${indent}  description: ${task.description}`);
    } else {
      lines.push(
        `${indent}  description: ${preferShorter(task.description, `same as task #${first}`)}`,
      );
    }
  }
  for (const comment of task.comments) {
    const body = comment.description ?? '';
    const ts = fmtDateTime(comment.created_at);
    const head = `${indent}  comment · ${comment.author ?? DASH} · ${ts}: `;
    /* An empty body has nothing to reference and no reference could be shorter than it. */
    const key = body.trim();
    if (key === '') {
      lines.push(`${head}${body}`);
      continue;
    }
    const first = dedupe.comments.get(key);
    if (first === undefined) {
      dedupe.comments.set(key, { taskId: task.id, ts });
      lines.push(`${head}${body}`);
    } else {
      const reference = `same as comment on task #${first.taskId} at ${first.ts}`;
      lines.push(`${head}${preferShorter(body, reference)}`);
    }
  }
  return lines;
}

function nonNullFieldLines(row: Record<string, unknown>, skip: string[], indent: string): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(row)) {
    if (skip.includes(key)) continue;
    if (value == null || value === '') continue;
    lines.push(`${indent}${key}: ${String(value)}`);
  }
  return lines;
}

export type RenderOptions =
  | { stage: 'extract' }
  | { stage: 'pick'; shortlist: ShortlistResult }
  | { stage: 'read'; identifiedId: string | null };

/** A task with no `created_at` cannot be placed in the window, so it is shown, not hidden. */
function taskInWindow(task: BundleTask, from: string, to: string): boolean {
  if (task.created_at == null || task.created_at === '') return true;
  const day = isoDate(task.created_at);
  return day >= from && day <= to;
}

/** `extract` and `pick`: the tasks around the thread, with a count of what was left out. */
function windowedTaskLines(bundle: ThreadBundle, dedupe: RenderDedupe): string[] {
  if (bundle.tasks.length === 0) return ['== CUSTOMER TASKS · none found for this alias'];
  const from = shiftDays(bundle.meta.first_dialogue_at, -TASK_WINDOW_BEFORE_DAYS);
  const to = shiftDays(bundle.meta.last_dialogue_at, TASK_WINDOW_AFTER_DAYS);
  const shown = bundle.tasks.filter((task) => taskInWindow(task, from, to));
  const lines = [
    `== CUSTOMER TASKS · ${shown.length} in window ${TASK_WINDOW_BEFORE_DAYS}d before – ${TASK_WINDOW_AFTER_DAYS}d after the thread · chronological`,
  ];
  for (const task of shown) lines.push(...taskBlock(task, '', dedupe));
  const hidden = bundle.tasks.length - shown.length;
  if (hidden > 0) {
    lines.push(
      `(${plural(hidden, 'older/newer task', 'older/newer tasks')} on this customer not shown at this stage)`,
    );
  }
  return lines;
}

/** `read`: every task on the customer, no window. */
function allTaskLines(bundle: ThreadBundle, dedupe: RenderDedupe): string[] {
  if (bundle.tasks.length === 0) return ['== CUSTOMER TASKS · none found for this alias'];
  const lines = [`== CUSTOMER TASKS · ${bundle.tasks.length} · all time · chronological`];
  for (const task of bundle.tasks) lines.push(...taskBlock(task, '', dedupe));
  return lines;
}

function candidateLine(
  record: LedgerCandidate | OrderCandidate,
  handle: string | null,
): string {
  if ('public_id' in record) return orderLine(record, handle);
  return isCardType(record.type)
    ? ledgerCardLine(record, handle)
    : ledgerBankLine(record, handle);
}

function shortlistLines(shortlist: ShortlistResult): string[] {
  if (shortlist.rows.length === 0) {
    return [
      '== SHORTLISTED TRANSACTIONS · none matched — answer NOT_FOUND unless the conversation clearly identifies a payment by other means',
    ];
  }
  const lines = [
    `== SHORTLISTED TRANSACTIONS · ${shortlist.rows.length} of the customer's own records · pick one or answer NOT_FOUND`,
  ];
  for (const row of shortlist.rows) {
    lines.push(`${candidateLine(row.row, row.handle)} · why: ${row.reasons.join(', ')}`);
  }
  if (shortlist.omitted > 0) {
    lines.push(
      `(${plural(shortlist.omitted, 'further match', 'further matches')} not shown — if none of the above fits, answer NOT_FOUND)`,
    );
  }
  return lines;
}

/**
 * `read`: a fortnight of bank transfers either side of the thread, in place of the
 * 180-day list. Enough to see what else moved around the payment; short enough to
 * sit in a prompt. The identified row is marked when it falls inside the window.
 * On a card thread card presentments are shown too — there they are the subject.
 */
function ledgerContextLines(bundle: ThreadBundle, identifiedId: string | null): string[] {
  const { meta } = bundle;
  const cardThread = isCardThread(meta.path_key);
  const from = shiftDays(meta.first_dialogue_at, -LEDGER_CONTEXT_DAYS);
  const to = shiftDays(meta.last_dialogue_at, LEDGER_CONTEXT_DAYS);
  const inWindow = (iso: string | null): boolean =>
    iso != null && iso !== '' && isoDate(iso) >= from && isoDate(iso) <= to;

  const shown: { date: string; id: string; record: LedgerCandidate | OrderCandidate }[] = [];
  for (const candidate of bundle.candidates.ledger) {
    if ((isCardLike(candidate.type) && !cardThread) || !inWindow(candidate.date)) continue;
    shown.push({ date: candidate.date ?? '', id: candidate.id, record: candidate });
  }
  for (const order of bundle.candidates.orders_without_ledger) {
    if (!inWindow(order.created)) continue;
    shown.push({ date: order.created ?? '', id: order.public_id ?? '', record: order });
  }
  shown.sort((a, b) => (a.date === b.date ? (a.id < b.id ? -1 : 1) : a.date < b.date ? -1 : 1));

  const total = bundle.candidates.ledger.length + bundle.candidates.orders_without_ledger.length;
  const further = total - shown.length;
  const subject = cardThread ? 'transfers and card payments' : 'bank transfers';
  const head = `== LEDGER CONTEXT · ${subject} within ${LEDGER_CONTEXT_DAYS} days of the thread · ${plural(shown.length, 'row', 'rows')}`;
  const lines = [
    further > 0
      ? `${head} (${plural(further, 'further row', 'further rows')} in the ${LEDGER_LOOKBACK_DAYS}-day window not shown)`
      : head,
  ];
  for (const entry of shown) {
    const marker = identifiedId != null && entry.id === identifiedId ? ' ◀ identified' : '';
    lines.push(`${candidateLine(entry.record, null)}${marker}`);
  }
  return lines;
}

function identifiedPaymentLines(bundle: ThreadBundle, identifiedId: string): string[] {
  const candidate = bundle.candidates.ledger.find((c) => c.id === identifiedId);
  if (candidate) {
    const lines = [`== IDENTIFIED PAYMENT · id ${candidate.id}`];
    lines.push(
      ...nonNullFieldLines(candidate as unknown as Record<string, unknown>, ['handle', 'order'], '  '),
    );
    if (candidate.order) {
      lines.push('  order:');
      lines.push(
        ...nonNullFieldLines(candidate.order as unknown as Record<string, unknown>, [], '    '),
      );
    } else {
      lines.push('  order: no payment_payment row for this transaction id');
    }
    return lines;
  }
  /* pass 1b can also pick an order that never reached the ledger. */
  const order = bundle.candidates.orders_without_ledger.find((o) => o.public_id === identifiedId);
  if (order) {
    return [
      `== IDENTIFIED PAYMENT · id ${identifiedId} · payment order, never posted to the ledger`,
      ...nonNullFieldLines(order as unknown as Record<string, unknown>, ['handle'], '  '),
    ];
  }
  return [`== IDENTIFIED PAYMENT · id ${identifiedId} · not in this thread's candidate list`];
}

/**
 * The identified payment on one line: `FP out -3750.00 GBP to GHAFAR HUSSAIN · DECLINED`.
 *
 * A list row, not a prompt rendering — the same fields the bank line carries, minus the
 * ids, dates and flags, so a hundred of them can be scanned at once. `null` when pass 1
 * identified nothing, or named a record this thread's candidates do not hold.
 */
export function renderIdentifiedSummary(
  bundle: ThreadBundle,
  identifiedId: string | null,
): string | null {
  if (identifiedId == null) return null;
  const candidate = bundle.candidates.ledger.find((c) => c.id === identifiedId);
  if (candidate) {
    const dir = direction(candidate.amount);
    return [
      [
        candidate.type ?? DASH,
        dir,
        money(candidate.amount, candidate.currency),
        `${dir === 'in' ? 'from' : 'to'} ${counterpartyName(candidate) ?? DASH}`,
      ].join(' '),
      candidate.status ?? DASH,
    ].join(' · ');
  }
  const order = bundle.candidates.orders_without_ledger.find((o) => o.public_id === identifiedId);
  if (order) {
    return [
      [
        order.payee_payment_type ?? DASH,
        'out',
        money(order.amount, order.currency),
        `to ${order.to_account_name ?? DASH}`,
      ].join(' '),
      order.status ?? DASH,
      'order, never posted',
    ].join(' · ');
  }
  return null;
}

function holdChainLines(
  bundle: ThreadBundle,
  identifiedId: string,
  dedupe: RenderDedupe,
): string[] {
  const lines = [`== HOLD CHAIN for id ${identifiedId}`];
  const chain = bundle.holds.by_transaction_id[identifiedId];
  if (!chain || chain.log_rows.length === 0) {
    lines.push('(no fraud-log rows for this transaction)');
    return lines;
  }
  for (const row of chain.log_rows) {
    const rule = row.rule_id ? bundle.holds.rules[row.rule_id] : undefined;
    const ts = fmtSeconds(row.event_dt);
    const bits = [
      'fraud log',
      ts,
      `rule ${row.rule_id ?? DASH}${rule?.title ? ` "${rule.title}"` : ''}`,
      row.rule_restriction ?? DASH,
      `blocked=${row.was_blocked_or_declined ?? false}`,
      `status ${row.transaction_status ?? DASH}`,
    ];
    if (row.action_type) bits.push(`action ${row.action_type}`);
    if (row.moved_to_review_required) bits.push('moved to review required');
    if (row.is_full_block_active) bits.push('full block active');
    if (row.alert_id) bits.push(`alert ${row.alert_id}`);
    if (rule?.ws_task_first_group_name) bits.push(`ws group ${rule.ws_task_first_group_name}`);
    /* One rule firing repeatedly writes the same sentence on every row of the chain. */
    const message = row.message ?? '';
    const key = message.trim();
    let printed = message;
    if (key !== '') {
      const first = dedupe.logMessages.get(key);
      if (first === undefined) dedupe.logMessages.set(key, ts);
      else printed = preferShorter(message, `same as fraud log at ${first}`);
    }
    lines.push(`${bits.join(' · ')} · message: ${printed}`);
  }
  for (const alert of chain.alerts) {
    if (alert.rm_tasks.length === 0) {
      lines.push(`  alert ${alert.alert_id} → no RM task found`);
      continue;
    }
    for (const task of alert.rm_tasks) {
      const [head, ...rest] = taskBlock(task, '', dedupe);
      lines.push(`  alert ${alert.alert_id} → RM task ${head}`);
      for (const line of rest) lines.push(`    ${line.trimStart()}`);
    }
  }
  return lines;
}

function partnerTaskLines(bundle: ThreadBundle): string[] {
  const partnerTasks = bundle.tasks.filter((t) => t.partner_side);
  if (partnerTasks.length === 0) return ['== PARTNER-SIDE TASKS ON THIS CUSTOMER · none'];
  const lines = [`== PARTNER-SIDE TASKS ON THIS CUSTOMER · ${partnerTasks.length}`];
  for (const task of partnerTasks) {
    lines.push(
      [
        `#${task.id}`,
        task.title ?? DASH,
        `opened ${fmtDateTime(task.created_at)}`,
        `closed ${task.closed_at ? fmtDateTime(task.closed_at) : DASH}`,
        task.status ?? DASH,
      ].join(' · '),
    );
  }
  return lines;
}

export function renderBundleText(bundle: ThreadBundle, options: RenderOptions): string {
  const lines: string[] = [];
  const { meta, stats } = bundle;
  /* Fresh per rendering: every `same as …` reference has to resolve inside this text. */
  const dedupe = newDedupe();

  lines.push(
    [
      `THREAD ${meta.thread_id}`,
      categoryLabel(meta.path_key),
      `customer ${meta.customer_alias}${meta.alias_namespace === 'an_' ? ' [an_ namespace: no tasks, accounts or ledger rows exist for it]' : ''}`,
      plural(stats.n_dialogues, 'dialogue', 'dialogues'),
      fmtDate(meta.first_dialogue_at),
    ].join(' · '),
  );

  /* dialogues — every stage, whole text, snapshot order */
  for (const dialogue of bundle.dialogues) {
    const c = dialogue.container;
    const head = [`== DIALOGUE ${dialogue.dialogue_id}`];
    if (c) {
      head.push(`type ${c.type ?? DASH}`);
      head.push(c.status ?? DASH);
      if (c.channel) head.push(`channel ${c.channel}`);
      head.push(`opened ${fmtDateTime(c.created_at)} (London)`);
      if (c.closed_at) head.push(`closed ${fmtDateTime(c.closed_at)}`);
      const handler = c.last_agent ?? c.taken_by;
      head.push(`handled by ${agentLabel(handler)}`);
      if (c.taken_by && c.last_agent && c.taken_by !== c.last_agent) {
        head.push(`taken by ${agentLabel(c.taken_by)}`);
      }
    } else {
      head.push('container not found in task_manager_tasks');
    }
    if (dialogue.kind && dialogue.kind !== 'real') head.push(`kind ${dialogue.kind}`);
    lines.push(head.join(' · '));

    for (const message of dialogue.messages) {
      const parts: string[] = [];
      if (message.text) parts.push(message.text);
      if (message.files > 0) parts.push(`[attachment: ${plural(message.files, 'file', 'files')}]`);
      const body = parts.join(' ');
      lines.push(
        `[${fmtMessageTime(message.timestamp)}] ${message.speaker.toUpperCase()}: ${body}`,
      );
    }
    if (dialogue.messages.length === 0) {
      lines.push('(no messages found in the message window)');
    }
    if (dialogue.dropped_empty_system_rows > 0) {
      lines.push(
        `(${plural(dialogue.dropped_empty_system_rows, 'empty automation row', 'empty automation rows')} omitted)`,
      );
    }
  }

  if (options.stage === 'extract') {
    lines.push(...windowedTaskLines(bundle, dedupe));
    return `${lines.join('\n')}\n`;
  }

  if (options.stage === 'pick') {
    lines.push(...windowedTaskLines(bundle, dedupe));
    lines.push(...shortlistLines(options.shortlist));
    return `${lines.join('\n')}\n`;
  }

  /* read: all tasks, the identified payment, its hold chain, then ledger context */
  lines.push(...allTaskLines(bundle, dedupe));
  const identifiedId = options.identifiedId;
  if (identifiedId == null) {
    lines.push(
      '== IDENTIFIED PAYMENT · NOT_FOUND in pass 1 — read from the conversation, the tasks and the ledger context alone.',
    );
  } else {
    lines.push(...identifiedPaymentLines(bundle, identifiedId));
    lines.push(...holdChainLines(bundle, identifiedId, dedupe));
  }
  lines.push(...partnerTaskLines(bundle));
  lines.push(...ledgerContextLines(bundle, identifiedId));

  return `${lines.join('\n')}\n`;
}

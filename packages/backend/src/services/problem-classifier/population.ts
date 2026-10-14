import { getBigQueryService } from '../bigquery.js';

/**
 * Payment problem classifier — population selector.
 *
 * `gemma.thread_scenarios` and `gemma.threads` are rewritten daily and revise rows
 * as well as appending them, so two runs of this selector return different sets.
 * Every downstream pass must read the snapshot file this selector feeds, never
 * re-run the selector.
 */

const THREAD_SCENARIOS_TABLE = 'anna-money.gemma.thread_scenarios';
const THREADS_TABLE = 'anna-money.gemma.threads';

/**
 * Named sets of Gemma scenario leaves. A run picks one, and the resolved list is written
 * into the snapshot manifest, so a snapshot always says what it was drawn from.
 *
 * One question, one set. `money-not-arrived` is waiting — the customer expects money and
 * it is not there. `declines` is refusal — the customer was told no. Mixing them multiplies
 * the pass-2 bill and induces categories that answer neither question cleanly, so a run
 * names the set it wants rather than inheriting every leaf anyone has ever added.
 */
export const LEAF_SETS: Record<string, readonly string[]> = {
  /* The pilot and `fn1` ran on these three. */
  'money-not-arrived': [
    'Business account > Incoming payments > Missing or failed incoming payment',
    'Business account > Incoming payments > Incoming payment status / pending',
    'Business account > Outgoing payments > Payment issues > Payment status / pending',
  ],
  /*
   * Refusal. The card leaves are what makes the card/non-card split measurable at all:
   * `fn1` identified 162 declined payments and only 5 were card rows, which is a property
   * of a population with no card leaf in it, not of the traffic.
   *
   * The set is wider than the four leaves that name a decline, because a refusal is
   * described by its cause as often as by its symptom — a frozen card, a restricted
   * account, a bounced direct debit, a top-up that failed. Whether a leaf belongs is
   * settled by pass 1, which is the cheap pass: a leaf whose threads rarely resolve to a
   * DECLINED payment is answering a different question and should come back out.
   */
  declines: [
    /* Names the decline. */
    'Business account > Outgoing payments > Payment issues > Blocked or declined payment',
    'Business account > Cards > Card problems & declines > Card declined',
    'Business account > Cards > Card problems & declines > Blocked or declined payment',
    'Business account > Cards > Card problems & declines > Card not working',
    /* Names the cause instead: the card, the account, the mandate, the funding. */
    'Business account > Cards > Card security & loss > Block / freeze / unfreeze',
    'Compliance > Risk monitoring > Account restriction / freeze',
    'Business account > Top up > Add funds',
    'Business account > Outgoing payments > Direct debit & standing order',
    /* Refusal by a rule — on probation until pass 1 says how often a payment is behind them. */
    'Business account > Cards > Card usage & limits > Card limits',
    'Business account > Outgoing payments > Transfer limits',
    'Business account > Cards > Payment authentication (selfie/OTP)',
    'Business account > Outgoing payments > Payment authentication (selfie/OTP)',
    'Business account > Cards > Card usage & limits > Card usage scope / eligibility',
    'Business account > Cards > Card usage & limits > Card use abroad',
    'Business account > Cards > Card usage & limits > ATM / cash withdrawal',
  ],
};

export const DEFAULT_LEAF_SET = 'money-not-arrived';

export interface ResolvedLeafSet {
  /** A registry name, or `custom` when the caller passed leaves of its own. */
  name: string;
  pathKeys: string[];
}

/**
 * A registry name, or an explicit list of full path keys. A string holding `>` is read as
 * the latter, so a one-off cut needs no code change — but it is recorded as `custom` in
 * the manifest, because nothing else will remember what it was.
 */
export function resolveLeafSet(input?: string | readonly string[]): ResolvedLeafSet {
  if (input === undefined) {
    return { name: DEFAULT_LEAF_SET, pathKeys: [...LEAF_SETS[DEFAULT_LEAF_SET]] };
  }
  const list = Array.isArray(input) ? [...input] : String(input).split(',');
  const trimmed = list.map((s) => s.trim()).filter((s) => s !== '');
  if (trimmed.length === 0) throw new Error('leaves: empty');

  if (trimmed.length === 1 && !trimmed[0].includes('>')) {
    const set = LEAF_SETS[trimmed[0]];
    if (set === undefined) {
      throw new Error(
        `leaves: unknown set "${trimmed[0]}" — known sets are ${Object.keys(LEAF_SETS).join(', ')}, or give full path keys`,
      );
    }
    return { name: trimmed[0], pathKeys: [...set] };
  }

  const notAPath = trimmed.find((s) => !s.includes(' > '));
  if (notAPath !== undefined) {
    throw new Error(`leaves: "${notAPath}" is neither a known set nor a full path key`);
  }
  return { name: 'custom', pathKeys: trimmed };
}

export const SELECTOR_PREDICATE = 'is_primary and not no_fit and not invalid_path';

export const SELECTOR_DATE_RULE =
  'min(threads.dialogue_created_at) per thread, DATE between date_from and date_to inclusive';

export const SELECTOR_TABLES = [THREAD_SCENARIOS_TABLE, THREADS_TABLE];

const TURN_EVENTS_TABLE = 'anna-money.verified_tables.gemma_turn_events';
const HUMAN_TOUCH_TABLE = 'anna-money.verified_tables.gemma_dialogue_human_touch';

/**
 * A thread escalated when one of its dialogues successfully handed the customer to a
 * human. Never `escalate` — 42% of those calls only swap the active capability and carry
 * on, and at dialogue grain `escalate` overstates handovers by 78%. `Rethink requested`
 * is the fast model asking for the call to be redone and creates nothing, while carrying
 * `is_error = false`, so nothing else excludes it.
 */
export const ESCALATION_RULE =
  "gemma_turn_events: successful create_support_task / amend_support_task, excluding 'Rethink requested'";

/**
 * A person acted in the conversation — wrote in it, moved its status, or worked a ticket
 * belonging to it. Wider than the rule above and the right one wherever Gemma may never
 * have run: measured on the decline leaves over 17–18 Sep 2026, only 3.2% of their
 * dialogues appear in `gemma_turn_events` at all, so an escalation filter there is blind
 * by construction — a skill that gave up, or an agent who simply picked the chat up,
 * leaves no handover call to count. It also catches `skill_handover`, which is what a
 * non-Gemma flow produces when it fails.
 */
export const HUMAN_TOUCH_RULE =
  'gemma_dialogue_human_touch: a person wrote in the dialogue, moved its status, or worked its ticket';

export const POPULATION_FILTERS = ['all', 'escalated', 'touched'] as const;
export type PopulationFilter = (typeof POPULATION_FILTERS)[number];

/** A handover can land days after the conversation opened, so the event window runs past it. */
const ESCALATION_LOOKAHEAD_DAYS = 31;

/** 2 GB. A full month of the selector reads ~140 MB. */
const MAXIMUM_BYTES_BILLED = String(2 * 1024 * 1024 * 1024);

/** 60 GB: the escalation filter adds a partition scan of the turn-event table. */
const MAXIMUM_BYTES_BILLED_ESCALATED = String(60 * 1024 * 1024 * 1024);

export interface PopulationDialogue {
  dialogue_id: string;
  thread_position: number;
  kind: string;
  created_at: string;
}

export interface PopulationThread {
  thread_id: string;
  path_key: string;
  first_dialogue_at: string;
  customer_alias: string;
  dialogues: PopulationDialogue[];
}

export interface CategoryCount {
  path_key: string;
  threads: number;
  dialogues: number;
  customers: number;
}

export interface SelectPopulationOptions {
  dateFrom: string;
  dateTo: string;
  /** The resolved leaves of the run's set; see `resolveLeafSet`. */
  pathKeys: readonly string[];
  /** ISO timestamp; pins both tables with FOR SYSTEM_TIME AS OF (BigQuery keeps 7 days). */
  asOf?: string;
  /**
   * `all` is every thread in the leaves. `escalated` keeps the ones Gemma handed over
   * (`ESCALATION_RULE`), `touched` the ones a person acted in (`HUMAN_TOUCH_RULE`).
   */
  filter?: PopulationFilter;
}

/** BigQuery returns TIMESTAMP/DATE as `{ value: string }`; flatten to a plain ISO string. */
function bqIsoString(val: unknown): string | null {
  if (val == null) return null;
  if (typeof val === 'string') return val;
  if (typeof val === 'object' && 'value' in val) {
    const inner = (val as { value: unknown }).value;
    return typeof inner === 'string' ? inner : null;
  }
  return null;
}

function bqInt(val: unknown): number {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') return Number(val);
  if (val != null && typeof val === 'object' && 'value' in val) {
    return Number((val as { value: unknown }).value);
  }
  return Number.NaN;
}

export function buildPopulationSql(asOf?: string, filter: PopulationFilter = 'all'): string {
  // FOR SYSTEM_TIME AS OF accepts a named parameter (verified against BigQuery);
  // the client maps a JS Date to TIMESTAMP.
  const atClause = asOf ? ' for system_time as of @as_of' : '';
  /*
   * `gemma.threads.dialogue_id` is STRING and it is INT64 on the event table, so the cast
   * is load-bearing. The event window runs past the snapshot's own because a handover can
   * land days after the conversation opened; `started_at` is the partition column.
   *
   * The dialogue ids get their own CTE because a time-travelled table cannot take an
   * alias — `FROM t FOR SYSTEM_TIME AS OF x AS a` is a syntax error — and the join needs
   * one to say which `dialogue_id` it means.
   */
  const reachedRule =
    filter === 'escalated'
      ? `  join \`${TURN_EVENTS_TABLE}\` as events using (dialogue_id)
  where events.started_at >= timestamp(date(@date_from))
    and events.started_at < timestamp(date_add(date(@date_to), interval ${ESCALATION_LOOKAHEAD_DAYS} day))
    and events.tool_name in ('create_support_task', 'amend_support_task')
    and not events.is_error
    and not starts_with(json_value(events.span_outputs, '$.content'), 'Rethink requested')`
      : `  join \`${HUMAN_TOUCH_TABLE}\` as touch using (dialogue_id)`;
  const escCtes =
    filter === 'all'
      ? ''
      : `reached_dialogues as (
  select thread_id, safe_cast(dialogue_id as int64) as dialogue_id
  from \`${THREADS_TABLE}\`${atClause}
),
reached as (
  select distinct reached_dialogues.thread_id
  from reached_dialogues
${reachedRule}
),
`;
  const escClause =
    filter === 'all' ? '' : '\n  and sel.thread_id in (select thread_id from reached)';
  return `
with ${escCtes}sel as (
  select thread_id, path_key
  from \`${THREAD_SCENARIOS_TABLE}\`${atClause}
  where ${SELECTOR_PREDICATE} and path_key in unnest(@path_keys)
),
th as (
  select
    thread_id,
    min(dialogue_created_at) as first_at,
    any_value(customer_alias) as customer_alias,
    array_agg(
      struct(dialogue_id, thread_position, kind, dialogue_created_at)
      order by thread_position, dialogue_created_at
    ) as dialogues
  from \`${THREADS_TABLE}\`${atClause}
  group by thread_id
)
select sel.thread_id, sel.path_key, th.first_at, th.customer_alias, th.dialogues
from sel join th using (thread_id)
where date(th.first_at) between @date_from and @date_to${escClause}
`.trim();
}

interface RawRow {
  thread_id: string;
  path_key: string;
  first_at: unknown;
  customer_alias: string | null;
  dialogues: Array<{
    dialogue_id: string;
    thread_position: unknown;
    kind: string | null;
    dialogue_created_at: unknown;
  }> | null;
}

export async function selectPopulation(
  options: SelectPopulationOptions,
): Promise<PopulationThread[]> {
  const params: Record<string, unknown> = {
    path_keys: [...options.pathKeys],
    date_from: options.dateFrom,
    date_to: options.dateTo,
  };
  if (options.asOf) params.as_of = new Date(options.asOf);

  const filter = options.filter ?? 'all';
  const rows = await getBigQueryService().query<RawRow>(
    buildPopulationSql(options.asOf, filter),
    params,
    {
      maximumBytesBilled:
        filter === 'all' ? MAXIMUM_BYTES_BILLED : MAXIMUM_BYTES_BILLED_ESCALATED,
    },
  );

  return rows.map((row) => ({
    thread_id: String(row.thread_id),
    path_key: row.path_key,
    first_dialogue_at: bqIsoString(row.first_at) ?? '',
    customer_alias: row.customer_alias ?? '',
    dialogues: (row.dialogues ?? []).map((d) => ({
      // dialogue_id is STRING in gemma.threads (INT64 everywhere else) — keep it a string.
      dialogue_id: String(d.dialogue_id),
      thread_position: bqInt(d.thread_position),
      kind: d.kind ?? '',
      created_at: bqIsoString(d.dialogue_created_at) ?? '',
    })),
  }));
}

export function countByCategory(
  threads: PopulationThread[],
  pathKeys: readonly string[],
): CategoryCount[] {
  return pathKeys.map((pathKey) => {
    const inCategory = threads.filter((t) => t.path_key === pathKey);
    return {
      path_key: pathKey,
      threads: inCategory.length,
      dialogues: inCategory.reduce((sum, t) => sum + t.dialogues.length, 0),
      customers: new Set(inCategory.map((t) => t.customer_alias)).size,
    };
  });
}

import {
  isCardLike,
  isCardThread,
  type LedgerCandidate,
  type OrderCandidate,
  type ThreadBundle,
} from './bundle.js';
import type { PaymentExtraction } from './extraction.js';

/**
 * Payment problem classifier — M2: the deterministic step between pass 1a and 1b.
 *
 * Pass 1a says what the text claims about the payment; this file turns that into at
 * most forty of the customer's own records for pass 1b to choose from. It is the one
 * place in the pipeline where a script narrows the data, and it narrows only what the
 * model *sees as candidates* — never whether a thread is read. A thread whose text
 * names nothing still gets the proximity floor, and a thread whose shortlist comes
 * back empty still goes to pass 1b (to answer NOT_FOUND) and then to pass 2.
 *
 * Over-inclusion is the safe error here, so:
 *  - a row is kept, not dropped, when its direction disagrees with the extraction;
 *  - currency never gates an amount match (the fraud-log/ledger currency trap), it
 *    is only reported;
 *  - both `amount` and `transaction_amount` are tried.
 */

export const SHORTLIST_MAX_ROWS = 40;

/** The proximity floor: records this close to the thread, capped. */
const PROXIMITY_DAYS = 3;
const PROXIMITY_MAX_ROWS = 15;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Amounts are compared as absolute values to half a penny. */
const AMOUNT_TOLERANCE = 0.005;

const NAME_STOP_WORDS = new Set([
  'ltd',
  'limited',
  'the',
  'and',
  'mr',
  'mrs',
  'ms',
  'miss',
  'dr',
]);
const STRONG_NAME_TOKEN = 4;
/** (b) below: half the union of the two token sets has to be shared. */
const MIN_JACCARD = 0.5;

export const REASON = {
  explicitId: 'explicit_id',
  /** `amount` matched an extracted value. */
  amount: 'amount',
  /** `transaction_amount` matched but `amount` did not — currency-converted row. */
  amountTxn: 'amount_txn',
  /** The amount matched but the extraction named a different currency. */
  currencyMismatch: 'currency_mismatch',
  counterparty: 'counterparty',
  proximity: 'proximity',
  /** Kept anyway: a customer chasing "my payment" may have the direction wrong. */
  directionMismatch: 'direction_mismatch',
} as const;

export interface ShortlistRow {
  /** `S01…S40`, chronological within the shortlist. The bundle's C/O handles are not shown. */
  handle: string;
  kind: 'ledger' | 'order';
  /** Ledger `id` or order `public_id` — what pass 1b hands back. */
  id: string;
  reasons: string[];
  row: LedgerCandidate | OrderCandidate;
}

export interface ShortlistResult {
  rows: ShortlistRow[];
  /** Matches that lost their place to the 40-row cap. */
  omitted: number;
  /** Reason → number of shortlisted rows carrying it (the omitted rows are not counted). */
  reasons_summary: Record<string, number>;
}

interface Entry {
  kind: 'ledger' | 'order';
  id: string;
  date: string | null;
  cardLike: boolean;
  /** Absolute value of the posted amount, or of the order amount. */
  amount: number | null;
  currency: string | null;
  /** Absolute value of `transaction_amount`, ledger rows only. */
  txnAmount: number | null;
  txnCurrency: string | null;
  direction: 'in' | 'out';
  names: string[][];
  row: LedgerCandidate | OrderCandidate;
  reasons: Set<string>;
}

function abs(value: string | null): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.abs(n) : null;
}

/**
 * lower-case, strip punctuation, split, drop the stop-list.
 *
 * Single-letter tokens are kept: an initial is the only thing separating "MRS M LAU"
 * from every other Lau on the customer's ledger, and dropping it left the surname as
 * the whole of the name.
 */
export function nameTokens(name: string | null): string[] {
  if (name == null) return [];
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 0 && !NAME_STOP_WORDS.has(token));
}

/**
 * Either (a) the shorter name sits whole inside the longer one — initials included, so
 * `[m, lau]` needs both `m` and `lau` — or (b) the two token sets overlap by at least
 * half (Jaccard) with at least one shared token of four characters or more.
 *
 * The old rule was one shared strong token, which made "MRS M LAU" (a single token,
 * `lau`, once the honorific went) match HON WAI LAU and CURTIS LAU and fill the
 * 40-row cap with the customer's other payees.
 */
export function nameMatch(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;

  const setA = new Set(a);
  const setB = new Set(b);

  const aIsShorter = a.length <= b.length;
  const shorter = aIsShorter ? a : b;
  const setLonger = aIsShorter ? setB : setA;
  if (shorter.every((token) => setLonger.has(token))) return true;

  let shared = 0;
  let strongShared = false;
  for (const token of setA) {
    if (!setB.has(token)) continue;
    shared += 1;
    if (token.length >= STRONG_NAME_TOKEN) strongShared = true;
  }
  if (!strongShared) return false;
  const union = setA.size + setB.size - shared;
  return union > 0 && shared / union >= MIN_JACCARD;
}

function toEntry(candidate: LedgerCandidate | OrderCandidate, kind: 'ledger' | 'order'): Entry {
  if (kind === 'order') {
    const order = candidate as OrderCandidate;
    return {
      kind,
      id: order.public_id ?? '',
      date: order.created,
      cardLike: false,
      amount: abs(order.amount),
      currency: order.currency,
      txnAmount: null,
      txnCurrency: null,
      direction: 'out',
      names: [nameTokens(order.to_account_name)],
      row: order,
      reasons: new Set<string>(),
    };
  }
  const ledger = candidate as LedgerCandidate;
  const signed = Number(ledger.amount ?? '0');
  return {
    kind,
    id: ledger.id,
    date: ledger.date,
    cardLike: isCardLike(ledger.type),
    amount: abs(ledger.amount),
    currency: ledger.currency,
    txnAmount: abs(ledger.transaction_amount),
    txnCurrency: ledger.transaction_currency,
    direction: signed < 0 ? 'out' : 'in',
    names: [
      nameTokens(ledger.transfer_details_account_name),
      nameTokens(ledger.original_payee_account_name),
      nameTokens(ledger.account_details_account_name),
      nameTokens(ledger.description),
    ],
    row: ledger,
    reasons: new Set<string>(),
  };
}

function near(actual: number | null, wanted: number): boolean {
  return actual != null && Math.abs(actual - wanted) <= AMOUNT_TOLERANCE;
}

function amountReasons(entry: Entry, extraction: PaymentExtraction): string[] {
  const reasons: string[] = [];
  for (const wanted of extraction.amounts) {
    if (near(entry.amount, wanted.value)) {
      reasons.push(REASON.amount);
      if (wanted.currency != null && entry.currency != null && wanted.currency !== entry.currency) {
        reasons.push(REASON.currencyMismatch);
      }
    } else if (near(entry.txnAmount, wanted.value)) {
      reasons.push(REASON.amountTxn);
      if (
        wanted.currency != null &&
        entry.txnCurrency != null &&
        wanted.currency !== entry.txnCurrency
      ) {
        reasons.push(REASON.currencyMismatch);
      }
    }
  }
  return reasons;
}

function counterpartyMatches(entry: Entry, extraction: PaymentExtraction): boolean {
  for (const name of extraction.counterparties) {
    const wanted = nameTokens(name);
    if (wanted.length === 0) continue;
    for (const candidate of entry.names) {
      if (nameMatch(wanted, candidate)) return true;
    }
  }
  return false;
}

function millisFrom(anchor: number, iso: string | null): number {
  if (iso == null) return Number.POSITIVE_INFINITY;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : Math.abs(t - anchor);
}

function hasAmountReason(reasons: Set<string>): boolean {
  return reasons.has(REASON.amount) || reasons.has(REASON.amountTxn);
}

/** `explicit_id` > (`amount` and `counterparty`) > `amount` > `counterparty` > `proximity`. */
function tier(reasons: Set<string>): number {
  if (reasons.has(REASON.explicitId)) return 0;
  const amount = hasAmountReason(reasons);
  const counterparty = reasons.has(REASON.counterparty);
  if (amount && counterparty) return 1;
  if (amount) return 2;
  if (counterparty) return 3;
  return 4;
}

/** Reasons in a stable, readable order rather than discovery order. */
const REASON_ORDER = [
  REASON.explicitId,
  REASON.amount,
  REASON.amountTxn,
  REASON.currencyMismatch,
  REASON.counterparty,
  REASON.proximity,
  REASON.directionMismatch,
];

function orderReasons(reasons: Set<string>): string[] {
  return REASON_ORDER.filter((reason) => reasons.has(reason));
}

export function shortlistCandidates(
  bundle: ThreadBundle,
  extraction: PaymentExtraction,
): ShortlistResult {
  const anchorMs = new Date(bundle.meta.first_dialogue_at).getTime();
  const anchor = Number.isNaN(anchorMs) ? 0 : anchorMs;
  const cardThread = isCardThread(bundle.meta.path_key);

  /* One entry per record. An order whose public_id is already a ledger row in this
   * bundle is dropped: that ledger candidate carries the order on it. */
  const ledgerIds = new Set(bundle.candidates.ledger.map((c) => c.id));
  const entries: Entry[] = bundle.candidates.ledger.map((c) => toEntry(c, 'ledger'));
  for (const order of bundle.candidates.orders_without_ledger) {
    if (order.public_id == null || order.public_id === '') continue;
    if (ledgerIds.has(order.public_id)) continue;
    entries.push(toEntry(order, 'order'));
  }

  const wantedIds = new Set(extraction.explicit_ids.map((id) => id.toLowerCase()));
  for (const entry of entries) {
    if (entry.id !== '' && wantedIds.has(entry.id.toLowerCase())) {
      entry.reasons.add(REASON.explicitId);
    }
    for (const reason of amountReasons(entry, extraction)) entry.reasons.add(reason);
    /* Card presentments (and fees, cash, FX) are reachable by id or amount only —
     * their counterparty text is a merchant descriptor, and they are not what a
     * "where is my payment" thread is about. On a card thread the merchant descriptor
     * is exactly what the customer names, so the exclusion is lifted there. */
    if ((cardThread || !entry.cardLike) && counterpartyMatches(entry, extraction)) {
      entry.reasons.add(REASON.counterparty);
    }
  }

  /* The proximity floor. Bank transfers only, nearest first, capped — and on a card
   * thread card rows as well, since a declined card payment often carries no amount in
   * the text and the floor is then the only way it reaches pass 1b at all. */
  const nearby = entries
    .filter(
      (entry) =>
        (cardThread || !entry.cardLike) &&
        millisFrom(anchor, entry.date) <= PROXIMITY_DAYS * DAY_MS,
    )
    .sort(
      (a, b) =>
        millisFrom(anchor, a.date) - millisFrom(anchor, b.date) || (a.id < b.id ? -1 : 1),
    )
    .slice(0, PROXIMITY_MAX_ROWS);
  for (const entry of nearby) entry.reasons.add(REASON.proximity);

  /* Direction is a tag, never a filter. */
  const matched = entries.filter((entry) => entry.reasons.size > 0);
  if (extraction.direction !== 'unknown') {
    for (const entry of matched) {
      if (entry.direction !== extraction.direction) entry.reasons.add(REASON.directionMismatch);
    }
  }

  const ranked = matched.slice().sort((a, b) => {
    const byTier = tier(a.reasons) - tier(b.reasons);
    if (byTier !== 0) return byTier;
    const byDelta = millisFrom(anchor, a.date) - millisFrom(anchor, b.date);
    if (byDelta !== 0) return byDelta;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const kept = ranked.slice(0, SHORTLIST_MAX_ROWS);
  const omitted = ranked.length - kept.length;

  const chronological = kept.slice().sort((a, b) => {
    const ta = a.date ?? '';
    const tb = b.date ?? '';
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const rows: ShortlistRow[] = chronological.map((entry, i) => ({
    handle: `S${String(i + 1).padStart(2, '0')}`,
    kind: entry.kind,
    id: entry.id,
    reasons: orderReasons(entry.reasons),
    row: entry.row,
  }));

  const reasonsSummary: Record<string, number> = {};
  for (const row of rows) {
    for (const reason of row.reasons) {
      reasonsSummary[reason] = (reasonsSummary[reason] ?? 0) + 1;
    }
  }

  return { rows, omitted, reasons_summary: reasonsSummary };
}

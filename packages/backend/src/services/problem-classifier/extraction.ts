import { z } from 'zod';

/**
 * Payment problem classifier — M2: what pass 1a ("extract") returns.
 *
 * Pass 1a reads the dialogues and the windowed tasks only, with no candidate list,
 * and reports what the *text* says about the payment. Nothing here is matched
 * against the ledger; that is `shortlist.ts`'s job. So every field is "as written":
 * amounts are absolute values, names are the customer's spelling, dates are only as
 * precise as the conversation allows.
 *
 * The schema is deliberately tolerant. An LLM will hand back `"3,750.00"`,
 * `£3750`, a bare number instead of an object, `"outgoing"` instead of `"out"`,
 * duplicate ids and blank strings. All of that is normalised or dropped rather
 * than rejected, because a hard parse failure would cost a thread its pass 1b.
 */

export interface PaymentExtraction {
  /** UUIDs or other ids quoted in text. */
  explicit_ids: string[];
  /** Absolute values as written. */
  amounts: { value: number; currency: string | null }[];
  /** Payee / sender names as written. */
  counterparties: string[];
  direction: 'in' | 'out' | 'unknown';
  /** YYYY-MM-DD as far as the text allows. */
  dates: string[];
  /** The conversation is not about a specific payment. */
  no_payment_discussed: boolean;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  '£': 'GBP',
  $: 'USD',
  '€': 'EUR',
};

/** Trim, drop empties, drop case-insensitive duplicates, keep the first spelling. */
function cleanStrings(values: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text === '') continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

/**
 * "£3,750.00" → 3750, "1234,56" → 1234.56, "-216" → 216.
 *
 * A comma is a decimal separator only when it is the sole comma, has exactly two
 * digits after it and there is no dot; otherwise it is a thousands separator.
 */
export function parseAmountValue(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.abs(raw) : null;
  if (typeof raw !== 'string') return null;
  let text = raw.replace(/[^\d.,-]/g, '').trim();
  if (text === '') return null;
  const commas = (text.match(/,/g) ?? []).length;
  if (commas === 1 && !text.includes('.') && /,\d{2}$/.test(text)) {
    text = text.replace(',', '.');
  } else {
    text = text.replace(/,/g, '');
  }
  const value = Number(text);
  return Number.isFinite(value) ? Math.abs(value) : null;
}

/** "£" → "GBP", " gbp " → "GBP", "" / unknown shapes → null. */
export function normaliseCurrency(raw: unknown): string | null {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (text === '') return null;
  const symbol = CURRENCY_SYMBOLS[text];
  if (symbol) return symbol;
  return text.toUpperCase();
}

const LooseStringArray = z
  .array(z.unknown())
  .catch([])
  .default([])
  .transform(cleanStrings);

const AmountInput = z.union([
  z.number(),
  z.string(),
  z.object({ value: z.unknown(), currency: z.unknown() }),
]);

function cleanAmounts(values: z.infer<typeof AmountInput>[]): {
  value: number;
  currency: string | null;
}[] {
  const out: { value: number; currency: string | null }[] = [];
  const seen = new Set<string>();
  for (const entry of values) {
    const isObject = typeof entry === 'object' && entry !== null;
    const value = parseAmountValue(isObject ? entry.value : entry);
    if (value == null || value === 0) continue;
    const currency = normaliseCurrency(isObject ? entry.currency : null);
    const key = `${value.toFixed(4)}|${currency ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ value, currency });
  }
  return out;
}

const DIRECTION_ALIASES: Record<string, PaymentExtraction['direction']> = {
  in: 'in',
  incoming: 'in',
  inbound: 'in',
  credit: 'in',
  received: 'in',
  out: 'out',
  outgoing: 'out',
  outbound: 'out',
  debit: 'out',
  sent: 'out',
};

const LooseDirection = z
  .preprocess((raw) => {
    if (raw == null) return 'unknown';
    const text = String(raw).trim().toLowerCase();
    return DIRECTION_ALIASES[text] ?? text;
  }, z.enum(['in', 'out', 'unknown']))
  .catch('unknown');

const LooseBool = z
  .preprocess((raw) => {
    if (typeof raw === 'string') {
      const text = raw.trim().toLowerCase();
      if (text === 'true' || text === 'yes' || text === '1') return true;
      if (text === 'false' || text === 'no' || text === '0' || text === '') return false;
    }
    if (typeof raw === 'number') return raw !== 0;
    return raw ?? false;
  }, z.boolean())
  .catch(false);

/**
 * Typed as `ZodType<PaymentExtraction, …>` on purpose: the annotation makes the
 * compiler check that the schema's output still matches the interface above.
 */
export const PaymentExtractionSchema: z.ZodType<PaymentExtraction, z.ZodTypeDef, unknown> = z
  .object({
    explicit_ids: LooseStringArray,
    amounts: z.array(AmountInput).catch([]).default([]).transform(cleanAmounts),
    counterparties: LooseStringArray,
    direction: LooseDirection,
    dates: LooseStringArray,
    no_payment_discussed: LooseBool,
  })
  .strip();

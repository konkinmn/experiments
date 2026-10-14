/** Shared formatters for the problem-classifier page. */

export function shortId(id: string | null | undefined, chars = 8): string {
  if (!id) return '—';
  return id.length <= chars ? id : id.slice(0, chars);
}

export function formatInt(n: number | null | undefined): string {
  if (n == null) return '—';
  return n.toLocaleString('en-GB');
}

export function formatCost(usd: number | null | undefined): string {
  if (usd == null) return 'cost not returned';
  return `$${usd.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Plan estimates are small — keep four decimals so a cheap pass isn't "$0.00". */
export function formatCostPrecise(usd: number | null | undefined): string {
  if (usd == null) return '—';
  return `$${usd.toLocaleString('en-GB', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatTimeSeconds(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

export function formatLatency(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** `not started` / `37 of 122` / `complete` — never a breakdown by state. */
export function progressLabel(done: number, total: number): string {
  if (total === 0) return 'not started';
  if (done === 0) return 'not started';
  if (done >= total) return 'complete';
  return `${formatInt(done)} of ${formatInt(total)}`;
}

export function errorMessage(err: unknown): string | null {
  if (!err) return null;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * WorkStation base, same host the case-browser and queue-analyser link to.
 * `wsLink` comes from the backend per row; this is only the fallback for a
 * backend that has not shipped it yet, and it lands on the customer's task
 * list rather than pretending to deep-link the thread.
 */
const WS_BASE = 'https://chat-workstation.k1.anna.money';

export function wsCustomerLink(alias: string | null | undefined): string | null {
  if (!alias) return null;
  return `${WS_BASE}/${alias}/tasks`;
}

/** Collapses a multi-line model sentence into one table-safe line. */
export function oneLine(text: string | null | undefined): string {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim();
}

/** Next unused single-letter induction label, so a new run does not clash. */
export function nextLabel(used: string[]): string {
  const taken = new Set(used.map((l) => l.trim().toLowerCase()));
  for (let i = 0; i < 26; i += 1) {
    const letter = String.fromCharCode(97 + i);
    if (!taken.has(letter)) return letter;
  }
  return `l${used.length + 1}`;
}

/** `1 payment` / `13 payments` — the count with its noun, never mismatched. */
export function paymentsWords(n: number): string {
  return `${formatInt(n)} payment${n === 1 ? '' : 's'}`;
}

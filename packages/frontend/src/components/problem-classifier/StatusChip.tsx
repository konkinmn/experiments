import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';

interface StatusChipProps {
  /** Already-composed parts: what this run is, in the reader's words. */
  parts: string[];
  running: boolean;
  /** 0–100, only while a job runs. */
  progressPct: number | null;
  open: boolean;
  onToggle: () => void;
}

/**
 * The only thing the page says about snapshots and runs by default: one plain
 * line naming the run being read. Clicking it opens the Advanced panel, which
 * is where every action lives.
 */
export function StatusChip({ parts, running, progressPct, open, onToggle }: StatusChipProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title="Which run this page is reading — click for snapshot, run and pipeline controls"
      className="pc-focus pc-dim inline-flex max-w-full items-center gap-2 py-1 text-[13px] hover:text-[var(--pc-ink)]"
    >
      {running && <Loader2 className="h-3 w-3 shrink-0 animate-spin" />}
      <span className="pc-tnum truncate">{parts.join(', ')}</span>
      {running && progressPct != null && (
        <span className="hidden h-1 w-16 shrink-0 overflow-hidden rounded-full bg-[var(--pc-line)] sm:block">
          <span
            className="block h-full rounded-full bg-primary"
            style={{ width: `${progressPct}%` }}
          />
        </span>
      )}
      {open ? (
        <ChevronDown className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <ChevronRight className="h-3.5 w-3.5 shrink-0" />
      )}
    </button>
  );
}

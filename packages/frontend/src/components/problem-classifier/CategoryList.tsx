import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Report, ReportScenarioCount, RunSummary } from '@/types';
import { formatInt, paymentsWords, progressLabel } from './format';
import { UNASSIGNED, UNASSIGNED_LABEL } from './problem';
import { ScenarioSwitcher } from './ScenarioSwitcher';

/**
 * The one group that is not a problem: the customer asked, the answer was
 * right, nothing needs to change. Matched on the induced name because the
 * induction writes it fresh on every run.
 */
function isNonProblem(name: string): boolean {
  return /answered correctly|no change (needed|required)|not a problem/i.test(name);
}

interface CategoryListProps {
  report: Report | null;
  loading: boolean;
  error: string | null;
  passes: RunSummary['passes'] | null;
  /** Problem name, UNASSIGNED, or null for no filter. */
  selected: string | null;
  onSelect: (value: string | null) => void;
  /** The scenario the page is scoped to, as a path key, or null for the whole run. */
  scenarioKey: string | null;
  onSelectScenario: (pathKey: string | null) => void;
  hasRun: boolean;
}

/**
 * One sentence for an unfinished pipeline. No counts by state and no problem
 * counts here: the report endpoint decides when a number is final, and this
 * page never adds up rows itself.
 */
function pendingSentence(report: Report, passes: RunSummary['passes'] | null): string {
  if (!report.pass1.complete) {
    return `Pass 1 (which payment) is ${progressLabel(passes?.pass1.done ?? 0, passes?.pass1.total ?? 0)} — problems appear once pass 3 finishes.`;
  }
  if (!report.pass2.complete) {
    return `Pass 2 (what happened) is ${progressLabel(passes?.pass2.done ?? 0, passes?.pass2.total ?? 0)} — problems appear once pass 3 finishes.`;
  }
  if (!report.pass3) {
    return 'Pass 3 has not induced problems for this label yet.';
  }
  return 'Pass 3 is still running — problems appear when it finishes.';
}

function Note({ children }: { children: ReactNode }) {
  return <p className="pc-dim text-[15px]">{children}</p>;
}

interface BarProps {
  threads: number;
  /** Longest bar in the list — every fill is drawn against it. */
  maxThreads: number;
  selected: boolean;
  /** The non-problem group: hatched, because it is not work to be done. */
  nonProblem?: boolean;
}

/**
 * A problem's bar: threads / longest bar in the list, one fill. The list answers
 * "where is the volume" inside whatever the page is scoped to, and nothing else —
 * the split by scenario is now the switcher above, not a colour inside the bar.
 */
function CategoryBar({ threads, maxThreads, selected, nonProblem }: BarProps) {
  const pct = maxThreads > 0 ? Math.max(1, (threads / maxThreads) * 100) : 0;

  return (
    <span
      className={cn(
        'mt-[5px] block h-2.5 w-[220px] rounded-sm bg-[var(--pc-line)]',
        selected && 'pc-bar-picked',
      )}
    >
      <span
        className={cn('block h-full rounded-sm', nonProblem && 'pc-hatch')}
        style={{
          width: `${pct}%`,
          ...(nonProblem ? {} : { backgroundColor: 'var(--pc-bar-fill)' }),
        }}
      />
    </span>
  );
}

/** One row of the list, already scoped: the count is whatever scope it was built in. */
interface ListRow {
  /** Problem name, or the UNASSIGNED sentinel — the filter value. */
  key: string;
  label: string;
  threads: number;
  /**
   * The line under the count. `13 payments` for the whole run, because the spec
   * collapses to the payment before counting; `of 51 overall` inside a scenario,
   * where the payment count is not available per leaf.
   */
  secondary: string | null;
  definition: string;
  whatRemovesIt: string | null;
  nonProblem?: boolean;
  quiet?: boolean;
}

interface RowProps {
  row: ListRow;
  maxThreads: number;
  selected: boolean;
  onSelect: () => void;
}

function CategoryRow({ row, maxThreads, selected, onSelect }: RowProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'pc-focus pc-band block w-full px-3 py-4 text-left',
        selected ? 'bg-[var(--pc-shade)]' : 'hover:bg-[var(--pc-shade)]',
      )}
    >
      <div className="flex items-start gap-6">
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              'text-[17px] font-medium',
              row.quiet ? 'pc-dim' : 'text-[var(--pc-ink)]',
            )}
          >
            {row.label}
          </p>
          <p className="pc-dim mt-1.5 truncate text-[15px]" title={row.definition}>
            {row.definition}
          </p>
          {row.whatRemovesIt && (
            <p className="pc-dim mt-1 truncate text-[13px]" title={row.whatRemovesIt}>
              Would remove it: {row.whatRemovesIt}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-start gap-4">
          <CategoryBar
            threads={row.threads}
            maxThreads={maxThreads}
            selected={selected}
            nonProblem={row.nonProblem}
          />
          <span className="w-24 text-right">
            <span className="pc-tnum block text-[15px] leading-none">
              {formatInt(row.threads)}
            </span>
            {row.secondary && (
              <span className="pc-dim pc-tnum mt-1.5 block text-[13px]">{row.secondary}</span>
            )}
          </span>
        </div>
      </div>
    </button>
  );
}

/** A leaf's count inside a per-scenario split. Absent means none, not unknown. */
function inScenario(rows: ReportScenarioCount[] | null | undefined, pathKey: string): number {
  return rows?.find((r) => r.pathKey === pathKey)?.threads ?? 0;
}

/**
 * The result, inside the chosen scope: the scenario switcher, then one row per induced
 * problem, biggest first. With a scenario picked the counts are that scenario's own and
 * the rows it has none of drop out; with `All scenarios` it is the whole run. Clicking
 * a row filters the threads table below.
 */
export function CategoryList({
  report,
  loading,
  error,
  passes,
  selected,
  onSelect,
  scenarioKey,
  onSelectScenario,
  hasRun,
}: CategoryListProps) {
  if (!hasRun) {
    return <Note>No run selected — open Advanced to pick a snapshot and a run.</Note>;
  }

  if (loading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-1">
        <Note>The problems did not load. Reopen the page to try again.</Note>
        <p className="pc-dim text-[13px]">{error}</p>
      </div>
    );
  }

  if (!report) {
    return <Note>Nothing has run in this run yet.</Note>;
  }

  const pass3 = report.pass3;
  if (!pass3 || !pass3.complete) {
    return <Note>{pendingSentence(report, passes)}</Note>;
  }

  const unassignedTotal = pass3.unassigned.length;
  const scenarios = pass3.scenarioTotals ?? [];
  const unassignedByScenario = pass3.unassignedByScenario ?? [];

  // Biggest problem first — the reader's question is "where is the volume", inside
  // whatever scope is picked. Ties keep the induction's order (Array.sort is stable).
  const problems: ListRow[] = pass3.categories
    .map((c) => ({
      key: c.name,
      label: c.name,
      threads: scenarioKey ? inScenario(c.byScenario, scenarioKey) : c.threads,
      secondary: scenarioKey
        ? `of ${formatInt(c.threads)} overall`
        : paymentsWords(c.distinctPayments),
      definition: c.definition,
      whatRemovesIt: c.whatRemovesIt,
      nonProblem: isNonProblem(c.name),
    }))
    .filter((r) => !scenarioKey || r.threads > 0)
    .sort((a, b) => b.threads - a.threads);

  // Last in the list wherever it appears: it is the absence of a problem, not a small one.
  const unassignedThreads = scenarioKey
    ? inScenario(unassignedByScenario, scenarioKey)
    : unassignedTotal;
  const rows =
    unassignedThreads > 0
      ? [
          ...problems,
          {
            key: UNASSIGNED,
            label: UNASSIGNED_LABEL,
            threads: unassignedThreads,
            secondary: scenarioKey ? `of ${formatInt(unassignedTotal)} overall` : null,
            definition: 'No induced problem fitted these threads.',
            whatRemovesIt: null,
            quiet: true,
          },
        ]
      : problems;

  const maxThreads = rows.reduce((max, r) => Math.max(max, r.threads), 0);

  return (
    <div className="space-y-5">
      {report.pilotNotice && <p className="pc-dim text-[15px]">{report.pilotNotice}</p>}

      <ScenarioSwitcher
        scenarios={scenarios}
        selected={scenarioKey}
        onSelect={onSelectScenario}
      />

      <div className="divide-y divide-[var(--pc-line)] border-y border-[var(--pc-line)]">
        {rows.map((row) => (
          <CategoryRow
            key={row.key}
            row={row}
            maxThreads={maxThreads}
            selected={selected === row.key}
            onSelect={() => onSelect(selected === row.key ? null : row.key)}
          />
        ))}
      </div>
    </div>
  );
}

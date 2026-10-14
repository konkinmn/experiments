import { cn } from '@/lib/utils';
import type { ReportScenarioCount } from '@/types';
import { formatInt } from './format';

interface ScenarioSwitcherProps {
  /** The Gemma scenario leaves, in the snapshot's own order. */
  scenarios: ReportScenarioCount[];
  /** The selected leaf's path key, or null for the whole run. */
  selected: string | null;
  onSelect: (pathKey: string | null) => void;
}

interface ButtonProps {
  label: string;
  count: number;
  selected: boolean;
  onClick: () => void;
}

function SwitcherButton({ label, count, selected, onClick }: ButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        'pc-focus pc-band inline-flex items-center gap-1.5 whitespace-nowrap rounded-[5px] px-3 py-1.5 text-[15px]',
        selected
          ? 'bg-[var(--pc-accent)] font-medium text-white'
          : 'hover:bg-[var(--pc-shade)]',
      )}
    >
      <span>{label}</span>
      <span className={cn('pc-tnum', selected ? 'text-white/75' : 'pc-dim')}>
        ({formatInt(count)})
      </span>
    </button>
  );
}

/**
 * The page's scope, chosen first: the whole run, or one Gemma scenario leaf.
 *
 * Everything below reads inside the selection — the problem list counts, the threads
 * table — so this is navigation, not a legend. The counts are the population the
 * snapshot selected by, which is always allowed to be shown; the numbers further down
 * the page are pilot output and are not shares of these.
 */
export function ScenarioSwitcher({ scenarios, selected, onSelect }: ScenarioSwitcherProps) {
  if (scenarios.length === 0) return null;
  const total = scenarios.reduce((sum, s) => sum + s.threads, 0);

  return (
    <div
      role="group"
      aria-label="Gemma scenario"
      className="flex flex-wrap items-center gap-1 rounded-md border border-[var(--pc-line)] p-1"
    >
      <SwitcherButton
        label="All scenarios"
        count={total}
        selected={selected == null}
        onClick={() => onSelect(null)}
      />
      {scenarios.map((s) => (
        <SwitcherButton
          key={s.pathKey}
          label={s.scenario}
          count={s.threads}
          selected={selected === s.pathKey}
          onClick={() => onSelect(s.pathKey)}
        />
      ))}
    </div>
  );
}

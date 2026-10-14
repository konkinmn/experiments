import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import type { Pass1State } from '@/types';
import { UNASSIGNED, UNASSIGNED_LABEL } from './problem';
import { PAYMENT_FOUND_WORDS } from './StateBadge';

export interface ThreadFiltersState {
  pass1State: string;
  /** Induced problem name, or the UNASSIGNED sentinel. */
  category: string;
  search: string;
}

export const EMPTY_THREAD_FILTERS: ThreadFiltersState = {
  pass1State: '',
  category: '',
  search: '',
};

// Fixed enum, so the filter never doubles as a list of what came back.
const PASS1_STATES: Pass1State[] = ['RESOLVED', 'ORDER_ONLY', 'NOT_FOUND', 'UNRESOLVED_HANDLE'];

interface ThreadFiltersProps {
  filters: ThreadFiltersState;
  onChange: (filters: ThreadFiltersState) => void;
  /** Induced problem names, plus UNASSIGNED when pass 3 left anything out. */
  categories: string[];
}

/**
 * Filters *inside* the page's scope. The scenario is not one of them: it is chosen
 * above, in the switcher, and this table is already scoped to it. What is left is the
 * induced problem (also settable by clicking a row in the list), whether pass 1 found
 * the payment, and free text.
 */
export function ThreadFilters({ filters, onChange, categories }: ThreadFiltersProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="w-[22rem]">
        <Input
          className="pc-focus h-9 text-[15px]"
          value={filters.search}
          onChange={(e) => onChange({ ...filters, search: e.target.value })}
          placeholder="Search a thread, a customer, what happened"
        />
      </div>
      <div className="w-64">
        <Select
          className="pc-focus h-9 text-[15px]"
          value={filters.category}
          onChange={(e) => onChange({ ...filters, category: e.target.value })}
          disabled={categories.length === 0}
        >
          <option value="">All problems</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c === UNASSIGNED ? UNASSIGNED_LABEL : c}
            </option>
          ))}
        </Select>
      </div>
      <div className="w-48">
        <Select
          className="pc-focus h-9 text-[15px]"
          value={filters.pass1State}
          onChange={(e) => onChange({ ...filters, pass1State: e.target.value })}
        >
          <option value="">Payment found: any</option>
          {PASS1_STATES.map((s) => (
            <option key={s} value={s}>
              Payment found: {PAYMENT_FOUND_WORDS[s]}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}

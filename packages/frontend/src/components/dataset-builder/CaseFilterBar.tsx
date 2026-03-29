import { Select } from '@/components/ui/select';
import type { LabelFilter, RiskFilter, HardGateFilter, SortOption, FilterMode } from '@/hooks/useCaseFilters';

interface Props {
  labelFilter: LabelFilter;
  onLabelFilterChange: (v: LabelFilter) => void;
  riskFilter: RiskFilter;
  onRiskFilterChange: (v: RiskFilter) => void;
  hardGateFilter: HardGateFilter;
  onHardGateFilterChange: (v: HardGateFilter) => void;
  sortOption: SortOption;
  onSortChange: (v: SortOption) => void;
  totalCount: number;
  filteredCount: number;
  mode?: FilterMode;
}

export function CaseFilterBar({
  labelFilter,
  onLabelFilterChange,
  riskFilter,
  onRiskFilterChange,
  hardGateFilter,
  onHardGateFilterChange,
  sortOption,
  onSortChange,
  totalCount,
  filteredCount,
  mode = 'run',
}: Props) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <div className="flex items-center gap-1.5">
        <label className="text-xs text-muted-foreground whitespace-nowrap">Label</label>
        <Select
          className="h-8 text-xs w-[120px]"
          value={labelFilter}
          onChange={(e) => onLabelFilterChange(e.target.value as LabelFilter)}
        >
          <option value="all">All</option>
          <option value="credit">Credit</option>
          <option value="escalate">Escalate</option>
          <option value="undecided">Undecided</option>
          <option value="unlabeled">Unlabeled</option>
        </Select>
      </div>

      {mode === 'run' && (
        <>
          <div className="flex items-center gap-1.5">
            <label className="text-xs text-muted-foreground whitespace-nowrap">Risk</label>
            <Select
              className="h-8 text-xs w-[100px]"
              value={riskFilter}
              onChange={(e) => onRiskFilterChange(e.target.value as RiskFilter)}
            >
              <option value="all">All</option>
              <option value="green">Green</option>
              <option value="amber">Amber</option>
              <option value="red">Red</option>
            </Select>
          </div>

          <div className="flex items-center gap-1.5">
            <label className="text-xs text-muted-foreground whitespace-nowrap">Hard Gate</label>
            <Select
              className="h-8 text-xs w-[100px]"
              value={hardGateFilter}
              onChange={(e) => onHardGateFilterChange(e.target.value as HardGateFilter)}
            >
              <option value="all">All</option>
              <option value="hit">Hit</option>
              <option value="clear">Clear</option>
            </Select>
          </div>

        </>
      )}

      <div className="flex items-center gap-1.5">
        <label className="text-xs text-muted-foreground whitespace-nowrap">Sort</label>
        <Select
          className="h-8 text-xs w-[160px]"
          value={sortOption}
          onChange={(e) => onSortChange(e.target.value as SortOption)}
        >
          <option value="default">Newest first</option>
          {mode === 'run' && (
            <>
              <option value="risk">Risk (red first)</option>
              <option value="rubric">Rubric score (high first)</option>
            </>
          )}
          <option value="amount">Amount (high first)</option>
          <option value="account_age">Account age (newest first)</option>
        </Select>
      </div>

      {filteredCount !== totalCount && (
        <span className="text-xs text-muted-foreground ml-auto">
          Showing {filteredCount} of {totalCount}
        </span>
      )}
    </div>
  );
}

import { Search, Filter } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';

export interface CaseBrowserFiltersState {
  search: string;
  status: 'IN_PROGRESS' | 'RESOLVED' | 'DISMISSED' | null;
  outcome: string | null;
  decision: 'CREDIT' | 'ESCALATE' | null;
  riskLevel: 'green' | 'amber' | 'red' | null;
  hasAssessment: 'true' | 'false' | null;
  trigger: string | null;
}

interface CaseBrowserFiltersProps {
  filters: CaseBrowserFiltersState;
  onChange: (filters: CaseBrowserFiltersState) => void;
}

export function CaseBrowserFilters({ filters, onChange }: CaseBrowserFiltersProps) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="text"
          placeholder="ref_id, alias, case id..."
          value={filters.search}
          onChange={(e) => onChange({ ...filters, search: e.target.value })}
          className="w-[220px] pl-9"
        />
      </div>

      <div className="relative">
        <Filter className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Select
          value={filters.status ?? ''}
          onChange={(e) => onChange({ ...filters, status: (e.target.value || null) as CaseBrowserFiltersState['status'] })}
          className="w-[150px] pl-9"
        >
          <option value="">All statuses</option>
          <option value="IN_PROGRESS">In progress</option>
          <option value="RESOLVED">Resolved</option>
          <option value="DISMISSED">Dismissed</option>
        </Select>
      </div>

      <div className="relative">
        <Filter className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Select
          value={filters.outcome ?? ''}
          onChange={(e) => onChange({ ...filters, outcome: e.target.value || null })}
          className="w-[200px] pl-9"
        >
          <option value="">All outcomes</option>
          <option value="CUSTOMER_REFUNDED">Customer refunded</option>
          <option value="NO_GROUNDS_FOR_DISPUTE">No grounds for dispute</option>
          <option value="CASE_NOT_REQUIRED">Case not required</option>
          <option value="NO_CUSTOMER_RESPONSE">No customer response</option>
        </Select>
      </div>

      <div className="relative">
        <Filter className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Select
          value={filters.decision ?? ''}
          onChange={(e) => onChange({ ...filters, decision: (e.target.value || null) as CaseBrowserFiltersState['decision'] })}
          className="w-[150px] pl-9"
        >
          <option value="">All decisions</option>
          <option value="CREDIT">Credit</option>
          <option value="ESCALATE">Escalate</option>
        </Select>
      </div>

      <div className="relative">
        <Filter className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Select
          value={filters.riskLevel ?? ''}
          onChange={(e) => onChange({ ...filters, riskLevel: (e.target.value || null) as CaseBrowserFiltersState['riskLevel'] })}
          className="w-[150px] pl-9"
        >
          <option value="">All risk levels</option>
          <option value="green">Green</option>
          <option value="amber">Amber</option>
          <option value="red">Red</option>
        </Select>
      </div>

      <div className="relative">
        <Filter className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Select
          value={filters.hasAssessment ?? ''}
          onChange={(e) =>
            onChange({ ...filters, hasAssessment: (e.target.value || null) as CaseBrowserFiltersState['hasAssessment'] })
          }
          className="w-[170px] pl-9"
        >
          <option value="">Assessment: any</option>
          <option value="true">Has assessment</option>
          <option value="false">No assessment</option>
        </Select>
      </div>

      <div className="relative">
        <Filter className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="text"
          placeholder="Hard gate trigger..."
          value={filters.trigger ?? ''}
          onChange={(e) => onChange({ ...filters, trigger: e.target.value || null })}
          className="w-[200px] pl-9"
        />
      </div>
    </div>
  );
}

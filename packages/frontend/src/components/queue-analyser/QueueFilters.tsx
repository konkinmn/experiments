import { Select } from '@/components/ui/select';
import type { Urgency, TaskStatus, QueueTaskFilters } from '@/types';

interface QueueFiltersProps {
  filters: QueueTaskFilters;
  onChange: (filters: QueueTaskFilters) => void;
}

export function QueueFilters({ filters, onChange }: QueueFiltersProps) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="w-40">
        <Select
          value={filters.urgency ?? ''}
          onChange={(e) => onChange({ ...filters, urgency: (e.target.value || undefined) as Urgency | undefined })}
        >
          <option value="">All urgencies</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </Select>
      </div>
      <div className="w-48">
        <Select
          value={filters.status ?? ''}
          onChange={(e) => onChange({ ...filters, status: (e.target.value || undefined) as TaskStatus | undefined })}
        >
          <option value="">All statuses</option>
          <option value="ready">Ready</option>
          <option value="actionable_now">Actionable now</option>
          <option value="waiting_customer">Waiting on customer</option>
          <option value="waiting_third_party">Waiting on 3rd party</option>
          <option value="needs_info">Needs info</option>
        </Select>
      </div>
      <div className="w-44">
        <Select
          value={filters.quickWin === undefined ? '' : String(filters.quickWin)}
          onChange={(e) =>
            onChange({ ...filters, quickWin: e.target.value === '' ? undefined : e.target.value === 'true' })
          }
        >
          <option value="">Quick win: any</option>
          <option value="true">Quick wins only</option>
          <option value="false">Not quick wins</option>
        </Select>
      </div>
      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input
          type="checkbox"
          className="h-4 w-4"
          checked={filters.wrongQueue === true}
          onChange={(e) => onChange({ ...filters, wrongQueue: e.target.checked ? true : undefined })}
        />
        Wrong queue only
      </label>
    </div>
  );
}

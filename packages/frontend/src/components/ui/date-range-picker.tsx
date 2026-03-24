import * as React from 'react';
import { Calendar } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface DateRange {
  startDate: Date;
  endDate: Date;
}

interface DateRangePickerProps {
  value: DateRange;
  onChange: (range: DateRange) => void;
  className?: string;
}

const presets = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
] as const;

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

function isPresetActive(days: number, range: DateRange): boolean {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const expectedStart = new Date(today);
  expectedStart.setDate(today.getDate() - days);

  const actualStart = new Date(range.startDate);
  actualStart.setHours(0, 0, 0, 0);

  const actualEnd = new Date(range.endDate);
  actualEnd.setHours(0, 0, 0, 0);

  return actualStart.getTime() === expectedStart.getTime() &&
         actualEnd.getTime() === today.getTime();
}

function DateRangePicker({ value, onChange, className }: DateRangePickerProps) {
  const handlePresetClick = (days: number) => {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    onChange({ startDate, endDate });
  };

  const handleStartDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newStart = new Date(e.target.value);
    if (!isNaN(newStart.getTime())) {
      onChange({ ...value, startDate: newStart });
    }
  };

  const handleEndDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newEnd = new Date(e.target.value);
    if (!isNaN(newEnd.getTime())) {
      onChange({ ...value, endDate: newEnd });
    }
  };

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div className="flex items-center gap-1 rounded-md border border-input bg-background p-1">
        {presets.map((preset) => (
          <button
            key={preset.days}
            onClick={() => handlePresetClick(preset.days)}
            className={cn(
              'rounded px-2 py-1 text-xs font-medium transition-colors',
              isPresetActive(preset.days, value)
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
            )}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2">
        <Calendar className="h-4 w-4 text-muted-foreground" />
        <input
          type="date"
          value={formatDate(value.startDate)}
          onChange={handleStartDateChange}
          className="w-[110px] bg-transparent text-sm outline-none"
        />
        <span className="text-muted-foreground">-</span>
        <input
          type="date"
          value={formatDate(value.endDate)}
          onChange={handleEndDateChange}
          className="w-[110px] bg-transparent text-sm outline-none"
        />
      </div>
    </div>
  );
}

export { DateRangePicker };

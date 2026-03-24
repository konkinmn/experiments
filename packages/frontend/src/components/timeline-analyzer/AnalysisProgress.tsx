import { Button } from '@/components/ui/button';
import type { AnalysisProgress as AnalysisProgressType } from '@/types';

interface AnalysisProgressProps {
  progress: AnalysisProgressType;
  onCancel: () => void;
}

export function AnalysisProgress({ progress, onCancel }: AnalysisProgressProps) {
  const percentage = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span>
            Processing case {progress.current + 1} of {progress.total}
          </span>
          <span className="text-muted-foreground">{percentage}%</span>
        </div>

        {/* Progress bar */}
        <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
          <div
            className="h-full bg-primary transition-all duration-300"
            style={{ width: `${percentage}%` }}
          />
        </div>

        {progress.currentCaseId && (
          <p className="text-xs text-muted-foreground">
            Currently analyzing case ID: {progress.currentCaseId}
          </p>
        )}
      </div>

      <div className="flex justify-end">
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

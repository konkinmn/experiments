import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface RubricFormProps {
  onSubmit: (caseId: number) => Promise<void>;
  isPending: boolean;
}

export function RubricForm({ onSubmit, isPending }: RubricFormProps) {
  const [caseIdInput, setCaseIdInput] = useState('');

  const handleRun = async () => {
    const caseId = Number(caseIdInput);
    if (!Number.isInteger(caseId) || caseId <= 0) return;
    try {
      await onSubmit(caseId);
      setCaseIdInput('');
    } catch {
      // error handled by parent via mutation state
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleRun();
    }
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6">
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-gray-900">Run Pipeline</h3>
        <div className="flex items-center gap-3">
          <div className="space-y-1 flex-1 max-w-xs">
            <Input
              type="number"
              min={1}
              value={caseIdInput}
              onChange={(e) => setCaseIdInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Enter Case ID"
            />
          </div>
          <Button onClick={handleRun} disabled={!caseIdInput || isPending}>
            {isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Running pipeline...
              </>
            ) : (
              'Run'
            )}
          </Button>
        </div>
        {isPending && (
          <p className="text-sm text-muted-foreground">
            Fetching signals from BigQuery + running LLM planner...
          </p>
        )}
      </div>
    </div>
  );
}

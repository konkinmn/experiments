import { useState, useMemo } from 'react';
import { Activity } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { AnalysisConfig } from './AnalysisConfig';
import { AnalysisProgress } from './AnalysisProgress';
import { AnalysisResults } from './AnalysisResults';
import { useTimelineAnalyzer } from '@/hooks/useTimelineAnalyzer';
import type { AnalyzerConfig, CaseOverviewItem } from '@/types';

interface TimelineAnalyzerModalProps {
  visibleCases: CaseOverviewItem[];
}

function parseCaseIds(input: string): number[] {
  const ids = input
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseInt(s, 10))
    .filter((n) => !isNaN(n) && n > 0);
  return [...new Set(ids)]; // Dedupe
}

export function TimelineAnalyzerModal({ visibleCases }: TimelineAnalyzerModalProps) {
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<AnalyzerConfig>({
    promptId: '',
    caseSource: 'visible',
    manualCaseIds: '',
  });

  const { status, progress, results, error, startAnalysis, cancelAnalysis, reset } = useTimelineAnalyzer();

  const caseIds = useMemo(() => {
    if (config.caseSource === 'visible') {
      return visibleCases.map((c) => parseInt(c.id, 10)).filter((n) => !isNaN(n));
    }
    return parseCaseIds(config.manualCaseIds);
  }, [config.caseSource, config.manualCaseIds, visibleCases]);

  const canStart = config.promptId && caseIds.length > 0;

  const handleStart = () => {
    if (canStart) {
      startAnalysis(config.promptId, caseIds);
    }
  };

  const handleReset = () => {
    reset();
    setConfig({
      promptId: '',
      caseSource: 'visible',
      manualCaseIds: '',
    });
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen && status === 'running') {
      // Don't close while running
      return;
    }
    if (!newOpen) {
      handleReset();
    }
    setOpen(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Activity className="mr-2 h-4 w-4" />
          Analyze Timelines
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Timeline Analyzer</DialogTitle>
          <DialogDescription>
            Run LLM-powered analysis on case timelines to extract insights.
          </DialogDescription>
        </DialogHeader>

        {status === 'idle' && (
          <>
            <AnalysisConfig
              config={config}
              onChange={setConfig}
              visibleCasesCount={visibleCases.length}
            />
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {caseIds.length} case{caseIds.length !== 1 ? 's' : ''} selected
              </p>
              <Button onClick={handleStart} disabled={!canStart}>
                Run Analysis
              </Button>
            </div>
          </>
        )}

        {status === 'running' && (
          <AnalysisProgress progress={progress} onCancel={cancelAnalysis} />
        )}

        {status === 'completed' && (
          <AnalysisResults results={results} onReset={handleReset} />
        )}

        {status === 'error' && (
          <div className="space-y-4">
            <div className="rounded-md border border-red-200 bg-red-50 p-4">
              <p className="text-sm text-red-800">{error}</p>
            </div>
            <div className="flex justify-end">
              <Button onClick={handleReset}>Try Again</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

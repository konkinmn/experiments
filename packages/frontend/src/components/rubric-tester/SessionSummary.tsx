import { useMemo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import type { PipelineResult } from '@/types';

interface SessionSummaryProps {
  results: PipelineResult[];
}

export function SessionSummary({ results }: SessionSummaryProps) {
  if (results.length === 0) return null;

  const counts = useMemo(() => {
    let credit = 0;
    let escalate = 0;
    let hardGated = 0;
    let reviewedCorrect = 0;
    let reviewedIncorrect = 0;

    for (const r of results) {
      if (r.hardGateTriggered) {
        hardGated++;
      } else if (r.plannerOutput?.decision === 'credit') {
        credit++;
      } else {
        escalate++;
      }
      if (r.reviewerVerdict === 'correct') reviewedCorrect++;
      if (r.reviewerVerdict === 'incorrect') reviewedIncorrect++;
    }

    return { credit, escalate, hardGated, reviewedCorrect, reviewedIncorrect };
  }, [results]);

  return (
    <Card>
      <CardContent className="pt-6">
        <div className="grid grid-cols-5 gap-4 text-center">
          <div>
            <p className="text-2xl font-bold">{results.length}</p>
            <p className="text-xs text-muted-foreground">Total Runs</p>
          </div>
          <div>
            <p className="text-2xl font-bold text-green-600">{counts.credit}</p>
            <p className="text-xs text-muted-foreground">Credit</p>
          </div>
          <div>
            <p className="text-2xl font-bold text-amber-600">{counts.escalate}</p>
            <p className="text-xs text-muted-foreground">Escalate</p>
          </div>
          <div>
            <p className="text-2xl font-bold text-red-600">{counts.hardGated}</p>
            <p className="text-xs text-muted-foreground">Hard-Gated</p>
          </div>
          <div>
            <p className="text-2xl font-bold">
              <span className="text-green-600">{counts.reviewedCorrect}</span>
              <span className="text-muted-foreground">/</span>
              <span className="text-red-600">{counts.reviewedIncorrect}</span>
            </p>
            <p className="text-xs text-muted-foreground">Correct / Incorrect</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

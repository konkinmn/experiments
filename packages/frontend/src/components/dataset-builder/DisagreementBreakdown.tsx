import { Card, CardContent } from '@/components/ui/card';
import type { DisagreementBreakdownEntry } from '@/types';

interface Props {
  breakdown: Record<string, DisagreementBreakdownEntry>;
}

const REASON_LABELS: Record<string, string> = {
  signal_quality: 'Bad signals',
  rubric_issue: 'Rubric issue',
  llm_reasoning: 'LLM reasoning',
  human_label_wrong: 'Human label may be wrong',
  edge_case: 'Edge case',
  other: 'Other',
  no_reason: 'No reason given',
};

export function DisagreementBreakdown({ breakdown }: Props) {
  const entries = Object.entries(breakdown).sort((a, b) => b[1].count - a[1].count);
  const totalCount = entries.reduce((sum, [, v]) => sum + v.count, 0);

  if (totalCount === 0) return null;

  return (
    <Card>
      <CardContent className="pt-6">
        <h3 className="text-sm font-medium text-gray-700 mb-4">
          Disagreement Reasons
          <span className="text-xs font-normal text-gray-400 ml-2">({totalCount} disagreements)</span>
        </h3>
        <div className="space-y-2">
          {entries.map(([reason, { count, percentage }]) => (
            <div key={reason} className="flex items-center gap-3">
              <span className="text-sm w-48 shrink-0">{REASON_LABELS[reason] ?? reason}</span>
              <div className="flex-1 bg-gray-100 rounded-full h-5 relative">
                <div
                  className="bg-red-400 h-5 rounded-full transition-all"
                  style={{ width: `${Math.max(percentage, 2)}%` }}
                />
              </div>
              <span className="text-sm text-gray-600 tabular-nums w-20 text-right">
                {count} ({percentage}%)
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

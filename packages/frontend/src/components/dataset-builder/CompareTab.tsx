import { useState } from 'react';
import { Loader2, ArrowUp, ArrowDown, Minus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { useRunComparison } from '@/hooks/useDatasetBuilder';
import type { DatasetRun } from '@/types';

interface Props {
  datasetId: number;
  runs: DatasetRun[];
}

function MetricCard({
  label,
  valueA,
  valueB,
  delta,
  invertDelta,
}: {
  label: string;
  valueA: number | null;
  valueB: number | null;
  delta: number | null;
  invertDelta?: boolean;
}) {
  const fmt = (v: number | null) => (v != null ? `${v}%` : '—');
  const isGood = invertDelta ? (delta ?? 0) < 0 : (delta ?? 0) > 0;
  const isBad = invertDelta ? (delta ?? 0) > 0 : (delta ?? 0) < 0;

  return (
    <div className="text-center">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <div className="flex items-center justify-center gap-3">
        <span className="text-lg font-bold tabular-nums">{fmt(valueA)}</span>
        <span className="text-xs">
          {delta != null && delta !== 0 ? (
            <span className={`inline-flex items-center gap-0.5 font-medium ${isGood ? 'text-green-600' : isBad ? 'text-red-600' : 'text-gray-400'}`}>
              {delta > 0 ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
              {delta > 0 ? '+' : ''}{delta}%
            </span>
          ) : (
            <Minus className="h-3 w-3 text-gray-300" />
          )}
        </span>
        <span className="text-lg font-bold tabular-nums">{fmt(valueB)}</span>
      </div>
    </div>
  );
}

const DIRECTION_BADGE: Record<string, { label: string; variant: 'green' | 'red' | 'gray' }> = {
  improved: { label: 'Improved', variant: 'green' },
  regressed: { label: 'Regressed', variant: 'red' },
  changed: { label: 'Changed', variant: 'gray' },
};

export function CompareTab({ datasetId, runs }: Props) {
  const completedRuns = runs.filter((r) => r.status === 'completed');
  const [runAId, setRunAId] = useState<number | undefined>(completedRuns[0]?.id);
  const [runBId, setRunBId] = useState<number | undefined>(completedRuns[1]?.id);

  const { data: comparison, isLoading } = useRunComparison(datasetId, runAId, runBId);

  const runAName = completedRuns.find((r) => r.id === runAId)?.name ?? 'Run A';
  const runBName = completedRuns.find((r) => r.id === runBId)?.name ?? 'Run B';

  if (completedRuns.length < 2) {
    return <p className="text-sm text-gray-500 py-4">Need at least 2 completed runs to compare.</p>;
  }

  return (
    <div className="space-y-6">
      {/* Run selectors */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5">
          <label className="text-sm font-medium text-gray-700">Run A:</label>
          <Select
            className="h-9 text-sm w-[220px]"
            value={runAId ?? ''}
            onChange={(e) => setRunAId(e.target.value ? parseInt(e.target.value, 10) : undefined)}
          >
            <option value="">Select run...</option>
            {completedRuns.filter((r) => r.id !== runBId).map((r) => (
              <option key={r.id} value={String(r.id)}>{r.name} ({r.config.model})</option>
            ))}
          </Select>
        </div>
        <span className="text-gray-400">vs</span>
        <div className="flex items-center gap-1.5">
          <label className="text-sm font-medium text-gray-700">Run B:</label>
          <Select
            className="h-9 text-sm w-[220px]"
            value={runBId ?? ''}
            onChange={(e) => setRunBId(e.target.value ? parseInt(e.target.value, 10) : undefined)}
          >
            <option value="">Select run...</option>
            {completedRuns.filter((r) => r.id !== runAId).map((r) => (
              <option key={r.id} value={String(r.id)}>{r.name} ({r.config.model})</option>
            ))}
          </Select>
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
        </div>
      )}

      {comparison && (
        <>
          {/* Side-by-side metrics */}
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-medium text-gray-700">Metrics Comparison</h3>
                <Badge variant={comparison.net_improvement > 0 ? 'green' : comparison.net_improvement < 0 ? 'red' : 'gray'}>
                  Net: {comparison.net_improvement > 0 ? '+' : ''}{comparison.net_improvement} cases
                </Badge>
              </div>
              <div className="grid grid-cols-2 gap-1 mb-3">
                <p className="text-xs text-center text-muted-foreground">{runAName}</p>
                <p className="text-xs text-center text-muted-foreground">{runBName}</p>
              </div>
              <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
                <MetricCard
                  label="Agreement"
                  valueA={comparison.summary.runA.agreement_rate}
                  valueB={comparison.summary.runB.agreement_rate}
                  delta={comparison.summary.delta.agreement_rate}
                />
                <MetricCard
                  label="Credit Precision"
                  valueA={comparison.summary.runA.credit_precision}
                  valueB={comparison.summary.runB.credit_precision}
                  delta={comparison.summary.delta.credit_precision}
                />
                <MetricCard
                  label="Escalate Recall"
                  valueA={comparison.summary.runA.escalate_recall}
                  valueB={comparison.summary.runB.escalate_recall}
                  delta={comparison.summary.delta.escalate_recall}
                />
                <MetricCard
                  label="False Credit Rate"
                  valueA={comparison.summary.runA.false_credit_rate}
                  valueB={comparison.summary.runB.false_credit_rate}
                  delta={comparison.summary.delta.false_credit_rate}
                  invertDelta
                />
              </div>
            </CardContent>
          </Card>

          {/* Flipped cases table */}
          {comparison.flipped_cases.length > 0 && (
            <Card>
              <CardContent className="pt-6">
                <h3 className="text-sm font-medium text-gray-700 mb-4">
                  Flipped Cases
                  <span className="text-xs font-normal text-gray-400 ml-2">({comparison.flipped_cases.length} cases changed)</span>
                </h3>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-xs text-gray-500">
                      <th className="text-left px-3 py-2 font-medium">Case ID</th>
                      <th className="text-left px-3 py-2 font-medium">Human Label</th>
                      <th className="text-center px-3 py-2 font-medium">{runAName}</th>
                      <th className="text-center px-3 py-2 font-medium">{runBName}</th>
                      <th className="text-center px-3 py-2 font-medium">Direction</th>
                    </tr>
                  </thead>
                  <tbody>
                    {comparison.flipped_cases.map((fc) => {
                      const badge = DIRECTION_BADGE[fc.direction];
                      return (
                        <tr key={fc.datasetCaseId} className="border-b last:border-0 hover:bg-gray-50">
                          <td className="px-3 py-2 font-mono">{fc.caseId}</td>
                          <td className="px-3 py-2">{fc.label ?? '—'}</td>
                          <td className="px-3 py-2 text-center">
                            <Badge variant={fc.runA_decision === 'credit' ? 'green' : 'amber'}>{fc.runA_decision}</Badge>
                          </td>
                          <td className="px-3 py-2 text-center">
                            <Badge variant={fc.runB_decision === 'credit' ? 'green' : 'amber'}>{fc.runB_decision}</Badge>
                          </td>
                          <td className="px-3 py-2 text-center">
                            <Badge variant={badge.variant}>{badge.label}</Badge>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}

          {comparison.flipped_cases.length === 0 && (
            <p className="text-sm text-gray-500 py-4">No cases changed decisions between these runs.</p>
          )}
        </>
      )}
    </div>
  );
}

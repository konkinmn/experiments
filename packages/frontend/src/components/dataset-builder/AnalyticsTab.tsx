import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { ConfusionMatrix } from './ConfusionMatrix';
import { StratifiedMetrics } from './StratifiedMetrics';
import { useDatasetAnalytics } from '@/hooks/useDatasetBuilder';
import type { DatasetRun } from '@/types';

interface Props {
  datasetId: number;
  runs?: DatasetRun[];
}

export function AnalyticsTab({ datasetId, runs }: Props) {
  const [selectedRunId, setSelectedRunId] = useState<number | undefined>(undefined);
  const { data: analytics, isLoading } = useDatasetAnalytics(datasetId, selectedRunId, { enabled: true });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    );
  }

  if (!analytics) {
    return <p className="text-sm text-gray-500 py-4">No analytics data available. Label some cases first.</p>;
  }

  const { overall } = analytics;

  return (
    <div className="space-y-6">
      {/* Run selector */}
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium text-gray-700">Source:</label>
        <select
          className="text-sm border border-gray-300 rounded-md px-3 py-1.5 bg-white"
          value={selectedRunId ?? ''}
          onChange={(e) => setSelectedRunId(e.target.value ? parseInt(e.target.value, 10) : undefined)}
        >
          <option value="">Baseline (Labels tab)</option>
          {runs?.map((run) => (
            <option key={run.id} value={run.id}>
              {run.name} ({run.config.model})
            </option>
          ))}
        </select>
      </div>

      {/* Overall metrics */}
      <Card>
        <CardContent className="pt-6">
          <h3 className="text-sm font-medium text-gray-700 mb-4">Overall Metrics</h3>
          <div className="grid grid-cols-5 gap-4 text-center">
            <div>
              <p className="text-2xl font-bold">{overall.sample_size}</p>
              <p className="text-xs text-muted-foreground">Labeled Cases</p>
            </div>
            <div>
              <p className="text-2xl font-bold">
                {overall.agreement_rate != null ? `${overall.agreement_rate}%` : '—'}
              </p>
              <p className="text-xs text-muted-foreground">Agreement</p>
            </div>
            <div>
              <p className="text-2xl font-bold">
                {overall.credit_precision != null ? `${overall.credit_precision}%` : '—'}
              </p>
              <p className="text-xs text-muted-foreground">Credit Precision</p>
            </div>
            <div>
              <p className="text-2xl font-bold">
                {overall.escalate_recall != null ? `${overall.escalate_recall}%` : '—'}
              </p>
              <p className="text-xs text-muted-foreground">Escalate Recall</p>
            </div>
            <div>
              <p className={`text-2xl font-bold ${overall.false_credit_rate != null && overall.false_credit_rate > 0 ? 'text-red-600' : ''}`}>
                {overall.false_credit_rate != null ? `${overall.false_credit_rate}%` : '—'}
              </p>
              <p className="text-xs text-muted-foreground">False Credit Rate</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Confusion matrix */}
      <ConfusionMatrix matrix={analytics.confusion_matrix} />

      {/* Stratified breakdown */}
      <StratifiedMetrics stratified={analytics.stratified} />
    </div>
  );
}

import { useState } from 'react';
import { ChevronRight, ChevronDown, AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import type { SegmentMetrics } from '@/types';

interface Props {
  stratified: {
    by_risk_level: Record<string, SegmentMetrics>;
    by_dispute_type: Record<string, SegmentMetrics>;
    by_hard_gate: Record<string, SegmentMetrics>;
    by_rubric_bucket: Record<string, SegmentMetrics>;
  };
}

const DIMENSION_LABELS: Record<string, string> = {
  by_risk_level: 'By Risk Level',
  by_dispute_type: 'By Dispute Type',
  by_hard_gate: 'By Hard Gate',
  by_rubric_bucket: 'By Rubric Score',
};

function MetricCell({ value, suffix = '%', danger }: { value: number | null; suffix?: string; danger?: boolean }) {
  if (value == null) return <td className="px-3 py-2 text-gray-400 text-center">—</td>;
  return (
    <td className={`px-3 py-2 text-center tabular-nums ${danger && value > 0 ? 'text-red-600 font-semibold' : ''}`}>
      {value}{suffix}
    </td>
  );
}

function SegmentTable({ data }: { data: Record<string, SegmentMetrics> }) {
  const entries = Object.entries(data).sort((a, b) => b[1].sample_size - a[1].sample_size);

  if (entries.length === 0) {
    return <p className="text-sm text-gray-400 py-2">No data</p>;
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b text-xs text-gray-500">
          <th className="text-left px-3 py-2 font-medium">Segment</th>
          <th className="text-center px-3 py-2 font-medium">n</th>
          <th className="text-center px-3 py-2 font-medium">Agreement</th>
          <th className="text-center px-3 py-2 font-medium">Precision</th>
          <th className="text-center px-3 py-2 font-medium">Recall</th>
          <th className="text-center px-3 py-2 font-medium">False Credit</th>
        </tr>
      </thead>
      <tbody>
        {entries.map(([segment, metrics]) => (
          <tr key={segment} className="border-b last:border-0 hover:bg-gray-50">
            <td className="px-3 py-2 font-medium flex items-center gap-1.5">
              {segment}
              {metrics.sample_size < 10 && metrics.sample_size > 0 && (
                <AlertTriangle className="h-3 w-3 text-amber-500" />
              )}
            </td>
            <td className="px-3 py-2 text-center text-gray-500">{metrics.sample_size}</td>
            <MetricCell value={metrics.agreement_rate} />
            <MetricCell value={metrics.credit_precision} />
            <MetricCell value={metrics.escalate_recall} />
            <MetricCell value={metrics.false_credit_rate} danger />
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function StratifiedMetrics({ stratified }: Props) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    by_risk_level: true,
    by_dispute_type: false,
    by_hard_gate: false,
    by_rubric_bucket: false,
  });

  const toggle = (key: string) => setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <Card>
      <CardContent className="pt-6">
        <h3 className="text-sm font-medium text-gray-700 mb-4">Stratified Breakdown</h3>
        <div className="space-y-2">
          {(Object.entries(stratified) as [string, Record<string, SegmentMetrics>][]).map(([key, data]) => (
            <div key={key}>
              <button
                className="flex items-center gap-2 text-sm font-medium text-gray-700 hover:text-gray-900 w-full text-left py-1"
                onClick={() => toggle(key)}
              >
                {expanded[key] ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
                {DIMENSION_LABELS[key] ?? key}
                <span className="text-xs text-gray-400 font-normal">({Object.keys(data).length} segments)</span>
              </button>
              {expanded[key] && (
                <div className="ml-6 mt-1 mb-3">
                  <SegmentTable data={data} />
                </div>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

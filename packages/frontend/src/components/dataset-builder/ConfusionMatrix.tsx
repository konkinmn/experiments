import { Card, CardContent } from '@/components/ui/card';
import type { ConfusionMatrix as ConfusionMatrixData } from '@/types';

interface Props {
  matrix: ConfusionMatrixData;
}

export function ConfusionMatrix({ matrix }: Props) {
  const total = matrix.true_credit + matrix.false_credit + matrix.true_escalate + matrix.false_escalate;
  const pct = (n: number) => (total > 0 ? `${Math.round((n / total) * 100)}%` : '—');

  return (
    <Card>
      <CardContent className="pt-6">
        <h3 className="text-sm font-medium text-gray-700 mb-4">Confusion Matrix</h3>

        <div className="grid grid-cols-[120px_1fr_1fr] gap-0 text-sm max-w-md">
          {/* Header row */}
          <div />
          <div className="text-center font-medium text-gray-500 pb-2 text-xs">Pipeline: Credit</div>
          <div className="text-center font-medium text-gray-500 pb-2 text-xs">Pipeline: Escalate</div>

          {/* Row 1: Human labeled credit */}
          <div className="flex items-center font-medium text-gray-500 pr-3 text-xs">Human: Credit</div>
          <div className="bg-green-50 border border-green-200 rounded-tl-lg p-3 text-center">
            <p className="text-lg font-bold text-green-700">{matrix.true_credit}</p>
            <p className="text-xs text-green-600">True Credit {pct(matrix.true_credit)}</p>
          </div>
          <div className="bg-amber-50 border border-amber-200 rounded-tr-lg p-3 text-center">
            <p className="text-lg font-bold text-amber-700">{matrix.false_escalate}</p>
            <p className="text-xs text-amber-600">False Escalate {pct(matrix.false_escalate)}</p>
          </div>

          {/* Row 2: Human labeled escalate */}
          <div className="flex items-center font-medium text-gray-500 pr-3 text-xs">Human: Escalate</div>
          <div className="bg-red-50 border border-red-300 rounded-bl-lg p-3 text-center">
            <p className="text-lg font-bold text-red-700">{matrix.false_credit}</p>
            <p className="text-xs text-red-600">False Credit {pct(matrix.false_credit)}</p>
          </div>
          <div className="bg-green-50 border border-green-200 rounded-br-lg p-3 text-center">
            <p className="text-lg font-bold text-green-700">{matrix.true_escalate}</p>
            <p className="text-xs text-green-600">True Escalate {pct(matrix.true_escalate)}</p>
          </div>
        </div>

        {/* Other counts */}
        {(matrix.unlabeled > 0 || matrix.needs_more_info > 0) && (
          <div className="mt-3 flex gap-4 text-xs text-gray-500">
            {matrix.unlabeled > 0 && <span>Unlabeled: {matrix.unlabeled}</span>}
            {matrix.needs_more_info > 0 && <span>Needs more info: {matrix.needs_more_info}</span>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

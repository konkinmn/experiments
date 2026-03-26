import { useState, useMemo } from 'react';
import { Database, Download, Loader2, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useSegments, useDatasetCases, useLoadSegment, useLabelCase, useDeleteDatasetCase } from '@/hooks/useDatasetBuilder';
import { downloadXlsx, type ColumnDef } from '@/lib/download-xlsx';
import type { DatasetCase, DatasetLabel, SegmentInfo } from '@/types';

const RISK_BADGE: Record<string, { label: string; variant: 'green' | 'amber' | 'red' }> = {
  green: { label: 'Green', variant: 'green' },
  amber: { label: 'Amber', variant: 'amber' },
  red: { label: 'Red', variant: 'red' },
};

const DECISION_BADGE: Record<string, { label: string; variant: 'green' | 'amber' | 'red' }> = {
  credit: { label: 'Credit', variant: 'green' },
  escalate_to_agent: { label: 'Escalate', variant: 'amber' },
};

const LABEL_CONFIG: Record<DatasetLabel, { label: string; variant: 'green' | 'amber' | 'blue' }> = {
  credit: { label: 'Credit', variant: 'green' },
  escalate: { label: 'Escalate', variant: 'amber' },
  needs_more_info: { label: 'Needs more info', variant: 'blue' },
};

const EXPORT_COLUMNS: ColumnDef<DatasetCase>[] = [
  { header: 'Case ID', accessor: (r) => r.caseId },
  { header: 'Segment', accessor: (r) => r.segment },
  { header: 'Pipeline Decision', accessor: (r) => {
    if (!r.pipelineRun) return '';
    if (r.pipelineRun.hardGateTriggered) return 'hard_gate';
    return r.pipelineRun.plannerOutput?.decision ?? '';
  }},
  { header: 'Label', accessor: (r) => r.label ?? '' },
  { header: 'Label Notes', accessor: (r) => r.labelNotes ?? '' },
  { header: 'Risk Level', accessor: (r) => r.pipelineRun?.disputeProfile?.risk_level ?? '' },
  { header: 'Rubric Score', accessor: (r) => r.pipelineRun?.disputeProfile?.rubric_score ?? '' },
  { header: 'Thought', accessor: (r) => r.pipelineRun?.plannerOutput?.thought ?? '' },
  { header: 'Uncertainty Factors', accessor: (r) => r.pipelineRun?.plannerOutput?.uncertainty_factors?.join('; ') ?? '' },
  { header: 'Duration (ms)', accessor: (r) => r.pipelineRun?.pipelineDurationMs ?? '' },
  { header: 'Labeled By', accessor: (r) => r.labeledBy ?? '' },
  { header: 'Labeled At', accessor: (r) => r.labeledAt ?? '' },
];

export function DatasetBuilder() {
  const [selectedSegment, setSelectedSegment] = useState<string>('clear_credit');
  const { data: segments = [] } = useSegments();
  const { data: cases = [] } = useDatasetCases(selectedSegment);
  const loadSegment = useLoadSegment();
  const labelCase = useLabelCase();
  const deleteCase = useDeleteDatasetCase();

  const segmentHasCases = useMemo(() => {
    const seg = segments.find((s) => s.key === selectedSegment);
    return (seg?.totalCount ?? 0) > 0;
  }, [segments, selectedSegment]);

  const counts = useMemo(() => {
    let labeled = 0;
    let credit = 0;
    let escalate = 0;
    let needsMoreInfo = 0;
    for (const c of cases) {
      if (c.label) {
        labeled++;
        if (c.label === 'credit') credit++;
        if (c.label === 'escalate') escalate++;
        if (c.label === 'needs_more_info') needsMoreInfo++;
      }
    }
    return { total: cases.length, labeled, credit, escalate, needsMoreInfo };
  }, [cases]);

  const handleExport = () => {
    downloadXlsx(cases, EXPORT_COLUMNS, `dataset-${selectedSegment}`);
  };

  return (
    <div className="flex-1 p-6 bg-gray-50 overflow-auto">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-blue-100 flex items-center justify-center">
              <Database className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold text-gray-900">Dataset Builder</h1>
              <p className="text-sm text-gray-500">
                Build ground-truth eval dataset by segment — label pipeline decisions
              </p>
            </div>
          </div>
          {cases.length > 0 && (
            <Button variant="outline" onClick={handleExport}>
              <Download className="h-4 w-4 mr-2" />
              Export
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-6">
        {/* Segment Selector */}
        <SegmentSelector
          segments={segments}
          selected={selectedSegment}
          onSelect={setSelectedSegment}
        />

        {/* Load Cases Button */}
        <div className="flex items-center gap-3">
          <Button
            onClick={() => loadSegment.mutate(selectedSegment)}
            disabled={loadSegment.isPending || segmentHasCases}
          >
            {loadSegment.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {loadSegment.isPending ? 'Running pipeline...' : 'Load cases'}
          </Button>
          {loadSegment.isPending && (
            <span className="text-sm text-muted-foreground">
              Running pipeline for segment cases...
            </span>
          )}
          {segmentHasCases && !loadSegment.isPending && (
            <span className="text-sm text-muted-foreground">
              Cases already loaded for this segment
            </span>
          )}
          {loadSegment.isError && (
            <span className="text-sm text-red-600">
              Error: {loadSegment.error?.message}
            </span>
          )}
        </div>

        {/* Session Summary */}
        {cases.length > 0 && (
          <Card>
            <CardContent className="pt-6">
              <div className="grid grid-cols-5 gap-4 text-center">
                <div>
                  <p className="text-2xl font-bold">{counts.total}</p>
                  <p className="text-xs text-muted-foreground">Total Cases</p>
                </div>
                <div>
                  <p className="text-2xl font-bold">{counts.labeled}</p>
                  <p className="text-xs text-muted-foreground">Labeled</p>
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
                  <p className="text-2xl font-bold text-blue-600">{counts.needsMoreInfo}</p>
                  <p className="text-xs text-muted-foreground">Needs More Info</p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Cases List */}
        {cases.length === 0 && !loadSegment.isPending && (
          <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-sm text-muted-foreground">
            No cases loaded for this segment. Click "Load cases" to fetch cases from BigQuery and run the pipeline.
          </div>
        )}

        <div className="space-y-4">
          {cases.map((c) => (
            <DatasetCaseCard
              key={c.id}
              datasetCase={c}
              onLabel={(label, notes) =>
                labelCase.mutate({ id: c.id, label, notes, labeledBy: 'analyst' })
              }
              onDelete={() => deleteCase.mutate(c.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function SegmentSelector({
  segments,
  selected,
  onSelect,
}: {
  segments: SegmentInfo[];
  selected: string;
  onSelect: (key: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {segments.map((seg) => (
        <button
          key={seg.key}
          onClick={() => onSelect(seg.key)}
          className={`px-4 py-2 rounded-full text-sm font-medium transition-colors border ${
            selected === seg.key
              ? 'bg-blue-50 border-blue-300 text-blue-700'
              : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
          }`}
        >
          {seg.label}
          <span className="ml-1.5 text-xs opacity-70">
            {seg.labeledCount}/{seg.totalCount}
          </span>
        </button>
      ))}
    </div>
  );
}

function DatasetCaseCard({
  datasetCase,
  onLabel,
  onDelete,
}: {
  datasetCase: DatasetCase;
  onLabel: (label: DatasetLabel, notes: string | null) => void;
  onDelete: () => void;
}) {
  const [notes, setNotes] = useState(datasetCase.labelNotes ?? '');
  const [expanded, setExpanded] = useState(false);
  const run = datasetCase.pipelineRun;

  const risk = run?.disputeProfile
    ? RISK_BADGE[run.disputeProfile.risk_level]
    : null;

  const decision = run
    ? run.hardGateTriggered
      ? { label: 'Hard gate', variant: 'red' as const }
      : DECISION_BADGE[run.plannerOutput?.decision ?? 'escalate_to_agent']
    : null;

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      {/* Card Header */}
      <div className="flex items-center gap-8 px-5 py-4">
        <div className="min-w-0">
          <span className="text-xs text-muted-foreground">Case</span>
          <p className="font-mono text-lg font-bold">{datasetCase.caseId}</p>
        </div>
        {risk && (
          <div>
            <span className="text-xs text-muted-foreground">Risk</span>
            <div className="mt-1">
              <Badge variant={risk.variant}>{risk.label}</Badge>
            </div>
          </div>
        )}
        {decision && (
          <div>
            <span className="text-xs text-muted-foreground">Decision</span>
            <div className="mt-1">
              <Badge variant={decision.variant}>{decision.label}</Badge>
            </div>
          </div>
        )}
        {run && (
          <div>
            <span className="text-xs text-muted-foreground">Duration</span>
            <p className="text-sm mt-1">{(run.pipelineDurationMs / 1000).toFixed(1)}s</p>
          </div>
        )}
        <div>
          <span className="text-xs text-muted-foreground">Label</span>
          <div className="mt-1">
            {datasetCase.label ? (
              <Badge variant={LABEL_CONFIG[datasetCase.label].variant}>
                {LABEL_CONFIG[datasetCase.label].label}
              </Badge>
            ) : (
              <span className="text-sm text-muted-foreground">Unlabeled</span>
            )}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-700 transition-colors"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
          <button
            className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-red-500 transition-colors"
            onClick={onDelete}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Expanded Detail */}
      {expanded && run && (
        <div className="border-t px-5 py-4 space-y-4">
          {/* Planner Thought */}
          {run.plannerOutput && (
            <div>
              <h4 className="text-xs font-medium text-muted-foreground mb-1">Planner Thought</h4>
              <blockquote className="border-l-2 border-gray-300 pl-3 text-sm text-gray-700 whitespace-pre-wrap">
                {run.plannerOutput.thought}
              </blockquote>
            </div>
          )}

          {/* Hard Gate */}
          {run.hardGateTriggered && (
            <div>
              <h4 className="text-xs font-medium text-muted-foreground mb-1">Hard Gate Triggered</h4>
              <Badge variant="red">{run.hardGateTriggered}</Badge>
              <p className="text-sm text-muted-foreground mt-1">
                Planner was not called. Case automatically escalated.
              </p>
            </div>
          )}

          {/* Dispute Profile */}
          {run.disputeProfile && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <h4 className="text-xs font-medium text-muted-foreground">Dispute Profile</h4>
                <Badge variant={RISK_BADGE[run.disputeProfile.risk_level].variant}>
                  {RISK_BADGE[run.disputeProfile.risk_level].label} Risk
                </Badge>
                <span className="text-sm font-bold">
                  {run.disputeProfile.rubric_score}/108
                </span>
              </div>

              {/* Score breakdown bar */}
              <div className="mb-3">
                <div className="flex h-3 rounded-full overflow-hidden bg-gray-100">
                  <div
                    className="bg-blue-400"
                    style={{ width: `${(run.disputeProfile.category_scores.account_trust / 108) * 100}%` }}
                    title={`Account Trust: ${run.disputeProfile.category_scores.account_trust}/58`}
                  />
                  <div
                    className="bg-purple-400"
                    style={{ width: `${(run.disputeProfile.category_scores.dispute_history / 108) * 100}%` }}
                    title={`Dispute History: ${run.disputeProfile.category_scores.dispute_history}/30`}
                  />
                  <div
                    className="bg-emerald-400"
                    style={{ width: `${(run.disputeProfile.category_scores.transaction_risk / 108) * 100}%` }}
                    title={`Transaction Risk: ${run.disputeProfile.category_scores.transaction_risk}/20`}
                  />
                </div>
                <div className="flex gap-4 mt-1.5 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-full bg-blue-400" />
                    Account Trust: {run.disputeProfile.category_scores.account_trust}/58
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-full bg-purple-400" />
                    Dispute History: {run.disputeProfile.category_scores.dispute_history}/30
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
                    Txn Risk: {run.disputeProfile.category_scores.transaction_risk}/20
                  </span>
                </div>
              </div>

              {run.disputeProfile.risk_factors.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {run.disputeProfile.risk_factors.map((f, i) => (
                    <Badge key={i} variant="amber">{f}</Badge>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Uncertainty Factors */}
          {run.plannerOutput && run.plannerOutput.uncertainty_factors.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-muted-foreground mb-1">Uncertainty Factors</h4>
              <div className="flex flex-wrap gap-1.5">
                {run.plannerOutput.uncertainty_factors.map((factor, i) => (
                  <Badge key={i} variant="gray">{factor}</Badge>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Label Controls */}
      <div className="border-t px-5 py-3">
        <div className="flex items-center gap-3">
          {(['credit', 'escalate', 'needs_more_info'] as DatasetLabel[]).map((label) => (
            <Button
              key={label}
              size="sm"
              variant={datasetCase.label === label ? 'default' : 'outline'}
              className={
                datasetCase.label === label
                  ? label === 'credit'
                    ? 'bg-green-600 hover:bg-green-700'
                    : label === 'escalate'
                      ? 'bg-amber-600 hover:bg-amber-700'
                      : 'bg-blue-600 hover:bg-blue-700'
                  : ''
              }
              onClick={() => onLabel(label, notes || null)}
            >
              {LABEL_CONFIG[label].label}
            </Button>
          ))}
          <Input
            className="flex-1 max-w-sm"
            placeholder="Notes (optional)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          {datasetCase.labeledBy && datasetCase.labeledAt && (
            <span className="text-xs text-muted-foreground ml-auto">
              Labeled by {datasetCase.labeledBy} at{' '}
              {new Date(datasetCase.labeledAt).toLocaleString()}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

import { useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Download, Trash2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ResultsTable } from '@/components/rubric-tester';
import { useDataset, useLabelDatasetCase, useDeleteDatasetCase, useDeleteDataset } from '@/hooks/useDatasetBuilder';
import { downloadXlsx, type ColumnDef } from '@/lib/download-xlsx';
import type { DatasetCase, DatasetLabel } from '@/types';

type ExportRow = DatasetCase & { datasetName: string };

const EXPORT_COLUMNS: ColumnDef<ExportRow>[] = [
  { header: 'Case ID', accessor: (r) => r.caseId },
  { header: 'Dataset', accessor: (r) => r.datasetName },
  { header: 'Decision', accessor: (r) => r.pipelineRun?.plannerOutput?.decision ?? (r.pipelineRun?.hardGateTriggered ? 'hard_gate' : '') },
  { header: 'Label', accessor: (r) => r.label ?? '' },
  { header: 'Label Notes', accessor: (r) => r.labelNotes ?? '' },
  { header: 'Labeled By', accessor: (r) => r.labeledBy ?? '' },
  { header: 'Risk Level', accessor: (r) => r.pipelineRun?.disputeProfile.risk_level ?? '' },
  { header: 'Rubric Score', accessor: (r) => r.pipelineRun?.disputeProfile.rubric_score ?? '' },
  { header: 'Total Amount', accessor: (r) => r.pipelineRun?.rawSignals.total_amount ?? '' },
  { header: 'Max Txn Amount', accessor: (r) => r.pipelineRun?.rawSignals.max_transaction_amount ?? '' },
  { header: 'Account Age (days)', accessor: (r) => r.pipelineRun?.rawSignals.account_age_days ?? '' },
  { header: 'CIFAS Count', accessor: (r) => r.pipelineRun?.rawSignals.cifas_count ?? '' },
  { header: 'Scammer Count', accessor: (r) => r.pipelineRun?.rawSignals.scammer_count ?? '' },
  { header: 'Hard Gate', accessor: (r) => r.pipelineRun?.hardGateTriggered ?? '' },
  { header: 'Thought', accessor: (r) => r.pipelineRun?.plannerOutput?.thought ?? '' },
  { header: 'Uncertainty Factors', accessor: (r) => r.pipelineRun?.plannerOutput?.uncertainty_factors?.join('; ') ?? '' },
  { header: 'Duration (ms)', accessor: (r) => r.pipelineRun?.pipelineDurationMs ?? '' },
];

export function DatasetDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const datasetId = Number(id);
  const validId = !isNaN(datasetId) && datasetId > 0;
  const { data: dataset, isLoading, isError } = useDataset(datasetId, { enabled: validId });
  const labelCase = useLabelDatasetCase();
  const deleteCase = useDeleteDatasetCase();
  const deleteDataset = useDeleteDataset();

  const summary = useMemo(() => {
    if (!dataset?.cases) return { total: 0, labeled: 0, credit: 0, escalate: 0, needsMoreInfo: 0 };
    let labeled = 0, credit = 0, escalate = 0, needsMoreInfo = 0;
    for (const c of dataset.cases) {
      if (c.label) {
        labeled++;
        if (c.label === 'credit') credit++;
        else if (c.label === 'escalate') escalate++;
        else if (c.label === 'needs_more_info') needsMoreInfo++;
      }
    }
    return { total: dataset.cases.length, labeled, credit, escalate, needsMoreInfo };
  }, [dataset?.cases]);

  const handleLabel = (datasetCaseId: number, label: DatasetLabel, notes?: string) => {
    labelCase.mutate({ id: datasetCaseId, label, notes: notes ?? null, labeledBy: null });
  };

  const handleDeleteCase = (datasetCaseId: number) => {
    deleteCase.mutate(datasetCaseId);
  };

  const handleDeleteDataset = () => {
    if (window.confirm('Delete this dataset and all its cases?')) {
      deleteDataset.mutate(datasetId, {
        onSuccess: () => navigate('/dataset'),
      });
    }
  };

  const handleExport = () => {
    if (!dataset?.cases) return;
    const rows: ExportRow[] = dataset.cases.map((c) => ({ ...c, datasetName: dataset.name }));
    downloadXlsx(rows, EXPORT_COLUMNS, `dataset-${dataset.name}`);
  };

  if (isLoading) {
    return (
      <div className="flex-1 p-6 bg-gray-50 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
      </div>
    );
  }

  if (!validId || isError || !dataset) {
    return (
      <div className="flex-1 p-6 bg-gray-50">
        <p className="text-sm text-red-600">Failed to load dataset.</p>
        <Link to="/dataset" className="text-sm text-blue-600 hover:underline mt-2 inline-block">
          Back to datasets
        </Link>
      </div>
    );
  }

  const hasLoadingCases = dataset.cases.some((c) => c.pipelineRunId === null);

  return (
    <div className="flex-1 p-6 bg-gray-50 overflow-auto">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              to="/dataset"
              className="h-10 w-10 rounded-full bg-blue-100 flex items-center justify-center hover:bg-blue-200 transition-colors"
            >
              <ArrowLeft className="h-5 w-5 text-blue-600" />
            </Link>
            <div>
              <h1 className="text-2xl font-semibold text-gray-900">{dataset.name}</h1>
              {dataset.description && (
                <p className="text-sm text-gray-500">{dataset.description}</p>
              )}
              {dataset.sourceType === 'custom_sql' && typeof dataset.sourceConfig.sql === 'string' && (
                <pre className="mt-2 text-xs text-gray-500 bg-gray-100 rounded px-3 py-2 overflow-x-auto max-w-2xl whitespace-pre-wrap font-mono">
                  {dataset.sourceConfig.sql}
                </pre>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {dataset.cases.length > 0 && (
              <Button variant="outline" onClick={handleExport}>
                <Download className="h-4 w-4 mr-2" />
                Export
              </Button>
            )}
            <Button variant="outline" className="text-red-600 hover:text-red-700" onClick={handleDeleteDataset}>
              <Trash2 className="h-4 w-4 mr-2" />
              Delete
            </Button>
          </div>
        </div>
        {hasLoadingCases && (
          <div className="mt-3 flex items-center gap-2 text-sm text-amber-600">
            <Loader2 className="h-4 w-4 animate-spin" />
            Some cases are still running through the pipeline...
          </div>
        )}
      </div>

      <div className="space-y-6">
        {/* Session Summary */}
        {dataset.cases.length > 0 && (
          <Card>
            <CardContent className="pt-6">
              <div className="grid grid-cols-5 gap-4 text-center">
                <div>
                  <p className="text-2xl font-bold">{summary.total}</p>
                  <p className="text-xs text-muted-foreground">Total Cases</p>
                </div>
                <div>
                  <p className="text-2xl font-bold">{summary.labeled}</p>
                  <p className="text-xs text-muted-foreground">Labeled</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-green-600">{summary.credit}</p>
                  <p className="text-xs text-muted-foreground">Credit</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-amber-600">{summary.escalate}</p>
                  <p className="text-xs text-muted-foreground">Escalate</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-blue-600">{summary.needsMoreInfo}</p>
                  <p className="text-xs text-muted-foreground">Needs More Info</p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Results Table */}
        <ResultsTable
          results={[]}
          verdictOptions="dataset"
          datasetCases={dataset.cases}
          onDatasetLabel={handleLabel}
          onDeleteCase={handleDeleteCase}
        />
      </div>
    </div>
  );
}

import { useState, useMemo, useRef, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Download, Trash2, Loader2, Plus, RefreshCw, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { ResultsTable } from '@/components/rubric-tester';
import { NewRunModal, AnalyticsTab, CaseFilterBar, CompareTab } from '@/components/dataset-builder';
import { useCaseFilters } from '@/hooks/useCaseFilters';
import {
  useDataset,
  useUpdateDataset,
  useLabelDatasetCase,
  useLabelRunCase,
  useDeleteDatasetCase,
  useDeleteDataset,
  useDatasetRuns,
  useDatasetRunCases,
  useTagCase,
  useLabelDatasetCase2,
  useRefreshDataset,
  useRetryRunCase,
  useRerunDatasetRun,
} from '@/hooks/useDatasetBuilder';
import { downloadXlsx, type ColumnDef } from '@/lib/download-xlsx';
import type { DatasetCase, DatasetLabel, DatasetRun } from '@/types';

type ExportRow = DatasetCase & { datasetName: string };

const EXPORT_COLUMNS: ColumnDef<ExportRow>[] = [
  { header: 'Case ID', accessor: (r) => r.caseId },
  { header: 'Dataset', accessor: (r) => r.datasetName },
  { header: 'Label', accessor: (r) => r.label ?? '' },
  { header: 'Label Notes', accessor: (r) => r.labelNotes ?? '' },
  { header: 'Labeled By', accessor: (r) => r.labeledBy ?? '' },
  { header: 'Label Confidence', accessor: (r) => r.labelConfidence ?? '' },
  { header: 'Total Amount', accessor: (r) => r.rawSignals?.total_amount ?? '' },
  { header: 'Max Txn Amount', accessor: (r) => r.rawSignals?.max_transaction_amount ?? '' },
  { header: 'Account Age (days)', accessor: (r) => r.rawSignals?.account_age_days ?? '' },
  { header: 'CIFAS Count', accessor: (r) => r.rawSignals?.cifas_count ?? '' },
  { header: 'Trust Score', accessor: (r) => r.rawSignals?.trust_score ?? '' },
  { header: 'Scammer Count', accessor: (r) => r.rawSignals?.scammer_count ?? '' },
  { header: 'Merchants', accessor: (r) => r.rawSignals?.merchants ?? '' },
  { header: 'Account Status', accessor: (r) => r.rawSignals?.account_status ?? '' },
  { header: 'Tier', accessor: (r) => r.rawSignals?.tier_name ?? '' },
];

type ActiveTab = 'labels' | 'analytics' | 'compare' | `run-${number}`;

export function DatasetDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const datasetId = Number(id);
  const validId = !isNaN(datasetId) && datasetId > 0;
  const { data: dataset, isLoading, isError } = useDataset(datasetId, { enabled: validId });
  const { data: runs } = useDatasetRuns(datasetId, { enabled: validId });
  const labelCase = useLabelDatasetCase();
  const deleteCase = useDeleteDatasetCase();
  const deleteDataset = useDeleteDataset();
  const tagCase = useTagCase();
  const labelCase2 = useLabelDatasetCase2();
  const refreshDataset = useRefreshDataset();
  const updateDatasetMutation = useUpdateDataset();

  const [activeTab, setActiveTab] = useState<ActiveTab>('labels');
  const [showNewRunModal, setShowNewRunModal] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const [descValue, setDescValue] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);
  const descInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editingName) nameInputRef.current?.focus();
  }, [editingName]);
  useEffect(() => {
    if (editingDesc) descInputRef.current?.focus();
  }, [editingDesc]);

  const startEditName = () => {
    if (!dataset) return;
    setNameValue(dataset.name);
    setEditingName(true);
  };
  const saveName = () => {
    const trimmed = nameValue.trim();
    if (trimmed && dataset && trimmed !== dataset.name) {
      updateDatasetMutation.mutate({ id: datasetId, name: trimmed });
    }
    setEditingName(false);
  };
  const startEditDesc = () => {
    if (!dataset) return;
    setDescValue(dataset.description ?? '');
    setEditingDesc(true);
  };
  const saveDesc = () => {
    if (!dataset) return;
    const val = descValue.trim() || null;
    if (val !== (dataset.description ?? null)) {
      updateDatasetMutation.mutate({ id: datasetId, description: val ?? '' });
    }
    setEditingDesc(false);
  };

  const summary = useMemo(() => {
    if (!dataset?.cases) return { total: 0, labeled: 0, credit: 0, escalate: 0, undecided: 0 };
    let labeled = 0, credit = 0, escalate = 0, undecided = 0;
    for (const c of dataset.cases) {
      if (c.label) {
        labeled++;
        if (c.label === 'credit') credit++;
        else if (c.label === 'escalate') escalate++;
        else if (c.label === 'undecided') undecided++;
      }
    }
    return { total: dataset.cases.length, labeled, credit, escalate, undecided };
  }, [dataset?.cases]);

  const handleLabel = (datasetCaseId: number, label: DatasetLabel, notes?: string, confidence?: string | null, disagreementReason?: string | null, disagreementNotes?: string | null) => {
    labelCase.mutate({ id: datasetCaseId, label, notes: notes ?? null, labeledBy: null, confidence, disagreementReason, disagreementNotes });
  };

  const handleDeleteCase = (datasetCaseId: number) => {
    deleteCase.mutate(datasetCaseId);
  };

  const handleTagCase = (datasetCaseId: number, tags: string[]) => {
    tagCase.mutate({ id: datasetCaseId, tags });
  };

  const handleLabel2 = (datasetCaseId: number, label: DatasetLabel, notes?: string, confidence?: string | null) => {
    labelCase2.mutate({ id: datasetCaseId, label, notes: notes ?? null, labeledBy: null, confidence });
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

  const hasLoadingCases = dataset.cases.some((c) =>
    (c.contextFetchedAt === null && !c.contextError) ||
    (c.pipelineRunId === null && !c.pipelineError && !c.contextFetchedAt)
  );
  const activeRunId = activeTab.startsWith('run-') ? parseInt(activeTab.slice(4), 10) : null;
  const activeRun = activeRunId != null ? runs?.find((r) => r.id === activeRunId) : null;

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
              {editingName ? (
                <input
                  ref={nameInputRef}
                  value={nameValue}
                  onChange={(e) => setNameValue(e.target.value)}
                  onBlur={saveName}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveName();
                    if (e.key === 'Escape') setEditingName(false);
                  }}
                  className="text-2xl font-semibold text-gray-900 bg-white border border-blue-300 rounded px-2 py-0.5 outline-none focus:ring-2 focus:ring-blue-400 w-full max-w-md"
                />
              ) : (
                <h1
                  className="text-2xl font-semibold text-gray-900 group/name flex items-center gap-2 cursor-pointer"
                  onClick={startEditName}
                >
                  {dataset.name}
                  <Pencil className="h-4 w-4 text-gray-400 opacity-0 group-hover/name:opacity-100 transition-opacity" />
                </h1>
              )}
              {editingDesc ? (
                <textarea
                  ref={descInputRef}
                  value={descValue}
                  onChange={(e) => setDescValue(e.target.value)}
                  onBlur={saveDesc}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveDesc(); }
                    if (e.key === 'Escape') setEditingDesc(false);
                  }}
                  rows={3  }
                  className="text-sm text-gray-500 bg-white border border-blue-300 rounded px-2 py-1 outline-none focus:ring-2 focus:ring-blue-400 w-full max-w-lg resize-none mt-0.5"
                  placeholder="Add description..."
                />
              ) : (
                <p
                  className="text-sm text-gray-500 group/desc flex items-center gap-1.5 cursor-pointer mt-0.5"
                  onClick={startEditDesc}
                >
                  {dataset.description || <span className="italic text-gray-400">Add description...</span>}
                  <Pencil className="h-3 w-3 text-gray-400 opacity-0 group-hover/desc:opacity-100 transition-opacity" />
                </p>
              )}
              {dataset.sourceType === 'custom_sql' && typeof dataset.sourceConfig.sql === 'string' && (
                <pre className="mt-2 text-xs text-gray-500 bg-gray-100 rounded px-3 py-2 overflow-x-auto max-w-2xl whitespace-pre-wrap font-mono">
                  {dataset.sourceConfig.sql}
                </pre>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => refreshDataset.mutate(datasetId)}
              disabled={refreshDataset.isPending}
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${refreshDataset.isPending ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
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
        {hasLoadingCases && activeTab === 'labels' && (
          <div className="mt-3 flex items-center gap-2 text-sm text-amber-600">
            <Loader2 className="h-4 w-4 animate-spin" />
            Some cases are still running through the pipeline...
          </div>
        )}
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-gray-200 mb-6">
        <button
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'labels'
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
          }`}
          onClick={() => setActiveTab('labels')}
        >
          Dataset
        </button>
        <button
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'analytics'
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
          }`}
          onClick={() => setActiveTab('analytics')}
        >
          Analytics
        </button>
        <button
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'compare'
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
          }`}
          onClick={() => setActiveTab('compare')}
        >
          Compare
        </button>
        {runs?.map((run) => (
          <button
            key={run.id}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${
              activeTab === `run-${run.id}`
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
            onClick={() => setActiveTab(`run-${run.id}`)}
          >
            {run.name}
            {(run.status === 'pending' || run.status === 'running') && (
              <Loader2 className="h-3 w-3 animate-spin" />
            )}
            {run.status === 'failed' && (
              <span className="h-2 w-2 rounded-full bg-red-500" />
            )}
          </button>
        ))}
        <button
          className="px-3 py-2 text-sm font-medium text-gray-400 hover:text-blue-600 transition-colors flex items-center gap-1 border-b-2 border-transparent"
          onClick={() => setShowNewRunModal(true)}
        >
          <Plus className="h-4 w-4" />
          New run
        </button>
      </div>

      {/* Tab content */}
      {activeTab === 'labels' ? (
        <LabelsTab
          dataset={dataset}
          summary={summary}
          onLabel={handleLabel}
          onDeleteCase={handleDeleteCase}
          onTagCase={handleTagCase}
          onLabel2={handleLabel2}
        />
      ) : activeTab === 'analytics' ? (
        <AnalyticsTab
          datasetId={datasetId}
          runs={runs}
        />
      ) : activeTab === 'compare' ? (
        <CompareTab
          datasetId={datasetId}
          runs={runs ?? []}
        />
      ) : activeRun ? (
        <RunTab
          run={activeRun}
          datasetId={datasetId}
        />
      ) : null}

      <NewRunModal
        open={showNewRunModal}
        onOpenChange={setShowNewRunModal}
        datasetId={datasetId}
      />
    </div>
  );
}

function LabelsTab({
  dataset,
  summary,
  onLabel,
  onDeleteCase,
  onTagCase,
  onLabel2,
}: {
  dataset: { cases: DatasetCase[] };
  summary: { total: number; labeled: number; credit: number; escalate: number; undecided: number };
  onLabel: (datasetCaseId: number, label: DatasetLabel, notes?: string, confidence?: string | null, disagreementReason?: string | null, disagreementNotes?: string | null) => void;
  onDeleteCase: (datasetCaseId: number) => void;
  onTagCase: (datasetCaseId: number, tags: string[]) => void;
  onLabel2: (datasetCaseId: number, label: DatasetLabel, notes?: string, confidence?: string | null) => void;
}) {
  const filters = useCaseFilters(dataset.cases, 'dataset');

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const c of dataset.cases) {
      for (const t of c.manualTags) set.add(t);
    }
    return [...set].sort();
  }, [dataset.cases]);

  return (
    <div className="space-y-6">
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
                <p className="text-2xl font-bold text-blue-600">{summary.undecided}</p>
                <p className="text-xs text-muted-foreground">Can't decide yet</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {dataset.cases.length > 0 && (
        <CaseFilterBar
          labelFilter={filters.labelFilter}
          onLabelFilterChange={filters.setLabelFilter}
          riskFilter={filters.riskFilter}
          onRiskFilterChange={filters.setRiskFilter}
          hardGateFilter={filters.hardGateFilter}
          onHardGateFilterChange={filters.setHardGateFilter}
          sortOption={filters.sortOption}
          onSortChange={filters.setSortOption}
          totalCount={filters.totalCount}
          filteredCount={filters.filteredCount}
          mode="dataset"
        />
      )}

      <ResultsTable
        results={[]}
        verdictOptions="dataset"
        datasetCases={filters.filteredCases}
        onDatasetLabel={onLabel}
        onDeleteCase={onDeleteCase}
        onTagCase={onTagCase}
        onDatasetLabel2={onLabel2}
        tagSuggestions={allTags}
      />
    </div>
  );
}

function RunTab({ run, datasetId }: { run: DatasetRun; datasetId: number }) {
  const isActive = run.status === 'pending' || run.status === 'running';
  const { data: runCases } = useDatasetRunCases(run.id, {
    enabled: true,
    polling: isActive,
  });
  const labelRunCase = useLabelRunCase();
  const retryRunCase = useRetryRunCase();
  const rerunAll = useRerunDatasetRun();
  const [retryingIds, setRetryingIds] = useState<Set<number>>(new Set());

  const handleRunLabel = (runCaseId: number, label: DatasetLabel, notes?: string, confidence?: string | null, disagreementReason?: string | null, disagreementNotes?: string | null) => {
    labelRunCase.mutate({ id: runCaseId, label, notes: notes ?? null, labeledBy: null, confidence, disagreementReason, disagreementNotes });
  };

  const handleRetryCase = (runCaseId: number) => {
    setRetryingIds((prev) => new Set(prev).add(runCaseId));
    retryRunCase.mutate(runCaseId, {
      onSettled: () => {
        setRetryingIds((prev) => { const next = new Set(prev); next.delete(runCaseId); return next; });
      },
    });
  };

  const failedCaseIds = useMemo(() => {
    if (!runCases) return [];
    return runCases.filter((rc) => rc.pipelineError).map((rc) => rc.id);
  }, [runCases]);

  const handleRetryAllFailed = () => {
    for (const id of failedCaseIds) {
      handleRetryCase(id);
    }
  };

  const mappedCases: DatasetCase[] = useMemo(() => {
    if (!runCases) return [];
    return runCases.map((rc) => ({
      id: rc.id,
      datasetId,
      caseId: rc.caseId,
      // Context fields (not available in run cases — use null)
      rawSignals: null,
      caseDetails: null,
      caseActions: null,
      dialogueMessages: null,
      fileParseResults: null,
      enrichmentMetadata: null,
      contextError: null,
      contextFetchedAt: null,
      // Legacy pipeline fields
      pipelineRunId: rc.pipelineRunId,
      pipelineError: rc.pipelineError,
      pipelineRun: rc.pipelineRun,
      label: rc.label,
      labelNotes: rc.labelNotes,
      labeledBy: rc.labeledBy,
      labeledAt: rc.labeledAt,
      labelConfidence: rc.labelConfidence ?? null,
      disagreementReason: rc.disagreementReason ?? null,
      disagreementNotes: rc.disagreementNotes ?? null,
      label2: null,
      label2Notes: null,
      label2By: null,
      label2At: null,
      label2Confidence: null,
      manualTags: [],
      autoTags: {},
      createdAt: '',
    }));
  }, [runCases, datasetId]);

  const filters = useCaseFilters(mappedCases);

  const agreementMap: Record<number, boolean | null> = useMemo(() => {
    if (!runCases) return {};
    const map: Record<number, boolean | null> = {};
    for (const rc of runCases) {
      map[rc.id] = rc.agreement;
    }
    return map;
  }, [runCases]);

  const runSummary = useMemo(() => {
    if (!runCases) return { total: 0, labeled: 0, credit: 0, escalate: 0, undecided: 0 };
    let labeled = 0, credit = 0, escalate = 0, undecided = 0;
    for (const rc of runCases) {
      if (rc.label) {
        labeled++;
        if (rc.label === 'credit') credit++;
        else if (rc.label === 'escalate') escalate++;
        else if (rc.label === 'undecided') undecided++;
      }
    }
    return { total: runCases.length, labeled, credit, escalate, undecided };
  }, [runCases]);

  return (
    <div className="space-y-6">
      {/* Run metrics header */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-4 text-sm text-muted-foreground">
              <span>Model: <span className="font-medium text-gray-900">{run.config.model}</span></span>
              <span>Prompt: <span className="font-medium text-gray-900">{run.config.prompt_version}</span></span>
              <span>Status: <RunStatusBadge status={run.status} /></span>
            </div>
            {!isActive && (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => rerunAll.mutate(run.id)}
                  disabled={rerunAll.isPending}
                >
                  <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${rerunAll.isPending ? 'animate-spin' : ''}`} />
                  Rerun all
                </Button>
                {failedCaseIds.length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleRetryAllFailed}
                    disabled={retryingIds.size > 0}
                  >
                    <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${retryingIds.size > 0 ? 'animate-spin' : ''}`} />
                    Retry failed ({failedCaseIds.length})
                  </Button>
                )}
              </div>
            )}
          </div>
          {isActive && (
            <div className="mb-4">
              <div className="flex items-center gap-2 text-sm text-amber-600 mb-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Running pipeline for {run.total_cases} cases...
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div
                  className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                  style={{ width: run.total_cases > 0 ? `${(run.completed_cases / run.total_cases) * 100}%` : '0%' }}
                />
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {run.completed_cases}/{run.total_cases} completed
              </p>
            </div>
          )}
          <div className="grid grid-cols-5 gap-4 text-center">
            <div>
              <p className="text-2xl font-bold">
                {run.agreement_rate != null ? `${run.agreement_rate}%` : '—'}
              </p>
              <p className="text-xs text-muted-foreground">Agreement</p>
            </div>
            <div>
              <p className="text-2xl font-bold">
                {run.credit_precision != null ? `${run.credit_precision}%` : '—'}
              </p>
              <p className="text-xs text-muted-foreground">Credit Precision</p>
            </div>
            <div>
              <p className="text-2xl font-bold">
                {run.escalate_recall != null ? `${run.escalate_recall}%` : '—'}
              </p>
              <p className="text-xs text-muted-foreground">Escalate Recall</p>
            </div>
            <div>
              <p className={`text-2xl font-bold ${run.false_credit_rate != null && run.false_credit_rate > 0 ? 'text-red-600' : ''}`}>
                {run.false_credit_rate != null ? `${run.false_credit_rate}%` : '—'}
              </p>
              <p className="text-xs text-muted-foreground">False Credit Rate</p>
            </div>
            <div>
              <p className="text-2xl font-bold">
                {run.completed_cases}/{run.total_cases}
              </p>
              <p className="text-xs text-muted-foreground">Cases</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Label summary */}
      {runCases && runCases.length > 0 && (
        <Card>
          <CardContent className="pt-6">
            <div className="grid grid-cols-5 gap-4 text-center">
              <div>
                <p className="text-2xl font-bold">{runSummary.total}</p>
                <p className="text-xs text-muted-foreground">Total Cases</p>
              </div>
              <div>
                <p className="text-2xl font-bold">{runSummary.labeled}</p>
                <p className="text-xs text-muted-foreground">Labeled</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-green-600">{runSummary.credit}</p>
                <p className="text-xs text-muted-foreground">Credit</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-amber-600">{runSummary.escalate}</p>
                <p className="text-xs text-muted-foreground">Escalate</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-blue-600">{runSummary.undecided}</p>
                <p className="text-xs text-muted-foreground">Can't decide yet</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Filter bar */}
      {mappedCases.length > 0 && (
        <CaseFilterBar
          labelFilter={filters.labelFilter}
          onLabelFilterChange={filters.setLabelFilter}
          riskFilter={filters.riskFilter}
          onRiskFilterChange={filters.setRiskFilter}
          hardGateFilter={filters.hardGateFilter}
          onHardGateFilterChange={filters.setHardGateFilter}
          sortOption={filters.sortOption}
          onSortChange={filters.setSortOption}
          totalCount={filters.totalCount}
          filteredCount={filters.filteredCount}
        />
      )}

      {/* Run case cards */}
      <ResultsTable
        results={[]}
        verdictOptions="dataset"
        datasetCases={filters.filteredCases}
        onDatasetLabel={handleRunLabel}
        agreementMap={agreementMap}
        onRetryCase={handleRetryCase}
        retryingCaseIds={retryingIds}
      />
    </div>
  );
}

function RunStatusBadge({ status }: { status: DatasetRun['status'] }) {
  switch (status) {
    case 'pending':
      return <Badge variant="gray">Pending</Badge>;
    case 'running':
      return <Badge variant="blue">Running</Badge>;
    case 'completed':
      return <Badge variant="green">Completed</Badge>;
    case 'failed':
      return <Badge variant="red">Failed</Badge>;
  }
}

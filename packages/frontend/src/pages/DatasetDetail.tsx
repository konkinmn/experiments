import { useState, useMemo, useRef, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Download, Trash2, Loader2, Plus, RefreshCw, Pencil, FilePlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { ResultsTable, NewRunModal, AnalyticsTab, CaseFilterBar, CompareTab } from '@/components/dataset-builder';
import { useCaseFilters } from '@/hooks/useCaseFilters';
import {
  useDataset,
  useUpdateDataset,
  useLabelDatasetCase,
  useDeleteDatasetCase,
  useDeleteDataset,
  useDatasetRuns,
  useDatasetRunCases,
  useTagCase,
  useLabelDatasetCase2,
  useRefreshDataset,
  useAddDatasetCases,
  useRetryRunCase,
  useRerunDatasetRun,
  useDeleteDatasetRun,
  useRenameDatasetRun,
  useUpdateRunCaseActionNote,
} from '@/hooks/useDatasetBuilder';
import { downloadXlsx, type ColumnDef } from '@/lib/download-xlsx';
import type { DatasetCase, DatasetLabel, DatasetRun } from '@/types';
import type { AgreementFilter } from '@/hooks/useCaseFilters';

function parseCaseIds(input: string): number[] {
  const ids = input
    .split(/[\n,\s]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseInt(s, 10))
    .filter((n) => !isNaN(n) && n > 0);
  return [...new Set(ids)];
}

type ExportRow = DatasetCase & { datasetName: string };

const EXPORT_COLUMNS: ColumnDef<ExportRow>[] = [
  { header: 'Case ID', accessor: (r) => r.caseId },
  { header: 'WS Link', accessor: (r) => r.rawSignals?.alias ? `https://chat-workstation.k1.anna.money/${r.rawSignals.alias}/tasks/cases?caseId=${r.caseId}` : '' },
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
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [datasetDeleteText, setDatasetDeleteText] = useState('');
  const tagCase = useTagCase();
  const labelCase2 = useLabelDatasetCase2();
  const refreshDataset = useRefreshDataset();
  const addCases = useAddDatasetCases();
  const updateDatasetMutation = useUpdateDataset();
  const [addCasesOpen, setAddCasesOpen] = useState(false);
  const [addCasesText, setAddCasesText] = useState('');
  const [addCasesError, setAddCasesError] = useState<string | null>(null);
  const [addCasesResult, setAddCasesResult] = useState<{ added: number; skipped: number } | null>(null);

  const [activeTab, setActiveTab] = useState<ActiveTab>('labels');
  const [showNewRunModal, setShowNewRunModal] = useState(false);
  const [editingRunId, setEditingRunId] = useState<number | null>(null);
  const [editingRunName, setEditingRunName] = useState('');
  const renameRun = useRenameDatasetRun();
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
    deleteDataset.mutate(datasetId, {
      onSuccess: () => navigate('/dataset'),
    });
  };

  const handleAddCasesSubmit = () => {
    setAddCasesError(null);
    setAddCasesResult(null);
    const ids = parseCaseIds(addCasesText);
    if (ids.length === 0) {
      setAddCasesError('Enter at least one valid case ID');
      return;
    }
    if (ids.length > 500) {
      setAddCasesError('Maximum 500 case IDs per request');
      return;
    }
    addCases.mutate(
      { datasetId, caseIds: ids },
      {
        onSuccess: (data) => {
          setAddCasesResult({ added: data.added, skipped: data.skipped });
          setAddCasesText('');
        },
        onError: (err) => {
          setAddCasesError(err instanceof Error ? err.message : 'Failed to add cases');
        },
      },
    );
  };

  const closeAddCases = () => {
    setAddCasesOpen(false);
    setAddCasesText('');
    setAddCasesError(null);
    setAddCasesResult(null);
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
              onClick={() => setAddCasesOpen(true)}
            >
              <FilePlus className="h-4 w-4 mr-2" />
              Add cases
            </Button>
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
            <Button variant="outline" className="text-red-600 hover:text-red-700" onClick={() => setDeleteConfirmOpen(true)}>
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
        {runs && runs.length > 0 && (
          <div className="flex items-center gap-1 ml-2">
            {editingRunId != null ? (
              <input
                className="bg-white border border-blue-400 rounded px-2 py-1 text-sm font-medium w-44 focus:outline-none"
                value={editingRunName}
                onChange={(e) => setEditingRunName(e.target.value)}
                onBlur={() => {
                  const run = runs.find((r) => r.id === editingRunId);
                  if (run && editingRunName.trim() && editingRunName.trim() !== run.name) {
                    renameRun.mutate({ runId: editingRunId, name: editingRunName.trim() });
                  }
                  setEditingRunId(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); }
                  if (e.key === 'Escape') { setEditingRunId(null); }
                }}
                autoFocus
              />
            ) : (
              <Select
                className={`h-9 w-48 ${activeRunId != null ? 'border-blue-600 text-blue-600 font-medium' : ''}`}
                value={activeRunId != null ? `run-${activeRunId}` : ''}
                onChange={(e) => { if (e.target.value) setActiveTab(e.target.value as ActiveTab); }}
              >
                <option value="" disabled>
                  {`Runs (${runs.length})…`}
                </option>
                {runs.map((run) => (
                  <option key={run.id} value={`run-${run.id}`}>
                    {run.name}
                    {run.status === 'pending' || run.status === 'running'
                      ? ' (running)'
                      : run.status === 'failed'
                        ? ' (failed)'
                        : ''}
                  </option>
                ))}
              </Select>
            )}
            {activeRun && editingRunId == null && (
              <button
                className="p-1.5 text-gray-400 hover:text-blue-600 transition-colors"
                title="Rename run"
                onClick={() => { setEditingRunId(activeRun.id); setEditingRunName(activeRun.name); }}
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            )}
            {activeRun && (activeRun.status === 'pending' || activeRun.status === 'running') && (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-600" />
            )}
            {activeRun && activeRun.status === 'failed' && (
              <span className="h-2 w-2 rounded-full bg-red-500" />
            )}
          </div>
        )}
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
          onDeleted={() => setActiveTab('labels')}
        />
      ) : null}

      <NewRunModal
        open={showNewRunModal}
        onOpenChange={setShowNewRunModal}
        datasetId={datasetId}
      />

      <Dialog open={addCasesOpen} onOpenChange={(open) => { if (!open) closeAddCases(); else setAddCasesOpen(true); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add cases</DialogTitle>
            <DialogDescription>
              Paste case IDs separated by commas, spaces, or new lines. Context will be fetched in the background. Duplicates are skipped.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2 space-y-2">
            <textarea
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono min-h-[140px] resize-y outline-none focus:ring-2 focus:ring-blue-400"
              value={addCasesText}
              onChange={(e) => { setAddCasesText(e.target.value); setAddCasesError(null); setAddCasesResult(null); }}
              placeholder="34075, 34076&#10;34077"
              autoFocus
            />
            {addCasesError && <p className="text-sm text-red-600">{addCasesError}</p>}
            {addCasesResult && (
              <p className="text-sm text-green-700">
                Added {addCasesResult.added} case{addCasesResult.added === 1 ? '' : 's'}.
                {addCasesResult.skipped > 0 && ` Skipped ${addCasesResult.skipped} duplicate${addCasesResult.skipped === 1 ? '' : 's'}.`}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeAddCases}>
              {addCasesResult ? 'Close' : 'Cancel'}
            </Button>
            <Button
              onClick={handleAddCasesSubmit}
              disabled={addCases.isPending || addCasesText.trim().length === 0}
            >
              {addCases.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteConfirmOpen} onOpenChange={(open) => { setDeleteConfirmOpen(open); if (!open) setDatasetDeleteText(''); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete dataset</DialogTitle>
            <DialogDescription>
              This will permanently delete the dataset, all cases, labels, and runs. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <p className="text-sm text-muted-foreground mb-2">Type <span className="font-mono font-bold text-gray-900">delete</span> to confirm:</p>
            <input
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={datasetDeleteText}
              onChange={(e) => setDatasetDeleteText(e.target.value)}
              placeholder="delete"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setDeleteConfirmOpen(false); setDatasetDeleteText(''); }}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteDataset}
              disabled={deleteDataset.isPending || datasetDeleteText !== 'delete'}
            >
              {deleteDataset.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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

function RunTab({ run, datasetId, onDeleted }: { run: DatasetRun; datasetId: number; onDeleted: () => void }) {
  const isActive = run.status === 'pending' || run.status === 'running';
  const { data: runCases } = useDatasetRunCases(run.id, {
    enabled: true,
    polling: isActive,
  });
  const retryRunCase = useRetryRunCase();
  const rerunAll = useRerunDatasetRun();
  const deleteRun = useDeleteDatasetRun();
  const labelCase = useLabelDatasetCase();
  const tagCase = useTagCase();
  const updateActionNote = useUpdateRunCaseActionNote();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [showPrompt, setShowPrompt] = useState(false);
  const [retryingIds, setRetryingIds] = useState<Set<number>>(new Set());

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
      label: rc.datasetLabel,
      labelNotes: rc.datasetLabelNotes,
      labeledBy: null,
      labeledAt: null,
      labelConfidence: (rc.datasetLabelConfidence as DatasetCase['labelConfidence']) ?? null,
      disagreementReason: null,
      disagreementNotes: null,
      label2: null,
      label2Notes: null,
      label2By: null,
      label2At: null,
      label2Confidence: null,
      manualTags: rc.datasetManualTags ?? [],
      autoTags: {},
      createdAt: '',
    }));
  }, [runCases, datasetId]);

  const agreementMap: Record<number, boolean | null> = useMemo(() => {
    if (!runCases) return {};
    const map: Record<number, boolean | null> = {};
    for (const rc of runCases) {
      map[rc.id] = rc.agreement;
    }
    return map;
  }, [runCases]);

  const runCaseToDatasetCase = useMemo(() => {
    if (!runCases) return {};
    const map: Record<number, number> = {};
    for (const rc of runCases) map[rc.id] = rc.datasetCaseId;
    return map;
  }, [runCases]);

  const handleLabel = (runCaseId: number, label: DatasetLabel, notes?: string, confidence?: string | null, disagreementReason?: string | null, disagreementNotes?: string | null) => {
    const datasetCaseId = runCaseToDatasetCase[runCaseId];
    if (datasetCaseId != null) {
      labelCase.mutate({ id: datasetCaseId, label, notes: notes ?? null, labeledBy: null, confidence, disagreementReason, disagreementNotes });
    }
  };

  const handleTagCase = (runCaseId: number, tags: string[]) => {
    const datasetCaseId = runCaseToDatasetCase[runCaseId];
    if (datasetCaseId != null) {
      tagCase.mutate({ id: datasetCaseId, tags });
    }
  };

  const handleActionNote = (runCaseId: number, note: string | null) => {
    updateActionNote.mutate({ id: runCaseId, actionNote: note });
  };

  const actionNotes = useMemo(() => {
    if (!runCases) return {};
    const map: Record<number, string | null> = {};
    for (const rc of runCases) map[rc.id] = rc.actionNote;
    return map;
  }, [runCases]);

  const filters = useCaseFilters(mappedCases);
  const [agreementFilter, setAgreementFilter] = useState<AgreementFilter>('all');

  const filteredByAgreement = useMemo(() => {
    if (agreementFilter === 'all') return filters.filteredCases;
    return filters.filteredCases.filter((c) => {
      const ag = agreementMap[c.id];
      if (agreementFilter === 'agree') return ag === true;
      if (agreementFilter === 'disagree') return ag === false;
      return ag == null; // no-label
    });
  }, [filters.filteredCases, agreementFilter, agreementMap]);

  const pipelineStats = useMemo(() => {
    if (!runCases) return null;
    let decisionCredit = 0, decisionEscalate = 0;
    let riskGreen = 0, riskAmber = 0, riskRed = 0;
    let hardGateCount = 0;
    const hardGateBreakdown: Record<string, number> = {};
    let totalDuration = 0, durationCount = 0;
    let errorCount = 0;

    for (const rc of runCases) {
      if (rc.pipelineError) { errorCount++; continue; }
      if (!rc.pipelineRun) continue;
      const pr = rc.pipelineRun;
      if (pr.hardGateTriggered) {
        decisionEscalate++;
        hardGateCount++;
        hardGateBreakdown[pr.hardGateTriggered] = (hardGateBreakdown[pr.hardGateTriggered] || 0) + 1;
      } else if (pr.plannerOutput?.decision === 'credit') {
        decisionCredit++;
      } else {
        decisionEscalate++;
      }
      const risk = pr.disputeProfile?.risk_level;
      if (risk === 'GREEN') riskGreen++;
      else if (risk === 'AMBER') riskAmber++;
      else if (risk === 'RED') riskRed++;
      if (pr.pipelineDurationMs) { totalDuration += pr.pipelineDurationMs; durationCount++; }
    }

    return {
      decisionCredit, decisionEscalate,
      riskGreen, riskAmber, riskRed,
      hardGateCount, hardGateBreakdown,
      avgDurationMs: durationCount > 0 ? totalDuration / durationCount : 0,
      errorCount,
    };
  }, [runCases]);

  const comparisonSummary = useMemo(() => {
    if (!runCases) return null;
    let labeled = 0, agreed = 0, disagreed = 0, falseCredits = 0, missedCredits = 0;
    for (const rc of runCases) {
      if (!rc.datasetLabel || rc.datasetLabel === 'undecided' || !rc.pipelineRun) continue;
      labeled++;
      if (rc.agreement === true) agreed++;
      else if (rc.agreement === false) {
        disagreed++;
        const pipelineDecision = rc.pipelineRun.hardGateTriggered ? 'escalate' : rc.pipelineRun.plannerOutput?.decision === 'credit' ? 'credit' : 'escalate';
        if (pipelineDecision === 'credit' && rc.datasetLabel === 'escalate') falseCredits++;
        if (pipelineDecision === 'escalate' && rc.datasetLabel === 'credit') missedCredits++;
      }
    }
    if (labeled === 0) return null;
    return { labeled, total: runCases.length, agreed, disagreed, falseCredits, missedCredits };
  }, [runCases]);

  return (
    <div className="space-y-6">
      {/* Run header */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-4 text-sm text-muted-foreground">
              <span>Model: <span className="font-medium text-gray-900">{run.config.model}</span></span>
              <span>Prompt: <span className="font-medium text-gray-900">{run.config.prompt_version}</span></span>
              <span>Status: <RunStatusBadge status={run.status} /></span>
              {run.config.prompt_content && (
                <button
                  type="button"
                  className="text-xs text-blue-600 hover:text-blue-700 font-medium"
                  onClick={() => setShowPrompt((v) => !v)}
                >
                  {showPrompt ? 'Hide prompt' : 'View prompt'}
                </button>
              )}
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
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowDeleteDialog(true)}
                  className="text-red-600 hover:text-red-700 hover:bg-red-50"
                >
                  <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                  Delete run
                </Button>
              </div>
            )}
          </div>
          {run.description && (
            <p className="text-sm text-muted-foreground mb-4">{run.description}</p>
          )}
          {showPrompt && run.config.prompt_content && (
            <pre className="mb-4 max-h-64 overflow-auto rounded-md border border-gray-200 bg-gray-50 p-3 text-xs font-mono text-gray-700 whitespace-pre-wrap">{run.config.prompt_content}</pre>
          )}
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

          {/* Pipeline decisions */}
          {pipelineStats && (
            <>
              <div className="grid grid-cols-2 gap-4 mb-4">
                {/* Decisions */}
                <div className="rounded-md border border-gray-100 bg-gray-50 px-4 py-3">
                  <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wider mb-2">Decisions</p>
                  <div className="flex items-center gap-6">
                    <div className="text-center">
                      <p className="text-2xl font-bold text-green-600">{pipelineStats.decisionCredit}</p>
                      <p className="text-xs text-muted-foreground">Credit</p>
                    </div>
                    <div className="text-center">
                      <p className="text-2xl font-bold text-amber-600">{pipelineStats.decisionEscalate}</p>
                      <p className="text-xs text-muted-foreground">Escalate</p>
                    </div>
                    <div className="text-center">
                      <p className="text-2xl font-bold">{run.completed_cases}/{run.total_cases}</p>
                      <p className="text-xs text-muted-foreground">Cases</p>
                    </div>
                  </div>
                </div>
                {/* Risk & Hard Gates */}
                <div className="rounded-md border border-gray-100 bg-gray-50 px-4 py-3">
                  <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wider mb-2">Risk & Hard Gates</p>
                  <div className="flex items-center gap-6">
                    <div className="text-center">
                      <p className="text-2xl font-bold text-green-600">{pipelineStats.riskGreen}</p>
                      <p className="text-xs text-muted-foreground">Green</p>
                    </div>
                    <div className="text-center">
                      <p className="text-2xl font-bold text-amber-600">{pipelineStats.riskAmber}</p>
                      <p className="text-xs text-muted-foreground">Amber</p>
                    </div>
                    <div className="text-center">
                      <p className="text-2xl font-bold text-red-600">{pipelineStats.riskRed}</p>
                      <p className="text-xs text-muted-foreground">Red</p>
                    </div>
                    <div className="text-center">
                      <p className="text-2xl font-bold">{pipelineStats.hardGateCount}</p>
                      <p className="text-xs text-muted-foreground">Hard Gate</p>
                    </div>
                  </div>
                  {Object.keys(pipelineStats.hardGateBreakdown).length > 0 && (
                    <div className="flex items-center gap-2 mt-2">
                      {Object.entries(pipelineStats.hardGateBreakdown).map(([gate, count]) => (
                        <span key={gate} className="inline-flex items-center rounded-full bg-red-50 border border-red-100 px-2 py-0.5 text-xs text-red-700">
                          {gate}: {count}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                <span>Avg duration: {(pipelineStats.avgDurationMs / 1000).toFixed(1)}s</span>
                {pipelineStats.errorCount > 0 && (
                  <span className="text-red-600">Errors: {pipelineStats.errorCount}</span>
                )}
              </div>
            </>
          )}

          {/* Comparison vs human labels */}
          {comparisonSummary && (
            <div className="mt-4 pt-4 border-t border-gray-100">
              <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wider mb-3">Pipeline vs Human Labels</p>
              <div className="grid grid-cols-5 gap-4 text-center">
                <div>
                  <p className="text-2xl font-bold">{comparisonSummary.labeled}<span className="text-base font-normal text-muted-foreground">/{comparisonSummary.total}</span></p>
                  <p className="text-xs text-muted-foreground">Labeled</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-green-600">{comparisonSummary.agreed} <span className="text-base font-normal">({comparisonSummary.labeled > 0 ? Math.round(100 * comparisonSummary.agreed / comparisonSummary.labeled) : 0}%)</span></p>
                  <p className="text-xs text-muted-foreground">Agree</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-red-600">{comparisonSummary.disagreed}</p>
                  <p className="text-xs text-muted-foreground">Disagree</p>
                </div>
                <div>
                  <p className={`text-2xl font-bold ${comparisonSummary.falseCredits > 0 ? 'text-red-600' : ''}`}>{comparisonSummary.falseCredits}</p>
                  <p className="text-xs text-muted-foreground">False Credits</p>
                </div>
                <div>
                  <p className={`text-2xl font-bold ${comparisonSummary.missedCredits > 0 ? 'text-amber-600' : ''}`}>{comparisonSummary.missedCredits}</p>
                  <p className="text-xs text-muted-foreground">Missed Credits</p>
                </div>
              </div>
              {(run.credit_precision != null || run.escalate_recall != null || run.false_credit_rate != null) && (
                <div className="flex items-center gap-4 mt-3 text-xs text-muted-foreground">
                  {run.credit_precision != null && <span>Credit Precision: <span className="font-medium text-gray-900">{run.credit_precision}%</span></span>}
                  {run.escalate_recall != null && <span>Escalate Recall: <span className="font-medium text-gray-900">{run.escalate_recall}%</span></span>}
                  {run.false_credit_rate != null && <span>False Credit Rate: <span className={`font-medium ${run.false_credit_rate > 0 ? 'text-red-600' : 'text-gray-900'}`}>{run.false_credit_rate}%</span></span>}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

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
          filteredCount={filteredByAgreement.length}
          agreementFilter={agreementFilter}
          onAgreementFilterChange={setAgreementFilter}
        />
      )}

      {/* Run case cards */}
      <ResultsTable
        results={[]}
        verdictOptions="dataset"
        datasetCases={filteredByAgreement}
        agreementMap={agreementMap}
        onDatasetLabel={handleLabel}
        onTagCase={handleTagCase}
        onRetryCase={handleRetryCase}
        retryingCaseIds={retryingIds}
        onActionNote={handleActionNote}
        actionNotes={actionNotes}
      />

      <Dialog open={showDeleteDialog} onOpenChange={(open) => { setShowDeleteDialog(open); if (!open) setDeleteConfirmText(''); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete run</DialogTitle>
            <DialogDescription>
              This will permanently delete &quot;{run.name}&quot; and all run results. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <p className="text-sm text-muted-foreground mb-2">Type <span className="font-mono font-bold text-gray-900">delete</span> to confirm:</p>
            <input
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder="delete"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowDeleteDialog(false); setDeleteConfirmText(''); }}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => deleteRun.mutate(run.id, { onSuccess: () => { setShowDeleteDialog(false); setDeleteConfirmText(''); onDeleted(); } })}
              disabled={deleteRun.isPending || deleteConfirmText !== 'delete'}
            >
              {deleteRun.isPending ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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

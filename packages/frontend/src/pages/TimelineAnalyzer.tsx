import { useState, useMemo, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Activity, Bookmark, Clock, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { DateRangePicker, type DateRange } from '@/components/ui/date-range-picker';
import { AnalysisProgress, AnalysisResults, SavedAnalysesList } from '@/components/timeline-analyzer';
import { usePrompts, useTimelineAnalyzer, useFilteredCases, useJobs, useDeleteJob } from '@/hooks/useTimelineAnalyzer';
import {
  getSavedAnalyses,
  saveAnalysis,
  deleteSavedAnalysis,
  loadSavedAnalysis,
  generateAnalysisName,
  computeAnalysisCounts,
} from '@/lib/saved-analyses';
import type { AnalyzerConfig, CaseSource, CaseFilterParams, SavedAnalysis } from '@/types';

function parseCaseIds(input: string): number[] {
  const ids = input
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseInt(s, 10))
    .filter((n) => !isNaN(n) && n > 0);
  return [...new Set(ids)];
}

function formatDateForApi(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const STATUS_OPTIONS = [
  { value: 'IN_PROGRESS', label: 'In Progress' },
  { value: 'RESOLVED', label: 'Resolved' },
  { value: 'DISMISSED', label: 'Dismissed' },
] as const;

type StatusValue = (typeof STATUS_OPTIONS)[number]['value'];

export function TimelineAnalyzer() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlJobId = searchParams.get('jobId');

  const [config, setConfig] = useState<AnalyzerConfig>({
    promptId: '',
    caseSource: 'manual',
    manualCaseIds: '',
  });

  // Filter state
  const [dateRange, setDateRange] = useState<DateRange>(() => {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 30);
    return { startDate, endDate };
  });
  const [filterStatuses, setFilterStatuses] = useState<StatusValue[]>([]);
  const [filteredCaseIds, setFilteredCaseIds] = useState<number[]>([]);

  // Saved analyses state
  const [savedAnalyses, setSavedAnalyses] = useState<SavedAnalysis[]>(() => getSavedAnalyses());
  const [loadedAnalysis, setLoadedAnalysis] = useState<SavedAnalysis | null>(null);
  const [isSaved, setIsSaved] = useState(false);

  const { data: prompts, isLoading: promptsLoading } = usePrompts();
  const { status, progress, results, error, jobId, startAnalysis, cancelAnalysis, reset } = useTimelineAnalyzer(urlJobId);
  const filteredCasesMutation = useFilteredCases();
  const { data: jobs } = useJobs();
  const deleteJob = useDeleteJob();

  // Sync jobId to URL
  useEffect(() => {
    if (jobId && jobId !== urlJobId) {
      setSearchParams({ jobId }, { replace: true });
    } else if (!jobId && urlJobId && status !== 'running') {
      setSearchParams({}, { replace: true });
    }
  }, [jobId, urlJobId, status, setSearchParams]);

  const manualCaseIds = useMemo(() => {
    return parseCaseIds(config.manualCaseIds);
  }, [config.manualCaseIds]);

  const activeCaseIds = config.caseSource === 'manual' ? manualCaseIds : filteredCaseIds;
  const canStart = config.promptId && activeCaseIds.length > 0;

  const toggleStatus = (value: StatusValue) => {
    setFilterStatuses((prev) =>
      prev.includes(value) ? prev.filter((s) => s !== value) : [...prev, value]
    );
  };

  const handleFetchCases = () => {
    const params: CaseFilterParams = {
      startDate: formatDateForApi(dateRange.startDate),
      endDate: formatDateForApi(dateRange.endDate),
      issueType: 'dispute',
    };
    if (filterStatuses.length) params.statuses = filterStatuses;

    filteredCasesMutation.mutate(params, {
      onSuccess: (data) => {
        setFilteredCaseIds(data.caseIds);
      },
    });
  };

  const handleStart = () => {
    if (canStart) {
      startAnalysis(config.promptId, activeCaseIds);
    }
  };

  const handleReset = () => {
    reset();
    setSearchParams({}, { replace: true });
    setConfig({
      promptId: '',
      caseSource: 'manual',
      manualCaseIds: '',
    });
    setFilteredCaseIds([]);
    filteredCasesMutation.reset();
    setIsSaved(false);
  };

  const handleSourceChange = (source: CaseSource) => {
    setConfig({ ...config, caseSource: source });
    // Clear fetched cases when switching modes
    if (source === 'manual') {
      setFilteredCaseIds([]);
      filteredCasesMutation.reset();
    }
  };

  const handleSaveAnalysis = useCallback(() => {
    const promptName = prompts?.find((p) => p.id === config.promptId)?.name ?? 'Unknown';
    const { successCount, errorCount } = computeAnalysisCounts(results);

    saveAnalysis({
      name: generateAnalysisName(),
      promptId: config.promptId,
      promptName,
      results,
      successCount,
      errorCount,
    });

    setSavedAnalyses(getSavedAnalyses());
    setIsSaved(true);
  }, [config.promptId, prompts, results]);

  const handleLoadAnalysis = useCallback((id: string) => {
    const analysis = loadSavedAnalysis(id);
    if (analysis) {
      setLoadedAnalysis(analysis);
    }
  }, []);

  const handleDeleteAnalysis = useCallback((id: string) => {
    deleteSavedAnalysis(id);
    setSavedAnalyses(getSavedAnalyses());
  }, []);

  const handleResetFromLoaded = useCallback(() => {
    setLoadedAnalysis(null);
  }, []);

  const handleViewJob = useCallback((id: string) => {
    setSearchParams({ jobId: id }, { replace: true });
    window.location.reload();
  }, [setSearchParams]);

  return (
    <div className="flex-1 p-6 bg-gray-50 overflow-auto">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-full bg-blue-100 flex items-center justify-center">
            <Activity className="h-5 w-5 text-blue-600" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">Case Timeline Analyzer</h1>
            <p className="text-sm text-gray-500">
              Run LLM-powered analysis on case timelines to extract insights
            </p>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className={`space-y-6 ${status === 'completed' || loadedAnalysis ? '' : 'max-w-2xl'}`}>
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          {/* Show loaded analysis */}
          {loadedAnalysis && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="font-medium">{loadedAnalysis.name}</h2>
                  <p className="text-sm text-muted-foreground">{loadedAnalysis.promptName}</p>
                </div>
              </div>
              <AnalysisResults
                results={loadedAnalysis.results}
                onReset={handleResetFromLoaded}
              />
            </div>
          )}

          {/* Show new analysis workflow when no loaded analysis */}
          {!loadedAnalysis && status === 'idle' && (
            <div className="space-y-6">
              <div className="space-y-2">
                <label className="text-sm font-medium">Analysis Prompt</label>
                <Select
                  value={config.promptId}
                  onChange={(e) => setConfig({ ...config, promptId: e.target.value })}
                  disabled={promptsLoading}
                >
                  <option value="">Select a prompt...</option>
                  {prompts?.map((prompt) => (
                    <option key={prompt.id} value={prompt.id}>
                      {prompt.name}
                    </option>
                  ))}
                </Select>
              </div>

              {/* Source Toggle */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Case Source</label>
                <div className="flex gap-1 rounded-md border border-input bg-background p-1 w-fit">
                  <button
                    onClick={() => handleSourceChange('manual')}
                    className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${
                      config.caseSource === 'manual'
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                    }`}
                  >
                    Manual
                  </button>
                  <button
                    onClick={() => handleSourceChange('filter')}
                    className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${
                      config.caseSource === 'filter'
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                    }`}
                  >
                    Filter
                  </button>
                </div>
              </div>

              {/* Manual Mode */}
              {config.caseSource === 'manual' && (
                <div className="space-y-2">
                  <label className="text-sm font-medium">Case IDs</label>
                  <textarea
                    className="flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                    placeholder="Enter case IDs (one per line or comma-separated)"
                    value={config.manualCaseIds}
                    onChange={(e) => setConfig({ ...config, manualCaseIds: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    Enter numeric case IDs, one per line or separated by commas.
                  </p>
                </div>
              )}

              {/* Filter Mode */}
              {config.caseSource === 'filter' && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Date Range</label>
                    <DateRangePicker value={dateRange} onChange={setDateRange} />
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium">Status</label>
                    <div className="flex flex-wrap gap-2">
                      {STATUS_OPTIONS.map((opt) => (
                        <button
                          key={opt.value}
                          onClick={() => toggleStatus(opt.value)}
                          className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
                            filterStatuses.includes(opt.value)
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-input bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                    {filterStatuses.length === 0 && (
                      <p className="text-xs text-muted-foreground">No filter — all statuses will be included</p>
                    )}
                  </div>

                  <div className="flex items-center gap-4">
                    <Button
                      onClick={handleFetchCases}
                      disabled={filteredCasesMutation.isPending}
                      variant="outline"
                    >
                      {filteredCasesMutation.isPending ? 'Fetching...' : 'Fetch Cases'}
                    </Button>
                    {filteredCasesMutation.isSuccess && (
                      <p className="text-sm text-muted-foreground">
                        Found <span className="font-medium text-foreground">{filteredCaseIds.length}</span> case{filteredCaseIds.length !== 1 ? 's' : ''}
                      </p>
                    )}
                    {filteredCasesMutation.isError && (
                      <p className="text-sm text-red-600">
                        Failed to fetch cases
                      </p>
                    )}
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between pt-4 border-t">
                <p className="text-sm text-muted-foreground">
                  {activeCaseIds.length} case{activeCaseIds.length !== 1 ? 's' : ''} selected
                </p>
                <Button onClick={handleStart} disabled={!canStart}>
                  Run Analysis
                </Button>
              </div>
            </div>
          )}

          {!loadedAnalysis && status === 'running' && (
            <AnalysisProgress progress={progress} onCancel={cancelAnalysis} />
          )}

          {!loadedAnalysis && status === 'completed' && (
            <AnalysisResults
              results={results}
              onReset={handleReset}
              onSave={handleSaveAnalysis}
              isSaved={isSaved}
            />
          )}

          {!loadedAnalysis && status === 'error' && (
            <div className="space-y-4">
              <div className="rounded-md border border-red-200 bg-red-50 p-4">
                <p className="text-sm text-red-800">{error}</p>
              </div>
              <div className="flex justify-end">
                <Button onClick={handleReset}>Try Again</Button>
              </div>
            </div>
          )}
        </div>

        {/* Saved Analyses Section - show only when idle and not viewing loaded */}
        {status === 'idle' && !loadedAnalysis && savedAnalyses.length > 0 && (
          <div className="rounded-lg border border-gray-200 bg-white p-6">
            <div className="flex items-center gap-2 mb-4">
              <Bookmark className="h-5 w-5 text-muted-foreground" />
              <h2 className="font-medium">Saved Analyses</h2>
            </div>
            <SavedAnalysesList
              analyses={savedAnalyses}
              onLoad={handleLoadAnalysis}
              onDelete={handleDeleteAnalysis}
            />
          </div>
        )}

        {/* Recent Jobs Section - show only when idle and not viewing loaded */}
        {status === 'idle' && !loadedAnalysis && jobs && jobs.length > 0 && (
          <div className="rounded-lg border border-gray-200 bg-white p-6">
            <div className="flex items-center gap-2 mb-4">
              <Clock className="h-5 w-5 text-muted-foreground" />
              <h2 className="font-medium">Recent Jobs</h2>
            </div>
            <div className="space-y-2">
              {jobs.map((job) => (
                <div
                  key={job.id}
                  className="flex items-center justify-between p-3 rounded-md border border-gray-100 hover:bg-gray-50"
                >
                  <div className="flex items-center gap-3">
                    <span
                      className={`inline-flex h-2 w-2 rounded-full ${
                        job.status === 'running'
                          ? 'bg-blue-500 animate-pulse'
                          : job.status === 'completed'
                          ? 'bg-green-500'
                          : 'bg-red-500'
                      }`}
                    />
                    <div>
                      <p className="text-sm font-medium">
                        {job.resultCount} case{job.resultCount !== 1 ? 's' : ''}
                        {job.status === 'running' && ` (${job.progress.current}/${job.progress.total})`}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(job.createdAt).toLocaleString()}
                        {job.errorCount > 0 && ` · ${job.errorCount} error${job.errorCount !== 1 ? 's' : ''}`}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => handleViewJob(job.id)}>
                      {job.status === 'running' ? 'View Progress' : 'View Results'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => deleteJob.mutate(job.id)}
                      disabled={deleteJob.isPending}
                    >
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

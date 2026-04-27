import type {
  Prompt,
  AnalysisJob,
  StartAnalysisConfig,
  CaseFilterParams,
  FilteredCasesResponse,
  JobSummary,
  Dataset,
  DatasetWithCases,
  DatasetCase,
  DatasetLabel,
  DatasetSourceType,
  DatasetRun,
  DatasetRunCase,
  DatasetAnalytics,
  RunComparisonResult,
} from '@/types';

const API_BASE = import.meta.env.API_URL || '';

async function fetchApi<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const headers: HeadersInit = {
    ...(options?.body ? { 'Content-Type': 'application/json' } : {}),
    ...options?.headers,
  };

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? `API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

export const api = {
  health: () => fetchApi<{ status: string; timestamp: string }>('/health'),

  // Timeline Analyzer API
  getPrompts: () => fetchApi<{ data: Prompt[] }>('/api/timeline-analyzer/prompts'),

  startAnalysis: (config: StartAnalysisConfig) =>
    fetchApi<{ jobId: string }>('/api/timeline-analyzer/start', {
      method: 'POST',
      body: JSON.stringify(config),
    }),

  getAnalysisStatus: (jobId: string) =>
    fetchApi<AnalysisJob>(`/api/timeline-analyzer/status/${jobId}`),

  cancelAnalysis: (jobId: string) =>
    fetchApi<{ success: boolean }>(`/api/timeline-analyzer/status/${jobId}`, {
      method: 'DELETE',
    }),

  getFilteredCaseIds: (params: CaseFilterParams) => {
    const searchParams = new URLSearchParams();
    searchParams.set('startDate', params.startDate);
    searchParams.set('endDate', params.endDate);
    if (params.issueType) searchParams.set('issueType', params.issueType);
    if (params.statuses?.length) searchParams.set('statuses', params.statuses.join(','));
    return fetchApi<FilteredCasesResponse>(`/api/timeline-analyzer/cases?${searchParams}`);
  },

  getJobs: () => fetchApi<{ data: JobSummary[] }>('/api/timeline-analyzer/jobs'),

  // Dataset Builder API
  getDatasets: () =>
    fetchApi<{ data: Dataset[] }>('/api/datasets'),

  createDataset: (name: string, description: string | null, sourceType: DatasetSourceType, sourceConfig: Record<string, unknown>) =>
    fetchApi<Dataset>('/api/datasets', {
      method: 'POST',
      body: JSON.stringify({ name, description, sourceType, sourceConfig }),
    }),

  getDataset: (id: number) =>
    fetchApi<DatasetWithCases>(`/api/datasets/${id}`),

  updateDataset: (id: number, data: { name?: string; description?: string }) =>
    fetchApi<Dataset>(`/api/datasets/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  deleteDataset: (id: number) =>
    fetchApi<{ success: boolean }>(`/api/datasets/${id}`, {
      method: 'DELETE',
    }),

  refreshDataset: (datasetId: number) =>
    fetchApi<{ success: boolean; refreshing: number }>(`/api/datasets/${datasetId}/refresh`, {
      method: 'POST',
    }),

  addDatasetCases: (datasetId: number, caseIds: number[]) =>
    fetchApi<{ added: number; skipped: number; cases: DatasetCase[] }>(`/api/datasets/${datasetId}/cases`, {
      method: 'POST',
      body: JSON.stringify({ caseIds }),
    }),

  labelDatasetCase: (id: number, label: DatasetLabel, notes: string | null, labeledBy: string | null, confidence?: string | null, disagreementReason?: string | null, disagreementNotes?: string | null) =>
    fetchApi<DatasetCase>(`/api/datasets/cases/${id}/label`, {
      method: 'PATCH',
      body: JSON.stringify({ label, notes, labeledBy, confidence: confidence ?? null, disagreementReason: disagreementReason ?? null, disagreementNotes: disagreementNotes ?? null }),
    }),

  labelRunCase: (id: number, label: DatasetLabel, notes: string | null, labeledBy: string | null, confidence?: string | null, disagreementReason?: string | null, disagreementNotes?: string | null) =>
    fetchApi<{ success: boolean }>(`/api/datasets/run-cases/${id}/label`, {
      method: 'PATCH',
      body: JSON.stringify({ label, notes, labeledBy, confidence: confidence ?? null, disagreementReason: disagreementReason ?? null, disagreementNotes: disagreementNotes ?? null }),
    }),

  deleteDatasetCase: (id: number) =>
    fetchApi<{ success: boolean }>(`/api/datasets/cases/${id}`, {
      method: 'DELETE',
    }),

  // Dataset Runs API
  getDatasetRuns: (datasetId: number) =>
    fetchApi<{ data: DatasetRun[] }>(`/api/datasets/${datasetId}/runs`),

  createDatasetRun: (datasetId: number, config: { name: string; description?: string }) =>
    fetchApi<DatasetRun>(`/api/datasets/${datasetId}/runs`, {
      method: 'POST',
      body: JSON.stringify(config),
    }),

  getDatasetRunCases: (runId: number) =>
    fetchApi<{ data: DatasetRunCase[] }>(`/api/datasets/runs/${runId}/cases`),

  updateRunCaseActionNote: (runCaseId: number, actionNote: string | null) =>
    fetchApi<{ success: boolean }>(`/api/datasets/run-cases/${runCaseId}/action-note`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actionNote }),
    }),

  retryRunCase: (runCaseId: number) =>
    fetchApi<{ success: boolean }>(`/api/datasets/run-cases/${runCaseId}/retry`, {
      method: 'POST',
    }),

  rerunDatasetRun: (runId: number) =>
    fetchApi<{ success: boolean; rerunning: number }>(`/api/datasets/runs/${runId}/rerun`, {
      method: 'POST',
    }),

  renameDatasetRun: (runId: number, name: string) =>
    fetchApi<{ success: boolean }>(`/api/datasets/runs/${runId}/name`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),

  deleteDatasetRun: (runId: number) =>
    fetchApi<{ success: boolean }>(`/api/datasets/runs/${runId}`, {
      method: 'DELETE',
    }),

  // Dataset Analytics API
  getDatasetAnalytics: (datasetId: number, runId?: number) => {
    const params = runId ? `?runId=${runId}` : '';
    return fetchApi<DatasetAnalytics>(`/api/datasets/${datasetId}/analytics${params}`);
  },

  labelDatasetCase2: (id: number, label: DatasetLabel, notes: string | null, labeledBy: string | null, confidence?: string | null) =>
    fetchApi<DatasetCase>(`/api/datasets/cases/${id}/label-2`, {
      method: 'PATCH',
      body: JSON.stringify({ label, notes, labeledBy, confidence: confidence ?? null }),
    }),

  composeDatasets: (name: string, description: string | null, datasetIds: number[]) =>
    fetchApi<Dataset>('/api/datasets/compose', {
      method: 'POST',
      body: JSON.stringify({ name, description, datasetIds }),
    }),

  compareRuns: (datasetId: number, runA: number, runB: number) =>
    fetchApi<RunComparisonResult>(`/api/datasets/${datasetId}/compare?runA=${runA}&runB=${runB}`),

  tagDatasetCase: (id: number, tags: string[]) =>
    fetchApi<DatasetCase>(`/api/datasets/cases/${id}/tags`, {
      method: 'PATCH',
      body: JSON.stringify({ tags }),
    }),
};

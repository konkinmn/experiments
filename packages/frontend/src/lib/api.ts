import type {
  Prompt,
  AnalysisJob,
  StartAnalysisConfig,
  CaseFilterParams,
  FilteredCasesResponse,
  JobSummary,
  PipelineResult,
  DatasetCase,
  DatasetLabel,
  SegmentInfo,
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
    throw new Error(`API error: ${response.status} ${response.statusText}`);
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

  // Dispute Pipeline API
  runDisputePipeline: (caseId: number) =>
    fetchApi<PipelineResult>('/api/dispute-pipeline/run', {
      method: 'POST',
      body: JSON.stringify({ caseId }),
    }),

  getPipelineResults: () =>
    fetchApi<{ data: PipelineResult[] }>('/api/dispute-pipeline/results'),

  submitPipelineReview: (id: number, verdict: 'correct' | 'incorrect', notes?: string) =>
    fetchApi<PipelineResult>(`/api/dispute-pipeline/results/${id}/review`, {
      method: 'PATCH',
      body: JSON.stringify({ verdict, notes: notes ?? null }),
    }),

  deletePipelineResult: (id: number) =>
    fetchApi<{ success: boolean }>(`/api/dispute-pipeline/results/${id}`, {
      method: 'DELETE',
    }),

  // Dataset Builder API
  getSegments: () =>
    fetchApi<{ data: SegmentInfo[] }>('/api/dataset/segments'),

  loadSegmentCases: (segment: string) =>
    fetchApi<{ data: unknown[]; loaded: number; skipped: number }>(`/api/dataset/segments/${segment}/load`, {
      method: 'POST',
    }),

  getDatasetCases: (segment?: string) => {
    const params = segment ? `?segment=${segment}` : '';
    return fetchApi<{ data: DatasetCase[] }>(`/api/dataset/cases${params}`);
  },

  labelDatasetCase: (id: number, label: DatasetLabel, notes: string | null, labeledBy: string | null) =>
    fetchApi<DatasetCase>(`/api/dataset/cases/${id}/label`, {
      method: 'PATCH',
      body: JSON.stringify({ label, notes, labeledBy }),
    }),

  deleteDatasetCase: (id: number) =>
    fetchApi<{ success: boolean }>(`/api/dataset/cases/${id}`, {
      method: 'DELETE',
    }),
};

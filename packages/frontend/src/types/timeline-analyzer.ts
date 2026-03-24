export interface Prompt {
  id: string;
  name: string;
}

export interface AnalysisResult {
  caseId: number;
  analysis: unknown;
  error: string | null;
}

export interface AnalysisProgress {
  current: number;
  total: number;
  currentCaseId: number | null;
}

export type AnalysisStatus = 'idle' | 'running' | 'completed' | 'error';

export interface AnalysisJob {
  id: string;
  status: 'running' | 'completed' | 'error';
  progress: AnalysisProgress;
  results: AnalysisResult[];
  error: string | null;
}

export interface StartAnalysisConfig {
  promptId: string;
  caseIds: number[];
}

export type CaseSource = 'manual' | 'filter' | 'visible';

export interface AnalyzerConfig {
  promptId: string;
  caseSource: CaseSource;
  manualCaseIds: string;
}

export interface CaseFilterParams {
  startDate: string;
  endDate: string;
  issueType?: string;
  statuses?: ('IN_PROGRESS' | 'RESOLVED' | 'DISMISSED')[];
}

export interface FilteredCasesResponse {
  caseIds: number[];
  count: number;
}

export interface SavedAnalysis {
  id: string;
  name: string;
  savedAt: string;
  promptId: string;
  promptName: string;
  results: AnalysisResult[];
  successCount: number;
  errorCount: number;
}

export interface JobSummary {
  id: string;
  status: 'running' | 'completed' | 'error';
  progress: AnalysisProgress;
  createdAt: string;
  resultCount: number;
  errorCount: number;
}

export interface CaseOverviewItem {
  alias: string;
  id: string;
  refId: string;
  issueType: string;
  status: string;
  outcome: string | null;
  owner: string | null;
  createdAt: string;
}

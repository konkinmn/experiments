import type { PipelineResult } from './rubric-tester';

export type DatasetLabel = 'credit' | 'escalate' | 'needs_more_info';
export type DatasetSourceType = 'preset' | 'case_ids' | 'custom_sql';

export interface Dataset {
  id: number;
  name: string;
  description: string | null;
  sourceType: DatasetSourceType;
  sourceConfig: Record<string, unknown>;
  totalCases: number;
  labeledCases: number;
  createdAt: string;
}

export interface DatasetWithCases extends Dataset {
  cases: DatasetCase[];
}

export interface DatasetCase {
  id: number;
  datasetId: number;
  caseId: number;
  pipelineRunId: number | null;
  pipelineRun: PipelineResult | null;
  label: DatasetLabel | null;
  labelNotes: string | null;
  labeledBy: string | null;
  labeledAt: string | null;
  createdAt: string;
}

export interface PresetInfo {
  key: string;
  label: string;
  description: string;
}

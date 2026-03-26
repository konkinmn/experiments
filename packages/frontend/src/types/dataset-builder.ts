import type { PipelineResult } from './rubric-tester';

export type DatasetLabel = 'credit' | 'escalate' | 'needs_more_info';
export type DatasetSourceType = 'case_ids' | 'custom_sql';

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
  pipelineError: string | null;
  pipelineRun: PipelineResult | null;
  label: DatasetLabel | null;
  labelNotes: string | null;
  labeledBy: string | null;
  labeledAt: string | null;
  createdAt: string;
}

export interface RubricWeights {
  account_trust_max: number;
  dispute_history_max: number;
  transaction_risk_max: number;
  green_threshold: number;
  amber_threshold: number;
}

export interface RunConfig {
  model: string;
  prompt_version: string;
  rubric_weights: RubricWeights;
  name: string;
}

export interface DatasetRun {
  id: number;
  dataset_id: number;
  name: string;
  config: RunConfig;
  status: 'pending' | 'running' | 'completed' | 'failed';
  created_at: string;
  completed_at: string | null;
  total_cases: number;
  completed_cases: number;
  agreement_rate: number | null;
  credit_precision: number | null;
  escalate_recall: number | null;
}

export interface DatasetRunCase {
  id: number;
  runId: number;
  datasetCaseId: number;
  caseId: number;
  label: DatasetLabel | null;
  labelNotes: string | null;
  labeledBy: string | null;
  labeledAt: string | null;
  pipelineRunId: number | null;
  pipelineError: string | null;
  pipelineRun: PipelineResult | null;
  agreement: boolean | null;
}

export interface RunOptions {
  models: string[];
  prompts: string[];
  default_rubric: RubricWeights;
}

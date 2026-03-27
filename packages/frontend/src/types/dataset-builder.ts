import type { PipelineResult } from './rubric-tester';

export type DatasetLabel = 'credit' | 'escalate' | 'undecided';
export type LabelConfidence = 'high' | 'medium' | 'low';
export type DisagreementReason = 'signal_quality' | 'rubric_issue' | 'llm_reasoning' | 'human_label_wrong' | 'edge_case' | 'other';
export type DatasetSourceType = 'case_ids' | 'custom_sql' | 'composition';

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
  labelConfidence: LabelConfidence | null;
  disagreementReason: DisagreementReason | null;
  disagreementNotes: string | null;
  label2: DatasetLabel | null;
  label2Notes: string | null;
  label2By: string | null;
  label2At: string | null;
  label2Confidence: LabelConfidence | null;
  manualTags: string[];
  autoTags: Record<string, string | boolean>;
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
  false_credit_rate: number | null;
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
  labelConfidence: LabelConfidence | null;
  disagreementReason: DisagreementReason | null;
  disagreementNotes: string | null;
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

// --- Analytics types ---

export interface SegmentMetrics {
  sample_size: number;
  agreement_rate: number | null;
  credit_precision: number | null;
  escalate_recall: number | null;
  false_credit_rate: number | null;
}

export interface ConfusionMatrix {
  true_credit: number;
  false_credit: number;
  true_escalate: number;
  false_escalate: number;
  unlabeled: number;
  undecided: number;
}

export interface DisagreementBreakdownEntry {
  count: number;
  percentage: number;
}

export interface InterAnnotatorAgreement {
  kappa: number | null;
  agreement_rate: number | null;
  dual_labeled_count: number;
}

export interface DatasetAnalytics {
  confusion_matrix: ConfusionMatrix;
  overall: SegmentMetrics;
  stratified: {
    by_risk_level: Record<string, SegmentMetrics>;
    by_dispute_type: Record<string, SegmentMetrics>;
    by_hard_gate: Record<string, SegmentMetrics>;
    by_rubric_bucket: Record<string, SegmentMetrics>;
    by_label_confidence: Record<string, SegmentMetrics>;
  };
  disagreement_breakdown: Record<string, DisagreementBreakdownEntry>;
  inter_annotator: InterAnnotatorAgreement | null;
}

// --- Run Comparison types ---

export interface FlippedCase {
  caseId: number;
  datasetCaseId: number;
  label: string | null;
  runA_decision: string;
  runB_decision: string;
  direction: 'improved' | 'regressed' | 'changed';
}

export interface RunComparisonResult {
  summary: {
    runA: SegmentMetrics;
    runB: SegmentMetrics;
    delta: {
      agreement_rate: number | null;
      credit_precision: number | null;
      escalate_recall: number | null;
      false_credit_rate: number | null;
    };
  };
  flipped_cases: FlippedCase[];
  net_improvement: number;
}

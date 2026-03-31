// --- Pipeline types (shared across dataset builder) ---

export type RiskLevel = 'green' | 'amber' | 'red';

export interface CaseSignalsRaw {
  case_id: number;
  company_id: number;
  alias: string;
  case_created_at: string;
  total_amount: number;
  max_transaction_amount: number;
  merchants: string;
  account_age_days: number;
  account_status: string;
  cifas_count: number;
  tier_name: string | null;
  is_money_maker: boolean;
  trust_score: string | null;
  scammer_count: number;
  scam_victim_count: number;
  tx_count_90_days: number;
  active_months: number;
  prior_payments_to_merchant: number;
  railsr_disputes_last_6_months: number;
  railsr_disputes_last_30_days: number;
}

export interface HardGateSignals {
  cifas: boolean;
  railsr_dispute_last_6_months: boolean;
  confirmed_scammer: boolean;
  account_not_active: boolean;
}

export interface DisputeProfile {
  case_id: number;
  alias: string;
  company_id: number;
  risk_level: RiskLevel;
  total_amount: number;
  max_transaction_amount: number;
  merchants: string;
  account_age_days: number;
  account_status: string;
  tier_name: string | null;
  is_money_maker: boolean;
  trust_score: string | null;
  rubric_score: number;
  category_scores: {
    account_trust: number;
    dispute_history: number;
    transaction_risk: number;
  };
  risk_factors: string[];
}

export interface PlannerArgs {
  is_dispute: false;
  is_fraud: boolean;
  credit_mode: 'IMMEDIATELY';
  reason: string;
  fraud_type?: string;
  fraud_sub_type?: string;
  crime_reference?: string;
}

export interface PlannerOutput {
  thought: string;
  decision: 'credit' | 'escalate_to_agent';
  args?: PlannerArgs;
  uncertainty_factors: string[];
}

export type PlannerDecision = PlannerOutput['decision'];

// Stable contract for the AI iteration artifact (projection of pipeline run data)
export interface AIIterationArtifact {
  version: '1.0';
  dispute_profile: {
    risk_level: RiskLevel;
    rubric_score: number;
    category_scores: {
      account_trust: number;
      dispute_history: number;
      transaction_risk: number;
    };
    signals: CaseSignalsRaw;
    risk_factors: string[];
  };
  hard_gate_result: {
    passed: boolean;
    triggered_gate: string | null;
  };
  planner_output: PlannerOutput | null;
  enrichment: {
    model: string;
    prompt_version: string;
    files_parsed: number;
    files_failed: number;
    dialogues_fetched: number;
    dialogues_failed: number;
    case_actions_count: number;
    customer_messages_count: number;
  };
  executor_action: string;
  pipeline_duration_ms: number;
  created_at: string;
  pipeline_run_id: number;
}

export interface PipelineResult {
  id: number;
  caseId: number;
  rawSignals: CaseSignalsRaw;
  caseDetails: unknown | null;
  disputeProfile: DisputeProfile;
  hardGates: HardGateSignals;
  hardGateTriggered: string | null;
  plannerOutput: PlannerOutput | null;
  executorAction: string;
  pipelineDurationMs: number;
  promptVersion: string | null;
  plannerRawResponse: string | null;
  plannerRequest: Record<string, unknown> | null;
  plannerSystemPrompt: string | null;
  fileParseResults: string[] | null;
  dialogueMessages: Array<{ role: string; content: string; created_at: string }> | null;
  enrichmentMetadata: {
    dialogues_requested?: number;
    dialogues_found?: number;
    dialogues_with_messages?: number;
    chat_fetch_failures?: Array<{
      dialogue_id: number;
      alias: string;
      status: number;
      error_body: string;
    }>;
    total_messages_fetched?: number;
    customer_messages_filtered?: number;
    customer_messages_sent_to_planner?: number;
    file_artifacts_found?: number;
    file_descriptions_parsed?: number;
  } | null;
  reviewerVerdict: 'correct' | 'incorrect' | null;
  reviewerNotes: string | null;
  reviewedAt: string | null;
  createdAt: string;
  artifact: AIIterationArtifact;
}

// --- Dataset types ---

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
  status?: 'loading' | 'ready';
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
  // Context data (new architecture)
  rawSignals: CaseSignalsRaw | null;
  caseDetails: Record<string, unknown> | null;
  caseActions: Array<{ action_type: string; status: string; created_at: string; metadata: Record<string, unknown> }> | null;
  dialogueMessages: Array<{ role: string; content: string; created_at: string }> | null;
  fileParseResults: string[] | null;
  enrichmentMetadata: Record<string, unknown> | null;
  contextError: string | null;
  contextFetchedAt: string | null;
  // Legacy fields
  pipelineRunId: number | null;
  pipelineError: string | null;
  pipelineRun: PipelineResult | null;
  // Labels
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

export interface HardGateConfig {
  cifas: boolean;
  confirmed_scammer: boolean;
  account_not_active: boolean;
  railsr_dispute_last_6_months: boolean;
}

export interface RubricScoringRules {
  account_age: Array<{ min_days: number; points: number }>;
  tier: Record<string, number>;
  money_maker_points: number;
  trust_score: Record<string, number>;
  tx_activity: { min_count: number; points: number };
  dispute_history: Array<{ max_disputes: number; points: number }>;
  recent_dispute_penalty: number;
  scam_victim_penalty: number;
  amount_brackets: Array<{ max_amount: number; points: number }>;
}

export interface PipelineConfig {
  hard_gates: HardGateConfig;
  rubric_weights: RubricWeights;
  scoring_rules: RubricScoringRules;
}

export interface RunConfig {
  model: string;
  prompt_version: string;
  prompt_content?: string;
  pipeline_config: PipelineConfig;
  name: string;
}

export interface DatasetRun {
  id: number;
  dataset_id: number;
  name: string;
  description: string | null;
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
  actionNote: string | null;
  pipelineRunId: number | null;
  pipelineError: string | null;
  pipelineRun: PipelineResult | null;
  datasetLabel: DatasetLabel | null;
  datasetLabelNotes: string | null;
  datasetLabelConfidence: string | null;
  datasetManualTags: string[];
  agreement: boolean | null;
}

export interface RunOptions {
  default_model: string;
  default_prompt: { id: string; content: string };
  default_pipeline_config: PipelineConfig;
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

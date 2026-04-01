export type RiskLevel = 'green' | 'amber' | 'red';

export interface DialogueMessage {
  role: string;
  content: string;
  created_at: string;
}

export interface DialogueFetchMetadata {
  dialogues_requested: number;
  dialogues_found: number;
  dialogues_with_messages: number;
  chat_fetch_failures: Array<{
    dialogue_id: number;
    alias: string;
    status: number;
    error_body: string;
  }>;
}

export interface CaseAction {
  id: number;
  action_type: string;
  status: string;
  created_at: string;
  metadata: {
    crime_ref_number?: string;
    crime_date?: string;
    dispute_form_file_id?: string;
    [key: string]: unknown;
  };
}

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
  fraud_type?: string | null;
  fraud_sub_type?: string | null;
  crime_reference?: string | null;
}

export interface PlannerOutput {
  thought: string;
  decision: 'credit' | 'escalate_to_agent';
  args?: PlannerArgs;
  uncertainty_factors: string[];
}

export interface PipelineRunRow {
  id: number;
  case_id: number;
  raw_signals: CaseSignalsRaw;
  case_details: unknown | null;
  dispute_profile: DisputeProfile;
  hard_gates: HardGateSignals;
  hard_gate_triggered: string | null;
  planner_output: PlannerOutput | null;
  executor_action: string;
  pipeline_duration_ms: number;
  prompt_version: string | null;
  planner_raw_response: string | null;
  case_actions: CaseAction[] | null;
  planner_request: Record<string, unknown> | null;
  planner_system_prompt: string | null;
  file_parse_results: string[] | null;
  dialogue_messages: DialogueMessage[] | null;
  enrichment_metadata: Record<string, unknown> | null;
  reviewer_verdict: string | null;
  reviewer_notes: string | null;
  reviewed_at: string | null;
  created_at: string;
}

export interface PipelineRunInsert {
  case_id: number;
  raw_signals: CaseSignalsRaw;
  case_details: unknown | null;
  dispute_profile: DisputeProfile;
  hard_gates: HardGateSignals;
  hard_gate_triggered: string | null;
  planner_output: PlannerOutput | null;
  executor_action: string;
  pipeline_duration_ms: number;
  prompt_version: string | null;
  planner_raw_response: string | null;
  case_actions: CaseAction[] | null;
  planner_request: Record<string, unknown> | null;
  planner_system_prompt: string | null;
  file_parse_results: string[] | null;
  dialogue_messages: DialogueMessage[] | null;
  enrichment_metadata: Record<string, unknown> | null;
}

// --- AI Iteration Artifact ---
// Stable contract for what anna-case will receive as artifact_extra.
// Pure projection of PipelineRunRow — no new storage, no duplication.

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

export function buildArtifactFromRun(row: PipelineRunRow): AIIterationArtifact {
  const meta = (row.enrichment_metadata ?? {}) as Record<string, number | string>;
  return {
    version: '1.0',
    dispute_profile: {
      risk_level: row.dispute_profile.risk_level,
      rubric_score: row.dispute_profile.rubric_score,
      category_scores: row.dispute_profile.category_scores,
      signals: row.raw_signals,
      risk_factors: row.dispute_profile.risk_factors,
    },
    hard_gate_result: {
      passed: !row.hard_gate_triggered,
      triggered_gate: row.hard_gate_triggered,
    },
    planner_output: row.planner_output,
    enrichment: {
      model: (meta.model as string) ?? 'unknown',
      prompt_version: row.prompt_version ?? 'unknown',
      files_parsed: (meta.files_parsed as number) ?? 0,
      files_failed: (meta.files_failed as number) ?? 0,
      dialogues_fetched: (meta.dialogues_fetched as number) ?? 0,
      dialogues_failed: (meta.dialogues_failed as number) ?? 0,
      case_actions_count: row.case_actions?.length ?? 0,
      customer_messages_count: row.dialogue_messages?.length ?? 0,
    },
    executor_action: row.executor_action,
    pipeline_duration_ms: row.pipeline_duration_ms,
    created_at: row.created_at,
    pipeline_run_id: row.id,
  };
}

// --- Pipeline Run Formatter ---

export function formatPipelineRun(row: PipelineRunRow) {
  return {
    id: row.id,
    caseId: row.case_id,
    rawSignals: row.raw_signals,
    caseDetails: row.case_details,
    disputeProfile: row.dispute_profile,
    hardGates: row.hard_gates,
    hardGateTriggered: row.hard_gate_triggered,
    plannerOutput: row.planner_output,
    executorAction: row.executor_action,
    pipelineDurationMs: row.pipeline_duration_ms,
    promptVersion: row.prompt_version,
    plannerRawResponse: row.planner_raw_response,
    plannerRequest: row.planner_request,
    plannerSystemPrompt: row.planner_system_prompt,
    fileParseResults: row.file_parse_results,
    dialogueMessages: row.dialogue_messages,
    enrichmentMetadata: row.enrichment_metadata,
    caseActions: row.case_actions,
    reviewerVerdict: row.reviewer_verdict,
    reviewerNotes: row.reviewer_notes,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    artifact: buildArtifactFromRun(row),
  };
}

// --- Pipeline Configuration ---
// All hardcoded pipeline rules as a configurable object.
// Defaults match current production behavior. Override per run to test variations.

export interface HardGateConfig {
  cifas: boolean;                 // default: true
  confirmed_scammer: boolean;     // default: true
  account_not_active: boolean;    // default: true
  railsr_dispute_last_6_months: boolean; // default: true
}

export interface RubricWeights {
  account_trust_max: number;      // default 58
  dispute_history_max: number;    // default 30
  transaction_risk_max: number;   // default 20
  green_threshold: number;        // default 70
  amber_threshold: number;        // default 40
}

export interface RubricScoringRules {
  // Account age breakpoints: [threshold_days, points]
  account_age: Array<{ min_days: number; points: number }>;
  // Tier points: tier_name → points
  tier: Record<string, number>;
  // Money maker bonus
  money_maker_points: number;
  // Trust score points: score_level → points
  trust_score: Record<string, number>;
  // Transaction activity threshold
  tx_activity: { min_count: number; points: number };
  // Dispute history: [max_disputes_6m, points]
  dispute_history: Array<{ max_disputes: number; points: number }>;
  // Recent dispute penalty
  recent_dispute_penalty: number;
  // Scam victim penalty
  scam_victim_penalty: number;
  // Amount brackets: [max_amount, points]
  amount_brackets: Array<{ max_amount: number; points: number }>;
  // Crime reference bonus points (contextual)
  crime_reference_points: number;
}

export interface PipelineConfig {
  hard_gates: HardGateConfig;
  rubric_weights: RubricWeights;
  scoring_rules: RubricScoringRules;
}

// --- Dataset Run types ---

export interface RunConfig {
  model: string;                  // e.g. 'claude-sonnet-4-6'
  prompt_version: string;         // e.g. 'dispute-planner-v1' or 'custom'
  prompt_content?: string;        // full prompt text (stored per run for reproducibility)
  pipeline_config: PipelineConfig; // full pipeline config (gates, weights, scoring rules)
  name: string;                   // human-readable run name
  // Legacy field — kept for backward compatibility with existing runs
  rubric_weights?: RubricWeights;
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
  // computed
  total_cases: number;
  completed_cases: number;
  agreement_rate: number | null;
  credit_precision: number | null;
  escalate_recall: number | null;
  false_credit_rate: number | null;
}

export interface DatasetRunCase {
  id: number;
  run_id: number;
  dataset_case_id: number;
  pipeline_run: PipelineRunRow | null;
  label: DatasetLabel | null;
  agreement: boolean | null;
}

// --- Dataset Builder types ---

export type DatasetLabel = 'credit' | 'escalate' | 'undecided';
export type LabelConfidence = 'high' | 'medium' | 'low';
export type DisagreementReason = 'signal_quality' | 'rubric_issue' | 'llm_reasoning' | 'human_label_wrong' | 'edge_case' | 'other';
export type DatasetSourceType = 'case_ids' | 'custom_sql' | 'composition';

export interface DatasetRow {
  id: number;
  name: string;
  description: string | null;
  source_type: DatasetSourceType;
  source_config: Record<string, unknown>;
  status: 'loading' | 'ready';
  created_at: string;
}

export interface DatasetWithCounts extends DatasetRow {
  total_cases: number;
  labeled_cases: number;
}

export interface CaseContext {
  raw_signals: CaseSignalsRaw;
  case_details: unknown | null;
  case_actions: CaseAction[] | null;
  dialogue_messages: DialogueMessage[] | null;
  file_parse_results: string[] | null;
  enrichment_metadata: Record<string, unknown> | null;
}

export interface DatasetCaseRow {
  id: number;
  dataset_id: number;
  case_id: number;
  pipeline_run_id: number | null;
  pipeline_error: string | null;
  // Context data (new architecture)
  raw_signals: CaseSignalsRaw | null;
  case_details: unknown | null;
  case_actions: CaseAction[] | null;
  dialogue_messages: DialogueMessage[] | null;
  file_parse_results: string[] | null;
  enrichment_metadata: Record<string, unknown> | null;
  context_error: string | null;
  context_fetched_at: string | null;
  // Labels
  label: DatasetLabel | null;
  label_notes: string | null;
  labeled_by: string | null;
  labeled_at: string | null;
  label_confidence: LabelConfidence | null;
  disagreement_reason: DisagreementReason | null;
  disagreement_notes: string | null;
  label_2: DatasetLabel | null;
  label_2_notes: string | null;
  label_2_by: string | null;
  label_2_at: string | null;
  label_2_confidence: LabelConfidence | null;
  manual_tags: string[];
  auto_tags: Record<string, string | boolean>;
  created_at: string;
}

export interface DatasetCaseWithRun extends DatasetCaseRow {
  pipeline_run: PipelineRunRow | null;
}


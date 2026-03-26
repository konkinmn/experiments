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
  fraud_type?: string;
  fraud_sub_type?: string;
  crime_reference?: string;
}

export interface PlannerOutput {
  thought: string;
  decision: 'credit' | 'escalate_to_agent';
  credit_timing: 'immediately' | 'none';
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

// --- Dataset Builder types ---

export type DatasetLabel = 'credit' | 'escalate' | 'needs_more_info';

export interface DatasetCaseRow {
  id: number;
  case_id: number;
  segment: string;
  pipeline_run_id: number | null;
  label: DatasetLabel | null;
  label_notes: string | null;
  labeled_by: string | null;
  labeled_at: string | null;
  created_at: string;
}

export interface DatasetCaseWithRun extends DatasetCaseRow {
  pipeline_run: PipelineRunRow | null;
}

export interface SegmentInfo {
  key: string;
  label: string;
  description: string;
  labeled_count: number;
  total_count: number;
}

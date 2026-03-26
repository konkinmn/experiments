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
  credit_timing: 'immediately' | 'none';
  args?: PlannerArgs;
  uncertainty_factors: string[];
}

export type PlannerDecision = PlannerOutput['decision'];

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
}

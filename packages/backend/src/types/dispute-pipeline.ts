export type RiskLevel = 'GREEN' | 'AMBER' | 'RED';

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
  is_authenticated: boolean | null;
  auth_method: string | null;
}

export interface AnnaCaseScoringBreakdownItem {
  signal: string;
  value: unknown;
  points: number;
  max_points: number;
}

export interface DisputeProfile {
  score: number;
  score_max: number;
  risk_level: RiskLevel;
  category_scores: Record<string, number>; // ACCOUNT_TRUST, DISPUTE_HISTORY, TRANSACTION_RISK
  breakdown: AnnaCaseScoringBreakdownItem[];
  risk_factors: string[];
}

export interface AnnaCaseGateCheckResult {
  gate: string; // CIFAS | SCAMMER | ACCOUNT_NOT_ACTIVE | RAILSR_DISPUTE
  passed: boolean;
  detail: string;
}

export interface HardGateResult {
  passed: boolean;
  results: AnnaCaseGateCheckResult[];
  triggered_gate: string | null;
}

export interface PlannerArgs {
  is_dispute: boolean;
  is_fraud: boolean;
  credit_mode: 'IMMEDIATELY' | 'ON_WIN' | 'ON_CHARGEBACK_NOTIFICATION';
  reason: 'NOT_AUTHORISED' | 'DIFFERENT_AMOUNT' | 'DUPLICATE' | 'NO_FUNDS_FROM_ATM' | 'OTHER';
  fraud_type: string | null;
  fraud_sub_type: string | null;
  crime_reference: string | null;
}

// Fixed evidence vocabulary, mirroring anna-case anna_case/dispute_pipeline/models.py
// EvidenceItem. The bridge must emit exactly these values so anna-case's
// build_evidence_check sees what evidence is already attached.
export type EvidenceItem =
  | 'MERCHANT_CORRESPONDENCE'
  | 'ORDER_CONFIRMATION'
  | 'PROOF_OF_NON_DELIVERY'
  | 'PHOTOS_OF_GOODS'
  | 'CANCELLATION_CONFIRMATION'
  | 'ATM_RECEIPT'
  | 'POLICE_REPORT';

// One parsed file artifact: a text description plus its classification into the
// evidence vocabulary (null when the document matches no vocabulary item).
export interface FileParseResult {
  description: string;
  evidence_item: EvidenceItem | null;
}

export interface PlannerOutput {
  thought: string;
  // request_evidence is an intermediate action; in prod it downgrades to escalate
  // when the customer never answers. anna-case PlannerDecision allows all three.
  decision: 'credit' | 'escalate_to_agent' | 'request_evidence';
  args: PlannerArgs | null;
  uncertainty_factors: string[];
}

export interface PipelineRunRow {
  id: number;
  case_id: number;
  raw_signals: CaseSignalsRaw;
  case_details: unknown | null;
  dispute_profile: DisputeProfile | null;
  hard_gates: HardGateResult | null;
  hard_gate_triggered: string | null;
  planner_output: PlannerOutput | null;
  executor_action: string;
  pipeline_duration_ms: number;
  prompt_version: string | null;
  prompt_md5: string | null;
  engine: string;
  planner_raw_response: string | null;
  case_actions: CaseAction[] | null;
  planner_request: Record<string, unknown> | null;
  planner_system_prompt: string | null;
  file_parse_results: FileParseResult[] | null;
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
  dispute_profile: DisputeProfile | null;
  hard_gates: HardGateResult | null;
  hard_gate_triggered: string | null;
  planner_output: PlannerOutput | null;
  executor_action: string;
  pipeline_duration_ms: number;
  prompt_version: string | null;
  prompt_md5: string | null;
  engine: string;
  planner_raw_response: string | null;
  case_actions: CaseAction[] | null;
  planner_request: Record<string, unknown> | null;
  planner_system_prompt: string | null;
  file_parse_results: FileParseResult[] | null;
  dialogue_messages: DialogueMessage[] | null;
  enrichment_metadata: Record<string, unknown> | null;
}

// --- AI Iteration Artifact ---
// Stable contract for what anna-case will receive as artifact_extra.
// Pure projection of PipelineRunRow — no new storage, no duplication.

export interface AIIterationArtifact {
  version: '2.0';
  engine: string;
  dispute_profile: DisputeProfile | null;
  hard_gate_result: HardGateResult | null;
  planner_output: PlannerOutput | null;
  enrichment: {
    model: string;
    prompt_version: string;
    prompt_md5: string | null;
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
    version: '2.0',
    engine: row.engine,
    dispute_profile: row.dispute_profile,
    hard_gate_result: row.hard_gates,
    planner_output: row.planner_output,
    enrichment: {
      model: (meta.model as string) ?? 'unknown',
      prompt_version: row.prompt_version ?? 'unknown',
      prompt_md5: row.prompt_md5,
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
    engine: row.engine,
    rawSignals: row.raw_signals,
    caseDetails: row.case_details,
    disputeProfile: row.dispute_profile,
    hardGates: row.hard_gates,
    hardGateTriggered: row.hard_gate_triggered,
    plannerOutput: row.planner_output,
    executorAction: row.executor_action,
    pipelineDurationMs: row.pipeline_duration_ms,
    promptVersion: row.prompt_version,
    promptMd5: row.prompt_md5,
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

// --- Dataset Run types ---

export interface RunConfig {
  model: string;                  // e.g. 'claude-sonnet-4-6'
  prompt_version: string;         // anna-case prompt version captured at run-start
  prompt_content?: string;        // full prompt text (stored per run for reproducibility)
  name: string;                   // human-readable run name
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
  file_parse_results: FileParseResult[] | null;
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
  file_parse_results: FileParseResult[] | null;
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

import { z } from 'zod';
import { fetchCaseSignals } from './signals-query.js';
import { fetchCaseDetails, fetchArtifactAsBase64, fetchCaseActions, fetchCaseDialogues } from './case-api.js';
import { analyzeWithLLM, parseFileWithLLM } from './llm-api.js';
import type { ContentPart } from './llm-api.js';
import { getPromptById } from './prompts.js';
import { insertPipelineRun } from './db.js';
import type {
  CaseSignalsRaw,
  CaseAction,
  DialogueMessage,
  HardGateSignals,
  DisputeProfile,
  PlannerOutput,
  PipelineRunRow,
  RiskLevel,
} from '../types/dispute-pipeline.js';

const PROMPT_ID = 'dispute-planner-v1';
const MAX_DIALOGUE_MESSAGES = 50;

const FILE_PARSER_SYSTEM_PROMPT = `Your task is to analyze an uploaded document, detect its type, and extract structured data.

1. Detect Document Type

Classify the document into one primary type:
- Dispute form, invoice, receipt, bank statement, payment proof
- Screenshot of a transaction or conversation
- Other (specify)

2. Extraction Rules

For dispute forms:
- Extract fraud type, dispute reason, crime reference, card status
- Extract any merchant or transaction details mentioned

For invoices/receipts/statements:
- Extract counterparties, amounts, currencies, taxes
- Extract dates (issue, due, payment)
- Extract identifiers (invoice number, transaction ID, etc.)

For screenshots/images:
- Describe what is visible in the image
- Extract any text, amounts, or transaction details shown

Do not infer missing data. Only report what is explicitly present in the document.`;

const FILE_PARSER_USER_PROMPT = 'Extract all relevant information from this file for a dispute case review.';

// --- Layer 0: Signal fetch + dispute profile ---

function deriveHardGates(raw: CaseSignalsRaw): HardGateSignals {
  return {
    cifas: raw.cifas_count > 0,
    railsr_dispute_last_6_months: raw.railsr_disputes_last_6_months > 0,
    confirmed_scammer: raw.scammer_count > 0,
    account_not_active: raw.account_status !== 'ACCOUNT_IS_ACTIVE',
  };
}

interface RubricScoreResult {
  total: number;
  account_trust: number;
  dispute_history: number;
  transaction_risk: number;
}

function computeRubricScore(raw: CaseSignalsRaw): RubricScoreResult {
  // Category 1 — Account Trust (max 58)
  let accountTrust = 0;

  if (raw.account_age_days >= 365) accountTrust += 20;
  else if (raw.account_age_days >= 180) accountTrust += 12;
  else if (raw.account_age_days >= 90) accountTrust += 5;

  const tier = raw.tier_name?.toUpperCase();
  if (tier === 'E') accountTrust += 10;
  else if (tier === 'D') accountTrust += 8;
  else if (tier === 'C') accountTrust += 5;

  if (raw.is_money_maker) accountTrust += 15;

  const trust = raw.trust_score?.toUpperCase();
  if (trust === 'GREEN') accountTrust += 8;
  else if (trust === 'AMBER') accountTrust += 4;

  if (raw.tx_count_90_days >= 5) accountTrust += 5;

  // Category 2 — Dispute History (max 30)
  let disputeHistory = 0;

  if (raw.railsr_disputes_last_6_months === 0) disputeHistory += 30;
  else if (raw.railsr_disputes_last_6_months <= 2) disputeHistory += 15;
  else if (raw.railsr_disputes_last_6_months <= 4) disputeHistory += 5;

  if (raw.railsr_disputes_last_30_days > 0) disputeHistory -= 5;
  if (raw.scam_victim_count > 0) disputeHistory -= 5;
  disputeHistory = Math.max(disputeHistory, 0);

  // Category 3 — Transaction Risk (max 20)
  let transactionRisk = 0;
  const amount = Number(raw.max_transaction_amount);
  if (!isNaN(amount)) {
    if (amount < 5) transactionRisk += 20;
    else if (amount < 10) transactionRisk += 14;
    else if (amount < 15) transactionRisk += 9;
    else if (amount <= 25) transactionRisk += 5;
  }

  return {
    total: accountTrust + disputeHistory + transactionRisk,
    account_trust: accountTrust,
    dispute_history: disputeHistory,
    transaction_risk: transactionRisk,
  };
}

function deriveRiskLevel(hardGates: HardGateSignals, rubricScore: number): RiskLevel {
  if (Object.values(hardGates).some(Boolean)) return 'red';
  if (rubricScore >= 70) return 'green';
  if (rubricScore >= 40) return 'amber';
  return 'red';
}

function buildDisputeProfile(raw: CaseSignalsRaw, hardGates: HardGateSignals): DisputeProfile {
  const rubric = computeRubricScore(raw);
  const riskLevel = deriveRiskLevel(hardGates, rubric.total);

  const riskFactors: string[] = [];
  if (raw.cifas_count > 0) riskFactors.push('CIFAS marker present');
  if (raw.scammer_count > 0) riskFactors.push('Confirmed scammer');
  if (raw.account_status !== 'ACCOUNT_IS_ACTIVE') riskFactors.push(`Account status: ${raw.account_status}`);
  if (raw.railsr_disputes_last_6_months > 0) riskFactors.push(`${raw.railsr_disputes_last_6_months} Railsr dispute(s) in last 6 months`);
  if (raw.account_age_days < 180) riskFactors.push(`New account (${raw.account_age_days} days)`);
  if (raw.trust_score?.toUpperCase() === 'BLUE') riskFactors.push('Blue trust score (lowest level)');
  if (raw.tier_name?.toUpperCase() === 'B') riskFactors.push('Tier B');
  if (raw.scam_victim_count > 0) riskFactors.push(`Scam victim (${raw.scam_victim_count})`);

  return {
    case_id: raw.case_id,
    alias: raw.alias,
    company_id: raw.company_id,
    risk_level: riskLevel,
    total_amount: raw.total_amount,
    max_transaction_amount: raw.max_transaction_amount,
    merchants: raw.merchants,
    account_age_days: raw.account_age_days,
    account_status: raw.account_status,
    tier_name: raw.tier_name,
    is_money_maker: raw.is_money_maker,
    trust_score: raw.trust_score,
    rubric_score: rubric.total,
    category_scores: {
      account_trust: rubric.account_trust,
      dispute_history: rubric.dispute_history,
      transaction_risk: rubric.transaction_risk,
    },
    risk_factors: riskFactors,
  };
}

// --- Layer 1: Hard gates ---

function checkHardGates(gates: HardGateSignals): string | null {
  if (gates.cifas) return 'cifas';
  if (gates.confirmed_scammer) return 'confirmed_scammer';
  if (gates.account_not_active) return 'account_not_active';
  if (gates.railsr_dispute_last_6_months) return 'railsr_dispute_last_6_months';
  return null;
}

// --- Layer 2: Planner ---

const ALLOWED_ARTIFACT_TYPES = new Set([
  'FILE',
]);

function filterCaseArtifacts(artifacts: unknown[]): unknown[] {
  return artifacts.filter((a) => {
    if (typeof a === 'object' && a !== null && 'artifact_type' in a) {
      const type = (a as { artifact_type: string }).artifact_type?.toUpperCase();
      return ALLOWED_ARTIFACT_TYPES.has(type);
    }
    return false;
  });
}

const PlannerArgsSchema = z.object({
  is_dispute: z.literal(false),
  is_fraud: z.boolean(),
  credit_mode: z.literal('IMMEDIATELY'),
  reason: z.enum(['NOT_AUTHORISED', 'DIFFERENT_AMOUNT', 'DUPLICATE', 'NO_FUNDS_FROM_ATM', 'OTHER']),
  fraud_type: z.enum([
    'LOST_CARD_FRAUD', 'STOLEN_CARD_FRAUD', 'COUNTERFEIT_CARD_FRAUD',
    'ACCOUNT_TAKEOVER_FRAUD', 'CARD_NOT_PRESENT_FRAUD', 'BUST_OUT_COLLUSIVE_MERCHANT',
    'FIRST_PARTY', 'MODIFICATION_OF_PAYMENT_ORDER', 'MANIPULATION_OF_CARDHOLDER',
    'PAYMENT_CREATED_BY_FRAUDSTER', 'MANIPULATION_OF_PAYER_BY_FRAUDSTER',
  ]).optional(),
  fraud_sub_type: z.enum([
    'CONVENIENCE_OR_BALANCE_TRANSFER', 'PIN_NOT_USED', 'PIN_USED', 'UNKNOWN',
    'ADVANCE_FEE', 'IMPERSONATION', 'INVESTMENT', 'PURCHASE', 'ROMANCE',
  ]).optional(),
  crime_reference: z.string().optional(),
});

const PlannerOutputSchema = z.discriminatedUnion('decision', [
  z.object({
    thought: z.string(),
    decision: z.literal('credit'),
    credit_timing: z.literal('immediately'),
    args: PlannerArgsSchema,
    uncertainty_factors: z.array(z.string()),
  }),
  z.object({
    thought: z.string(),
    decision: z.literal('escalate_to_agent'),
    credit_timing: z.literal('none'),
    args: z.undefined().optional(),
    uncertainty_factors: z.array(z.string()),
  }),
]);

function parseJson(raw: string): unknown {
  // Try direct parse
  try {
    return JSON.parse(raw);
  } catch {
    // noop
  }

  // Try extracting from markdown code block
  const codeBlockMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1]);
    } catch {
      // noop
    }
  }

  // Try brace-counting extraction
  const firstBrace = raw.indexOf('{');
  if (firstBrace >= 0) {
    let depth = 0;
    for (let i = firstBrace; i < raw.length; i++) {
      if (raw[i] === '{') depth++;
      if (raw[i] === '}') depth--;
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(firstBrace, i + 1));
        } catch {
          break;
        }
      }
    }
  }

  return null;
}

const NON_CUSTOMER_SENDER_TYPES = new Set([
  'agent', 'system', 'annabot', 'bot', 'unknown',
]);

function filterCustomerMessages(messages: DialogueMessage[]): DialogueMessage[] {
  return messages.filter((m) => !NON_CUSTOMER_SENDER_TYPES.has(m.role.toLowerCase()));
}

async function fetchAndParseFileArtifacts(
  fileArtifacts: unknown[],
): Promise<string[]> {
  // Fetch artifact files in parallel
  const artifactResults = await Promise.allSettled(
    fileArtifacts.map(async (a) => {
      const artifact = a as { id: number; artifact_id: string; artifact_type: string };
      const fileId = artifact.artifact_id ?? String(artifact.id);
      const file = await fetchArtifactAsBase64(fileId);
      return { artifact, file };
    }),
  );

  // Build multimodal content parts for Gemini parsing
  const fileParts: ContentPart[] = [];
  for (const result of artifactResults) {
    if (result.status !== 'fulfilled' || !result.value.file) continue;
    const { file } = result.value;

    if (file.mimeType === 'application/pdf') {
      fileParts.push({
        type: 'file',
        file: {
          filename: file.filename,
          file_data: `data:application/pdf;base64,${file.base64}`,
        },
      });
    } else {
      fileParts.push({
        type: 'image_url',
        image_url: {
          url: `data:${file.mimeType};base64,${file.base64}`,
        },
      });
    }
  }

  // Parse each file with Google Gemini (in parallel)
  console.log(`[Planner] ${fileParts.length} file(s) to parse with Gemini`);
  const parsedDescriptions: string[] = [];
  if (fileParts.length > 0) {
    const parseResults = await Promise.allSettled(
      fileParts.map(part => parseFileWithLLM(FILE_PARSER_SYSTEM_PROMPT, FILE_PARSER_USER_PROMPT, part)),
    );
    for (const result of parseResults) {
      if (result.status === 'fulfilled') {
        parsedDescriptions.push(result.value);
      } else {
        console.warn('[Planner] File parse failed:', result.reason);
        parsedDescriptions.push('[File could not be parsed]');
      }
    }
    console.log(`[Planner] Parsed ${parsedDescriptions.length} file description(s): [${parsedDescriptions.map(d => `${d.length} chars`).join(', ')}]`);
  }

  return parsedDescriptions;
}

interface EnrichmentData {
  caseActions: CaseAction[];
  customerDialogueMessages: DialogueMessage[];
  parsedFileDescriptions: string[];
}

async function callPlanner(
  profile: DisputeProfile,
  rawSignals: CaseSignalsRaw,
  caseDetails: { artifacts: unknown[] } | null,
  enrichment: EnrichmentData,
): Promise<{ output: PlannerOutput; rawResponse: string; plannerRequest: Record<string, unknown>; systemPrompt: string }> {
  const prompt = await getPromptById(PROMPT_ID);
  if (!prompt) {
    throw new Error(`Prompt ${PROMPT_ID} not found`);
  }

  // Build text payload with three enrichment sections
  const signalsPayload: Record<string, unknown> = {
    dispute_profile: profile,
    raw_signals: {
      case_created_at: rawSignals.case_created_at,
      tx_count_90_days: rawSignals.tx_count_90_days,
      active_months: rawSignals.active_months,
      prior_payments_to_merchant: rawSignals.prior_payments_to_merchant,
      railsr_disputes_last_30_days: rawSignals.railsr_disputes_last_30_days,
    },
    case_details: caseDetails
      ? { artifacts: filterCaseArtifacts(caseDetails.artifacts) }
      : null,
  };

  // Section 1: Case actions
  if (enrichment.caseActions.length > 0) {
    signalsPayload.case_actions = enrichment.caseActions.map((a) => ({
      action_type: a.action_type,
      status: a.status,
      created_at: a.created_at,
      metadata: a.metadata,
    }));
  }

  // Section 2: Customer dialogue messages
  if (enrichment.customerDialogueMessages.length > 0) {
    signalsPayload.customer_dialogue_messages = enrichment.customerDialogueMessages.map((m) => ({
      role: m.role,
      content: m.content,
      created_at: m.created_at,
    }));
  }

  // Section 3: File artifact descriptions
  if (enrichment.parsedFileDescriptions.length > 0) {
    signalsPayload.artifact_descriptions = enrichment.parsedFileDescriptions;
  }

  const plannerMessages = [
    { role: 'system' as const, content: prompt.content },
    { role: 'user' as const, content: JSON.stringify(signalsPayload, null, 2) },
  ];
  // Log planner request with customer dialogue content redacted to avoid PII in logs
  const redactedPayload = { ...signalsPayload };
  if (redactedPayload.customer_dialogue_messages) {
    redactedPayload.customer_dialogue_messages = (redactedPayload.customer_dialogue_messages as unknown[]).map(() => '[REDACTED]');
  }
  console.log('[Planner] Full LLM request:', JSON.stringify({
    messages: [
      { role: 'system', content: `[system prompt, ${plannerMessages[0].content.length} chars]` },
      { role: 'user', content: JSON.stringify(redactedPayload, null, 2) },
    ],
    provider: 'ANTHROPIC',
    model: process.env.LLM_MODEL || 'claude-sonnet-4-5@20250929',
  }, null, 2));

  const response = await analyzeWithLLM(plannerMessages);

  const rawResponse = response.content;

  const parsed = parseJson(rawResponse);
  if (!parsed) {
    throw Object.assign(
      new Error(`Failed to parse JSON from LLM response`),
      { rawResponse },
    );
  }

  try {
    const validated = PlannerOutputSchema.parse(parsed);
    return { output: validated, rawResponse, plannerRequest: signalsPayload, systemPrompt: prompt.content };
  } catch (zodErr) {
    throw Object.assign(
      zodErr instanceof Error ? zodErr : new Error(String(zodErr)),
      { rawResponse },
    );
  }
}

// --- Pipeline orchestrator ---

export async function runDisputePipeline(caseId: number): Promise<PipelineRunRow> {
  const start = Date.now();

  // Layer 0: Fetch signals + case details + case actions in parallel
  const [rawSignals, caseDetails, caseActions] = await Promise.all([
    fetchCaseSignals(caseId),
    fetchCaseDetails(caseId).catch((err) => {
      console.warn(`Failed to fetch case details for ${caseId}:`, err.message);
      return null;
    }),
    fetchCaseActions(caseId),
  ]);

  // Build dispute profile
  const hardGates = deriveHardGates(rawSignals);
  const profile = buildDisputeProfile(rawSignals, hardGates);

  // Layer 1: Hard gates
  const triggeredGate = checkHardGates(hardGates);

  let plannerOutput: PlannerOutput | null = null;
  let plannerRawResponse: string | null = null;
  let plannerRequest: Record<string, unknown> | null = null;
  let plannerSystemPrompt: string | null = null;
  let fileParseResults: string[] | null = null;
  let dialogueMessages: DialogueMessage[] | null = null;
  let enrichmentMetadata: Record<string, unknown> | null = null;

  if (!triggeredGate) {
    // Collect FILE and DIALOGUE artifact IDs from case artifacts
    const allArtifacts = caseDetails ? (caseDetails.artifacts as unknown[]) : [];
    const fileArtifacts = allArtifacts.filter((a) => {
      if (typeof a === 'object' && a !== null && 'artifact_type' in a) {
        return (a as { artifact_type: string }).artifact_type?.toUpperCase() === 'FILE';
      }
      return false;
    });
    const dialogueArtifactIds = allArtifacts
      .filter((a) => {
        if (typeof a === 'object' && a !== null && 'artifact_type' in a) {
          return (a as { artifact_type: string }).artifact_type?.toUpperCase() === 'DIALOGUE';
        }
        return false;
      })
      .map((a) => {
        const art = a as { id?: number; artifact_id?: string };
        return art.artifact_id ?? String(art.id);
      });

    // Run dialogue and file enrichments in parallel
    const [dialoguesFetchResult, parsedFileDescriptions] = await Promise.all([
      fetchCaseDialogues(dialogueArtifactIds),
      fetchAndParseFileArtifacts(fileArtifacts),
    ]);
    const allCustomerMessages = filterCustomerMessages(dialoguesFetchResult.messages);
    // Sort by time so the most recent messages are at the end, then take last N
    allCustomerMessages.sort((a, b) => a.created_at.localeCompare(b.created_at));
    const customerDialogueMessages = allCustomerMessages.slice(-MAX_DIALOGUE_MESSAGES);

    console.log(`[Pipeline] Enrichment results — case_actions: ${caseActions.length}, dialogue_messages: ${dialoguesFetchResult.messages.length} (customer: ${allCustomerMessages.length}, sent to planner: ${customerDialogueMessages.length}), file_descriptions: ${parsedFileDescriptions.length}`);

    // Capture enrichment data for DB storage
    fileParseResults = parsedFileDescriptions.length > 0 ? parsedFileDescriptions : null;
    dialogueMessages = customerDialogueMessages.length > 0 ? customerDialogueMessages : null;
    enrichmentMetadata = {
      ...dialoguesFetchResult.metadata,
      total_messages_fetched: dialoguesFetchResult.messages.length,
      customer_messages_filtered: allCustomerMessages.length,
      customer_messages_sent_to_planner: customerDialogueMessages.length,
      file_artifacts_found: fileArtifacts.length,
      file_descriptions_parsed: parsedFileDescriptions.length,
    };

    // Layer 2: Planner
    try {
      const result = await callPlanner(
        profile,
        rawSignals,
        caseDetails ? { artifacts: caseDetails.artifacts as unknown[] } : null,
        { caseActions, customerDialogueMessages, parsedFileDescriptions },
      );
      plannerOutput = result.output;
      plannerRawResponse = result.rawResponse;
      plannerRequest = result.plannerRequest;
      plannerSystemPrompt = result.systemPrompt;
    } catch (err) {
      // Parse error fallback — escalate, don't throw
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`Planner error for case ${caseId}:`, errorMessage);
      // Capture raw LLM response even on parse/validation failure (log length only to avoid PII)
      if (err && typeof err === 'object' && 'rawResponse' in err) {
        const raw = (err as { rawResponse: string }).rawResponse;
        console.error(`Planner raw LLM response for case ${caseId}: [${raw.length} chars, not logged due to potential PII]`);
        plannerRawResponse = raw;
      }
      plannerOutput = {
        thought: `Planner error: ${errorMessage}`,
        decision: 'escalate_to_agent',
        credit_timing: 'none',
        uncertainty_factors: ['planner_parse_error'],
      };
    }
  }

  const duration = Date.now() - start;

  // Layer 4: Audit — save to DB
  const filteredDetails = caseDetails
    ? {
        id: caseDetails.id,
        ref_id: caseDetails.ref_id,
        alias: caseDetails.alias,
        issue_type_id: caseDetails.issue_type_id,
        artifacts: filterCaseArtifacts(caseDetails.artifacts as unknown[]),
      }
    : null;

  const row = await insertPipelineRun({
    case_id: caseId,
    raw_signals: rawSignals,
    case_details: filteredDetails,
    dispute_profile: profile,
    hard_gates: hardGates,
    hard_gate_triggered: triggeredGate,
    planner_output: plannerOutput,
    executor_action: 'shadow',
    pipeline_duration_ms: duration,
    prompt_version: PROMPT_ID,
    planner_raw_response: plannerRawResponse,
    case_actions: caseActions.length > 0 ? caseActions : null,
    planner_request: plannerRequest,
    planner_system_prompt: plannerSystemPrompt,
    file_parse_results: fileParseResults,
    dialogue_messages: dialogueMessages,
    enrichment_metadata: enrichmentMetadata,
  });

  return row;
}

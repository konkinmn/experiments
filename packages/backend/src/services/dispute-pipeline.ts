import { z } from 'zod';
import { fetchCaseSignals } from './signals-query.js';
import { fetchCaseDetails, fetchArtifactAsBase64 } from './case-api.js';
import { analyzeWithLLM } from './llm-api.js';
import type { ContentPart } from './llm-api.js';
import { getPromptById } from './prompts.js';
import { insertPipelineRun } from './db.js';
import type {
  CaseSignalsRaw,
  HardGateSignals,
  DisputeProfile,
  PlannerOutput,
  PipelineRunRow,
  RiskLevel,
} from '../types/dispute-pipeline.js';

const PROMPT_ID = 'dispute-planner-v1';

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
  else if (trust === 'BLUE') accountTrust += 4;

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
  if (amount < 5) transactionRisk += 20;
  else if (amount < 10) transactionRisk += 14;
  else if (amount < 15) transactionRisk += 9;
  else if (amount <= 25) transactionRisk += 5;

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
  if (raw.trust_score?.toUpperCase() === 'AMBER') riskFactors.push('Amber trust score');
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
  'DISPUTE_FORM',
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

const PlannerOutputSchema = z.object({
  thought: z.string(),
  decision: z.enum(['credit', 'escalate_to_agent']),
  credit_timing: z.enum(['immediately', 'none']),
  args: z.object({
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
  }).optional(),
  uncertainty_factors: z.array(z.string()),
});

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

async function callPlanner(
  profile: DisputeProfile,
  rawSignals: CaseSignalsRaw,
  caseDetails: { artifacts: unknown[] } | null,
): Promise<{ output: PlannerOutput; rawResponse: string }> {
  const prompt = await getPromptById(PROMPT_ID);
  if (!prompt) {
    throw new Error(`Prompt ${PROMPT_ID} not found`);
  }

  const filteredArtifacts = caseDetails ? filterCaseArtifacts(caseDetails.artifacts) : [];

  // Fetch artifact files in parallel
  const artifactResults = await Promise.allSettled(
    filteredArtifacts.map(async (a) => {
      const artifact = a as { id: number; artifact_id: string; artifact_type: string };
      const fileId = artifact.artifact_id ?? String(artifact.id);
      const file = await fetchArtifactAsBase64(fileId);
      return { artifact, file };
    }),
  );

  // Build multimodal content array
  const contentParts: ContentPart[] = [];

  for (const result of artifactResults) {
    if (result.status !== 'fulfilled' || !result.value.file) continue;
    const { artifact, file } = result.value;
    const type = artifact.artifact_type?.toUpperCase();

    if (type === 'DISPUTE_FORM') {
      contentParts.push({
        type: 'file',
        file: {
          filename: file.filename,
          file_data: `data:application/pdf;base64,${file.base64}`,
        },
      });
    } else if (type === 'FILE') {
      contentParts.push({
        type: 'image_url',
        image_url: {
          url: `data:${file.mimeType};base64,${file.base64}`,
        },
      });
    }
  }

  // Append text signals as the final content part
  contentParts.push({
    type: 'text',
    text: JSON.stringify({
      dispute_profile: profile,
      raw_signals: {
        case_created_at: rawSignals.case_created_at,
        tx_count_90_days: rawSignals.tx_count_90_days,
        active_months: rawSignals.active_months,
        prior_payments_to_merchant: rawSignals.prior_payments_to_merchant,
        railsr_disputes_last_30_days: rawSignals.railsr_disputes_last_30_days,
      },
      case_details: caseDetails
        ? {
            artifacts: filterCaseArtifacts(caseDetails.artifacts),
          }
        : null,
    }, null, 2),
  });

  // Use content array if we have file/image parts, plain string if text only
  const userContent: string | ContentPart[] = contentParts.length === 1
    ? (contentParts[0] as { type: 'text'; text: string }).text
    : contentParts;

  const response = await analyzeWithLLM([
    { role: 'system', content: prompt.content },
    { role: 'user', content: userContent },
  ]);

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
    return { output: validated, rawResponse };
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

  // Layer 0: Fetch signals + case details in parallel
  const [rawSignals, caseDetails] = await Promise.all([
    fetchCaseSignals(caseId),
    fetchCaseDetails(caseId).catch((err) => {
      console.warn(`Failed to fetch case details for ${caseId}:`, err.message);
      return null;
    }),
  ]);

  // Build dispute profile
  const hardGates = deriveHardGates(rawSignals);
  const profile = buildDisputeProfile(rawSignals, hardGates);

  // Layer 1: Hard gates
  const triggeredGate = checkHardGates(hardGates);

  let plannerOutput: PlannerOutput | null = null;
  let plannerRawResponse: string | null = null;

  if (!triggeredGate) {
    // Layer 2: Planner
    try {
      const result = await callPlanner(
        profile,
        rawSignals,
        caseDetails ? { artifacts: caseDetails.artifacts as unknown[] } : null,
      );
      plannerOutput = result.output;
      plannerRawResponse = result.rawResponse;
    } catch (err) {
      // Parse error fallback — escalate, don't throw
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`Planner error for case ${caseId}:`, errorMessage);
      // Capture raw LLM response even on parse/validation failure
      if (err && typeof err === 'object' && 'rawResponse' in err) {
        plannerRawResponse = (err as { rawResponse: string }).rawResponse;
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
  });

  return row;
}

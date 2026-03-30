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
  CaseContext,
  DialogueMessage,
  HardGateSignals,
  HardGateConfig,
  DisputeProfile,
  PlannerOutput,
  PipelineRunRow,
  PipelineConfig,
  RiskLevel,
  RubricWeights,
  RubricScoringRules,
  RunConfig,
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

export const DEFAULT_RUBRIC_WEIGHTS: RubricWeights = {
  account_trust_max: 58,
  dispute_history_max: 30,
  transaction_risk_max: 20,
  green_threshold: 70,
  amber_threshold: 40,
};

export const DEFAULT_HARD_GATE_CONFIG: HardGateConfig = {
  cifas: true,
  confirmed_scammer: true,
  account_not_active: true,
  railsr_dispute_last_6_months: true,
};

export const DEFAULT_SCORING_RULES: RubricScoringRules = {
  account_age: [
    { min_days: 365, points: 20 },
    { min_days: 180, points: 12 },
    { min_days: 90, points: 5 },
  ],
  tier: { E: 10, D: 8, C: 5 },
  money_maker_points: 15,
  trust_score: { GREEN: 8, AMBER: 4 },
  tx_activity: { min_count: 5, points: 5 },
  dispute_history: [
    { max_disputes: 0, points: 30 },
    { max_disputes: 2, points: 15 },
    { max_disputes: 4, points: 5 },
  ],
  recent_dispute_penalty: -5,
  scam_victim_penalty: -5,
  amount_brackets: [
    { max_amount: 5, points: 20 },
    { max_amount: 10, points: 14 },
    { max_amount: 15, points: 9 },
    { max_amount: 25, points: 5 },
  ],
};

export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  hard_gates: DEFAULT_HARD_GATE_CONFIG,
  rubric_weights: DEFAULT_RUBRIC_WEIGHTS,
  scoring_rules: DEFAULT_SCORING_RULES,
};

interface RubricScoreResult {
  total: number;
  account_trust: number;
  dispute_history: number;
  transaction_risk: number;
}

function computeRubricScore(raw: CaseSignalsRaw, weights?: RubricWeights, rules?: RubricScoringRules): RubricScoreResult {
  const w = weights ?? DEFAULT_RUBRIC_WEIGHTS;
  const r = rules ?? DEFAULT_SCORING_RULES;

  // Category 1 — Account Trust
  let accountTrust = 0;

  // Account age (sorted desc by min_days)
  const ageBracket = [...r.account_age].sort((a, b) => b.min_days - a.min_days).find((b) => raw.account_age_days >= b.min_days);
  if (ageBracket) accountTrust += ageBracket.points;

  // Tier
  const tier = raw.tier_name?.toUpperCase();
  if (tier && r.tier[tier]) accountTrust += r.tier[tier];

  // Money maker
  if (raw.is_money_maker) accountTrust += r.money_maker_points;

  // Trust score
  const trust = raw.trust_score?.toUpperCase();
  if (trust && r.trust_score[trust]) accountTrust += r.trust_score[trust];

  // Transaction activity
  if (raw.tx_count_90_days >= r.tx_activity.min_count) accountTrust += r.tx_activity.points;
  accountTrust = Math.min(accountTrust, w.account_trust_max);

  // Category 2 — Dispute History
  let disputeHistory = 0;

  // Dispute count brackets (sorted asc by max_disputes)
  const histBracket = [...r.dispute_history].sort((a, b) => a.max_disputes - b.max_disputes).find((b) => raw.railsr_disputes_last_6_months <= b.max_disputes);
  if (histBracket) disputeHistory += histBracket.points;

  if (raw.railsr_disputes_last_30_days > 0) disputeHistory += r.recent_dispute_penalty;
  if (raw.scam_victim_count > 0) disputeHistory += r.scam_victim_penalty;
  disputeHistory = Math.max(disputeHistory, 0);
  disputeHistory = Math.min(disputeHistory, w.dispute_history_max);

  // Category 3 — Transaction Risk
  let transactionRisk = 0;
  const amount = Number(raw.max_transaction_amount);
  if (!isNaN(amount)) {
    // Amount brackets (sorted asc by max_amount)
    const amtBracket = [...r.amount_brackets].sort((a, b) => a.max_amount - b.max_amount).find((b) => amount < b.max_amount || (amount === b.max_amount && b === r.amount_brackets[r.amount_brackets.length - 1]));
    if (amtBracket) transactionRisk += amtBracket.points;
  }
  transactionRisk = Math.min(transactionRisk, w.transaction_risk_max);

  return {
    total: accountTrust + disputeHistory + transactionRisk,
    account_trust: accountTrust,
    dispute_history: disputeHistory,
    transaction_risk: transactionRisk,
  };
}

function deriveRiskLevel(hardGates: HardGateSignals, rubricScore: number, weights?: RubricWeights): RiskLevel {
  if (Object.values(hardGates).some(Boolean)) return 'red';
  const greenThreshold = weights?.green_threshold ?? DEFAULT_RUBRIC_WEIGHTS.green_threshold;
  const amberThreshold = weights?.amber_threshold ?? DEFAULT_RUBRIC_WEIGHTS.amber_threshold;
  if (rubricScore >= greenThreshold) return 'green';
  if (rubricScore >= amberThreshold) return 'amber';
  return 'red';
}

function buildDisputeProfile(raw: CaseSignalsRaw, hardGates: HardGateSignals, config?: PipelineConfig): DisputeProfile {
  const rubric = computeRubricScore(raw, config?.rubric_weights, config?.scoring_rules);
  const riskLevel = deriveRiskLevel(hardGates, rubric.total, config?.rubric_weights);

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

function checkHardGates(gates: HardGateSignals, gateConfig?: HardGateConfig): string | null {
  const cfg = gateConfig ?? DEFAULT_HARD_GATE_CONFIG;
  if (cfg.cifas && gates.cifas) return 'cifas';
  if (cfg.confirmed_scammer && gates.confirmed_scammer) return 'confirmed_scammer';
  if (cfg.account_not_active && gates.account_not_active) return 'account_not_active';
  if (cfg.railsr_dispute_last_6_months && gates.railsr_dispute_last_6_months) return 'railsr_dispute_last_6_months';
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
    args: PlannerArgsSchema,
    uncertainty_factors: z.array(z.string()),
  }),
  z.object({
    thought: z.string(),
    decision: z.literal('escalate_to_agent'),
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
  caseDetails: Record<string, unknown> | null,
  enrichment: EnrichmentData,
  options?: { model?: string; promptVersion?: string; promptContent?: string },
): Promise<{ output: PlannerOutput; rawResponse: string; plannerRequest: Record<string, unknown>; systemPrompt: string }> {
  let promptText: string;
  if (options?.promptContent) {
    promptText = options.promptContent;
  } else {
    const promptId = options?.promptVersion || PROMPT_ID;
    const prompt = await getPromptById(promptId);
    if (!prompt) {
      throw new Error(`Prompt ${promptId} not found`);
    }
    promptText = prompt.content;
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
      ? {
          issue_type_id: (caseDetails as { issue_type_id?: string }).issue_type_id ?? null,
          created_at: (caseDetails as { created_at?: string }).created_at ?? null,
        }
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
    { role: 'system' as const, content: promptText },
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
    model: options?.model || process.env.LLM_MODEL || 'claude-sonnet-4-5@20250929',
  }, null, 2));

  const response = await analyzeWithLLM(plannerMessages, { model: options?.model });

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
    return { output: validated, rawResponse, plannerRequest: signalsPayload, systemPrompt: promptText };
  } catch (zodErr) {
    throw Object.assign(
      zodErr instanceof Error ? zodErr : new Error(String(zodErr)),
      { rawResponse },
    );
  }
}

// --- Context fetcher (dataset creation — no LLM planner) ---

export async function fetchCaseContext(caseId: number): Promise<CaseContext> {
  // Fetch signals + case details + case actions in parallel
  const [rawSignals, caseDetails, caseActions] = await Promise.all([
    fetchCaseSignals(caseId),
    fetchCaseDetails(caseId).catch((err) => {
      console.warn(`Failed to fetch case details for ${caseId}:`, err.message);
      return null;
    }),
    fetchCaseActions(caseId),
  ]);

  // Extract FILE and DIALOGUE artifacts from case details
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

  // Fetch dialogue + parse files in parallel
  const [dialoguesFetchResult, parsedFileDescriptions] = await Promise.all([
    fetchCaseDialogues(dialogueArtifactIds),
    fetchAndParseFileArtifacts(fileArtifacts),
  ]);

  const allCustomerMessages = filterCustomerMessages(dialoguesFetchResult.messages);
  allCustomerMessages.sort((a, b) => a.created_at.localeCompare(b.created_at));
  const customerDialogueMessages = allCustomerMessages.slice(-MAX_DIALOGUE_MESSAGES);

  const filteredDetails = caseDetails
    ? {
        id: caseDetails.id,
        ref_id: caseDetails.ref_id,
        alias: caseDetails.alias,
        issue_type_id: caseDetails.issue_type_id,
        artifacts: filterCaseArtifacts(caseDetails.artifacts as unknown[]),
      }
    : null;

  return {
    raw_signals: rawSignals,
    case_details: filteredDetails,
    case_actions: caseActions.length > 0 ? caseActions : null,
    dialogue_messages: customerDialogueMessages.length > 0 ? customerDialogueMessages : null,
    file_parse_results: parsedFileDescriptions.length > 0 ? parsedFileDescriptions : null,
    enrichment_metadata: {
      ...dialoguesFetchResult.metadata,
      total_messages_fetched: dialoguesFetchResult.messages.length,
      customer_messages_filtered: allCustomerMessages.length,
      customer_messages_sent_to_planner: customerDialogueMessages.length,
      file_artifacts_found: fileArtifacts.length,
      file_descriptions_parsed: parsedFileDescriptions.length,
    },
  };
}

// --- Pipeline orchestrator ---

export async function runDisputePipeline(
  caseId: number,
  runConfig?: RunConfig,
  cachedContext?: CaseContext,
): Promise<PipelineRunRow> {
  const start = Date.now();

  // Layer 0: Use cached context or fetch fresh
  let rawSignals: CaseSignalsRaw;
  let caseDetails: unknown | null;
  let caseActions: CaseAction[];

  if (cachedContext) {
    rawSignals = cachedContext.raw_signals;
    caseDetails = cachedContext.case_details;
    caseActions = cachedContext.case_actions ?? [];
  } else {
    [rawSignals, caseDetails, caseActions] = await Promise.all([
      fetchCaseSignals(caseId),
      fetchCaseDetails(caseId).catch((err) => {
        console.warn(`Failed to fetch case details for ${caseId}:`, err.message);
        return null;
      }),
      fetchCaseActions(caseId),
    ]);
  }

  // Build dispute profile (use pipeline config from run config if provided)
  const pipelineConfig = runConfig?.pipeline_config;
  const hardGates = deriveHardGates(rawSignals);
  const profile = buildDisputeProfile(rawSignals, hardGates, pipelineConfig);

  // Layer 1: Hard gates (respects gate toggles from config)
  const triggeredGate = checkHardGates(hardGates, pipelineConfig?.hard_gates);

  let plannerOutput: PlannerOutput | null = null;
  let plannerRawResponse: string | null = null;
  let plannerRequest: Record<string, unknown> | null = null;
  let plannerSystemPrompt: string | null = null;
  let fileParseResults: string[] | null = cachedContext?.file_parse_results ?? null;
  let dialogueMessages: DialogueMessage[] | null = cachedContext?.dialogue_messages ?? null;
  let enrichmentMetadata: Record<string, unknown> | null = cachedContext?.enrichment_metadata ?? null;

  if (!triggeredGate) {
    // If we have cached context, reuse enrichment data; otherwise fetch fresh
    let customerDialogueMessages: DialogueMessage[] = cachedContext?.dialogue_messages ?? [];
    let parsedFileDescriptions: string[] = cachedContext?.file_parse_results ?? [];

    if (!cachedContext) {
      // Collect FILE and DIALOGUE artifact IDs from case artifacts
      const allArtifacts = caseDetails ? ((caseDetails as { artifacts: unknown[] }).artifacts as unknown[]) : [];
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
      const [dialoguesFetchResult, parsedFiles] = await Promise.all([
        fetchCaseDialogues(dialogueArtifactIds),
        fetchAndParseFileArtifacts(fileArtifacts),
      ]);
      const allCustomerMessages = filterCustomerMessages(dialoguesFetchResult.messages);
      allCustomerMessages.sort((a, b) => a.created_at.localeCompare(b.created_at));
      customerDialogueMessages = allCustomerMessages.slice(-MAX_DIALOGUE_MESSAGES);
      parsedFileDescriptions = parsedFiles;

      console.log(`[Pipeline] Enrichment results — case_actions: ${caseActions.length}, dialogue_messages: ${dialoguesFetchResult.messages.length} (customer: ${allCustomerMessages.length}, sent to planner: ${customerDialogueMessages.length}), file_descriptions: ${parsedFileDescriptions.length}`);

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
    }

    // Layer 2: Planner
    const detailsForPlanner = caseDetails && typeof caseDetails === 'object'
      ? {
          issue_type_id: (caseDetails as Record<string, unknown>).issue_type_id ?? null,
          created_at: (caseDetails as Record<string, unknown>).created_at ?? null,
        }
      : null;
    try {
      const result = await callPlanner(
        profile,
        rawSignals,
        detailsForPlanner,
        { caseActions, customerDialogueMessages, parsedFileDescriptions },
        runConfig ? { model: runConfig.model, promptVersion: runConfig.prompt_version, promptContent: runConfig.prompt_content } : undefined,
      );
      plannerOutput = result.output;
      plannerRawResponse = result.rawResponse;
      plannerRequest = result.plannerRequest;
      plannerSystemPrompt = result.systemPrompt;
    } catch (err) {
      // Parse error fallback — escalate, don't throw
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`Planner error for case ${caseId}:`, errorMessage);
      if (err && typeof err === 'object' && 'rawResponse' in err) {
        const raw = (err as { rawResponse: string }).rawResponse;
        console.error(`Planner raw LLM response for case ${caseId}: [${raw.length} chars, not logged due to potential PII]`);
        plannerRawResponse = raw;
      }
      plannerOutput = {
        thought: `Planner error: ${errorMessage}`,
        decision: 'escalate_to_agent',
        uncertainty_factors: ['planner_parse_error'],
      };
    }
  }

  const duration = Date.now() - start;

  // Layer 4: Audit — save to DB
  const filteredDetails = cachedContext
    ? caseDetails
    : caseDetails
      ? {
          id: (caseDetails as { id: unknown }).id,
          ref_id: (caseDetails as { ref_id: unknown }).ref_id,
          alias: (caseDetails as { alias: unknown }).alias,
          issue_type_id: (caseDetails as { issue_type_id: unknown }).issue_type_id,
          artifacts: filterCaseArtifacts((caseDetails as { artifacts: unknown[] }).artifacts),
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
    prompt_version: runConfig?.prompt_version || PROMPT_ID,
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

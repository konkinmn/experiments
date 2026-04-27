import { fetchCaseSignals } from './signals-query.js';
import { fetchCaseDetails, fetchArtifactAsBase64, fetchCaseActions, fetchCaseDialogues } from './case-api.js';
import { parseFileWithLLM } from './llm-api.js';
import type { ContentPart } from './llm-api.js';
import { insertPipelineRun } from './db.js';
import { runAssessmentForCase } from './anna-case-bridge.js';
import type {
  CaseSignalsRaw,
  CaseAction,
  CaseContext,
  DialogueMessage,
  PipelineRunRow,
  RunConfig,
} from '../types/dispute-pipeline.js';

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

const ALLOWED_ARTIFACT_TYPES = new Set(['FILE']);

function filterCaseArtifacts(artifacts: unknown[]): unknown[] {
  return artifacts.filter((a) => {
    if (typeof a === 'object' && a !== null && 'artifact_type' in a) {
      const type = (a as { artifact_type: string }).artifact_type?.toUpperCase();
      return ALLOWED_ARTIFACT_TYPES.has(type);
    }
    return false;
  });
}

function filterCustomerMessages(messages: DialogueMessage[]): DialogueMessage[] {
  return messages.filter((m) => m.role.toLowerCase() === 'client');
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
  console.log(`[Context] ${fileParts.length} file(s) to parse with Gemini`);
  const parsedDescriptions: string[] = [];
  if (fileParts.length > 0) {
    const parseResults = await Promise.allSettled(
      fileParts.map(part => parseFileWithLLM(FILE_PARSER_SYSTEM_PROMPT, FILE_PARSER_USER_PROMPT, part)),
    );
    for (const result of parseResults) {
      if (result.status === 'fulfilled') {
        parsedDescriptions.push(result.value);
      } else {
        console.warn('[Context] File parse failed:', result.reason);
        parsedDescriptions.push('[File could not be parsed]');
      }
    }
    console.log(`[Context] Parsed ${parsedDescriptions.length} file description(s): [${parsedDescriptions.map(d => `${d.length} chars`).join(', ')}]`);
  }

  return parsedDescriptions;
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
    .sort((a, b) => {
      const aDate = (a as { created_at?: string }).created_at ?? '';
      const bDate = (b as { created_at?: string }).created_at ?? '';
      return aDate.localeCompare(bDate);
    })
    .map((a) => {
      const art = a as { id?: number; artifact_id?: string };
      return art.artifact_id ?? String(art.id);
    })
    .slice(0, 3); // First 3 dialogues by date — contains initial claim and key context

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

export async function runDisputePipeline(
  caseId: number,
  runConfig?: RunConfig,
  cachedContext?: CaseContext,
): Promise<PipelineRunRow> {
  const context: CaseContext = cachedContext ?? (await fetchCaseContext(caseId));
  const rawSignals: CaseSignalsRaw = context.raw_signals;
  const caseDetails: unknown | null = context.case_details;
  const caseActions: CaseAction[] = context.case_actions ?? [];
  const fileParseResults: string[] | null = context.file_parse_results;
  const dialogueMessages: DialogueMessage[] | null = context.dialogue_messages;
  const enrichmentMetadata: Record<string, unknown> | null = context.enrichment_metadata;

  const bridgeResult = await runAssessmentForCase(caseId, context);
  const assessment = bridgeResult.assessment;
  const triggeredGate = assessment?.hard_gates?.triggered_gate ?? null;

  // Audit — save to DB
  const filteredDetails = caseDetails
    ? cachedContext
      ? caseDetails
      : {
          id: (caseDetails as { id: unknown }).id,
          ref_id: (caseDetails as { ref_id: unknown }).ref_id,
          alias: (caseDetails as { alias: unknown }).alias,
          issue_type_id: (caseDetails as { issue_type_id: unknown }).issue_type_id,
          artifacts: filterCaseArtifacts((caseDetails as { artifacts: unknown[] }).artifacts ?? []),
        }
    : null;

  const row = await insertPipelineRun({
    case_id: caseId,
    engine: 'anna-case',
    raw_signals: rawSignals,
    case_details: filteredDetails,
    dispute_profile: assessment?.risk_scoring ?? null,
    hard_gates: assessment?.hard_gates ?? null,
    hard_gate_triggered: triggeredGate,
    planner_output: assessment?.planner_output ?? null,
    executor_action: 'shadow',
    pipeline_duration_ms: bridgeResult.durationMs,
    prompt_version: assessment?.prompt_version ?? runConfig?.prompt_version ?? null,
    prompt_md5: bridgeResult.promptMd5,
    planner_raw_response: bridgeResult.error
      ? JSON.stringify({ error: bridgeResult.error })
      : assessment
        ? JSON.stringify(assessment)
        : null,
    case_actions: caseActions.length > 0 ? caseActions : null,
    planner_request: null,
    planner_system_prompt: bridgeResult.promptContent,
    file_parse_results: fileParseResults,
    dialogue_messages: dialogueMessages,
    enrichment_metadata: enrichmentMetadata,
  });

  return row;
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type {
  CaseContext,
  CaseAction,
  CaseSignalsRaw,
  DialogueMessage,
  DisputeProfile,
  FileParseResult,
  HardGateResult,
  PlannerOutput,
} from '../types/dispute-pipeline.js';

const execFileAsync = promisify(execFile);

const TIER_LETTER_TO_ANNA_CASE: Record<string, string> = {
  A: 'ANF-VL-005',
  B: 'ANF-VL-004',
  C: 'ANF-VL-003',
  D: 'ANF-VL-002',
  E: 'ANF-VL-001',
  F: 'ANF-VL-000',
};

function defaultAnnaCasePath(): string {
  return process.env.ANNA_CASE_PATH || join(homedir(), 'WebstormProjects/anna/anna-case');
}

// BigQuery returns timestamp columns as { value: '<iso>' }. anna-case expects plain ISO strings.
function bqIsoString(val: unknown): string | null {
  if (val == null) return null;
  if (typeof val === 'string') return val;
  if (typeof val === 'object' && val !== null && 'value' in val) {
    const inner = (val as { value: unknown }).value;
    return typeof inner === 'string' ? inner : null;
  }
  return null;
}

export interface BridgeRunConfig {
  annaCaseRepoPath: string;
  llmProxyUrl?: string;
  timeoutMs: number;
}

export interface AnnaCaseAssessment {
  version: string;
  signals: unknown | null;
  risk_scoring: DisputeProfile | null;
  hard_gates: HardGateResult | null;
  enrichment: unknown | null;
  planner_input: unknown | null;
  planner_output: PlannerOutput | null;
  llm_model: string | null;
  prompt_version: string | null;
}

interface AnnaCaseScenarioResult {
  scenario: { name: string; expected_decision: string | null };
  decision: string;
  risk_level: string | null;
  risk_score: number | null;
  error: string | null;
  assessment_data: AnnaCaseAssessment;
}

interface AnnaCaseOutputWrapper {
  dataset: string;
  results: AnnaCaseScenarioResult[];
}

export interface BridgeRunResult {
  ok: boolean;
  assessment: AnnaCaseAssessment | null;
  decision: string | null;
  riskLevel: string | null;
  riskScore: number | null;
  error: string | null;
  promptContent: string | null;
  promptMd5: string | null;
  durationMs: number;
}

// total_disputes uses railsr_disputes_last_6_months as a proxy — this repo doesn't track lifetime disputes.
export function projectScenarioSignals(
  raw: CaseSignalsRaw,
  caseActions: CaseAction[],
): Record<string, unknown> {
  const tierLetter = raw.tier_name?.toUpperCase();
  const annaCaseTier = tierLetter ? (TIER_LETTER_TO_ANNA_CASE[tierLetter] ?? null) : null;

  const caseCreatedAtIso = bqIsoString(raw.case_created_at);
  let accountCreatedAt: string | null = null;
  if (raw.account_age_days != null && caseCreatedAtIso) {
    const caseEpoch = Date.parse(caseCreatedAtIso);
    if (!Number.isNaN(caseEpoch)) {
      const accountEpoch = caseEpoch - raw.account_age_days * 24 * 60 * 60 * 1000;
      accountCreatedAt = new Date(accountEpoch).toISOString();
    }
  }

  const crimeReferencePresent = caseActions.some(
    (a) =>
      a.action_type === 'DISPUTE_FORM_FILLED' &&
      typeof a.metadata?.crime_ref_number === 'string' &&
      a.metadata.crime_ref_number.length > 0,
  );

  return {
    account_status: raw.account_status ?? null,
    account_created_at: accountCreatedAt,
    cifas_has_matches: raw.cifas_count != null ? raw.cifas_count > 0 : null,
    scammer_count: raw.scammer_count ?? null,
    trust_score: raw.trust_score ? raw.trust_score.toUpperCase() : null,
    money_maker_badge: raw.is_money_maker ?? null,
    tier: annaCaseTier,
    tx_count_90_days: raw.tx_count_90_days ?? null,
    active_months: raw.active_months ?? null,
    prior_payments_to_merchant: raw.prior_payments_to_merchant ?? null,
    total_disputes: raw.railsr_disputes_last_6_months ?? null,
    disputes_last_30_days: raw.railsr_disputes_last_30_days ?? null,
    scam_victim_count: raw.scam_victim_count ?? null,
    railsr_disputes_last_6_months: raw.railsr_disputes_last_6_months ?? null,
    max_transaction_amount:
      raw.max_transaction_amount != null ? String(raw.max_transaction_amount) : null,
    disputed_currency: 'GBP',
    crime_reference_present: crimeReferencePresent,
    // Customer-authentication signal (derived in CASE_SIGNALS_QUERY from
    // export.balance_virtual_transaction). Field names match anna-case RiskSignals so the
    // CLI validates them straight in; omitting them would fall to the RiskSignals default (None).
    is_authenticated: raw.is_authenticated ?? null,
    auth_method: raw.auth_method ?? null,
    card_present: raw.card_present ?? null,
    fetch_failures: [],
  };
}

function projectEnrichment(
  caseActions: CaseAction[] | null,
  dialogueMessages: DialogueMessage[] | null,
  parsedDocuments: FileParseResult[] | null,
): Record<string, unknown> {
  const actions = (caseActions ?? []).map((a) => ({
    action_type: a.action_type,
    status: a.status,
    created_at: bqIsoString(a.created_at) ?? '',
  }));
  const messages = (dialogueMessages ?? []).map((m) => ({
    message: m.content,
    created_at: Date.parse(bqIsoString(m.created_at) ?? '') / 1000 || 0,
  }));
  return {
    case_actions: actions,
    customer_dialogue_messages: messages,
    // anna-case EnrichmentData.parsed_documents expects DocumentLabel objects
    // ({ description, evidence_item, ... }). Passing evidence_item is what lets
    // anna-case's build_evidence_check see which Required items are already attached
    // instead of marking every item MISSING and reflexively requesting evidence.
    parsed_documents: (parsedDocuments ?? []).map((d) => ({
      description: d.description,
      evidence_item: d.evidence_item,
    })),
    case_actions_count: actions.length,
    customer_messages_count: messages.length,
    files_parsed: parsedDocuments?.length ?? 0,
  };
}

function projectCaseDetails(
  caseId: number,
  details: unknown | null,
  raw: CaseSignalsRaw,
): Record<string, unknown> {
  const obj = (details && typeof details === 'object' ? (details as Record<string, unknown>) : {});
  const issueTypeId = typeof obj.issue_type_id === 'string' ? obj.issue_type_id : 'dispute';
  const createdAt = bqIsoString(obj.created_at) ?? bqIsoString(raw.case_created_at) ?? '';
  return {
    case_id: caseId,
    issue_type_id: issueTypeId,
    created_at: createdAt,
  };
}

let promptCache: { path: string; mtimeMs: number; content: string; md5: string } | null = null;

export async function loadAnnaCasePrompt(
  annaCaseRepoPath: string = defaultAnnaCasePath(),
): Promise<{ content: string; md5: string }> {
  return loadPrompt(annaCaseRepoPath);
}

async function loadPrompt(annaCaseRepoPath: string): Promise<{ content: string; md5: string }> {
  const promptPath = join(annaCaseRepoPath, 'anna_case/dispute_pipeline/prompts.py');
  const stats = await stat(promptPath);
  if (
    promptCache &&
    promptCache.path === promptPath &&
    promptCache.mtimeMs === stats.mtimeMs
  ) {
    return { content: promptCache.content, md5: promptCache.md5 };
  }
  const content = await readFile(promptPath, 'utf-8');
  const md5 = createHash('md5').update(content).digest('hex');
  promptCache = { path: promptPath, mtimeMs: stats.mtimeMs, content, md5 };
  return { content, md5 };
}

export async function runAssessmentForCase(
  caseId: number,
  context: CaseContext,
  config: Partial<BridgeRunConfig> = {},
): Promise<BridgeRunResult> {
  const start = Date.now();
  const annaCaseRepoPath = config.annaCaseRepoPath ?? defaultAnnaCasePath();
  const timeoutMs = config.timeoutMs ?? 120_000;
  const llmProxyUrl = config.llmProxyUrl ?? process.env.ANNA_LLM_PROXY_URL;

  const scenario = {
    name: `case-${caseId}`,
    case_details: projectCaseDetails(caseId, context.case_details, context.raw_signals),
    signals: projectScenarioSignals(context.raw_signals, context.case_actions ?? []),
    enrichment: projectEnrichment(
      context.case_actions,
      context.dialogue_messages,
      context.file_parse_results,
    ),
  };

  const tempDir = await mkdtemp(join(tmpdir(), 'anna-case-bridge-'));
  const inputPath = join(tempDir, 'input.json');
  const outputPath = join(tempDir, 'output.json');

  let promptContent: string | null = null;
  let promptMd5: string | null = null;

  try {
    const [, prompt] = await Promise.all([
      writeFile(inputPath, JSON.stringify({ scenarios: [scenario] })),
      loadPrompt(annaCaseRepoPath).catch(() => ({ content: '', md5: '' })),
    ]);
    if (prompt.md5) {
      promptContent = prompt.content;
      promptMd5 = prompt.md5;
    }

    const env = { ...process.env };
    if (llmProxyUrl) env.ANNA_LLM_PROXY_URL = llmProxyUrl;

    // requires `uv sync` in anna-case once; --no-sync runs offline against the existing venv.
    let stdout = '';
    let stderr = '';
    try {
      const result = await execFileAsync(
        'uv',
        [
          'run',
          '--no-sync',
          'anna-case',
          'run-dispute-assessment',
          '--dataset',
          inputPath,
          '--output',
          outputPath,
        ],
        {
          cwd: annaCaseRepoPath,
          env,
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      stdout = result.stdout?.toString() ?? '';
      stderr = result.stderr?.toString() ?? '';
    } catch (err) {
      const e = err as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
      stdout = e.stdout?.toString() ?? '';
      stderr = e.stderr?.toString() ?? '';
      throw new Error(
        `anna-case CLI failed: ${e.message ?? 'unknown error'}\n--- stderr ---\n${stderr}\n--- stdout ---\n${stdout}`,
      );
    }

    let outputText: string;
    try {
      outputText = await readFile(outputPath, 'utf-8');
    } catch {
      throw new Error(
        `anna-case CLI exited 0 but did not write ${outputPath}\n--- stderr ---\n${stderr}\n--- stdout ---\n${stdout}`,
      );
    }
    const wrapper = JSON.parse(outputText) as AnnaCaseOutputWrapper;
    const result = wrapper.results?.[0];
    if (!result) {
      throw new Error('anna-case CLI returned no results');
    }

    return {
      ok: result.error == null,
      assessment: result.assessment_data,
      decision: result.decision ?? null,
      riskLevel: result.risk_level,
      riskScore: result.risk_score,
      error: result.error,
      promptContent,
      promptMd5,
      durationMs: Date.now() - start,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

import { parseLlmJson } from '../../utils/llm-json.js';

import {
  analyzeWithLLMUsage,
  analyzeWithLLMUsageStream,
  type LLMUsage,
  type Message,
} from '../llm-api.js';
import type { ThreadBundle } from './bundle.js';
import {
  PROBLEM_CLASSIFIER_MODELS,
  PROBLEM_CLASSIFIER_TRANSPORT,
  modelForStage,
  type ProblemClassifierStage,
} from './config.js';
import { PaymentExtractionSchema, parseAmountValue, type PaymentExtraction } from './extraction.js';
import { PcError, type PlanRow } from './pipeline-types.js';

/**
 * Payment problem classifier — M3: the plumbing every pass shares.
 *
 * Paths, the snapshot/bundle readers, the plan-and-gate that stands between a script
 * and the proxy, the one call wrapper that logs usage, and the pass-2 label guard.
 *
 * Three rules from earlier runs live here rather than in the scripts, so no script can
 * quietly break them:
 *  - nothing reaches the proxy without `--go`: `planAndGate` prints and returns false;
 *  - every call is accounted for: `callWithUsage` appends a line per attempt to
 *    `<run>/llm-calls.ndjson`, failures included;
 *  - no intermediate aggregate leaves a pass: this file prints plans and nothing else.
 *    Counts, shares and category tables are `pc-report.ts`'s job, over a completed pass.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

/** `packages/backend/data/problem-classifier` from either `src/` or `dist/`. */
export const PC_DATA_ROOT = resolve(__dirname, '../../../data/problem-classifier');

export const NAME_RE = /^[A-Za-z0-9._-]+$/;

/** A plan-time guess only; the measured ratio comes from `pc-measure-tokens.ts --go`. */
export const CHARS_PER_TOKEN_ESTIMATE = 4;

/**
 * List price in USD per 1M *input* tokens, for the plan's estimate only — the same
 * assumption `pc-measure-tokens.ts` states. Output tokens are shown in the plan but
 * not priced: no output rate is asserted here. The billed number is the proxy's
 * `usage.total_cost_usd`, which `pc-report.ts` totals.
 */
const LIST_PRICE_USD_PER_MTOK: Record<string, number> = {
  'claude-haiku-4-5': 1,
  'claude-opus-4-8': 5,
};

/* ------------------------------------------------------------- script helpers */

export function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

export function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) fail(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

export function stringFlag(args: Record<string, string | true>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (value === true) fail(`--${name} requires a value`);
  return value;
}

export function allowFlags(args: Record<string, string | true>, allowed: string[]): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) fail(`unknown flag: --${key}`);
  }
}

export function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function pct(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

export function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}

/* ------------------------------------------------------- deterministic sampling */

/**
 * mulberry32 — small deterministic PRNG so a shuffle is reproducible from its seed.
 *
 * Shared rather than local because two draws have to be reproducible from the same
 * snapshot seed: the population shuffle `createSnapshot` writes, and pass 3's induce
 * sample. A second implementation would silently make them two different draws.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffleInPlace<T>(items: T[], rand: () => number): void {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}

/* ---------------------------------------------------------------------- paths */

export interface RunPathsResult {
  snapshot: string;
  runLabel: string;
  snapshotDir: string;
  bundlesDir: string;
  populationPath: string;
  runDir: string;
  pass1Dir: string;
  pass2Dir: string;
  pass3Dir: string;
  /** One NDJSON line per LLM attempt, every pass of this run appending to the same file. */
  callsPath: string;
}

export interface RunPathsOptions {
  /** `false` leaves the directories alone — for a caller that only needs the paths. */
  create?: boolean;
}

/**
 * `data/problem-classifier/<snapshot>/runs/<runLabel>/{pass1,pass2,pass3}/`, created if
 * absent. Creating them in plan-only mode is deliberate: an empty run directory costs
 * nothing and every pass then reads and writes the same place whether or not it spends.
 */
export function RunPaths(
  snapshot: string,
  runLabel: string,
  options: RunPathsOptions = {},
): RunPathsResult {
  if (!NAME_RE.test(snapshot)) throw new PcError('snapshot name may only contain [A-Za-z0-9._-]');
  if (!NAME_RE.test(runLabel)) throw new PcError('run label may only contain [A-Za-z0-9._-]');
  const snapshotDir = resolve(PC_DATA_ROOT, snapshot);
  const runDir = resolve(snapshotDir, 'runs', runLabel);
  const paths: RunPathsResult = {
    snapshot,
    runLabel,
    snapshotDir,
    bundlesDir: resolve(snapshotDir, 'bundles'),
    populationPath: resolve(snapshotDir, 'population.json'),
    runDir,
    pass1Dir: resolve(runDir, 'pass1'),
    pass2Dir: resolve(runDir, 'pass2'),
    pass3Dir: resolve(runDir, 'pass3'),
    callsPath: resolve(runDir, 'llm-calls.ndjson'),
  };
  if (options.create !== false) {
    for (const dir of [paths.pass1Dir, paths.pass2Dir, paths.pass3Dir]) {
      mkdirSync(dir, { recursive: true });
    }
  }
  return paths;
}

/* ------------------------------------------------------------ snapshot access */

export interface SnapshotThread {
  thread_id: string;
  path_key: string;
  customer_alias: string;
  first_dialogue_at: string;
}

/**
 * The snapshot's threads in file order — a seeded shuffle. Never sort this: order must
 * not correlate with size, category or anything else the model could pick up on.
 */
export function loadSnapshotThreads(snapshot: string): SnapshotThread[] {
  const path = resolve(PC_DATA_ROOT, snapshot, 'population.json');
  if (!existsSync(path)) throw new PcError(`no population snapshot at ${path}`, 404);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { threads?: SnapshotThread[] };
  const threads = parsed.threads ?? [];
  if (threads.length === 0) throw new PcError(`population at ${path} holds no threads`);
  return threads;
}

export function loadBundle(snapshot: string, threadId: string): ThreadBundle {
  const path = resolve(PC_DATA_ROOT, snapshot, 'bundles', `${threadId}.json`);
  if (!existsSync(path)) {
    throw new PcError(`no bundle at ${path} — run pc-build-bundles.ts first`, 409);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as ThreadBundle;
}

export function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * The threads to process: the explicit `threads` list if given (all must be in the
 * snapshot), else the first `n` in snapshot order if `n` is given, else all of them.
 *
 * The two are alternatives, not a filter pair — an explicit list wins, and the CLIs
 * refuse the combination before it reaches here. `n` slices the snapshot's file order,
 * which is a seeded shuffle, so the first `n` are already a random sample; never sort
 * before slicing. An `n` outside `1..threads.length` is refused rather than clamped: a
 * clamped run would look exactly like the one that was asked for.
 */
export function selectThreads(
  threads: SnapshotThread[],
  threadFilter: string | string[] | undefined,
  n?: number,
): SnapshotThread[] {
  if (!threadFilter || (Array.isArray(threadFilter) && threadFilter.length === 0)) {
    if (n === undefined) return threads;
    if (!Number.isInteger(n) || n < 1 || n > threads.length) {
      throw new PcError(
        `n must be an integer between 1 and ${threads.length} (the snapshot's thread count), got ${n}`,
      );
    }
    return threads.slice(0, n);
  }
  const wanted = new Set(
    (Array.isArray(threadFilter) ? threadFilter : threadFilter.split(','))
      .map((t) => t.trim())
      .filter(Boolean),
  );
  const selected = threads.filter((t) => wanted.has(t.thread_id));
  const missing = [...wanted].filter((id) => !selected.some((t) => t.thread_id === id));
  if (missing.length > 0) {
    throw new PcError(`thread(s) not in the snapshot: ${missing.join(', ')}`);
  }
  if (selected.length === 0) throw new PcError('no threads selected');
  return selected;
}

/* -------------------------------------------------------------- plan and gate */

export interface PlannedCall {
  stage: ProblemClassifierStage;
  model: string;
  /** System + user chars, i.e. what would actually be sent. */
  chars: number;
  /** The configured `max_tokens` for this call — the plan's output-token estimate. */
  maxTokens: number;
}

export interface PlanOptions {
  calls: PlannedCall[];
  go: boolean;
  /** Printed above the table (what this pass is about to do). */
  header?: string[];
  /** Printed below the table (warnings, caveats about the estimate). */
  notes?: string[];
}

/**
 * Print the plan, then answer whether to spend. `false` means the caller stops; it has
 * already told the operator why. There is no other way out of this file to the proxy.
 */
export interface PlanTable {
  rows: PlanRow[];
  estInputCostUsd: number;
  /** `false` when a stage's model has no list price, so the total is a floor. */
  costKnown: boolean;
}

/**
 * The plan's arithmetic, with no printing. `planAndGate` renders this and the HTTP
 * `plan` route serialises it, so the table an operator reads and the table the
 * frontend shows as its confirmation step can never disagree.
 *
 * Stage order is first-seen order in `calls`, which is the order the passes plan in.
 */
export function summarisePlannedCalls(calls: PlannedCall[]): PlanTable {
  const stages: ProblemClassifierStage[] = [];
  for (const call of calls) if (!stages.includes(call.stage)) stages.push(call.stage);

  const rows: PlanRow[] = [];
  let estInputCostUsd = 0;
  let costKnown = true;
  for (const stage of stages) {
    const stageCalls = calls.filter((call) => call.stage === stage);
    const chars = stageCalls.map((call) => call.chars);
    const model = stageCalls[0].model;
    const estInputTokens = Math.round(sum(chars) / CHARS_PER_TOKEN_ESTIMATE);
    const price = LIST_PRICE_USD_PER_MTOK[model];
    const cost = price === undefined ? 0 : (estInputTokens / 1_000_000) * price;
    if (price === undefined) costKnown = false;
    else estInputCostUsd += cost;
    rows.push({
      stage,
      model,
      calls: stageCalls.length,
      charsSum: sum(chars),
      charsP50: pct(chars, 50),
      charsMax: pct(chars, 100),
      estInputTokens,
      estOutputTokens: sum(stageCalls.map((call) => call.maxTokens)),
      estInputCostUsd: cost,
    });
  }
  return { rows, estInputCostUsd, costKnown };
}

/** Does this model have a list price, i.e. is its plan row's cost a real number? */
export function hasListPrice(model: string): boolean {
  return LIST_PRICE_USD_PER_MTOK[model] !== undefined;
}

export function planAndGate(options: PlanOptions): boolean {
  const { calls, go } = options;
  const lines: string[] = [];
  for (const line of options.header ?? []) lines.push(line);
  lines.push(
    `PLAN · ${calls.length} ${calls.length === 1 ? 'call' : 'calls'} · provider ${PROBLEM_CLASSIFIER_MODELS.provider}`,
  );
  lines.push(
    'list prices are assumptions for this plan (haiku-4-5 $1, opus-4-8 $5 per 1M input tokens); the real cost comes from the proxy\'s usage.total_cost_usd',
  );
  lines.push(
    `input token estimate is chars / ${CHARS_PER_TOKEN_ESTIMATE}; output tokens are the configured max_tokens per call and are not priced here`,
  );
  lines.push('');
  lines.push(
    [
      'stage'.padEnd(8),
      'calls'.padStart(6),
      '  model'.padEnd(20),
      'chars sum'.padStart(12),
      'chars p50'.padStart(12),
      'chars max'.padStart(12),
      'est in tok'.padStart(12),
      'est out tok'.padStart(12),
      'est in cost'.padStart(12),
    ].join(''),
  );

  const table = summarisePlannedCalls(calls);
  for (const row of table.rows) {
    lines.push(
      [
        row.stage.padEnd(8),
        String(row.calls).padStart(6),
        `  ${row.model}`.padEnd(20),
        String(row.charsSum).padStart(12),
        String(row.charsP50).padStart(12),
        String(row.charsMax).padStart(12),
        String(row.estInputTokens).padStart(12),
        String(row.estOutputTokens).padStart(12),
        (hasListPrice(row.model) ? usd(row.estInputCostUsd) : 'unknown').padStart(12),
      ].join(''),
    );
  }
  lines.push('');
  lines.push(
    table.costKnown
      ? `estimated input cost: ${usd(table.estInputCostUsd)}`
      : `estimated input cost: ${usd(table.estInputCostUsd)} plus the stages with no list price above`,
  );
  for (const note of options.notes ?? []) lines.push(note);

  console.log(lines.join('\n'));

  if (!go) {
    console.log('');
    console.log('--go absent: nothing sent');
    return false;
  }
  return true;
}

/* ----------------------------------------------------------------- the caller */

export interface CallOptions {
  maxTokens: number;
  /**
   * Proxy `ResponseFormat`. Verified in anna-llm-proxy: the request schema accepts
   * `JSON` for any provider, but the Anthropic SDK adapter only acts on `JSON_SCHEMA`,
   * so on `VERTEX_AI` + Claude this is inert and the 3-tier parse does the real work.
   */
  responseFormat?: 'TEXT' | 'JSON';
  /** Written to the call log; `null` for a pass with no per-thread grain (pass 3). */
  threadId: string | null;
  callsPath: string;
}

export interface CallResult {
  content: string;
  usage: LLMUsage;
  latencyMs: number;
  attempts: number;
}

const RETRY_PAUSE_MS = 5_000;

/**
 * A transport failure (no HTTP status in the message) or a 408/5xx is worth one retry.
 * An HTTP 4xx other than 408, and a provider error the proxy returns in `error`, are
 * not: they will fail again and the second call is paid for.
 */
export function isRetryableCallError(error: unknown): boolean {
  const message = (error as Error)?.message ?? '';
  const status = /LLM API error: (\d{3})\b/.exec(message);
  if (status) {
    const code = Number(status[1]);
    return code === 408 || code >= 500;
  }
  return !message.includes('LLM API error:');
}

/**
 * The proxy's refusal to stream Claude at all:
 * `400 {"error":{"code":4,"message":"Streaming is not supported by AnthropicSDKAdapter"}}`.
 * Matched on the status and the message rather than the adapter's name, so a rename on
 * the proxy side does not turn this back into a hard failure.
 */
export function isStreamUnsupportedError(error: unknown): boolean {
  const message = (error as Error)?.message ?? '';
  return message.includes('LLM API error: 400') && message.includes('Streaming is not supported');
}

/**
 * Set the first time the proxy says it cannot stream. Module-level on purpose: the
 * answer is a property of the proxy, not of the call, so once it is known every later
 * call in the process goes buffered without paying a doomed round trip first.
 */
let streamUnsupported = false;

function appendCallLine(callsPath: string, line: Record<string, unknown>): void {
  mkdirSync(dirname(callsPath), { recursive: true });
  appendFileSync(callsPath, `${JSON.stringify(line)}\n`);
}

async function pause(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * One LLM call at the stage's configured model, with the usage accounting. Every attempt
 * appends a line to `llm-calls.ndjson` — a failed one too, so a sweep's error count and
 * its latency spread are readable off the log alone. Latency is recorded because the
 * stage proxy's `REQUEST_TIMEOUT` is 60 s: how close a stage runs to that is the thing
 * that decides whether the whole snapshot can be swept in one go.
 *
 * Which transport is used comes from `PC_LLM_STREAM` and is recorded on every call
 * line, because the two have different failure modes and a sweep's timeouts are only
 * interpretable if the log says which endpoint they came from. `buffered(fallback)`
 * means `PC_LLM_STREAM=1` was asked for and the proxy refused to stream: that 400 is
 * not the call failing, so it is not logged, not retried and not an error against the
 * thread — the call simply goes out buffered instead, here and for the rest of the
 * process.
 *
 * Throws after the retry. Callers record the thread as unfinished and carry on — a
 * missing result file is what makes the next run pick the thread up again.
 */
export async function callWithUsage(
  stage: ProblemClassifierStage,
  messages: Message[],
  options: CallOptions,
): Promise<CallResult> {
  const model = modelForStage(stage);
  const wantStream = PROBLEM_CLASSIFIER_TRANSPORT.stream;
  let lastError: unknown = null;
  /* `attempt` is advanced by hand: a stream-unsupported 400 re-enters the loop on the
   * same attempt number, because it costs nothing and buys no information. */
  for (let attempt = 1; attempt <= 2; ) {
    const useStream = wantStream && !streamUnsupported;
    const transport = useStream ? 'stream' : wantStream ? 'buffered(fallback)' : 'buffered';
    const send = useStream ? analyzeWithLLMUsageStream : analyzeWithLLMUsage;
    const started = Date.now();
    try {
      const response = await send(messages, {
        model,
        provider: PROBLEM_CLASSIFIER_MODELS.provider,
        maxTokens: options.maxTokens,
        temperature: 0,
        responseFormat: options.responseFormat,
        baseUrl: PROBLEM_CLASSIFIER_TRANSPORT.baseUrl,
      });
      const latencyMs = Date.now() - started;
      appendCallLine(options.callsPath, {
        ts: new Date().toISOString(),
        stage,
        thread_id: options.threadId,
        model,
        transport,
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        total_cost_usd: response.usage.total_cost_usd,
        latency_ms: latencyMs,
        ok: true,
        error: null,
      });
      return { content: response.content, usage: response.usage, latencyMs, attempts: attempt };
    } catch (error) {
      if (useStream && isStreamUnsupportedError(error)) {
        if (!streamUnsupported) {
          streamUnsupported = true;
          console.warn(
            'PC_LLM_STREAM=1 but the proxy answered "Streaming is not supported" — falling back to the buffered /api/chat for the rest of this process',
          );
        }
        continue;
      }
      const latencyMs = Date.now() - started;
      lastError = error;
      appendCallLine(options.callsPath, {
        ts: new Date().toISOString(),
        stage,
        thread_id: options.threadId,
        model,
        transport,
        input_tokens: 0,
        output_tokens: 0,
        total_cost_usd: null,
        latency_ms: latencyMs,
        ok: false,
        error: (error as Error)?.message ?? 'unknown error',
      });
      if (attempt === 2 || !isRetryableCallError(error)) break;
      attempt += 1;
      await pause(RETRY_PAUSE_MS);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('LLM call failed');
}

/* -------------------------------------------------------- the regex extraction */

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const SYMBOL_RE = /([£$€])\s?(\d[\d,]*(?:\.\d{1,2})?)/g;
const CODE_RE = /(\d[\d,]*(?:\.\d{1,2})?)\s?(GBP|USD|EUR)\b/gi;
const SYMBOL_CCY: Record<string, string> = { '£': 'GBP', $: 'USD', '€': 'EUR' };

/** A currency figure anywhere in the text, either shape. Non-global: a test, not a scan. */
const HAS_MONEY_RE = /[£$€]\s?\d|\d\s?(?:GBP|USD|EUR)\b/i;

/** Every money figure in `text`, both shapes, currency taken from the symbol or the code. */
function moneyFigures(text: string): { value: number; currency: string | null }[] {
  const out: { value: number; currency: string | null }[] = [];
  for (const match of text.matchAll(SYMBOL_RE)) {
    const value = parseAmountValue(match[2]);
    if (value != null) out.push({ value, currency: SYMBOL_CCY[match[1]] ?? null });
  }
  for (const match of text.matchAll(CODE_RE)) {
    const value = parseAmountValue(match[1]);
    if (value != null) out.push({ value, currency: match[2].toUpperCase() });
  }
  return out;
}

/**
 * Pass 1a without a model: every UUID in the message and task text, every money figure
 * the customer or an automated task wrote, no counterparties, no direction.
 *
 * In `regex-first` mode this *is* pass 1a for most threads — 94 of the pilot's 122 carry
 * a transaction UUID in their text, and a shortlist built from ids alone is short enough
 * (p50 10 rows) for `pick` to answer off it. Where it is not enough the model's `extract`
 * still runs and its answer is merged over this one, so nothing the model would have
 * found is lost; what is saved is the call on the threads that never needed it. It is
 * also what the plans size their `pick` rendering from, which is the job it was written
 * for.
 *
 * Amounts come from the customer's own messages, plus the title and description of any
 * task whose *title* carries a currency figure. That last rule stands in for "written by
 * Gemma": `created_by` does not reliably separate a bot from a person, but a task titled
 * `Incoming payment 1,250.00 GBP held` is an automated one, and its figure is the payment
 * the thread is about. An agent's free-text note is not read for amounts.
 */
export function regexExtraction(bundle: ThreadBundle): PaymentExtraction {
  const messageText = bundle.dialogues.flatMap((d) => d.messages.map((m) => m.text)).join('\n');
  const taskText = bundle.tasks
    .flatMap((t) => [
      t.title ?? '',
      t.description ?? '',
      ...t.comments.map((c) => c.description ?? ''),
    ])
    .join('\n');
  const customerText = bundle.dialogues
    .flatMap((d) => d.messages.filter((m) => m.speaker === 'customer').map((m) => m.text))
    .join('\n');

  const amounts = moneyFigures(customerText);
  for (const task of bundle.tasks) {
    const title = task.title ?? '';
    if (!HAS_MONEY_RE.test(title)) continue;
    amounts.push(...moneyFigures(`${title}\n${task.description ?? ''}`));
  }

  return PaymentExtractionSchema.parse({
    explicit_ids: [...`${messageText}\n${taskText}`.matchAll(UUID_RE)].map((m) => m[0]),
    amounts,
    counterparties: [],
    direction: 'unknown',
    dates: [],
    no_payment_discussed: false,
  });
}

/**
 * The fallback extraction: everything either side found, with the model winning where
 * only it can have an opinion.
 *
 * Ids and amounts are a union — the regex cannot invent a UUID that is not in the text,
 * and the model reads figures out of prose the regex misses, so dropping either side
 * would shorten the shortlist the fallback exists to widen. Counterparties, direction and
 * `dates` are the model's alone: the regex never sets them. `no_payment_discussed` is the
 * model's verdict, which the regex has no way to reach.
 */
export function mergeExtractions(
  regex: PaymentExtraction,
  model: PaymentExtraction,
): PaymentExtraction {
  return PaymentExtractionSchema.parse({
    explicit_ids: [...regex.explicit_ids, ...model.explicit_ids],
    amounts: [...regex.amounts, ...model.amounts],
    counterparties: model.counterparties,
    direction: model.direction,
    dates: model.dates,
    no_payment_discussed: model.no_payment_discussed,
  });
}

/** An extraction that claims nothing — what a thread gets when pass 1a will not parse. */
export const EMPTY_EXTRACTION: PaymentExtraction = {
  explicit_ids: [],
  amounts: [],
  counterparties: [],
  direction: 'unknown',
  dates: [],
  no_payment_discussed: false,
};

/* -------------------------------------------------------- pass-1 result shape */

/**
 * `RESOLVED` — a handle that resolved to a ledger row.
 * `ORDER_ONLY` — a handle that resolved to a payment order that never posted.
 * `UNRESOLVED_HANDLE` — a handle that is not in the shortlist, or output that would not
 *   parse after one retry. The model was wrong; that is not the same as no payment.
 * `NOT_FOUND` — the model's verdict that no shortlisted record is the one, or an empty
 *   shortlist. A verdict, not a failure: the thread still goes to pass 2.
 */
export type Pass1State = 'RESOLVED' | 'ORDER_ONLY' | 'UNRESOLVED_HANDLE' | 'NOT_FOUND';

export const PASS1_STATES: Pass1State[] = [
  'RESOLVED',
  'ORDER_ONLY',
  'UNRESOLVED_HANDLE',
  'NOT_FOUND',
];

export interface Pass1Pick {
  handle: string;
  confidence: string;
  why: string;
}

/**
 * Pass 1b's answer. Tolerant on the two soft fields — a missing `confidence` is not
 * worth a retry — but `handle` has to be there, because it is the whole answer.
 */
const PickSchema = z.object({
  handle: z.string(),
  confidence: z.string().default('low'),
  why: z.string().default(''),
});

/** Throws when the text holds no usable pick; the caller retries once, then gives up. */
export function parsePickJson(raw: string): Pass1Pick {
  const parsed = PickSchema.safeParse(parseLlmJson(raw));
  if (!parsed.success) throw new Error(parsed.error.message);
  return parsed.data;
}

export interface ShortlistHandleRow {
  handle: string;
  id: string;
  kind: 'ledger' | 'order';
}

/**
 * A handle becomes a state. `NOT_FOUND` is the model's verdict; a handle the shortlist
 * does not hold is the model being wrong, which is `UNRESOLVED_HANDLE` and never a
 * silent `NOT_FOUND` — the two have to stay tellable apart in the report.
 */
export function resolvePickHandle(
  rows: ShortlistHandleRow[],
  handle: string,
): { state: Pass1State; identified: { id: string; kind: 'ledger' | 'order' } | null } {
  const wanted = handle.trim().toUpperCase();
  if (wanted === 'NOT_FOUND') return { state: 'NOT_FOUND', identified: null };
  const row = rows.find((r) => r.handle.toUpperCase() === wanted);
  if (!row) return { state: 'UNRESOLVED_HANDLE', identified: null };
  return {
    state: row.kind === 'order' ? 'ORDER_ONLY' : 'RESOLVED',
    identified: { id: row.id, kind: row.kind },
  };
}

/**
 * Which calls this thread actually cost, as a path through pass 1. Recorded on every
 * result so a run's call count is readable off its results alone, and so an A/B between
 * `regex-first` and `extract-always` can be cut by the branch each thread took rather
 * than by counting lines in `llm-calls.ndjson`.
 *
 * `extract+pick` / `extract` — `extract-always`, the original flow. The second is a
 *   thread whose shortlist came back empty, which never had a `pick` call.
 * `regex+pick` — the whole point: the regex shortlist was enough and `pick` named a row.
 * `regex+pick→extract+pick` — `pick` answered NOT_FOUND, so `extract` ran, the merged
 *   shortlist differed, and `pick` ran again on it.
 * `regex+pick→extract` — as above, but the merged shortlist was identical to the first,
 *   so the second `pick` was pointless and the NOT_FOUND stands.
 * `regex-empty→extract+pick` — the regex found nothing to shortlist, `extract` ran, and
 *   its shortlist reached `pick`. No first `pick` was made.
 * `regex-empty→extract` — and the merged shortlist was empty too: NOT_FOUND, one call.
 */
export type Pass1Path =
  | 'extract+pick'
  | 'extract'
  | 'regex+pick'
  | 'regex+pick→extract+pick'
  | 'regex+pick→extract'
  | 'regex-empty→extract+pick'
  | 'regex-empty→extract';

export interface Pass1Result {
  thread_id: string;
  path_key: string;
  /**
   * The model's extraction, `null` when `extract` was not called (`regex-first` on a
   * thread that never needed it) or when it would not parse twice. `pass1_path` tells
   * the two apart, and so does `usage.extract_attempts`.
   */
  extraction: PaymentExtraction | null;
  extraction_raw: string | null;
  /** What the regex read out of the text. `null` in `extract-always` mode. */
  regex_extraction: PaymentExtraction | null;
  pass1_path: Pass1Path;
  /** The shortlist `pick` last saw — the merged one on any fallback path. */
  shortlist: {
    rows: { handle: string; id: string; kind: 'ledger' | 'order'; reasons: string[] }[];
    omitted: number;
  };
  pick_raw: string | null;
  pick: Pass1Pick | null;
  state: Pass1State;
  identified: { id: string; kind: 'ledger' | 'order' } | null;
  usage: {
    extract: LLMUsage | null;
    pick: LLMUsage | null;
    extract_attempts: number;
    pick_attempts: number;
  };
  timings: { extract_ms: number; pick_ms: number };
}

export interface Pass2Result {
  thread_id: string;
  path_key: string;
  /**
   * The prompt that produced `reading`. Absent on runs made before it was recorded —
   * `fn1` and everything earlier, all of which were read with `pc-read-v2`.
   */
  prompt_id?: string;
  pass1_state: Pass1State;
  identified: { id: string; kind: 'ledger' | 'order' } | null;
  reading: string;
  usage: LLMUsage | null;
  timing: { read_ms: number };
}

export interface Pass3Category {
  name: string;
  definition: string;
  what_removes_it: string;
  member_thread_ids: string[];
}

/**
 * The draw behind an induction whose categories came from a sample of the readings
 * rather than all of them. `thread_ids` is the sample itself, in snapshot order, so a
 * later run can reproduce the induction without re-deriving the draw; `seed` is the
 * snapshot manifest's seed the draw was made with.
 */
export interface InduceSample {
  size: number;
  seed: number;
  thread_ids: string[];
}

/**
 * `raw` keeps both calls of the two-step mode: the induce output and one entry per
 * assign batch, in batch order. One-call mode fills `induce` and leaves `assign` empty.
 * `usage` is the sum over every call the induction spent — the per-call detail is in
 * `llm-calls.ndjson`, which is where a latency or a cost question gets answered.
 *
 * `induce_sample` is absent unless the induce call was sent a sample: an induction over
 * every reading is the ordinary case and says so by carrying no draw.
 */
export interface Pass3Result {
  categories: Pass3Category[];
  unassigned: string[];
  notes: string;
  raw: { induce: string; assign: string[] };
  usage: LLMUsage | null;
  mode: 'two-step' | 'one-call';
  induce_sample?: InduceSample;
}

/* --------------------------------------------------- pass 3's assign-line parser */

export interface AssignLineOutcome {
  /** A 1-based category number, or `null` for the model's own `unassigned` verdict. */
  category: number | null;
  reason: string;
}

export interface AssignParseResult {
  /** The expected threads the model answered with a category number or `unassigned`. */
  assigned: Map<string, AssignLineOutcome>;
  /** An expected thread whose category token is neither a valid number nor `unassigned`. */
  invalid: { thread_id: string; token: string }[];
  /** An expected thread with no parseable line at all. */
  missing: string[];
  /** Ids the output names that were not in this batch — ignored, but counted. */
  unknown: string[];
}

/** `- ` / `* ` / `1. ` in front of a line: tolerated, then discarded. */
const ASSIGN_BULLET_RE = /^\s*(?:[-*+•]|\d+[.)])\s+/;
const ASSIGN_LINE_RE = /^([A-Za-z0-9._-]+)\s*:\s*(.*)$/;

/**
 * Read `<thread_id>: <category number> | <reason>` lines against the batch that was
 * sent. Strict on the category token — a number in range or the literal `unassigned`,
 * nothing else — because the caller's answer to a bad token is a cheap one-thread retry,
 * and guessing what `Category 3 (probably)` meant is how a wrong assignment gets kept.
 *
 * An id the batch did not contain is dropped rather than assigned: it is either a
 * hallucinated thread or a thread from another batch, and neither belongs here.
 */
export function parseAssignLines(
  raw: string,
  expectedIds: string[],
  categoryCount: number,
): AssignParseResult {
  const expected = new Set(expectedIds);
  const assigned = new Map<string, AssignLineOutcome>();
  const invalid: { thread_id: string; token: string }[] = [];
  const unknown: string[] = [];

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.replace(ASSIGN_BULLET_RE, '').trim();
    if (line === '') continue;
    const match = ASSIGN_LINE_RE.exec(line);
    if (!match) continue;
    const threadId = match[1];
    if (!expected.has(threadId)) {
      unknown.push(threadId);
      continue;
    }
    /* First valid answer wins; a repeated id is not a second opinion. */
    if (assigned.has(threadId)) continue;

    const rest = match[2];
    const bar = rest.indexOf('|');
    const token = (bar === -1 ? rest : rest.slice(0, bar)).trim();
    const reason = (bar === -1 ? '' : rest.slice(bar + 1)).trim();

    if (token.toLowerCase() === 'unassigned') {
      assigned.set(threadId, { category: null, reason });
      continue;
    }
    const number = Number(token);
    if (!Number.isInteger(number) || number < 1 || number > categoryCount) {
      if (!invalid.some((row) => row.thread_id === threadId)) {
        invalid.push({ thread_id: threadId, token });
      }
      continue;
    }
    assigned.set(threadId, { category: number, reason });
  }

  const missing = expectedIds.filter(
    (id) => !assigned.has(id) && !invalid.some((row) => row.thread_id === id),
  );
  return { assigned, invalid, missing, unknown };
}

/* ------------------------------------------------------------- the label guard */

/** The only three headings a pass-2 reading may carry. */
export const PASS2_HEADINGS = [
  'Payment',
  'What happened to the customer',
  'What would have removed the problem',
] as const;

const HEADING_ONLY_RE = new RegExp(
  `^\\s*#{0,6}\\s*(${PASS2_HEADINGS.join('|')})\\s*:?\\s*$`,
  'i',
);
/** `Category: hold`, `Outcome: refunded` — a label wearing a sentence's clothes. */
const KEY_VALUE_RE = /^\s*([A-Z][A-Za-z ]{2,30}):\s/;
/** `HELD_BY_PARTNER`, `MISSING`, `NOT_FOUND` — five characters or more of shouting. */
const SHOUTED_TOKEN_RE = /\b[A-Z][A-Z_]{4,}\b/g;

/**
 * Payment vocabulary, and the record states a reading may name: rails, currencies, the
 * compliance checks, the transaction statuses. Shouting one of these is how the domain
 * is written, not a reader inventing a class. Kept as one list because the alternative
 * is the guard flagging the subject matter of every reading it reads.
 */
export const LABEL_GUARD_VOCABULARY = new Set([
  'SWIFT',
  'SEPA',
  'BACS',
  'CHAPS',
  'FP',
  'DD',
  'IBAN',
  'BIC',
  'MT103',
  'GBP',
  'EUR',
  'USD',
  'KYB',
  'KYC',
  'EDD',
  'SAR',
  'CIFAS',
  'PSR',
  'ANNA',
  'UK',
  'POS',
  'ATM',
  'PENDING',
  'PROCESSED',
  'DECLINED',
  'SUCCEED',
  'NOT_FOUND',
  'RESOLVED',
]);
const BULLET_RE = /^\s*[-*+•]\s/;
const BOLD_RE = /\*\*/;
const TAXONOMY_WORD_RE = /\b(categor(?:y|ies)|bucket|taxonomy|label)\b/i;

/**
 * Pass 2 writes prose. Anything that looks like a class, a type or a bucket means the
 * reader started classifying, which is pass 3's job over the whole corpus and nobody
 * else's. Findings only: the guard flags, it never edits.
 *
 * `bundleText` is the thread's own rendering — the text pass 2 was shown. An all-caps
 * token that appears in it was copied out of the record (a payee name, a reference, a
 * transaction status), so it is the customer's data being quoted, not a label being
 * invented. Without that filter the rule fired on 98 of the pilot's 122 readings, which
 * is a guard that cannot be read. What survives is a token that is *not* in the thread's
 * own text, *not* payment vocabulary, and either carries an underscore or was shouted
 * more than once — the shape of a coinage the reader is now reusing as a class.
 */
export function labelGuardFlags(reading: string, bundleText = ''): string[] {
  const flags: string[] = [];
  const lines = reading.split('\n');
  for (const line of lines) {
    if (HEADING_ONLY_RE.test(line)) continue;
    if (KEY_VALUE_RE.test(line)) flags.push(`key:value line "${line.trim().slice(0, 40)}"`);
    if (BULLET_RE.test(line)) flags.push(`markdown bullet "${line.trim().slice(0, 40)}"`);
  }
  if (BOLD_RE.test(reading)) flags.push('markdown bold');

  const haystack = bundleText.toUpperCase();
  /* First-appearance order, with the count, so the two tests below need one pass. */
  const shouted = new Map<string, number>();
  for (const match of reading.matchAll(SHOUTED_TOKEN_RE)) {
    shouted.set(match[0], (shouted.get(match[0]) ?? 0) + 1);
  }
  for (const [token, count] of shouted) {
    if (LABEL_GUARD_VOCABULARY.has(token)) continue;
    if (haystack.includes(token)) continue;
    if (!token.includes('_') && count < 2) continue;
    flags.push(`all-caps token "${token}"${count > 1 ? ` ×${count}` : ''}`);
  }

  const word = TAXONOMY_WORD_RE.exec(reading);
  if (word) flags.push(`taxonomy word "${word[0]}"`);
  return flags;
}

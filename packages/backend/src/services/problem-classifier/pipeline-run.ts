/**
 * Payment problem classifier — the three things that actually do work.
 *
 * `createSnapshot` runs the selector once (BigQuery, no LLM), `buildBundles` pulls the
 * sources and assembles a bundle per thread (BigQuery, no LLM), and `runPass` spends
 * tokens. Every one of them is the body a `pc-*.ts` script used to hold, so the CLI and
 * the HTTP surface cannot drift.
 *
 * Two rules the file keeps, because no caller is trusted to:
 *  - a pass runs over *every* selected thread; nothing here decides that a thread is
 *    not worth reading;
 *  - no aggregate leaves a pass. Per-thread progress goes out through `hooks.onEvent`,
 *    CLI prose through `hooks.onLog`, and counts are `buildReport`'s job over a pass
 *    that is complete across the whole snapshot.
 *
 * Cancellation is cooperative: the loops stop *scheduling* when `hooks.isCancelled()`
 * turns true and let whatever is already in flight finish, so a cancelled run leaves
 * only whole results behind and the next run resumes from them.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { z } from 'zod';

import { analyzeWithLLMUsage, type LLMUsage, type Message } from '../llm-api.js';
import { parseLlmJson } from '../../utils/llm-json.js';
import {
  LEDGER_WINDOW_DAYS,
  assembleBundles,
  collectPullKeys,
  renderBundleText,
  shiftDays,
} from './bundle.js';
import * as sources from './bundle-sources.js';
import { PROBLEM_CLASSIFIER_MODELS, modelForStage } from './config.js';
import { PaymentExtractionSchema, type PaymentExtraction } from './extraction.js';
import {
  ESCALATION_RULE,
  HUMAN_TOUCH_RULE,
  SELECTOR_DATE_RULE,
  SELECTOR_PREDICATE,
  SELECTOR_TABLES,
  countByCategory,
  resolveLeafSet,
  selectPopulation,
  type PopulationThread,
} from './population.js';
import { shortlistCandidates, type ShortlistResult } from './shortlist.js';
import {
  EMPTY_EXTRACTION,
  callWithUsage,
  mergeExtractions,
  mulberry32,
  parseAssignLines,
  loadSnapshotThreads,
  parsePickJson,
  pct,
  resolvePickHandle,
  shuffleInPlace,
  sum,
  usd,
  writeJsonFile,
  type CallResult,
  type Pass1Path,
  type Pass1Pick,
  type Pass1Result,
  type Pass1State,
  type Pass2Result,
  type Pass3Category,
  type Pass3Result,
} from './runner.js';
import {
  MEASURE,
  PASS1,
  PASS2,
  PASS3,
  assignUserMessage,
  preparePass,
  preparePass1,
  preparePass2,
  preparePass3,
  renderCategoryBlock,
  type AllPrepared,
  type MeasureJob,
  type MeasurePrepared,
  type Pass1Prepared,
  type Pass2Prepared,
  type Pass3Prepared,
  type Prepared,
  type ReadingBlock,
} from './pipeline-plan.js';
import {
  assertName,
  bundlesBuilt,
  populationPath,
  safeDataPath,
  summariseSnapshot,
} from './pipeline-read.js';
import {
  PcError,
  makeEvent,
  type CreateSnapshotInput,
  type PassRequest,
  type PipelineHooks,
  type SnapshotSummary,
} from './pipeline-types.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})?$/;

/** Messages are pulled 60 days past the last dialogue, then extended while the tail is live. */
const MESSAGE_LOOKAHEAD_DAYS = 60;
const MESSAGE_LOOKBEHIND_DAYS = 1;
const TAIL_GUARD_DAYS = 2;

export type RunOutcome = { status: 'completed' | 'cancelled' };

function log(hooks: PipelineHooks, line: string): void {
  hooks.onLog?.(line);
}

/** One LLM call, with its usage reported to the job before the result is returned. */
async function callAndReport(
  hooks: PipelineHooks,
  stage: Parameters<typeof callWithUsage>[0],
  messages: Message[],
  options: Parameters<typeof callWithUsage>[2],
): Promise<CallResult> {
  try {
    const result = await callWithUsage(stage, messages, options);
    hooks.onUsage?.({
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
      costUsd: result.usage.total_cost_usd,
      ok: true,
    });
    return result;
  } catch (error) {
    hooks.onUsage?.({ inputTokens: 0, outputTokens: 0, costUsd: null, ok: false });
    throw error;
  }
}

/* --------------------------------------------------------------- M1: snapshot */

/**
 * Run the fixed selector once and write `population.json`. That file is the population
 * for every later pass: `gemma.thread_scenarios` and `gemma.threads` are rewritten
 * daily and revise rows, so nothing downstream may ever re-query the selector.
 *
 * Synchronous (seconds): one BigQuery query, no LLM.
 */
export async function createSnapshot(input: CreateSnapshotInput): Promise<SnapshotSummary> {
  const { dateFrom, dateTo } = input;
  const name = assertName('snapshot name', input.name);
  if (!DATE_RE.test(dateFrom)) throw new PcError(`dateFrom must be YYYY-MM-DD, got "${dateFrom}"`);
  if (!DATE_RE.test(dateTo)) throw new PcError(`dateTo must be YYYY-MM-DD, got "${dateTo}"`);
  if (dateFrom > dateTo) throw new PcError(`dateFrom (${dateFrom}) is after dateTo (${dateTo})`);
  if (input.asOf !== undefined && !ISO_TS_RE.test(input.asOf)) {
    throw new PcError(`asOf must be an ISO-8601 timestamp, got "${input.asOf}"`);
  }
  let seed = input.seed;
  if (seed === undefined) seed = Math.floor(Math.random() * 2 ** 32);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new PcError(`seed must be a non-negative 32-bit integer, got "${String(input.seed)}"`);
  }

  const outPath = populationPath(name);
  if (existsSync(outPath) && input.force !== true) {
    throw new PcError(`snapshot already exists: ${outPath} (pass --force to overwrite)`, 409);
  }

  let leafSet;
  try {
    leafSet = resolveLeafSet(input.leaves);
  } catch (error) {
    throw new PcError(error instanceof Error ? error.message : String(error));
  }

  const threads = await selectPopulation({
    dateFrom,
    dateTo,
    pathKeys: leafSet.pathKeys,
    asOf: input.asOf,
    filter: input.filter,
  });

  /* BigQuery returns rows in an unspecified order, so canonicalise on thread_id first —
   * that makes the shuffle a pure function of (selected set, seed). */
  threads.sort((a, b) => (a.thread_id < b.thread_id ? -1 : a.thread_id > b.thread_id ? 1 : 0));
  /* Seeded shuffle: a downstream pass that processes the file in order must not process
   * cases in any order correlated with content (category, size, customer). */
  shuffleInPlace(threads, mulberry32(seed));

  const byCategory = countByCategory(threads, leafSet.pathKeys);
  const snapshot = {
    manifest: {
      tool: 'problem-classifier',
      version: 1,
      created_at: new Date().toISOString(),
      date_from: dateFrom,
      date_to: dateTo,
      as_of: input.asOf ?? null,
      selector: {
        tables: SELECTOR_TABLES,
        predicate: SELECTOR_PREDICATE,
        leaf_set: leafSet.name,
        path_keys: leafSet.pathKeys,
        date_rule: SELECTOR_DATE_RULE,
        filter: input.filter ?? 'all',
        filter_rule:
          input.filter === 'escalated'
            ? ESCALATION_RULE
            : input.filter === 'touched'
              ? HUMAN_TOUCH_RULE
              : null,
      },
      seed,
      counts: {
        total_threads: threads.length,
        total_dialogues: threads.reduce((total, t) => total + t.dialogues.length, 0),
        total_customers: new Set(threads.map((t) => t.customer_alias)).size,
        by_category: byCategory,
      },
    },
    threads,
  };

  mkdirSync(safeDataPath(name), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  return summariseSnapshot(name);
}

/* ---------------------------------------------------------------- M2: bundles */

export interface BuildBundlesOptions {
  /** A subset of the snapshot's threads; the default is all of them, in file order. */
  threads?: string[];
  force?: boolean;
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function quantiles(values: number[]): { min: number; median: number; max: number } {
  if (values.length === 0) return { min: 0, median: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return { min: sorted[0], median, max: sorted[sorted.length - 1] };
}

/**
 * One pull per source table over the whole snapshot, assembled per thread in Node.
 * No LLM calls. Threads are processed in the snapshot file's order and never re-sorted.
 */
export function checkBundlesWritable(
  snapshot: string,
  options: BuildBundlesOptions = {},
): { threads: PopulationThread[]; bundlesDir: string } {
  const snapshotName = assertName('snapshot name', snapshot);
  const bundlesDir = resolve(safeDataPath(snapshotName), 'bundles');
  const outPath = populationPath(snapshotName);
  if (!existsSync(outPath)) throw new PcError(`no population snapshot at ${outPath}`, 404);

  const file = JSON.parse(readFileSync(outPath, 'utf8')) as { threads: PopulationThread[] };

  let threads = file.threads;
  if (options.threads && options.threads.length > 0) {
    const wanted = new Set(options.threads.map((t) => t.trim()).filter(Boolean));
    threads = threads.filter((t) => wanted.has(t.thread_id));
    const missing = [...wanted].filter((id) => !threads.some((t) => t.thread_id === id));
    if (missing.length > 0) {
      throw new PcError(`thread(s) not in the snapshot: ${missing.join(', ')}`);
    }
  }
  if (threads.length === 0) throw new PcError('no threads selected');

  const targets = threads.flatMap((t) => [
    resolve(bundlesDir, `${t.thread_id}.json`),
    resolve(bundlesDir, `${t.thread_id}.extract.txt`),
  ]);
  const existing = targets.filter((p) => existsSync(p));
  if (existing.length > 0 && options.force !== true) {
    throw new PcError(
      `${existing.length} bundle file(s) already exist under ${bundlesDir} (pass --force to overwrite)`,
      409,
    );
  }
  return { threads, bundlesDir };
}

export async function buildBundles(
  snapshot: string,
  hooks: PipelineHooks,
  options: BuildBundlesOptions = {},
): Promise<RunOutcome> {
  const snapshotName = assertName('snapshot name', snapshot);
  const { threads, bundlesDir } = checkBundlesWritable(snapshotName, options);

  const startedAt = new Date();
  const today = startedAt.toISOString().slice(0, 10);

  const keys = collectPullKeys(threads);
  const messageWindow = {
    from: shiftDays(keys.earliestDialogueDate, -MESSAGE_LOOKBEHIND_DAYS),
    to: (() => {
      const nominal = shiftDays(keys.latestDialogueDate, MESSAGE_LOOKAHEAD_DAYS);
      return nominal > today ? today : nominal;
    })(),
  };
  const ledgerWindow = {
    from: shiftDays(keys.earliestDialogueDate, -LEDGER_WINDOW_DAYS.lookback),
    to: shiftDays(keys.latestDialogueDate, LEDGER_WINDOW_DAYS.lookahead),
  };

  log(hooks, `snapshot:        ${snapshotName} (${threads.length} threads)`);
  log(hooks, `aliases:         ${keys.aliases.length}`);
  log(hooks, `dialogue ids:    ${keys.dialogueIds.length}`);
  log(hooks, `message window:  ${messageWindow.from} .. ${messageWindow.to}`);
  log(hooks, `ledger window:   ${ledgerWindow.from} .. ${ledgerWindow.to}`);
  log(hooks, '');

  hooks.onProgress?.({ done: 0, total: threads.length, current: null });

  const bytes: Record<string, number> = {};
  const queries: Record<string, number> = {};
  const record = (
    source: string,
    pull: { bytes: number; queries: number },
    rowCount: number,
  ): void => {
    bytes[source] = (bytes[source] ?? 0) + pull.bytes;
    queries[source] = (queries[source] ?? 0) + pull.queries;
    log(
      hooks,
      `pulled ${source.padEnd(14)} ${String(rowCount).padStart(7)} rows  ${gib(pull.bytes).padStart(10)}  ${pull.queries} query(s)`,
    );
  };

  const cancelled = (): boolean => hooks.isCancelled();

  const containers = await sources.pullContainers(keys.dialogueIds, keys.earliestDialogueDate);
  record('containers', containers, containers.rows.length);
  if (cancelled()) return { status: 'cancelled' };

  /* Messages, then the tail guard: extend the window while any dialogue's last
   * message sits within TAIL_GUARD_DAYS of the window edge and the edge is not today. */
  const messagePull = await sources.pullMessages(
    keys.dialogueIds,
    messageWindow.from,
    messageWindow.to,
  );
  let messageRows = messagePull.rows;
  let messageBytes = messagePull.bytes;
  let messageQueries = messagePull.queries;
  let winTo = messageWindow.to;
  let extensions = 0;
  for (;;) {
    if (winTo >= today) break;
    const latestByDialogue = new Map<string, string>();
    for (const row of messageRows) {
      if (!row.timestamp) continue;
      const prev = latestByDialogue.get(row.task_id);
      if (prev == null || row.timestamp > prev) latestByDialogue.set(row.task_id, row.timestamp);
    }
    const edge = shiftDays(winTo, -TAIL_GUARD_DAYS);
    const nearEdge = [...latestByDialogue.entries()]
      .filter(([, ts]) => ts.slice(0, 10) >= edge)
      .map(([id]) => Number(id));
    if (nearEdge.length === 0) break;
    const nominal = shiftDays(winTo, MESSAGE_LOOKAHEAD_DAYS);
    const nextTo = nominal > today ? today : nominal;
    if (nextTo === winTo) break;
    const extra = await sources.pullMessages(nearEdge, winTo, nextTo);
    messageRows = messageRows.concat(extra.rows);
    messageBytes += extra.bytes;
    messageQueries += extra.queries;
    extensions += 1;
    log(
      hooks,
      `tail guard: extended ${nearEdge.length} dialogue(s) to ${nextTo} (+${extra.rows.length} rows)`,
    );
    winTo = nextTo;
  }
  messageWindow.to = winTo;
  record('messages', { bytes: messageBytes, queries: messageQueries }, messageRows.length);
  if (cancelled()) return { status: 'cancelled' };

  const accounts = await sources.pullAccounts(keys.aliases);
  record('accounts', accounts, accounts.rows.length);

  const accountIds = [
    ...new Set(accounts.rows.map((a) => a.public_id).filter((id): id is string => id != null)),
  ];
  const ledger = await sources.pullLedger(
    keys.aliases,
    accountIds,
    ledgerWindow.from,
    ledgerWindow.to,
  );
  let ledgerRows = ledger.rows;
  let ledgerBytes = ledger.bytes;
  let ledgerQueries = ledger.queries;

  /* `balance_account.alias` is the account owner's alias, which for some customers is
   * not the alias on their ledger rows (20 of the 113 pilot aliases have no
   * balance_account row at all). Those accounts still carry the customer's inbound
   * bank transfers, which are alias-NULL and would otherwise be invisible. Take the
   * account ids off the rows we already matched by alias and scan once more for them. */
  const aliasSet = new Set(keys.aliases);
  const knownAccountIds = new Set(accountIds);
  const discoveredAccountIds = [
    ...new Set(
      ledgerRows
        .filter(
          (r) =>
            r.alias != null &&
            aliasSet.has(r.alias) &&
            r.account_id != null &&
            !knownAccountIds.has(r.account_id),
        )
        .map((r) => r.account_id as string),
    ),
  ];
  if (discoveredAccountIds.length > 0) {
    const extra = await sources.pullLedger(
      [],
      discoveredAccountIds,
      ledgerWindow.from,
      ledgerWindow.to,
    );
    const seen = new Set(ledgerRows.map((r) => r.id));
    const added = extra.rows.filter((r) => !seen.has(r.id));
    ledgerRows = ledgerRows.concat(added);
    ledgerBytes += extra.bytes;
    ledgerQueries += extra.queries;
    log(
      hooks,
      `ledger: ${discoveredAccountIds.length} account id(s) absent from balance_account; second scan added ${added.length} row(s)`,
    );
  }
  record('ledger', { bytes: ledgerBytes, queries: ledgerQueries }, ledgerRows.length);
  if (cancelled()) return { status: 'cancelled' };

  const orders = await sources.pullOrders(keys.aliases, ledgerWindow.from, ledgerWindow.to);
  record('orders', orders, orders.rows.length);

  const agentTasks = await sources.pullAgentTasksByAlias(keys.aliases);
  record('agent_tasks', agentTasks, agentTasks.rows.length);

  const candidateIds = [...new Set(ledgerRows.map((l) => l.id))];
  const fraudLog = await sources.pullFraudLog(candidateIds, ledgerWindow.from, ledgerWindow.to);
  record('fraud_log', fraudLog, fraudLog.rows.length);

  const alertIds = [
    ...new Set(fraudLog.rows.map((f) => f.alert_id).filter((id): id is string => id != null)),
  ].map(Number);
  const alertTasks = await sources.pullAlertTasks(alertIds);
  record('fraud_m2m', alertTasks, alertTasks.rows.length);

  const rmTaskIds = [...new Set(alertTasks.rows.map((m) => m.agent_task_id))].map(Number);
  const rmTasks = await sources.pullAgentTasksById(rmTaskIds);
  record('rm_tasks', rmTasks, rmTasks.rows.length);

  const commentTaskIds = [
    ...new Set([...agentTasks.rows.map((t) => t.id), ...rmTasks.rows.map((t) => t.id)]),
  ].map(Number);
  const comments = await sources.pullComments(commentTaskIds);
  record('comments', comments, comments.rows.length);

  const rules = await sources.pullRuleConfig();
  record('fraud_rules', rules, rules.rows.length);
  if (cancelled()) return { status: 'cancelled' };

  const bundles = assembleBundles(
    {
      name: snapshotName,
      built_at: startedAt.toISOString(),
      threads,
      message_window: { ...messageWindow, extensions },
    },
    {
      containers: containers.rows,
      messages: messageRows,
      tasks: agentTasks.rows,
      rmTasks: rmTasks.rows,
      comments: comments.rows,
      accounts: accounts.rows,
      ledger: ledgerRows,
      orders: orders.rows,
      fraudLog: fraudLog.rows,
      alertTasks: alertTasks.rows,
      rules: rules.rows,
    },
  );

  mkdirSync(bundlesDir, { recursive: true });
  let written = 0;
  for (const bundle of bundles) {
    writeFileSync(
      resolve(bundlesDir, `${bundle.meta.thread_id}.json`),
      `${JSON.stringify(bundle, null, 2)}\n`,
    );
    writeFileSync(
      resolve(bundlesDir, `${bundle.meta.thread_id}.extract.txt`),
      renderBundleText(bundle, { stage: 'extract' }),
    );
    written += 1;
    hooks.onEvent(
      makeEvent({ threadId: bundle.meta.thread_id, stage: 'bundles', state: 'assembled' }),
    );
    hooks.onProgress?.({
      done: written,
      total: bundles.length,
      current: bundle.meta.thread_id,
    });
  }

  const perThread = bundles.map((b) => ({
    thread_id: b.meta.thread_id,
    category: b.meta.category,
    alias_namespace: b.meta.alias_namespace,
    ...b.stats,
    n_dropped_automation_rows: b.dialogues.reduce((s, d) => s + d.dropped_empty_system_rows, 0),
    n_dialogues_without_messages: b.dialogues.filter((d) => d.messages.length === 0).length,
    extract_chars: renderBundleText(b, { stage: 'extract' }).length,
    read_chars: renderBundleText(b, { stage: 'read', identifiedId: null }).length,
  }));

  const build = {
    snapshot: snapshotName,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    threads_built: bundles.length,
    threads_requested: options.threads?.join(',') ?? 'all',
    windows: {
      containers_from: keys.earliestDialogueDate,
      message: { ...messageWindow, extensions },
      ledger: ledgerWindow,
    },
    byte_caps_gb: sources.BYTE_CAPS_GB,
    bytes_by_source: bytes,
    queries_by_source: queries,
    per_thread: perThread,
  };
  writeFileSync(resolve(bundlesDir, '_build.json'), `${JSON.stringify(build, null, 2)}\n`);

  /* ---- the CLI summary. Prose only; nothing here reaches a job's event stream. */
  const emptyDialogues = bundles.flatMap((b) =>
    b.dialogues
      .filter((d) => d.messages.length === 0)
      .map((d) => `${b.meta.thread_id}/${d.dialogue_id}`),
  );
  const msgStats = quantiles(perThread.map((t) => t.n_messages));
  const taskStats = quantiles(perThread.map((t) => t.n_tasks));
  const candStats = quantiles(perThread.map((t) => t.n_ledger_candidates));
  const noTasks = perThread.filter((t) => t.n_tasks === 0);
  const noCandidates = perThread.filter((t) => t.n_ledger_candidates === 0);
  const neither = perThread.filter((t) => t.n_tasks === 0 && t.n_ledger_candidates === 0);

  log(hooks, '');
  log(hooks, `total bytes:            ${gib(Object.values(bytes).reduce((a, b) => a + b, 0))}`);
  log(hooks, `bundles written:        ${bundles.length} → ${bundlesDir}`);
  log(hooks, `tail-guard extensions:  ${extensions}`);
  log(
    hooks,
    `dialogues, no messages: ${emptyDialogues.length}${emptyDialogues.length > 0 ? ` (${emptyDialogues.join(', ')})` : ''}`,
  );
  log(
    hooks,
    `messages/thread:        min ${msgStats.min} · median ${msgStats.median} · max ${msgStats.max}`,
  );
  log(
    hooks,
    `tasks/thread:           min ${taskStats.min} · median ${taskStats.median} · max ${taskStats.max}`,
  );
  log(
    hooks,
    `candidates/thread:      min ${candStats.min} · median ${candStats.median} · max ${candStats.max}`,
  );
  log(hooks, `threads with 0 tasks:   ${noTasks.length}`);
  log(hooks, `threads with 0 cands:   ${noCandidates.length}`);
  log(
    hooks,
    `threads with neither:   ${neither.length}${neither.length > 0 ? ` (${neither.map((t) => t.thread_id).join(', ')})` : ''}`,
  );
  log(hooks, `hold log rows total:    ${perThread.reduce((s, t) => s + t.n_hold_log_rows, 0)}`);

  return { status: 'completed' };
}

/** Whether a snapshot's bundles are all present — what the route's 409 turns on. */
export function snapshotBundlesBuilt(snapshot: string): boolean {
  return bundlesBuilt(snapshot, loadSnapshotThreads(snapshot));
}

/* -------------------------------------------------------------------- M3: pass 1 */

function messagesFor(system: string, user: string): Message[] {
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

interface StageOutcome<T> {
  value: T | null;
  raw: string | null;
  usage: LLMUsage | null;
  attempts: number;
  ms: number;
}

/**
 * One call, and on a parse failure one more with the parse error appended to the user
 * message. A transport failure throws out of here: the thread is left without a result
 * file so the next run picks it up.
 */
async function callAndParse<T>(
  hooks: PipelineHooks,
  stage: 'extract' | 'pick',
  system: string,
  user: string,
  maxTokens: number,
  threadId: string,
  callsPath: string,
  parse: (raw: string) => T,
): Promise<StageOutcome<T>> {
  let raw: string | null = null;
  let usage: LLMUsage | null = null;
  let ms = 0;
  let userMessage = user;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await callAndReport(hooks, stage, messagesFor(system, userMessage), {
      maxTokens,
      responseFormat: 'JSON',
      threadId,
      callsPath,
    });
    raw = result.content;
    usage = result.usage;
    ms += result.latencyMs;
    try {
      return { value: parse(result.content), raw, usage, attempts: attempt, ms };
    } catch (error) {
      if (attempt === 2) return { value: null, raw, usage, attempts: attempt, ms };
      userMessage = `${user}\n\n== YOUR PREVIOUS ANSWER COULD NOT BE PARSED\n${(error as Error).message}\nReturn only the JSON object described above.`;
    }
  }
  return { value: null, raw, usage, attempts: 2, ms };
}

function parseExtraction(rawText: string): PaymentExtraction {
  const parsed = PaymentExtractionSchema.safeParse(parseLlmJson(rawText));
  if (!parsed.success) throw new Error(parsed.error.message);
  return parsed.data;
}

type ShortlistOut = Pass1Result['shortlist'];

function shortlistOutOf(shortlist: ShortlistResult): ShortlistOut {
  return {
    rows: shortlist.rows.map((row) => ({
      handle: row.handle,
      id: row.id,
      kind: row.kind,
      reasons: row.reasons,
    })),
    omitted: shortlist.omitted,
  };
}

/**
 * Two shortlists are the same when they hold the same records in the same order. The
 * handles are positional (`S01…`) so they carry no information the ids do not, and
 * `reasons` can differ between a regex shortlist and a merged one without changing what
 * `pick` has to choose between — which is the only question this comparison answers.
 */
function sameShortlist(a: ShortlistResult, b: ShortlistResult): boolean {
  if (a.rows.length !== b.rows.length) return false;
  return a.rows.every((row, i) => row.kind === b.rows[i].kind && row.id === b.rows[i].id);
}

/** Two pick calls on one thread: the result file carries their total, the log each call. */
function addUsage(a: LLMUsage | null, b: LLMUsage | null): LLMUsage | null {
  if (a == null) return b;
  if (b == null) return a;
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
    total_cost_usd:
      a.total_cost_usd == null && b.total_cost_usd == null
        ? null
        : (a.total_cost_usd ?? 0) + (b.total_cost_usd ?? 0),
  };
}

const EMPTY_SHORTLIST_PICK: Pass1Pick = {
  handle: 'NOT_FOUND',
  confidence: 'high',
  why: 'empty shortlist',
};

/**
 * Pass 1 for one thread, in whichever of the two modes the run was planned in.
 *
 * `extract-always` is the original flow: `extract`, shortlist, `pick`. `regex-first`
 * inverts the order of cost — the deterministic shortlist goes to `pick` first, and the
 * model's `extract` is paid for only when that cannot produce an answer. Either way the
 * pass decides nothing about which threads continue: a thread with no shortlist and no
 * extraction lands on NOT_FOUND and still goes to pass 2.
 *
 * The fallback never *narrows* anything. The merged extraction is the union of the two
 * sides' ids and amounts (see `mergeExtractions`), so a thread that reaches `extract` ends
 * up with at least the shortlist the regex alone produced. The second `pick` is skipped
 * when the merged shortlist is identical to the first, because that call would be sent
 * the same rows and the same prompt and there is no reason to expect a different answer.
 */
async function runPass1Thread(
  prepared: Pass1Prepared,
  job: Pass1Prepared['jobs'][number],
  hooks: PipelineHooks,
): Promise<Pass1Result> {
  const { paths } = prepared;

  const callExtract = (): Promise<StageOutcome<PaymentExtraction>> =>
    callAndParse(
      hooks,
      'extract',
      prepared.extractSystem,
      job.extractText,
      PASS1.extractMaxTokens,
      job.threadId,
      paths.callsPath,
      parseExtraction,
    );

  const callPick = (text: string): Promise<StageOutcome<Pass1Pick>> =>
    callAndParse(
      hooks,
      'pick',
      prepared.pickSystem,
      text,
      PASS1.pickMaxTokens,
      job.threadId,
      paths.callsPath,
      parsePickJson,
    );

  const resolveOf = (
    pick: StageOutcome<Pass1Pick>,
    rows: ShortlistOut['rows'],
  ): { state: Pass1State; identified: { id: string; kind: 'ledger' | 'order' } | null } =>
    pick.value == null
      ? { state: 'UNRESOLVED_HANDLE' as Pass1State, identified: null }
      : resolvePickHandle(rows, pick.value.handle);

  /* ---------------------------------------------------------- regex-first */
  if (job.regex != null) {
    const { extraction: regex, shortlist: regexShortlist, pickText } = job.regex;
    const regexOut = shortlistOutOf(regexShortlist);

    let firstPick: StageOutcome<Pass1Pick> | null = null;
    if (regexShortlist.rows.length > 0) {
      firstPick = await callPick(pickText);
      const resolved = resolveOf(firstPick, regexOut.rows);
      /* Anything but the model's own "none of these" is the answer: a handle it named,
       * and equally a handle it invented. `UNRESOLVED_HANDLE` means the model was wrong
       * about the shortlist it was given, not that the shortlist was too short, and a
       * wider one is not the fix for it. */
      if (resolved.state !== 'NOT_FOUND') {
        return {
          thread_id: job.threadId,
          path_key: job.pathKey,
          extraction: null,
          extraction_raw: null,
          regex_extraction: regex,
          pass1_path: 'regex+pick',
          shortlist: regexOut,
          pick_raw: firstPick.raw,
          pick: firstPick.value,
          state: resolved.state,
          identified: resolved.identified,
          usage: {
            extract: null,
            pick: firstPick.usage,
            extract_attempts: 0,
            pick_attempts: firstPick.attempts,
          },
          timings: { extract_ms: 0, pick_ms: firstPick.ms },
        };
      }
    }

    /* Fallback: the regex had nothing to offer, or `pick` said none of it fits. */
    const extract = await callExtract();
    const merged = mergeExtractions(regex, extract.value ?? EMPTY_EXTRACTION);
    const mergedShortlist = shortlistCandidates(job.bundle, merged);
    const mergedOut = shortlistOutOf(mergedShortlist);

    const worthAnotherPick =
      mergedShortlist.rows.length > 0 &&
      (firstPick == null || !sameShortlist(regexShortlist, mergedShortlist));

    const emptyPath: Pass1Path = firstPick == null ? 'regex-empty→extract' : 'regex+pick→extract';
    const base = {
      thread_id: job.threadId,
      path_key: job.pathKey,
      extraction: extract.value,
      extraction_raw: extract.raw,
      regex_extraction: regex,
      shortlist: mergedOut,
    };

    if (!worthAnotherPick) {
      return {
        ...base,
        pass1_path: emptyPath,
        pick_raw: firstPick?.raw ?? null,
        pick: firstPick?.value ?? EMPTY_SHORTLIST_PICK,
        state: 'NOT_FOUND',
        identified: null,
        usage: {
          extract: extract.usage,
          pick: firstPick?.usage ?? null,
          extract_attempts: extract.attempts,
          pick_attempts: firstPick?.attempts ?? 0,
        },
        timings: { extract_ms: extract.ms, pick_ms: firstPick?.ms ?? 0 },
      };
    }

    const secondPick = await callPick(
      renderBundleText(job.bundle, { stage: 'pick', shortlist: mergedShortlist }),
    );
    const resolved = resolveOf(secondPick, mergedOut.rows);
    return {
      ...base,
      pass1_path: firstPick == null ? 'regex-empty→extract+pick' : 'regex+pick→extract+pick',
      pick_raw: secondPick.raw,
      pick: secondPick.value,
      state: resolved.state,
      identified: resolved.identified,
      usage: {
        extract: extract.usage,
        pick: addUsage(firstPick?.usage ?? null, secondPick.usage),
        extract_attempts: extract.attempts,
        pick_attempts: (firstPick?.attempts ?? 0) + secondPick.attempts,
      },
      timings: { extract_ms: extract.ms, pick_ms: (firstPick?.ms ?? 0) + secondPick.ms },
    };
  }

  /* -------------------------------------------------------- extract-always */
  const extract = await callExtract();
  /* A thread that would not parse twice is not dropped: it goes on with an extraction
   * that claims nothing, and the shortlist falls back to the proximity floor. */
  const shortlist = shortlistCandidates(job.bundle, extract.value ?? EMPTY_EXTRACTION);
  const shortlistOut = shortlistOutOf(shortlist);

  const base = {
    thread_id: job.threadId,
    path_key: job.pathKey,
    extraction: extract.value,
    extraction_raw: extract.raw,
    regex_extraction: null,
    shortlist: shortlistOut,
  };

  if (shortlist.rows.length === 0) {
    return {
      ...base,
      pass1_path: 'extract',
      pick_raw: null,
      pick: EMPTY_SHORTLIST_PICK,
      state: 'NOT_FOUND',
      identified: null,
      usage: {
        extract: extract.usage,
        pick: null,
        extract_attempts: extract.attempts,
        pick_attempts: 0,
      },
      timings: { extract_ms: extract.ms, pick_ms: 0 },
    };
  }

  const pick = await callPick(renderBundleText(job.bundle, { stage: 'pick', shortlist }));
  const resolved = resolveOf(pick, shortlistOut.rows);

  return {
    ...base,
    pass1_path: 'extract+pick',
    pick_raw: pick.raw,
    pick: pick.value,
    state: resolved.state,
    identified: resolved.identified,
    usage: {
      extract: extract.usage,
      pick: pick.usage,
      extract_attempts: extract.attempts,
      pick_attempts: pick.attempts,
    },
    timings: { extract_ms: extract.ms, pick_ms: pick.ms },
  };
}

async function runPass1(prepared: Pass1Prepared, hooks: PipelineHooks): Promise<RunOutcome> {
  const { jobs, paths } = prepared;

  const runThread = (job: Pass1Prepared['jobs'][number]): Promise<Pass1Result> =>
    runPass1Thread(prepared, job, hooks);

  log(hooks, '');
  log(
    hooks,
    `--go: pass 1 over ${jobs.length} threads, mode ${prepared.pass1Mode}, concurrency ${PASS1.concurrency}`,
  );

  let next = 0;
  let done = 0;
  let errors = 0;
  let stopped = false;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (hooks.isCancelled()) {
        stopped = true;
        return;
      }
      const index = next;
      next += 1;
      if (index >= jobs.length) return;
      const job = jobs[index];
      hooks.onProgress?.({ done, total: jobs.length, current: job.threadId });
      try {
        const result = await runThread(job);
        writeJsonFile(job.resultPath, result);
        done += 1;
        log(
          hooks,
          `[pass1 ${done}/${jobs.length}] ${job.threadId} ${result.state} · ${result.pass1_path}`,
        );
        hooks.onEvent(
          makeEvent({
            threadId: job.threadId,
            stage: 'pass1',
            state: result.state,
            latencyMs: result.timings.extract_ms + result.timings.pick_ms,
          }),
        );
      } catch (error) {
        done += 1;
        errors += 1;
        const message = (error as Error).message;
        log(hooks, `[pass1 ${done}/${jobs.length}] ${job.threadId} ERROR ${message.slice(0, 120)}`);
        hooks.onEvent(
          makeEvent({
            threadId: job.threadId,
            stage: 'pass1',
            state: 'ERROR',
            ok: false,
            error: message,
          }),
        );
      }
      hooks.onProgress?.({ done, total: jobs.length, current: null });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PASS1.concurrency, jobs.length) }, () => worker()),
  );

  log(hooks, '');
  if (stopped) log(hooks, 'pass 1 cancelled: no further threads were scheduled');
  log(
    hooks,
    `pass 1 finished: ${done - errors} written, ${errors} failed (no result file written)`,
  );
  log(hooks, `results in ${paths.pass1Dir}`);
  log(hooks, `calls logged to ${paths.callsPath}`);
  log(
    hooks,
    'counts and states: run pc-report.ts (it prints nothing until the pass is complete)',
  );
  return { status: stopped ? 'cancelled' : 'completed' };
}

/* -------------------------------------------------------------------- M3: pass 2 */

async function runPass2(prepared: Pass2Prepared, hooks: PipelineHooks): Promise<RunOutcome> {
  const { jobs, paths } = prepared;

  log(hooks, '');
  log(hooks, `--go: pass 2 over ${jobs.length} threads, concurrency ${PASS2.concurrency}`);

  const runThread = async (job: Pass2Prepared['jobs'][number]): Promise<Pass2Result> => {
    const result = await callAndReport(
      hooks,
      'read',
      messagesFor(prepared.readSystem, job.readText),
      { maxTokens: PASS2.readMaxTokens, threadId: job.threadId, callsPath: paths.callsPath },
    );
    return {
      thread_id: job.threadId,
      path_key: job.pathKey,
      /* Which prompt wrote this reading. Prompts are versioned by file and a reading is
       * only comparable with another produced by the same one — `fn1` was read with
       * `pc-read-v2`, and without this the two are indistinguishable on disk. */
      prompt_id: PASS2.readPromptId,
      pass1_state: job.pass1.state,
      identified: job.pass1.identified,
      reading: result.content,
      usage: result.usage,
      timing: { read_ms: result.latencyMs },
    };
  };

  let next = 0;
  let done = 0;
  let errors = 0;
  let stopped = false;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (hooks.isCancelled()) {
        stopped = true;
        return;
      }
      const index = next;
      next += 1;
      if (index >= jobs.length) return;
      const job = jobs[index];
      hooks.onProgress?.({ done, total: jobs.length, current: job.threadId });
      try {
        const result = await runThread(job);
        writeJsonFile(job.resultPath, result);
        done += 1;
        log(hooks, `[pass2 ${done}/${jobs.length}] ${job.threadId} ${job.pass1.state} ok`);
        hooks.onEvent(
          makeEvent({
            threadId: job.threadId,
            stage: 'pass2',
            state: job.pass1.state,
            latencyMs: result.timing.read_ms,
          }),
        );
      } catch (error) {
        done += 1;
        errors += 1;
        const message = (error as Error).message;
        log(
          hooks,
          `[pass2 ${done}/${jobs.length}] ${job.threadId} ${job.pass1.state} ERROR ${message.slice(0, 120)}`,
        );
        hooks.onEvent(
          makeEvent({
            threadId: job.threadId,
            stage: 'pass2',
            state: 'ERROR',
            ok: false,
            error: message,
          }),
        );
      }
      hooks.onProgress?.({ done, total: jobs.length, current: null });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PASS2.concurrency, jobs.length) }, () => worker()),
  );

  log(hooks, '');
  if (stopped) log(hooks, 'pass 2 cancelled: no further threads were scheduled');
  log(
    hooks,
    `pass 2 finished: ${done - errors} written, ${errors} failed (no result file written)`,
  );
  log(hooks, `readings in ${paths.pass2Dir}`);
  log(hooks, 'label guard and counts: run pc-report.ts over the completed pass');
  return { status: stopped ? 'cancelled' : 'completed' };
}

/* -------------------------------------------------------------------- M3: pass 3 */

const OneCallCategorySchema = z.object({
  name: z.string(),
  definition: z.string().default(''),
  what_removes_it: z.string().default(''),
  member_thread_ids: z.array(z.union([z.string(), z.number()])).default([]),
});
const OneCallSchema = z.object({
  categories: z.array(OneCallCategorySchema).default([]),
  unassigned: z.array(z.union([z.string(), z.number()])).default([]),
  notes: z.string().default(''),
});

const TwoStepCategorySchema = z.object({
  name: z.string(),
  definition: z.string().default(''),
  what_removes_it: z.string().default(''),
  example_thread_ids: z.array(z.union([z.string(), z.number()])).default([]),
});
const TwoStepSchema = z.object({
  categories: z.array(TwoStepCategorySchema).default([]),
  notes: z.string().default(''),
});

/** Every call of this induction, summed. The per-call detail is in llm-calls.ndjson. */
function sumUsage(usages: LLMUsage[]): LLMUsage | null {
  if (usages.length === 0) return null;
  const costs = usages.map((u) => u.total_cost_usd).filter((c): c is number => c != null);
  return {
    input_tokens: sum(usages.map((u) => u.input_tokens)),
    output_tokens: sum(usages.map((u) => u.output_tokens)),
    cache_creation_input_tokens: sum(usages.map((u) => u.cache_creation_input_tokens)),
    cache_read_input_tokens: sum(usages.map((u) => u.cache_read_input_tokens)),
    total_cost_usd: costs.length === 0 ? null : sum(costs),
  };
}

async function runPass3(prepared: Pass3Prepared, hooks: PipelineHooks): Promise<RunOutcome> {
  const { paths, readings, batches, mode, label, outPath } = prepared;

  log(hooks, '');

  if (mode === 'one-call') {
    log(hooks, '--go: pass 3, one call');
    hooks.onProgress?.({ done: 0, total: 1, current: 'induce' });

    const result = await callAndReport(
      hooks,
      'induce',
      messagesFor(prepared.induceSystem, prepared.induceUserMessage),
      {
        maxTokens: prepared.induceMaxTokens,
        responseFormat: 'JSON',
        threadId: null,
        callsPath: paths.callsPath,
      },
    );

    let parsed: z.infer<typeof OneCallSchema> | null = null;
    let parseError: string | null = null;
    try {
      const candidate = OneCallSchema.safeParse(parseLlmJson(result.content));
      if (candidate.success) parsed = candidate.data;
      else parseError = candidate.error.message;
    } catch (error) {
      parseError = (error as Error).message;
    }

    const out: Pass3Result = {
      categories: (parsed?.categories ?? []).map((category) => ({
        name: category.name,
        definition: category.definition,
        what_removes_it: category.what_removes_it,
        member_thread_ids: category.member_thread_ids.map(String),
      })),
      unassigned: (parsed?.unassigned ?? []).map(String),
      notes: parsed?.notes ?? '',
      raw: { induce: result.content, assign: [] },
      usage: result.usage,
      mode,
    };
    writeJsonFile(outPath, out);
    hooks.onEvent(
      makeEvent({
        stage: 'induce',
        state: parseError == null ? 'parsed' : 'UNPARSED',
        ok: parseError == null,
        error: parseError,
        latencyMs: result.latencyMs,
      }),
    );
    hooks.onProgress?.({ done: 1, total: 1, current: null });

    log(hooks, `[pass3 1/1] induction ${label} ${parseError == null ? 'parsed' : 'UNPARSED'}`);
    if (parseError != null) {
      log(hooks, `  the raw model output is kept in the result file; parse error: ${parseError}`);
    }
    log(hooks, `wrote ${outPath}`);
    log(hooks, `the category table: run pc-report.ts --label ${label}`);
    return { status: 'completed' };
  }

  /* --- two-step: induce, then assign in batches --------------------------------- */

  const total = 1 + batches.length;
  log(
    hooks,
    `--go: pass 3 two-step, 1 induce call then ${batches.length} assign ${batches.length === 1 ? 'call' : 'calls'}, concurrency ${PASS3.assignConcurrency}`,
  );
  if (prepared.induceSample != null) {
    log(
      hooks,
      `induce over ${prepared.induceSample.size} of ${readings.length} readings (seeded sample, seed ${prepared.induceSample.seed}); all ${readings.length} are assigned`,
    );
  }
  hooks.onProgress?.({ done: 0, total, current: 'induce' });

  const usages: LLMUsage[] = [];
  const induceResult = await callAndReport(
    hooks,
    'induce',
    messagesFor(prepared.induceSystem, prepared.induceUserMessage),
    {
      maxTokens: prepared.induceMaxTokens,
      responseFormat: 'JSON',
      threadId: null,
      callsPath: paths.callsPath,
    },
  );
  usages.push(induceResult.usage);

  let induced: z.infer<typeof TwoStepSchema> | null = null;
  let induceParseError: string | null = null;
  try {
    const candidate = TwoStepSchema.safeParse(parseLlmJson(induceResult.content));
    if (candidate.success) induced = candidate.data;
    else induceParseError = candidate.error.message;
  } catch (error) {
    induceParseError = (error as Error).message;
  }

  const inducedCategories = induced?.categories ?? [];
  log(
    hooks,
    `[pass3 induce] ${induceParseError == null ? `parsed · ${inducedCategories.length} categories` : 'UNPARSED'}`,
  );
  hooks.onEvent(
    makeEvent({
      stage: 'induce',
      state: induceParseError == null ? 'parsed' : 'UNPARSED',
      ok: induceParseError == null,
      error: induceParseError,
      latencyMs: induceResult.latencyMs,
    }),
  );
  hooks.onProgress?.({ done: 1, total, current: null });

  if (inducedCategories.length === 0) {
    /* Nothing to assign against. The raw answer is kept so the failure is inspectable,
     * and no thread is called unassigned — that would be a claim this run cannot make. */
    const emptyOut: Pass3Result = {
      categories: [],
      unassigned: [],
      notes: induced?.notes ?? '',
      raw: { induce: induceResult.content, assign: [] },
      usage: sumUsage(usages),
      mode,
    };
    if (prepared.induceSample != null) emptyOut.induce_sample = prepared.induceSample;
    writeJsonFile(outPath, emptyOut);
    throw new PcError(
      `the induce call returned no categories${induceParseError == null ? '' : ` (parse error: ${induceParseError})`}; the assign calls were not sent. The raw induce output is in ${outPath} — re-run with a new label`,
      500,
    );
  }

  const categoryBlock = renderCategoryBlock(inducedCategories);
  log(hooks, `[pass3 induce] category block ${categoryBlock.length.toLocaleString('en-GB')} chars`);

  /** Thread id → the category number the model gave it, or `null` for `unassigned`. */
  const answers = new Map<string, { category: number | null; reason: string }>();
  const rawAssign: string[] = [];
  let unknownIdCount = 0;
  let needRetry: ReadingBlock[] = [];
  const failedBatches: string[] = [];
  let stopped = false;
  let doneCalls = 1;

  /**
   * The batches, `PASS3.assignConcurrency` at a time. Everything a batch produces goes
   * into its own slot rather than onto a shared array, so the result file reads in
   * batch order whichever call finishes first: `null` in `rawByBatch` means the batch
   * was never scheduled (cancellation), `''` means it was sent and failed. Cancellation
   * is the same cooperative shape as passes 1 and 2 — stop scheduling, let what is in
   * flight finish.
   */
  const rawByBatch: (string | null)[] = new Array<string | null>(batches.length).fill(null);
  const retryByBatch: ReadingBlock[][] = batches.map(() => []);
  const failedByBatch: (string | null)[] = new Array<string | null>(batches.length).fill(null);
  let nextBatch = 0;

  const assignWorker = async (): Promise<void> => {
    for (;;) {
      if (hooks.isCancelled()) {
        stopped = true;
        return;
      }
      const index = nextBatch;
      nextBatch += 1;
      if (index >= batches.length) return;
      const batch = batches[index];
      const userMessage = assignUserMessage(categoryBlock, batch);
      let content: string;
      try {
        const result = await callAndReport(
          hooks,
          'assign',
          messagesFor(prepared.assignSystem!, userMessage),
          { maxTokens: PASS3.assignMaxTokens, threadId: null, callsPath: paths.callsPath },
        );
        usages.push(result.usage);
        content = result.content;
      } catch (error) {
        const message = (error as Error).message;
        failedByBatch[index] = `batch ${index + 1}: ${message.slice(0, 120)}`;
        rawByBatch[index] = '';
        retryByBatch[index] = batch;
        log(hooks, `[pass3 assign ${index + 1}/${batches.length}] ERROR ${message.slice(0, 120)}`);
        hooks.onEvent(
          makeEvent({
            stage: 'assign',
            state: `batch ${index + 1}`,
            ok: false,
            error: message,
          }),
        );
        doneCalls += 1;
        hooks.onProgress?.({ done: doneCalls, total, current: null });
        continue;
      }
      rawByBatch[index] = content;

      const parsedBatch = parseAssignLines(
        content,
        batch.map((r) => r.threadId),
        inducedCategories.length,
      );
      for (const [threadId, outcome] of parsedBatch.assigned) answers.set(threadId, outcome);
      unknownIdCount += parsedBatch.unknown.length;
      const toRetry = new Set([
        ...parsedBatch.missing,
        ...parsedBatch.invalid.map((row) => row.thread_id),
      ]);
      retryByBatch[index] = batch.filter((r) => toRetry.has(r.threadId));
      log(
        hooks,
        `[pass3 assign ${index + 1}/${batches.length}] ${parsedBatch.assigned.size}/${batch.length} placed · ${parsedBatch.missing.length} missing · ${parsedBatch.invalid.length} invalid · ${parsedBatch.unknown.length} unknown ids ignored`,
      );
      hooks.onEvent(
        makeEvent({ stage: 'assign', state: `batch ${index + 1} placed ${parsedBatch.assigned.size}/${batch.length}` }),
      );
      doneCalls += 1;
      hooks.onProgress?.({ done: doneCalls, total, current: null });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PASS3.assignConcurrency, batches.length) }, () =>
      assignWorker(),
    ),
  );

  for (const content of rawByBatch) if (content !== null) rawAssign.push(content);
  for (const line of failedByBatch) if (line !== null) failedBatches.push(line);
  needRetry = retryByBatch.flat();

  /* One retry each, alone, so a single bad line cannot cost a whole batch again. */
  if (needRetry.length > 0 && !stopped) {
    log(hooks, `[pass3 assign] retrying ${needRetry.length} thread(s) one at a time`);
  }
  for (const reading of needRetry) {
    if (stopped || hooks.isCancelled()) {
      stopped = true;
      break;
    }
    try {
      const result = await callAndReport(
        hooks,
        'assign',
        messagesFor(prepared.assignSystem!, assignUserMessage(categoryBlock, [reading])),
        {
          maxTokens: PASS3.assignMaxTokens,
          threadId: reading.threadId,
          callsPath: paths.callsPath,
        },
      );
      usages.push(result.usage);
      rawAssign.push(result.content);
      const parsedOne = parseAssignLines(
        result.content,
        [reading.threadId],
        inducedCategories.length,
      );
      unknownIdCount += parsedOne.unknown.length;
      const outcome = parsedOne.assigned.get(reading.threadId);
      log(
        hooks,
        `[pass3 assign retry] ${reading.threadId} ${outcome === undefined ? 'still no valid assignment' : `→ ${outcome.category ?? 'unassigned'}`}`,
      );
      if (outcome !== undefined) answers.set(reading.threadId, outcome);
      hooks.onEvent(
        makeEvent({
          threadId: reading.threadId,
          stage: 'assign',
          state: outcome === undefined ? 'no valid assignment' : String(outcome.category ?? 'unassigned'),
          latencyMs: result.latencyMs,
        }),
      );
    } catch (error) {
      rawAssign.push('');
      const message = (error as Error).message;
      log(hooks, `[pass3 assign retry] ${reading.threadId} ERROR ${message.slice(0, 120)}`);
      hooks.onEvent(
        makeEvent({
          threadId: reading.threadId,
          stage: 'assign',
          state: 'ERROR',
          ok: false,
          error: message,
        }),
      );
    }
  }

  const categories: Pass3Category[] = inducedCategories.map((category) => ({
    name: category.name,
    definition: category.definition,
    what_removes_it: category.what_removes_it,
    member_thread_ids: [],
  }));
  const unassigned: string[] = [];

  /* Snapshot order, so `member_thread_ids` is not ordered by whichever batch finished. */
  for (const reading of readings) {
    const outcome = answers.get(reading.threadId);
    if (outcome === undefined) {
      unassigned.push(`${reading.threadId} — no valid assignment returned`);
      continue;
    }
    if (outcome.category == null) {
      unassigned.push(
        `${reading.threadId} — ${outcome.reason === '' ? 'the model returned unassigned with no reason' : outcome.reason}`,
      );
      continue;
    }
    categories[outcome.category - 1].member_thread_ids.push(reading.threadId);
  }

  const out: Pass3Result = {
    categories,
    unassigned,
    notes: induced?.notes ?? '',
    raw: { induce: induceResult.content, assign: rawAssign },
    usage: sumUsage(usages),
    mode,
  };
  if (prepared.induceSample != null) out.induce_sample = prepared.induceSample;
  writeJsonFile(outPath, out);

  log(hooks, '');
  if (stopped) log(hooks, 'pass 3 cancelled: no further assign calls were scheduled');
  log(
    hooks,
    `pass 3 two-step finished: ${inducedCategories.length} categories · ${readings.length - unassigned.length} threads placed · ${unassigned.length} unassigned`,
  );
  if (unknownIdCount > 0) {
    log(
      hooks,
      `  ${unknownIdCount} thread id(s) in the output were not in their batch and were ignored`,
    );
  }
  for (const line of failedBatches) log(hooks, `  ${line}`);
  log(hooks, `wrote ${outPath}`);
  log(hooks, `the category table: run pc-report.ts --label ${label}`);
  return { status: stopped ? 'cancelled' : 'completed' };
}

/* ------------------------------------------------------------------ M4: all passes */

/** The threads in `ids` with no result file in `dir` — a pass's remaining work. */
function unfinishedThreads(dir: string, ids: string[]): string[] {
  return ids.filter((id) => !existsSync(resolve(dir, `${id}.json`)));
}

/**
 * Hooks for one stage of a multi-stage job. Events, prose, usage and the cancel flag
 * pass straight through; only progress is rewritten, onto the job's own scale, so the
 * bar does not restart at every pass. The stage's own `total` is discarded.
 */
function stageHooks(hooks: PipelineHooks, offset: number, total: number): PipelineHooks {
  return {
    onEvent: (event) => hooks.onEvent(event),
    isCancelled: () => hooks.isCancelled(),
    onLog: (line) => hooks.onLog?.(line),
    onProgress: (progress) =>
      hooks.onProgress?.({
        done: Math.min(total, offset + progress.done),
        total,
        current: progress.current,
      }),
    onUsage: (usage) => hooks.onUsage?.(usage),
  };
}

/**
 * Pass 1 → pass 2 → pass 3, sequentially, in one job.
 *
 * Each pass is prepared only when the one before it has finished, because each reads
 * the previous pass's files: planning all three up front would plan pass 2 against
 * answers that do not exist yet. That is why the plan calls its later stages estimates.
 *
 * A pass that leaves a thread unfinished is swept once more — the queue *is* the set of
 * missing result files, so a retry is the same prepare over what is left. If anything is
 * still unfinished after that, the job fails there and nothing downstream is sent: a
 * taxonomy induced over the threads that happened to succeed is a taxonomy of whatever
 * succeeded. Cancellation is checked between passes and inside each of them.
 */
async function runAll(prepared: AllPrepared, hooks: PipelineHooks): Promise<RunOutcome> {
  const { snapshot, run, paths, threadIds, request } = prepared;
  const total = prepared.totalUnits;
  const perPass = threadIds.length;
  const force = request.force === true;

  const sweep = async (
    pass: 'pass1' | 'pass2',
    dir: string,
    offset: number,
  ): Promise<{ status: RunOutcome['status']; left: number }> => {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (hooks.isCancelled()) {
        return { status: 'cancelled', left: unfinishedThreads(dir, threadIds).length };
      }
      const left = unfinishedThreads(dir, threadIds);
      /* `--force` re-runs everything, but only on the first attempt: the second is a
       * retry of what failed, not a second re-run of what already succeeded. */
      const targets = attempt === 1 && force ? threadIds : left;
      if (targets.length === 0) break;
      log(
        hooks,
        attempt === 1
          ? `[all] ${pass} over ${targets.length} thread(s)`
          : `[all] ${pass} retry over ${targets.length} unfinished thread(s)`,
      );
      const stageRequest: PassRequest = {
        ...request,
        pass,
        threads: targets,
        n: undefined,
        force: attempt === 1 && force,
      };
      const stageOffset = offset + perPass - left.length;
      const outcome =
        pass === 'pass1'
          ? await runPass1(
              await preparePass1(snapshot, run, stageRequest),
              stageHooks(hooks, stageOffset, total),
            )
          : await runPass2(
              await preparePass2(snapshot, run, stageRequest),
              stageHooks(hooks, stageOffset, total),
            );
      if (outcome.status === 'cancelled') {
        return { status: 'cancelled', left: unfinishedThreads(dir, threadIds).length };
      }
    }
    const left = unfinishedThreads(dir, threadIds).length;
    hooks.onProgress?.({ done: Math.min(total, offset + perPass - left), total, current: null });
    return { status: 'completed', left };
  };

  log(hooks, '');
  log(
    hooks,
    `--go: all passes over ${perPass} thread(s) · induction label ${prepared.label} · mode ${prepared.mode}`,
  );
  hooks.onProgress?.({ done: 0, total, current: 'pass1' });

  for (const [pass, dir, offset] of [
    ['pass1', paths.pass1Dir, 0],
    ['pass2', paths.pass2Dir, perPass],
  ] as const) {
    const outcome = await sweep(pass, dir, offset);
    if (outcome.status === 'cancelled') {
      log(hooks, `all passes cancelled during ${pass}`);
      return { status: 'cancelled' };
    }
    if (outcome.left > 0) {
      throw new PcError(
        `${pass} left ${outcome.left} of ${perPass} thread(s) unfinished after one retry — pass 3 was not sent. The finished threads are on disk; start the run again to pick up only what is missing`,
        500,
      );
    }
  }

  if (hooks.isCancelled()) {
    log(hooks, 'all passes cancelled before pass 3');
    return { status: 'cancelled' };
  }

  /* Pass 3 is prepared now, against readings that exist. It refuses on its own terms —
   * an existing induction label, or a snapshot thread with no reading — and that
   * refusal is the job's error rather than a silently skipped pass. */
  const pass3 = await preparePass3(snapshot, run, {
    ...request,
    pass: 'pass3',
    threads: undefined,
    n: undefined,
    force: false,
    label: prepared.label,
    mode: prepared.mode,
  });
  if (pass3.blockers.length > 0) throw new PcError(pass3.blockers[0], 409);
  return runPass3(pass3, stageHooks(hooks, perPass * 2, total));
}

/* ------------------------------------------------------------------- M2b: measure */

interface MeasureRow {
  thread_id: string;
  stage: MeasureJob['stage'];
  model: string;
  provider: string;
  chars: number;
  ms: number;
  usage: LLMUsage | null;
  error: string | null;
}

/**
 * Renders the three stages and asks the proxy to count them for real, with
 * `max_tokens: 1` — the answer is `usage.input_tokens`, not the text. Written to
 * `<snapshot>/measure/tokens-<ts>.json`.
 */
async function runMeasure(prepared: MeasurePrepared, hooks: PipelineHooks): Promise<RunOutcome> {
  const { jobs, threadIds } = prepared;
  const provider = PROBLEM_CLASSIFIER_MODELS.provider;

  /** One retry, then the row carries the error and the sweep carries on. */
  const measure = async (job: MeasureJob): Promise<MeasureRow> => {
    const model = modelForStage(job.stage);
    const messages = messagesFor(MEASURE.systemPrompt, job.text);
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const started = Date.now();
      try {
        const response = await analyzeWithLLMUsage(messages, {
          model,
          provider,
          maxTokens: MEASURE.maxTokens,
          temperature: 0,
        });
        hooks.onUsage?.({
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          costUsd: response.usage.total_cost_usd,
          ok: true,
        });
        return {
          thread_id: job.threadId,
          stage: job.stage,
          model,
          provider,
          chars: job.chars,
          ms: Date.now() - started,
          usage: response.usage,
          error: null,
        };
      } catch (error) {
        lastError = error;
        hooks.onUsage?.({ inputTokens: 0, outputTokens: 0, costUsd: null, ok: false });
        log(
          hooks,
          `  ${job.threadId} ${job.stage}: attempt ${attempt + 1} failed after ${Date.now() - started}ms — ${(error as Error).message}`,
        );
      }
    }
    return {
      thread_id: job.threadId,
      stage: job.stage,
      model,
      provider,
      chars: job.chars,
      ms: 0,
      usage: null,
      error: (lastError as Error)?.message ?? 'unknown error',
    };
  };

  log(hooks, '');
  log(hooks, `--go: sending ${jobs.length} calls, concurrency ${MEASURE.concurrency}`);

  const rows: (MeasureRow | undefined)[] = new Array<MeasureRow | undefined>(jobs.length);
  let next = 0;
  let done = 0;
  let stopped = false;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (hooks.isCancelled()) {
        stopped = true;
        return;
      }
      const index = next;
      next += 1;
      if (index >= jobs.length) return;
      const job = jobs[index];
      hooks.onProgress?.({ done, total: jobs.length, current: job.threadId });
      const row = await measure(job);
      rows[index] = row;
      done += 1;
      hooks.onEvent(
        makeEvent({
          threadId: job.threadId,
          stage: job.stage,
          state: row.usage == null ? 'ERROR' : `${row.usage.input_tokens} in`,
          ok: row.error == null,
          error: row.error,
          latencyMs: row.ms,
        }),
      );
      hooks.onProgress?.({ done, total: jobs.length, current: null });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(MEASURE.concurrency, jobs.length) }, () => worker()),
  );

  const measured: MeasureRow[] = rows.filter((row): row is MeasureRow => row != null);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = safeDataPath(prepared.snapshot, 'measure');
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, `tokens-${timestamp}.json`);
  writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        snapshot: prepared.snapshot,
        created_at: new Date().toISOString(),
        threads: threadIds.length,
        provider,
        models: {
          extract: modelForStage('extract'),
          pick: modelForStage('pick'),
          read: modelForStage('read'),
        },
        max_tokens: MEASURE.maxTokens,
        system_prompt: MEASURE.systemPrompt,
        rows: measured,
      },
      null,
      2,
    )}\n`,
  );

  for (const line of renderMeasureSummaryLines(measured, outPath)) log(hooks, line);
  return { status: stopped ? 'cancelled' : 'completed' };
}

/**
 * What `pc-measure-tokens.ts --go` printed after the sweep: per-stage token
 * quantiles, the measured chars/token ratio, cost and latency, then the
 * over-the-window count. Prose and aggregates, so it goes out through `onLog` only.
 */
function renderMeasureSummaryLines(rows: MeasureRow[], outPath: string): string[] {
  const lines: string[] = [''];
  for (const stage of MEASURE.stages) {
    const stageRows = rows.filter((row) => row.stage === stage);
    const ok = stageRows.filter((row) => row.usage != null);
    const failed = stageRows.length - ok.length;
    lines.push(
      `== ${stage} · ${modelForStage(stage)} · ${ok.length} measured, ${failed} failed`,
    );
    if (ok.length === 0) {
      lines.push('  no usage returned for this stage');
      continue;
    }
    const tokens = ok.map((row) => row.usage!.input_tokens);
    const chars = ok.map((row) => row.chars);
    const latency = ok.map((row) => row.ms);
    lines.push(
      `  input tokens   p50 ${pct(tokens, 50)}  p90 ${pct(tokens, 90)}  max ${pct(tokens, 100)}  sum ${sum(tokens)}`,
    );
    lines.push(`  chars/token    ${(sum(chars) / sum(tokens)).toFixed(2)}`);
    const priced = ok
      .map((row) => row.usage!.total_cost_usd)
      .filter((cost): cost is number => cost != null);
    lines.push(
      `  cost           ${priced.length === 0 ? 'not returned' : `${usd(sum(priced))} over ${priced.length} of ${ok.length} calls`}`,
    );
    lines.push(`  latency ms     p50 ${pct(latency, 50)}  max ${pct(latency, 100)}`);
  }
  const overWindow = new Set(
    rows
      .filter(
        (row) =>
          row.stage !== 'read' && row.usage != null && row.usage.input_tokens > MEASURE.windowTokens,
      )
      .map((row) => row.thread_id),
  );
  lines.push('');
  lines.push(
    `threads over ${MEASURE.windowTokens.toLocaleString('en-GB')} measured input tokens on extract or pick: ${overWindow.size}`,
  );
  lines.push(`wrote ${outPath}`);
  return lines;
}

/* --------------------------------------------------------------------- runPass */

/**
 * The only function in this tool that spends tokens. It refuses to start when the
 * prepared plan carries blockers, so a caller cannot route round the plan step.
 */
export async function runPass(
  snapshot: string,
  run: string,
  request: PassRequest,
  hooks: PipelineHooks,
  prepared?: Prepared,
): Promise<RunOutcome> {
  const plan = prepared ?? (await preparePass(snapshot, run, request));
  if (plan.blockers.length > 0) {
    throw new PcError(plan.blockers[0], 409);
  }
  switch (plan.pass) {
    case 'pass1':
      return runPass1(plan, hooks);
    case 'pass2':
      return runPass2(plan, hooks);
    case 'pass3':
      return runPass3(plan, hooks);
    case 'measure':
      return runMeasure(plan, hooks);
    case 'all':
      return runAll(plan, hooks);
  }
}

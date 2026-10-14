/**
 * Payment problem classifier — everything that only reads what is already on disk.
 *
 * The snapshot and run listings, the per-thread views, the report and the pass-3
 * comparison. No BigQuery, no proxy, no writes (`createRun` makes an empty directory
 * and that is the whole of it), so every function here is safe to call from a request
 * handler.
 *
 * Two rules from the CLI hold here unchanged:
 *  - order is the snapshot file's order everywhere, never a sort;
 *  - no aggregate is produced for a pass that is not complete over the whole snapshot.
 *    `buildReport` is the only function that counts anything, and it gates every count.
 */
import { existsSync, readFileSync, readdirSync, mkdirSync, statSync } from 'fs';
import { resolve, sep } from 'path';

import {
  categoryLabel,
  renderBundleText,
  renderIdentifiedSummary,
  type ThreadBundle,
} from './bundle.js';
import {
  NAME_RE,
  PASS1_STATES,
  PASS2_HEADINGS,
  PC_DATA_ROOT,
  RunPaths,
  labelGuardFlags,
  loadBundle,
  loadSnapshotThreads,
  pct,
  readJsonFile,
  sum,
  usd,
  type Pass1Result,
  type Pass2Result,
  type Pass3Result,
  type SnapshotThread,
} from './runner.js';
import {
  PcError,
  UNASSIGNED_CATEGORY_KEY,
  type ComparePass3,
  type LatestRun,
  type PcDefaults,
  type Report,
  type ReportCategory,
  type ReportCrosstabRow,
  type ReportScenarioCount,
  type ReportStageUsage,
  type RunSummary,
  type SnapshotSummary,
  type ThreadDetail,
  type ThreadRow,
} from './pipeline-types.js';

export const DEFAULT_INDUCTION_LABEL = 'a';

export const PILOT_NOTICE =
  'Pilot output proves the pipeline; these counts are not population shares.';

/** The CX Workstation. One host: the tool is read by the team that works in it. */
export const WS_BASE_URL = 'https://chat-workstation.k1.anna.money';

export function wsDialogueUrl(alias: string, dialogueId: string): string {
  return `${WS_BASE_URL}/${alias}/tasks/dialogues?dialogueId=${dialogueId}&chatWindow=chat`;
}

/**
 * `alias` is the *task's* own alias, not the thread's customer. An RM hold task is
 * raised against whichever alias the alert landed on, and a Workstation URL built from
 * the wrong alias opens an empty queue.
 */
export function wsTaskUrl(alias: string, taskId: string | number): string {
  return `${WS_BASE_URL}/${alias}/tasks/agent-tasks?taskId=${taskId}`;
}

/** The customer's opening words, for a list row. */
export const FIRST_MESSAGE_CHARS = 160;
/** The reading's own opening, for a list row. */
export const WHAT_HAPPENED_CHARS = 200;

/* ------------------------------------------------------------------ path guard */

/**
 * A name from a URL or a flag, checked twice: against the charset, and against the
 * resolved path actually landing under `data/problem-classifier/`. The second check is
 * the one that matters — the charset alone already excludes `/` and `..`, but a future
 * caller joining names together would slip past it.
 */
export function assertName(kind: string, value: string): string {
  if (!NAME_RE.test(value)) {
    throw new PcError(`${kind} may only contain [A-Za-z0-9._-]`, 400);
  }
  return value;
}

export function safeDataPath(...segments: string[]): string {
  const path = resolve(PC_DATA_ROOT, ...segments);
  if (path !== PC_DATA_ROOT && !path.startsWith(`${PC_DATA_ROOT}${sep}`)) {
    throw new PcError('resolved path escapes data/problem-classifier/', 400);
  }
  return path;
}

/* -------------------------------------------------------------------- snapshots */

interface PopulationFile {
  manifest: {
    created_at?: string;
    date_from?: string;
    date_to?: string;
    as_of?: string | null;
    seed?: number;
    counts?: {
      total_threads?: number;
      total_dialogues?: number;
      total_customers?: number;
      by_category?: { path_key: string; threads: number; dialogues: number; customers: number }[];
    };
  };
  threads: SnapshotThread[];
}

interface BuildFile {
  finished_at?: string;
  per_thread?: {
    thread_id: string;
    n_messages?: number;
    n_tasks?: number;
  }[];
}

export function populationPath(snapshot: string): string {
  return safeDataPath(assertName('snapshot name', snapshot), 'population.json');
}

function readPopulation(snapshot: string): PopulationFile {
  const path = populationPath(snapshot);
  if (!existsSync(path)) throw new PcError(`no snapshot ${snapshot}`, 404);
  return JSON.parse(readFileSync(path, 'utf8')) as PopulationFile;
}

export function snapshotExists(snapshot: string): boolean {
  return existsSync(populationPath(snapshot));
}

/**
 * The seed in the snapshot's manifest — the one every deterministic draw over this
 * snapshot is made with, so the population shuffle and pass 3's induce sample are
 * reproducible from the file rather than from a run's own choice.
 */
export function snapshotSeed(snapshot: string): number {
  const seed = readPopulation(snapshot).manifest.seed;
  if (seed == null) {
    throw new PcError(
      `snapshot ${snapshot} has no seed in its manifest — it predates the seeded shuffle and cannot be sampled reproducibly`,
    );
  }
  return seed;
}

/** The build manifest `pc-build-bundles.ts` writes, or `null` before a first build. */
export function readBuildFile(snapshot: string): BuildFile | null {
  const path = safeDataPath(assertName('snapshot name', snapshot), 'bundles', '_build.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as BuildFile;
  } catch {
    return null;
  }
}

export function bundlePath(snapshot: string, threadId: string): string {
  return safeDataPath(
    assertName('snapshot name', snapshot),
    'bundles',
    `${assertName('thread id', threadId)}.json`,
  );
}

/** Bundles are "built" only when every thread in the snapshot has one. */
export function bundlesBuilt(snapshot: string, threads: SnapshotThread[]): boolean {
  if (threads.length === 0) return false;
  return threads.every((thread) => existsSync(bundlePath(snapshot, thread.thread_id)));
}

export function runNames(snapshot: string): string[] {
  const dir = safeDataPath(assertName('snapshot name', snapshot), 'runs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && NAME_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export function summariseSnapshot(snapshot: string): SnapshotSummary {
  const file = readPopulation(snapshot);
  const manifest = file.manifest ?? {};
  const counts = manifest.counts ?? {};
  const threads = file.threads ?? [];
  const build = readBuildFile(snapshot);
  const built = bundlesBuilt(snapshot, threads);
  return {
    name: snapshot,
    dateFrom: manifest.date_from ?? '',
    dateTo: manifest.date_to ?? '',
    asOf: manifest.as_of ?? null,
    seed: manifest.seed ?? 0,
    createdAt: manifest.created_at ?? '',
    counts: {
      totalThreads: counts.total_threads ?? threads.length,
      totalDialogues: counts.total_dialogues ?? 0,
      totalCustomers: counts.total_customers ?? 0,
      byCategory: (counts.by_category ?? []).map((row) => ({
        pathKey: row.path_key,
        category: categoryLabel(row.path_key),
        threads: row.threads,
        dialogues: row.dialogues,
        customers: row.customers,
      })),
    },
    bundlesBuilt: built,
    bundlesBuiltAt: built ? (build?.finished_at ?? null) : null,
    runs: runNames(snapshot),
    latestRun: latestRunFor(snapshot, threads),
  };
}

export function listSnapshots(): SnapshotSummary[] {
  if (!existsSync(PC_DATA_ROOT)) return [];
  return readdirSync(PC_DATA_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && NAME_RE.test(entry.name))
    .map((entry) => entry.name)
    .filter((name) => existsSync(resolve(PC_DATA_ROOT, name, 'population.json')))
    .sort()
    .map((name) => summariseSnapshot(name));
}

/** The snapshot's threads in file order — the order every list in this tool keeps. */
export function snapshotThreadList(snapshot: string): {
  threadId: string;
  pathKey: string;
  category: string;
  customerAlias: string;
  firstDialogueAt: string;
  nDialogues: number;
  dialogueIds: string[];
}[] {
  const file = readPopulation(snapshot);
  return (file.threads ?? []).map((thread) => {
    /* The population file is the thread's membership list, so the dialogue ids come
     * from it rather than the bundle: they are then available before a bundle exists,
     * and in the snapshot's own thread order. */
    const dialogues =
      (thread as SnapshotThread & { dialogues?: { dialogue_id?: string }[] }).dialogues ?? [];
    return {
      threadId: thread.thread_id,
      pathKey: thread.path_key,
      category: categoryLabel(thread.path_key),
      customerAlias: thread.customer_alias,
      firstDialogueAt: thread.first_dialogue_at,
      nDialogues: dialogues.length,
      dialogueIds: dialogues.map((dialogue) => String(dialogue.dialogue_id ?? '')),
    };
  });
}

/* -------------------------------------------------------------------- the runs */

export interface CallLine {
  stage: string;
  thread_id: string | null;
  input_tokens: number;
  output_tokens: number;
  total_cost_usd: number | null;
  latency_ms: number;
  ok: boolean;
}

export function readCallLog(callsPath: string): CallLine[] {
  if (!existsSync(callsPath)) return [];
  return readFileSync(callsPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as CallLine);
}

function usageFromCalls(lines: CallLine[]): RunSummary['usage'] {
  const ok = lines.filter((line) => line.ok);
  const costs = ok.map((line) => line.total_cost_usd).filter((c): c is number => c != null);
  return {
    calls: lines.length,
    inputTokens: sum(ok.map((line) => line.input_tokens)),
    outputTokens: sum(ok.map((line) => line.output_tokens)),
    costUsd: costs.length === 0 ? null : sum(costs),
    errors: lines.length - ok.length,
  };
}

function countResults(dir: string): Set<string> {
  if (!existsSync(dir)) return new Set();
  return new Set(
    readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length)),
  );
}

export function pass3Labels(pass3Dir: string): string[] {
  return [...countResults(pass3Dir)].sort();
}

export function summariseRun(snapshot: string, run: string): RunSummary {
  const paths = RunPaths(snapshot, run);
  const threads = loadSnapshotThreads(snapshot);
  const total = threads.length;
  const pass1 = countResults(paths.pass1Dir);
  const pass2 = countResults(paths.pass2Dir);
  let createdAt = '';
  try {
    createdAt = statSync(paths.runDir).birthtime.toISOString();
  } catch {
    createdAt = '';
  }
  return {
    run,
    createdAt,
    passes: {
      pass1: { done: threads.filter((t) => pass1.has(t.thread_id)).length, total },
      pass2: { done: threads.filter((t) => pass2.has(t.thread_id)).length, total },
      pass3: { labels: pass3Labels(paths.pass3Dir) },
    },
    usage: usageFromCalls(readCallLog(paths.callsPath)),
  };
}

export function listRuns(snapshot: string): RunSummary[] {
  if (!snapshotExists(snapshot)) throw new PcError(`no snapshot ${snapshot}`, 404);
  return runNames(snapshot).map((run) => summariseRun(snapshot, run));
}

/**
 * The run worth opening: the most pass-2 readings, newest on a tie. Readings are the
 * measure because they are what the tool is read for — a run with pass 1 and no reading
 * has nothing to show, however recent it is.
 */
export function latestRunFor(snapshot: string, threads: SnapshotThread[]): LatestRun | null {
  let best: LatestRun | null = null;
  let bestCreatedAt = '';
  for (const run of runNames(snapshot)) {
    /* `create: false`: listing runs must not bring a run directory into being. */
    const paths = RunPaths(snapshot, run, { create: false });
    const pass1 = countResults(paths.pass1Dir);
    const pass2 = countResults(paths.pass2Dir);
    const candidate: LatestRun = {
      run,
      pass1Done: threads.filter((thread) => pass1.has(thread.thread_id)).length,
      pass2Done: threads.filter((thread) => pass2.has(thread.thread_id)).length,
      pass3Labels: pass3Labels(paths.pass3Dir),
    };
    let createdAt = '';
    try {
      createdAt = statSync(paths.runDir).birthtime.toISOString();
    } catch {
      createdAt = '';
    }
    const better =
      best == null ||
      candidate.pass2Done > best.pass2Done ||
      (candidate.pass2Done === best.pass2Done && (bestCreatedAt === '' || (createdAt !== '' && createdAt < bestCreatedAt)));
    if (better) {
      best = candidate;
      bestCreatedAt = createdAt;
    }
  }
  return best;
}

/** Newest first: by creation timestamp, then by name so the order is total. */
function newestFirst(snapshots: SnapshotSummary[]): SnapshotSummary[] {
  return [...snapshots].sort(
    (a, b) =>
      (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0) ||
      (a.name < b.name ? 1 : a.name > b.name ? -1 : 0),
  );
}

/**
 * What a client should open with no parameters at all: the newest snapshot that has
 * actually been read, its best run, and that run's first induction label. Readings are
 * the filter, because a result-first UI opening on an empty snapshot shows nothing and
 * looks broken — but among the snapshots that have them, newest wins. Ranking by how
 * many readings a snapshot holds instead pins the landing page to the largest snapshot
 * ever taken, and the run you made this morning never appears. The fallbacks are the
 * newest snapshot with bundles, then simply the newest snapshot.
 */
export function pcDefaults(): PcDefaults {
  const snapshots = listSnapshots();
  if (snapshots.length === 0) return { snapshot: null, run: null, label: null };

  const read = newestFirst(snapshots).filter(
    (snapshot) => (snapshot.latestRun?.pass2Done ?? 0) > 0,
  );
  const chosen = read[0] ?? newestFirst(snapshots.filter((s) => s.bundlesBuilt))[0] ?? newestFirst(snapshots)[0];
  return {
    snapshot: chosen.name,
    run: chosen.latestRun?.run ?? null,
    label: chosen.latestRun?.pass3Labels[0] ?? null,
  };
}

export function createRun(snapshot: string, run: string): RunSummary {
  if (!snapshotExists(snapshot)) throw new PcError(`no snapshot ${snapshot}`, 404);
  assertName('run label', run);
  const dir = safeDataPath(snapshot, 'runs', run);
  if (existsSync(dir)) throw new PcError(`run ${run} already exists`, 409);
  mkdirSync(dir, { recursive: true });
  /* Same three directories `RunPaths` would create, so a run made over HTTP and a run
   * made by a script are the same thing on disk. */
  RunPaths(snapshot, run);
  return summariseRun(snapshot, run);
}

/* ---------------------------------------------------------------- thread views */

function readPass1(paths: ReturnType<typeof RunPaths>, threadId: string): Pass1Result | null {
  const path = resolve(paths.pass1Dir, `${threadId}.json`);
  return existsSync(path) ? readJsonFile<Pass1Result>(path) : null;
}

function readPass2(paths: ReturnType<typeof RunPaths>, threadId: string): Pass2Result | null {
  const path = resolve(paths.pass2Dir, `${threadId}.json`);
  return existsSync(path) ? readJsonFile<Pass2Result>(path) : null;
}

export function readPass3(
  paths: ReturnType<typeof RunPaths>,
  label: string,
): Pass3Result | null {
  assertName('induction label', label);
  const path = resolve(paths.pass3Dir, `${label}.json`);
  return existsSync(path) ? readJsonFile<Pass3Result>(path) : null;
}

/** Thread id → the category name it was placed in, for one induction label. */
function categoryByThread(induction: Pass3Result | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!induction) return out;
  for (const category of induction.categories) {
    for (const id of category.member_thread_ids) out.set(id, category.name);
  }
  return out;
}

/** `<thread_id> — <reason>` from pass 3's `unassigned` list, keyed by thread. */
function unassignedReasonByThread(induction: Pass3Result | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!induction) return out;
  for (const entry of induction.unassigned) {
    const separator = entry.indexOf(' — ');
    if (separator === -1) {
      out.set(entry.trim(), '');
      continue;
    }
    out.set(entry.slice(0, separator).trim(), entry.slice(separator + ' — '.length).trim());
  }
  return out;
}

/**
 * The bundle's own text: every string value it holds, and no field names. It is the
 * label guard's haystack — a token the reading shouts that appears here was copied out
 * of the record, so it is the customer's data and not a class the reader invented.
 */
export function bundleStringValues(bundle: ThreadBundle): string {
  const parts: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      parts.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value != null && typeof value === 'object') {
      for (const item of Object.values(value)) walk(item);
    }
  };
  walk(bundle);
  return parts.join('\n').toUpperCase();
}

/** `## What happened to the customer`, `**What happened to the customer:**`, plain. */
function headingOf(line: string): string | null {
  const stripped = line
    .replace(/^\s*#{1,6}\s*/, '')
    .replace(/\*/g, '')
    .replace(/:\s*$/, '')
    .trim()
    .toLowerCase();
  return PASS2_HEADINGS.some((heading) => heading.toLowerCase() === stripped) ? stripped : null;
}

/** One section of a pass-2 reading, whitespace collapsed. `null` when it is not there. */
export function readingSection(reading: string, heading: string): string | null {
  const lines = reading.split('\n');
  const wanted = heading.toLowerCase();
  const start = lines.findIndex((line) => headingOf(line) === wanted);
  if (start === -1) return null;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (headingOf(line) != null || /^\s*#{1,6}\s/.test(line)) break;
    body.push(line);
  }
  const text = body.join(' ').replace(/\s+/g, ' ').trim();
  return text === '' ? null : text;
}

/** The reading's own answer to "what happened", cut to a list row's width. */
export function whatHappenedExcerpt(reading: string): string | null {
  const section = readingSection(reading, PASS2_HEADINGS[1]);
  return section == null ? null : section.slice(0, WHAT_HAPPENED_CHARS);
}

/** The customer's first words in the thread — what the row is actually about. */
export function firstCustomerMessage(bundle: ThreadBundle): string | null {
  for (const dialogue of bundle.dialogues) {
    for (const message of dialogue.messages) {
      if (message.speaker !== 'customer') continue;
      const text = message.text.trim();
      if (text === '') continue;
      return text.slice(0, FIRST_MESSAGE_CHARS);
    }
  }
  return null;
}

/** A row is still a row when its bundle has not been built; the extras go null. */
function tryLoadBundle(snapshot: string, threadId: string): ThreadBundle | null {
  try {
    return loadBundle(snapshot, threadId);
  } catch {
    return null;
  }
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

export interface RunThreadsResult {
  rows: ThreadRow[];
  complete: { pass1: boolean; pass2: boolean; pass3: boolean };
}

export function readRunThreads(
  snapshot: string,
  run: string,
  label: string = DEFAULT_INDUCTION_LABEL,
): RunThreadsResult {
  const paths = RunPaths(snapshot, run);
  const threads = snapshotThreadList(snapshot);
  const build = readBuildFile(snapshot);
  const statsById = new Map(
    (build?.per_thread ?? []).map((row) => [
      String(row.thread_id),
      { nMessages: row.n_messages ?? null, nTasks: row.n_tasks ?? null },
    ]),
  );
  const induction = readPass3(paths, label);
  const categoryOf = categoryByThread(induction);

  let pass1Done = 0;
  let pass2Done = 0;
  const rows: ThreadRow[] = threads.map((thread) => {
    const pass1 = readPass1(paths, thread.threadId);
    const pass2 = readPass2(paths, thread.threadId);
    if (pass1) pass1Done += 1;
    if (pass2) pass2Done += 1;
    const stats = statsById.get(thread.threadId);
    /* One bundle read per row and no more: the first customer message, the identified
     * payment's summary and the label guard's haystack all come off this one object. */
    const bundle = tryLoadBundle(snapshot, thread.threadId);
    return {
      ...thread,
      nMessages: stats?.nMessages ?? null,
      nTasks: stats?.nTasks ?? null,
      firstCustomerMessage: bundle == null ? null : firstCustomerMessage(bundle),
      whatHappened: pass2 == null ? null : whatHappenedExcerpt(pass2.reading),
      identifiedSummary:
        bundle == null ? null : renderIdentifiedSummary(bundle, pass1?.identified?.id ?? null),
      wsLink: wsDialogueUrl(thread.customerAlias, thread.dialogueIds[0] ?? ''),
      pass1: pass1
        ? {
            state: pass1.state,
            identifiedId: pass1.identified?.id ?? null,
            identifiedKind: pass1.identified?.kind ?? null,
            confidence: pass1.pick?.confidence ?? null,
          }
        : null,
      pass2: pass2
        ? {
            done: true,
            words: wordCount(pass2.reading),
            labelGuardFlags: labelGuardFlags(
              pass2.reading,
              bundle == null ? '' : bundleStringValues(bundle),
            ),
          }
        : null,
      pass3Category: categoryOf.get(thread.threadId) ?? null,
    };
  });

  const pass1Complete = threads.length > 0 && pass1Done === threads.length;
  const pass2Complete = threads.length > 0 && pass2Done === threads.length;
  return {
    rows,
    complete: {
      pass1: pass1Complete,
      pass2: pass2Complete,
      pass3: induction != null && pass2Complete,
    },
  };
}

export function readThreadDetail(
  snapshot: string,
  run: string,
  threadId: string,
  label: string = DEFAULT_INDUCTION_LABEL,
): ThreadDetail {
  const paths = RunPaths(snapshot, run);
  assertName('thread id', threadId);
  const threads = loadSnapshotThreads(snapshot);
  if (!threads.some((thread) => thread.thread_id === threadId)) {
    throw new PcError(`thread ${threadId} is not in snapshot ${snapshot}`, 404);
  }
  const bundle: ThreadBundle = loadBundle(snapshot, threadId);
  const pass1 = readPass1(paths, threadId);
  const pass2 = readPass2(paths, threadId);
  const induction = readPass3(paths, label);

  let pass3: ThreadDetail['pass3'] = null;
  if (induction) {
    const category = categoryByThread(induction).get(threadId) ?? null;
    const reason = unassignedReasonByThread(induction).get(threadId) ?? null;
    pass3 = { label, category, reason: category == null ? reason : null };
  }

  return {
    threadId,
    meta: bundle.meta,
    stats: bundle.stats,
    bundle: {
      dialogues: bundle.dialogues,
      tasks: bundle.tasks,
      accounts: bundle.accounts,
      candidates: bundle.candidates,
      holds: bundle.holds,
    },
    renderedExtract: renderBundleText(bundle, { stage: 'extract' }),
    /* The read rendering is what pass 2 was (or would be) shown: pass 1's identified
     * payment when there is one, and the NOT_FOUND wording when there is not. */
    renderedRead: renderBundleText(bundle, {
      stage: 'read',
      identifiedId: pass1?.identified?.id ?? null,
    }),
    pass1,
    pass2: pass2 ? { reading: pass2.reading, usage: pass2.usage ?? {} } : null,
    pass3,
    wsLinks: {
      dialogues: bundle.dialogues.map((dialogue) => ({
        dialogueId: dialogue.dialogue_id,
        url: wsDialogueUrl(bundle.meta.customer_alias, dialogue.dialogue_id),
      })),
      tasks: bundle.tasks.map((task) => ({
        taskId: Number(task.id),
        url: wsTaskUrl(task.alias ?? bundle.meta.customer_alias, task.id),
      })),
    },
  };
}

/* ------------------------------------------------------------------ the report */

export interface ReportFull {
  report: Report;
  snapshot: string;
  run: string;
  label: string;
  total: number;
  callsPath: string;
  pass1Path: string;
  pass2Path: string;
  pass3Path: string;
  /** CLI-only extras: numbers the printed report shows and the API does not carry. */
  extras: {
    pass1Identified: number;
    pass1DistinctIdentified: number;
    pass1PerState: { state: string; threads: number; distinctPayments: number }[];
    pass1NoExtraction: number;
    pass1EmptyShortlist: number;
    pass2Empty: number;
    pass3Exists: boolean;
    pass3Assigned: number;
    pass3UnknownMemberIds: string[];
    pass3Uncovered: string[];
    callLines: number;
  };
}

function stageUsage(lines: CallLine[]): ReportStageUsage[] {
  const stages = [...new Set(lines.map((line) => line.stage))];
  return stages.map((stage) => {
    const stageLines = lines.filter((line) => line.stage === stage);
    const ok = stageLines.filter((line) => line.ok);
    const costs = ok.map((line) => line.total_cost_usd).filter((c): c is number => c != null);
    const latency = stageLines.map((line) => line.latency_ms);
    return {
      stage,
      calls: stageLines.length,
      inputTokens: sum(ok.map((line) => line.input_tokens)),
      outputTokens: sum(ok.map((line) => line.output_tokens)),
      costUsd: costs.length === 0 ? null : sum(costs),
      latencyP50Ms: latency.length === 0 ? null : pct(latency, 50),
      latencyMaxMs: latency.length === 0 ? null : pct(latency, 100),
      errors: stageLines.length - ok.length,
    };
  });
}

/* ------------------------------------------------------- scenario ↔ problem */

/**
 * The snapshot's threads counted by the Gemma scenario leaf they were selected by, in
 * the manifest's `counts.by_category` order.
 *
 * The order is the whole point: it is what fixes a scenario's position in the legend,
 * in every stacked bar and in the crosstab's columns, so one leaf keeps one colour
 * across the page. Counting the thread rows rather than quoting `by_category.threads`
 * keeps this total and every split below it derived from the same rows — a crosstab
 * that does not add up to its own column total is worse than no crosstab.
 * A path key present in the threads but missing from the manifest is appended in
 * thread order rather than dropped.
 */
function scenarioTotalsFor(snapshot: string, threads: SnapshotThread[]): ReportScenarioCount[] {
  const counts = new Map<string, number>();
  for (const thread of threads) {
    counts.set(thread.path_key, (counts.get(thread.path_key) ?? 0) + 1);
  }
  const ordered: string[] = [];
  const manifest = readPopulation(snapshot).manifest.counts?.by_category ?? [];
  for (const row of manifest) {
    if (counts.has(row.path_key) && !ordered.includes(row.path_key)) ordered.push(row.path_key);
  }
  for (const pathKey of counts.keys()) {
    if (!ordered.includes(pathKey)) ordered.push(pathKey);
  }
  return ordered.map((pathKey) => ({
    pathKey,
    scenario: categoryLabel(pathKey),
    threads: counts.get(pathKey) ?? 0,
  }));
}

/**
 * The report, with the CLI's extra numbers alongside it. Everything that counts
 * anything is gated on the pass being complete over *every* thread in the snapshot —
 * a category share glimpsed halfway through a sweep is a number that gets quoted, and
 * half a sweep is not a population.
 */
export function buildReportFull(
  snapshot: string,
  run: string,
  label: string = DEFAULT_INDUCTION_LABEL,
): ReportFull {
  const paths = RunPaths(snapshot, run);
  assertName('induction label', label);
  const threads = loadSnapshotThreads(snapshot);
  const total = threads.length;

  const pass1: Pass1Result[] = [];
  for (const thread of threads) {
    const row = readPass1(paths, thread.thread_id);
    if (row) pass1.push(row);
  }
  const pass1Complete = pass1.length === total;

  const pass2: Pass2Result[] = [];
  for (const thread of threads) {
    const row = readPass2(paths, thread.thread_id);
    if (row) pass2.push(row);
  }
  const pass2Complete = pass2.length === total;

  const states: Record<string, number> = {};
  const perState: ReportFull['extras']['pass1PerState'] = [];
  if (pass1Complete) {
    for (const state of PASS1_STATES) {
      const rows = pass1.filter((row) => row.state === state);
      states[state] = rows.length;
      perState.push({
        state,
        threads: rows.length,
        distinctPayments: new Set(rows.map((row) => row.identified?.id).filter(Boolean)).size,
      });
    }
  }
  const withId = pass1.filter((row) => row.identified != null);
  const distinctIdentified = new Set(withId.map((row) => row.identified!.id)).size;

  const readingByThread = new Map(pass2.map((row) => [row.thread_id, row.reading]));
  /* The guard needs the thread's own text to tell a quoted payee from a coined label,
   * so the report reads one bundle per reading — once each, in snapshot order. */
  const flagged = pass2
    .map((row) => {
      const bundle = tryLoadBundle(snapshot, row.thread_id);
      return {
        threadId: row.thread_id,
        flags: labelGuardFlags(row.reading, bundle == null ? '' : bundleStringValues(bundle)),
      };
    })
    .filter((row) => row.flags.length > 0);

  const paymentByThread = new Map<string, string>();
  for (const row of pass1) {
    if (row.identified != null) paymentByThread.set(row.thread_id, row.identified.id);
  }

  const pass3Path = resolve(paths.pass3Dir, `${label}.json`);
  const induction = readPass3(paths, label);
  let pass3: Report['pass3'] = null;
  let assignedCount = 0;
  let unknownMemberIds: string[] = [];
  let uncovered: string[] = [];
  if (induction && pass2Complete) {
    const scenarioTotals = scenarioTotalsFor(snapshot, threads);
    const pathKeyByThread = new Map(threads.map((thread) => [thread.thread_id, thread.path_key]));
    /* A member id that is not in the snapshot has no scenario, so it is left out of the
     * split rather than guessed at; `extras.pass3UnknownMemberIds` is where that shows. */
    const splitByScenario = (ids: string[]): ReportScenarioCount[] => {
      const tally = new Map<string, number>();
      for (const id of ids) {
        const pathKey = pathKeyByThread.get(id);
        if (pathKey == null) continue;
        tally.set(pathKey, (tally.get(pathKey) ?? 0) + 1);
      }
      return scenarioTotals.map((row) => ({
        pathKey: row.pathKey,
        scenario: row.scenario,
        threads: tally.get(row.pathKey) ?? 0,
      }));
    };
    const unassignedIds = [...unassignedReasonByThread(induction).keys()];
    const unassignedByScenario = splitByScenario(unassignedIds);

    const categories: ReportCategory[] = induction.categories.map((category) => {
      /* Three ids and one reading's opening: a category name is a claim, and this is
       * the shortest thing that lets a reader check it against a case. */
      const examples = category.member_thread_ids.slice(0, 3);
      const first = examples[0];
      const reading = first == null ? undefined : readingByThread.get(first);
      return {
        name: category.name,
        definition: category.definition,
        whatRemovesIt: category.what_removes_it,
        threads: category.member_thread_ids.length,
        distinctPayments: new Set(
          category.member_thread_ids.map((id) => paymentByThread.get(id)).filter(Boolean),
        ).size,
        memberThreadIds: category.member_thread_ids,
        exampleThreadIds: examples,
        whatHappenedSample: reading == null ? null : whatHappenedExcerpt(reading),
        byScenario: splitByScenario(category.member_thread_ids),
      };
    });

    /* The same numbers transposed. Built from `categories` and the unassigned split, so
     * the two directions cannot disagree: a cell is one count read two ways. */
    const crosstab: ReportCrosstabRow[] = scenarioTotals.map((row, index) => {
      const byCategory: Record<string, number> = {};
      for (const category of categories) {
        const threadCount = category.byScenario[index]?.threads ?? 0;
        if (threadCount > 0) byCategory[category.name] = threadCount;
      }
      const unassignedCount = unassignedByScenario[index]?.threads ?? 0;
      if (unassignedCount > 0) byCategory[UNASSIGNED_CATEGORY_KEY] = unassignedCount;
      return { scenario: row.scenario, byCategory };
    });
    const assigned = new Set(induction.categories.flatMap((c) => c.member_thread_ids));
    const snapshotIds = new Set(threads.map((t) => t.thread_id));
    assignedCount = assigned.size;
    unknownMemberIds = [...assigned].filter((id) => !snapshotIds.has(id));
    uncovered = [...snapshotIds].filter(
      (id) => !assigned.has(id) && !induction.unassigned.some((u) => u.startsWith(id)),
    );
    pass3 = {
      label,
      complete: true,
      categories,
      unassigned: induction.unassigned,
      notes: induction.notes,
      scenarioTotals,
      unassignedByScenario,
      crosstab,
    };
  }

  const callLines = readCallLog(paths.callsPath);

  const report: Report = {
    pass1: {
      complete: pass1Complete,
      states: pass1Complete ? states : null,
      distinctPayments: pass1Complete ? distinctIdentified : null,
      threads: pass1.length,
    },
    pass2: {
      complete: pass2Complete,
      readings: pass2.length,
      flagged: pass2Complete ? flagged : null,
    },
    pass3,
    usage: { perStage: stageUsage(callLines) },
    pilotNotice: snapshot.startsWith('pilot') ? PILOT_NOTICE : null,
  };

  return {
    report,
    snapshot,
    run,
    label,
    total,
    callsPath: paths.callsPath,
    pass1Path: paths.pass1Dir,
    pass2Path: paths.pass2Dir,
    pass3Path,
    extras: {
      pass1Identified: withId.length,
      pass1DistinctIdentified: distinctIdentified,
      pass1PerState: perState,
      /* `extraction == null` means two different things since `regex-first` landed: the
       * model's answer would not parse twice, or `extract` was never called because the
       * regex shortlist was enough on its own. Only the first is a failure, and
       * `extract_attempts` separates them on a result file from either mode. */
      pass1NoExtraction: pass1.filter(
        (row) => row.usage.extract_attempts > 0 && row.extraction == null,
      ).length,
      pass1EmptyShortlist: pass1.filter((row) => row.shortlist.rows.length === 0).length,
      pass2Empty: pass2.filter((row) => row.reading.trim() === '').length,
      pass3Exists: existsSync(pass3Path),
      pass3Assigned: assignedCount,
      pass3UnknownMemberIds: unknownMemberIds,
      pass3Uncovered: uncovered,
      callLines: callLines.length,
    },
  };
}

export function buildReport(
  snapshot: string,
  run: string,
  label: string = DEFAULT_INDUCTION_LABEL,
): Report {
  return buildReportFull(snapshot, run, label).report;
}

/** Exactly what `pc-report.ts` printed before the refactor, line for line. */
export function renderReportLines(full: ReportFull): string[] {
  const { report, extras, total } = full;
  const lines: string[] = [];
  lines.push(
    `REPORT · snapshot ${full.snapshot} · run ${full.run} · ${total} threads in the snapshot`,
  );

  lines.push('');
  if (!report.pass1.complete) {
    lines.push(`pass 1: ${report.pass1.threads}/${total} — incomplete, no counts`);
  } else {
    lines.push(`pass 1: ${report.pass1.threads}/${total} — complete`);
    for (const row of extras.pass1PerState) {
      const idBit = row.distinctPayments > 0 ? ` · ${row.distinctPayments} distinct payment ids` : '';
      lines.push(`  ${row.state.padEnd(18)} ${String(row.threads).padStart(5)} threads${idBit}`);
    }
    lines.push(
      `  identified overall  ${String(extras.pass1Identified).padStart(5)} threads · ${extras.pass1DistinctIdentified} distinct payments (${extras.pass1Identified - extras.pass1DistinctIdentified} threads land on a payment another thread already names)`,
    );
    lines.push(
      `  extraction unparsed after retry: ${extras.pass1NoExtraction} · empty shortlist: ${extras.pass1EmptyShortlist}`,
    );
  }

  lines.push('');
  if (!report.pass2.complete) {
    lines.push(`pass 2: ${report.pass2.readings}/${total} — incomplete, no counts`);
  } else {
    lines.push(`pass 2: ${report.pass2.readings}/${total} readings — complete`);
    const flagged = report.pass2.flagged ?? [];
    if (flagged.length === 0) {
      lines.push('  label guard: no reading looks like labelling');
    } else {
      lines.push(`  label guard: ${flagged.length} of ${report.pass2.readings} readings flagged`);
      for (const row of flagged) lines.push(`    ${row.threadId}  ${row.flags.join(' | ')}`);
    }
    if (extras.pass2Empty > 0) lines.push(`  ${extras.pass2Empty} readings came back empty`);
  }

  lines.push('');
  if (!extras.pass3Exists) {
    lines.push(`pass 3: no induction at ${full.pass3Path}`);
  } else if (!report.pass2.complete) {
    lines.push(
      `pass 3: an induction exists at ${full.pass3Path} but pass 2 is ${report.pass2.readings}/${total} — no counts`,
    );
  } else {
    const pass3 = report.pass3!;
    lines.push(
      `pass 3 · induction ${full.label} · ${pass3.categories.length} categories`,
    );
    if (report.pilotNotice) lines.push(report.pilotNotice);
    lines.push(`  ${'category'.padEnd(40)}${'threads'.padStart(9)}${'payments'.padStart(10)}`);
    for (const category of pass3.categories) {
      lines.push(
        `  ${category.name.slice(0, 39).padEnd(40)}${String(category.threads).padStart(9)}${String(category.distinctPayments).padStart(10)}`,
      );
    }
    lines.push(`  assigned ${extras.pass3Assigned} · unassigned ${pass3.unassigned.length}`);
    if (extras.pass3UnknownMemberIds.length > 0) {
      lines.push(
        `  ${extras.pass3UnknownMemberIds.length} member ids are not in the snapshot: ${extras.pass3UnknownMemberIds.join(', ')}`,
      );
    }
    if (extras.pass3Uncovered.length > 0) {
      lines.push(
        `  ${extras.pass3Uncovered.length} snapshot threads appear in no category and no unassigned entry`,
      );
    }
  }

  lines.push('');
  if (!existsSync(full.callsPath)) {
    lines.push(`calls: no ${full.callsPath} — nothing has been sent under this run label`);
    return lines;
  }
  const stages = report.usage.perStage;
  lines.push(`calls: ${extras.callLines} logged in ${full.callsPath}`);
  lines.push(
    `  ${'stage'.padEnd(10)}${'calls'.padStart(7)}${'errors'.padStart(8)}${'in tok'.padStart(12)}${'out tok'.padStart(10)}${'cost'.padStart(12)}${'lat p50'.padStart(10)}${'lat max'.padStart(10)}`,
  );
  for (const stage of stages) {
    lines.push(
      [
        `  ${stage.stage.padEnd(8)}`,
        String(stage.calls).padStart(7),
        String(stage.errors).padStart(8),
        String(stage.inputTokens).padStart(12),
        String(stage.outputTokens).padStart(10),
        (stage.costUsd == null ? 'not returned' : usd(stage.costUsd)).padStart(12),
        String(stage.latencyP50Ms ?? 0).padStart(10),
        String(stage.latencyMaxMs ?? 0).padStart(10),
      ].join(''),
    );
  }
  const allLines = readCallLog(full.callsPath);
  const allCosts = allLines.map((line) => line.total_cost_usd).filter((c): c is number => c != null);
  lines.push(
    `  total: ${sum(allLines.map((l) => (l.ok ? l.input_tokens : 0)))} in, ${sum(allLines.map((l) => (l.ok ? l.output_tokens : 0)))} out, ${allCosts.length === 0 ? 'cost not returned by the proxy' : `${usd(sum(allCosts))} over ${allCosts.length} of ${allLines.length} calls`}, ${allLines.filter((l) => !l.ok).length} errors`,
  );
  return lines;
}

/* ------------------------------------------------------------- compare pass 3 */

function jaccard(x: Set<string>, y: Set<string>): number {
  if (x.size === 0 && y.size === 0) return 1;
  let shared = 0;
  for (const item of x) if (y.has(item)) shared += 1;
  const union = x.size + y.size - shared;
  return union === 0 ? 0 : shared / union;
}

export interface ComparePass3Full {
  snapshot: string;
  run: string;
  labelA: string;
  labelB: string;
  a: Pass3Result;
  b: Pass3Result;
  setsA: Set<string>[];
  setsB: Set<string>[];
  matched: { ia: number; ib: number; score: number }[];
  unmatchedA: number[];
  unmatchedB: number[];
  agreeing: number;
  inBoth: number;
  onlyOne: number;
}

/**
 * Two inductions over the same readings produce two category sets with different
 * names, so they are matched by their members. Greedy best-first over all pairs: the
 * strongest overlap anywhere is matched, both sides are struck out, repeat. A one-sided
 * argmax would let two A categories claim the same B category and hide a split.
 */
export function comparePass3Full(
  snapshot: string,
  run: string,
  labelA: string,
  labelB: string,
): ComparePass3Full {
  const paths = RunPaths(snapshot, run);
  assertName('induction label', labelA);
  assertName('induction label', labelB);
  if (labelA === labelB) throw new PcError('the two induction labels must differ');

  const load = (label: string): Pass3Result => {
    const path = resolve(paths.pass3Dir, `${label}.json`);
    if (!existsSync(path)) throw new PcError(`no induction at ${path}`, 404);
    return readJsonFile<Pass3Result>(path);
  };
  const a = load(labelA);
  const b = load(labelB);

  const setsA = a.categories.map((c) => new Set(c.member_thread_ids));
  const setsB = b.categories.map((c) => new Set(c.member_thread_ids));

  const candidates: { ia: number; ib: number; score: number }[] = [];
  for (let ia = 0; ia < setsA.length; ia += 1) {
    for (let ib = 0; ib < setsB.length; ib += 1) {
      const score = jaccard(setsA[ia], setsB[ib]);
      if (score > 0) candidates.push({ ia, ib, score });
    }
  }
  candidates.sort((x, y) => y.score - x.score || x.ia - y.ia || x.ib - y.ib);

  const matchOfA = new Map<number, number>();
  const matchOfB = new Map<number, number>();
  for (const candidate of candidates) {
    if (matchOfA.has(candidate.ia) || matchOfB.has(candidate.ib)) continue;
    matchOfA.set(candidate.ia, candidate.ib);
    matchOfB.set(candidate.ib, candidate.ia);
  }

  const matched = [...matchOfA.entries()]
    .map(([ia, ib]) => ({ ia, ib, score: jaccard(setsA[ia], setsB[ib]) }))
    .sort((x, y) => y.score - x.score);

  const catOfThreadA = new Map<string, number>();
  a.categories.forEach((category, ia) => {
    for (const id of category.member_thread_ids) catOfThreadA.set(id, ia);
  });
  const catOfThreadB = new Map<string, number>();
  b.categories.forEach((category, ib) => {
    for (const id of category.member_thread_ids) catOfThreadB.set(id, ib);
  });
  const inBoth = [...catOfThreadA.keys()].filter((id) => catOfThreadB.has(id));
  const agreeing = inBoth.filter(
    (id) => matchOfA.get(catOfThreadA.get(id)!) === catOfThreadB.get(id),
  );

  return {
    snapshot,
    run,
    labelA,
    labelB,
    a,
    b,
    setsA,
    setsB,
    matched,
    unmatchedA: a.categories.map((_, ia) => ia).filter((ia) => !matchOfA.has(ia)),
    unmatchedB: b.categories.map((_, ib) => ib).filter((ib) => !matchOfB.has(ib)),
    agreeing: agreeing.length,
    inBoth: inBoth.length,
    onlyOne: new Set([...catOfThreadA.keys(), ...catOfThreadB.keys()]).size - inBoth.length,
  };
}

export function comparePass3(
  snapshot: string,
  run: string,
  labelA: string,
  labelB: string,
): ComparePass3 {
  const full = comparePass3Full(snapshot, run, labelA, labelB);
  return {
    pairs: full.matched.map((pair) => ({
      a: full.a.categories[pair.ia].name,
      b: full.b.categories[pair.ib].name,
      jaccard: pair.score,
    })),
    unmatchedA: full.unmatchedA.map((ia) => full.a.categories[ia].name),
    unmatchedB: full.unmatchedB.map((ib) => full.b.categories[ib].name),
    assignmentAgreement: full.inBoth === 0 ? 0 : full.agreeing / full.inBoth,
  };
}

/** Exactly what `pc-compare-pass3.ts` printed before the refactor. */
export function renderComparePass3Lines(full: ComparePass3Full): string[] {
  const lines: string[] = [];
  lines.push(
    `COMPARE pass 3 · snapshot ${full.snapshot} · run ${full.run} · ${full.labelA} (${full.a.categories.length} categories) vs ${full.labelB} (${full.b.categories.length} categories)`,
  );
  lines.push('');
  lines.push(`matched pairs (${full.matched.length})`);
  lines.push(`  ${'jaccard'.padEnd(9)}${full.labelA.padEnd(42)}${full.labelB}`);
  for (const pair of full.matched) {
    const left = `${full.a.categories[pair.ia].name} (${full.setsA[pair.ia].size})`;
    lines.push(
      `  ${pair.score.toFixed(2).padEnd(9)}${left.slice(0, 41).padEnd(42)}${full.b.categories[pair.ib].name} (${full.setsB[pair.ib].size})`,
    );
  }
  lines.push('');
  lines.push(`unmatched in ${full.labelA}: ${full.unmatchedA.length}`);
  for (const ia of full.unmatchedA) {
    const category = full.a.categories[ia];
    lines.push(`  ${category.name} (${category.member_thread_ids.length})`);
  }
  lines.push(`unmatched in ${full.labelB}: ${full.unmatchedB.length}`);
  for (const ib of full.unmatchedB) {
    const category = full.b.categories[ib];
    lines.push(`  ${category.name} (${category.member_thread_ids.length})`);
  }
  lines.push('');
  lines.push(
    `assignment agreement: ${full.agreeing}/${full.inBoth}${full.inBoth === 0 ? '' : `  ${((full.agreeing / full.inBoth) * 100).toFixed(1)}%`} of the threads both inductions assigned`,
  );
  if (full.onlyOne > 0) {
    lines.push(`  ${full.onlyOne} threads were assigned in one induction only`);
  }
  return lines;
}

/**
 * Payment problem classifier — the shapes the HTTP surface and the CLI scripts share.
 *
 * The types here are the API contract the frontend is built against. Nothing in this
 * file touches the filesystem, BigQuery or the proxy, so both the routes and the
 * scripts can import it without pulling a transport in behind it.
 *
 * `PcError` exists because the scripts' `fail()` calls `process.exit`, which a Fastify
 * handler must never do. The pipeline throws instead, the routes map `status`, and the
 * scripts catch and print `error: <message>` exactly as they did before.
 */

export class PcError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'PcError';
    this.status = status;
  }
}

export function isPcError(error: unknown): error is PcError {
  return error instanceof PcError;
}

/* ------------------------------------------------------------------ snapshots */

export interface SnapshotCategoryCount {
  pathKey: string;
  category: string;
  threads: number;
  dialogues: number;
  customers: number;
}

export interface SnapshotSummary {
  name: string;
  dateFrom: string;
  dateTo: string;
  asOf: string | null;
  seed: number;
  createdAt: string;
  counts: {
    totalThreads: number;
    totalDialogues: number;
    totalCustomers: number;
    byCategory: SnapshotCategoryCount[];
  };
  bundlesBuilt: boolean;
  bundlesBuiltAt: string | null;
  runs: string[];
  /**
   * The run worth opening: the one with the most pass-2 readings, newest on a tie.
   * `null` when the snapshot has no run, so a result-first client can tell a snapshot
   * that has been read from one that has only been snapshotted.
   */
  latestRun: LatestRun | null;
}

export interface LatestRun {
  run: string;
  pass1Done: number;
  pass2Done: number;
  pass3Labels: string[];
}

/** What a client should open when it has been given no snapshot, run or label. */
export interface PcDefaults {
  snapshot: string | null;
  run: string | null;
  label: string | null;
}

export interface CreateSnapshotInput {
  dateFrom: string;
  dateTo: string;
  name: string;
  /**
   * A leaf set by name (`money-not-arrived`, `declines`), or full path keys of your own.
   * Defaults to `money-not-arrived`, which is what the pilot and `fn1` ran on.
   */
  leaves?: string | readonly string[];
  /**
   * Which threads to keep: `all`, the ones Gemma handed over (`escalated`), or the ones a
   * person acted in (`touched`). The question is which problems make work for people, so
   * the untouched majority is noise for it — and on a wide leaf set it is almost all of
   * the population.
   */
  filter?: 'all' | 'escalated' | 'touched';
  seed?: number;
  asOf?: string;
  /** CLI `--force`: overwrite an existing population.json. The route never sets it. */
  force?: boolean;
}

/* ---------------------------------------------------------------- pass request */

/**
 * `all` is passes 1 → 2 → 3 as one job. It is not a fourth pass: it plans and runs the
 * other three in order, writes exactly the same per-stage result files, and exists so
 * the whole pipeline is one confirmation step rather than three.
 */
export type PassKind = 'measure' | 'pass1' | 'pass2' | 'pass3' | 'all';

/**
 * How pass 1 reaches its shortlist.
 *
 * `regex-first` (the default) builds the extraction deterministically and pays for the
 * model's `extract` only when the regex shortlist is empty or `pick` cannot answer off
 * it. `extract-always` is the original flow — one `extract` call per thread,
 * unconditionally — kept so the two can be run over the same snapshot and compared.
 */
export type Pass1Mode = 'regex-first' | 'extract-always';

export const PASS1_MODES: Pass1Mode[] = ['regex-first', 'extract-always'];

export const DEFAULT_PASS1_MODE: Pass1Mode = 'regex-first';

export interface PassRequest {
  pass: PassKind;
  threads?: string[];
  n?: number;
  force?: boolean;
  mode?: 'two-step' | 'one-call';
  label?: string;
  /** Pass 1 only; the `all` pass hands it through. Defaults to `regex-first`. */
  pass1Mode?: Pass1Mode;
}

export interface PlanRow {
  stage: string;
  model: string;
  calls: number;
  charsSum: number;
  charsP50: number;
  charsMax: number;
  estInputTokens: number;
  estOutputTokens: number;
  estInputCostUsd: number;
}

export interface Plan {
  pass: PassKind;
  request: PassRequest;
  rows: PlanRow[];
  estInputCostUsd: number;
  notes: string[];
  blockers: string[];
  threadsSelected: number;
  threadsToDo: number;
}

/* ------------------------------------------------------------------- the jobs */

export interface JobEvent {
  ts: string;
  threadId: string | null;
  stage: string | null;
  state: string | null;
  ok: boolean;
  error: string | null;
  latencyMs: number | null;
}

export interface JobUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  errors: number;
}

export type JobKind = 'bundles' | PassKind;

export type JobStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  kind: JobKind;
  snapshot: string;
  run: string | null;
  status: JobStatus;
  startedAt: string;
  finishedAt: string | null;
  progress: { done: number; total: number };
  current: string | null;
  events: JobEvent[];
  usage: JobUsage;
  error: string | null;
  plan: Plan | null;
}

/* ------------------------------------------------------------------ run views */

export interface RunSummary {
  run: string;
  createdAt: string;
  passes: {
    pass1: { done: number; total: number };
    pass2: { done: number; total: number };
    pass3: { labels: string[] };
  };
  usage: JobUsage;
}

export interface ThreadRow {
  threadId: string;
  pathKey: string;
  category: string;
  customerAlias: string;
  firstDialogueAt: string;
  nDialogues: number;
  nMessages: number | null;
  nTasks: number | null;
  /** The thread's dialogues in thread order — the order the bundle holds them in. */
  dialogueIds: string[];
  /** The customer's own opening words, 160 chars at most. `null` when they never wrote. */
  firstCustomerMessage: string | null;
  /** The first 200 chars of the reading's "What happened" section; `null` before pass 2. */
  whatHappened: string | null;
  /** `FP out -3750.00 GBP to GHAFAR HUSSAIN · DECLINED`, or `null` when pass 1 found none. */
  identifiedSummary: string | null;
  /** The thread's first dialogue in the CX Workstation. */
  wsLink: string;
  pass1: {
    state: string;
    identifiedId: string | null;
    identifiedKind: string | null;
    confidence: string | null;
  } | null;
  pass2: { done: boolean; words: number; labelGuardFlags: string[] } | null;
  pass3Category: string | null;
}

export interface ThreadDetail {
  threadId: string;
  meta: object;
  stats: object;
  bundle: {
    dialogues: object[];
    tasks: object[];
    accounts: object[];
    candidates: object;
    holds: object;
  };
  renderedExtract: string;
  renderedRead: string;
  pass1: object | null;
  pass2: { reading: string; usage: object } | null;
  pass3: { label: string; category: string | null; reason: string | null } | null;
  /** Every dialogue and task of this thread, as a Workstation URL. */
  wsLinks: {
    dialogues: { dialogueId: string; url: string }[];
    tasks: { taskId: number; url: string }[];
  };
}

/* --------------------------------------------------------------- the report */

export interface ReportStageUsage {
  stage: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  latencyP50Ms: number | null;
  latencyMaxMs: number | null;
  errors: number;
}

/**
 * One Gemma scenario leaf with a thread count against it. The leaf is the thing the
 * snapshot *selected* by; the induced problem is what reading the threads found. Every
 * list of these is in the snapshot's own `counts.byCategory` order, so a scenario keeps
 * one position — and therefore one colour — everywhere it is drawn.
 */
export interface ReportScenarioCount {
  pathKey: string;
  /** The short leaf label, as `categoryLabel()` gives it. */
  scenario: string;
  threads: number;
}

/**
 * The key `crosstab` uses for the threads pass 3 left unassigned. Same sentinel the
 * frontend filters on, so a crosstab cell and a filter value are the same string.
 */
export const UNASSIGNED_CATEGORY_KEY = '__unassigned__';

/**
 * A scenario's threads split across the induced problems. Zero cells are absent rather
 * than 0: the reader's question is which pairs exist, and a grid of noughts answers a
 * different one. Includes `UNASSIGNED_CATEGORY_KEY` when the scenario has unassigned
 * threads, so a row sums to that scenario's total in `scenarioTotals`.
 */
export interface ReportCrosstabRow {
  scenario: string;
  byCategory: Record<string, number>;
}

export interface ReportCategory {
  name: string;
  definition: string;
  whatRemovesIt: string;
  threads: number;
  distinctPayments: number;
  memberThreadIds: string[];
  /** Up to three members, in snapshot order — enough to check the category by hand. */
  exampleThreadIds: string[];
  /** The first member's "What happened" opening, so a name can be read against a case. */
  whatHappenedSample: string | null;
  /**
   * How this problem's threads divide across the three scenario leaves they were
   * selected by — the central question of the spec, and the only place the page can
   * answer it. Sums to `threads` unless a member id is not in the snapshot.
   */
  byScenario: ReportScenarioCount[];
}

export interface Report {
  pass1: {
    complete: boolean;
    states: Record<string, number> | null;
    distinctPayments: number | null;
    threads: number;
  };
  pass2: {
    complete: boolean;
    readings: number;
    flagged: { threadId: string; flags: string[] }[] | null;
  };
  pass3: {
    label: string;
    complete: boolean;
    categories: ReportCategory[];
    unassigned: string[];
    notes: string;
    /**
     * Every thread in the snapshot by the scenario leaf it was selected by — the
     * population, not this induction's results, so the legend's counts do not move when
     * the categories do. Always present when `pass3` is.
     */
    scenarioTotals: ReportScenarioCount[];
    /** The unassigned threads' own scenario split, in the same order. */
    unassignedByScenario: ReportScenarioCount[];
    /** The same counts by scenario, so the frontend adds nothing up itself. */
    crosstab: ReportCrosstabRow[];
  } | null;
  usage: { perStage: ReportStageUsage[] };
  pilotNotice: string | null;
}

/* -------------------------------------------------------------- compare pass 3 */

export interface ComparePass3 {
  pairs: { a: string; b: string; jaccard: number }[];
  unmatchedA: string[];
  unmatchedB: string[];
  assignmentAgreement: number;
}

/* ------------------------------------------------------------------- the hooks */

/**
 * What a long-running pipeline function reports back through, and how it is told to
 * stop. `onEvent` and `isCancelled` are the two the job registry wires; `onLog`,
 * `onProgress` and `onUsage` are optional so a CLI script can print exactly what it
 * printed before while an HTTP job ignores the prose entirely.
 *
 * Cancellation is cooperative: a pipeline function stops *scheduling* work when
 * `isCancelled()` turns true and lets whatever is already in flight finish.
 */
export interface PipelineHooks {
  onEvent(event: JobEvent): void;
  isCancelled(): boolean;
  /** A line of CLI prose. Never wired by the HTTP job: it can carry aggregates. */
  onLog?(line: string): void;
  onProgress?(progress: { done: number; total: number; current: string | null }): void;
  onUsage?(usage: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
    ok: boolean;
  }): void;
}

export const NO_HOOKS: PipelineHooks = {
  onEvent: () => {},
  isCancelled: () => false,
};

export function nowIso(): string {
  return new Date().toISOString();
}

export function makeEvent(partial: Partial<JobEvent>): JobEvent {
  return {
    ts: partial.ts ?? nowIso(),
    threadId: partial.threadId ?? null,
    stage: partial.stage ?? null,
    state: partial.state ?? null,
    ok: partial.ok ?? true,
    error: partial.error ?? null,
    latencyMs: partial.latencyMs ?? null,
  };
}

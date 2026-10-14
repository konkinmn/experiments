// Payment problem classifier — three-pass read over payment support threads.
// Mirrors the backend contract under /api/problem-classifier. Fields inside
// `bundle` and `pass1` stay snake_case because they come straight from the
// pipeline artefacts, not from the HTTP layer.

export type PassKind = 'measure' | 'pass1' | 'pass2' | 'pass3' | 'all';
export type Pass3Mode = 'two-step' | 'one-call';
export type Pass1State = 'RESOLVED' | 'ORDER_ONLY' | 'UNRESOLVED_HANDLE' | 'NOT_FOUND';

export interface SnapshotCategoryCount {
  pathKey: string;
  category: string;
  threads: number;
  dialogues: number;
  customers: number;
}

export interface SnapshotCounts {
  totalThreads: number;
  totalDialogues: number;
  totalCustomers: number;
  byCategory: SnapshotCategoryCount[];
}

/**
 * What the backend knows about a snapshot's most advanced run. Lets the page
 * pick a sensible default without asking for every run of every snapshot.
 */
export interface SnapshotLatestRun {
  run: string;
  pass1Done: number;
  pass2Done: number;
  pass3Labels: string[];
}

export interface SnapshotSummary {
  name: string;
  dateFrom: string;
  dateTo: string;
  asOf: string | null;
  seed: number;
  createdAt: string;
  counts: SnapshotCounts;
  bundlesBuilt: boolean;
  bundlesBuiltAt: string | null;
  runs: string[];
  /** Absent on older backends — the page falls back to its own pick. */
  latestRun?: SnapshotLatestRun | null;
}

/** What the page selects on load. Any field can be null on a cold backend. */
export interface PcDefaults {
  snapshot: string | null;
  run: string | null;
  label: string | null;
}

export interface CreateSnapshotRequest {
  dateFrom: string;
  dateTo: string;
  name: string;
  seed?: number;
  asOf?: string;
}

export interface PassRequest {
  pass: PassKind;
  threads?: string[];
  n?: number;
  force?: boolean;
  mode?: Pass3Mode;
  label?: string;
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

export interface JobEvent {
  ts: string;
  threadId: string | null;
  stage: string | null;
  state: string | null;
  ok: boolean;
  error: string | null;
  latencyMs: number | null;
}

export interface UsageTotals {
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
  usage: UsageTotals;
  error: string | null;
  plan: Plan | null;
}

export interface RunSummary {
  run: string;
  createdAt: string;
  passes: {
    pass1: { done: number; total: number };
    pass2: { done: number; total: number };
    pass3: { labels: string[] };
  };
  usage: UsageTotals;
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
  pass1: {
    state: string;
    identifiedId: string | null;
    identifiedKind: string | null;
    confidence: string | null;
  } | null;
  pass2: { done: boolean; words: number; labelGuardFlags: string[] } | null;
  pass3Category: string | null;
  // Added by the backend after the first version of this page. Optional here
  // so the table still renders against a backend that has not shipped them.
  dialogueIds?: string[] | null;
  firstCustomerMessage?: string | null;
  whatHappened?: string | null;
  identifiedSummary?: string | null;
  wsLink?: string | null;
}

export interface RunThreadsResponse {
  rows: ThreadRow[];
  complete: { pass1: boolean; pass2: boolean; pass3: boolean };
}

export type BundleSpeaker = 'customer' | 'agent' | 'bot' | 'system';

export interface BundleMessage {
  message_id: string;
  message_num: number;
  timestamp: string;
  speaker: BundleSpeaker;
  speaker_alias: string | null;
  text: string | null;
  files: unknown;
  is_hidden: boolean | null;
  payload_type: string | null;
}

export interface BundleDialogue {
  dialogue_id: string;
  thread_position: number;
  kind: string | null;
  container: {
    type: string | null;
    status: string | null;
    channel: string | null;
    created_at: string | null;
    closed_at: string | null;
    taken_by: string | null;
    last_agent: string | null;
  } | null;
  messages: BundleMessage[];
  dropped_empty_system_rows: number | null;
}

export interface BundleTaskComment {
  id: string;
  author: string | null;
  created_at: string | null;
  description: string | null;
}

export interface BundleTask {
  id: string;
  title: string | null;
  task_type: string | null;
  status: string | null;
  group_id: string | null;
  created_at: string | null;
  closed_at: string | null;
  created_by: string | null;
  closed_by: string | null;
  description: string | null;
  rb_jira_link: string | null;
  n_attachments: number | null;
  partner_side: boolean | null;
  comments: BundleTaskComment[];
}

export interface ThreadBundle {
  dialogues: BundleDialogue[];
  tasks: BundleTask[];
  accounts: unknown[];
  candidates: unknown;
  holds: unknown;
}

export interface Pass1Extraction {
  explicit_ids: string[] | null;
  amounts: { value: number | string | null; currency: string | null }[] | null;
  counterparties: string[] | null;
  direction: string | null;
  dates: string[] | null;
  no_payment_discussed: boolean | null;
}

export interface Pass1ShortlistRow {
  handle: string;
  id: string | null;
  kind: string | null;
  // The pipeline writes either a list of reasons or a single sentence.
  reasons: string[] | string | null;
}

export interface Pass1Result {
  thread_id: string;
  path_key: string | null;
  extraction: Pass1Extraction | null;
  shortlist: { rows: Pass1ShortlistRow[]; omitted: unknown } | null;
  pick: { handle: string; confidence: string | null; why: string | null } | null;
  state: Pass1State | string;
  identified: { id: string; kind: string | null } | null;
  usage: unknown;
  timings: unknown;
}

export interface ThreadWsLinks {
  // Ids arrive as strings in the bundle and as numbers in these links, so both
  // are accepted and compared as strings.
  dialogues: { dialogueId: string | number; url: string }[];
  tasks: { taskId: string | number; url: string }[];
}

export interface ThreadDetail {
  threadId: string;
  meta: Record<string, unknown>;
  stats: Record<string, unknown>;
  bundle: ThreadBundle;
  renderedExtract: string;
  renderedRead: string;
  pass1: Pass1Result | null;
  pass2: { reading: string; usage: unknown } | null;
  pass3: { label: string; category: string | null; reason: string | null } | null;
  /** Absent on older backends. */
  wsLinks?: ThreadWsLinks | null;
}

/**
 * A Gemma scenario leaf — one of the `path_key` leaves the snapshot selected threads
 * by — with a thread count against it. Lists of these always arrive in the snapshot's
 * own order, and that order is what fixes each scenario's colour on the page.
 */
export interface ReportScenarioCount {
  pathKey: string;
  scenario: string;
  threads: number;
}

/** One scenario's threads by induced problem. Zero cells are absent, not 0. */
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
  /** Absent on older backends. */
  exampleThreadIds?: string[] | null;
  whatHappenedSample?: string | null;
  /** Absent on older backends — the row's bar then draws as one flat fill. */
  byScenario?: ReportScenarioCount[] | null;
}

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
    /** The population by scenario leaf. Absent on older backends. */
    scenarioTotals?: ReportScenarioCount[] | null;
    unassignedByScenario?: ReportScenarioCount[] | null;
    /** The same counts by scenario, so this page adds nothing up itself. */
    crosstab?: ReportCrosstabRow[] | null;
  } | null;
  usage: { perStage: ReportStageUsage[] };
  pilotNotice: string | null;
}

export interface ComparePass3Result {
  pairs: { a: string; b: string; jaccard: number }[];
  unmatchedA: string[];
  unmatchedB: string[];
  assignmentAgreement: number;
}

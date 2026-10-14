/**
 * Payment problem classifier — the job registry.
 *
 * A pass over the pilot snapshot is minutes of LLM calls, so the HTTP surface starts it
 * as a background job and the client watches it. The registry is a `Map` in memory,
 * mirrored to `data/problem-classifier/_jobs.json` so a page reload after a restart
 * still shows what happened rather than nothing.
 *
 * Three rules it keeps:
 *  - **one running job per snapshot.** Two passes writing the same run directory would
 *    interleave their result files and their call log; the route answers 409 instead.
 *  - **a job that was `running` when the file was last written did not survive.** The
 *    worker lived in the old process, so on load it becomes `failed` with
 *    `server restarted` — never left `running` for a client to poll forever.
 *  - **progress carries no aggregate.** `done/total`, the current thread, and one event
 *    per thread with its state. Counts, shares and category tables are the report's
 *    job, over a pass that is complete across the whole snapshot. Token and cost totals
 *    are the exception: they are spend, not content.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { dirname, resolve } from 'path';

import { PC_DATA_ROOT } from './runner.js';
import {
  nowIso,
  type Job,
  type JobEvent,
  type JobKind,
  type JobStatus,
  type PipelineHooks,
  type Plan,
} from './pipeline-types.js';

/** What `GET /jobs` returns per job. The full stream stays in memory. */
export const EVENTS_OVER_HTTP = 200;

const JOBS_FILE = resolve(PC_DATA_ROOT, '_jobs.json');

/** Coalesces bursts of per-thread updates into one write. Well inside the 1 s ceiling. */
const PERSIST_DEBOUNCE_MS = 250;

interface JobRecord {
  job: Job;
  cancelRequested: boolean;
}

const jobs = new Map<string, JobRecord>();

/* ------------------------------------------------------------------ persistence */

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function serialise(): string {
  return JSON.stringify(
    {
      version: 1,
      written_at: nowIso(),
      jobs: [...jobs.values()].map((record) => ({
        ...record.job,
        /* The in-memory stream is complete; the file keeps the same tail the HTTP
         * surface exposes, so a restarted server does not carry a 20 MB history. */
        events: record.job.events.slice(-EVENTS_OVER_HTTP),
      })),
    },
    null,
    2,
  );
}

function writeNow(): void {
  try {
    mkdirSync(dirname(JOBS_FILE), { recursive: true });
    /* Write-then-rename: a crash mid-write must not leave a half-parsed registry. */
    const temporary = `${JOBS_FILE}.tmp`;
    writeFileSync(temporary, `${serialise()}\n`);
    renameSync(temporary, JOBS_FILE);
  } catch {
    /* The registry is a convenience mirror, not the source of truth for anything —
     * a failed write must never take a running pass down with it. */
  }
}

function persist(): void {
  if (persistTimer != null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    writeNow();
  }, PERSIST_DEBOUNCE_MS);
  /* Do not hold the process open for a debounce timer. */
  persistTimer.unref?.();
}

function flush(): void {
  if (persistTimer != null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  writeNow();
}

function load(): void {
  if (!existsSync(JOBS_FILE)) return;
  try {
    const parsed = JSON.parse(readFileSync(JOBS_FILE, 'utf8')) as { jobs?: Job[] };
    for (const job of parsed.jobs ?? []) {
      const restored: Job =
        job.status === 'running'
          ? {
              ...job,
              status: 'failed',
              error: 'server restarted',
              finishedAt: job.finishedAt ?? nowIso(),
              current: null,
            }
          : job;
      jobs.set(restored.id, { job: restored, cancelRequested: false });
    }
  } catch {
    /* A corrupt registry is not worth failing startup over: start from empty. */
    jobs.clear();
  }
}

load();
/* Reconciling a restart is itself a change worth writing back, so the file does not
 * keep claiming a job is running. */
if ([...jobs.values()].some((record) => record.job.error === 'server restarted')) writeNow();

/* ----------------------------------------------------------------- the registry */

export function listJobs(): Job[] {
  return [...jobs.values()]
    .map((record) => forHttp(record.job))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
}

export function getJob(id: string): Job | null {
  const record = jobs.get(id);
  return record ? forHttp(record.job) : null;
}

/** Events truncated to the last `EVENTS_OVER_HTTP`; everything else is as held. */
function forHttp(job: Job): Job {
  return { ...job, events: job.events.slice(-EVENTS_OVER_HTTP) };
}

export function runningJobFor(snapshot: string): Job | null {
  for (const record of jobs.values()) {
    if (record.job.snapshot === snapshot && record.job.status === 'running') {
      return forHttp(record.job);
    }
  }
  return null;
}

export interface StartJobInput {
  kind: JobKind;
  snapshot: string;
  run: string | null;
  plan: Plan | null;
  total: number;
}

/**
 * Register a job and hand back the hooks its worker reports through. The worker itself
 * is started by the caller — the registry never decides what work happens, only how it
 * is watched and how it is asked to stop.
 */
export function createJob(input: StartJobInput): Job {
  const job: Job = {
    id: randomUUID(),
    kind: input.kind,
    snapshot: input.snapshot,
    run: input.run,
    status: 'running',
    startedAt: nowIso(),
    finishedAt: null,
    progress: { done: 0, total: input.total },
    current: null,
    events: [],
    usage: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: null, errors: 0 },
    error: null,
    plan: input.plan,
  };
  jobs.set(job.id, { job, cancelRequested: false });
  persist();
  return forHttp(job);
}

/** The hooks a worker reports through, bound to one job id. */
export function hooksForJob(id: string): PipelineHooks {
  return {
    onEvent: (event) => appendEvent(id, event),
    isCancelled: () => isCancelRequested(id),
    onProgress: (progress) => setProgress(id, progress),
    onUsage: (usage) => addUsage(id, usage),
  };
}

export function appendEvent(id: string, event: JobEvent): void {
  const record = jobs.get(id);
  if (!record) return;
  record.job.events.push(event);
  persist();
}

export function setProgress(
  id: string,
  progress: { done: number; total: number; current: string | null },
): void {
  const record = jobs.get(id);
  if (!record) return;
  record.job.progress = { done: progress.done, total: progress.total };
  record.job.current = progress.current;
  persist();
}

export function addUsage(
  id: string,
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null; ok: boolean },
): void {
  const record = jobs.get(id);
  if (!record) return;
  const current = record.job.usage;
  current.calls += 1;
  current.inputTokens += usage.inputTokens;
  current.outputTokens += usage.outputTokens;
  if (usage.costUsd != null) current.costUsd = (current.costUsd ?? 0) + usage.costUsd;
  if (!usage.ok) current.errors += 1;
  persist();
}

export function finishJob(id: string, status: JobStatus, error: string | null = null): Job | null {
  const record = jobs.get(id);
  if (!record) return null;
  record.job.status = status;
  record.job.finishedAt = nowIso();
  record.job.current = null;
  record.job.error = error;
  flush();
  return forHttp(record.job);
}

/**
 * Ask a job to stop. Cooperative: the worker stops scheduling new threads and lets
 * whatever is in flight finish, then reports `cancelled` itself. A job that is already
 * finished is returned unchanged.
 */
export function requestCancel(id: string): Job | null {
  const record = jobs.get(id);
  if (!record) return null;
  if (record.job.status === 'running') record.cancelRequested = true;
  return forHttp(record.job);
}

export function isCancelRequested(id: string): boolean {
  return jobs.get(id)?.cancelRequested === true;
}

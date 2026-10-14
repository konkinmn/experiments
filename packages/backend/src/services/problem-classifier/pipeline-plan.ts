/**
 * Payment problem classifier — what a pass would do, worked out without doing it.
 *
 * One `prepare*` function per pass. Each one resolves the selection, reads what is
 * already on disk, renders every prompt it would send, and returns both the planned
 * calls and the reasons it cannot start (`blockers`). `planPass` projects that onto the
 * API's `Plan`; `runPass` in `pipeline-run.ts` takes the same prepared object and
 * executes it. So the plan an operator confirms and the work that happens are the same
 * computation, and there is no second place where a selection could be decided.
 *
 * Nothing here reaches the proxy. `prepare*` renders text and counts characters; the
 * only exception is that it reads prompt files, which is what makes it async.
 */
import { existsSync } from 'fs';
import { resolve } from 'path';

import { getPromptById } from '../prompts.js';
import { renderBundleText, type ThreadBundle } from './bundle.js';
import {
  PROBLEM_CLASSIFIER_MODELS,
  PROBLEM_CLASSIFIER_TUNING,
  modelForStage,
  type ProblemClassifierStage,
} from './config.js';
import type { PaymentExtraction } from './extraction.js';
import { REASON, shortlistCandidates, type ShortlistResult } from './shortlist.js';
import {
  CHARS_PER_TOKEN_ESTIMATE,
  RunPaths,
  loadBundle,
  loadSnapshotThreads,
  mulberry32,
  pct,
  readJsonFile,
  regexExtraction,
  selectThreads,
  shuffleInPlace,
  summarisePlannedCalls,
  sum,
  usd,
  hasListPrice,
  type InduceSample,
  type PlannedCall,
  type Pass1Result,
  type Pass2Result,
  type RunPathsResult,
  type SnapshotThread,
} from './runner.js';
import {
  assertName,
  bundlePath,
  snapshotSeed,
  DEFAULT_INDUCTION_LABEL,
} from './pipeline-read.js';
import {
  DEFAULT_PASS1_MODE,
  PASS1_MODES,
  PcError,
  type Pass1Mode,
  type PassKind,
  type PassRequest,
  type Plan,
  type PlanRow,
} from './pipeline-types.js';

/* ------------------------------------------------------------------- constants */

/* v2 of both prompts is the card-leaf change. `extract` was reading a refused card
 * payment as a card query and setting `no_payment_discussed`, which skips the pick
 * entirely; `pick` was told proximity is the weakest reason there is, which is true of a
 * transfer and wrong of a refusal the customer gives by merchant and day with no amount.
 * v1 stays in place — prompts are versioned by file. */
export const PASS1 = {
  extractPromptId: 'pc-extract-v2',
  pickPromptId: 'pc-pick-v2',
  extractMaxTokens: 2000,
  pickMaxTokens: 800,
  /** Two calls a thread; threads at once, from `PC_CONCURRENCY`. */
  concurrency: PROBLEM_CLASSIFIER_TUNING.concurrency,
} as const;

export const PASS2 = {
  /* v2 adds the paragraph that lets the reader disown the identified payment: pass 1
   * picks it automatically and can be wrong, and a reader with no way to say so writes
   * notes about the wrong payment. v3 adds the card restatement and the refusal
   * paragraph — a refused payment needs its reason, the party that refused it, and a
   * plain statement when the record holds neither, which is the common case on
   * transfers. Prompts are versioned by file — v1 and v2 stay in place. */
  readPromptId: 'pc-read-v3',
  readMaxTokens: 2500,
  /** Opus, ~1.5k output tokens a call, `PC_CONCURRENCY` at once against a 60 s proxy. */
  concurrency: PROBLEM_CLASSIFIER_TUNING.concurrency,
} as const;

export const PASS3 = {
  /** One-call mode: induce and assign in the same answer, so the cap covers both. */
  oneCallPromptId: 'pc-induce-v1',
  oneCallMaxTokens: 16000,
  /* Two-step mode: definitions only, no member lists, so 3k is ample. v3 is v2 plus the
   * paragraph that stops a politely handled conversation reading as no problem — v2
   * stays in place, prompts are versioned by file. */
  twoStepPromptId: 'pc-induce-v3',
  twoStepMaxTokens: 3000,
  assignPromptId: 'pc-assign-v1',
  assignMaxTokens: 1500,
  /** One line of output per reading, so a batch of 25 is ~25 short lines. */
  assignBatchSize: 25,
  /** Assign batches in flight at once, from `PC_CONCURRENCY`. */
  assignConcurrency: PROBLEM_CLASSIFIER_TUNING.concurrency,
  /**
   * `PC_INDUCE_SAMPLE` — the most readings one induce call is sent. Above it, two-step
   * mode induces from a seeded sample of this many and still assigns every reading;
   * one-call mode refuses, because it induces and assigns in the same answer.
   */
  induceSampleSize: PROBLEM_CLASSIFIER_TUNING.induceSampleSize,
  /** Over this, the single one-call induction is not worth attempting at all. */
  inputTokenWarn: 800_000,
} as const;

export const MEASURE = {
  defaultN: 20,
  concurrency: 3,
  /** One token out is all we need; anything more is paid-for text we throw away. */
  maxTokens: 1,
  systemPrompt: 'You are measuring input size. Reply with a single character.',
  /** The Haiku context window — a thread over this cannot run `extract` or `pick`. */
  windowTokens: 200_000,
  stages: ['extract', 'pick', 'read'] as const,
} as const;

export type MeasureStage = (typeof MEASURE.stages)[number];

/* ------------------------------------------------------------ prepared results */

interface PreparedBase {
  snapshot: string;
  run: string;
  request: PassRequest;
  /** `null` only for a measurement run started from the CLI, which has no run label. */
  paths: RunPathsResult | null;
  calls: PlannedCall[];
  /** CLI header lines, printed above the plan table. */
  header: string[];
  notes: string[];
  blockers: string[];
  threadsSelected: number;
  threadsToDo: number;
}

/**
 * The regex pass-1a for one thread, worked out at plan time and carried into the run.
 *
 * Computed here rather than in `runPass1` for the reason the file header gives: the plan
 * an operator confirms and the work that happens are the same computation. The `pick`
 * chars in a `regex-first` plan are therefore exact for the threads that need no
 * `extract`, not an estimate.
 */
export interface RegexPass1a {
  extraction: PaymentExtraction;
  shortlist: ShortlistResult;
  /** The `pick` rendering over `shortlist`. `''` when the shortlist is empty. */
  pickText: string;
}

export interface Pass1Job {
  threadId: string;
  pathKey: string;
  bundle: ThreadBundle;
  extractText: string;
  resultPath: string;
  /** `null` in `extract-always`, where the shortlist cannot exist before the call. */
  regex: RegexPass1a | null;
}

export interface Pass1Prepared extends PreparedBase {
  pass: 'pass1';
  paths: RunPathsResult;
  pass1Mode: Pass1Mode;
  jobs: Pass1Job[];
  alreadyDone: number;
  extractSystem: string;
  pickSystem: string;
}

export interface Pass2Job {
  threadId: string;
  pathKey: string;
  pass1: Pass1Result;
  readText: string;
  resultPath: string;
}

export interface Pass2Prepared extends PreparedBase {
  pass: 'pass2';
  paths: RunPathsResult;
  jobs: Pass2Job[];
  alreadyDone: number;
  readSystem: string;
}

export interface ReadingBlock {
  threadId: string;
  block: string;
}

export interface Pass3Prepared extends PreparedBase {
  pass: 'pass3';
  paths: RunPathsResult;
  label: string;
  mode: 'two-step' | 'one-call';
  outPath: string;
  induceSystem: string;
  assignSystem: string | null;
  inducePromptId: string;
  induceMaxTokens: number;
  /** Every reading in the snapshot, in snapshot order — what the assign calls cover. */
  readings: ReadingBlock[];
  batches: ReadingBlock[][];
  induceUserMessage: string;
  /** The draw behind `induceUserMessage`, or `null` when it holds every reading. */
  induceSample: InduceSample | null;
}

export interface MeasureJob {
  threadId: string;
  stage: MeasureStage;
  chars: number;
  text: string;
}

export interface MeasurePrepared extends PreparedBase {
  pass: 'measure';
  jobs: MeasureJob[];
  threadIds: string[];
  /** Printed instead of the shared plan table: measure has its own column set. */
  planLines: string[];
  /** `--n` larger than the population: the CLI says so before the plan. */
  shortPopulationNote: string | null;
}

/**
 * Pass 1 → 2 → 3 as one job. Only pass 1 can be prepared for real up front: pass 2
 * needs pass 1's answers and pass 3 needs pass 2's readings, so `runAll` prepares each
 * of them when the one before it has finished. What is held here is the pass-1 plan and
 * the sizing of the two that follow.
 */
export interface AllPrepared extends PreparedBase {
  pass: 'all';
  paths: RunPathsResult;
  label: string;
  mode: 'two-step' | 'one-call';
  pass1: Pass1Prepared;
  /** Every selected thread, in snapshot order — what passes 1 and 2 will run over. */
  threadIds: string[];
  /** Pass 3's assign calls, which is a function of the snapshot, not of the selection. */
  assignBatches: number;
  /** A job's `progress.total`: one unit per thread per pass, plus pass 3's calls. */
  totalUnits: number;
}

export type Prepared =
  | Pass1Prepared
  | Pass2Prepared
  | Pass3Prepared
  | MeasurePrepared
  | AllPrepared;

/** Every stage the one-shot pipeline touches, in the order it touches them. */
const ALL_PASS_STAGES: ProblemClassifierStage[] = ['extract', 'pick', 'read', 'induce', 'assign'];

/* -------------------------------------------------------------------- helpers */

async function requirePrompt(id: string): Promise<string> {
  const prompt = await getPromptById(id);
  if (!prompt) throw new PcError(`prompt ${id} not found`, 500);
  return prompt.content;
}

/** Bundles have to exist before any pass can render a prompt from them. */
function bundleBlocker(snapshot: string, threads: SnapshotThread[]): string | null {
  const missing = threads
    .map((thread) => thread.thread_id)
    .filter((id) => !existsSync(bundlePath(snapshot, id)));
  if (missing.length === 0) return null;
  return `bundles are missing for ${missing.length} of ${threads.length} selected thread(s): ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ', …' : ''} — build the bundles first`;
}

/* ---------------------------------------------------------------------- pass 1 */

/** The regex pass-1a and the `pick` rendering it produces. Deterministic, no calls. */
export function prepareRegexPass1a(bundle: ThreadBundle): RegexPass1a {
  const extraction = regexExtraction(bundle);
  const shortlist = shortlistCandidates(bundle, extraction);
  return {
    extraction,
    shortlist,
    pickText:
      shortlist.rows.length === 0 ? '' : renderBundleText(bundle, { stage: 'pick', shortlist }),
  };
}

export function resolvePass1Mode(request: PassRequest): Pass1Mode {
  const mode = request.pass1Mode ?? DEFAULT_PASS1_MODE;
  if (!PASS1_MODES.includes(mode)) {
    throw new PcError(`pass1Mode must be one of ${PASS1_MODES.join(', ')}`);
  }
  return mode;
}

export async function preparePass1(
  snapshot: string,
  run: string,
  request: PassRequest,
): Promise<Pass1Prepared> {
  const paths = RunPaths(snapshot, run);
  const snapshotThreads = loadSnapshotThreads(snapshot);
  const selected = selectThreads(snapshotThreads, request.threads, request.n);
  const force = request.force === true;
  const pass1Mode = resolvePass1Mode(request);

  const extractSystem = await requirePrompt(PASS1.extractPromptId);
  const pickSystem = await requirePrompt(PASS1.pickPromptId);

  const blockers: string[] = [];
  const blocker = bundleBlocker(snapshot, selected);
  if (blocker) blockers.push(blocker);

  const jobs: Pass1Job[] = [];
  const calls: PlannedCall[] = [];
  let alreadyDone = 0;
  if (blockers.length === 0) {
    for (const thread of selected) {
      const resultPath = resolve(paths.pass1Dir, `${thread.thread_id}.json`);
      if (existsSync(resultPath) && !force) {
        alreadyDone += 1;
        continue;
      }
      const bundle = loadBundle(snapshot, thread.thread_id);
      jobs.push({
        threadId: thread.thread_id,
        pathKey: thread.path_key,
        bundle,
        extractText: renderBundleText(bundle, { stage: 'extract' }),
        resultPath,
        regex: pass1Mode === 'regex-first' ? prepareRegexPass1a(bundle) : null,
      });
    }
    for (const job of jobs) {
      calls.push({
        stage: 'extract',
        model: modelForStage('extract'),
        chars: extractSystem.length + job.extractText.length,
        maxTokens: PASS1.extractMaxTokens,
      });
      /* `regex-first`: the shortlist `pick` will see exists already, so the row count
       * driving this rendering's size is the real one and a thread with no regex
       * shortlist plans no `pick` call at all.
       *
       * `extract-always`: the row count follows a pass-1a answer we do not have yet, so
       * the regex extraction stands in for sizing only — nothing in the run uses it. */
      const pickText =
        job.regex != null
          ? job.regex.pickText
          : renderBundleText(job.bundle, {
              stage: 'pick',
              shortlist: shortlistCandidates(job.bundle, regexExtraction(job.bundle)),
            });
      if (pickText === '') continue;
      calls.push({
        stage: 'pick',
        model: modelForStage('pick'),
        chars: pickSystem.length + pickText.length,
        maxTokens: PASS1.pickMaxTokens,
      });
    }
  }

  const regexShortlisted = jobs.filter((job) => (job.regex?.shortlist.rows.length ?? 0) > 0).length;

  return {
    pass: 'pass1',
    snapshot,
    run,
    request,
    paths,
    pass1Mode,
    jobs,
    alreadyDone,
    extractSystem,
    pickSystem,
    calls,
    header: [
      `pass 1 · snapshot ${snapshot} · run ${run} · mode ${pass1Mode} · ${selected.length} threads selected · ${jobs.length} to do · ${alreadyDone} already have a result file${force ? ' (--force: all re-run)' : ''}`,
      `prompts ${PASS1.extractPromptId} (max_tokens ${PASS1.extractMaxTokens}) and ${PASS1.pickPromptId} (max_tokens ${PASS1.pickMaxTokens})`,
    ],
    notes:
      pass1Mode === 'regex-first'
        ? [
            'extract runs only as fallback; this count is the ceiling',
            `${regexShortlisted} of ${jobs.length} threads have a non-empty regex shortlist and go straight to pick; the other ${jobs.length - regexShortlisted} reach extract because there is nothing to pick from`,
            'pick chars are exact: the shortlist is the regex one the run will use, not a stand-in',
            'pick is counted once a thread — a thread whose pick answers NOT_FOUND pays a second pick call when the merged shortlist differs, so this row can be exceeded',
          ]
        : [
            'pick chars are estimated from a regex pass-1a extraction; the real shortlist may be shorter or longer',
            'a thread whose shortlist is empty skips the pick call, so the pick call count is an upper bound',
          ],
    blockers,
    threadsSelected: selected.length,
    threadsToDo: jobs.length,
  };
}

/* ---------------------------------------------------------------------- pass 2 */

export async function preparePass2(
  snapshot: string,
  run: string,
  request: PassRequest,
): Promise<Pass2Prepared> {
  const paths = RunPaths(snapshot, run);
  const snapshotThreads = loadSnapshotThreads(snapshot);
  const selected = selectThreads(snapshotThreads, request.threads, request.n);
  const force = request.force === true;

  const readSystem = await requirePrompt(PASS2.readPromptId);

  const blockers: string[] = [];
  /* Pass 1 first: its absence is the blocker the operator acts on, and naming the
   * missing threads is the whole point of the message. */
  const missingPass1 = selected
    .map((thread) => thread.thread_id)
    .filter((id) => !existsSync(resolve(paths.pass1Dir, `${id}.json`)));
  if (missingPass1.length > 0) {
    blockers.push(
      `pass 2 needs a pass-1 result for every selected thread. Missing ${missingPass1.length}: ${missingPass1.join(', ')}`,
    );
  }
  const blocker = bundleBlocker(snapshot, selected);
  if (blocker) blockers.push(blocker);

  const jobs: Pass2Job[] = [];
  let alreadyDone = 0;
  if (blockers.length === 0) {
    for (const thread of selected) {
      const resultPath = resolve(paths.pass2Dir, `${thread.thread_id}.json`);
      if (existsSync(resultPath) && !force) {
        alreadyDone += 1;
        continue;
      }
      const pass1 = readJsonFile<Pass1Result>(
        resolve(paths.pass1Dir, `${thread.thread_id}.json`),
      );
      /* RESOLVED and ORDER_ONLY both carry an id `renderBundleText` can resolve — a
       * ledger row for the first, a payment order that never posted for the second.
       * NOT_FOUND and UNRESOLVED_HANDLE carry nothing, and the prompt reads the
       * absence. */
      jobs.push({
        threadId: thread.thread_id,
        pathKey: thread.path_key,
        pass1,
        readText: renderBundleText(loadBundle(snapshot, thread.thread_id), {
          stage: 'read',
          identifiedId: pass1.identified?.id ?? null,
        }),
        resultPath,
      });
    }
  }

  return {
    pass: 'pass2',
    snapshot,
    run,
    request,
    paths,
    jobs,
    alreadyDone,
    readSystem,
    calls: jobs.map((job) => ({
      stage: 'read' as const,
      model: modelForStage('read'),
      chars: readSystem.length + job.readText.length,
      maxTokens: PASS2.readMaxTokens,
    })),
    header: [
      `pass 2 · snapshot ${snapshot} · run ${run} · ${selected.length} threads selected · ${jobs.length} to do · ${alreadyDone} already have a reading${force ? ' (--force: all re-run)' : ''}`,
      `prompt ${PASS2.readPromptId} (max_tokens ${PASS2.readMaxTokens})`,
    ],
    notes: [],
    blockers,
    threadsSelected: selected.length,
    threadsToDo: jobs.length,
  };
}

/* ---------------------------------------------------------------------- pass 3 */

/**
 * The category set as the assign prompt describes it: numbered, name, definition and
 * the `removed by` line. `example_thread_ids` are deliberately left out — showing the
 * assigner which threads the inducer already placed would anchor it.
 */
export function renderCategoryBlock(
  categories: { name: string; definition: string; what_removes_it: string }[],
): string {
  const lines = ['Categories:', ''];
  categories.forEach((category, index) => {
    lines.push(`${index + 1}. ${category.name}`);
    if (category.definition.trim() !== '') lines.push(`   ${category.definition.trim()}`);
    if (category.what_removes_it.trim() !== '') {
      lines.push(`   removed by: ${category.what_removes_it.trim()}`);
    }
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}

export function assignUserMessage(categoryBlock: string, batch: ReadingBlock[]): string {
  return `${categoryBlock}\n\n${batch.map((r) => r.block).join('\n\n')}\n`;
}

/**
 * The readings the induce call is sent, and the record of the draw when that is a
 * sample rather than all of them.
 *
 * A snapshot of ~1,500 readings does not fit one induce call comfortably, so above
 * `PASS3.induceSampleSize` the categories are induced from that many, drawn with the
 * snapshot manifest's seed. Assignment is unaffected: every reading is still placed
 * against the induced set, in batches, so no case is dropped by the sample.
 *
 * The draw is a seeded shuffle of the *indices*, then the chosen ones back in
 * ascending order — so the sample is deterministic from (reading count, seed) and the
 * induce call still reads in snapshot order, like every other prompt this tool sends.
 */
export function sampleInduceReadings(
  readings: ReadingBlock[],
  seed: number,
  size: number = PASS3.induceSampleSize,
): { induceReadings: ReadingBlock[]; induceSample: InduceSample | null } {
  if (readings.length <= size) return { induceReadings: readings, induceSample: null };
  const indices = readings.map((_, index) => index);
  shuffleInPlace(indices, mulberry32(seed));
  const chosen = indices.slice(0, size).sort((a, b) => a - b);
  const induceReadings = chosen.map((index) => readings[index]);
  return {
    induceReadings,
    induceSample: { size, seed, thread_ids: induceReadings.map((r) => r.threadId) },
  };
}

export async function preparePass3(
  snapshot: string,
  run: string,
  request: PassRequest,
): Promise<Pass3Prepared> {
  const paths = RunPaths(snapshot, run);
  const snapshotThreads = loadSnapshotThreads(snapshot);
  const label = request.label ?? DEFAULT_INDUCTION_LABEL;
  assertName('induction label', label);
  const mode = request.mode ?? 'two-step';
  if (mode !== 'two-step' && mode !== 'one-call') {
    throw new PcError('mode must be two-step or one-call');
  }

  const blockers: string[] = [];
  const outPath = resolve(paths.pass3Dir, `${label}.json`);
  if (existsSync(outPath)) {
    blockers.push(
      `${outPath} already exists — pass a different --label rather than overwrite an induction`,
    );
  }

  const inducePromptId = mode === 'two-step' ? PASS3.twoStepPromptId : PASS3.oneCallPromptId;
  const induceMaxTokens = mode === 'two-step' ? PASS3.twoStepMaxTokens : PASS3.oneCallMaxTokens;
  const induceSystem = await requirePrompt(inducePromptId);
  const assignSystem = mode === 'two-step' ? await requirePrompt(PASS3.assignPromptId) : null;

  const missing = snapshotThreads
    .map((thread) => thread.thread_id)
    .filter((id) => !existsSync(resolve(paths.pass2Dir, `${id}.json`)));
  if (missing.length > 0) {
    blockers.push(
      `pass 3 needs a pass-2 reading for every thread in the snapshot. ${snapshotThreads.length - missing.length}/${snapshotThreads.length} present; missing ${missing.length}: ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ', …' : ''}`,
    );
  }

  /* One-call mode induces and assigns in the same answer, so its input cannot be
   * sampled: a category set induced from 400 readings that also has to place all 1,547
   * of them is not a thing the one call can return. Two-step mode has no such problem
   * and is the mode a snapshot this size runs in. */
  if (mode === 'one-call' && snapshotThreads.length > PASS3.induceSampleSize) {
    blockers.push(
      `one-call mode sends every reading in one call and this snapshot holds ${snapshotThreads.length}, over the PC_INDUCE_SAMPLE limit of ${PASS3.induceSampleSize} — it cannot be sampled without breaking the mode's contract (induce and assign in one answer). Use --mode two-step, which induces from a seeded sample of ${PASS3.induceSampleSize} and still assigns all ${snapshotThreads.length}`,
    );
  }

  const readings: ReadingBlock[] = [];
  const batches: ReadingBlock[][] = [];
  let induceUserMessage = '';
  let induceSample: InduceSample | null = null;
  const calls: PlannedCall[] = [];
  const header = [
    `pass 3 · snapshot ${snapshot} · run ${run} · induction label ${label} · mode ${mode}`,
  ];
  const notes: string[] = [];

  if (missing.length === 0) {
    /* Snapshot order, in the readings and inside every batch. */
    for (const thread of snapshotThreads) {
      const reading = readJsonFile<Pass2Result>(
        resolve(paths.pass2Dir, `${thread.thread_id}.json`),
      );
      readings.push({
        threadId: thread.thread_id,
        block: `### thread ${thread.thread_id}\n${reading.reading.trim()}`,
      });
    }
    /* Two-step mode induces from a sample once there are more readings than one call
     * can hold; one-call mode has already refused above if it is over the same line. */
    const drawn =
      mode === 'two-step'
        ? sampleInduceReadings(readings, snapshotSeed(snapshot))
        : { induceReadings: readings, induceSample: null };
    induceSample = drawn.induceSample;
    induceUserMessage = `${drawn.induceReadings.map((r) => r.block).join('\n\n')}\n`;
    /* Assignment always covers every reading, sampled induction or not. */
    for (let i = 0; i < readings.length; i += PASS3.assignBatchSize) {
      batches.push(readings.slice(i, i + PASS3.assignBatchSize));
    }

    const induceChars = induceSystem.length + induceUserMessage.length;
    const estInduceInputTokens = Math.round(induceChars / CHARS_PER_TOKEN_ESTIMATE);
    calls.push({
      stage: 'induce',
      model: modelForStage('induce'),
      chars: induceChars,
      maxTokens: induceMaxTokens,
    });

    if (mode === 'one-call') {
      header.push(
        `ONE call · ${snapshotThreads.length} readings · ${induceChars.toLocaleString('en-GB')} chars · est ${estInduceInputTokens.toLocaleString('en-GB')} input tokens · model ${modelForStage('induce')} · max_tokens ${induceMaxTokens}`,
        `prompt ${inducePromptId}`,
      );
      notes.push(
        estInduceInputTokens > PASS3.inputTokenWarn
          ? `WARNING: the estimate exceeds ${PASS3.inputTokenWarn.toLocaleString('en-GB')} input tokens — this call will not fit and the induction has to be split or the readings shortened`
          : `within the ${PASS3.inputTokenWarn.toLocaleString('en-GB')}-token check`,
        `output is capped at ${induceMaxTokens} tokens; at a few tokens a second that alone can run past the stage proxy's 60 s REQUEST_TIMEOUT on /api/chat, so expect this call to be the one that times out`,
      );
    } else {
      /**
       * At plan time the categories do not exist yet, so the assign calls' size can
       * only be bounded. The bound is the induce call's own `max_tokens` in chars: the
       * category block is built from the induce answer with the example ids stripped,
       * so it cannot be larger than that answer.
       */
      const categoryBlockCharsBound = PASS3.twoStepMaxTokens * CHARS_PER_TOKEN_ESTIMATE;
      const assignChars = batches.map(
        (batch) => assignSystem!.length + categoryBlockCharsBound + assignUserMessage('', batch).length,
      );
      for (const chars of assignChars) {
        calls.push({
          stage: 'assign',
          model: modelForStage('assign'),
          chars,
          maxTokens: PASS3.assignMaxTokens,
        });
      }
      if (induceSample != null) {
        header.push(
          `induce over ${induceSample.size.toLocaleString('en-GB')} of ${readings.length.toLocaleString('en-GB')} readings (seeded sample)`,
        );
      }
      header.push(
        `1 induce call · ${drawn.induceReadings.length} readings · ${induceChars.toLocaleString('en-GB')} chars · est ${estInduceInputTokens.toLocaleString('en-GB')} input tokens · model ${modelForStage('induce')} · max_tokens ${induceMaxTokens}`,
        `${batches.length} assign ${batches.length === 1 ? 'call' : 'calls'} · up to ${PASS3.assignBatchSize} readings a batch · chars sum ${sum(assignChars).toLocaleString('en-GB')} · p50 ${pct(assignChars, 50).toLocaleString('en-GB')} · max ${pct(assignChars, 100).toLocaleString('en-GB')} · model ${modelForStage('assign')} · max_tokens ${PASS3.assignMaxTokens}`,
        `prompts ${inducePromptId} + ${PASS3.assignPromptId}`,
      );
      if (induceSample != null) {
        notes.push(
          `the induce sample is drawn with the snapshot's own seed ${induceSample.seed}, so it is the same ${induceSample.size} readings on every run of this snapshot, and it is recorded as induce_sample in ${outPath}`,
          `all ${readings.length.toLocaleString('en-GB')} readings are still assigned against the induced set — the sample narrows what the categories are induced from, never what is placed`,
        );
      }
      notes.push(
        estInduceInputTokens > PASS3.inputTokenWarn
          ? `WARNING: the induce estimate exceeds ${PASS3.inputTokenWarn.toLocaleString('en-GB')} input tokens — this call will not fit and the readings have to be shortened`
          : `induce is within the ${PASS3.inputTokenWarn.toLocaleString('en-GB')}-token check`,
        `assign sizes are an upper bound: the category block does not exist until induce returns, so it is counted at its ceiling of ${categoryBlockCharsBound.toLocaleString('en-GB')} chars (induce max_tokens × ${CHARS_PER_TOKEN_ESTIMATE})`,
        'a thread that comes back with no line, or with a category number that is not in the set, is retried once on its own before it is called unassigned',
      );
    }
  }

  return {
    pass: 'pass3',
    snapshot,
    run,
    request,
    paths,
    label,
    mode,
    outPath,
    induceSystem,
    assignSystem,
    inducePromptId,
    induceMaxTokens,
    readings,
    batches,
    induceUserMessage,
    induceSample,
    calls,
    header,
    notes,
    blockers,
    threadsSelected: snapshotThreads.length,
    threadsToDo: blockers.length === 0 ? snapshotThreads.length : 0,
  };
}

/* --------------------------------------------------------------------- measure */

/**
 * `run` may be `''`: `pc-measure-tokens.ts` has no `--run` flag, because a measurement
 * writes to `<snapshot>/measure/` and logs no calls. The HTTP surface always has one.
 */
export async function prepareMeasure(
  snapshot: string,
  run: string,
  request: PassRequest,
): Promise<MeasurePrepared> {
  const paths = run === '' ? null : RunPaths(snapshot, run);
  const snapshotThreads = loadSnapshotThreads(snapshot);
  /* `selectThreads` owns the slice and the range check, the same one pass 1 and pass 2
   * apply to their own `n`, so `--n` means one thing across the tool. It refuses an `n`
   * larger than the population — but the *default* must not fail on a small snapshot,
   * so the default alone is clamped and the note says it was. */
  const requestedN = request.n ?? MEASURE.defaultN;
  const n = request.n ?? Math.min(MEASURE.defaultN, snapshotThreads.length);
  const shortPopulationNote =
    n < requestedN
      ? `note: population holds ${snapshotThreads.length} threads, fewer than --n ${requestedN}`
      : null;
  const threadIds = selectThreads(snapshotThreads, undefined, n).map((thread) => thread.thread_id);

  const blockers: string[] = [];
  const missing = threadIds.filter((id) => !existsSync(bundlePath(snapshot, id)));
  if (missing.length > 0) {
    blockers.push(
      `bundles are missing for ${missing.length} of ${threadIds.length} selected thread(s): ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ', …' : ''} — build the bundles first`,
    );
  }

  const jobs: MeasureJob[] = [];
  const calls: PlannedCall[] = [];
  if (blockers.length === 0) {
    for (const threadId of threadIds) {
      const bundle = loadBundle(snapshot, threadId);
      const extraction = regexExtraction(bundle);
      const shortlist: ShortlistResult = shortlistCandidates(bundle, extraction);
      /* Pass 1b hands back one handle. The first explicit-id row is the closest thing
       * to that answer available without a call; a thread with none reads NOT_FOUND. */
      const identified = shortlist.rows.find((row) => row.reasons.includes(REASON.explicitId));
      const texts: Record<MeasureStage, string> = {
        extract: renderBundleText(bundle, { stage: 'extract' }),
        pick: renderBundleText(bundle, { stage: 'pick', shortlist }),
        read: renderBundleText(bundle, { stage: 'read', identifiedId: identified?.id ?? null }),
      };
      for (const stage of MEASURE.stages) {
        jobs.push({ threadId, stage, chars: texts[stage].length, text: texts[stage] });
      }
    }
    for (const job of jobs) {
      calls.push({
        stage: job.stage,
        model: modelForStage(job.stage),
        chars: job.chars,
        maxTokens: MEASURE.maxTokens,
      });
    }
  }

  return {
    pass: 'measure',
    snapshot,
    run,
    request,
    paths,
    jobs,
    threadIds,
    planLines: renderMeasurePlanLines(snapshot, threadIds, jobs),
    shortPopulationNote,
    calls,
    header: [],
    notes: [],
    blockers,
    threadsSelected: threadIds.length,
    threadsToDo: blockers.length === 0 ? threadIds.length : 0,
  };
}

/**
 * Measure prints its own table: `est tokens` and `est cost` rather than the split
 * input/output columns the passes use, plus the context-window line. Kept byte-for-byte
 * as `pc-measure-tokens.ts` printed it.
 */
export function renderMeasurePlanLines(
  snapshot: string,
  threadIds: string[],
  jobs: MeasureJob[],
): string[] {
  const lines: string[] = [];
  const calls: PlannedCall[] = jobs.map((job) => ({
    stage: job.stage,
    model: modelForStage(job.stage),
    chars: job.chars,
    maxTokens: MEASURE.maxTokens,
  }));
  const table = summarisePlannedCalls(calls);
  lines.push(
    `PLAN · snapshot ${snapshot} · ${threadIds.length} threads · ${jobs.length} calls · provider ${PROBLEM_CLASSIFIER_MODELS.provider} · max_tokens ${MEASURE.maxTokens}`,
  );
  lines.push(
    `list prices are assumptions for this plan (haiku-4-5 $1, opus-4-8 $5 per 1M input tokens); the real cost comes from the proxy's usage.total_cost_usd`,
  );
  lines.push(
    `token estimate is chars / ${CHARS_PER_TOKEN_ESTIMATE}; output is ${MEASURE.maxTokens} token per call and is not priced here`,
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
      'est tokens'.padStart(12),
      'est cost'.padStart(12),
    ].join(''),
  );
  for (const stage of MEASURE.stages) {
    const row = table.rows.find((candidate) => candidate.stage === stage);
    if (!row) continue;
    lines.push(
      [
        row.stage.padEnd(8),
        String(row.calls).padStart(6),
        `  ${row.model}`.padEnd(20),
        String(row.charsSum).padStart(12),
        String(row.charsP50).padStart(12),
        String(row.charsMax).padStart(12),
        String(row.estInputTokens).padStart(12),
        (hasListPrice(row.model) ? usd(row.estInputCostUsd) : 'unknown').padStart(12),
      ].join(''),
    );
  }
  lines.push('');
  lines.push(
    table.costKnown
      ? `estimated total: ${usd(table.estInputCostUsd)}`
      : `estimated total: ${usd(table.estInputCostUsd)} plus the stages with no list price above`,
  );
  const overWindow = jobs.filter(
    (job) => job.stage !== 'read' && job.chars / CHARS_PER_TOKEN_ESTIMATE > MEASURE.windowTokens,
  );
  lines.push(
    `threads over the ${MEASURE.windowTokens.toLocaleString('en-GB')}-token window on extract or pick, by estimate: ${new Set(overWindow.map((job) => job.threadId)).size}`,
  );
  return lines;
}

/* ------------------------------------------------------------------- all passes */

/**
 * The one identified payment a pass-1 run would most likely land on, worked out without
 * a call: the first shortlist row an explicit id put there. The same stand-in the
 * measurement plan uses to size its `read` rendering — sizing only, never a result.
 */
function syntheticIdentifiedId(bundle: ThreadBundle): string | null {
  const shortlist = shortlistCandidates(bundle, regexExtraction(bundle));
  const row = shortlist.rows.find((candidate) => candidate.reasons.includes(REASON.explicitId));
  return row?.id ?? null;
}

/**
 * The whole pipeline as one plan. Pass 1 is prepared for real; pass 2 and pass 3 are
 * sized as if the pass before them will complete, because there is no other way to
 * price a one-shot run before it starts.
 *
 * Both estimates follow a convention the single-pass plans already use:
 *  - pass 2's `read` rendering needs pass 1's identified payment. Where a pass-1 result
 *    is on disk it is read; where it is not, the synthetic extraction stands in.
 *  - pass 3's readings do not exist yet. One already on disk is counted at its real
 *    length; one that is not is counted at pass 2's `max_tokens` ceiling in chars — the
 *    same ceiling the pass-3 plan applies to its category block.
 *
 * `blockers` are only the two a one-shot run cannot route round: a missing bundle, and
 * (added by the route, which owns the registry) a job already running on the snapshot.
 * An existing pass-3 label is deliberately *not* a blocker here — pass 3 is an hour
 * away and the label is checked again when its own prepare runs.
 */
export async function prepareAll(
  snapshot: string,
  run: string,
  request: PassRequest,
): Promise<AllPrepared> {
  const paths = RunPaths(snapshot, run);
  const snapshotThreads = loadSnapshotThreads(snapshot);
  const selected = selectThreads(snapshotThreads, request.threads, request.n);
  const force = request.force === true;
  const label = request.label ?? DEFAULT_INDUCTION_LABEL;
  assertName('induction label', label);
  const mode = request.mode ?? 'two-step';
  if (mode !== 'two-step' && mode !== 'one-call') {
    throw new PcError('mode must be two-step or one-call');
  }

  const pass1 = await preparePass1(snapshot, run, { ...request, pass: 'pass1' });
  /* The bundles the pass-1 plan already read, so no thread's bundle is read twice. */
  const bundles = new Map<string, ThreadBundle>(
    pass1.jobs.map((job) => [job.threadId, job.bundle]),
  );

  const blockers: string[] = [];
  const missingBundles = bundleBlocker(snapshot, selected);
  if (missingBundles) blockers.push(missingBundles);

  const readSystem = await requirePrompt(PASS2.readPromptId);
  const inducePromptId = mode === 'two-step' ? PASS3.twoStepPromptId : PASS3.oneCallPromptId;
  const induceMaxTokens = mode === 'two-step' ? PASS3.twoStepMaxTokens : PASS3.oneCallMaxTokens;
  const induceSystem = await requirePrompt(inducePromptId);
  const assignSystem = mode === 'two-step' ? await requirePrompt(PASS3.assignPromptId) : null;

  const estimatedReadingChars = PASS2.readMaxTokens * CHARS_PER_TOKEN_ESTIMATE;
  const categoryBlockCharsBound = PASS3.twoStepMaxTokens * CHARS_PER_TOKEN_ESTIMATE;

  const calls: PlannedCall[] = [...pass1.calls];
  const notes: string[] = [
    'passes run in order; pass 2 and 3 plans are estimates until the previous pass completes',
    ...pass1.notes,
  ];
  let threadsToDo = 0;
  let assignBatches = 0;
  let estimatedReadings = 0;

  if (blockers.length === 0) {
    /* ---- pass 2, over the selection, in snapshot order */
    for (const thread of selected) {
      const pass1Path = resolve(paths.pass1Dir, `${thread.thread_id}.json`);
      const pass2Path = resolve(paths.pass2Dir, `${thread.thread_id}.json`);
      const needsPass1 = force || !existsSync(pass1Path);
      const needsPass2 = force || !existsSync(pass2Path);
      if (needsPass1 || needsPass2) threadsToDo += 1;
      if (!needsPass2) continue;
      const bundle = bundles.get(thread.thread_id) ?? loadBundle(snapshot, thread.thread_id);
      bundles.set(thread.thread_id, bundle);
      const identifiedId = needsPass1
        ? syntheticIdentifiedId(bundle)
        : (readJsonFile<Pass1Result>(pass1Path).identified?.id ?? null);
      calls.push({
        stage: 'read',
        model: modelForStage('read'),
        chars:
          readSystem.length + renderBundleText(bundle, { stage: 'read', identifiedId }).length,
        maxTokens: PASS2.readMaxTokens,
      });
    }

    /* ---- pass 3, over the whole snapshot: a taxonomy is induced from every reading */
    const readings: ReadingBlock[] = snapshotThreads.map((thread) => {
      const pass2Path = resolve(paths.pass2Dir, `${thread.thread_id}.json`);
      if (!force && existsSync(pass2Path)) {
        const reading = readJsonFile<Pass2Result>(pass2Path).reading.trim();
        return { threadId: thread.thread_id, block: `### thread ${thread.thread_id}\n${reading}` };
      }
      estimatedReadings += 1;
      return {
        threadId: thread.thread_id,
        block: `### thread ${thread.thread_id}\n${'.'.repeat(estimatedReadingChars)}`,
      };
    });
    /* Sized the way pass 3's own prepare will draw it, so a one-shot plan does not
     * price an induce call four times the size of the one that gets sent. */
    const drawn =
      mode === 'two-step'
        ? sampleInduceReadings(readings, snapshotSeed(snapshot))
        : { induceReadings: readings, induceSample: null };
    const induceUserMessage = `${drawn.induceReadings.map((r) => r.block).join('\n\n')}\n`;
    calls.push({
      stage: 'induce',
      model: modelForStage('induce'),
      chars: induceSystem.length + induceUserMessage.length,
      maxTokens: induceMaxTokens,
    });
    if (drawn.induceSample != null) {
      notes.push(
        `induce over ${drawn.induceSample.size.toLocaleString('en-GB')} of ${readings.length.toLocaleString('en-GB')} readings (seeded sample); all ${readings.length.toLocaleString('en-GB')} are still assigned`,
      );
    }
    /* Another refusal pass 3 makes on its own terms an hour into the run — a note here
     * rather than a blocker, for the same reason the two below are notes. */
    if (mode === 'one-call' && readings.length > PASS3.induceSampleSize) {
      notes.push(
        `one-call mode cannot be sampled and pass 3 refuses over ${PASS3.induceSampleSize} readings; this snapshot holds ${readings.length.toLocaleString('en-GB')}, so this run stops after pass 2 unless it is started in two-step mode`,
      );
    }

    if (mode === 'two-step') {
      for (let i = 0; i < readings.length; i += PASS3.assignBatchSize) {
        const batch = readings.slice(i, i + PASS3.assignBatchSize);
        assignBatches += 1;
        calls.push({
          stage: 'assign',
          model: modelForStage('assign'),
          chars:
            assignSystem!.length + categoryBlockCharsBound + assignUserMessage('', batch).length,
          maxTokens: PASS3.assignMaxTokens,
        });
      }
    }

    if (estimatedReadings > 0) {
      notes.push(
        `${estimatedReadings} of ${snapshotThreads.length} pass-3 readings do not exist yet and are counted at pass 2's ceiling of ${estimatedReadingChars.toLocaleString('en-GB')} chars each (read max_tokens × ${CHARS_PER_TOKEN_ESTIMATE})`,
      );
    }
    if (mode === 'two-step') {
      notes.push(
        `assign sizes are an upper bound: the category block does not exist until induce returns, so it is counted at its ceiling of ${categoryBlockCharsBound.toLocaleString('en-GB')} chars (induce max_tokens × ${CHARS_PER_TOKEN_ESTIMATE})`,
      );
    }
    notes.push(
      'a thread that fails in pass 1 or pass 2 is retried once; if any is still unfinished the job fails there and pass 3 is not sent',
    );
    /* Both of these are refusals pass 3 makes on its own terms, an hour after this plan
     * is confirmed and after passes 1 and 2 have spent. They are not blockers — pass 3
     * is checked again when its own prepare runs — but a plan that does not mention them
     * is a plan that hides a wasted sweep. */
    if (selected.length < snapshotThreads.length) {
      notes.push(
        `pass 3 needs a reading for every one of the ${snapshotThreads.length} threads in the snapshot and this run covers ${selected.length}, so it will refuse unless the rest are already read`,
      );
    }
    if (existsSync(resolve(paths.pass3Dir, `${label}.json`))) {
      notes.push(
        `an induction labelled ${label} already exists in this run, and pass 3 never overwrites one — pass a different label or this run stops after pass 2`,
      );
    }
  }

  const totalUnits = selected.length * 2 + 1 + assignBatches;

  return {
    pass: 'all',
    snapshot,
    run,
    request,
    paths,
    label,
    mode,
    pass1,
    threadIds: selected.map((thread) => thread.thread_id),
    assignBatches,
    totalUnits,
    calls,
    header: [
      `all passes · snapshot ${snapshot} · run ${run} · induction label ${label} · mode ${mode} · pass-1 mode ${pass1.pass1Mode}`,
      `${selected.length} threads selected · ${threadsToDo} still to do${force ? ' (--force: all re-run)' : ''}`,
    ],
    notes,
    blockers,
    threadsSelected: selected.length,
    threadsToDo,
  };
}

/* ------------------------------------------------------------------- the plans */

export async function preparePass(
  snapshot: string,
  run: string,
  request: PassRequest,
): Promise<Prepared> {
  switch (request.pass) {
    case 'pass1':
      return preparePass1(snapshot, run, request);
    case 'pass2':
      return preparePass2(snapshot, run, request);
    case 'pass3':
      return preparePass3(snapshot, run, request);
    case 'measure':
      return prepareMeasure(snapshot, run, request);
    case 'all':
      return prepareAll(snapshot, run, request);
    default:
      throw new PcError(`unknown pass: ${String((request as { pass: PassKind }).pass)}`);
  }
}

/** A stage with nothing left to send. Shown rather than dropped: see `planFromPrepared`. */
function emptyPlanRow(stage: ProblemClassifierStage): PlanRow {
  return {
    stage,
    model: modelForStage(stage),
    calls: 0,
    charsSum: 0,
    charsP50: 0,
    charsMax: 0,
    estInputTokens: 0,
    estOutputTokens: 0,
    estInputCostUsd: 0,
  };
}

export function planFromPrepared(prepared: Prepared): Plan {
  const table = summarisePlannedCalls(prepared.calls);
  const notes = [...prepared.notes];
  if (!table.costKnown) {
    notes.push('one or more stages have no list price, so the cost estimate is a floor');
  }
  /**
   * A one-shot run is confirmed against the whole pipeline, so every stage of it gets a
   * row — including one whose results are already on disk, which shows as 0 calls. The
   * alternative, dropping the stage, reads as "this pass will not run" rather than
   * "this pass has nothing left to do", and it would price a resumed run as a fresh one.
   */
  let rows = table.rows;
  if (prepared.pass === 'all') {
    const stages =
      prepared.mode === 'one-call'
        ? ALL_PASS_STAGES.filter((stage) => stage !== 'assign')
        : ALL_PASS_STAGES;
    rows = stages.map(
      (stage) => table.rows.find((row) => row.stage === stage) ?? emptyPlanRow(stage),
    );
    if (rows.some((row) => row.calls === 0)) {
      notes.push(
        'a stage with 0 calls has nothing left to send: every selected thread already has that result on disk',
      );
    }
  }
  return {
    pass: prepared.pass,
    request: prepared.request,
    rows,
    estInputCostUsd: table.estInputCostUsd,
    notes,
    blockers: prepared.blockers,
    threadsSelected: prepared.threadsSelected,
    threadsToDo: prepared.threadsToDo,
  };
}

/** Never spends: the whole point of this function is that it is free to call. */
export async function planPass(
  snapshot: string,
  run: string,
  request: PassRequest,
): Promise<Plan> {
  return planFromPrepared(await preparePass(snapshot, run, request));
}

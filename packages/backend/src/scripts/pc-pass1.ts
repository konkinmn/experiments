/**
 * Payment problem classifier — M3, pass 1: which payment was this thread about?
 *
 * At most two calls a thread: `extract` (what the text says about the payment) and, after
 * the deterministic shortlist, `pick` (one shortlist handle or NOT_FOUND). The pass
 * decides nothing about which threads continue — a thread whose shortlist comes back
 * empty gets NOT_FOUND without a `pick` call and still continues to pass 2.
 *
 * `--pass1-mode` chooses how the shortlist is reached:
 *   regex-first (default) — build the extraction with regexes (UUIDs in the message and
 *     task text, money figures the customer or an automated task wrote), shortlist from
 *     it, and go straight to `pick`. `extract` is paid for only when there is nothing to
 *     shortlist or `pick` answers NOT_FOUND; its answer is then merged over the regex one
 *     and `pick` is asked again if that changed the rows. 94 of the pilot's 122 threads
 *     name a transaction UUID outright, so most never reach `extract` at all.
 *   extract-always — the original flow, one `extract` a thread unconditionally. Kept so
 *     the two can be run over the same snapshot and compared.
 * Every result file records the branch it took in `pass1_path`.
 *
 * The final state separates "no payment" from "the model was wrong":
 *   RESOLVED · ORDER_ONLY · UNRESOLVED_HANDLE · NOT_FOUND   (see runner.ts)
 *
 * One JSON per thread under runs/<run>/pass1/, so a re-run resumes and only `--force`
 * re-spends. Threads are processed in the snapshot file's order and never re-sorted.
 * Progress lines carry the state and the path and nothing else: no counts, no shares, no
 * content.
 *
 * A thin wrapper over `preparePass1` + `runPass` in services/problem-classifier/, which
 * the HTTP surface plans and starts as a background job. This file owns the flags and
 * the `--go` gate; the plan table and every progress line come from the pipeline.
 *
 * Usage:
 *   npx tsx packages/backend/src/scripts/pc-pass1.ts \
 *     --snapshot pilot-2026-08-19 --run dev [--n 20 | --threads 316188407,316239492] \
 *     [--pass1-mode regex-first|extract-always] [--force]
 *   ... --go        # spends tokens
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPaths = [resolve(__dirname, '../../.env'), resolve(__dirname, '../../../../.env')];
const envPath = envPaths.find((p) => existsSync(p));
if (envPath) config({ path: envPath });

const runner = await import('../services/problem-classifier/runner.js');
const pipeline = await import('../services/problem-classifier/pipeline.js');

/* Annotated so TypeScript treats a `fail(...)` call as never-returning and narrows
 * the flag checks below; a destructured const would lose that. */
const fail: (message: string) => never = runner.fail;
const { parseArgs, stringFlag, allowFlags } = runner;

const args = parseArgs(process.argv.slice(2));
allowFlags(args, ['snapshot', 'run', 'threads', 'n', 'pass1-mode', 'force', 'go']);

const snapshotName = stringFlag(args, 'snapshot');
if (!snapshotName) fail('--snapshot <name> is required');
const runLabel = stringFlag(args, 'run');
if (!runLabel) fail('--run <label> is required');
const threadFilter = stringFlag(args, 'threads');
/* `--n` takes the first n threads in snapshot file order — a seeded shuffle, so the
 * first n are a random sample. It is an alternative to `--threads`, not a filter on top
 * of it; the range check against the snapshot's size lives in `selectThreads`. */
const nArg = stringFlag(args, 'n');
if (threadFilter !== undefined && nArg !== undefined) {
  fail('--threads and --n are alternatives; pass one');
}
const n = nArg === undefined ? undefined : Number(nArg);
if (n !== undefined && !Number.isInteger(n)) fail('--n must be an integer');
const force = args.force === true;
const go = args.go === true;

type Pass1Mode = import('../services/problem-classifier/pipeline.js').Pass1Mode;
const PASS1_MODES: Pass1Mode[] = ['regex-first', 'extract-always'];
const pass1ModeArg = stringFlag(args, 'pass1-mode');
if (pass1ModeArg !== undefined && !PASS1_MODES.includes(pass1ModeArg as Pass1Mode)) {
  fail(`--pass1-mode must be one of ${PASS1_MODES.join(', ')}`);
}
const pass1Mode = pass1ModeArg as Pass1Mode | undefined;

const request: import('../services/problem-classifier/pipeline.js').PassRequest = {
  pass: 'pass1',
  threads: threadFilter
    ? threadFilter.split(',').map((t) => t.trim()).filter(Boolean)
    : undefined,
  n,
  force,
  pass1Mode,
};

const prepared = await pipeline
  .preparePass1(snapshotName, runLabel, request)
  .catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));

if (prepared.blockers.length > 0) fail(prepared.blockers[0]);

if (prepared.jobs.length === 0) {
  console.log(prepared.header.join('\n'));
  console.log('nothing to do: every selected thread already has a pass-1 result. Use --force to re-run.');
  process.exit(0);
}

if (
  !runner.planAndGate({
    calls: prepared.calls,
    go,
    header: prepared.header,
    notes: prepared.notes,
  })
) {
  process.exit(0);
}

try {
  await pipeline.runPass(
    snapshotName,
    runLabel,
    request,
    { onEvent: () => {}, isCancelled: () => false, onLog: (line) => console.log(line) },
    prepared,
  );
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

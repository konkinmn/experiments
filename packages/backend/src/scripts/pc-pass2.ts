/**
 * Payment problem classifier — M3, pass 2: what happened to this customer?
 *
 * One call a thread over the `read` rendering: the whole conversation, every task and
 * comment, the payment pass 1 identified with its hold chain, the partner-side tasks
 * and a fortnight of ledger context. The model writes prose in three sections and
 * nothing else — no category, no label. `pc-report.ts` runs the label guard over the
 * output; this script does not read what came back.
 *
 * Every thread pass 1 covered gets read, NOT_FOUND ones included: an absent payment is
 * a verdict and the prompt asks the reader to read the absence. `UNRESOLVED_HANDLE`
 * also reads with no identified payment — the model was wrong, so it gets nothing
 * asserted rather than something invented.
 *
 * A thin wrapper over `preparePass2` + `runPass` in services/problem-classifier/, which
 * the HTTP surface plans and starts as a background job.
 *
 * Usage:
 *   npx tsx packages/backend/src/scripts/pc-pass2.ts \
 *     --snapshot pilot-2026-08-19 --run dev [--n 20 | --threads 316188407] [--force]
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
allowFlags(args, ['snapshot', 'run', 'threads', 'n', 'force', 'go']);

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

const request: import('../services/problem-classifier/pipeline.js').PassRequest = {
  pass: 'pass2',
  threads: threadFilter
    ? threadFilter.split(',').map((t) => t.trim()).filter(Boolean)
    : undefined,
  n,
  force,
};

const prepared = await pipeline
  .preparePass2(snapshotName, runLabel, request)
  .catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));

/* Pass 2 refuses to start unless every selected thread has a pass-1 result, and the
 * blocker names the missing ones. */
if (prepared.blockers.length > 0) fail(prepared.blockers[0]);

if (prepared.jobs.length === 0) {
  console.log(prepared.header.join('\n'));
  console.log('nothing to do: every selected thread already has a reading. Use --force to re-run.');
  process.exit(0);
}

if (!runner.planAndGate({ calls: prepared.calls, go, header: prepared.header })) {
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

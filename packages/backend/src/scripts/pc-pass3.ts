/**
 * Payment problem classifier — M3, pass 3: induce the categories from the readings.
 *
 * The categories are induced from what the readings say happened and what would have
 * removed it — they are never declared up front, and the model is not shown the Gemma
 * scenario leaf that selected the thread, its pass-1 state or anything else that could
 * seed a taxonomy. It sees `### thread <id>` and three sections of prose, in the
 * snapshot's order.
 *
 * Two shapes:
 *   --mode two-step (default)  one induce call that returns categories and no members,
 *                              then assign calls of 25 readings each that place every
 *                              thread against that set. Every call is individually
 *                              small, so none of them is the one that times out.
 *   --mode one-call            the original: a single call that induces and assigns in
 *                              one 16k-token answer. Kept because it is the shape the
 *                              earlier inductions were produced with.
 *
 * Refuses to run unless pass 2 is complete for every thread in the snapshot: a
 * taxonomy induced over the threads that happened to finish is a taxonomy of whatever
 * finished first. Refuses to overwrite an existing induction label.
 *
 * A thin wrapper over `preparePass3` + `runPass` in services/problem-classifier/, which
 * the HTTP surface plans and starts as a background job.
 *
 * Usage:
 *   npx tsx packages/backend/src/scripts/pc-pass3.ts \
 *     --snapshot pilot-2026-08-19 --run dev [--label a] [--mode two-step|one-call]
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
allowFlags(args, ['snapshot', 'run', 'label', 'mode', 'go']);

const snapshotName = stringFlag(args, 'snapshot');
if (!snapshotName) fail('--snapshot <name> is required');
const runLabel = stringFlag(args, 'run');
if (!runLabel) fail('--run <label> is required');
const inductionLabel = stringFlag(args, 'label') ?? 'a';
if (!runner.NAME_RE.test(inductionLabel)) fail('--label may only contain [A-Za-z0-9._-]');
const mode = stringFlag(args, 'mode') ?? 'two-step';
if (mode !== 'two-step' && mode !== 'one-call') fail('--mode must be two-step or one-call');
const go = args.go === true;

const request: import('../services/problem-classifier/pipeline.js').PassRequest = {
  pass: 'pass3',
  label: inductionLabel,
  mode,
};

const prepared = await pipeline
  .preparePass3(snapshotName, runLabel, request)
  .catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));

/* The label check comes first, then pass-2 completeness — the same order as before,
 * so the message an operator sees for a double failure is unchanged. */
if (prepared.blockers.length > 0) fail(prepared.blockers[0]);

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

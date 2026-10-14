/**
 * Payment problem classifier — M3: do two inductions agree?
 *
 * Two `pc-pass3.ts` runs over the same readings produce two category sets with
 * different names, so they are matched by their members: for each category in A, the
 * category in B whose member set shares the most with it (Jaccard). What is left over
 * on either side is a category one induction found and the other did not, which is the
 * interesting part. Assignment agreement is then the share of threads whose category
 * in A is matched to their category in B.
 *
 * Makes no LLM calls, so it has no --go. A thin wrapper over `comparePass3Full` and
 * `renderComparePass3Lines`; the HTTP `compare-pass3` route serves the same comparison
 * as JSON.
 *
 * Usage:
 *   npx tsx packages/backend/src/scripts/pc-compare-pass3.ts \
 *     --snapshot pilot-2026-08-19 --run dev --label-a a --label-b b
 */
const runner = await import('../services/problem-classifier/runner.js');
const pipeline = await import('../services/problem-classifier/pipeline-read.js');

/* Annotated so TypeScript treats a `fail(...)` call as never-returning and narrows
 * the flag checks below; a destructured const would lose that. */
const fail: (message: string) => never = runner.fail;
const { parseArgs, stringFlag, allowFlags } = runner;

const args = parseArgs(process.argv.slice(2));
allowFlags(args, ['snapshot', 'run', 'label-a', 'label-b']);

const snapshotName = stringFlag(args, 'snapshot');
if (!snapshotName) fail('--snapshot <name> is required');
const runLabel = stringFlag(args, 'run');
if (!runLabel) fail('--run <label> is required');
const labelA = stringFlag(args, 'label-a');
if (!labelA) fail('--label-a <label> is required');
const labelB = stringFlag(args, 'label-b');
if (!labelB) fail('--label-b <label> is required');
if (labelA === labelB) fail('--label-a and --label-b must differ');

try {
  const full = pipeline.comparePass3Full(snapshotName, runLabel, labelA, labelB);
  console.log(pipeline.renderComparePass3Lines(full).join('\n'));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

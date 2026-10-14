/**
 * Payment problem classifier — M3: the only script that prints a count.
 *
 * No pass prints an aggregate of its own: a category share glimpsed halfway through a
 * sweep is a number that gets quoted, and half a sweep is not a population. So the
 * counts live here, and this script refuses to print any for a pass that is not
 * complete over every thread in the snapshot.
 *
 * Prints: the four pass-1 states with distinct payment ids beside thread counts (the
 * same payment can be the subject of several threads); the pass-2 reading count and
 * every label-guard flag with its thread id; the induced category table if there is
 * one; and the run's real token, cost and latency totals from llm-calls.ndjson.
 *
 * Makes no LLM calls, so it has no --go. A thin wrapper over `buildReportFull` and
 * `renderReportLines`, which is also what the HTTP `report` route gates on.
 *
 * Usage:
 *   npx tsx packages/backend/src/scripts/pc-report.ts \
 *     --snapshot pilot-2026-08-19 --run dev [--label a]
 */
const runner = await import('../services/problem-classifier/runner.js');
const pipeline = await import('../services/problem-classifier/pipeline-read.js');

/* Annotated so TypeScript treats a `fail(...)` call as never-returning and narrows
 * the flag checks below; a destructured const would lose that. */
const fail: (message: string) => never = runner.fail;
const { parseArgs, stringFlag, allowFlags } = runner;

const args = parseArgs(process.argv.slice(2));
allowFlags(args, ['snapshot', 'run', 'label']);

const snapshotName = stringFlag(args, 'snapshot');
if (!snapshotName) fail('--snapshot <name> is required');
const runLabel = stringFlag(args, 'run');
if (!runLabel) fail('--run <label> is required');
const inductionLabel = stringFlag(args, 'label') ?? 'a';

try {
  const full = pipeline.buildReportFull(snapshotName, runLabel, inductionLabel);
  console.log(pipeline.renderReportLines(full).join('\n'));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

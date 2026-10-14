/**
 * Payment problem classifier — M3: is pass 1 stable?
 *
 * Two run labels over the same threads, compared per thread: same final state, same
 * identified payment. The transition table shows where the disagreement sits — an
 * `UNRESOLVED_HANDLE` that becomes `RESOLVED` is a different problem from a `RESOLVED`
 * that becomes a `NOT_FOUND`.
 *
 * Makes no LLM calls, so it has no --go.
 *
 * Usage:
 *   npx tsx packages/backend/src/scripts/pc-compare-pass1.ts \
 *     --snapshot pilot-2026-08-19 --run-a stab1 --run-b stab2
 */
import { existsSync } from 'fs';
import { resolve } from 'path';

const runner = await import('../services/problem-classifier/runner.js');
type Pass1Result = import('../services/problem-classifier/runner.js').Pass1Result;

/* Annotated so TypeScript treats a `fail(...)` call as never-returning and narrows
 * the flag checks below; a destructured const would lose that. */
const fail: (message: string) => never = runner.fail;
const { parseArgs, stringFlag, allowFlags } = runner;

const args = parseArgs(process.argv.slice(2));
allowFlags(args, ['snapshot', 'run-a', 'run-b']);

const snapshotName = stringFlag(args, 'snapshot');
if (!snapshotName) fail('--snapshot <name> is required');
const runA = stringFlag(args, 'run-a');
if (!runA) fail('--run-a <label> is required');
const runB = stringFlag(args, 'run-b');
if (!runB) fail('--run-b <label> is required');
if (runA === runB) fail('--run-a and --run-b must differ');

/* The path helpers throw rather than exit, so the script turns the throw back into
 * the one-line `error: ...` it has always printed. */
function resolvePaths(snapshot: string, labelA: string, labelB: string) {
  try {
    return {
      pathsA: runner.RunPaths(snapshot, labelA),
      pathsB: runner.RunPaths(snapshot, labelB),
      snapshotThreads: runner.loadSnapshotThreads(snapshot),
    };
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
const { pathsA, pathsB, snapshotThreads } = resolvePaths(snapshotName, runA, runB);

interface Pair {
  thread_id: string;
  a: Pass1Result;
  b: Pass1Result;
}

const pairs: Pair[] = [];
let onlyA = 0;
let onlyB = 0;
for (const thread of snapshotThreads) {
  const pathA = resolve(pathsA.pass1Dir, `${thread.thread_id}.json`);
  const pathB = resolve(pathsB.pass1Dir, `${thread.thread_id}.json`);
  const hasA = existsSync(pathA);
  const hasB = existsSync(pathB);
  if (hasA && hasB) {
    pairs.push({
      thread_id: thread.thread_id,
      a: runner.readJsonFile<Pass1Result>(pathA),
      b: runner.readJsonFile<Pass1Result>(pathB),
    });
  } else if (hasA) onlyA += 1;
  else if (hasB) onlyB += 1;
}

console.log(
  `COMPARE pass 1 · snapshot ${snapshotName} · ${runA} vs ${runB} · ${pairs.length} threads in both (${onlyA} only in ${runA}, ${onlyB} only in ${runB})`,
);
if (pairs.length === 0) process.exit(0);

const sameState = pairs.filter((pair) => pair.a.state === pair.b.state);
const sameId = pairs.filter(
  (pair) => (pair.a.identified?.id ?? null) === (pair.b.identified?.id ?? null),
);

function share(n: number): string {
  return `${((n / pairs.length) * 100).toFixed(1)}%`;
}

console.log('');
console.log(`state agreement:         ${sameState.length}/${pairs.length}  ${share(sameState.length)}`);
console.log(`identified-id agreement: ${sameId.length}/${pairs.length}  ${share(sameId.length)}`);

console.log('');
console.log('state transitions (rows = run A, columns = run B)');
const header = ['', ...runner.PASS1_STATES];
console.log(header.map((cell, i) => (i === 0 ? cell.padEnd(20) : cell.padStart(19))).join(''));
for (const from of runner.PASS1_STATES) {
  const cells = runner.PASS1_STATES.map(
    (to) => pairs.filter((pair) => pair.a.state === from && pair.b.state === to).length,
  );
  console.log([from.padEnd(20), ...cells.map((n) => String(n).padStart(19))].join(''));
}

const differing = pairs.filter(
  (pair) =>
    pair.a.state !== pair.b.state ||
    (pair.a.identified?.id ?? null) !== (pair.b.identified?.id ?? null),
);
if (differing.length > 0) {
  console.log('');
  console.log('threads that differ:');
  for (const pair of differing) {
    const idA = pair.a.identified?.id ?? 'none';
    const idB = pair.b.identified?.id ?? 'none';
    console.log(
      `  ${pair.thread_id}  ${pair.a.state} → ${pair.b.state}${idA === idB ? '' : `  id ${idA} → ${idB}`}`,
    );
  }
}

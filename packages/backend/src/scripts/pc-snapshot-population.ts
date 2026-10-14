/**
 * Payment problem classifier — M1: snapshot the population.
 *
 * Runs the fixed selector once and writes the selected thread list to
 * packages/backend/data/problem-classifier/<name>/population.json.
 * That file is the population for every later pass: the source tables
 * (gemma.thread_scenarios, gemma.threads) are rewritten daily and revise rows,
 * so nothing downstream may ever re-query the selector.
 *
 * A thin wrapper over `createSnapshot` in services/problem-classifier/pipeline-run.ts,
 * which the HTTP surface calls too. This file owns the flags and the printing and
 * nothing else.
 *
 * Usage:
 *   npx tsx packages/backend/src/scripts/pc-snapshot-population.ts \
 *     --from 2026-08-01 --to 2026-08-31 [--name month-2026-08] \
 *     [--leaves declines] [--filter touched] [--as-of 2026-09-04T07:30:00Z] [--seed 12345] [--force]
 *
 * `--leaves` takes a set name (`money-not-arrived`, the default, or `declines`) or a
 * comma-separated list of full path keys for a one-off cut.
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPaths = [
  resolve(__dirname, '../../.env'),
  resolve(__dirname, '../../../../.env'),
];
const envPath = envPaths.find((p) => existsSync(p));
if (envPath) config({ path: envPath });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})?$/;
const NAME_RE = /^[A-Za-z0-9._-]+$/;

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) fail(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function stringFlag(
  args: Record<string, string | true>,
  name: string,
): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (value === true) fail(`--${name} requires a value`);
  return value;
}

const args = parseArgs(process.argv.slice(2));

const dateFrom = stringFlag(args, 'from');
const dateTo = stringFlag(args, 'to');
if (!dateFrom) fail('--from YYYY-MM-DD is required');
if (!dateTo) fail('--to YYYY-MM-DD is required');
if (!DATE_RE.test(dateFrom)) fail(`--from must be YYYY-MM-DD, got "${dateFrom}"`);
if (!DATE_RE.test(dateTo)) fail(`--to must be YYYY-MM-DD, got "${dateTo}"`);
if (dateFrom > dateTo) fail(`--from (${dateFrom}) is after --to (${dateTo})`);

const asOf = stringFlag(args, 'as-of');
if (asOf !== undefined && !ISO_TS_RE.test(asOf)) {
  fail(`--as-of must be an ISO-8601 timestamp, got "${asOf}"`);
}

const name = stringFlag(args, 'name') ?? `${dateFrom}_${dateTo}`;
if (!NAME_RE.test(name)) fail(`--name may only contain [A-Za-z0-9._-], got "${name}"`);

const seedFlag = stringFlag(args, 'seed');
let seed: number | undefined;
if (seedFlag !== undefined) {
  if (!/^\d+$/.test(seedFlag)) fail(`--seed must be a non-negative integer, got "${seedFlag}"`);
  seed = Number(seedFlag);
  if (!Number.isInteger(seed) || seed > 0xffffffff) {
    fail(`--seed must fit in 32 bits, got "${seedFlag}"`);
  }
}

/* A set name, or a comma-separated list of full path keys. Resolved and validated in
 * `resolveLeafSet`; the resolved list lands in the manifest either way. */
const leaves = stringFlag(args, 'leaves');

const filterFlag = stringFlag(args, 'filter') ?? 'all';
if (filterFlag !== 'all' && filterFlag !== 'escalated' && filterFlag !== 'touched') {
  fail(`--filter must be all, escalated or touched, got "${filterFlag}"`);
}
const filter = filterFlag as 'all' | 'escalated' | 'touched';

const force = args.force === true || args.force === 'true';

const outPath = resolve(__dirname, '../../data/problem-classifier', name, 'population.json');

/* Dynamic import so dotenv has run before the config module reads env. */
const { createSnapshot } = await import('../services/problem-classifier/pipeline-run.js');

const summary = await createSnapshot({
  dateFrom,
  dateTo,
  name,
  leaves,
  filter,
  seed,
  asOf,
  force,
}).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));

const byCategory = summary.counts.byCategory;
const shortLabel = (pathKey: string) => pathKey.split(' > ').slice(-2).join(' > ');
const labelWidth = Math.max(
  ...byCategory.map((c) => shortLabel(c.pathKey).length),
  'TOTAL'.length,
);
const col = (value: number, width: number) => String(value).padStart(width);

console.log(`snapshot: ${outPath}`);
console.log(`leaves:   ${leaves ?? 'money-not-arrived (default)'}`);
console.log(
  `filter:   ${filter === 'all' ? 'every thread in the leaves' : filter === 'escalated' ? 'threads Gemma handed over' : 'threads a person acted in'}`,
);
console.log(`seed:     ${summary.seed}`);
console.log(`as-of:    ${summary.asOf ?? '(none — live tables)'}`);
console.log('');
console.log(
  `${'category'.padEnd(labelWidth)}  ${'threads'.padStart(8)}  ${'dialogues'.padStart(10)}  ${'customers'.padStart(10)}`,
);
for (const c of byCategory) {
  console.log(
    `${shortLabel(c.pathKey).padEnd(labelWidth)}  ${col(c.threads, 8)}  ${col(c.dialogues, 10)}  ${col(c.customers, 10)}`,
  );
}
console.log(
  `${'TOTAL'.padEnd(labelWidth)}  ${col(summary.counts.totalThreads, 8)}  ${col(summary.counts.totalDialogues, 10)}  ${col(summary.counts.totalCustomers, 10)}`,
);

/**
 * Payment problem classifier — M2b: how big are the three prompts, in real tokens?
 *
 * `chars / 4` is a guess. This script renders `extract`, `pick` and `read` from the
 * stored bundles and asks the proxy to count them for real, by sending each rendering
 * with `max_tokens: 1` and keeping only `usage`. One token comes back; the input
 * tokens are the answer. That tells us three things `chars / 4` cannot:
 *   - how many threads blow the 200k Haiku window on `extract` or `pick`;
 *   - the real chars-per-token ratio for this kind of text (ledger lines and refs
 *     tokenise far worse than prose);
 *   - how close a single call sits to the stage proxy's ~60s cut-off.
 *
 * The plan is always printed first and `--dry-run` (the default) stops there. Nothing
 * reaches the proxy without `--go`.
 *
 * A thin wrapper over `prepareMeasure` + `runPass` in services/problem-classifier/.
 * There is no `--run`: a measurement writes to `<snapshot>/measure/` and logs no
 * calls, so it is passed the empty run label the pipeline allows for exactly this.
 *
 * Usage:
 *   npx tsx packages/backend/src/scripts/pc-measure-tokens.ts \
 *     --snapshot pilot-2026-08-19 [--n 20] [--dry-run]
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

function stringFlag(args: Record<string, string | true>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (value === true) fail(`--${name} requires a value`);
  return value;
}

const args = parseArgs(process.argv.slice(2));
for (const key of Object.keys(args)) {
  if (!['snapshot', 'n', 'dry-run', 'go'].includes(key)) fail(`unknown flag: --${key}`);
}

const snapshotName = stringFlag(args, 'snapshot');
if (!snapshotName) fail('--snapshot <name> is required');
if (!NAME_RE.test(snapshotName)) fail('--snapshot may only contain [A-Za-z0-9._-]');

/* `--n` is left undefined when the flag is absent so the default lives in one place,
 * `MEASURE.defaultN` in pipeline-plan.ts, which also clamps it to a short population.
 * An explicit `--n` above the population is refused there, not clamped. */
const nArg = stringFlag(args, 'n');
const n = nArg === undefined ? undefined : Number(nArg);
if (n !== undefined && !Number.isInteger(n)) fail('--n must be an integer');

const go = args.go === true;
const dryRunFlag = args['dry-run'] === true;
if (go && dryRunFlag) fail('--dry-run and --go are contradictory; pass one');
const dryRun = !go;

const pipeline = await import('../services/problem-classifier/pipeline.js');

const request: import('../services/problem-classifier/pipeline.js').PassRequest = {
  pass: 'measure',
  n,
};

const prepared = await pipeline
  .prepareMeasure(snapshotName, '', request)
  .catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));

if (prepared.shortPopulationNote) console.log(prepared.shortPopulationNote);
if (prepared.blockers.length > 0) fail(prepared.blockers[0]);

console.log(prepared.planLines.join('\n'));

if (dryRun) {
  console.log('');
  console.log('--dry-run: nothing sent to the proxy. Re-run with --go to measure.');
  process.exit(0);
}

try {
  await pipeline.runPass(
    snapshotName,
    '',
    request,
    { onEvent: () => {}, isCancelled: () => false, onLog: (line) => console.log(line) },
    prepared,
  );
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

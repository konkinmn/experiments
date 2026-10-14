/**
 * Payment problem classifier — M2: build a bundle per thread.
 *
 * Reads the population snapshot written by pc-snapshot-population.ts, runs one
 * pull per source table over the whole snapshot, assembles a per-thread bundle in
 * Node, and writes:
 *   bundles/<thread_id>.json         the bundle
 *   bundles/<thread_id>.extract.txt  the pass-1a ("extract") rendering
 *   bundles/_build.json              windows, bytes per source, per-thread stats
 *
 * The `pick` and `read` renderings are not written here: `pick` needs a pass-1a
 * extraction and `read` an identified transaction. Both come from `pc-render.ts`.
 *
 * No LLM calls. Threads are processed in the snapshot file's order (a seeded
 * shuffle) and never re-sorted.
 *
 * A thin wrapper over `buildBundles` in services/problem-classifier/pipeline-run.ts,
 * which the HTTP surface runs as a background job. This file owns the flags; every
 * line below the flags is printed by the pipeline through `onLog`.
 *
 * Usage:
 *   npx tsx packages/backend/src/scripts/pc-build-bundles.ts \
 *     --snapshot pilot-2026-08-19 [--threads 316188407,316239492] [--force]
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
const snapshotName = stringFlag(args, 'snapshot');
if (!snapshotName) fail('--snapshot <name> is required');
if (!NAME_RE.test(snapshotName)) fail(`--snapshot may only contain [A-Za-z0-9._-]`);
const threadFilter = stringFlag(args, 'threads');
const force = args.force === true || args.force === 'true';

/* Dynamic import so dotenv has run before the config module reads env. */
const { buildBundles } = await import('../services/problem-classifier/pipeline-run.js');

try {
  await buildBundles(
    snapshotName,
    {
      onEvent: () => {},
      isCancelled: () => false,
      onLog: (line) => console.log(line),
    },
    {
      threads: threadFilter
        ? threadFilter.split(',').map((t) => t.trim()).filter(Boolean)
        : undefined,
      force,
    },
  );
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

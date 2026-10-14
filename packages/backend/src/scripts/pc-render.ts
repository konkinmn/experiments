/**
 * Payment problem classifier — M2: render one stored bundle to stdout.
 *
 * Reads a bundle written by pc-build-bundles.ts and prints the `extract`, `pick` or
 * `read` text for it. No BigQuery, no LLM: everything comes from the bundle JSON,
 * plus (for `pick`) a pass-1a extraction on disk. This is the surface M3 drives and
 * the one to eyeball a single thread with.
 *
 * Usage:
 *   npx tsx packages/backend/src/scripts/pc-render.ts \
 *     --snapshot pilot-2026-08-19 --thread 316251792 --stage extract
 *   ... --stage pick --extraction /tmp/316251792.extraction.json
 *   ... --stage read --identified f5192f17-812a-4d9c-8e0c-993215ca5fea
 *   ... --stage read --identified NOT_FOUND
 */
import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const NAME_RE = /^[A-Za-z0-9._-]+$/;
const STAGES = ['extract', 'pick', 'read'] as const;
type Stage = (typeof STAGES)[number];

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
const threadId = stringFlag(args, 'thread');
const stageArg = stringFlag(args, 'stage');
const extractionPath = stringFlag(args, 'extraction');
const identifiedArg = stringFlag(args, 'identified');

if (!snapshotName) fail('--snapshot <name> is required');
if (!NAME_RE.test(snapshotName)) fail('--snapshot may only contain [A-Za-z0-9._-]');
if (!threadId) fail('--thread <id> is required');
if (!NAME_RE.test(threadId)) fail('--thread may only contain [A-Za-z0-9._-]');
if (!stageArg) fail(`--stage <${STAGES.join('|')}> is required`);
if (!(STAGES as readonly string[]).includes(stageArg)) {
  fail(`--stage must be one of ${STAGES.join(', ')}`);
}
const stage = stageArg as Stage;
if (stage === 'pick' && !extractionPath) fail('--stage pick requires --extraction <path>');
if (stage !== 'pick' && extractionPath) fail('--extraction is only used by --stage pick');
if (stage !== 'read' && identifiedArg) fail('--identified is only used by --stage read');

const bundlePath = resolve(
  __dirname,
  '../../data/problem-classifier',
  snapshotName,
  'bundles',
  `${threadId}.json`,
);
if (!existsSync(bundlePath)) fail(`no bundle at ${bundlePath}`);

const { renderBundleText } = await import('../services/problem-classifier/bundle.js');
const { shortlistCandidates } = await import('../services/problem-classifier/shortlist.js');
const { PaymentExtractionSchema } = await import('../services/problem-classifier/extraction.js');
type ThreadBundle = import('../services/problem-classifier/bundle.js').ThreadBundle;

const bundle = JSON.parse(readFileSync(bundlePath, 'utf8')) as ThreadBundle;

if (stage === 'extract') {
  process.stdout.write(renderBundleText(bundle, { stage: 'extract' }));
} else if (stage === 'pick') {
  const path = extractionPath as string;
  if (!existsSync(path)) fail(`no extraction file at ${path}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`--extraction is not valid JSON: ${(error as Error).message}`);
  }
  const parsed = PaymentExtractionSchema.safeParse(raw);
  if (!parsed.success) fail(`--extraction does not match PaymentExtraction: ${parsed.error.message}`);
  const shortlist = shortlistCandidates(bundle, parsed.data);
  process.stdout.write(renderBundleText(bundle, { stage: 'pick', shortlist }));
} else {
  /* An absent --identified reads as NOT_FOUND: pass 1b may fail to name a payment
   * and pass 2 still has to read the thread. */
  const identifiedId =
    identifiedArg == null || identifiedArg === 'NOT_FOUND' ? null : identifiedArg;
  process.stdout.write(renderBundleText(bundle, { stage: 'read', identifiedId }));
}

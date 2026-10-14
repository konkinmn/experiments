/**
 * Payment problem classifier — the pipeline's public surface.
 *
 * Split by what a function is allowed to do, because that is the distinction that
 * matters here: `pipeline-read.ts` only reads what is on disk, `pipeline-plan.ts` works
 * out what a pass would send without sending it, and `pipeline-run.ts` is the only file
 * that queries BigQuery or spends a token. Import this barrel unless you specifically
 * want to depend on just one of the three.
 */
export * from './pipeline-types.js';
export * from './pipeline-read.js';
export * from './pipeline-plan.js';
export * from './pipeline-run.js';

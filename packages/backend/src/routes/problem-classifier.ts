/**
 * Payment problem classifier — the HTTP surface over the pipeline.
 *
 * Everything the `pc-*.ts` scripts do is callable from here: snapshot the population,
 * build the bundles, plan a pass, start it as a background job, watch it, cancel it,
 * read the per-thread results and the report.
 *
 * Three properties this file is responsible for:
 *  - **`start` is the only route that spends.** `plan` recomputes from the same body
 *    and never sends anything, and `start` recomputes the plan again from the body it
 *    is given and refuses when it carries blockers — so the plan the client showed as
 *    its confirmation step is the plan that runs.
 *  - **no intermediate aggregate leaves the tool.** A job exposes `done/total`, the
 *    current thread and the per-thread event stream. States, category counts, distinct
 *    payments and shares appear only in `report`, and only for a pass that is complete
 *    over the whole snapshot. Token and cost totals are spend, not content, so they are
 *    allowed anywhere.
 *  - **order is snapshot file order** in every list of threads, always.
 *
 * Path parameters are checked against `[A-Za-z0-9._-]+` and every resolved path is
 * asserted to stay under `data/problem-classifier/` (see `safeDataPath`).
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import {
  buildBundles,
  buildReport,
  checkBundlesWritable,
  comparePass3,
  createRun,
  createSnapshot,
  listRuns,
  listSnapshots,
  pcDefaults,
  planFromPrepared,
  preparePass,
  readRunThreads,
  readThreadDetail,
  runPass,
  snapshotExists,
  snapshotThreadList,
  summariseSnapshot,
  type Prepared,
} from '../services/problem-classifier/pipeline.js';
import { PcError } from '../services/problem-classifier/pipeline-types.js';
import {
  createJob,
  finishJob,
  getJob,
  hooksForJob,
  listJobs,
  requestCancel,
  runningJobFor,
} from '../services/problem-classifier/jobs.js';

const NAME = /^[A-Za-z0-9._-]+$/;
const Name = z.string().regex(NAME);
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const CreateSnapshotBody = z.object({
  dateFrom: DateOnly,
  dateTo: DateOnly,
  name: Name,
  /** A leaf-set name, or full path keys. Omitted means `money-not-arrived`. */
  leaves: z.union([z.string().min(1), z.array(z.string().min(1)).nonempty()]).optional(),
  /** Which threads to keep: every one, the handed-over ones, or the human-touched ones. */
  filter: z.enum(['all', 'escalated', 'touched']).optional(),
  seed: z.number().int().min(0).max(0xffffffff).optional(),
  asOf: z.string().min(1).optional(),
});

const PassRequestBody = z.object({
  pass: z.enum(['measure', 'pass1', 'pass2', 'pass3', 'all']),
  threads: z.array(Name).optional(),
  n: z.number().int().positive().optional(),
  force: z.boolean().optional(),
  mode: z.enum(['two-step', 'one-call']).optional(),
  label: Name.optional(),
  /** Pass 1 only; `all` hands it through. Absent means `regex-first`. */
  pass1Mode: z.enum(['regex-first', 'extract-always']).optional(),
});

const CreateRunBody = z.object({ run: Name });

const BundlesBody = z
  .object({ force: z.boolean().optional(), threads: z.array(Name).optional() })
  .optional();

const LabelQuery = z.object({ label: Name.optional() });

const ComparePass3Query = z.object({ a: Name, b: Name });

/** `{ data }` on success, `{ error }` with the pipeline's own status on failure. */
async function send<T>(reply: FastifyReply, work: () => Promise<T> | T): Promise<unknown> {
  try {
    return { data: await work() };
  } catch (error) {
    if (error instanceof PcError) {
      return reply.status(error.status).send({ error: error.message });
    }
    if (error instanceof z.ZodError) {
      return reply.status(400).send({ error: error.errors.map((e) => e.message).join('; ') });
    }
    const message = error instanceof Error ? error.message : String(error);
    return reply.status(500).send({ error: message });
  }
}

function requireSnapshot(name: string): string {
  if (!NAME.test(name)) throw new PcError('snapshot name may only contain [A-Za-z0-9._-]');
  if (!snapshotExists(name)) throw new PcError(`no snapshot ${name}`, 404);
  return name;
}

function requireName(kind: string, value: string): string {
  if (!NAME.test(value)) throw new PcError(`${kind} may only contain [A-Za-z0-9._-]`);
  return value;
}

/** How many units of work a job reports against, per kind of pass. */
function totalFor(prepared: Prepared): number {
  switch (prepared.pass) {
    case 'pass3':
      return prepared.mode === 'one-call' ? 1 : 1 + prepared.batches.length;
    case 'all':
      /* One unit per thread per pass, plus pass 3's induce and assign calls. */
      return prepared.totalUnits;
    case 'measure':
      return prepared.jobs.length;
    default:
      return prepared.jobs.length;
  }
}

export async function problemClassifierRoutes(app: FastifyInstance) {
  /* ------------------------------------------------------------------ snapshots */

  app.get('/snapshots', async (_request, reply) => send(reply, () => listSnapshots()));

  /**
   * What to open with no parameters: the snapshot that has been read the most, its best
   * run, and that run's first induction label. A result-first client asks for this
   * first, so its landing view is a report rather than an empty picker.
   */
  app.get('/defaults', async (_request, reply) => send(reply, () => pcDefaults()));

  app.post('/snapshots', async (request, reply) =>
    send(reply, async () => {
      const body = CreateSnapshotBody.parse(request.body);
      if (snapshotExists(body.name)) {
        throw new PcError(`snapshot ${body.name} already exists`, 409);
      }
      /* Synchronous on purpose: the selector is one BigQuery query and takes seconds,
       * and the snapshot is what everything downstream reads, so the client should not
       * get a job id it has to poll before it can do anything. */
      return createSnapshot(body);
    }),
  );

  app.get<{ Params: { name: string } }>('/snapshots/:name', async (request, reply) =>
    send(reply, () => summariseSnapshot(requireSnapshot(request.params.name))),
  );

  app.get<{ Params: { name: string } }>('/snapshots/:name/threads', async (request, reply) =>
    send(reply, () => snapshotThreadList(requireSnapshot(request.params.name))),
  );

  /* -------------------------------------------------------------------- bundles */

  app.post<{ Params: { name: string } }>('/snapshots/:name/bundles', async (request, reply) =>
    send(reply, () => {
      const snapshot = requireSnapshot(request.params.name);
      const body = BundlesBody.parse(request.body ?? undefined) ?? {};
      const running = runningJobFor(snapshot);
      if (running) {
        throw new PcError(`job ${running.id} is already running on snapshot ${snapshot}`, 409);
      }
      /* The same check `buildBundles` makes, run before the job exists so the refusal
       * is a 409 the client sees rather than a job that fails a second later. */
      const { threads } = checkBundlesWritable(snapshot, body);
      const job = createJob({
        kind: 'bundles',
        snapshot,
        run: null,
        plan: null,
        total: threads.length,
      });
      const hooks = hooksForJob(job.id);
      void buildBundles(snapshot, hooks, body)
        .then((outcome) => finishJob(job.id, outcome.status))
        .catch((error: unknown) =>
          finishJob(job.id, 'failed', error instanceof Error ? error.message : String(error)),
        );
      return { jobId: job.id };
    }),
  );

  /* ----------------------------------------------------------------------- runs */

  app.get<{ Params: { name: string } }>('/snapshots/:name/runs', async (request, reply) =>
    send(reply, () => listRuns(requireSnapshot(request.params.name))),
  );

  app.post<{ Params: { name: string } }>('/snapshots/:name/runs', async (request, reply) =>
    send(reply, () => {
      const snapshot = requireSnapshot(request.params.name);
      const body = CreateRunBody.parse(request.body);
      return createRun(snapshot, body.run);
    }),
  );

  /* ------------------------------------------------------------- plan and start */

  app.post<{ Params: { name: string; run: string } }>(
    '/snapshots/:name/runs/:run/plan',
    async (request, reply) =>
      send(reply, async () => {
        const snapshot = requireSnapshot(request.params.name);
        const run = requireName('run label', request.params.run);
        const body = PassRequestBody.parse(request.body);
        const plan = planFromPrepared(await preparePass(snapshot, run, body));
        /* The registry lives here, not in the pipeline, so the one-shot plan's second
         * blocker is added here: a job already on this snapshot means `start` would be
         * refused, and the plan is what the client shows before it asks. */
        if (body.pass === 'all') {
          const running = runningJobFor(snapshot);
          if (running) {
            plan.blockers.push(`job ${running.id} is already running on snapshot ${snapshot}`);
          }
        }
        return plan;
      }),
  );

  app.post<{ Params: { name: string; run: string } }>(
    '/snapshots/:name/runs/:run/start',
    async (request, reply) =>
      send(reply, async () => {
        const snapshot = requireSnapshot(request.params.name);
        const run = requireName('run label', request.params.run);
        const body = PassRequestBody.parse(request.body);

        const running = runningJobFor(snapshot);
        if (running) {
          throw new PcError(`job ${running.id} is already running on snapshot ${snapshot}`, 409);
        }
        /* The plan is recomputed from the body that was sent, so what is confirmed and
         * what is spent cannot come apart. Blockers are a refusal, never a warning. */
        const prepared = await preparePass(snapshot, run, body);
        const plan = planFromPrepared(prepared);
        if (plan.blockers.length > 0) throw new PcError(plan.blockers[0], 409);

        const job = createJob({
          kind: body.pass,
          snapshot,
          run,
          plan,
          total: totalFor(prepared),
        });
        const hooks = hooksForJob(job.id);
        void runPass(snapshot, run, body, hooks, prepared)
          .then((outcome) => finishJob(job.id, outcome.status))
          .catch((error: unknown) =>
            finishJob(job.id, 'failed', error instanceof Error ? error.message : String(error)),
          );
        return { jobId: job.id, plan };
      }),
  );

  /* ----------------------------------------------------------------------- jobs */

  app.get('/jobs', async (_request, reply) => send(reply, () => listJobs()));

  app.get<{ Params: { id: string } }>('/jobs/:id', async (request, reply) =>
    send(reply, () => {
      const job = getJob(request.params.id);
      if (!job) throw new PcError(`no job ${request.params.id}`, 404);
      return job;
    }),
  );

  app.post<{ Params: { id: string } }>('/jobs/:id/cancel', async (request, reply) =>
    send(reply, () => {
      const job = requestCancel(request.params.id);
      if (!job) throw new PcError(`no job ${request.params.id}`, 404);
      return job;
    }),
  );

  /* --------------------------------------------------------------- run readings */

  app.get<{ Params: { name: string; run: string }; Querystring: { label?: string } }>(
    '/snapshots/:name/runs/:run/threads',
    async (request, reply) =>
      send(reply, () => {
        const snapshot = requireSnapshot(request.params.name);
        const run = requireName('run label', request.params.run);
        const query = LabelQuery.parse(request.query);
        return readRunThreads(snapshot, run, query.label);
      }),
  );

  app.get<{
    Params: { name: string; run: string; threadId: string };
    Querystring: { label?: string };
  }>('/snapshots/:name/runs/:run/threads/:threadId', async (request, reply) =>
    send(reply, () => {
      const snapshot = requireSnapshot(request.params.name);
      const run = requireName('run label', request.params.run);
      const threadId = requireName('thread id', request.params.threadId);
      const query = LabelQuery.parse(request.query);
      return readThreadDetail(snapshot, run, threadId, query.label);
    }),
  );

  app.get<{ Params: { name: string; run: string }; Querystring: { label?: string } }>(
    '/snapshots/:name/runs/:run/report',
    async (request, reply) =>
      send(reply, () => {
        const snapshot = requireSnapshot(request.params.name);
        const run = requireName('run label', request.params.run);
        const query = LabelQuery.parse(request.query);
        return buildReport(snapshot, run, query.label);
      }),
  );

  app.get<{ Params: { name: string; run: string }; Querystring: { a?: string; b?: string } }>(
    '/snapshots/:name/runs/:run/compare-pass3',
    async (request, reply) =>
      send(reply, () => {
        const snapshot = requireSnapshot(request.params.name);
        const run = requireName('run label', request.params.run);
        const query = ComparePass3Query.parse(request.query);
        return comparePass3(snapshot, run, query.a, query.b);
      }),
  );
}

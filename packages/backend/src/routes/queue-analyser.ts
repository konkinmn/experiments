import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';

// TEMP diagnostic: write each run stage to a file so we can see where a run stalls.
function stageLog(runId: number, msg: string) {
  try {
    appendFileSync('/tmp/queue-stage.log', `[${new Date().toISOString()}] run#${runId} ${msg}\n`);
  } catch {
    /* best effort */
  }
}
import {
  fetchQueueEnriched,
  assembleCaseContext,
  buildTaskWsLink,
  buildCaseWsLink,
  type EnrichedTaskRow,
} from '../services/queue-analyser-query.js';
import { fetchLiveCaseContent } from '../services/queue-live-content.js';
import { fetchOpenAgentTasks, fetchOpenCaseActions, type WsAgentTask } from '../services/case-api.js';
import { analyseQueue, analyseDisputeQueue, type TaskAssignment } from '../services/queue-classifier.js';
import {
  insertQueueRun,
  completeQueueRun,
  failQueueRun,
  bulkInsertQueueTasks,
  getQueueRuns,
  getQueueRunCount,
  getQueueRun,
  deleteQueueRun,
  getQueueRunTasks,
  failStuckQueueRuns,
  type QueueRunRow,
  type QueueTaskRowDb,
  type QueueTaskInsert,
  type WorkGroupSummary,
} from '../services/db.js';

/** The 8 Payments-skill groups (verified 2026-06-03). group_id = task_manager_groups.public_id. */
const PAYMENTS_GROUPS = [
  { groupId: '58447710-7eb4-4ae0-ac01-1761786a3d41', name: 'Scam Squad', priority: 4 },
  { groupId: 'a2e97f29-1d6a-49bc-af24-f5a6a8d59ffe', name: 'Auto-chargebacks', priority: 3 },
  { groupId: 'e15ea1ef-e41f-498d-9315-d82922dd2e2d', name: 'Return funds to source', priority: 2 },
  { groupId: 'fa8a1576-be37-4414-a9ab-caf6cf458d34', name: 'DD Indemnity Claims', priority: 2 },
  { groupId: '24f4611a-3065-469b-bde1-2c5409911621', name: 'Disputes', priority: 2 },
  { groupId: '5d68f04595296d55702eeea6', name: 'Payments Account Support', priority: 1 },
  { groupId: 'a21f8a8f-d20c-453c-a6bf-31aa09e6bf5f', name: 'Negative Balance', priority: 1 },
  { groupId: '61e0d287-3569-4190-b598-7e657d0c1785', name: 'Retrievals', priority: 1 },
] as const;

// Hard cap on a single run; past this the worker is assumed hung and the run is failed.
const RUN_DEADLINE_MS = 8 * 60_000;

const RunSchema = z.object({
  groupId: z.string().min(1),
  model: z.string().min(1).optional(),
});

const TasksQuerySchema = z.object({
  urgency: z.enum(['high', 'medium', 'low']).optional(),
  quickWin: z.enum(['true', 'false']).optional(),
  status: z.string().optional(),
  kind: z.string().optional(),
  wrongQueue: z.enum(['true', 'false']).optional(),
  groupName: z.string().optional(),
});

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function formatRun(r: QueueRunRow) {
  return {
    id: r.id,
    groupId: r.group_id,
    groupName: r.group_name,
    model: r.model,
    promptMd5: r.prompt_md5,
    status: r.status,
    nTasks: r.n_tasks,
    nHighUrgency: r.n_high_priority,
    totalResidualBalance: num(r.total_residual_balance),
    nSafeClose: r.n_safe_close,
    nQuickWins: r.n_quick_wins,
    nOverdue: r.n_overdue,
    nWrongQueue: r.n_wrong_queue,
    summary: r.summary,
    groups: (r.groups ?? []).map((g) => ({
      name: g.name,
      kind: g.kind,
      isNewKind: g.is_new_kind,
      disposition: g.disposition,
      urgency: g.urgency,
      quickWin: g.quick_win,
      slaDays: g.sla_days,
      theWork: g.the_work,
      destination: g.destination,
      kbRef: g.kb_ref,
      count: g.count,
      totalBalance: g.total_balance,
      memberTaskIds: g.member_task_ids,
    })),
    error: r.error,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
}

function formatTask(t: QueueTaskRowDb) {
  return {
    id: t.id,
    runId: t.run_id,
    taskId: t.task_id,
    wsLink: buildTaskWsLink(t.alias, t.task_id) ?? t.ws_link,
    alias: t.alias,
    title: t.title,
    taskType: t.task_type,
    ageDays: t.age_days,
    createdBy: t.created_by,
    takenBy: t.taken_by,
    rbJiraSync: t.rb_jira_sync,
    nCases: t.n_cases,
    nActive: t.n_active,
    nDone: t.n_done,
    caseStatuses: t.case_statuses,
    balance: num(t.balance),
    currency: t.currency,
    accountStatuses: t.account_statuses,
    accountClosed: t.account_closed,
    companyStatus: t.company_status,
    dateCeasedOn: t.date_ceased_on,
    daysSinceCessation: t.days_since_cessation,
    companyNumber: t.company_number,
    companyTitle: t.company_title,
    nAliasOpen: t.n_alias_open,
    nAliasClosed: t.n_alias_closed,
    hasAttachments: t.has_attachments,
    groupName: t.group_name,
    kind: t.kind,
    isNewKind: t.is_new_kind,
    disposition: t.disposition,
    theWork: t.the_work,
    urgency: t.urgency,
    quickWin: t.quick_win,
    status: t.status,
    slaDays: t.sla_days,
    slaStatus: t.sla_status,
    wrongQueue: t.wrong_queue,
    suggestedQueue: t.suggested_queue,
    destination: t.destination,
    kbRef: t.kb_ref,
    suggestedAction: t.suggested_action,
    rationale: t.rationale,
    caseContext: t.case_context,
    createdAt: t.created_at,
  };
}

/** Merge an enriched task with its triage assignment into a DB insert row. */
function toInsert(t: EnrichedTaskRow, a: TaskAssignment | undefined): QueueTaskInsert {
  return {
    task_id: t.task_id,
    ws_link: buildTaskWsLink(t.alias, t.task_id),
    alias: t.alias,
    title: t.title,
    task_type: t.task_type,
    age_days: t.age_days,
    created_by: t.created_by,
    taken_by: t.taken_by,
    rb_jira_sync: t.rb_jira_sync,
    n_cases: t.n_cases,
    n_active: t.n_active,
    n_done: t.n_done,
    case_statuses: t.case_statuses,
    balance: t.total_balance,
    currency: t.currency,
    account_statuses: t.account_statuses,
    account_closed: t.account_closed,
    company_status: t.company_status,
    date_ceased_on: t.date_ceased_on,
    days_since_cessation: t.days_since_cessation,
    company_number: t.company_number,
    company_title: t.company_title,
    n_alias_open: t.n_alias_open,
    n_alias_closed: t.n_alias_closed,
    group_name: a?.group_name ?? null,
    disposition: a?.disposition ?? null,
    the_work: a?.the_work ?? null,
    priority: a?.urgency ?? null,
    rationale: a?.rationale ?? null,
    suggested_action: a?.next_step ?? null,
    kind: a?.kind ?? null,
    urgency: a?.urgency ?? null,
    quick_win: a?.quick_win ?? null,
    status: a?.status ?? null,
    sla_days: a?.sla_days ?? null,
    sla_status: a?.sla_status ?? null,
    wrong_queue: a?.wrong_queue ?? null,
    suggested_queue: a?.suggested_queue ?? null,
    destination: a?.destination ?? null,
    kb_ref: a?.kb_ref ?? null,
    is_new_kind: a?.is_new_kind ?? null,
    has_attachments: t.has_attachments,
    case_context: t.case_context ?? null,
  };
}

export async function queueAnalyserRoutes(app: FastifyInstance) {
  // Reconcile runs orphaned by a previous restart (their in-process workers are gone).
  failStuckQueueRuns()
    .then((n) => {
      if (n > 0) app.log.warn({ n }, 'queue: reconciled stuck run(s) orphaned by restart');
    })
    .catch((err) => app.log.error({ err }, 'queue: failed to reconcile stuck runs'));

  // GET /groups — the seeded Payments skill groups (ordered by priority desc)
  app.get('/groups', async () => {
    return {
      data: [...PAYMENTS_GROUPS]
        .sort((a, b) => b.priority - a.priority)
        .map((g) => ({ groupId: g.groupId, name: g.name, priority: g.priority })),
    };
  });

  // POST /run — enrich (Stage 1) → analyse/group (Stage 2) → persist (async)
  app.post('/run', async (request, reply) => {
    let body: z.infer<typeof RunSchema>;
    try {
      body = RunSchema.parse(request.body);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ error: 'Validation error', details: error.errors });
      }
      throw error;
    }

    const group = PAYMENTS_GROUPS.find((g) => g.groupId === body.groupId);
    if (!group) {
      return reply.status(400).send({ error: `Unknown groupId: ${body.groupId}` });
    }

    const run = await insertQueueRun(group.groupId, group.name, body.model ?? null);

    void (async () => {
      let timedOut = false;
      let stage = 'fetch-ws';
      const runPipeline = async () => {
        // The open-task LIST comes live from the workstation tasks API — the BigQuery
        // export lags (closed tasks linger, fresh ones missing). A WS failure fails the
        // run loudly; we never fall back to the stale export.
        const tws = Date.now();
        stageLog(run.id, 'WORKER START → fetch-ws');
        const agentTasks = await fetchOpenAgentTasks(group.groupId);
        // The Disputes queue's work includes CASE ACTIONS (dispute form/evidence/handover
        // items) — they queue by SKILL (all under skill:payments today), not by task
        // group, so they're invisible to the agent-tasks listing. Surface them as
        // queue items with their case attached directly.
        const caseActions = group.name === 'Disputes' ? await fetchOpenCaseActions('payments') : [];
        const actionWs: WsAgentTask[] = caseActions.map((a) => ({
          id: a.id,
          alias: a.alias,
          title: `${a.action_type.replace(/_/g, ' ')} — case action`,
          description: null,
          task_type: 'CASE_ACTION',
          rb_jira_sync: null,
          created_by: null,
          taken_by: null,
          created_at: a.created_at,
          status: a.status,
          group_id: group.groupId,
          attachments: [],
        }));
        const actionCaseById = new Map(caseActions.map((a) => [a.id, a.case_id]));
        const wsTasks = [...agentTasks, ...actionWs];
        stageLog(
          run.id,
          `fetch-ws done (${agentTasks.length} open tasks + ${caseActions.length} case actions, ${Date.now() - tws}ms) → enrich`,
        );

        // BQ enrichment (balances/company/siblings) and the live WS case content
        // (activity, cases, events, assessments, messages) are independent — run both
        // at once. Live-content failures degrade per task; only the WS task list and
        // the BQ enrich query are fatal.
        stage = 'enrich';
        const t0 = Date.now();
        app.log.info({ runId: run.id, n: wsTasks.length }, 'queue: enrich + live content start');
        const taskRefs = wsTasks.map((t) => ({
          task_id: t.id,
          alias: t.alias,
          created_at: t.created_at,
          direct_case_id: actionCaseById.get(t.id) ?? null,
          is_case_action: actionCaseById.has(t.id),
        }));
        const [enriched, live] = await Promise.all([
          fetchQueueEnriched(wsTasks),
          fetchLiveCaseContent(taskRefs),
        ]);
        stageLog(
          run.id,
          `enrich + live-content done (${enriched.length} tasks, ${live.failures.length} fetch failures, ${Date.now() - t0}ms) → merge`,
        );

        stage = 'case-content';
        const t1 = Date.now();
        let nWithContext = 0;
        for (const t of enriched) {
          // Live case stats fill what the enrich query no longer computes.
          const stats = live.caseStats.get(t.task_id);
          if (stats) {
            t.n_cases = stats.n_cases;
            t.n_active = stats.n_active;
            t.n_done = stats.n_done;
            t.case_statuses = stats.case_statuses;
          }
          t.safe_close_candidate =
            (t.total_balance ?? 0) <= 0.005 && t.n_active === 0 && t.n_done > 0;
          t.case_context = assembleCaseContext(live.aggs.get(t.task_id), live.msgs.get(t.task_id));
          if (t.case_context) nWithContext++;
        }
        stageLog(
          run.id,
          `case-content merged (${nWithContext} with ctx, ${live.nAttached} via attached dialogues, ${Date.now() - t1}ms) → analyse`,
        );
        if (live.failures.length > 0) {
          stageLog(run.id, `live-content failures: ${live.failures.slice(0, 20).join(', ')}${live.failures.length > 20 ? ' …' : ''}`);
        }
        app.log.info(
          { runId: run.id, n: enriched.length, nWithContext, failures: live.failures.length },
          'queue: case content done, analyse start',
        );
        // Disputes are classified by phase (Timeline Analyzer + case actions), not catalog kinds.
        stage = 'analyse';
        const t2 = Date.now();
        const analysis =
          group.name === 'Disputes'
            ? await analyseDisputeQueue(enriched, group.name, live.casesByTask, body.model)
            : await analyseQueue(enriched, group.name, body.model);
        // The degrade marker: surface partial live-content coverage on the run itself.
        if (live.failures.length > 0) {
          const marker = `context: ${live.failures.length} live fetch(es) failed`;
          analysis.error = analysis.error ? `${analysis.error} · ${marker}` : marker;
        }
        stageLog(run.id, `analyse done (${analysis.groups.length} groups, llmError=${analysis.error ?? 'none'}, ${Date.now() - t2}ms) → persist`);
        app.log.info({ runId: run.id, groups: analysis.groups.length, llmError: analysis.error, ms: Date.now() - t2 }, 'queue: analyse done, persist start');
        stage = 'persist';

        await bulkInsertQueueTasks(
          run.id,
          enriched.map((t) => {
            const row = toInsert(t, analysis.byTask.get(t.task_id));
            // Case-action items have no agent task to link to — link to their case.
            const actionCaseId = actionCaseById.get(t.task_id);
            if (actionCaseId) row.ws_link = buildCaseWsLink(t.alias, actionCaseId);
            return row;
          }),
        );

        // Roll group member counts + residual balance into the run summary.
        const balById = new Map(enriched.map((t) => [t.task_id, t.total_balance ?? 0]));
        const groupSummaries: WorkGroupSummary[] = analysis.groups.map((g) => ({
          name: g.name,
          kind: g.kind,
          is_new_kind: g.is_new_kind,
          disposition: g.disposition,
          urgency: g.urgency,
          quick_win: g.quick_win,
          sla_days: g.sla_days,
          the_work: g.the_work,
          destination: g.destination,
          kb_ref: g.kb_ref,
          count: g.member_task_ids.length,
          total_balance: Math.round(g.member_task_ids.reduce((s, id) => s + (balById.get(id) ?? 0), 0) * 100) / 100,
          member_task_ids: g.member_task_ids,
        }));

        const assignments = [...analysis.byTask.values()];
        const totalResidual = enriched
          .filter((t) => t.company_inactive && (t.total_balance ?? 0) > 0.005)
          .reduce((s, t) => s + (t.total_balance ?? 0), 0);

        if (timedOut) return;
        await completeQueueRun(run.id, {
          promptMd5: createHash('md5').update(analysis.promptContent).digest('hex'),
          nTasks: enriched.length,
          groups: groupSummaries,
          summary: analysis.error
            ? `${analysis.queue_summary} (LLM error: ${analysis.error})`
            : analysis.queue_summary,
          nHighPriority: assignments.filter((a) => a.urgency === 'high').length,
          totalResidualBalance: Math.round(totalResidual * 100) / 100,
          nSafeClose: assignments.filter((a) => a.kind === 'safe_close').length,
          nQuickWins: assignments.filter((a) => a.quick_win).length,
          nOverdue: assignments.filter((a) => a.sla_status === 'overdue').length,
          nWrongQueue: assignments.filter((a) => a.wrong_queue).length,
        });
        stageLog(run.id, 'COMPLETE (persisted, status=ready)');
      };

      // Hard deadline — a run is fire-and-forget with no cancel, so without this a single
      // stuck BigQuery query or LLM call would orphan it as "running" forever.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          stageLog(run.id, `DEADLINE FIRED in stage "${stage}"`);
          reject(new Error(`Run exceeded ${RUN_DEADLINE_MS / 60_000} min — stuck in stage "${stage}" (a BigQuery query or LLM call did not return).`));
        }, RUN_DEADLINE_MS);
      });

      try {
        await Promise.race([runPipeline(), deadline]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stageLog(run.id, `ERROR in stage "${stage}": ${message}`);
        app.log.error({ runId: run.id, error }, 'Queue analyser run failed');
        await failQueueRun(run.id, message).catch(() => {});
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();

    return reply.status(201).send(formatRun(run));
  });

  // GET /runs — paginated run history
  app.get<{ Querystring: { page?: string; pageSize?: string } }>('/runs', async (request) => {
    const page = Math.max(1, parseInt(request.query.page ?? '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(request.query.pageSize ?? '20', 10) || 20));
    const offset = (page - 1) * pageSize;
    const [runs, totalCount] = await Promise.all([getQueueRuns(pageSize, offset), getQueueRunCount()]);
    return {
      data: runs.map(formatRun),
      totalCount,
      page,
      pageSize,
      totalPages: Math.ceil(totalCount / pageSize),
    };
  });

  // GET /runs/:runId — single run summary (incl. groups)
  app.get<{ Params: { runId: string } }>('/runs/:runId', async (request, reply) => {
    const runId = parseInt(request.params.runId, 10);
    if (isNaN(runId)) return reply.status(400).send({ error: 'Invalid run ID' });
    const run = await getQueueRun(runId);
    if (!run) return reply.status(404).send({ error: 'Run not found' });
    return formatRun(run);
  });

  // DELETE /runs/:runId — remove a run (and its task rows via cascade)
  app.delete<{ Params: { runId: string } }>('/runs/:runId', async (request, reply) => {
    const runId = parseInt(request.params.runId, 10);
    if (isNaN(runId)) return reply.status(400).send({ error: 'Invalid run ID' });
    const deleted = await deleteQueueRun(runId);
    if (deleted === 0) return reply.status(404).send({ error: 'Run not found' });
    return { success: true };
  });

  // GET /runs/:runId/tasks — enriched task rows (filterable by urgency / quick-win / status / kind / wrong-queue / group)
  app.get<{ Params: { runId: string }; Querystring: Record<string, string> }>(
    '/runs/:runId/tasks',
    async (request, reply) => {
      const runId = parseInt(request.params.runId, 10);
      if (isNaN(runId)) return reply.status(400).send({ error: 'Invalid run ID' });
      let q: z.infer<typeof TasksQuerySchema>;
      try {
        q = TasksQuerySchema.parse(request.query);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.status(400).send({ error: 'Validation error', details: error.errors });
        }
        throw error;
      }
      const tasks = await getQueueRunTasks(runId, {
        urgency: q.urgency,
        quickWin: q.quickWin === undefined ? undefined : q.quickWin === 'true',
        status: q.status,
        kind: q.kind,
        wrongQueue: q.wrongQueue === undefined ? undefined : q.wrongQueue === 'true',
        groupName: q.groupName,
      });
      return { data: tasks.map(formatTask) };
    },
  );
}

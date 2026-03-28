import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runCustomSql } from '../services/dataset-segments.js';
import { runDisputePipeline, fetchCaseContext } from '../services/dispute-pipeline.js';
import {
  insertDatasetWithCases,
  listDatasets,
  getDataset,
  deleteDataset,
  listDatasetCases,
  updateDatasetCaseLabel,
  deleteDatasetCase,
  datasetCaseExists,
  getPipelineRunsByIds,
  insertDatasetRun,
  insertDatasetRunCases,
  updateDatasetRunCaseResult,
  updateDatasetRunCaseError,
  updateDatasetRunStatus,
  listDatasetRuns,
  getDatasetRunCases,
  updateDatasetRunCaseLabel,
  updateDatasetCaseTags,
  getDatasetAnalytics,
  getComparisonData,
  updateDatasetCaseLabel2,
  composeDatasets,
  updateDatasetCaseContext,
  updateDatasetCaseContextError,
  updateDatasetStatus,
  getDatasetCaseContexts,
} from '../services/db.js';
import { formatPipelineRun } from '../types/dispute-pipeline.js';
import type { PipelineRunRow, DatasetCaseRow, DatasetRow, RunConfig, CaseContext, CaseSignalsRaw, CaseAction, DialogueMessage } from '../types/dispute-pipeline.js';
import { DEFAULT_RUBRIC_WEIGHTS } from '../services/dispute-pipeline.js';
import { listPrompts } from '../services/prompts.js';
import { computeFullAnalytics, computeRunComparison } from '../services/dataset-analytics.js';

const CreateDatasetSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  sourceType: z.enum(['case_ids', 'custom_sql']),
  sourceConfig: z.record(z.unknown()),
});

const LabelSchema = z.object({
  label: z.enum(['credit', 'escalate', 'undecided']),
  notes: z.string().nullable().optional(),
  labeledBy: z.string().nullable().optional(),
  confidence: z.enum(['high', 'medium', 'low']).nullable().optional(),
  disagreementReason: z.enum(['signal_quality', 'rubric_issue', 'llm_reasoning', 'human_label_wrong', 'edge_case', 'other']).nullable().optional(),
  disagreementNotes: z.string().nullable().optional(),
});

function formatDataset(d: DatasetRow & { total_cases?: number; labeled_cases?: number }) {
  return {
    id: d.id,
    name: d.name,
    description: d.description,
    sourceType: d.source_type,
    sourceConfig: d.source_config,
    status: d.status ?? 'ready',
    createdAt: d.created_at,
    ...(d.total_cases !== undefined ? { totalCases: d.total_cases } : {}),
    ...(d.labeled_cases !== undefined ? { labeledCases: d.labeled_cases } : {}),
  };
}

function formatDatasetCase(row: DatasetCaseRow) {
  return {
    id: row.id,
    datasetId: row.dataset_id,
    caseId: row.case_id,
    // Context data
    rawSignals: row.raw_signals ?? null,
    caseDetails: row.case_details ?? null,
    caseActions: row.case_actions ?? null,
    dialogueMessages: row.dialogue_messages ?? null,
    fileParseResults: row.file_parse_results ?? null,
    enrichmentMetadata: row.enrichment_metadata ?? null,
    contextError: row.context_error ?? null,
    contextFetchedAt: row.context_fetched_at ?? null,
    // Legacy fields
    pipelineRunId: row.pipeline_run_id,
    pipelineError: row.pipeline_error,
    // Labels
    label: row.label,
    labelNotes: row.label_notes,
    labeledBy: row.labeled_by,
    labeledAt: row.labeled_at,
    labelConfidence: row.label_confidence ?? null,
    disagreementReason: row.disagreement_reason ?? null,
    disagreementNotes: row.disagreement_notes ?? null,
    label2: row.label_2 ?? null,
    label2Notes: row.label_2_notes ?? null,
    label2By: row.label_2_by ?? null,
    label2At: row.label_2_at ?? null,
    label2Confidence: row.label_2_confidence ?? null,
    manualTags: row.manual_tags ?? [],
    autoTags: row.auto_tags ?? {},
    createdAt: row.created_at,
  };
}

/**
 * Run promises with a concurrency limit.
 */
async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results: T[] = [];
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]!();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

const SUPPORTED_MODELS = [
  'claude-sonnet-4-5@20250929',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'gemini-2.5-flash',
];

export async function datasetRoutes(app: FastifyInstance) {
  // GET /run-options — Available models, prompts, and default rubric weights
  app.get('/run-options', async () => {
    const prompts = await listPrompts();
    return {
      models: SUPPORTED_MODELS,
      prompts,
      default_rubric: DEFAULT_RUBRIC_WEIGHTS,
    };
  });

  // GET / — List all datasets with labeled/total counts
  app.get('/', async () => {
    const datasets = await listDatasets();
    return {
      data: datasets.map((d) => formatDataset(d)),
    };
  });

  // POST / — Create dataset + resolve case IDs + run pipeline for each
  app.post('/', async (request, reply) => {
    try {
      const body = CreateDatasetSchema.parse(request.body);

      // Resolve case IDs based on source type
      let caseIds: number[];
      try {
        if (body.sourceType === 'case_ids') {
          const ids = body.sourceConfig.ids;
          if (!Array.isArray(ids)) {
            return reply.status(400).send({ error: 'source_config.ids must be an array' });
          }
          if (ids.length > 500) {
            return reply.status(400).send({ error: 'Maximum 500 case IDs allowed' });
          }
          caseIds = ids.map((id) => {
            const n = Number(id);
            if (!Number.isInteger(n) || n <= 0) {
              throw new Error(`Invalid case ID: ${id}`);
            }
            return n;
          });
        } else {
          const sql = body.sourceConfig.sql;
          if (typeof sql !== 'string') {
            return reply.status(400).send({ error: 'source_config.sql must be a string' });
          }
          caseIds = await runCustomSql(sql);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.status(400).send({ error: `Failed to resolve case IDs: ${message}` });
      }

      // Deduplicate case IDs
      caseIds = [...new Set(caseIds)];

      if (caseIds.length === 0) {
        return reply.status(400).send({ error: 'No case IDs resolved from source' });
      }

      // Insert dataset + cases in a single transaction
      const { dataset, cases: datasetCases } = await insertDatasetWithCases(
        body.name,
        body.description ?? null,
        body.sourceType,
        body.sourceConfig,
        caseIds,
      );

      // Fetch context for each case in background (no LLM pipeline)
      await updateDatasetStatus(dataset.id, 'loading');

      const tasks = datasetCases.map((dc) => async () => {
        try {
          const exists = await datasetCaseExists(dc.id);
          if (!exists) return;

          const context = await fetchCaseContext(dc.case_id);
          await updateDatasetCaseContext(dc.id, context);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          app.log.error(
            { caseId: dc.case_id, datasetId: dataset.id, error },
            'Context fetch failed for dataset case',
          );
          await updateDatasetCaseContextError(dc.id, message).catch(() => {});
        }
      });

      // Fire and forget — frontend polls for completion
      runWithConcurrency(tasks, 3)
        .then(() => updateDatasetStatus(dataset.id, 'ready'))
        .catch((error) => {
          app.log.error({ datasetId: dataset.id, error }, 'Background context fetch batch failed');
          updateDatasetStatus(dataset.id, 'ready').catch(() => {});
        });

      return reply.status(201).send({
        ...formatDataset(dataset),
        totalCases: datasetCases.length,
        labeledCases: 0,
        status: 'loading',
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ error: 'Validation error', details: error.errors });
      }
      throw error;
    }
  });

  // GET /:id — Get dataset with all cases and context data
  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    if (isNaN(id)) {
      return reply.status(400).send({ error: 'Invalid ID' });
    }

    const dataset = await getDataset(id);
    if (!dataset) {
      return reply.status(404).send({ error: 'Dataset not found' });
    }

    const cases = await listDatasetCases(id);

    // For backward compat: if a case has pipeline_run_id but no raw_signals,
    // populate context from the linked pipeline run
    const legacyCaseIds = cases
      .filter((c) => c.pipeline_run_id !== null && c.raw_signals === null)
      .map((c) => c.pipeline_run_id!);
    let legacyRunMap = new Map<number, PipelineRunRow>();
    if (legacyCaseIds.length > 0) {
      const runs = await getPipelineRunsByIds(legacyCaseIds);
      legacyRunMap = new Map(runs.map((r) => [r.id, r]));
    }

    const formattedCases = cases.map((c) => {
      const formatted = formatDatasetCase(c);
      // Backfill context from legacy pipeline run
      if (!formatted.rawSignals && c.pipeline_run_id) {
        const run = legacyRunMap.get(c.pipeline_run_id);
        if (run) {
          formatted.rawSignals = run.raw_signals;
          formatted.caseDetails = run.case_details as Record<string, unknown> | null;
          formatted.caseActions = run.case_actions;
          formatted.dialogueMessages = run.dialogue_messages;
          formatted.fileParseResults = run.file_parse_results;
          formatted.enrichmentMetadata = run.enrichment_metadata;
          formatted.contextFetchedAt = run.created_at;
        }
      }
      return formatted;
    });

    return {
      ...formatDataset(dataset),
      totalCases: cases.length,
      labeledCases: cases.filter((c) => c.label !== null).length,
      cases: formattedCases,
    };
  });

  // DELETE /:id — Delete dataset and all its cases
  app.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    if (isNaN(id)) {
      return reply.status(400).send({ error: 'Invalid ID' });
    }
    const count = await deleteDataset(id);
    if (count === 0) {
      return reply.status(404).send({ error: 'Dataset not found' });
    }
    return { success: true };
  });

  // POST /:id/refresh — Re-fetch context for all cases
  app.post<{ Params: { id: string } }>('/:id/refresh', async (request, reply) => {
    const datasetId = parseInt(request.params.id, 10);
    if (isNaN(datasetId)) {
      return reply.status(400).send({ error: 'Invalid ID' });
    }

    const dataset = await getDataset(datasetId);
    if (!dataset) {
      return reply.status(404).send({ error: 'Dataset not found' });
    }

    const cases = await listDatasetCases(datasetId);
    if (cases.length === 0) {
      return reply.send({ success: true, refreshing: 0 });
    }

    await updateDatasetStatus(datasetId, 'loading');

    const tasks = cases.map((dc) => async () => {
      try {
        const context = await fetchCaseContext(dc.case_id);
        await updateDatasetCaseContext(dc.id, context);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await updateDatasetCaseContextError(dc.id, message).catch(() => {});
      }
    });

    runWithConcurrency(tasks, 3)
      .then(() => updateDatasetStatus(datasetId, 'ready'))
      .catch(() => updateDatasetStatus(datasetId, 'ready').catch(() => {}));

    return reply.send({ success: true, refreshing: cases.length });
  });

  // PATCH /cases/:id/label — Save label, notes, labeled_by
  app.patch<{ Params: { id: string } }>('/cases/:id/label', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    if (isNaN(id)) {
      return reply.status(400).send({ error: 'Invalid ID' });
    }

    try {
      const body = LabelSchema.parse(request.body);
      const row = await updateDatasetCaseLabel(
        id, body.label, body.notes ?? null, body.labeledBy ?? null,
        body.confidence ?? null, body.disagreementReason ?? null, body.disagreementNotes ?? null,
      );
      if (!row) {
        return reply.status(404).send({ error: 'Dataset case not found' });
      }
      return formatDatasetCase(row);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ error: 'Validation error', details: error.errors });
      }
      throw error;
    }
  });

  // DELETE /cases/:id — Remove a case from dataset
  app.delete<{ Params: { id: string } }>('/cases/:id', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    if (isNaN(id)) {
      return reply.status(400).send({ error: 'Invalid ID' });
    }
    const count = await deleteDatasetCase(id);
    if (count === 0) {
      return reply.status(404).send({ error: 'Dataset case not found' });
    }
    return { success: true };
  });

  // --- Dataset Runs ---

  const CreateRunSchema = z.object({
    name: z.string().min(1),
    model: z.string().min(1),
    prompt_version: z.string().min(1),
    rubric_weights: z.object({
      account_trust_max: z.number(),
      dispute_history_max: z.number(),
      transaction_risk_max: z.number(),
      green_threshold: z.number(),
      amber_threshold: z.number(),
    }),
  });

  // POST /:id/runs — Create and execute a dataset run
  app.post<{ Params: { id: string } }>('/:id/runs', async (request, reply) => {
    const datasetId = parseInt(request.params.id, 10);
    if (isNaN(datasetId)) {
      return reply.status(400).send({ error: 'Invalid dataset ID' });
    }

    const dataset = await getDataset(datasetId);
    if (!dataset) {
      return reply.status(404).send({ error: 'Dataset not found' });
    }

    try {
      const body = CreateRunSchema.parse(request.body);

      const runConfig: RunConfig = {
        model: body.model,
        prompt_version: body.prompt_version,
        rubric_weights: body.rubric_weights,
        name: body.name,
      };

      // 1. Insert run row
      const run = await insertDatasetRun(datasetId, body.name, runConfig);

      // 2. Fetch all dataset cases
      const datasetCases = await listDatasetCases(datasetId);
      if (datasetCases.length === 0) {
        await updateDatasetRunStatus(run.id, 'completed', new Date());
        return reply.status(201).send({ ...run, status: 'completed' });
      }

      // 3. Insert run case rows
      const datasetCaseIds = datasetCases.map((dc) => dc.id);
      await insertDatasetRunCases(run.id, datasetCaseIds);

      // 4. Set status to running
      await updateDatasetRunStatus(run.id, 'running');

      // 5. Fetch cached contexts to pass to pipeline (optimization: skip re-fetching)
      const cachedContexts = await getDatasetCaseContexts(datasetId);
      const contextMap = new Map<number, CaseContext>();
      for (const dc of cachedContexts) {
        if (dc.raw_signals) {
          contextMap.set(dc.case_id as number, {
            raw_signals: dc.raw_signals as CaseSignalsRaw,
            case_details: dc.case_details ?? null,
            case_actions: (dc.case_actions as CaseAction[] | null) ?? null,
            dialogue_messages: (dc.dialogue_messages as DialogueMessage[] | null) ?? null,
            file_parse_results: (dc.file_parse_results as string[] | null) ?? null,
            enrichment_metadata: (dc.enrichment_metadata as Record<string, unknown> | null) ?? null,
          });
        }
      }

      // Execute pipelines in background with concurrency 3
      const cases = await getDatasetRunCases(run.id);
      let failedCount = 0;
      const tasks = cases.map((rc) => async () => {
        try {
          const cached = contextMap.get(rc.case_id);
          const pipelineRun = await runDisputePipeline(
            rc.case_id,
            runConfig,
            cached,
          );
          await updateDatasetRunCaseResult(rc.id, pipelineRun.id);
        } catch (error) {
          failedCount++;
          const message = error instanceof Error ? error.message : String(error);
          app.log.error(
            { caseId: rc.case_id, runId: run.id, error },
            'Pipeline run failed for dataset run case',
          );
          await updateDatasetRunCaseError(rc.id, message).catch((dbErr) => {
            app.log.error(
              { caseId: rc.case_id, runId: run.id, error: dbErr },
              'Failed to persist error status for dataset run case',
            );
          });
        }
      });

      // Fire and forget
      runWithConcurrency(tasks, 3)
        .then(async () => {
          const status = failedCount === cases.length ? 'failed' : 'completed';
          await updateDatasetRunStatus(run.id, status, new Date());
        })
        .catch(async (error) => {
          app.log.error({ runId: run.id, error }, 'Dataset run batch failed');
          await updateDatasetRunStatus(run.id, 'failed').catch(() => {});
        });

      // Return immediately with pending status
      return reply.status(201).send(run);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ error: 'Validation error', details: error.errors });
      }
      throw error;
    }
  });

  // GET /:id/runs — List all runs for a dataset
  app.get<{ Params: { id: string } }>('/:id/runs', async (request, reply) => {
    const datasetId = parseInt(request.params.id, 10);
    if (isNaN(datasetId)) {
      return reply.status(400).send({ error: 'Invalid dataset ID' });
    }

    const runs = await listDatasetRuns(datasetId);
    return { data: runs };
  });

  // GET /runs/:runId/cases — All run cases with pipeline output + label
  app.get<{ Params: { runId: string } }>('/runs/:runId/cases', async (request, reply) => {
    const runId = parseInt(request.params.runId, 10);
    if (isNaN(runId)) {
      return reply.status(400).send({ error: 'Invalid run ID' });
    }

    const cases = await getDatasetRunCases(runId);
    return {
      data: cases.map((rc) => ({
        id: rc.id,
        runId: rc.run_id,
        datasetCaseId: rc.dataset_case_id,
        caseId: rc.case_id,
        label: rc.label,
        labelNotes: rc.label_notes,
        labeledBy: rc.labeled_by,
        labeledAt: rc.labeled_at,
        labelConfidence: rc.label_confidence,
        disagreementReason: rc.disagreement_reason,
        disagreementNotes: rc.disagreement_notes,
        pipelineRunId: rc.pipeline_run_id,
        pipelineError: rc.pipeline_error,
        pipelineRun: rc.pipeline_run ? formatPipelineRun(rc.pipeline_run) : null,
        agreement: computeAgreement(rc.label, rc.pipeline_run),
      })),
    };
  });

  // PATCH /run-cases/:id/label — Save run-specific label
  app.patch<{ Params: { id: string } }>('/run-cases/:id/label', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    if (isNaN(id)) {
      return reply.status(400).send({ error: 'Invalid ID' });
    }

    try {
      const body = LabelSchema.parse(request.body);
      const row = await updateDatasetRunCaseLabel(
        id, body.label, body.notes ?? null, body.labeledBy ?? null,
        body.confidence ?? null, body.disagreementReason ?? null, body.disagreementNotes ?? null,
      );
      if (!row) {
        return reply.status(404).send({ error: 'Run case not found' });
      }
      return { success: true };
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ error: 'Validation error', details: error.errors });
      }
      throw error;
    }
  });

  // --- Analytics ---

  // GET /:id/analytics — Stratified analytics with confusion matrix
  app.get<{ Params: { id: string }; Querystring: { runId?: string } }>(
    '/:id/analytics',
    async (request, reply) => {
      const datasetId = parseInt(request.params.id, 10);
      if (isNaN(datasetId)) {
        return reply.status(400).send({ error: 'Invalid dataset ID' });
      }
      if (!request.query.runId) {
        return reply.status(400).send({ error: 'runId is required. Select a run to view analytics.' });
      }
      const runId = parseInt(request.query.runId, 10);
      if (isNaN(runId) || runId <= 0) {
        return reply.status(400).send({ error: 'Invalid run ID' });
      }

      const { confusion_matrix, rows } = await getDatasetAnalytics(datasetId, runId);
      return computeFullAnalytics(confusion_matrix, rows);
    },
  );

  // GET /:id/compare — Compare two runs
  app.get<{ Params: { id: string }; Querystring: { runA: string; runB: string } }>(
    '/:id/compare',
    async (request, reply) => {
      const datasetId = parseInt(request.params.id, 10);
      if (isNaN(datasetId)) {
        return reply.status(400).send({ error: 'Invalid dataset ID' });
      }
      const runA = parseInt(request.query.runA, 10);
      const runB = parseInt(request.query.runB, 10);
      if (isNaN(runA) || isNaN(runB) || runA <= 0 || runB <= 0) {
        return reply.status(400).send({ error: 'Invalid run IDs — provide runA and runB query parameters' });
      }
      if (runA === runB) {
        return reply.status(400).send({ error: 'Cannot compare a run with itself' });
      }

      const rows = await getComparisonData(datasetId, runA, runB);
      return computeRunComparison(rows);
    },
  );

  // PATCH /cases/:id/tags — Set manual tags
  const TagsSchema = z.object({
    tags: z.array(z.string()),
  });

  app.patch<{ Params: { id: string } }>('/cases/:id/tags', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    if (isNaN(id)) {
      return reply.status(400).send({ error: 'Invalid ID' });
    }
    try {
      const body = TagsSchema.parse(request.body);
      const row = await updateDatasetCaseTags(id, body.tags);
      if (!row) {
        return reply.status(404).send({ error: 'Dataset case not found' });
      }
      return formatDatasetCase(row);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ error: 'Validation error', details: error.errors });
      }
      throw error;
    }
  });

  // PATCH /cases/:id/label-2 — Save second labeler's verdict
  const Label2Schema = z.object({
    label: z.enum(['credit', 'escalate', 'undecided']),
    notes: z.string().nullable().optional(),
    labeledBy: z.string().nullable().optional(),
    confidence: z.enum(['high', 'medium', 'low']).nullable().optional(),
  });

  app.patch<{ Params: { id: string } }>('/cases/:id/label-2', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    if (isNaN(id)) {
      return reply.status(400).send({ error: 'Invalid ID' });
    }
    try {
      const body = Label2Schema.parse(request.body);
      const row = await updateDatasetCaseLabel2(
        id, body.label, body.notes ?? null, body.labeledBy ?? null, body.confidence ?? null,
      );
      if (!row) {
        return reply.status(404).send({ error: 'Dataset case not found' });
      }
      return formatDatasetCase(row);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ error: 'Validation error', details: error.errors });
      }
      throw error;
    }
  });

  // POST /compose — Create a composed dataset from multiple datasets
  const ComposeSchema = z.object({
    name: z.string().min(1),
    description: z.string().nullable().optional(),
    datasetIds: z.array(z.number().int().positive()).min(2),
  });

  app.post('/compose', async (request, reply) => {
    try {
      const body = ComposeSchema.parse(request.body);
      const { dataset, caseCount } = await composeDatasets(
        body.name, body.description ?? null, body.datasetIds,
      );
      return reply.status(201).send({
        ...formatDataset(dataset),
        totalCases: caseCount,
        labeledCases: 0,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ error: 'Validation error', details: error.errors });
      }
      throw error;
    }
  });

}

function computeAgreement(
  label: string | null,
  pipelineRun: PipelineRunRow | null,
): boolean | null {
  if (!label || label === 'undecided' || !pipelineRun) return null;
  const decision = pipelineRun.planner_output?.decision;
  const hardGate = pipelineRun.hard_gate_triggered;
  if (label === 'credit' && decision === 'credit') return true;
  if (label === 'escalate' && (decision === 'escalate_to_agent' || hardGate)) return true;
  return false;
}

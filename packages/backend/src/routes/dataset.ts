import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runCustomSql } from '../services/dataset-segments.js';
import { runDisputePipeline, fetchCaseContext } from '../services/dispute-pipeline.js';
import {
  insertDatasetWithCases,
  insertDatasetCases,
  listDatasets,
  getDataset,
  updateDataset,
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
  updateRunCaseActionNote,
  updateDatasetCaseTags,
  getDatasetAnalytics,
  getComparisonData,
  updateDatasetCaseLabel2,
  composeDatasets,
  updateDatasetCaseContext,
  updateDatasetCaseContextError,
  updateDatasetStatus,
  getDatasetCaseContexts,
  getRunCaseWithContext,
  getDatasetRun,
  deleteDatasetRun,
  renameDatasetRun,
} from '../services/db.js';
import { formatPipelineRun } from '../types/dispute-pipeline.js';
import { runWithConcurrency } from '../utils/concurrency.js';
import type { PipelineRunRow, DatasetCaseRow, DatasetRow, RunConfig, CaseContext, CaseSignalsRaw, CaseAction, DialogueMessage } from '../types/dispute-pipeline.js';
import { loadAnnaCasePrompt } from '../services/anna-case-bridge.js';
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

export async function datasetRoutes(app: FastifyInstance) {

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

  // PATCH /:id — Update dataset name/description
  app.patch<{ Params: { id: string }; Body: { name?: string; description?: string } }>(
    '/:id',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      if (isNaN(id)) {
        return reply.status(400).send({ error: 'Invalid ID' });
      }
      const { name, description } = request.body ?? {};
      if (name === undefined && description === undefined) {
        return reply.status(400).send({ error: 'Provide name or description' });
      }

      const existing = await getDataset(id);
      if (!existing) {
        return reply.status(404).send({ error: 'Dataset not found' });
      }

      const updated = await updateDataset(
        id,
        name !== undefined ? name : existing.name,
        description !== undefined ? description : existing.description,
      );
      return formatDataset(updated!);
    },
  );

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

  // POST /:id/cases — Add cases to an existing dataset
  app.post<{ Params: { id: string } }>('/:id/cases', async (request, reply) => {
    const datasetId = parseInt(request.params.id, 10);
    if (isNaN(datasetId)) {
      return reply.status(400).send({ error: 'Invalid ID' });
    }

    const dataset = await getDataset(datasetId);
    if (!dataset) {
      return reply.status(404).send({ error: 'Dataset not found' });
    }

    const AddCasesSchema = z.object({
      caseIds: z.array(z.union([z.number(), z.string()])).min(1).max(500),
    });

    try {
      const body = AddCasesSchema.parse(request.body);
      let caseIds: number[];
      try {
        caseIds = body.caseIds.map((id) => {
          const n = Number(id);
          if (!Number.isInteger(n) || n <= 0) {
            throw new Error(`Invalid case ID: ${id}`);
          }
          return n;
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.status(400).send({ error: message });
      }
      caseIds = [...new Set(caseIds)];

      const newCases = await insertDatasetCases(datasetId, caseIds);

      if (newCases.length === 0) {
        return reply.send({ added: 0, skipped: caseIds.length, cases: [] });
      }

      await updateDatasetStatus(datasetId, 'loading');

      const tasks = newCases.map((dc) => async () => {
        try {
          const exists = await datasetCaseExists(dc.id);
          if (!exists) return;
          const context = await fetchCaseContext(dc.case_id);
          await updateDatasetCaseContext(dc.id, context);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          app.log.error(
            { caseId: dc.case_id, datasetId, error },
            'Context fetch failed for added dataset case',
          );
          await updateDatasetCaseContextError(dc.id, message).catch(() => {});
        }
      });

      runWithConcurrency(tasks, 3)
        .then(() => updateDatasetStatus(datasetId, 'ready'))
        .catch(() => updateDatasetStatus(datasetId, 'ready').catch(() => {}));

      return reply.status(201).send({
        added: newCases.length,
        skipped: caseIds.length - newCases.length,
        cases: newCases.map(formatDatasetCase),
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ error: 'Validation error', details: error.errors });
      }
      throw error;
    }
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

  // PATCH /runs/:runId/name — Rename a run
  app.patch<{ Params: { runId: string } }>('/runs/:runId/name', async (request, reply) => {
    const runId = parseInt(request.params.runId, 10);
    if (isNaN(runId)) {
      return reply.status(400).send({ error: 'Invalid run ID' });
    }
    const { name } = z.object({ name: z.string().min(1) }).parse(request.body);
    await renameDatasetRun(runId, name);
    return { success: true };
  });

  // DELETE /runs/:runId — Remove a run and its cases
  app.delete<{ Params: { runId: string } }>('/runs/:runId', async (request, reply) => {
    const runId = parseInt(request.params.runId, 10);
    if (isNaN(runId)) {
      return reply.status(400).send({ error: 'Invalid run ID' });
    }
    const count = await deleteDatasetRun(runId);
    if (count === 0) {
      return reply.status(404).send({ error: 'Dataset run not found' });
    }
    return { success: true };
  });

  // --- Dataset Runs ---

  const CreateRunSchema = z.object({
    name: z.string().min(1),
    description: z.string().nullable().optional(),
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

      let promptContent: string | undefined;
      let promptVersion = 'anna-case';
      try {
        const prompt = await loadAnnaCasePrompt();
        promptContent = prompt.content;
        promptVersion = `anna-case:${prompt.md5.slice(0, 8)}`;
      } catch (err) {
        app.log.warn({ err }, 'Failed to snapshot anna-case prompt at run creation');
      }

      const runConfig: RunConfig = {
        name: body.name,
        model: process.env.DISPUTE_PIPELINE_LLM_MODEL ?? 'gemini-2.5-flash',
        prompt_version: promptVersion,
        prompt_content: promptContent,
      };

      // 1. Insert run row
      const run = await insertDatasetRun(datasetId, body.name, runConfig, body.description);

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
        actionNote: rc.action_note,
        pipelineRunId: rc.pipeline_run_id,
        pipelineError: rc.pipeline_error,
        pipelineRun: rc.pipeline_run ? formatPipelineRun(rc.pipeline_run) : null,
        datasetLabel: rc.dataset_label,
        datasetLabelNotes: rc.dataset_label_notes,
        datasetLabelConfidence: rc.dataset_label_confidence,
        datasetManualTags: rc.dataset_manual_tags,
        agreement: computeAgreement(rc.dataset_label, rc.pipeline_run),
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

  // PATCH /run-cases/:id/action-note — Save action note on run case
  app.patch<{ Params: { id: string } }>('/run-cases/:id/action-note', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    if (isNaN(id)) {
      return reply.status(400).send({ error: 'Invalid ID' });
    }
    const { actionNote } = request.body as { actionNote: string | null };
    const updated = await updateRunCaseActionNote(id, actionNote ?? null);
    if (!updated) {
      return reply.status(404).send({ error: 'Run case not found' });
    }
    return { success: true };
  });

  // POST /run-cases/:id/retry — Retry a failed run case
  app.post<{ Params: { id: string } }>('/run-cases/:id/retry', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    if (isNaN(id)) {
      return reply.status(400).send({ error: 'Invalid ID' });
    }

    const rc = await getRunCaseWithContext(id);
    if (!rc) {
      return reply.status(404).send({ error: 'Run case not found' });
    }

    // Build cached context from dataset_cases
    const cachedContexts = await getDatasetCaseContexts(rc.dataset_id);
    let cached: CaseContext | undefined;
    for (const dc of cachedContexts) {
      if (dc.case_id === rc.case_id && dc.raw_signals) {
        cached = {
          raw_signals: dc.raw_signals as CaseSignalsRaw,
          case_details: dc.case_details ?? null,
          case_actions: (dc.case_actions as CaseAction[] | null) ?? null,
          dialogue_messages: (dc.dialogue_messages as DialogueMessage[] | null) ?? null,
          file_parse_results: (dc.file_parse_results as string[] | null) ?? null,
          enrichment_metadata: (dc.enrichment_metadata as Record<string, unknown> | null) ?? null,
        };
        break;
      }
    }

    try {
      const pipelineRun = await runDisputePipeline(rc.case_id, rc.config, cached);
      await updateDatasetRunCaseResult(rc.id, pipelineRun.id);
      return { success: true, pipelineRunId: pipelineRun.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await updateDatasetRunCaseError(rc.id, message).catch(() => {});
      return reply.status(500).send({ error: message });
    }
  });

  // POST /runs/:runId/rerun — Re-execute pipeline for all cases in a run
  app.post<{ Params: { runId: string } }>('/runs/:runId/rerun', async (request, reply) => {
    const runId = parseInt(request.params.runId, 10);
    if (isNaN(runId)) {
      return reply.status(400).send({ error: 'Invalid run ID' });
    }

    const run = await getDatasetRun(runId);
    if (!run) {
      return reply.status(404).send({ error: 'Run not found' });
    }

    const runConfig = run.config;

    // Fetch cached contexts
    const cachedContexts = await getDatasetCaseContexts(run.dataset_id);
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

    const cases = await getDatasetRunCases(runId);
    await updateDatasetRunStatus(runId, 'running');

    let failedCount = 0;
    const tasks = cases.map((rc) => async () => {
      try {
        const cached = contextMap.get(rc.case_id);
        const pipelineRun = await runDisputePipeline(rc.case_id, runConfig, cached);
        await updateDatasetRunCaseResult(rc.id, pipelineRun.id);
      } catch (error) {
        failedCount++;
        const message = error instanceof Error ? error.message : String(error);
        app.log.error({ caseId: rc.case_id, runId, error }, 'Rerun pipeline failed for case');
        await updateDatasetRunCaseError(rc.id, message).catch(() => {});
      }
    });

    runWithConcurrency(tasks, 3)
      .then(async () => {
        const status = failedCount === cases.length ? 'failed' : 'completed';
        await updateDatasetRunStatus(runId, status, new Date());
      })
      .catch(async (error) => {
        app.log.error({ runId, error }, 'Rerun batch failed');
        await updateDatasetRunStatus(runId, 'failed').catch(() => {});
      });

    return { success: true, rerunning: cases.length };
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

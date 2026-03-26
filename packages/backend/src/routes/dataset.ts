import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPresets, runPresetQuery, runCustomSql } from '../services/dataset-segments.js';
import { runDisputePipeline } from '../services/dispute-pipeline.js';
import {
  insertDataset,
  listDatasets,
  getDataset,
  deleteDataset,
  insertDatasetCases,
  listDatasetCases,
  updateDatasetCaseLabel,
  updateDatasetCasePipelineRun,
  deleteDatasetCase,
  getPipelineRunsByIds,
} from '../services/db.js';
import type { PipelineRunRow, DatasetCaseRow } from '../types/dispute-pipeline.js';

const CreateDatasetSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  sourceType: z.enum(['preset', 'case_ids', 'custom_sql']),
  sourceConfig: z.record(z.unknown()),
});

const LabelSchema = z.object({
  label: z.enum(['credit', 'escalate', 'needs_more_info']),
  notes: z.string().nullable().optional(),
  labeledBy: z.string().nullable().optional(),
});

function formatPipelineRun(row: PipelineRunRow) {
  return {
    id: row.id,
    caseId: row.case_id,
    rawSignals: row.raw_signals,
    caseDetails: row.case_details,
    disputeProfile: row.dispute_profile,
    hardGates: row.hard_gates,
    hardGateTriggered: row.hard_gate_triggered,
    plannerOutput: row.planner_output,
    executorAction: row.executor_action,
    pipelineDurationMs: row.pipeline_duration_ms,
    promptVersion: row.prompt_version,
    plannerRawResponse: row.planner_raw_response,
    plannerRequest: row.planner_request,
    plannerSystemPrompt: row.planner_system_prompt,
    fileParseResults: row.file_parse_results,
    dialogueMessages: row.dialogue_messages,
    enrichmentMetadata: row.enrichment_metadata,
    caseActions: row.case_actions,
    reviewerVerdict: row.reviewer_verdict,
    reviewerNotes: row.reviewer_notes,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
  };
}

function formatDatasetCase(row: DatasetCaseRow, pipelineRun: PipelineRunRow | null) {
  return {
    id: row.id,
    datasetId: row.dataset_id,
    caseId: row.case_id,
    pipelineRunId: row.pipeline_run_id,
    pipelineRun: pipelineRun ? formatPipelineRun(pipelineRun) : null,
    label: row.label,
    labelNotes: row.label_notes,
    labeledBy: row.labeled_by,
    labeledAt: row.labeled_at,
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

export async function datasetRoutes(app: FastifyInstance) {
  // GET /presets — List available preset segment definitions
  app.get('/presets', async () => {
    return { data: getPresets() };
  });

  // GET / — List all datasets with labeled/total counts
  app.get('/', async () => {
    const datasets = await listDatasets();
    return {
      data: datasets.map((d) => ({
        id: d.id,
        name: d.name,
        description: d.description,
        sourceType: d.source_type,
        sourceConfig: d.source_config,
        totalCases: d.total_cases,
        labeledCases: d.labeled_cases,
        createdAt: d.created_at,
      })),
    };
  });

  // POST / — Create dataset + resolve case IDs + run pipeline for each
  app.post('/', async (request, reply) => {
    try {
      const body = CreateDatasetSchema.parse(request.body);

      // Resolve case IDs based on source type
      let caseIds: number[];
      try {
        if (body.sourceType === 'preset') {
          const presetKey = body.sourceConfig.preset_key;
          if (typeof presetKey !== 'string') {
            return reply.status(400).send({ error: 'source_config.preset_key must be a string' });
          }
          caseIds = await runPresetQuery(presetKey);
        } else if (body.sourceType === 'case_ids') {
          const ids = body.sourceConfig.ids;
          if (!Array.isArray(ids)) {
            return reply.status(400).send({ error: 'source_config.ids must be an array' });
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

      if (caseIds.length === 0) {
        return reply.status(400).send({ error: 'No case IDs resolved from source' });
      }

      // Insert dataset row
      const dataset = await insertDataset(
        body.name,
        body.description ?? null,
        body.sourceType,
        body.sourceConfig,
      );

      // Insert dataset_cases rows
      const datasetCases = await insertDatasetCases(dataset.id, caseIds);

      // Run pipelines in background with concurrency limit of 3
      const tasks = datasetCases.map((dc) => async () => {
        try {
          const pipelineRun = await runDisputePipeline(dc.case_id);
          await updateDatasetCasePipelineRun(dc.id, pipelineRun.id);
        } catch (error) {
          app.log.error(
            { caseId: dc.case_id, datasetId: dataset.id, error },
            'Pipeline run failed for dataset case',
          );
        }
      });

      // Fire and forget — frontend polls for completion
      runWithConcurrency(tasks, 3).catch((error) => {
        app.log.error({ datasetId: dataset.id, error }, 'Background pipeline batch failed');
      });

      return reply.status(201).send({
        id: dataset.id,
        name: dataset.name,
        description: dataset.description,
        sourceType: dataset.source_type,
        sourceConfig: dataset.source_config,
        totalCases: datasetCases.length,
        labeledCases: 0,
        createdAt: dataset.created_at,
        status: 'loading',
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ error: 'Validation error', details: error.errors });
      }
      throw error;
    }
  });

  // GET /:id — Get dataset with all cases and pipeline run data
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

    // Fetch pipeline runs for all cases that have one
    const runIds = cases.map((c) => c.pipeline_run_id).filter((rid): rid is number => rid !== null);
    const pipelineRuns = await getPipelineRunsByIds(runIds);
    const runMap = new Map(pipelineRuns.map((r) => [r.id, r]));

    const formattedCases = cases.map((c) => {
      const pipelineRun = c.pipeline_run_id ? (runMap.get(c.pipeline_run_id) ?? null) : null;
      return formatDatasetCase(c, pipelineRun);
    });

    return {
      id: dataset.id,
      name: dataset.name,
      description: dataset.description,
      sourceType: dataset.source_type,
      sourceConfig: dataset.source_config,
      createdAt: dataset.created_at,
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

  // PATCH /cases/:id/label — Save label, notes, labeled_by
  app.patch<{ Params: { id: string } }>('/cases/:id/label', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    if (isNaN(id)) {
      return reply.status(400).send({ error: 'Invalid ID' });
    }

    try {
      const body = LabelSchema.parse(request.body);
      const row = await updateDatasetCaseLabel(id, body.label, body.notes ?? null, body.labeledBy ?? null);
      if (!row) {
        return reply.status(404).send({ error: 'Dataset case not found' });
      }
      return formatDatasetCase(row, null);
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
}

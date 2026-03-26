import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runCustomSql } from '../services/dataset-segments.js';
import { runDisputePipeline } from '../services/dispute-pipeline.js';
import {
  insertDatasetWithCases,
  listDatasets,
  getDataset,
  deleteDataset,
  listDatasetCases,
  updateDatasetCaseLabel,
  updateDatasetCasePipelineRun,
  updateDatasetCasePipelineError,
  deleteDatasetCase,
  datasetCaseExists,
  getPipelineRunsByIds,
} from '../services/db.js';
import { formatPipelineRun } from '../types/dispute-pipeline.js';
import type { PipelineRunRow, DatasetCaseRow, DatasetRow } from '../types/dispute-pipeline.js';
import { DEFAULT_RUBRIC_WEIGHTS } from '../services/dispute-pipeline.js';
import { listPrompts } from '../services/prompts.js';

const CreateDatasetSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  sourceType: z.enum(['case_ids', 'custom_sql']),
  sourceConfig: z.record(z.unknown()),
});

const LabelSchema = z.object({
  label: z.enum(['credit', 'escalate', 'needs_more_info']),
  notes: z.string().nullable().optional(),
  labeledBy: z.string().nullable().optional(),
});

function formatDataset(d: DatasetRow & { total_cases?: number; labeled_cases?: number }) {
  return {
    id: d.id,
    name: d.name,
    description: d.description,
    sourceType: d.source_type,
    sourceConfig: d.source_config,
    createdAt: d.created_at,
    ...(d.total_cases !== undefined ? { totalCases: d.total_cases } : {}),
    ...(d.labeled_cases !== undefined ? { labeledCases: d.labeled_cases } : {}),
  };
}

function formatDatasetCase(row: DatasetCaseRow, pipelineRun: PipelineRunRow | null) {
  return {
    id: row.id,
    datasetId: row.dataset_id,
    caseId: row.case_id,
    pipelineRunId: row.pipeline_run_id,
    pipelineError: row.pipeline_error,
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

      // Run pipelines in background with concurrency limit of 3
      const tasks = datasetCases.map((dc) => async () => {
        try {
          // Skip if dataset case was deleted while queued
          const exists = await datasetCaseExists(dc.id);
          if (!exists) return;

          const pipelineRun = await runDisputePipeline(dc.case_id);
          await updateDatasetCasePipelineRun(dc.id, pipelineRun.id);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          app.log.error(
            { caseId: dc.case_id, datasetId: dataset.id, error },
            'Pipeline run failed for dataset case',
          );
          // Mark the case as failed so frontend stops polling
          await updateDatasetCasePipelineError(dc.id, message).catch(() => {});
        }
      });

      // Fire and forget — frontend polls for completion
      runWithConcurrency(tasks, 3).catch((error) => {
        app.log.error({ datasetId: dataset.id, error }, 'Background pipeline batch failed');
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

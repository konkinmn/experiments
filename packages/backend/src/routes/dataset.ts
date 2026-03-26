import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SEGMENTS, fetchSegmentCaseIds } from '../services/dataset-segments.js';
import { runDisputePipeline } from '../services/dispute-pipeline.js';
import {
  insertDatasetCase,
  listDatasetCases,
  updateDatasetLabel,
  deleteDatasetCase,
  getDatasetSegmentCounts,
  getExistingDatasetCaseIds,
  getPipelineRunsByIds,
} from '../services/db.js';
import type { PipelineRunRow, DatasetCaseRow } from '../types/dispute-pipeline.js';

const LabelSchema = z.object({
  label: z.enum(['credit', 'escalate', 'needs_more_info']),
  notes: z.string().nullable().optional(),
  labeledBy: z.string().nullable().optional(),
});

function formatDatasetCase(row: DatasetCaseRow, pipelineRun: PipelineRunRow | null) {
  return {
    id: row.id,
    caseId: row.case_id,
    segment: row.segment,
    pipelineRunId: row.pipeline_run_id,
    pipelineRun: pipelineRun ? formatPipelineRun(pipelineRun) : null,
    label: row.label,
    labelNotes: row.label_notes,
    labeledBy: row.labeled_by,
    labeledAt: row.labeled_at,
    createdAt: row.created_at,
  };
}

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
  // GET /segments — List all segments with counts
  app.get('/segments', async () => {
    const counts = await getDatasetSegmentCounts();
    const countMap = new Map(counts.map((c) => [c.segment, c]));

    const segments = SEGMENTS.map((s) => ({
      key: s.key,
      label: s.label,
      description: s.description,
      totalCount: (countMap.get(s.key)?.total_count ?? 0),
      labeledCount: (countMap.get(s.key)?.labeled_count ?? 0),
    }));

    return { data: segments };
  });

  // POST /segments/:segment/load — Fetch case IDs and run pipeline for each
  app.post<{ Params: { segment: string } }>(
    '/segments/:segment/load',
    async (request, reply) => {
      const { segment } = request.params;
      const segmentDef = SEGMENTS.find((s) => s.key === segment);
      if (!segmentDef) {
        return reply.status(400).send({ error: `Unknown segment: ${segment}` });
      }

      try {
        // Fetch case IDs from BigQuery
        const caseIds = await fetchSegmentCaseIds(segment);
        if (caseIds.length === 0) {
          return { data: [], loaded: 0, skipped: 0 };
        }

        // Skip already-existing cases
        const existing = await getExistingDatasetCaseIds(caseIds);
        const newCaseIds = caseIds.filter((id) => !existing.has(id));

        if (newCaseIds.length === 0) {
          return { data: [], loaded: 0, skipped: caseIds.length };
        }

        // Run pipelines with concurrency limit of 3
        const tasks = newCaseIds.map((caseId) => async () => {
          try {
            const pipelineRun = await runDisputePipeline(caseId);
            const datasetCase = await insertDatasetCase(caseId, segment, pipelineRun.id);
            return { success: true as const, case: formatDatasetCase(datasetCase, pipelineRun) };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { success: false as const, caseId, error: message };
          }
        });

        const results = await runWithConcurrency(tasks, 3);

        return {
          data: results,
          loaded: results.filter((r) => r.success).length,
          skipped: existing.size,
        };
      } catch (error) {
        if (error instanceof Error && (error.message.includes('BigQuery') || error.message.includes('query'))) {
          return reply.status(502).send({ error: `Data fetch error: ${error.message}` });
        }
        throw error;
      }
    },
  );

  // GET /cases — List all dataset cases with pipeline run data
  app.get<{ Querystring: { segment?: string } }>('/cases', async (request) => {
    const segment = request.query.segment || undefined;
    const cases = await listDatasetCases(segment);

    // Fetch only the pipeline runs referenced by these dataset cases
    const runIds = cases.map((c) => c.pipeline_run_id).filter((id): id is number => id !== null);
    const pipelineRuns = await getPipelineRunsByIds(runIds);
    const runMap = new Map(pipelineRuns.map((r) => [r.id, r]));

    const data = cases.map((c) => {
      const pipelineRun = c.pipeline_run_id ? (runMap.get(c.pipeline_run_id) ?? null) : null;
      return formatDatasetCase(c, pipelineRun);
    });

    return { data };
  });

  // PATCH /cases/:id/label — Save label for a case
  app.patch<{ Params: { id: string } }>('/cases/:id/label', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    if (isNaN(id)) {
      return reply.status(400).send({ error: 'Invalid ID' });
    }

    try {
      const body = LabelSchema.parse(request.body);
      const row = await updateDatasetLabel(id, body.label, body.notes ?? null, body.labeledBy ?? null);
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

  // DELETE /cases/:id — Remove a case from the dataset
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

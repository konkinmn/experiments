import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runDisputePipeline } from '../services/dispute-pipeline.js';
import { listPipelineRuns, updatePipelineReview, deletePipelineRun } from '../services/db.js';
import type { PipelineRunRow } from '../types/dispute-pipeline.js';

const RunSchema = z.object({
  caseId: z.number().int().positive(),
});

const ReviewSchema = z.object({
  verdict: z.enum(['correct', 'incorrect']),
  notes: z.string().nullable().optional(),
});

function formatRow(row: PipelineRunRow) {
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
    evidenceArtifacts: row.evidence_artifacts,
    caseActions: row.case_actions,
    reviewerVerdict: row.reviewer_verdict,
    reviewerNotes: row.reviewer_notes,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
  };
}

export async function disputePipelineRoutes(app: FastifyInstance) {
  // POST /run — Run pipeline for a single case
  app.post('/run', async (request, reply) => {
    try {
      const body = RunSchema.parse(request.body);
      const row = await runDisputePipeline(body.caseId);
      return formatRow(row);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ error: 'Validation error', details: error.errors });
      }
      if (error instanceof Error) {
        if (error.message.includes('not found')) {
          return reply.status(404).send({ error: error.message });
        }
        if (error.message.includes('BigQuery') || error.message.includes('query')) {
          return reply.status(502).send({ error: `Data fetch error: ${error.message}` });
        }
        if (error.message.includes('LLM') || error.message.includes('Prompt')) {
          return reply.status(502).send({ error: `Planner error: ${error.message}` });
        }
      }
      throw error;
    }
  });

  // GET /results — List all pipeline runs
  app.get('/results', async () => {
    const rows = await listPipelineRuns();
    return { data: rows.map(formatRow) };
  });

  // PATCH /results/:id/review — Submit reviewer verdict
  app.patch<{ Params: { id: string } }>('/results/:id/review', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    if (isNaN(id)) {
      return reply.status(400).send({ error: 'Invalid ID' });
    }

    try {
      const body = ReviewSchema.parse(request.body);
      const row = await updatePipelineReview(id, body.verdict, body.notes ?? null);
      if (!row) {
        return reply.status(404).send({ error: 'Pipeline run not found' });
      }
      return formatRow(row);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ error: 'Validation error', details: error.errors });
      }
      throw error;
    }
  });

  // DELETE /results/:id — Delete a pipeline run
  app.delete<{ Params: { id: string } }>('/results/:id', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    if (isNaN(id)) {
      return reply.status(400).send({ error: 'Invalid ID' });
    }
    const count = await deletePipelineRun(id);
    if (count === 0) {
      return reply.status(404).send({ error: 'Pipeline run not found' });
    }
    return { success: true };
  });
}

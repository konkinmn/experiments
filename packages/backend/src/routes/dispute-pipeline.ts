import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runDisputePipeline } from '../services/dispute-pipeline.js';
import { listPipelineRuns, updatePipelineReview, deletePipelineRun } from '../services/db.js';
import { formatPipelineRun } from '../types/dispute-pipeline.js';

const RunSchema = z.object({
  caseId: z.number().int().positive(),
});

const ReviewSchema = z.object({
  verdict: z.enum(['correct', 'incorrect']),
  notes: z.string().nullable().optional(),
});

export async function disputePipelineRoutes(app: FastifyInstance) {
  // POST /run — Run pipeline for a single case
  app.post('/run', async (request, reply) => {
    try {
      const body = RunSchema.parse(request.body);
      const row = await runDisputePipeline(body.caseId);
      return formatPipelineRun(row);
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
    return { data: rows.map(formatPipelineRun) };
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
      return formatPipelineRun(row);
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
    try {
      const count = await deletePipelineRun(id);
      if (count === 0) {
        return reply.status(404).send({ error: 'Pipeline run not found' });
      }
      return { success: true };
    } catch (error) {
      if (error instanceof Error && error.message.includes('violates foreign key constraint')) {
        return reply.status(409).send({
          error: 'Cannot delete: this pipeline run is referenced by a dataset case',
        });
      }
      throw error;
    }
  });
}

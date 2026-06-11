import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { getPromptsList, getPromptById } from "../services/prompts.js";
import {
  fetchCaseTimeline,
  fetchCaseDetails,
  fetchFilteredCaseIds,
  type CaseTimeline,
  type CaseDetails,
} from "../services/case-api.js";
import { analyzeWithLLM } from "../services/llm-api.js";
import { buildPhaseMessages, parseAnalysisJson } from "../services/dispute-phase.js";
import {
  insertJob,
  updateJob,
  getJob,
  listJobs,
  deleteJob,
  type AnalysisJobRow,
} from "../services/db.js";

// Types for API responses
interface AnalysisResult {
  caseId: number;
  analysis: unknown;
  error: string | null;
}

interface AnalysisJob {
  id: string;
  status: "running" | "completed" | "error";
  progress: {
    current: number;
    total: number;
    currentCaseId: number | null;
  };
  results: AnalysisResult[];
  error: string | null;
  createdAt: string;
}

// Helper to convert DB row to API response
function rowToJob(row: AnalysisJobRow): AnalysisJob {
  return {
    id: row.id,
    status: row.status,
    progress: {
      current: row.progress_current,
      total: row.progress_total,
      currentCaseId: row.progress_current_case_id,
    },
    results: row.results as AnalysisResult[],
    error: row.error,
    createdAt: row.created_at,
  };
}

// Request schemas
const StartAnalysisSchema = z.object({
  promptId: z.string(),
  caseIds: z.array(z.number().int().positive()),
});

const statusEnum = z.enum(["IN_PROGRESS", "RESOLVED", "DISMISSED"]);

const CasesQuerySchema = z.object({
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD format"),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD format"),
  issueType: z.string().optional(),
  statuses: z
    .string()
    .optional()
    .transform((val) =>
      val ? val.split(",").map((s) => statusEnum.parse(s.trim())) : undefined,
    ),
});

async function processJob(jobId: string, promptId: string, caseIds: number[]) {
  try {
    // Load prompt
    const prompt = await getPromptById(promptId);
    if (!prompt) {
      await updateJob(jobId, {
        status: "error",
        error: `Prompt not found: ${promptId}`,
      });
      return;
    }

    const results: AnalysisResult[] = [];

    // Process each case
    for (let i = 0; i < caseIds.length; i++) {
      const caseId = caseIds[i];

      // Update progress in DB
      await updateJob(jobId, {
        progress_current: i,
        progress_current_case_id: caseId,
      });

      try {
        // Fetch timeline and case details in parallel
        const [timeline, caseDetails]: [CaseTimeline, CaseDetails] =
          await Promise.all([
            fetchCaseTimeline(caseId),
            fetchCaseDetails(caseId),
          ]);

        const messages = buildPhaseMessages(caseDetails, timeline, prompt.content);
        const response = await analyzeWithLLM(messages);
        const analysis = parseAnalysisJson(response.content);

        results.push({
          caseId,
          analysis,
          error: null,
        });
      } catch (error) {
        results.push({
          caseId,
          analysis: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Update results in DB after each case
      await updateJob(jobId, { results });
    }

    // Mark as completed
    await updateJob(jobId, {
      progress_current: caseIds.length,
      progress_current_case_id: null,
      status: "completed",
      results,
    });
  } catch (error) {
    await updateJob(jobId, {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function timelineAnalyzerRoutes(app: FastifyInstance) {
  // GET /prompts - List available prompts
  app.get("/prompts", async () => {
    const prompts = await getPromptsList();
    return { data: prompts };
  });

  // GET /jobs - List all jobs
  app.get("/jobs", async () => {
    const rows = await listJobs();

    const jobsList = rows.map((row) => ({
      id: row.id,
      status: row.status,
      progress: {
        current: row.progress_current,
        total: row.progress_total,
        currentCaseId: row.progress_current_case_id,
      },
      createdAt: row.created_at,
      resultCount: (row.results as unknown[])?.length || 0,
      errorCount:
        (row.results as AnalysisResult[])?.filter((r) => r.error !== null)
          .length || 0,
    }));

    return { data: jobsList };
  });

  // GET /cases - Get case IDs matching filters (uses WS API)
  app.get("/cases", async (request, reply) => {
    try {
      const query = CasesQuerySchema.parse(request.query);

      let caseIds: number[];

      if (query.statuses && query.statuses.length > 0) {
        const results = await Promise.all(
          query.statuses.map((status) =>
            fetchFilteredCaseIds({
              issueTypeId: query.issueType,
              status,
              createdAtFrom: query.startDate,
              createdAtTo: query.endDate,
            }),
          ),
        );
        caseIds = [...new Set(results.flat())];
      } else {
        caseIds = await fetchFilteredCaseIds({
          issueTypeId: query.issueType,
          createdAtFrom: query.startDate,
          createdAtTo: query.endDate,
        });
      }

      return { caseIds, count: caseIds.length };
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({
          error: "Validation error",
          details: error.errors,
        });
      }
      throw error;
    }
  });

  // POST /start - Start an analysis job
  app.post("/start", async (request, reply) => {
    try {
      const body = StartAnalysisSchema.parse(request.body);

      // Validate prompt exists
      const prompt = await getPromptById(body.promptId);
      if (!prompt) {
        return reply.status(400).send({
          error: "Invalid prompt",
          message: `Prompt not found: ${body.promptId}`,
        });
      }

      // Create job in DB
      const jobId = randomUUID();

      await insertJob({
        id: jobId,
        status: "running",
        progress_current: 0,
        progress_total: body.caseIds.length,
        progress_current_case_id: null,
        results: [],
        error: null,
      });

      // Start async processing (don't await)
      processJob(jobId, body.promptId, body.caseIds);

      return { jobId };
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({
          error: "Validation error",
          details: error.errors,
        });
      }
      throw error;
    }
  });

  // GET /status/:jobId - Get job status and results
  app.get<{ Params: { jobId: string } }>(
    "/status/:jobId",
    async (request, reply) => {
      const { jobId } = request.params;

      const data = await getJob(jobId);

      if (!data) {
        return reply.status(404).send({
          error: "Job not found",
          message: `No job found with ID: ${jobId}`,
        });
      }

      const job = rowToJob(data);

      return {
        id: job.id,
        status: job.status,
        progress: job.progress,
        results: job.results,
        error: job.error,
      };
    },
  );

  // DELETE /status/:jobId - Cancel/delete a job
  app.delete<{ Params: { jobId: string } }>(
    "/status/:jobId",
    async (request, reply) => {
      const { jobId } = request.params;

      const count = await deleteJob(jobId);

      if (count === 0) {
        return reply.status(404).send({
          error: "Job not found",
          message: `No job found with ID: ${jobId}`,
        });
      }

      return { success: true };
    },
  );
}

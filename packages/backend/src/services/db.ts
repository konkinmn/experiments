import pg from 'pg';

const { Pool } = pg;

export interface AnalysisJobRow {
  id: string;
  status: 'running' | 'completed' | 'error';
  progress_current: number;
  progress_total: number;
  progress_current_case_id: number | null;
  results: unknown[];
  error: string | null;
  created_at: string;
}

export interface AnalysisJobInsert {
  id: string;
  status: 'running' | 'completed' | 'error';
  progress_current: number;
  progress_total: number;
  progress_current_case_id?: number | null;
  results?: unknown[];
  error?: string | null;
}

export interface AnalysisJobUpdate {
  status?: 'running' | 'completed' | 'error';
  progress_current?: number;
  progress_total?: number;
  progress_current_case_id?: number | null;
  results?: unknown[];
  error?: string | null;
}

// Lazy singleton pool
let _pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!_pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL must be set');
    }
    _pool = new Pool({ connectionString });
  }
  return _pool;
}

export async function insertJob(job: AnalysisJobInsert): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO analysis_jobs (id, status, progress_current, progress_total, progress_current_case_id, results, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      job.id,
      job.status,
      job.progress_current,
      job.progress_total,
      job.progress_current_case_id ?? null,
      JSON.stringify(job.results ?? []),
      job.error ?? null,
    ],
  );
}

export async function updateJob(id: string, update: AnalysisJobUpdate): Promise<void> {
  const pool = getPool();
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (update.status !== undefined) {
    setClauses.push(`status = $${idx++}`);
    values.push(update.status);
  }
  if (update.progress_current !== undefined) {
    setClauses.push(`progress_current = $${idx++}`);
    values.push(update.progress_current);
  }
  if (update.progress_total !== undefined) {
    setClauses.push(`progress_total = $${idx++}`);
    values.push(update.progress_total);
  }
  if (update.progress_current_case_id !== undefined) {
    setClauses.push(`progress_current_case_id = $${idx++}`);
    values.push(update.progress_current_case_id);
  }
  if (update.results !== undefined) {
    setClauses.push(`results = $${idx++}`);
    values.push(JSON.stringify(update.results));
  }
  if (update.error !== undefined) {
    setClauses.push(`error = $${idx++}`);
    values.push(update.error);
  }

  if (setClauses.length === 0) return;

  values.push(id);
  await pool.query(
    `UPDATE analysis_jobs SET ${setClauses.join(', ')} WHERE id = $${idx}`,
    values,
  );
}

export async function getJob(id: string): Promise<AnalysisJobRow | null> {
  const pool = getPool();
  const { rows } = await pool.query<AnalysisJobRow>(
    'SELECT * FROM analysis_jobs WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

export async function listJobs(): Promise<AnalysisJobRow[]> {
  const pool = getPool();
  const { rows } = await pool.query<AnalysisJobRow>(
    'SELECT * FROM analysis_jobs ORDER BY created_at DESC',
  );
  return rows;
}

export async function deleteJob(id: string): Promise<number> {
  const pool = getPool();
  const result = await pool.query('DELETE FROM analysis_jobs WHERE id = $1', [id]);
  return result.rowCount ?? 0;
}

// --- Dispute Pipeline Runs ---

import type { PipelineRunRow, PipelineRunInsert } from '../types/dispute-pipeline.js';

export type { PipelineRunRow };

export async function insertPipelineRun(row: PipelineRunInsert): Promise<PipelineRunRow> {
  const pool = getPool();
  const { rows } = await pool.query<PipelineRunRow>(
    `INSERT INTO dispute_pipeline_runs
       (case_id, raw_signals, case_details, dispute_profile, hard_gates, hard_gate_triggered,
        planner_output, executor_action, pipeline_duration_ms, prompt_version, planner_raw_response)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      row.case_id,
      JSON.stringify(row.raw_signals),
      row.case_details ? JSON.stringify(row.case_details) : null,
      JSON.stringify(row.dispute_profile),
      JSON.stringify(row.hard_gates),
      row.hard_gate_triggered,
      row.planner_output ? JSON.stringify(row.planner_output) : null,
      row.executor_action,
      row.pipeline_duration_ms,
      row.prompt_version,
      row.planner_raw_response,
    ],
  );
  if (!rows[0]) throw new Error('Insert did not return a row');
  return rows[0];
}

export async function listPipelineRuns(): Promise<PipelineRunRow[]> {
  const pool = getPool();
  const { rows } = await pool.query<PipelineRunRow>(
    'SELECT * FROM dispute_pipeline_runs ORDER BY created_at DESC LIMIT 100',
  );
  return rows;
}

export async function updatePipelineReview(
  id: number,
  verdict: string,
  notes: string | null,
): Promise<PipelineRunRow | null> {
  const pool = getPool();
  const { rows } = await pool.query<PipelineRunRow>(
    `UPDATE dispute_pipeline_runs
     SET reviewer_verdict = $1, reviewer_notes = $2, reviewed_at = now()
     WHERE id = $3
     RETURNING *`,
    [verdict, notes, id],
  );
  return rows[0] ?? null;
}

export async function deletePipelineRun(id: number): Promise<number> {
  const pool = getPool();
  const result = await pool.query('DELETE FROM dispute_pipeline_runs WHERE id = $1', [id]);
  return result.rowCount ?? 0;
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

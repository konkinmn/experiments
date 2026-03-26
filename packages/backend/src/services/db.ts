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
let _migrationsApplied = false;
let _migrationsPromise: Promise<void> | null = null;

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

/**
 * Apply runtime migrations that may not have run via docker-entrypoint-initdb.d
 * (e.g. when the database volume already existed before a migration was added).
 * All statements must be idempotent.
 *
 * Uses information_schema to check column existence first (SELECT-only), so the
 * common case (column already exists) never requires DDL/ALTER privileges.
 * A promise lock prevents concurrent first calls from issuing redundant DDL.
 */
async function ensureMigrations(): Promise<void> {
  if (_migrationsApplied) return;
  if (_migrationsPromise) return _migrationsPromise;
  _migrationsPromise = applyMigrations();
  return _migrationsPromise;
}

async function applyMigrations(): Promise<void> {
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'dispute_pipeline_runs' AND column_name = 'planner_raw_response'`,
    );
    if (rows.length === 0) {
      await pool.query(
        `ALTER TABLE dispute_pipeline_runs ADD COLUMN IF NOT EXISTS planner_raw_response TEXT`,
      );
    }
    const { rows: caseActionsRows } = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'dispute_pipeline_runs' AND column_name = 'case_actions'`,
    );
    if (caseActionsRows.length === 0) {
      await pool.query(
        `ALTER TABLE dispute_pipeline_runs ADD COLUMN IF NOT EXISTS case_actions JSONB DEFAULT NULL`,
      );
    }
    // Migration 005: enrichment columns
    const enrichmentCols = [
      { name: 'planner_request', type: 'JSONB DEFAULT NULL' },
      { name: 'planner_system_prompt', type: 'TEXT DEFAULT NULL' },
      { name: 'file_parse_results', type: 'JSONB DEFAULT NULL' },
      { name: 'dialogue_messages', type: 'JSONB DEFAULT NULL' },
      { name: 'enrichment_metadata', type: 'JSONB DEFAULT NULL' },
    ];
    for (const col of enrichmentCols) {
      const { rows: colRows } = await pool.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_name = 'dispute_pipeline_runs' AND column_name = $1`,
        [col.name],
      );
      if (colRows.length === 0) {
        await pool.query(
          `ALTER TABLE dispute_pipeline_runs ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`,
        );
      }
    }
    // Migration 006: dataset_cases table
    const { rows: datasetTableRows } = await pool.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_name = 'dataset_cases'`,
    );
    if (datasetTableRows.length === 0) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS dataset_cases (
          id SERIAL PRIMARY KEY,
          case_id INTEGER NOT NULL,
          dataset_id INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
          pipeline_run_id INTEGER REFERENCES dispute_pipeline_runs(id),
          label TEXT CHECK (label IN ('credit', 'escalate', 'needs_more_info')),
          label_notes TEXT,
          labeled_by TEXT,
          labeled_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE(dataset_id, case_id)
        )
      `);
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_dataset_cases_dataset_id ON dataset_cases(dataset_id)`,
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_dataset_cases_label ON dataset_cases(label)`,
      );
    }

    // Migration 007: datasets parent table + migrate dataset_cases
    const { rows: datasetsTableRows } = await pool.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_name = 'datasets'`,
    );
    if (datasetsTableRows.length === 0) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS datasets (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          source_type TEXT NOT NULL CHECK (source_type IN ('preset', 'case_ids', 'custom_sql')),
          source_config JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
    }
    // Migrate dataset_cases if it still has old segment column
    const { rows: segmentColRows } = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'dataset_cases' AND column_name = 'segment'`,
    );
    if (segmentColRows.length > 0) {
      await pool.query(`DELETE FROM dataset_cases`);
      await pool.query(`ALTER TABLE dataset_cases DROP COLUMN IF EXISTS segment`);
      await pool.query(`DROP INDEX IF EXISTS idx_dataset_cases_segment`);
      await pool.query(`ALTER TABLE dataset_cases ADD COLUMN IF NOT EXISTS dataset_id INTEGER REFERENCES datasets(id) ON DELETE CASCADE`);
      await pool.query(`ALTER TABLE dataset_cases ALTER COLUMN dataset_id SET NOT NULL`);
      await pool.query(`ALTER TABLE dataset_cases DROP CONSTRAINT IF EXISTS dataset_cases_case_id_key`);
      await pool.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'dataset_cases_dataset_id_case_id_key'
          ) THEN
            ALTER TABLE dataset_cases ADD CONSTRAINT dataset_cases_dataset_id_case_id_key UNIQUE(dataset_id, case_id);
          END IF;
        END $$
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_dataset_cases_dataset_id ON dataset_cases(dataset_id)`);
    }
    _migrationsApplied = true;
  } catch (e) {
    _migrationsPromise = null;
    throw e;
  }
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

import type { PipelineRunRow, PipelineRunInsert, DatasetCaseRow, DatasetLabel } from '../types/dispute-pipeline.js';

export type { PipelineRunRow };

export async function insertPipelineRun(row: PipelineRunInsert): Promise<PipelineRunRow> {
  await ensureMigrations();
  const pool = getPool();
  const { rows } = await pool.query<PipelineRunRow>(
    `INSERT INTO dispute_pipeline_runs
       (case_id, raw_signals, case_details, dispute_profile, hard_gates, hard_gate_triggered,
        planner_output, executor_action, pipeline_duration_ms, prompt_version, planner_raw_response,
        case_actions, planner_request, planner_system_prompt, file_parse_results,
        dialogue_messages, enrichment_metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
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
      row.case_actions ? JSON.stringify(row.case_actions) : null,
      row.planner_request ? JSON.stringify(row.planner_request) : null,
      row.planner_system_prompt,
      row.file_parse_results ? JSON.stringify(row.file_parse_results) : null,
      row.dialogue_messages ? JSON.stringify(row.dialogue_messages) : null,
      row.enrichment_metadata ? JSON.stringify(row.enrichment_metadata) : null,
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

export async function getPipelineRunsByIds(ids: number[]): Promise<PipelineRunRow[]> {
  if (ids.length === 0) return [];
  const pool = getPool();
  const { rows } = await pool.query<PipelineRunRow>(
    'SELECT * FROM dispute_pipeline_runs WHERE id = ANY($1)',
    [ids],
  );
  return rows;
}

export async function deletePipelineRun(id: number): Promise<number> {
  const pool = getPool();
  const result = await pool.query('DELETE FROM dispute_pipeline_runs WHERE id = $1', [id]);
  return result.rowCount ?? 0;
}

// --- Dataset Cases ---

export async function insertDatasetCase(
  caseId: number,
  segment: string,
  pipelineRunId: number | null,
): Promise<DatasetCaseRow> {
  await ensureMigrations();
  const pool = getPool();
  const { rows } = await pool.query<DatasetCaseRow>(
    `INSERT INTO dataset_cases (case_id, segment, pipeline_run_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (case_id) DO NOTHING
     RETURNING *`,
    [caseId, segment, pipelineRunId],
  );
  // If ON CONFLICT hit, return the existing row
  if (!rows[0]) {
    const { rows: existing } = await pool.query<DatasetCaseRow>(
      `SELECT * FROM dataset_cases WHERE case_id = $1`,
      [caseId],
    );
    return existing[0]!;
  }
  return rows[0];
}

export async function listDatasetCases(segment?: string): Promise<DatasetCaseRow[]> {
  await ensureMigrations();
  const pool = getPool();
  if (segment) {
    const { rows } = await pool.query<DatasetCaseRow>(
      `SELECT * FROM dataset_cases WHERE segment = $1 ORDER BY created_at DESC`,
      [segment],
    );
    return rows;
  }
  const { rows } = await pool.query<DatasetCaseRow>(
    `SELECT * FROM dataset_cases ORDER BY created_at DESC`,
  );
  return rows;
}

export async function updateDatasetLabel(
  id: number,
  label: DatasetLabel,
  notes: string | null,
  labeledBy: string | null,
): Promise<DatasetCaseRow | null> {
  await ensureMigrations();
  const pool = getPool();
  const { rows } = await pool.query<DatasetCaseRow>(
    `UPDATE dataset_cases
     SET label = $1, label_notes = $2, labeled_by = $3, labeled_at = now()
     WHERE id = $4
     RETURNING *`,
    [label, notes, labeledBy, id],
  );
  return rows[0] ?? null;
}

export async function deleteDatasetCase(id: number): Promise<number> {
  await ensureMigrations();
  const pool = getPool();
  const result = await pool.query('DELETE FROM dataset_cases WHERE id = $1', [id]);
  return result.rowCount ?? 0;
}

export async function getDatasetSegmentCounts(): Promise<
  Array<{ segment: string; total_count: number; labeled_count: number }>
> {
  await ensureMigrations();
  const pool = getPool();
  const { rows } = await pool.query<{
    segment: string;
    total_count: string;
    labeled_count: string;
  }>(
    `SELECT segment,
            COUNT(*)::text AS total_count,
            COUNT(label)::text AS labeled_count
     FROM dataset_cases
     GROUP BY segment`,
  );
  return rows.map((r) => ({
    segment: r.segment,
    total_count: parseInt(r.total_count, 10),
    labeled_count: parseInt(r.labeled_count, 10),
  }));
}

export async function getExistingDatasetCaseIds(caseIds: number[]): Promise<Set<number>> {
  if (caseIds.length === 0) return new Set();
  await ensureMigrations();
  const pool = getPool();
  const { rows } = await pool.query<{ case_id: number }>(
    `SELECT case_id FROM dataset_cases WHERE case_id = ANY($1)`,
    [caseIds],
  );
  return new Set(rows.map((r) => r.case_id));
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

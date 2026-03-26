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
    // Migration 007: datasets parent table (must be created before dataset_cases references it)
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
          source_type TEXT NOT NULL CHECK (source_type IN ('case_ids', 'custom_sql')),
          source_config JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
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

    // Migration: add pipeline_error column to dataset_cases
    const { rows: pipelineErrorCol } = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'dataset_cases' AND column_name = 'pipeline_error'`,
    );
    if (pipelineErrorCol.length === 0) {
      await pool.query(
        `ALTER TABLE dataset_cases ADD COLUMN IF NOT EXISTS pipeline_error TEXT DEFAULT NULL`,
      );
    }

    // Migration 008: dataset_runs and dataset_run_cases tables
    const { rows: datasetRunsTableRows } = await pool.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_name = 'dataset_runs'`,
    );
    if (datasetRunsTableRows.length === 0) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS dataset_runs (
          id SERIAL PRIMARY KEY,
          dataset_id INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          config JSONB NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'running', 'completed', 'failed')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          completed_at TIMESTAMPTZ
        )
      `);
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_dataset_runs_dataset_id ON dataset_runs(dataset_id)`,
      );
    }

    const { rows: runCasesTableRows } = await pool.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_name = 'dataset_run_cases'`,
    );
    if (runCasesTableRows.length === 0) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS dataset_run_cases (
          id SERIAL PRIMARY KEY,
          run_id INTEGER NOT NULL REFERENCES dataset_runs(id) ON DELETE CASCADE,
          dataset_case_id INTEGER NOT NULL REFERENCES dataset_cases(id) ON DELETE CASCADE,
          pipeline_run_id INTEGER REFERENCES dispute_pipeline_runs(id),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE(run_id, dataset_case_id)
        )
      `);
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_dataset_run_cases_run_id ON dataset_run_cases(run_id)`,
      );
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

import type {
  PipelineRunRow,
  PipelineRunInsert,
  DatasetRow,
  DatasetWithCounts,
  DatasetCaseRow,
  DatasetLabel,
  DatasetSourceType,
} from '../types/dispute-pipeline.js';

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

// --- Datasets ---

export async function insertDataset(
  name: string,
  description: string | null,
  sourceType: DatasetSourceType,
  sourceConfig: Record<string, unknown>,
): Promise<DatasetRow> {
  await ensureMigrations();
  const pool = getPool();
  const { rows } = await pool.query<DatasetRow>(
    `INSERT INTO datasets (name, description, source_type, source_config)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [name, description, sourceType, JSON.stringify(sourceConfig)],
  );
  if (!rows[0]) throw new Error('Insert did not return a row');
  return rows[0];
}

/**
 * Insert dataset and its cases in a single transaction.
 * If case insertion fails, the dataset row is also rolled back.
 */
export async function insertDatasetWithCases(
  name: string,
  description: string | null,
  sourceType: DatasetSourceType,
  sourceConfig: Record<string, unknown>,
  caseIds: number[],
): Promise<{ dataset: DatasetRow; cases: DatasetCaseRow[] }> {
  await ensureMigrations();
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: datasetRows } = await client.query<DatasetRow>(
      `INSERT INTO datasets (name, description, source_type, source_config)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name, description, sourceType, JSON.stringify(sourceConfig)],
    );
    if (!datasetRows[0]) throw new Error('Insert did not return a row');
    const dataset = datasetRows[0];

    const allCaseRows: DatasetCaseRow[] = [];
    const BATCH_SIZE = 500;
    for (let start = 0; start < caseIds.length; start += BATCH_SIZE) {
      const batch = caseIds.slice(start, start + BATCH_SIZE);
      const values: unknown[] = [];
      const placeholders: string[] = [];
      let idx = 1;
      for (const caseId of batch) {
        placeholders.push(`($${idx++}, $${idx++})`);
        values.push(dataset.id, caseId);
      }
      const { rows } = await client.query<DatasetCaseRow>(
        `INSERT INTO dataset_cases (dataset_id, case_id)
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (dataset_id, case_id) DO NOTHING
         RETURNING *`,
        values,
      );
      allCaseRows.push(...rows);
    }

    await client.query('COMMIT');
    return { dataset, cases: allCaseRows };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function listDatasets(): Promise<DatasetWithCounts[]> {
  await ensureMigrations();
  const pool = getPool();
  const { rows } = await pool.query<DatasetRow & { total_cases: string; labeled_cases: string }>(
    `SELECT d.*,
            COUNT(dc.id)::text AS total_cases,
            COUNT(dc.label)::text AS labeled_cases
     FROM datasets d
     LEFT JOIN dataset_cases dc ON dc.dataset_id = d.id
     GROUP BY d.id
     ORDER BY d.created_at DESC`,
  );
  return rows.map((r) => ({
    ...r,
    total_cases: parseInt(r.total_cases, 10),
    labeled_cases: parseInt(r.labeled_cases, 10),
  }));
}

export async function getDataset(id: number): Promise<DatasetRow | null> {
  await ensureMigrations();
  const pool = getPool();
  const { rows } = await pool.query<DatasetRow>(
    `SELECT * FROM datasets WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function deleteDataset(id: number): Promise<number> {
  await ensureMigrations();
  const pool = getPool();
  const result = await pool.query('DELETE FROM datasets WHERE id = $1', [id]);
  return result.rowCount ?? 0;
}

// --- Dataset Cases ---

export async function insertDatasetCases(
  datasetId: number,
  caseIds: number[],
): Promise<DatasetCaseRow[]> {
  if (caseIds.length === 0) return [];
  await ensureMigrations();
  const pool = getPool();
  // Batch in groups of 500 to stay well within PostgreSQL's bind-parameter limit
  const BATCH_SIZE = 500;
  const allRows: DatasetCaseRow[] = [];
  for (let start = 0; start < caseIds.length; start += BATCH_SIZE) {
    const batch = caseIds.slice(start, start + BATCH_SIZE);
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let idx = 1;
    for (const caseId of batch) {
      placeholders.push(`($${idx++}, $${idx++})`);
      values.push(datasetId, caseId);
    }
    const { rows } = await pool.query<DatasetCaseRow>(
      `INSERT INTO dataset_cases (dataset_id, case_id)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (dataset_id, case_id) DO NOTHING
       RETURNING *`,
      values,
    );
    allRows.push(...rows);
  }
  return allRows;
}

export async function listDatasetCases(datasetId: number): Promise<DatasetCaseRow[]> {
  await ensureMigrations();
  const pool = getPool();
  const { rows } = await pool.query<DatasetCaseRow>(
    `SELECT * FROM dataset_cases WHERE dataset_id = $1 ORDER BY created_at DESC`,
    [datasetId],
  );
  return rows;
}

export async function updateDatasetCaseLabel(
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

export async function updateDatasetCasePipelineRun(
  id: number,
  pipelineRunId: number,
): Promise<void> {
  await ensureMigrations();
  const pool = getPool();
  await pool.query(
    `UPDATE dataset_cases SET pipeline_run_id = $1 WHERE id = $2`,
    [pipelineRunId, id],
  );
}

export async function updateDatasetCasePipelineError(
  id: number,
  error: string,
): Promise<void> {
  await ensureMigrations();
  const pool = getPool();
  await pool.query(
    `UPDATE dataset_cases SET pipeline_error = $1 WHERE id = $2`,
    [error, id],
  );
}

export async function datasetCaseExists(id: number): Promise<boolean> {
  await ensureMigrations();
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT 1 FROM dataset_cases WHERE id = $1`,
    [id],
  );
  return rows.length > 0;
}

export async function deleteDatasetCase(id: number): Promise<number> {
  await ensureMigrations();
  const pool = getPool();
  const result = await pool.query('DELETE FROM dataset_cases WHERE id = $1', [id]);
  return result.rowCount ?? 0;
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

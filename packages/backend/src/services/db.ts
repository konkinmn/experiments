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
          label TEXT CHECK (label IN ('credit', 'escalate', 'undecided')),
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

    // Migration: add pipeline_error column to dataset_run_cases
    const { rows: runCaseErrorCol } = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'dataset_run_cases' AND column_name = 'pipeline_error'`,
    );
    if (runCaseErrorCol.length === 0) {
      await pool.query(
        `ALTER TABLE dataset_run_cases ADD COLUMN IF NOT EXISTS pipeline_error TEXT DEFAULT NULL`,
      );
    }

    // Migration: add label columns to dataset_run_cases for per-run labeling
    const { rows: runCaseLabelCol } = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'dataset_run_cases' AND column_name = 'label'`,
    );
    if (runCaseLabelCol.length === 0) {
      await pool.query(`
        ALTER TABLE dataset_run_cases ADD COLUMN IF NOT EXISTS label TEXT CHECK (label IN ('credit', 'escalate', 'undecided'));
        ALTER TABLE dataset_run_cases ADD COLUMN IF NOT EXISTS label_notes TEXT;
        ALTER TABLE dataset_run_cases ADD COLUMN IF NOT EXISTS labeled_by TEXT;
        ALTER TABLE dataset_run_cases ADD COLUMN IF NOT EXISTS labeled_at TIMESTAMPTZ;
      `);
    }

    // Migration 010: add auto_tags to dataset_cases
    const { rows: autoTagsCol } = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'dataset_cases' AND column_name = 'auto_tags'`,
    );
    if (autoTagsCol.length === 0) {
      await pool.query(`
        ALTER TABLE dataset_cases ADD COLUMN IF NOT EXISTS auto_tags JSONB DEFAULT '{}';
      `);
    }

    // Migration 011: rename needs_more_info → undecided, drop excluded/exclude_reason
    const { rows: oldLabelCheck } = await pool.query(
      `SELECT 1 FROM pg_constraint
       WHERE conname = 'dataset_cases_label_check'
         AND pg_get_constraintdef(oid) LIKE '%needs_more_info%'`,
    );
    if (oldLabelCheck.length > 0) {
      await pool.query(`
        UPDATE dataset_cases SET label = 'undecided' WHERE label = 'needs_more_info';
        UPDATE dataset_run_cases SET label = 'undecided' WHERE label = 'needs_more_info';
        ALTER TABLE dataset_cases DROP CONSTRAINT IF EXISTS dataset_cases_label_check;
        ALTER TABLE dataset_cases ADD CONSTRAINT dataset_cases_label_check CHECK (label IN ('credit', 'escalate', 'undecided'));
        ALTER TABLE dataset_run_cases DROP CONSTRAINT IF EXISTS dataset_run_cases_label_check;
        ALTER TABLE dataset_run_cases ADD CONSTRAINT dataset_run_cases_label_check CHECK (label IN ('credit', 'escalate', 'undecided'));
        ALTER TABLE dataset_cases DROP COLUMN IF EXISTS excluded;
        ALTER TABLE dataset_cases DROP COLUMN IF EXISTS exclude_reason;
      `);
    }

    // Migration 012: add label_confidence, disagreement_reason, disagreement_notes to both tables
    const { rows: confidenceCol } = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'dataset_cases' AND column_name = 'label_confidence'`,
    );
    if (confidenceCol.length === 0) {
      await pool.query(`
        ALTER TABLE dataset_cases ADD COLUMN IF NOT EXISTS label_confidence TEXT CHECK (label_confidence IN ('high', 'medium', 'low'));
        ALTER TABLE dataset_cases ADD COLUMN IF NOT EXISTS disagreement_reason TEXT CHECK (disagreement_reason IN ('signal_quality', 'rubric_issue', 'llm_reasoning', 'human_label_wrong', 'edge_case', 'other'));
        ALTER TABLE dataset_cases ADD COLUMN IF NOT EXISTS disagreement_notes TEXT;
        ALTER TABLE dataset_run_cases ADD COLUMN IF NOT EXISTS label_confidence TEXT CHECK (label_confidence IN ('high', 'medium', 'low'));
        ALTER TABLE dataset_run_cases ADD COLUMN IF NOT EXISTS disagreement_reason TEXT CHECK (disagreement_reason IN ('signal_quality', 'rubric_issue', 'llm_reasoning', 'human_label_wrong', 'edge_case', 'other'));
        ALTER TABLE dataset_run_cases ADD COLUMN IF NOT EXISTS disagreement_notes TEXT;
      `);
    }

    // Migration 013: add manual_tags to dataset_cases
    const { rows: manualTagsCol } = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'dataset_cases' AND column_name = 'manual_tags'`,
    );
    if (manualTagsCol.length === 0) {
      await pool.query(`
        ALTER TABLE dataset_cases ADD COLUMN IF NOT EXISTS manual_tags TEXT[] DEFAULT '{}';
      `);
    }

    // Migration 014: add second-labeler columns to dataset_cases
    const { rows: label2Col } = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'dataset_cases' AND column_name = 'label_2'`,
    );
    if (label2Col.length === 0) {
      await pool.query(`
        ALTER TABLE dataset_cases ADD COLUMN IF NOT EXISTS label_2 TEXT CHECK (label_2 IN ('credit', 'escalate', 'undecided'));
        ALTER TABLE dataset_cases ADD COLUMN IF NOT EXISTS label_2_notes TEXT;
        ALTER TABLE dataset_cases ADD COLUMN IF NOT EXISTS label_2_by TEXT;
        ALTER TABLE dataset_cases ADD COLUMN IF NOT EXISTS label_2_at TIMESTAMPTZ;
        ALTER TABLE dataset_cases ADD COLUMN IF NOT EXISTS label_2_confidence TEXT CHECK (label_2_confidence IN ('high', 'medium', 'low'));
      `);
    }

    // Migration 015: create dataset_compositions table
    const { rows: compTable } = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'dataset_compositions'`,
    );
    if (compTable.length === 0) {
      await pool.query(`
        CREATE TABLE dataset_compositions (
          id SERIAL PRIMARY KEY,
          parent_dataset_id INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
          child_dataset_id INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
          UNIQUE(parent_dataset_id, child_dataset_id)
        );
      `);
    }

    // Migration 016: add 'composition' to datasets.source_type CHECK constraint
    const { rows: sourceTypeCheck } = await pool.query(
      `SELECT 1 FROM pg_constraint
       WHERE conname = 'datasets_source_type_check'
         AND pg_get_constraintdef(oid) NOT LIKE '%composition%'`,
    );
    if (sourceTypeCheck.length > 0) {
      await pool.query(`
        ALTER TABLE datasets DROP CONSTRAINT IF EXISTS datasets_source_type_check;
        ALTER TABLE datasets ADD CONSTRAINT datasets_source_type_check
          CHECK (source_type IN ('case_ids', 'custom_sql', 'composition'));
      `);
    }

    // Migration 017: add context columns to dataset_cases + status to datasets
    const { rows: ctxCol } = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'dataset_cases' AND column_name = 'raw_signals'`,
    );
    if (ctxCol.length === 0) {
      await pool.query(`
        ALTER TABLE dataset_cases ADD COLUMN IF NOT EXISTS raw_signals JSONB DEFAULT NULL;
        ALTER TABLE dataset_cases ADD COLUMN IF NOT EXISTS case_details JSONB DEFAULT NULL;
        ALTER TABLE dataset_cases ADD COLUMN IF NOT EXISTS case_actions JSONB DEFAULT NULL;
        ALTER TABLE dataset_cases ADD COLUMN IF NOT EXISTS dialogue_messages JSONB DEFAULT NULL;
        ALTER TABLE dataset_cases ADD COLUMN IF NOT EXISTS file_parse_results JSONB DEFAULT NULL;
        ALTER TABLE dataset_cases ADD COLUMN IF NOT EXISTS enrichment_metadata JSONB DEFAULT NULL;
        ALTER TABLE dataset_cases ADD COLUMN IF NOT EXISTS context_error TEXT DEFAULT NULL;
        ALTER TABLE dataset_cases ADD COLUMN IF NOT EXISTS context_fetched_at TIMESTAMPTZ DEFAULT NULL;
      `);
    }

    const { rows: dsStatusCol } = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'datasets' AND column_name = 'status'`,
    );
    if (dsStatusCol.length === 0) {
      await pool.query(`
        ALTER TABLE datasets ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'ready'
          CHECK (status IN ('loading', 'ready'));
      `);
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
  DatasetRun,
  RunConfig,
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
    status: (r.status ?? 'ready') as 'loading' | 'ready',
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
  confidence: string | null = null,
  disagreementReason: string | null = null,
  disagreementNotes: string | null = null,
): Promise<DatasetCaseRow | null> {
  await ensureMigrations();
  const pool = getPool();
  const { rows } = await pool.query<DatasetCaseRow>(
    `UPDATE dataset_cases
     SET label = $1, label_notes = $2, labeled_by = $3, labeled_at = now(),
         label_confidence = $5, disagreement_reason = $6, disagreement_notes = $7
     WHERE id = $4
     RETURNING *`,
    [label, notes, labeledBy, id, confidence, disagreementReason, disagreementNotes],
  );
  return rows[0] ?? null;
}

export async function updateDatasetRunCaseLabel(
  id: number,
  label: DatasetLabel,
  notes: string | null,
  labeledBy: string | null,
  confidence: string | null = null,
  disagreementReason: string | null = null,
  disagreementNotes: string | null = null,
): Promise<DatasetRunCaseDbRow | null> {
  await ensureMigrations();
  const pool = getPool();
  const { rows } = await pool.query<DatasetRunCaseDbRow>(
    `UPDATE dataset_run_cases
     SET label = $1, label_notes = $2, labeled_by = $3, labeled_at = now(),
         label_confidence = $5, disagreement_reason = $6, disagreement_notes = $7
     WHERE id = $4
     RETURNING *, (SELECT case_id FROM dataset_cases WHERE id = dataset_case_id) AS case_id`,
    [label, notes, labeledBy, id, confidence, disagreementReason, disagreementNotes],
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

export async function updateDatasetCaseContext(
  id: number,
  context: {
    raw_signals: unknown;
    case_details: unknown;
    case_actions: unknown;
    dialogue_messages: unknown;
    file_parse_results: unknown;
    enrichment_metadata: unknown;
  },
): Promise<void> {
  await ensureMigrations();
  const pool = getPool();
  await pool.query(
    `UPDATE dataset_cases
     SET raw_signals = $1, case_details = $2, case_actions = $3,
         dialogue_messages = $4, file_parse_results = $5, enrichment_metadata = $6,
         context_error = NULL, context_fetched_at = now()
     WHERE id = $7`,
    [
      JSON.stringify(context.raw_signals),
      JSON.stringify(context.case_details),
      JSON.stringify(context.case_actions),
      JSON.stringify(context.dialogue_messages),
      JSON.stringify(context.file_parse_results),
      JSON.stringify(context.enrichment_metadata),
      id,
    ],
  );
}

export async function updateDatasetCaseContextError(
  id: number,
  error: string,
): Promise<void> {
  await ensureMigrations();
  const pool = getPool();
  await pool.query(
    `UPDATE dataset_cases SET context_error = $1 WHERE id = $2`,
    [error, id],
  );
}

export async function updateDatasetStatus(
  id: number,
  status: 'loading' | 'ready',
): Promise<void> {
  await ensureMigrations();
  const pool = getPool();
  await pool.query(
    `UPDATE datasets SET status = $1 WHERE id = $2`,
    [status, id],
  );
}

export async function getDatasetCaseContexts(
  datasetId: number,
): Promise<
  Array<{
    id: number;
    case_id: number;
    raw_signals: unknown | null;
    case_details: unknown | null;
    case_actions: unknown | null;
    dialogue_messages: unknown | null;
    file_parse_results: unknown | null;
    enrichment_metadata: unknown | null;
  }>
> {
  await ensureMigrations();
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, case_id, raw_signals, case_details, case_actions,
            dialogue_messages, file_parse_results, enrichment_metadata
     FROM dataset_cases WHERE dataset_id = $1`,
    [datasetId],
  );
  return rows;
}

export async function deleteDatasetCase(id: number): Promise<number> {
  await ensureMigrations();
  const pool = getPool();
  const result = await pool.query('DELETE FROM dataset_cases WHERE id = $1', [id]);
  return result.rowCount ?? 0;
}

// --- Dataset Runs ---

interface DatasetRunRow {
  id: number;
  dataset_id: number;
  name: string;
  config: RunConfig;
  status: string;
  created_at: string;
  completed_at: string | null;
}

export async function insertDatasetRun(
  datasetId: number,
  name: string,
  config: RunConfig,
): Promise<DatasetRun> {
  await ensureMigrations();
  const pool = getPool();
  const { rows } = await pool.query<DatasetRunRow>(
    `INSERT INTO dataset_runs (dataset_id, name, config, status)
     VALUES ($1, $2, $3, 'pending')
     RETURNING *`,
    [datasetId, name, JSON.stringify(config)],
  );
  if (!rows[0]) throw new Error('Insert did not return a row');
  return {
    ...rows[0],
    status: rows[0].status as DatasetRun['status'],
    total_cases: 0,
    completed_cases: 0,
    agreement_rate: null,
    credit_precision: null,
    escalate_recall: null,
    false_credit_rate: null,
  };
}

export async function insertDatasetRunCases(
  runId: number,
  datasetCaseIds: number[],
): Promise<void> {
  if (datasetCaseIds.length === 0) return;
  await ensureMigrations();
  const pool = getPool();
  const BATCH_SIZE = 500;
  for (let start = 0; start < datasetCaseIds.length; start += BATCH_SIZE) {
    const batch = datasetCaseIds.slice(start, start + BATCH_SIZE);
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let idx = 1;
    for (const dcId of batch) {
      placeholders.push(`($${idx++}, $${idx++})`);
      values.push(runId, dcId);
    }
    await pool.query(
      `INSERT INTO dataset_run_cases (run_id, dataset_case_id)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (run_id, dataset_case_id) DO NOTHING`,
      values,
    );
  }
}

export async function updateDatasetRunCaseResult(
  runCaseId: number,
  pipelineRunId: number,
): Promise<void> {
  await ensureMigrations();
  const pool = getPool();
  await pool.query(
    `UPDATE dataset_run_cases SET pipeline_run_id = $1 WHERE id = $2`,
    [pipelineRunId, runCaseId],
  );
}

export async function updateDatasetRunCaseError(
  runCaseId: number,
  errorMessage: string,
): Promise<void> {
  await ensureMigrations();
  const pool = getPool();
  await pool.query(
    `UPDATE dataset_run_cases SET pipeline_error = $1 WHERE id = $2`,
    [errorMessage, runCaseId],
  );
}

export async function updateDatasetRunStatus(
  runId: number,
  status: DatasetRun['status'],
  completedAt?: Date,
): Promise<void> {
  await ensureMigrations();
  const pool = getPool();
  if (completedAt) {
    await pool.query(
      `UPDATE dataset_runs SET status = $1, completed_at = $2 WHERE id = $3`,
      [status, completedAt.toISOString(), runId],
    );
  } else {
    await pool.query(
      `UPDATE dataset_runs SET status = $1 WHERE id = $2`,
      [status, runId],
    );
  }
}

export async function listDatasetRuns(datasetId: number): Promise<DatasetRun[]> {
  await ensureMigrations();
  const pool = getPool();
  const { rows } = await pool.query<
    DatasetRunRow & {
      total_cases: string;
      completed_cases: string;
      agreement_rate: string | null;
      credit_precision: string | null;
      escalate_recall: string | null;
      false_credit_rate: string | null;
    }
  >(
    `SELECT r.*,
            COUNT(rc.id)::text AS total_cases,
            COUNT(CASE WHEN rc.pipeline_run_id IS NOT NULL OR rc.pipeline_error IS NOT NULL THEN 1 END)::text AS completed_cases,
            ROUND(
              100.0 * SUM(CASE
                WHEN rc.label = 'credit' AND pr.planner_output->>'decision' = 'credit' THEN 1
                WHEN rc.label = 'escalate' AND pr.planner_output->>'decision' = 'escalate_to_agent' THEN 1
                WHEN rc.label = 'escalate' AND pr.hard_gate_triggered IS NOT NULL THEN 1
                ELSE 0
              END) / NULLIF(COUNT(CASE WHEN rc.label IN ('credit','escalate') AND pr.id IS NOT NULL THEN 1 END), 0),
            1)::text AS agreement_rate,
            ROUND(
              100.0 * SUM(CASE WHEN pr.planner_output->>'decision' = 'credit' AND rc.label = 'credit' THEN 1 ELSE 0 END)
              / NULLIF(SUM(CASE WHEN pr.planner_output->>'decision' = 'credit' AND rc.label IN ('credit','escalate') THEN 1 ELSE 0 END), 0),
            1)::text AS credit_precision,
            ROUND(
              100.0 * SUM(CASE WHEN rc.label = 'escalate' AND (pr.planner_output->>'decision' = 'escalate_to_agent' OR pr.hard_gate_triggered IS NOT NULL) THEN 1 ELSE 0 END)
              / NULLIF(SUM(CASE WHEN rc.label = 'escalate' AND pr.id IS NOT NULL THEN 1 ELSE 0 END), 0),
            1)::text AS escalate_recall,
            ROUND(
              100.0 * SUM(CASE WHEN pr.planner_output->>'decision' = 'credit' AND rc.label = 'escalate' THEN 1 ELSE 0 END)
              / NULLIF(SUM(CASE WHEN pr.planner_output->>'decision' = 'credit' AND rc.label IN ('credit','escalate') THEN 1 ELSE 0 END), 0),
            1)::text AS false_credit_rate
     FROM dataset_runs r
     LEFT JOIN dataset_run_cases rc ON rc.run_id = r.id
     LEFT JOIN dispute_pipeline_runs pr ON pr.id = rc.pipeline_run_id
     WHERE r.dataset_id = $1
     GROUP BY r.id
     ORDER BY r.created_at DESC`,
    [datasetId],
  );
  return rows.map((r) => ({
    id: r.id,
    dataset_id: r.dataset_id,
    name: r.name,
    config: r.config,
    status: r.status as DatasetRun['status'],
    created_at: r.created_at,
    completed_at: r.completed_at,
    total_cases: parseInt(r.total_cases, 10),
    completed_cases: parseInt(r.completed_cases, 10),
    agreement_rate: r.agreement_rate !== null ? parseFloat(r.agreement_rate) : null,
    credit_precision: r.credit_precision !== null ? parseFloat(r.credit_precision) : null,
    escalate_recall: r.escalate_recall !== null ? parseFloat(r.escalate_recall) : null,
    false_credit_rate: r.false_credit_rate !== null ? parseFloat(r.false_credit_rate) : null,
  }));
}

interface DatasetRunCaseDbRow {
  id: number;
  run_id: number;
  dataset_case_id: number;
  pipeline_run_id: number | null;
  pipeline_error: string | null;
  created_at: string;
  case_id: number;
  label: DatasetLabel | null;
  label_notes: string | null;
  labeled_by: string | null;
  labeled_at: string | null;
  label_confidence: string | null;
  disagreement_reason: string | null;
  disagreement_notes: string | null;
}

export async function getDatasetRunCases(runId: number): Promise<
  Array<{
    id: number;
    run_id: number;
    dataset_case_id: number;
    pipeline_run_id: number | null;
    pipeline_error: string | null;
    case_id: number;
    label: DatasetLabel | null;
    label_notes: string | null;
    labeled_by: string | null;
    labeled_at: string | null;
    label_confidence: string | null;
    disagreement_reason: string | null;
    disagreement_notes: string | null;
    pipeline_run: PipelineRunRow | null;
  }>
> {
  await ensureMigrations();
  const pool = getPool();
  const { rows } = await pool.query<DatasetRunCaseDbRow>(
    `SELECT rc.id, rc.run_id, rc.dataset_case_id, rc.pipeline_run_id, rc.pipeline_error, rc.created_at,
            dc.case_id, rc.label, rc.label_notes, rc.labeled_by, rc.labeled_at,
            rc.label_confidence, rc.disagreement_reason, rc.disagreement_notes
     FROM dataset_run_cases rc
     JOIN dataset_cases dc ON dc.id = rc.dataset_case_id
     WHERE rc.run_id = $1
     ORDER BY dc.case_id`,
    [runId],
  );

  // Fetch pipeline runs for completed cases
  const pipelineRunIds = rows
    .map((r) => r.pipeline_run_id)
    .filter((id): id is number => id !== null);
  const pipelineRuns = await getPipelineRunsByIds(pipelineRunIds);
  const runMap = new Map(pipelineRuns.map((r) => [r.id, r]));

  return rows.map((r) => ({
    id: r.id,
    run_id: r.run_id,
    dataset_case_id: r.dataset_case_id,
    pipeline_run_id: r.pipeline_run_id,
    pipeline_error: r.pipeline_error,
    case_id: r.case_id,
    label: r.label,
    label_notes: r.label_notes,
    labeled_by: r.labeled_by,
    labeled_at: r.labeled_at,
    label_confidence: r.label_confidence,
    disagreement_reason: r.disagreement_reason,
    disagreement_notes: r.disagreement_notes,
    pipeline_run: r.pipeline_run_id ? (runMap.get(r.pipeline_run_id) ?? null) : null,
  }));
}

export async function updateDatasetCaseTags(
  id: number,
  tags: string[],
): Promise<DatasetCaseRow | null> {
  await ensureMigrations();
  const pool = getPool();
  const { rows } = await pool.query<DatasetCaseRow>(
    `UPDATE dataset_cases SET manual_tags = $1 WHERE id = $2 RETURNING *`,
    [tags, id],
  );
  return rows[0] ?? null;
}

export async function getDatasetAnalytics(
  _datasetId: number,
  runId?: number,
): Promise<{
  confusion_matrix: { true_credit: number; false_credit: number; true_escalate: number; false_escalate: number; unlabeled: number; undecided: number };
  rows: Array<{ auto_tags: Record<string, string | boolean>; label: string | null; pipeline_decision: string | null; hard_gate_triggered: string | null; label_confidence: string | null; disagreement_reason: string | null; label_2: string | null }>;
}> {
  await ensureMigrations();
  const pool = getPool();

  if (!runId) {
    // No baseline analytics — require a run
    return {
      confusion_matrix: { true_credit: 0, false_credit: 0, true_escalate: 0, false_escalate: 0, unlabeled: 0, undecided: 0 },
      rows: [],
    };
  }

  // Analytics for a specific run — compute auto_tags from pipeline run data
  const { rows } = await pool.query<{
    auto_tags: Record<string, string | boolean>;
    label: string | null;
    pipeline_decision: string | null;
    hard_gate_triggered: string | null;
    label_confidence: string | null;
    disagreement_reason: string | null;
    label_2: string | null;
  }>(
    `SELECT
       jsonb_build_object(
         'risk_level', COALESCE(pr.dispute_profile->>'risk_level', 'unknown'),
         'hard_gate_hit', COALESCE(pr.hard_gate_triggered IS NOT NULL, false),
         'rubric_score_bucket', CASE
           WHEN pr.dispute_profile IS NULL THEN 'unknown'
           WHEN COALESCE((pr.dispute_profile->>'rubric_score')::int, 0) >= 70 THEN '70-108'
           WHEN COALESCE((pr.dispute_profile->>'rubric_score')::int, 0) >= 40 THEN '40-69'
           ELSE '0-39'
         END,
         'amount_bucket', CASE
           WHEN pr.raw_signals IS NULL THEN 'unknown'
           WHEN COALESCE((pr.raw_signals->>'total_amount')::numeric, 0) < 25 THEN 'under_25'
           WHEN COALESCE((pr.raw_signals->>'total_amount')::numeric, 0) < 100 THEN '25_to_100'
           ELSE 'over_100'
         END,
         'dispute_type', COALESCE(pr.planner_output->'args'->>'reason', 'unknown')
       ) AS auto_tags,
       dc.label, pr.planner_output->>'decision' AS pipeline_decision, pr.hard_gate_triggered,
       rc.label_confidence, rc.disagreement_reason, dc.label_2
     FROM dataset_run_cases rc
     JOIN dataset_cases dc ON dc.id = rc.dataset_case_id
     LEFT JOIN dispute_pipeline_runs pr ON pr.id = rc.pipeline_run_id
     WHERE rc.run_id = $1`,
    [runId],
  );

  return computeAnalyticsFromRows(rows);
}

function computeAnalyticsFromRows(
  rows: Array<{ auto_tags: Record<string, string | boolean>; label: string | null; pipeline_decision: string | null; hard_gate_triggered: string | null; label_confidence: string | null; disagreement_reason: string | null; label_2: string | null }>
) {
  let true_credit = 0, false_credit = 0, true_escalate = 0, false_escalate = 0, unlabeled = 0, undecided = 0;

  for (const r of rows) {
    if (!r.label) { unlabeled++; continue; }
    if (r.label === 'undecided') { undecided++; continue; }

    const pipelineEscalated = r.hard_gate_triggered != null || r.pipeline_decision === 'escalate_to_agent';
    const pipelineCredited = !pipelineEscalated && r.pipeline_decision === 'credit';

    if (r.label === 'credit' && pipelineCredited) true_credit++;
    else if (r.label === 'escalate' && pipelineCredited) false_credit++;
    else if (r.label === 'escalate' && pipelineEscalated) true_escalate++;
    else if (r.label === 'credit' && pipelineEscalated) false_escalate++;
    else unlabeled++; // pipeline has no decision yet
  }

  return {
    confusion_matrix: { true_credit, false_credit, true_escalate, false_escalate, unlabeled, undecided },
    rows,
  };
}

export interface ComparisonRow {
  dataset_case_id: number;
  case_id: number;
  label: string | null;
  run_a_decision: string | null;
  run_a_hard_gate: string | null;
  run_b_decision: string | null;
  run_b_hard_gate: string | null;
}

export async function getComparisonData(
  datasetId: number,
  runAId: number,
  runBId: number,
): Promise<ComparisonRow[]> {
  await ensureMigrations();
  const pool = getPool();
  const { rows } = await pool.query<ComparisonRow>(
    `SELECT
       dc.id AS dataset_case_id, dc.case_id, dc.label,
       prA.planner_output->>'decision' AS run_a_decision, prA.hard_gate_triggered AS run_a_hard_gate,
       prB.planner_output->>'decision' AS run_b_decision, prB.hard_gate_triggered AS run_b_hard_gate
     FROM dataset_cases dc
     JOIN dataset_run_cases rcA ON rcA.dataset_case_id = dc.id AND rcA.run_id = $2
     JOIN dataset_run_cases rcB ON rcB.dataset_case_id = dc.id AND rcB.run_id = $3
     LEFT JOIN dispute_pipeline_runs prA ON prA.id = rcA.pipeline_run_id
     LEFT JOIN dispute_pipeline_runs prB ON prB.id = rcB.pipeline_run_id
     WHERE dc.dataset_id = $1
     ORDER BY dc.case_id`,
    [datasetId, runAId, runBId],
  );
  return rows;
}

export async function updateDatasetCaseLabel2(
  id: number,
  label: DatasetLabel,
  notes: string | null,
  labeledBy: string | null,
  confidence: string | null = null,
): Promise<DatasetCaseRow | null> {
  await ensureMigrations();
  const pool = getPool();
  const { rows } = await pool.query<DatasetCaseRow>(
    `UPDATE dataset_cases
     SET label_2 = $1, label_2_notes = $2, label_2_by = $3, label_2_at = now(), label_2_confidence = $5
     WHERE id = $4
     RETURNING *`,
    [label, notes, labeledBy, id, confidence],
  );
  return rows[0] ?? null;
}

export async function composeDatasets(
  name: string,
  description: string | null,
  datasetIds: number[],
): Promise<{ dataset: DatasetRow; caseCount: number }> {
  await ensureMigrations();
  const pool = getPool();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Create the composite dataset
    const { rows: [dataset] } = await client.query<DatasetRow>(
      `INSERT INTO datasets (name, description, source_type, source_config)
       VALUES ($1, $2, 'composition', $3)
       RETURNING *`,
      [name, description, JSON.stringify({ dataset_ids: datasetIds })],
    );

    // Copy cases from child datasets, deduplicating by case_id
    const { rowCount } = await client.query(
      `INSERT INTO dataset_cases (dataset_id, case_id, pipeline_run_id,
         raw_signals, case_details, case_actions, dialogue_messages,
         file_parse_results, enrichment_metadata, context_fetched_at,
         label, label_notes, labeled_by, labeled_at,
         label_confidence, disagreement_reason, disagreement_notes, label_2, label_2_notes, label_2_by, label_2_at,
         label_2_confidence, manual_tags, auto_tags)
       SELECT DISTINCT ON (dc.case_id)
         $1, dc.case_id, dc.pipeline_run_id,
         dc.raw_signals, dc.case_details, dc.case_actions, dc.dialogue_messages,
         dc.file_parse_results, dc.enrichment_metadata, dc.context_fetched_at,
         dc.label, dc.label_notes, dc.labeled_by, dc.labeled_at,
         dc.label_confidence, dc.disagreement_reason, dc.disagreement_notes, dc.label_2, dc.label_2_notes,
         dc.label_2_by, dc.label_2_at, dc.label_2_confidence, dc.manual_tags, dc.auto_tags
       FROM dataset_cases dc
       WHERE dc.dataset_id = ANY($2)
       ORDER BY dc.case_id, dc.labeled_at DESC NULLS LAST`,
      [dataset.id, datasetIds],
    );

    // Insert composition records
    for (const childId of datasetIds) {
      await client.query(
        `INSERT INTO dataset_compositions (parent_dataset_id, child_dataset_id) VALUES ($1, $2)`,
        [dataset.id, childId],
      );
    }

    await client.query('COMMIT');
    return { dataset, caseCount: rowCount ?? 0 };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

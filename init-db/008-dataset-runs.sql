CREATE TABLE IF NOT EXISTS dataset_runs (
  id SERIAL PRIMARY KEY,
  dataset_id INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  config JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS dataset_run_cases (
  id SERIAL PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES dataset_runs(id) ON DELETE CASCADE,
  dataset_case_id INTEGER NOT NULL REFERENCES dataset_cases(id) ON DELETE CASCADE,
  pipeline_run_id INTEGER REFERENCES dispute_pipeline_runs(id),
  pipeline_error TEXT DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(run_id, dataset_case_id)
);

CREATE INDEX IF NOT EXISTS idx_dataset_runs_dataset_id ON dataset_runs(dataset_id);
CREATE INDEX IF NOT EXISTS idx_dataset_run_cases_run_id ON dataset_run_cases(run_id);

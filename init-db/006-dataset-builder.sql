CREATE TABLE IF NOT EXISTS dataset_cases (
  id SERIAL PRIMARY KEY,
  case_id INTEGER NOT NULL,
  segment TEXT NOT NULL,
  pipeline_run_id INTEGER REFERENCES dispute_pipeline_runs(id),
  label TEXT CHECK (label IN ('credit', 'escalate', 'needs_more_info')),
  label_notes TEXT,
  labeled_by TEXT,
  labeled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(case_id)
);

CREATE INDEX IF NOT EXISTS idx_dataset_cases_segment ON dataset_cases(segment);
CREATE INDEX IF NOT EXISTS idx_dataset_cases_label ON dataset_cases(label);

CREATE TABLE IF NOT EXISTS dispute_pipeline_runs (
  id SERIAL PRIMARY KEY,
  case_id INTEGER NOT NULL,
  raw_signals JSONB NOT NULL,
  case_details JSONB,
  dispute_profile JSONB NOT NULL,
  hard_gates JSONB NOT NULL,
  hard_gate_triggered TEXT,
  planner_output JSONB,
  executor_action TEXT DEFAULT 'shadow',
  pipeline_duration_ms INTEGER,
  prompt_version TEXT,
  evidence_artifacts JSONB DEFAULT NULL,
  reviewer_verdict TEXT,
  reviewer_notes TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dispute_pipeline_case_id ON dispute_pipeline_runs(case_id);
CREATE INDEX IF NOT EXISTS idx_dispute_pipeline_created ON dispute_pipeline_runs(created_at DESC);

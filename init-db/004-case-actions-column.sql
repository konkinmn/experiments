ALTER TABLE dispute_pipeline_runs
  ADD COLUMN IF NOT EXISTS case_actions JSONB DEFAULT NULL;

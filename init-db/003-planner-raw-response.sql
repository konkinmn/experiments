ALTER TABLE dispute_pipeline_runs
  ADD COLUMN IF NOT EXISTS planner_raw_response TEXT;

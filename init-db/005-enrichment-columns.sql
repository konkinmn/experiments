-- Store full planner LLM request payload for analysis
ALTER TABLE dispute_pipeline_runs
  ADD COLUMN IF NOT EXISTS planner_request JSONB DEFAULT NULL;

-- Store actual system prompt text used (not just the version ID)
ALTER TABLE dispute_pipeline_runs
  ADD COLUMN IF NOT EXISTS planner_system_prompt TEXT DEFAULT NULL;

-- Store Gemini file parsing results
ALTER TABLE dispute_pipeline_runs
  ADD COLUMN IF NOT EXISTS file_parse_results JSONB DEFAULT NULL;

-- Store customer dialogue messages sent to planner
ALTER TABLE dispute_pipeline_runs
  ADD COLUMN IF NOT EXISTS dialogue_messages JSONB DEFAULT NULL;

-- Store enrichment fetch metadata (counts, failures, diagnostics)
ALTER TABLE dispute_pipeline_runs
  ADD COLUMN IF NOT EXISTS enrichment_metadata JSONB DEFAULT NULL;

ALTER TABLE dispute_pipeline_runs ADD COLUMN IF NOT EXISTS engine TEXT;
UPDATE dispute_pipeline_runs SET engine = 'experiments-v1' WHERE engine IS NULL;
ALTER TABLE dispute_pipeline_runs ALTER COLUMN engine SET NOT NULL;
ALTER TABLE dispute_pipeline_runs ADD COLUMN IF NOT EXISTS prompt_md5 TEXT;

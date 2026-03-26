ALTER TABLE dataset_run_cases ADD COLUMN IF NOT EXISTS label TEXT CHECK (label IN ('credit', 'escalate', 'needs_more_info'));
ALTER TABLE dataset_run_cases ADD COLUMN IF NOT EXISTS label_notes TEXT;
ALTER TABLE dataset_run_cases ADD COLUMN IF NOT EXISTS labeled_by TEXT;
ALTER TABLE dataset_run_cases ADD COLUMN IF NOT EXISTS labeled_at TIMESTAMPTZ;

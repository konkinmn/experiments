-- Create datasets parent table
CREATE TABLE IF NOT EXISTS datasets (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  source_type TEXT NOT NULL CHECK (source_type IN ('preset', 'case_ids', 'custom_sql')),
  source_config JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Migrate dataset_cases: add dataset_id, remove segment, update unique constraint
-- First delete any existing rows (old segment-based data will be recreated via new UI)
DELETE FROM dataset_cases;

ALTER TABLE dataset_cases ADD COLUMN IF NOT EXISTS dataset_id INTEGER REFERENCES datasets(id) ON DELETE CASCADE;
ALTER TABLE dataset_cases ALTER COLUMN dataset_id SET NOT NULL;

-- Drop old segment column and index
ALTER TABLE dataset_cases DROP COLUMN IF EXISTS segment;
DROP INDEX IF EXISTS idx_dataset_cases_segment;

-- Replace old unique constraint (case_id only) with new one (dataset_id, case_id)
ALTER TABLE dataset_cases DROP CONSTRAINT IF EXISTS dataset_cases_case_id_key;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'dataset_cases_dataset_id_case_id_key'
  ) THEN
    ALTER TABLE dataset_cases ADD CONSTRAINT dataset_cases_dataset_id_case_id_key UNIQUE(dataset_id, case_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_dataset_cases_dataset_id ON dataset_cases(dataset_id);
CREATE INDEX IF NOT EXISTS idx_dataset_cases_label ON dataset_cases(label);

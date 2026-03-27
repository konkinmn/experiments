ALTER TABLE dataset_run_cases ADD COLUMN IF NOT EXISTS label TEXT CHECK (label IN ('credit', 'escalate', 'undecided'));
ALTER TABLE dataset_run_cases ADD COLUMN IF NOT EXISTS label_notes TEXT;
ALTER TABLE dataset_run_cases ADD COLUMN IF NOT EXISTS labeled_by TEXT;
ALTER TABLE dataset_run_cases ADD COLUMN IF NOT EXISTS labeled_at TIMESTAMPTZ;
ALTER TABLE dataset_run_cases ADD COLUMN IF NOT EXISTS label_confidence TEXT CHECK (label_confidence IN ('high', 'medium', 'low'));
ALTER TABLE dataset_run_cases ADD COLUMN IF NOT EXISTS disagreement_reason TEXT CHECK (disagreement_reason IN ('signal_quality', 'rubric_issue', 'llm_reasoning', 'human_label_wrong', 'edge_case', 'other'));
ALTER TABLE dataset_run_cases ADD COLUMN IF NOT EXISTS disagreement_notes TEXT;

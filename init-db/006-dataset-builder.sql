CREATE TABLE IF NOT EXISTS dataset_cases (
  id SERIAL PRIMARY KEY,
  case_id INTEGER NOT NULL,
  segment TEXT NOT NULL,
  pipeline_run_id INTEGER REFERENCES dispute_pipeline_runs(id),
  label TEXT CHECK (label IN ('credit', 'escalate', 'undecided')),
  label_notes TEXT,
  labeled_by TEXT,
  labeled_at TIMESTAMPTZ,
  pipeline_error TEXT,
  label_confidence TEXT CHECK (label_confidence IN ('high', 'medium', 'low')),
  disagreement_reason TEXT CHECK (disagreement_reason IN ('signal_quality', 'rubric_issue', 'llm_reasoning', 'human_label_wrong', 'edge_case', 'other')),
  disagreement_notes TEXT,
  label_2 TEXT CHECK (label_2 IN ('credit', 'escalate', 'undecided')),
  label_2_notes TEXT,
  label_2_by TEXT,
  label_2_at TIMESTAMPTZ,
  label_2_confidence TEXT CHECK (label_2_confidence IN ('high', 'medium', 'low')),
  manual_tags TEXT[] DEFAULT '{}',
  auto_tags JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(case_id)
);

CREATE INDEX IF NOT EXISTS idx_dataset_cases_segment ON dataset_cases(segment);
CREATE INDEX IF NOT EXISTS idx_dataset_cases_label ON dataset_cases(label);

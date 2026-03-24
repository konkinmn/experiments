CREATE TABLE IF NOT EXISTS analysis_jobs (
  id UUID PRIMARY KEY,
  status TEXT NOT NULL,
  progress_current INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER NOT NULL DEFAULT 0,
  progress_current_case_id INTEGER,
  results JSONB DEFAULT '[]'::jsonb,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

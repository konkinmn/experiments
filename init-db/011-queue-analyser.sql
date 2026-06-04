-- Queue Analyser: per-skill triage runs + their classified task rows.

CREATE TABLE IF NOT EXISTS queue_analyser_runs (
  id SERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  group_name TEXT NOT NULL,
  model TEXT,
  prompt_md5 TEXT,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'ready', 'error')),
  n_tasks INTEGER NOT NULL DEFAULT 0,
  n_auto_close INTEGER NOT NULL DEFAULT 0,
  n_reroute INTEGER NOT NULL DEFAULT 0,
  n_needs_review INTEGER NOT NULL DEFAULT 0,
  n_real_work INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_queue_analyser_runs_group_id ON queue_analyser_runs(group_id);
CREATE INDEX IF NOT EXISTS idx_queue_analyser_runs_created_at ON queue_analyser_runs(created_at);

CREATE TABLE IF NOT EXISTS queue_analyser_tasks (
  id SERIAL PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES queue_analyser_runs(id) ON DELETE CASCADE,
  task_id BIGINT NOT NULL,
  ws_link TEXT,
  alias TEXT,
  title TEXT,
  task_type TEXT,
  age_days INTEGER,
  created_by TEXT,
  taken_by TEXT,
  rb_jira_sync BOOLEAN,
  n_cases INTEGER,
  case_statuses TEXT,
  bucket TEXT NOT NULL,
  rule_fired TEXT,
  sub_bucket TEXT,
  reason TEXT,
  suggested_action TEXT,
  confidence REAL,
  classify_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_queue_analyser_tasks_run_id ON queue_analyser_tasks(run_id);
CREATE INDEX IF NOT EXISTS idx_queue_analyser_tasks_bucket ON queue_analyser_tasks(bucket);

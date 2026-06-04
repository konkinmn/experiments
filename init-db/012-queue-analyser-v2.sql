-- Queue Analyser v2: enrichment facts + emergent work-group fields.

-- Run-level: grouped summary + headline + v2 counts.
ALTER TABLE queue_analyser_runs ADD COLUMN IF NOT EXISTS groups JSONB;
ALTER TABLE queue_analyser_runs ADD COLUMN IF NOT EXISTS summary TEXT;
ALTER TABLE queue_analyser_runs ADD COLUMN IF NOT EXISTS n_high_priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE queue_analyser_runs ADD COLUMN IF NOT EXISTS total_residual_balance NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE queue_analyser_runs ADD COLUMN IF NOT EXISTS n_safe_close INTEGER NOT NULL DEFAULT 0;

-- Task-level: financial / company / relational enrichment + group assignment.
ALTER TABLE queue_analyser_tasks ADD COLUMN IF NOT EXISTS n_active INTEGER;
ALTER TABLE queue_analyser_tasks ADD COLUMN IF NOT EXISTS n_done INTEGER;
ALTER TABLE queue_analyser_tasks ADD COLUMN IF NOT EXISTS balance NUMERIC;
ALTER TABLE queue_analyser_tasks ADD COLUMN IF NOT EXISTS currency TEXT;
ALTER TABLE queue_analyser_tasks ADD COLUMN IF NOT EXISTS account_statuses TEXT;
ALTER TABLE queue_analyser_tasks ADD COLUMN IF NOT EXISTS account_closed BOOLEAN;
ALTER TABLE queue_analyser_tasks ADD COLUMN IF NOT EXISTS company_status TEXT;
ALTER TABLE queue_analyser_tasks ADD COLUMN IF NOT EXISTS date_ceased_on DATE;
ALTER TABLE queue_analyser_tasks ADD COLUMN IF NOT EXISTS days_since_cessation INTEGER;
ALTER TABLE queue_analyser_tasks ADD COLUMN IF NOT EXISTS company_number TEXT;
ALTER TABLE queue_analyser_tasks ADD COLUMN IF NOT EXISTS company_title TEXT;
ALTER TABLE queue_analyser_tasks ADD COLUMN IF NOT EXISTS n_alias_open INTEGER;
ALTER TABLE queue_analyser_tasks ADD COLUMN IF NOT EXISTS n_alias_closed INTEGER;
ALTER TABLE queue_analyser_tasks ADD COLUMN IF NOT EXISTS group_name TEXT;
ALTER TABLE queue_analyser_tasks ADD COLUMN IF NOT EXISTS disposition TEXT;
ALTER TABLE queue_analyser_tasks ADD COLUMN IF NOT EXISTS the_work TEXT;
ALTER TABLE queue_analyser_tasks ADD COLUMN IF NOT EXISTS priority TEXT;
ALTER TABLE queue_analyser_tasks ADD COLUMN IF NOT EXISTS rationale TEXT;

CREATE INDEX IF NOT EXISTS idx_queue_analyser_tasks_priority ON queue_analyser_tasks(priority);
CREATE INDEX IF NOT EXISTS idx_queue_analyser_tasks_disposition ON queue_analyser_tasks(disposition);

-- v2 stopped writing the legacy v1 columns; relax their NOT NULL.
ALTER TABLE queue_analyser_tasks ALTER COLUMN bucket DROP NOT NULL;

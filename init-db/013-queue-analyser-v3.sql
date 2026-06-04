-- Queue Analyser v3: KB-grounded process catalog fields + two-axis triage.

ALTER TABLE queue_analyser_tasks ADD COLUMN IF NOT EXISTS kind TEXT;
ALTER TABLE queue_analyser_tasks ADD COLUMN IF NOT EXISTS urgency TEXT;
ALTER TABLE queue_analyser_tasks ADD COLUMN IF NOT EXISTS quick_win BOOLEAN;
ALTER TABLE queue_analyser_tasks ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE queue_analyser_tasks ADD COLUMN IF NOT EXISTS sla_days INTEGER;
ALTER TABLE queue_analyser_tasks ADD COLUMN IF NOT EXISTS sla_status TEXT;
ALTER TABLE queue_analyser_tasks ADD COLUMN IF NOT EXISTS wrong_queue BOOLEAN;
ALTER TABLE queue_analyser_tasks ADD COLUMN IF NOT EXISTS suggested_queue TEXT;
ALTER TABLE queue_analyser_tasks ADD COLUMN IF NOT EXISTS destination TEXT;
ALTER TABLE queue_analyser_tasks ADD COLUMN IF NOT EXISTS kb_ref TEXT;
ALTER TABLE queue_analyser_tasks ADD COLUMN IF NOT EXISTS is_new_kind BOOLEAN;
ALTER TABLE queue_analyser_tasks ADD COLUMN IF NOT EXISTS has_attachments BOOLEAN;

ALTER TABLE queue_analyser_runs ADD COLUMN IF NOT EXISTS n_quick_wins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE queue_analyser_runs ADD COLUMN IF NOT EXISTS n_overdue INTEGER NOT NULL DEFAULT 0;
ALTER TABLE queue_analyser_runs ADD COLUMN IF NOT EXISTS n_wrong_queue INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_queue_analyser_tasks_kind ON queue_analyser_tasks(kind);
CREATE INDEX IF NOT EXISTS idx_queue_analyser_tasks_urgency ON queue_analyser_tasks(urgency);

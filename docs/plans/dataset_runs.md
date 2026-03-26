# Plan: Dispute Agent — Dataset Runs

## Overview

Extends the Dataset Builder with multi-run support. A dataset has cases with ground-truth labels. Runs are separate pipeline executions against those same cases with different configs (model, prompt version, rubric weights). Each run is stored with its full config so it can be reproduced exactly. Runs appear as tabs within the dataset. Each run tab shows agreement metrics against ground-truth labels.

## Validation Commands
- `npx tsc --noEmit -p packages/backend`
- `npx tsc --noEmit -p packages/frontend`
- `npm run lint --workspace packages/backend`
- `npm run lint --workspace packages/frontend`

---

### Task 1: DB migration — run tables

- [x] Create `init-db/006-dataset-runs.sql`:

```sql
CREATE TABLE IF NOT EXISTS dataset_runs (
  id SERIAL PRIMARY KEY,
  dataset_id INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  config JSONB NOT NULL,       -- full run config: model, prompt_version, rubric_weights
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS dataset_run_cases (
  id SERIAL PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES dataset_runs(id) ON DELETE CASCADE,
  dataset_case_id INTEGER NOT NULL REFERENCES dataset_cases(id) ON DELETE CASCADE,
  pipeline_run_id INTEGER REFERENCES dispute_pipeline_runs(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(run_id, dataset_case_id)
);

CREATE INDEX idx_dataset_runs_dataset_id ON dataset_runs(dataset_id);
CREATE INDEX idx_dataset_run_cases_run_id ON dataset_run_cases(run_id);
```

- [x] Run validation commands
- [x] Mark completed

---

### Task 2: Backend — run config types and rubric override

- [x] Add to `packages/backend/src/types/dispute-pipeline.ts`:

```typescript
interface RubricWeights {
  account_trust_max: number      // default 58
  dispute_history_max: number    // default 30
  transaction_risk_max: number   // default 20
  // threshold overrides
  green_threshold: number        // default 70
  amber_threshold: number        // default 40
}

interface RunConfig {
  model: string                  // e.g. 'claude-sonnet-4-5@20250929'
  prompt_version: string         // e.g. 'dispute-planner-v1'
  rubric_weights: RubricWeights
  name: string                   // human-readable run name
}

interface DatasetRun {
  id: number
  dataset_id: number
  name: string
  config: RunConfig
  status: 'pending' | 'running' | 'completed' | 'failed'
  created_at: string
  completed_at: string | null
  // computed
  total_cases: number
  completed_cases: number
  agreement_rate: number | null  // % where planner decision matches label
  credit_precision: number | null // % of credit decisions that match label=credit
  escalate_recall: number | null  // % of label=escalate caught by planner
}

interface DatasetRunCase {
  id: number
  run_id: number
  dataset_case_id: number
  pipeline_run: PipelineRunRow | null
  label: DatasetLabel | null     // from parent dataset_case
  agreement: boolean | null      // planner decision matches label
}
```

- [x] Update `computeRubricScore` in `dispute-pipeline.ts` to accept optional `RubricWeights` parameter — falls back to defaults if not provided
- [x] Update `deriveRiskLevel` to use `green_threshold` and `amber_threshold` from weights if provided
- [x] Run validation commands
- [x] Mark completed

---

### Task 3: Backend — available prompts endpoint

- [x] In `packages/backend/src/services/prompts.ts`, add `listPrompts(): string[]` — scans the prompts directory, returns all `.md` filenames without extension (e.g. `['dispute-planner-v1', 'dispute-planner-v2']`)
- [x] Add `GET /api/datasets/run-options` endpoint returning:

```typescript
{
  models: string[]        // supported models from LLM proxy
  prompts: string[]       // available prompt versions from disk
  default_rubric: RubricWeights
}
```

Models list (hardcode for now, update when proxy adds new ones):
```
claude-sonnet-4-5@20250929
claude-sonnet-4-6
claude-opus-4-6
gemini-2.5-flash
```

- [x] Run validation commands
- [x] Mark completed

---

### Task 4: Backend — run execution

- [ ] Add DB functions to `db.ts`:
  - `insertDatasetRun(datasetId, name, config)` → returns run row
  - `insertDatasetRunCases(runId, datasetCaseIds)` → batch insert
  - `updateDatasetRunCaseResult(runCaseId, pipelineRunId)`
  - `updateDatasetRunStatus(runId, status, completedAt?)`
  - `listDatasetRuns(datasetId)` → with agreement metrics computed in SQL
  - `getDatasetRunCases(runId)` → joined with pipeline_runs and dataset_cases labels

- [ ] Add `POST /api/datasets/:id/runs` endpoint:
  1. Validate run config (model, prompt_version must be non-empty)
  2. Insert `dataset_runs` row with status `pending`
  3. Fetch all `dataset_cases` for this dataset
  4. Insert `dataset_run_cases` rows (one per dataset_case)
  5. Set status to `running`
  6. Execute pipelines in background — concurrency 3, pass `RunConfig` to `runDisputePipeline`
  7. For each completed pipeline: update `dataset_run_cases.pipeline_run_id`
  8. On all complete: set status to `completed`, stamp `completed_at`
  9. Return run immediately with status `pending` — frontend polls

- [ ] Update `runDisputePipeline` to accept optional `RunConfig` — uses config model/prompt/weights instead of env defaults when provided
- [ ] Add `GET /api/datasets/:id/runs` — list all runs for dataset with metrics
- [ ] Add `GET /api/dataset-runs/:runId/cases` — all run cases with pipeline output + label
- [ ] Run validation commands
- [ ] Mark completed

---

### Task 5: Backend — agreement metrics

- [ ] Agreement is computed at query time in `listDatasetRuns`. For each run, compute:

```sql
-- agreement_rate: planner decision matches label
-- credit decision = 'credit', escalate/hard-gate = 'escalate'
-- needs_more_info labels are excluded from metrics (not yet decided)

SELECT
  r.id,
  COUNT(rc.id) AS total_cases,
  COUNT(pr.id) AS completed_cases,
  ROUND(
    100.0 * SUM(CASE
      WHEN dc.label = 'credit' AND po->>'decision' = 'credit' THEN 1
      WHEN dc.label = 'escalate' AND po->>'decision' = 'escalate_to_agent' THEN 1
      WHEN dc.label = 'escalate' AND r2.hard_gate_triggered IS NOT NULL THEN 1
      ELSE 0
    END) / NULLIF(COUNT(CASE WHEN dc.label IN ('credit','escalate') THEN 1 END), 0),
  1) AS agreement_rate,
  -- credit precision: of cases planner said credit, what % were labeled credit
  ROUND(
    100.0 * SUM(CASE WHEN po->>'decision' = 'credit' AND dc.label = 'credit' THEN 1 ELSE 0 END)
    / NULLIF(SUM(CASE WHEN po->>'decision' = 'credit' THEN 1 ELSE 0 END), 0),
  1) AS credit_precision,
  -- escalate recall: of cases labeled escalate, what % did planner escalate
  ROUND(
    100.0 * SUM(CASE WHEN dc.label = 'escalate' AND (po->>'decision' = 'escalate_to_agent' OR r2.hard_gate_triggered IS NOT NULL) THEN 1 ELSE 0 END)
    / NULLIF(SUM(CASE WHEN dc.label = 'escalate' THEN 1 ELSE 0 END), 0),
  1) AS escalate_recall
FROM dataset_runs r
JOIN dataset_run_cases rc ON rc.run_id = r.id
JOIN dataset_cases dc ON dc.id = rc.dataset_case_id
LEFT JOIN dispute_pipeline_runs r2 ON r2.id = rc.pipeline_run_id
LEFT JOIN LATERAL (SELECT r2.planner_output) AS po(po) ON true
WHERE r.dataset_id = $1
GROUP BY r.id
```

- [ ] Expose metrics on `DatasetRun` type
- [ ] Run validation commands
- [ ] Mark completed

---

### Task 6: Frontend — dataset page with run tabs

- [ ] Update `DatasetDetail.tsx`:

**Tab structure:**
```
[Labels] [Run 1: name] [Run 2: name] ... [+ New run]
```

- Labels tab: cases with ground truth only — shows label badge per case, no pipeline output. This is the source of truth view.
- Run tabs: cases with pipeline output + ground truth label side by side + agreement indicator
- `+ New run` button: opens new run modal

**Run tab header** (above case list):
```
Model: claude-sonnet-4-5   Prompt: dispute-planner-v1   Status: completed
─────────────────────────────────────────────────────
Agreement  Credit precision  Escalate recall   Cases
   87%          94%              81%           17/17
```

**Case card in run tab:**
- Same card design as eval harness
- Top right: agreement indicator — green checkmark if planner matches label, red X if not, gray dash if label is `needs_more_info` or not yet labeled
- Ground truth label shown as a small badge below the verdict controls (read-only in run tab — labels are only editable in Labels tab)

**Loading state:** if run status is `running` or `pending`, show progress bar "Running pipeline for N cases..." with completed/total count. Poll every 3s.

- [ ] Run validation commands
- [ ] Mark completed

---

### Task 7: Frontend — new run modal

- [ ] Create `NewRunModal` component

**Fields:**
- Run name (text input, e.g. "Sonnet v2 test")
- Model (dropdown from `GET /api/datasets/run-options`)
- Prompt version (dropdown from run-options)
- Rubric weights (collapsible "Advanced" section):
  - Account Trust max (number, default 58)
  - Dispute History max (number, default 30)
  - Transaction Risk max (number, default 20)
  - Green threshold (number, default 70)
  - Amber threshold (number, default 40)
- "Create run" button

On submit: `POST /api/datasets/:id/runs` with full config. Modal closes, new tab appears with loading state.

- [ ] Run validation commands
- [ ] Mark completed

---

### Task 8: Frontend hooks and API

- [ ] Add to `api.ts`:
  - `getRunOptions()`
  - `createDatasetRun(datasetId, config)`
  - `getDatasetRuns(datasetId)`
  - `getDatasetRunCases(runId)`

- [ ] Add to `useDatasetBuilder.ts`:
  - `useRunOptions()` — query
  - `useCreateRun()` — mutation, invalidates dataset runs
  - `useDatasetRuns(datasetId)` — query
  - `useDatasetRunCases(runId)` — query, polls every 3s if run status is pending/running

- [ ] Run validation commands
- [ ] Mark completed

---

### Task 9: Integration test

- [ ] Open a dataset with labeled cases
- [ ] Click `+ New run`, configure with default settings, create — verify run tab appears with loading state
- [ ] Wait for completion — verify agreement metrics appear in tab header
- [ ] Create second run with different model — verify two run tabs exist independently
- [ ] Verify agreement indicator (✓/✗) appears per case in run tab
- [ ] Verify labels tab shows ground truth only, no pipeline output
- [ ] Verify rubric weight override changes scores in second run vs first
- [ ] Run validation commands
- [ ] Mark completed

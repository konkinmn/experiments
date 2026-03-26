# Plan: Dispute Agent — Dataset Builder

## Overview

A new section in Feature Observatory for building ground-truth eval datasets. Datasets are named entities you create, populate with cases (via preset query, case ID list, or custom SQL), and label with ground-truth verdicts. Used to measure Planner accuracy before enabling live actions.

This replaces the current hardcoded segment tabs with a flexible dataset management system.

## Validation Commands
- `npx tsc --noEmit -p packages/backend`
- `npx tsc --noEmit -p packages/frontend`
- `npm run lint --workspace packages/backend`
- `npm run lint --workspace packages/frontend`

---

### Task 1: DB migration — dataset tables

- [x] Create `init-db/007-datasets-table.sql` (used 007 since 005/006 already exist):

```sql
CREATE TABLE IF NOT EXISTS datasets (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  source_type TEXT NOT NULL CHECK (source_type IN ('preset', 'case_ids', 'custom_sql')),
  source_config JSONB NOT NULL,  -- preset name, case IDs array, or SQL string
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dataset_cases (
  id SERIAL PRIMARY KEY,
  dataset_id INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  case_id INTEGER NOT NULL,
  pipeline_run_id INTEGER REFERENCES dispute_pipeline_runs(id),
  label TEXT CHECK (label IN ('credit', 'escalate', 'needs_more_info')),
  label_notes TEXT,
  labeled_by TEXT,
  labeled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(dataset_id, case_id)
);

CREATE INDEX idx_dataset_cases_dataset_id ON dataset_cases(dataset_id);
CREATE INDEX idx_dataset_cases_label ON dataset_cases(label);
```

- [x] Run validation commands
- [x] Mark completed

---

### Task 2: Backend — preset segment queries

- [x] Create `packages/backend/src/services/dataset-segments.ts`
- [x] Define `PRESETS` array — each preset has: `key`, `label`, `description`, and a BQ query that returns `case_id` values. Reuse scammer/Railsr group UUIDs from `signals-query.ts`.

Presets:

**`clear_credit`** — strong refund candidates, ≤£25, established account:
```sql
SELECT DISTINCT c.id AS case_id
FROM `anna-money.export.case_case` c
JOIN `anna-money.export.account_customer` ac ON ac.magneta_alias = c.alias
JOIN `anna-money.export.case_case_artifact` a ON a.case_id = c.id
JOIN `anna-money.trusted.business_account__processed_transactions` t ON t.id = a.artifact_id
WHERE c.issue_type_id = 'dispute'
  AND c.status = 'RESOLVED'
  AND c.outcome = 'CUSTOMER_REFUNDED'
  AND a.artifact_type = 'TRANSACTION'
  AND ABS(t.amount) <= 25
  AND DATE_DIFF(DATE(c.created_at), DATE(ac.created_at), DAY) >= 365
  AND c.created_at >= TIMESTAMP('2026-01-01')
ORDER BY c.created_at DESC
LIMIT 30
```

**`hard_gate`** — cases with CIFAS or scammer flag:
```sql
SELECT DISTINCT c.id AS case_id
FROM `anna-money.export.case_case` c
LEFT JOIN `anna-money.export.cifas_matches` cf ON cf.alias = c.alias
WHERE c.issue_type_id = 'dispute'
  AND c.status = 'RESOLVED'
  AND c.created_at >= TIMESTAMP('2026-01-01')
  AND cf.id IS NOT NULL
ORDER BY c.created_at DESC
LIMIT 20
```

**`missing_evidence`** — fraud claim, no crime reference in case actions:
```sql
SELECT DISTINCT c.id AS case_id
FROM `anna-money.export.case_case` c
JOIN `anna-money.trusted.business_account__processed_transactions` t
  ON t.alias = c.alias
WHERE c.issue_type_id = 'dispute'
  AND c.status = 'RESOLVED'
  AND c.created_at >= TIMESTAMP('2026-01-01')
  AND NOT EXISTS (
    SELECT 1 FROM `anna-money.export.case_case_artifact` a
    WHERE a.case_id = c.id AND a.artifact_type = 'CASE_ACTION'
  )
ORDER BY c.created_at DESC
LIMIT 20
```

**`out_of_scope`** — transaction >£25:
```sql
SELECT DISTINCT c.id AS case_id
FROM `anna-money.export.case_case` c
JOIN `anna-money.export.case_case_artifact` a ON a.case_id = c.id
JOIN `anna-money.trusted.business_account__processed_transactions` t ON t.id = a.artifact_id
WHERE c.issue_type_id = 'dispute'
  AND c.status = 'RESOLVED'
  AND a.artifact_type = 'TRANSACTION'
  AND ABS(t.amount) > 25
  AND ABS(t.amount) <= 500
  AND c.created_at >= TIMESTAMP('2026-01-01')
ORDER BY c.created_at DESC
LIMIT 20
```

**`recent`** — general recent resolved disputes, no filter (borderline and complex emerge from rubric scores):
```sql
SELECT DISTINCT c.id AS case_id
FROM `anna-money.export.case_case` c
WHERE c.issue_type_id = 'dispute'
  AND c.status = 'RESOLVED'
  AND c.created_at >= TIMESTAMP('2026-01-01')
ORDER BY c.created_at DESC
LIMIT 30
```

- [x] Export `getPresets(): PresetInfo[]` and `runPresetQuery(key: string): Promise<number[]>`
- [x] Export `runCustomSql(sql: string): Promise<number[]>` — executes arbitrary BQ SQL, validates result has `case_id` column, returns array of integers. Reject if query returns >100 rows.
- [x] Run validation commands
- [x] Mark completed

---

### Task 3: Backend — dataset API routes

- [x] Create `packages/backend/src/routes/dataset.ts`

Endpoints:

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/datasets` | List all datasets with labeled/total counts |
| `POST` | `/api/datasets` | Create dataset + resolve case IDs + run pipeline for each |
| `GET` | `/api/datasets/:id` | Get dataset with all cases and pipeline run data |
| `DELETE` | `/api/datasets/:id` | Delete dataset and all its cases |
| `PATCH` | `/api/dataset-cases/:id/label` | Save label, notes, labeled_by |
| `DELETE` | `/api/dataset-cases/:id` | Remove a case from dataset |
| `GET` | `/api/datasets/presets` | List available preset segment definitions |

**`POST /api/datasets` logic:**
1. Validate request: name, description, source_type, source_config
2. Resolve case IDs:
   - `preset`: call `runPresetQuery(source_config.preset_key)`
   - `case_ids`: parse `source_config.ids` as integer array, validate all are positive integers
   - `custom_sql`: call `runCustomSql(source_config.sql)`
3. Insert dataset row
4. Insert dataset_cases rows (one per case_id, no pipeline_run_id yet)
5. Run pipelines in background — concurrency limit 3, save pipeline_run_id back to dataset_cases as each completes
6. Return dataset immediately with `status: 'loading'` — frontend polls until all pipeline_run_ids are populated

- [x] Add DB functions to `db.ts`: `insertDataset`, `listDatasets`, `getDataset`, `deleteDataset`, `insertDatasetCases`, `updateDatasetCaseLabel`, `updateDatasetCasePipelineRun`, `deleteDatasetCase`
- [x] Register route in `app.ts`
- [x] Run validation commands
- [x] Mark completed

---

### Task 4: Backend types

- [x] Add to `packages/backend/src/types/dispute-pipeline.ts`:

```typescript
type DatasetLabel = 'credit' | 'escalate' | 'needs_more_info'
type DatasetSourceType = 'preset' | 'case_ids' | 'custom_sql'

interface Dataset {
  id: number
  name: string
  description: string | null
  source_type: DatasetSourceType
  source_config: Record<string, unknown>
  created_at: string
  total_cases: number
  labeled_cases: number
}

interface DatasetCase {
  id: number
  dataset_id: number
  case_id: number
  pipeline_run_id: number | null
  pipeline_run: PipelineRunRow | null
  label: DatasetLabel | null
  label_notes: string | null
  labeled_by: string | null
  labeled_at: string | null
  created_at: string
}

interface PresetInfo {
  key: string
  label: string
  description: string
}
```

- [x] Run validation commands
- [x] Mark completed

---

### Task 5: Frontend — Datasets list page

- [x] Create `packages/frontend/src/pages/DatasetBuilder.tsx` — the datasets list
- [x] Register route `/dataset` in `App.tsx`
- [x] Add sidebar link "Dataset Builder" in `Sidebar.tsx`

**Layout:**

Page header: "Dataset Builder" + "New dataset" button

Datasets list: each dataset rendered as a card showing:
- Name (bold), description
- Source type badge (Preset / Case IDs / Custom SQL)
- Progress bar: N labeled / total
- Created date
- Click → navigate to `/dataset/:id`
- Delete button (with confirmation)

Empty state: "No datasets yet. Create one to start labeling."

**"New dataset" modal:**

Fields:
- Name (text input, required)
- Description (optional textarea)
- Source (radio: Preset segment / Case ID list / Custom SQL)

When Preset selected: dropdown of presets from `GET /api/datasets/presets`, each showing label + description

When Case ID list selected: textarea placeholder "Enter case IDs, one per line or comma-separated"

When Custom SQL selected: monospace textarea for BQ SQL, with note "Query must return a `case_id` column. Max 100 rows."

"Create" button — on submit, calls `POST /api/datasets`, closes modal, navigates to new dataset page.

- [x] Run validation commands
- [x] Mark completed

---

### Task 6: Frontend — Dataset detail page

- [x] Create `packages/frontend/src/pages/DatasetDetail.tsx`
- [x] Register route `/dataset/:id` in `App.tsx`

**Layout:** Identical to Dispute Agent Eval page (`/rubric-tester`) with these differences:

- Page header shows dataset name + description + back link to `/dataset`
- Session summary: Total Cases / Labeled / Credit / Escalate / Needs More Info
- Cases list: reuse the existing `ResultsTable` component — add a `verdictOptions` prop that accepts either `['correct', 'incorrect']` (eval harness mode) or `['credit', 'escalate', 'needs_more_info']` (dataset mode)
- Loading state: if `pipeline_run_id` is null for a case, show a skeleton/spinner in place of the card body with "Running pipeline..."
- Export button: XLSX with case_id, dataset name, planner decision, label, notes, rubric score, key signals

**ResultsTable changes:**
- Add `verdictOptions: 'eval' | 'dataset'` prop
- In dataset mode, render Credit / Escalate / Needs more info buttons instead of Correct / Incorrect
- Verdict submission calls `PATCH /api/dataset-cases/:id/label` instead of the eval harness endpoint

**Card design must be identical to eval harness — same component, same layout:**
- Card header: Case ID, Risk badge (Green/Amber/Red), Decision badge (Credit/Escalate/Hard-gate), Duration, Label status
- Planner Thought: full reasoning as left-bordered blockquote
- Decision row: badge + credit timing
- Uncertainty Factors: gray chip per factor
- Dispute Profile section: Green/Amber/Red risk badge, rubric score (N/108), category score bar (Account Trust / Dispute History / Txn Risk), signal grid with point values (+20, +5 etc.), risk factor badges
- Reviewer Verdict: Credit / Escalate / Needs more info buttons + optional notes input
- Raw BQ Data: collapsible section at bottom
- If `pipeline_run_id` is null: show skeleton placeholder with "Running pipeline..." instead of card body

- [x] Run validation commands
- [x] Mark completed

---

### Task 7: Frontend hooks and API client

- [x] Add to `packages/frontend/src/lib/api.ts`:
  - `getDatasets()`
  - `getDatasetPresets()`
  - `createDataset(name, description, sourceType, sourceConfig)`
  - `getDataset(id)`
  - `deleteDataset(id)`
  - `labelDatasetCase(id, label, notes, labeledBy)`
  - `deleteDatasetCase(id)`

- [x] Create `packages/frontend/src/hooks/useDatasetBuilder.ts`:
  - `useDatasets()` — query, invalidated on create/delete
  - `useDatasetPresets()` — query
  - `useCreateDataset()` — mutation
  - `useDataset(id)` — query, polls every 3s if any cases have null pipeline_run_id
  - `useDeleteDataset()` — mutation
  - `useLabelDatasetCase()` — mutation, invalidates dataset
  - `useDeleteDatasetCase()` — mutation, invalidates dataset

- [x] Run validation commands
- [x] Mark completed

---

### Task 8: Integration test

- [ ] Navigate to `/dataset` — verify empty state shows
- [ ] Create dataset using "Clear credit" preset — verify modal works, dataset card appears, navigates to detail page
- [ ] On detail page — verify cases load with pipeline results (may take 30-60s for batch)
- [ ] Label one case Credit, one Escalate, one Needs more info — verify labels persist on reload
- [ ] Create second dataset using Case ID list — enter 3 case IDs manually, verify all three run
- [ ] Create third dataset using Custom SQL — enter valid BQ query returning case_ids, verify it runs
- [ ] Delete a dataset — verify it disappears from list
- [ ] Export XLSX from a labeled dataset — verify label column present
- [ ] Run validation commands
- [ ] Mark completed

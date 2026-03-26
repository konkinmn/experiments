# Plan: Dispute Agent — Dataset Builder

## Overview

A new page in Feature Observatory for building the ground-truth eval dataset. Unlike the eval harness (which tests cases one at a time ad-hoc), the dataset builder finds candidate cases by segment, runs them through the pipeline in batch, and lets a labeler assign ground-truth verdicts.

The output is a labeled dataset used to measure Planner accuracy before enabling live actions.

## Validation Commands
- `npx tsc --noEmit -p packages/backend`
- `npx tsc --noEmit -p packages/frontend`
- `npm run lint --workspace packages/backend`
- `npm run lint --workspace packages/frontend`

---

### Task 1: DB migration — dataset tables

- [x] Create `init-db/006-dataset-builder.sql` with two tables:

```sql
CREATE TABLE IF NOT EXISTS dataset_cases (
  id SERIAL PRIMARY KEY,
  case_id INTEGER NOT NULL,
  segment TEXT NOT NULL,
  pipeline_run_id INTEGER REFERENCES dispute_pipeline_runs(id),
  label TEXT CHECK (label IN ('credit', 'escalate', 'needs_more_info')),
  label_notes TEXT,
  labeled_by TEXT,
  labeled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(case_id)
);

CREATE INDEX idx_dataset_cases_segment ON dataset_cases(segment);
CREATE INDEX idx_dataset_cases_label ON dataset_cases(label);
```

- [x] Run validation commands
- [x] Mark completed

---

### Task 2: Backend — segment query definitions

- [ ] Create `packages/backend/src/services/dataset-segments.ts` with one BQ query per segment. Each query returns `case_id` values only — no signals, just IDs. Signals are fetched when the pipeline runs.

Segments and their logic:

**`clear_credit`** — strong candidates for correct credit decision:
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

**`hard_gate`** — cases that should immediately escalate:
```sql
SELECT DISTINCT c.id AS case_id
FROM `anna-money.export.case_case` c
LEFT JOIN `anna-money.export.cifas_matches` cf ON cf.alias = c.alias
LEFT JOIN `anna-money.export.task_manager_agent_tasks` scam
  ON scam.alias = c.alias AND scam.group_id = '...' -- scammer group UUID
WHERE c.issue_type_id = 'dispute'
  AND c.status = 'RESOLVED'
  AND c.created_at >= TIMESTAMP('2026-01-01')
  AND (cf.id IS NOT NULL OR scam.id IS NOT NULL)
ORDER BY c.created_at DESC
LIMIT 20
```

**`missing_evidence`** — fraud claimed but no crime reference:
```sql
SELECT DISTINCT c.id AS case_id
FROM `anna-money.export.case_case` c
JOIN `anna-money.export.workstation_case_actions` ca ON ca.case_id = c.id
WHERE c.issue_type_id = 'dispute'
  AND c.status = 'RESOLVED'
  AND ca.action_type = 'DISPUTE_FORM_FILLED'
  AND JSON_EXTRACT_SCALAR(ca.metadata, '$.crime_ref_number') IS NULL
  AND c.created_at >= TIMESTAMP('2026-01-01')
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

**`borderline`** and **`complex`** — these cannot be pre-filtered by BQ alone. Return recent resolved dispute cases and let the pipeline compute the rubric score. Borderline cases will emerge from the scored results (40–70 range). Complex cases are manually identified during labeling.

- [ ] Export `SEGMENTS` constant — array of segment names with label and description
- [ ] Export `fetchSegmentCaseIds(segment: string): Promise<number[]>` — runs the appropriate query, returns up to 30 case IDs
- [ ] Run validation commands
- [ ] Mark completed

---

### Task 3: Backend — dataset API routes

- [ ] Create `packages/backend/src/routes/dataset.ts` with these endpoints:

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/dataset/segments` | List all segments with name, label, description, count of labeled cases |
| `POST` | `/api/dataset/segments/:segment/load` | Fetch case IDs for segment from BQ, run pipeline for each, save to dataset_cases + dispute_pipeline_runs. Returns array of results. |
| `GET` | `/api/dataset/cases` | List all dataset cases with pipeline run data, optionally filtered by segment |
| `PATCH` | `/api/dataset/cases/:id/label` | Save label (credit/escalate/needs_more_info), notes, labeled_by |
| `DELETE` | `/api/dataset/cases/:id` | Remove a case from the dataset |

- [ ] `POST /load` runs pipelines in parallel with concurrency limit of 3 (avoid BQ rate limits)
- [ ] If a case_id already exists in `dataset_cases`, skip it (don't re-run pipeline)
- [ ] Register route in `app.ts`
- [ ] Add DB functions to `db.ts`: `insertDatasetCase`, `listDatasetCases`, `updateDatasetLabel`, `deleteDatasetCase`
- [ ] Run validation commands
- [ ] Mark completed

---

### Task 4: Backend types

- [ ] Add to `packages/backend/src/types/dispute-pipeline.ts`:

```typescript
type DatasetLabel = 'credit' | 'escalate' | 'needs_more_info'

interface DatasetCase {
  id: number
  case_id: number
  segment: string
  pipeline_run_id: number | null
  pipeline_run: PipelineRunRow | null   // joined
  label: DatasetLabel | null
  label_notes: string | null
  labeled_by: string | null
  labeled_at: string | null
  created_at: string
}

interface SegmentInfo {
  key: string
  label: string
  description: string
  labeled_count: number
  total_count: number
}
```

- [ ] Run validation commands
- [ ] Mark completed

---

### Task 5: Frontend — Dataset Builder page

- [ ] Create `packages/frontend/src/pages/DatasetBuilder.tsx`
- [ ] Register route `/dataset` in `App.tsx`
- [ ] Add sidebar link "Dataset Builder" in `Sidebar.tsx`

**Page layout:**

Top: segment selector — row of pills (Clear credit, Hard gate, Missing evidence, Out of scope, Borderline, Complex). Each pill shows labeled/total count. Selected segment is highlighted.

Below segment selector: "Load cases" button — triggers `POST /load` for that segment. Shows loading state with "Running pipeline for N cases..." message. Disabled if cases already loaded.

Cases list: same card design as eval harness. Each card shows:
- Case ID, Risk badge, Planner decision badge, Duration
- Planner thought (blockquote)
- Dispute profile (rubric score bar, key signals)
- Uncertainty factors
- **Label controls:** three buttons — Credit / Escalate / Needs more info — plus optional notes input
- Labeled state: shows who labeled it and when if already labeled

Session summary bar: Total cases / Labeled / Credit / Escalate / Needs more info

Export button: XLSX with case_id, segment, pipeline decision, label, notes, rubric score, key signals.

- [ ] Run validation commands
- [ ] Mark completed

---

### Task 6: Frontend hooks and API client

- [ ] Add to `packages/frontend/src/lib/api.ts`:
  - `getSegments()`
  - `loadSegmentCases(segment)`
  - `getDatasetCases(segment?)`
  - `labelDatasetCase(id, label, notes, labeledBy)`
  - `deleteDatasetCase(id)`

- [ ] Create `packages/frontend/src/hooks/useDatasetBuilder.ts`:
  - `useSegments()` — query
  - `useDatasetCases(segment?)` — query
  - `useLoadSegment()` — mutation, invalidates cases + segments
  - `useLabelCase()` — mutation, invalidates cases + segments
  - `useDeleteDatasetCase()` — mutation

- [ ] Run validation commands
- [ ] Mark completed

---

### Task 7: Integration test

- [ ] Navigate to `/dataset`
- [ ] Select "Clear credit" segment, click "Load cases" — verify pipeline runs for multiple cases and cards appear
- [ ] Label one case as "Credit" — verify label persists on reload
- [ ] Label one case as "Needs more info" with a note — verify note saves
- [ ] Select "Hard gate" segment, load cases — verify at least one hard-gated case appears
- [ ] Export XLSX — verify it contains segment column and label column
- [ ] Run validation commands
- [ ] Mark completed

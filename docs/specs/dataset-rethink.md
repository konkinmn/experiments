# Dataset Builder Rethink — Specification

## Problem

The current Dataset Builder answers one question: "Does the pipeline agree with a human on a batch of cases?" It produces three numbers per run: agreement rate, credit precision, and escalate recall. This is not enough to prove the LLM auto-credit pipeline is safe to deploy.

### What's missing

1. **No safety proof by segment.** A model that's 90% accurate overall but 60% accurate on high-risk cases is dangerous. There's no way to break down metrics by risk level, dispute type, or rubric score.

2. **No confusion matrix.** The single "agreement rate" hides the most dangerous failure mode: **false credits** (cases the pipeline auto-credited but should have been escalated). This is asymmetric — a false credit costs real money, a false escalation just costs agent time.

3. **No case quality control.** Not all cases are well-built for evaluation. There's no way to exclude bad cases without deleting them, and no way to tag or categorize cases for analysis.

4. **No structured error analysis.** When the pipeline disagrees with a human, there's no way to understand _why_ — was it bad signals, wrong rubric scoring, flawed LLM reasoning, or a wrong human label?

5. **No regression detection.** When changing models or prompts, there's no way to see which cases flipped from correct to incorrect.

6. **Weak ground truth.** Single labeler, no confidence tracking, no inter-annotator agreement.

---

## Solution: Evaluation & Safety Assurance Platform

Transform the Dataset Builder from a simple batch-and-count tool into a platform that can produce a rigorous safety report. Implemented in phases, with Phase 1 (stratified analytics) as the immediate priority.

---

## Phase 1: Stratified Analytics (Implementing Now)

### Goal

Enable the team to produce a safety report that shows: "The pipeline's false credit rate is X% overall, Y% on green cases, Z% on red cases, and here's the full confusion matrix."

### Data Model Changes

#### New columns on `dataset_cases`

| Column | Type | Default | Purpose |
|--------|------|---------|---------|
| `auto_tags` | JSONB | `'{}'` | Auto-derived metadata from pipeline output |

#### Auto-tags schema

Populated automatically when a pipeline run completes for a dataset case. Derived deterministically from `dispute_pipeline_runs` data:

```json
{
  "risk_level": "green | amber | red",
  "amount_bucket": "under_25",
  "rubric_score_bucket": "0-39 | 40-69 | 70-108",
  "hard_gate_hit": true | false,
  "dispute_type": "STOLEN_CARD_FRAUD | ... | unknown",
  "dispute_sub_type": "PIN_USED | ... | unknown",
  "has_uncertainty": true | false,
  "merchant": "merchant name(s)"
}
```

**Why JSONB:** The tag vocabulary will evolve as the team discovers new stratification dimensions. JSONB avoids schema churn. The frontend reads known keys; unknown keys are ignored. Tags can be re-derived at any time.

### New API Endpoints

#### `GET /api/datasets/:id/analytics?runId=N`

Computes analytics on-the-fly via SQL aggregation.

- When `runId` omitted: uses baseline pipeline runs from the Labels tab
- When `runId` provided: uses pipeline runs from that specific named run

**Response:**

```typescript
{
  confusion_matrix: {
    true_credit: number;      // Pipeline: credit, Human: credit
    false_credit: number;     // Pipeline: credit, Human: escalate (DANGEROUS)
    true_escalate: number;    // Pipeline: escalate, Human: escalate
    false_escalate: number;   // Pipeline: escalate, Human: credit
    unlabeled: number;        // No human label
    undecided: number;        // Human labeled "undecided" (can't decide yet)
  };

  overall: {
    agreement_rate: number | null;
    credit_precision: number | null;
    escalate_recall: number | null;
    false_credit_rate: number | null;  // false_credit / (true_credit + false_credit)
    sample_size: number;               // labeled cases only (excl. undecided)
  };

  stratified: {
    by_risk_level: Record<'green' | 'amber' | 'red', SegmentMetrics>;
    by_dispute_type: Record<string, SegmentMetrics>;
    by_hard_gate: Record<'hit' | 'clear', SegmentMetrics>;
    by_rubric_bucket: Record<string, SegmentMetrics>;
  };
}
```

Where:

```typescript
interface SegmentMetrics {
  sample_size: number;
  agreement_rate: number | null;
  credit_precision: number | null;
  escalate_recall: number | null;
  false_credit_rate: number | null;
}
```

Null metrics returned when sample_size is 0. Frontend shows warning icon when sample_size < 10.

#### Modified: `GET /api/datasets/:id/runs`

Extended to also return `false_credit_rate` per run alongside existing `agreement_rate`, `credit_precision`, `escalate_recall`.

### Frontend Changes

#### New tab: "Analytics" on DatasetDetail page

Appears between "Labels" and the first run tab. Contains:

1. **Run selector** — dropdown to pick baseline (Labels tab data) or a specific named run
2. **Confusion matrix** — 2x2 colored grid
   - Top-left (green): True Credit (pipeline credit + human credit)
   - Top-right (red): False Credit (pipeline credit + human escalate) — **highlighted as danger**
   - Bottom-left (amber): False Escalate (pipeline escalate + human credit)
   - Bottom-right (green): True Escalate (pipeline escalate + human escalate)
   - Shows both count and percentage
3. **Overall metrics card** — agreement, precision, recall, **false credit rate prominently displayed**
4. **Stratified breakdown tables** — collapsible sections for each dimension:
   - By Risk Level (green/amber/red)
   - By Dispute Type (from planner args)
   - By Hard Gate (hit/clear)
   - By Rubric Score Bucket (0-39/40-69/70-108)
   - Each row: segment name, sample size, agreement, precision, recall, false credit rate
   - Warning icon when segment has < 10 cases

#### New components

| Component | Purpose |
|-----------|---------|
| `AnalyticsTab.tsx` | Container with run selector + all analytics sections |
| `ConfusionMatrix.tsx` | 2x2 grid visualization with counts and percentages |
| `StratifiedMetrics.tsx` | Collapsible per-segment metric tables |

#### Modified: Run list metrics

`false_credit_rate` shown alongside existing metrics in the run tab header.

### Auto-tag Derivation

New service function in `packages/backend/src/services/dataset-analytics.ts`:

```typescript
function deriveAutoTags(pipelineRun: PipelineRunRow): Record<string, string | boolean> {
  const score = pipelineRun.dispute_profile.rubric_score;
  return {
    risk_level: pipelineRun.dispute_profile.risk_level,
    amount_bucket: 'under_25',  // all cases are sub-£25
    rubric_score_bucket: score >= 70 ? '70-108' : score >= 40 ? '40-69' : '0-39',
    hard_gate_hit: !!pipelineRun.hard_gate_triggered,
    dispute_type: pipelineRun.planner_output?.args?.fraud_type ?? 'unknown',
    dispute_sub_type: pipelineRun.planner_output?.args?.fraud_sub_type ?? 'unknown',
    has_uncertainty: (pipelineRun.planner_output?.uncertainty_factors?.length ?? 0) > 0,
    merchant: pipelineRun.raw_signals.merchants,
  };
}
```

Called automatically:
1. When a pipeline run completes for a dataset case (in existing POST `/api/datasets` background handler)
2. When a run's pipeline completes (in existing POST `/api/datasets/:id/runs` background handler)
### Analytics SQL Strategy

All analytics computed on-the-fly. With max 500 cases per dataset, performance is trivial. The query joins `dataset_cases` (or `dataset_run_cases`) with `dispute_pipeline_runs` and aggregates using CASE expressions, grouped by tag dimensions.

For baseline analytics:
```sql
SELECT
  dc.auto_tags->>'risk_level' as segment,
  COUNT(*) as sample_size,
  COUNT(CASE WHEN dc.label = 'credit' AND pr.planner_output->>'decision' = 'credit' THEN 1 END) as true_credit,
  COUNT(CASE WHEN dc.label = 'escalate' AND pr.planner_output->>'decision' = 'credit' THEN 1 END) as false_credit,
  -- ... etc
FROM dataset_cases dc
JOIN dispute_pipeline_runs pr ON pr.id = dc.pipeline_run_id
WHERE dc.dataset_id = $1 AND dc.label IS NOT NULL AND dc.label != 'undecided'
GROUP BY dc.auto_tags->>'risk_level'
```

For run analytics: same pattern but joining through `dataset_run_cases` instead.

---

## Phase 2: Case Quality Control (Future)

- **Manual tags** (user-applied text tags for categorization)
- **Filter/sort** on Labels tab by tags, risk level, label status
- **Case tag editor** component

### Schema
```sql
ALTER TABLE dataset_cases ADD COLUMN manual_tags TEXT[] DEFAULT '{}';
```

### Endpoints
- `PATCH /api/datasets/cases/:id/tags` — set manual tags

---

## Phase 3: Richer Labeling (Future)

- **Label confidence** (high/medium/low) — how sure is the labeler?
- **Disagreement tracking** — when label != pipeline decision, categorize why
- **Disagreement reasons:** `signal_quality`, `rubric_issue`, `llm_reasoning`, `human_label_wrong`, `edge_case`, `other`
- Auto-prompt for disagreement reason when saving a conflicting label (soft prompt, dismissible)

### Schema
```sql
ALTER TABLE dataset_cases ADD COLUMN label_confidence TEXT CHECK (label_confidence IN ('high', 'medium', 'low'));
ALTER TABLE dataset_cases ADD COLUMN disagreement_reason TEXT CHECK (disagreement_reason IN ('signal_quality', 'rubric_issue', 'llm_reasoning', 'human_label_wrong', 'edge_case', 'other'));
ALTER TABLE dataset_cases ADD COLUMN disagreement_notes TEXT;

-- Same on dataset_run_cases
ALTER TABLE dataset_run_cases ADD COLUMN label_confidence TEXT CHECK (...);
ALTER TABLE dataset_run_cases ADD COLUMN disagreement_reason TEXT CHECK (...);
ALTER TABLE dataset_run_cases ADD COLUMN disagreement_notes TEXT;
```

### Analytics extension
- Accuracy by confidence level
- Disagreement reason breakdown chart

---

## Phase 4: Run Comparison & Regression Detection (Future)

- **Compare endpoint** `GET /api/datasets/:id/compare?runA=N&runB=N`
- Side-by-side metric cards with delta arrows
- **Flipped cases table:** cases that went correct→incorrect (red, regressed) or incorrect→correct (green, improved)
- Net improvement/regression count

### Response shape
```typescript
{
  summary: {
    runA: MetricsSummary;
    runB: MetricsSummary;
    delta: MetricsSummary;
  };
  flipped_cases: Array<{
    caseId: number;
    label: DatasetLabel;
    runA_decision: string;
    runB_decision: string;
    direction: 'improved' | 'regressed' | 'changed';
  }>;
  net_improvement: number;
}
```

---

## Phase 5: Dual Labeling & Dataset Composition (Future)

### Dual labeling
- Second labeler mode (writes to `label_2` fields)
- Inter-annotator agreement (Cohen's kappa)
- Cases with both labels shown in analytics

### Dataset composition
- Merge multiple hand-picked datasets into a larger evaluation set
- `dataset_compositions` table (parent/child references)
- Compose endpoint + modal

### Schema
```sql
ALTER TABLE dataset_cases ADD COLUMN label_2 TEXT CHECK (...);
ALTER TABLE dataset_cases ADD COLUMN label_2_notes TEXT;
ALTER TABLE dataset_cases ADD COLUMN label_2_by TEXT;
ALTER TABLE dataset_cases ADD COLUMN label_2_at TIMESTAMPTZ;
ALTER TABLE dataset_cases ADD COLUMN label_2_confidence TEXT CHECK (...);

CREATE TABLE dataset_compositions (
  id SERIAL PRIMARY KEY,
  parent_dataset_id INTEGER REFERENCES datasets(id) ON DELETE CASCADE,
  child_dataset_id INTEGER REFERENCES datasets(id) ON DELETE CASCADE,
  UNIQUE(parent_dataset_id, child_dataset_id)
);
```

---

## Metric Hierarchy

Structured by purpose — safety metrics are non-negotiable, efficiency metrics are optimized, quality metrics inform improvements.

| Priority | Metric | What it measures |
|----------|--------|-----------------|
| **Safety** | False credit rate (overall) | % of auto-credits that were wrong |
| **Safety** | False credit rate (by risk level) | Must be near-zero on amber/red segments |
| **Efficiency** | Auto-credit rate | % of cases not needing human review |
| **Efficiency** | Correct escalation rate | % of escalations humans agree with |
| **Quality** | Per-segment accuracy | Where does the model struggle? |
| **Quality** | Label confidence distribution | Are labels trustworthy? |
| **Quality** | Inter-annotator agreement | Do labelers agree with each other? |

---

## Files Affected (Phase 1)

| File | Change |
|------|--------|
| `packages/backend/src/services/db.ts` | Migration for new columns, analytics query functions |
| `packages/backend/src/routes/dataset.ts` | New analytics endpoint, auto-tag on pipeline completion |
| `packages/frontend/src/pages/DatasetDetail.tsx` | Add Analytics tab, false_credit_rate in run headers |
| `packages/frontend/src/types/dataset-builder.ts` | New types (ConfusionMatrix, SegmentMetrics, DatasetAnalytics, extended DatasetCase) |
| `packages/frontend/src/hooks/useDatasetBuilder.ts` | New hook (useDatasetAnalytics) |
| `packages/frontend/src/lib/api.ts` | New API client functions |
| **New:** `packages/backend/src/services/dataset-analytics.ts` | deriveAutoTags + analytics computation |
| **New:** `packages/frontend/src/components/dataset-builder/AnalyticsTab.tsx` | Analytics container |
| **New:** `packages/frontend/src/components/dataset-builder/ConfusionMatrix.tsx` | 2x2 grid |
| **New:** `packages/frontend/src/components/dataset-builder/StratifiedMetrics.tsx` | Per-segment tables |

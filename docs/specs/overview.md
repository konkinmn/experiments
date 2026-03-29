# Dispute Agent — System Overview

## What This Is

An AI agent that automates dispute case triage at ANNA. It decides: **"Can this case be safely credited now, or should a human handle it?"**

Currently running in **shadow mode** — the pipeline executes and logs decisions, but takes no live actions. The eval harness (Dataset Builder) measures accuracy before going live.

**Q1 OKR:** 50% of eligible disputes resolved without human intervention.

---

## Architecture — Five Layers

```
Dispute form submitted
        ↓
Layer 0 — Signal fetch + dispute profile (configurable rubric scoring)
        ↓
Layer 1 — Hard gates (deterministic, pre-LLM, toggleable per run)
        ↓ (if clear)
Layer 2 — Planner (LLM, configurable model + prompt per run)
        ↓
Layer 3 — Executor (shadow-only for now)
        ↓
Layer 4 — Audit log
```

### Layer 0 — Signal Fetch + Dispute Profile

Fetches 15+ signals from BigQuery via a single CTE query and scores them on a **configurable rubric** (default max 108):

| Category | Default Max | Key Factors |
|----------|-------------|-------------|
| Account Trust | 58 | Account age (up to 20), tier (up to 10), money maker badge (15), trust score (up to 8), activity (5) |
| Dispute History | 30 | Clean 6-month history (up to 30), penalties for recent disputes (-5 each), scam victim (-5) |
| Transaction Risk | 20 | Amount: <£5 → 20pts, £25+ → 0pts |

**Default thresholds:** Score >= 70 = green, 40–69 = amber, <40 = red.

All scoring rules (breakpoints, point values, penalties) are configurable per run via `RubricScoringRules`. All signals are DB lookups — no hallucination risk on binary inputs.

### Layer 1 — Hard Gates

Run before LLM. If any enabled gate fires → immediate escalation, no LLM call.

| Priority | Gate | Condition | Default |
|----------|------|-----------|---------|
| 1 | CIFAS hit | `cifas_count > 0` | On |
| 2 | Confirmed scammer | `scammer_count > 0` | On |
| 3 | Account inactive | `account_status !== ACCOUNT_IS_ACTIVE` | On |
| 4 | Recent Railsr dispute | `railsr_disputes_last_6_months > 0` | On |

Each gate can be toggled on/off per run via `HardGateConfig` — e.g., disable CIFAS to test impact on decisions.

### Layer 2 — Planner (LLM)

Receives a context package and outputs a structured JSON decision.

**Input:**
- Dispute profile (rubric score, risk level, all signals, risk factors)
- Case metadata (issue_type_id, created_at)
- Raw signals (tx_count_90d, active_months, prior_payments_to_merchant)
- Case actions (DISPUTE_FORM_FILLED with crime_ref_number)
- Customer dialogue messages (customer-only, last 50)
- Artifact descriptions (PDFs/images pre-parsed with Google Gemini)

**Output:**
```typescript
{
  thought: string              // full reasoning chain
  decision: "credit" | "escalate_to_agent"
  credit_timing: "immediately" | "none"
  args?: {                     // only when decision = "credit"
    is_dispute: false
    is_fraud: boolean
    credit_mode: "IMMEDIATELY"
    reason: "NOT_AUTHORISED" | "DIFFERENT_AMOUNT" | "DUPLICATE" | "NO_FUNDS_FROM_ATM" | "OTHER"
    fraud_type?: FraudType
    fraud_sub_type?: FraudSubType
    crime_reference?: string
  }
  uncertainty_factors: string[]
}
```

**Key constraints:** Credit only if account 365+ days, amount <£25, clean profile, required info provided. When in doubt → escalate. Parse failure → auto-escalate.

**Model and prompt are fully configurable per run** — default model from `LLM_MODEL` env var (fallback: `claude-sonnet-4-5@20250929`), default prompt: `dispute-planner-v1.md`. Both are editable free-text in the New Run modal. Full prompt text stored per run.

### Layer 3 — Executor (Shadow Only)

Currently hardcoded to `'shadow'`. No live actions. When enabled:
- `credit` → POST `TaskCreationRequest` to anna-disputes API
- `escalate_to_agent` → Create WorkStation task with summary

### Layer 4 — Audit Log

Every pipeline run is persisted to `dispute_pipeline_runs` with full context: signals, profile, planner request/response, system prompt, enrichment metadata.

---

## Pipeline Configuration (`PipelineConfig`)

All pipeline rules are configurable per dataset run. The New Run modal shows defaults that can be edited:

```typescript
interface PipelineConfig {
  hard_gates: {
    cifas: boolean;                    // default: true
    confirmed_scammer: boolean;        // default: true
    account_not_active: boolean;       // default: true
    railsr_dispute_last_6_months: boolean; // default: true
  };
  rubric_weights: {
    account_trust_max: number;         // default: 58
    dispute_history_max: number;       // default: 30
    transaction_risk_max: number;      // default: 20
    green_threshold: number;           // default: 70
    amber_threshold: number;           // default: 40
  };
  scoring_rules: {
    account_age: Array<{ min_days: number; points: number }>;
    tier: Record<string, number>;      // e.g. { E: 10, D: 8, C: 5 }
    money_maker_points: number;        // default: 15
    trust_score: Record<string, number>; // e.g. { GREEN: 8, AMBER: 4 }
    tx_activity: { min_count: number; points: number };
    dispute_history: Array<{ max_disputes: number; points: number }>;
    recent_dispute_penalty: number;    // default: -5
    scam_victim_penalty: number;       // default: -5
    amount_brackets: Array<{ max_amount: number; points: number }>;
  };
}
```

The New Run modal shows a live "Max possible score" summary that updates as you change values.

Stored in `dataset_runs.config` JSONB alongside model, prompt text, and run name.

---

## AI Iteration Artifact

Each pipeline run produces an `AIIterationArtifact` — a structured projection of the run data via `buildArtifactFromRun()`. No separate DB storage (it's a view over existing columns). This is the stable contract for future anna-case integration:

```typescript
{
  version: '1.0',
  dispute_profile: { risk_level, rubric_score, category_scores, signals, risk_factors },
  hard_gate_result: { passed, triggered_gate },
  planner_output: { thought, decision, credit_timing, args, uncertainty_factors } | null,
  enrichment: { model, prompt_version, files_parsed, dialogues_fetched, ... },
  executor_action, pipeline_duration_ms, created_at, pipeline_run_id
}
```

When ready for WorkStation: attach as `artifact_type: 'AI_ITERATION'`, `artifact_extra: buildArtifactFromRun(row)`.

---

## Dataset Builder

The evaluation harness. Datasets are **pure ground truth** — case IDs + cached context + human labels. No LLM runs on creation.

### Workflow

1. **Build dataset** — paste case IDs or run BigQuery SQL (max 100/500). System fetches and caches all context (signals, details, actions, dialogue, parsed files). This snapshot is reused across all runs.

2. **Label** — reviewers see raw signals and context (no pipeline output, to avoid bias). Label: credit / escalate / undecided. Record confidence + disagreement reasons. Add manual tags. Supports dual-labeling for inter-annotator agreement.

3. **Run experiments** — execute pipeline against dataset with full configuration:
   - Model (free-text, default from `LLM_MODEL` env)
   - Prompt (full editable text, default: `dispute-planner-v1`)
   - Hard gate toggles (on/off per gate)
   - Rubric weights + thresholds
   - Scoring rules (all breakpoints editable)
   - Full config stored per run for reproducibility
   - Runs can be renamed (double-click tab name)

4. **Review** — run tab shows two-column case rows: Pipeline output (risk, decision, duration) vs Human Label (dataset label, confidence, tags, notes). Agreement badge (match/disagree) per case. Prompt text viewable per run.

5. **Analyze** — confusion matrix, stratified metrics (by risk level, dispute type, hard gate, rubric bucket, label confidence), inter-annotator agreement (Cohen's kappa), disagreement breakdown.

6. **Compare** — side-by-side run comparison showing flipped cases (improved/regressed/changed), delta metrics.

7. **Iterate** — compose datasets (merge + deduplicate), refresh context, export to Excel.

### Database Schema

```
datasets → dataset_cases (1:many, with context + labels + manual_tags)
         → dataset_runs (1:many, with config JSONB including PipelineConfig + prompt_content)
              → dataset_run_cases (1:many, links to dispute_pipeline_runs, carries dataset_label for comparison)

dataset_compositions (self-join for merged datasets)
```

---

## Narrow Live Cohort (Phase 1 Target)

Only cases matching ALL criteria qualify for live credit:

| Signal | Condition |
|--------|-----------|
| Risk profile | Green (rubric score >= 70) |
| Hard gates | All clear |
| Account age | >= 365 days |
| CIFAS | 0 |
| Railsr disputes (6m) | 0 |
| Transaction amount | <= £25 |
| is_dispute | false (goodwill credit only) |
| Planner decision | credit with credit_timing=immediately |
| Planner uncertainty | Empty uncertainty_factors |

**Success criteria:** >= 95% credit precision, >= 90% escalate recall, 100% hard gate accuracy. Minimum 30 shadow cases reviewed before going live.

---

## External Dependencies

| Service | What It Provides |
|---------|-----------------|
| **BigQuery** | Account/transaction/dispute signals |
| **case-ag** | Case details (issue_type_id, created_at), artifacts |
| **file-share-ag + media** | Document downloads (PDFs, images) → Gemini parsing |
| **tasks** | Case actions, dispute forms |
| **chat** | Customer dialogue messages |
| **llm-proxy** | Claude + Gemini API access |
| **PostgreSQL** | Local state (datasets, labels, runs, pipeline results) |

---

## What's Built vs What's Not

| Component | Status |
|-----------|--------|
| Signal fetch + configurable rubric scoring | Done |
| Hard gates (4 checks, toggleable per run) | Done |
| LLM Planner with full enrichment | Done |
| Audit trail (DB persistence) | Done |
| Dataset Builder (labeling, runs, analytics, comparison) | Done |
| AI Iteration Artifact schema | Done |
| Editable prompt/model per run | Done |
| Full pipeline config per run (gates, weights, scoring rules) | Done |
| Run tab with Pipeline vs Human Label comparison | Done |
| Run rename | Done |
| Dynamic max score calculator | Done |
| Executor (live credit) | Not built |
| Verifier (task creation check) | Not built |
| Narrow cohort gate (code enforcement) | Not built |
| anna-disputes API integration | Not built |
| Event-driven trigger (form submission) | Not built |
| Production Docker/CI | Not built |

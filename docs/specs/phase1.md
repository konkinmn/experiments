# Phase 1 — Shadow Mode + First Live Credit

## Goal

Validate that the Planner makes correct decisions before giving it any real actions. Run in shadow mode on all eligible cases. Wire one live action — immediate credit — for a narrow, low-risk cohort only.

**Success metric:** 95%+ Planner precision on `credit` decisions within the narrow cohort, measured against reviewer verdicts in the eval harness.

---

## What gets built

### 1. Dispute profile artifact

Generated on dispute form submission. Saved to case in WorkStation. Built by Internal Tools.

**Contents:**

```typescript
{
  risk_level: "green" | "amber" | "red"
  rubric_score: number           // 0–108
  generated_at: timestamp
  signals: {
    account_age_days: number
    account_status: string
    cifas_count: number
    tier: "B" | "C" | "D" | "E"
    is_money_maker: boolean
    trust_score: "GREEN" | "BLUE" | "AMBER"
    scammer_count: number
    scam_victim_count: number
    railsr_disputes_6m: number
    railsr_disputes_30d: number
    tx_count_90_days: number
    prior_payments_to_merchant: number
    transaction_amount: number
    merchant: string
  }
  risk_factors: string[]         // human-readable flags e.g. "Blue trust score"
}
```

**Risk level derivation (rubric score):**

| Level | Condition |
|---|---|
| 🔴 Red | Any hard gate signal present, OR rubric score < 40 |
| 🟡 Amber | Rubric score 40–69 |
| 🟢 Green | Rubric score ≥ 70 |

**Rubric score breakdown (max 108):**

Category 1 — Account Trust (max 58):
- Account age ≥ 365d → 20, ≥ 180d → 12, ≥ 90d → 5
- Tier E → +10, D → +8, C → +5, B → 0
- Money Maker → +15
- Trust score GREEN → +8, AMBER → +4, BLUE → 0
- tx_count_90_days ≥ 5 → +5

Category 2 — Dispute History (max 30):
- 0 Railsr disputes (6m) → 30, 1–2 → 15, 3–4 → 5, 5+ → 0
- Dispute in last 30d → −5
- Scam victim → −5
- Floor at 0

Category 3 — Transaction Risk (max 20):
- Amount < £5 → 20, < £10 → 14, < £15 → 9, ≤ £25 → 5

**Tier eligibility note:** Tier C, D, E are all eligible customers. Only Tier B indicates an unestablished account.

## Eval dataset accuracy

> **Note: eval harness only.** The following applies to historical case testing in the
> eval harness. In production, the pipeline runs at the moment of form submission, so
> `CURRENT_TIMESTAMP()` and `case_created_at` are effectively the same. No separate
> production handling is needed.

All time-sensitive signals are calculated relative to `case_created_at`, not
`CURRENT_TIMESTAMP()`. This ensures historical test cases return the signals as they
were at filing time, not today.

| Signal | Historical fix |
|---|---|
| `account_age_days` | `DATE_DIFF(DATE(case_created_at), DATE(account.created_at), DAY)` |
| `tx_count_90_days`, `active_months`, `prior_payments_to_merchant` | Window: `[case_created_at - 90d, case_created_at)` |
| `railsr_disputes_last_6_months` | Window: `[case_created_at - 6m, case_created_at)` |
| `railsr_disputes_last_30_days` | Window: `[case_created_at - 30d, case_created_at)` |
| `scammer_count`, `scam_victim_count` | Upper bound: `created_at < case_created_at` |
| `tier` | `compliance_customer_tier_log` — prev_tier_name logic with COALESCE fallback |
| `trust_score` | `expiring_tables.compliance_trust_score_changes WHERE day <= DATE(case_created_at)` |

---

### 2. Eval harness (dispute agent eval)

Lives at `/rubric-tester` in Feature Observatory. Backend pipeline replaces client-side scoring. Frontend is a thin display and review layer.

**Pipeline flow:**
```
Case ID entered
      ↓
POST /api/dispute-pipeline/run
      ↓
Parallel fetch: BQ signals + Case API details + Case actions (Tasks API)
      ↓
Hard gate check
      ↓ (if clear)
Build dispute profile (rubric score + risk level)
      ↓
Parallel enrichment:
  FILE artifacts → base64 encode → Gemini parse → text descriptions
  DIALOGUE artifact IDs → Tasks API → Chat API → customer messages (filtered, last 50)
      ↓
Planner LLM call (profile + case_actions + customer_dialogue_messages + artifact_descriptions)
      ↓
Save full audit record to PostgreSQL (including case_actions as JSONB)
      ↓
Return result to frontend
      ↓
Reviewer marks correct / incorrect + notes
```

**Shadow mode:** Executor does NOT fire. No real actions taken. Planner output is captured and reviewed only.

**UI:** Each result renders as a full card (not collapsible). Shows: rubric score bar, category breakdown, planner thought, decision, uncertainty factors, dispute profile signals, reviewer verdict controls.

---

### 3. Case artifact and enrichment handling

**Data sources passed to Planner:**

| Type | Format | Processing |
|---|---|---|
| `FILE` (PDF) | PDF | Fetched as base64, pre-parsed with Google Gemini → text description |
| `FILE` (image) | Image (screenshot) | Fetched as base64, pre-parsed with Google Gemini → text description |
| `CASE_ACTION` | JSON (structured) | Fetched from Tasks API by case ID. No Gemini needed — already structured data |
| `DIALOGUE` | JSON (chat messages) | Fetched via 3-step Tasks + Chat API flow. Filtered to customer-only, capped at 50. No Gemini needed |

All other types (`AGENT_TASK`, `TRANSACTION`, `CALL`) are not passed to the Planner.

**File fetch and parse flow:**
```
artifact.artifact_id
        ↓
GET https://file-share-ag.k1.anna.money/api/workstation/files/{artifact_id}
        ↓
response.data.path + response.data.mime_type
        ↓
GET https://media.k1.anna.money{path}
        ↓
raw bytes → base64
        ↓
Send to Google Gemini (gemini-2.5-flash) via LLM proxy for parsing
        ↓
text description → included in Planner payload as artifact_descriptions
```

Fetched in parallel with BQ signals. Each file is parsed individually with Gemini. Individual file fetch or parse failures log a warning and include a placeholder — they do not fail the pipeline run.

This follows the anna-gemma `parse_file` pattern: Gemini handles multimodal file understanding, the Planner (Anthropic Claude) receives text-only input.

**Case action fetch flow:**
```
GET {TASKS_BASE_URL}/api/workstation/case-actions?case_id={caseId}
        ↓
response.data → CaseAction[]
        ↓
Passed to Planner as case_actions (action_type, status, created_at, metadata)
```

On failure: log warning, return empty array — do not fail the pipeline.

**Dialogue message fetch flow (3-step):**
```
DIALOGUE artifact IDs from case artifacts
        ↓
Step 1: GET {TASKS_BASE_URL}/api/v3/dialogues?id={ids} → get dialogue records + alias
        ↓
Step 2: GET {TASKS_BASE_URL}/api/v3/messages?dialogue_id={id} → get message IDs per dialogue
        ↓
Step 3: GET {CHAT_BASE_URL}/api/2/user/{alias}/messages?id[]={id1}&id[]={id2}... → get message content
        ↓
Filter: hidden messages removed, non-customer sender types (agent, system, annabot, bot, unknown) removed
        ↓
Sort by created_at, cap at last 50 → customer_dialogue_messages in Planner payload
```

On any individual dialogue failure: log warning, skip that dialogue — do not fail the pipeline. Customer dialogue content is redacted in pipeline logs to avoid PII exposure.

CASE_ACTION and DIALOGUE data are already structured text — they bypass Gemini entirely.

**Env vars required:** `FILE_SHARE_BASE_URL`, `MEDIA_BASE_URL`, `TASKS_BASE_URL`, `CHAT_BASE_URL`

---

### 4. Planner — Phase 1 scope

Two decisions only. `request_evidence`, `chargeback`, `on_notification`, `on_win` not available — any case needing those → `escalate_to_agent`.

```typescript
{
  thought: string
  decision: "credit" | "escalate_to_agent"
  credit_timing: "immediately" | "none"
  args?: {
    is_dispute: false               // Phase 1: goodwill credits only
    is_fraud: boolean
    credit_mode: "IMMEDIATELY"
    reason: DisputeReason           // NOT_AUTHORISED | DIFFERENT_AMOUNT | DUPLICATE | NO_FUNDS_FROM_ATM | OTHER
    fraud_type?: FraudType
    fraud_sub_type?: FraudSubType
    crime_reference?: string
  }
  uncertainty_factors: string[]     // empty = no reservations
}
```

**Enum values (from anna-disputes):**

FraudType: `LOST_CARD_FRAUD` | `STOLEN_CARD_FRAUD` | `COUNTERFEIT_CARD_FRAUD` | `ACCOUNT_TAKEOVER_FRAUD` | `CARD_NOT_PRESENT_FRAUD` | `BUST_OUT_COLLUSIVE_MERCHANT` | `FIRST_PARTY` | `MODIFICATION_OF_PAYMENT_ORDER` | `MANIPULATION_OF_CARDHOLDER` | `PAYMENT_CREATED_BY_FRAUDSTER` | `MANIPULATION_OF_PAYER_BY_FRAUDSTER`

FraudSubType: `CONVENIENCE_OR_BALANCE_TRANSFER` | `PIN_NOT_USED` | `PIN_USED` | `UNKNOWN` | `ADVANCE_FEE` | `IMPERSONATION` | `INVESTMENT` | `PURCHASE` | `ROMANCE`

**Planner receives three enrichment sections (when available):**
- `case_actions` — structured action records (e.g. DISPUTE_FORM_FILLED with crime_ref_number). Planner is instructed to use `crime_ref_number` as `args.crime_reference` when crediting.
- `customer_dialogue_messages` — customer's own chat messages (agent/system/bot filtered out). Used as context, not as authoritative evidence.
- `artifact_descriptions` — Gemini-extracted text summaries of FILE artifacts

**Key prompt constraints:**
- Tier C, D, E are all eligible — only Tier B indicates unestablished customer
- When in doubt, escalate
- Cannot request evidence or raise chargeback in Phase 1
- Cannot deny — only credit or escalate
- Use only provided signals, never infer
- uncertainty_factors: list what would change the decision

**Parse failure handling:** Malformed LLM response → `escalate_to_agent` with `uncertainty_factors: ['planner_parse_error']`, raw response logged. Pipeline does not throw.

---

### 5. Narrow live cohort definition

Only cases matching ALL of the following qualify for live `credit`:

| Signal | Condition |
|---|---|
| Risk profile | 🟢 Green only (rubric score ≥ 70) |
| Hard gates | All clear |
| Account age | ≥ 365 days |
| CIFAS | 0 |
| Railsr disputes (6m) | 0 |
| Transaction amount | ≤ £25 |
| is_dispute | false (goodwill credit path only) |
| Planner decision | `credit` with `credit_timing=immediately` |
| Planner uncertainty | Empty `uncertainty_factors` |

Everything outside this cohort → shadow mode only.

---

### 6. Executor — Phase 1

Only fires for cases in the narrow live cohort with `decision=credit`.

On executor failure: retry once with same idempotency key → if still failing, write to audit log with `executor_failure`, do not attempt again.

---

### 7. Verifier — Phase 1

Single check: did anna-disputes return a valid `agent_task_id`?

If yes: audit record marked `verified=true`.
If no: escalate immediately, attach full Planner output and executor error.

---

### 8. Audit schema — case_actions column

`case_actions` is persisted as a JSONB column in `dispute_pipeline_runs` for audit trail. Migration: `init-db/004-case-actions-column.sql`. Runtime migration also applied in `db.ts` on startup.

---

## Eval metrics — Phase 1

| Metric | Target before expanding live cohort |
|---|---|
| `credit` precision (reviewer agrees) | ≥ 95% |
| `escalate` recall (genuine escalations caught) | ≥ 90% |
| Empty `uncertainty_factors` on correct credits | ≥ 80% |
| Hard gate accuracy | 100% |

Minimum sample before going live: 30 shadow cases within the narrow cohort, all reviewed by a human.

---

## Open items

| Item | Owner | Status |
|---|---|---|
| Artifact type audit — confirm FILE mime types in production | Internal Tools | To do |
| Dispute profile artifact WorkStation design | Internal Tools | To design |
| Payments team sign-off on narrow cohort definition | Payments | To confirm |
| Hard gate configuration sign-off | Compliance | To confirm |
| anna-disputes API access for Executor | Payments + Internal Tools | To confirm |
| Idempotency key strategy for TaskCreationRequest | Internal Tools | To design |

**Completed:**
- ✅ Fix tier CTE LIMIT 1 in BQ query
- ✅ Fix Case Created display bug
- ✅ Fix tx_count_90_days join (alias-based, no account_account join needed)
- ✅ Risk level derivation updated to rubric score
- ✅ Hard gate priority order defined
- ✅ Artifact types audited and restricted to FILE only (DISPUTE_FORM metadata lives on disputes service, not file-share; the dispute form PDF is a FILE artifact)
- ✅ File fetch flow designed (file-share → media service → base64)
- ✅ File pre-parsing with Google Gemini (follows anna-gemma parse_file pattern)
- ✅ CASE_ACTION enrichment: fetchCaseActions via Tasks API, crime_ref_number extraction from DISPUTE_FORM_FILLED metadata
- ✅ DIALOGUE enrichment: fetchCaseDialogues via Tasks + Chat APIs, customer-only filtering (agent/system/bot removed), capped at last 50
- ✅ Planner prompt updated with `case_actions` and `customer_dialogue_messages` guidance sections
- ✅ Integration test (case 29452) verifying CASE_ACTION + DIALOGUE enrichment end-to-end
- ✅ DB migration for case_actions JSONB column (init-db/004-case-actions-column.sql)

---

## What Phase 1 does not include

- `request_evidence` live action (Phase 3)
- Formal dispute path (`is_dispute=true`) (Phase 4)
- Agent summaries for escalated cases (Phase 2)
- Regulatory rationale field (Phase 3)
- Gemma integration (Phase 3)
- Evidence re-entry loop (Phase 5)
- Railsr submission (Phase 4)

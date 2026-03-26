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
  risk_factors: string[]         // human-readable flags e.g. "Amber trust score"
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
- Trust score GREEN → +8, BLUE → +4, AMBER → 0
- tx_count_90_days ≥ 5 → +5

Category 2 — Dispute History (max 30):
- 0 Railsr disputes (6m) → 30, 1–2 → 15, 3–4 → 5, 5+ → 0
- Dispute in last 30d → −5
- Scam victim → −5
- Floor at 0

Category 3 — Transaction Risk (max 20):
- Amount < £5 → 20, < £10 → 14, < £15 → 9, ≤ £25 → 5

**Tier eligibility note:** Tier C, D, E are all eligible customers. Only Tier B indicates an unestablished account.

---

### 2. Eval harness (dispute agent eval)

Lives at `/rubric-tester` in Feature Observatory. Backend pipeline replaces client-side scoring. Frontend is a thin display and review layer.

**Pipeline flow:**
```
Case ID entered
      ↓
POST /api/dispute-pipeline/run
      ↓
Parallel fetch: BQ signals + Case API details
      ↓
Hard gate check
      ↓ (if clear)
Build dispute profile (rubric score + risk level)
      ↓
Fetch + base64 encode FILE artifacts
      ↓
Pre-parse each file with Google Gemini → text descriptions
      ↓
Planner LLM call (profile + artifact descriptions as text context)
      ↓
Save full audit record to PostgreSQL
      ↓
Return result to frontend
      ↓
Reviewer marks correct / incorrect + notes
```

**Shadow mode:** Executor does NOT fire. No real actions taken. Planner output is captured and reviewed only.

**UI:** Each result renders as a full card (not collapsible). Shows: rubric score bar, category breakdown, planner thought, decision, uncertainty factors, dispute profile signals, reviewer verdict controls.

---

### 3. Case artifact handling

**Allowed artifact types:**

| Type | Format | Processing |
|---|---|---|
| `FILE` (PDF) | PDF | Fetched as base64, pre-parsed with Google Gemini → text description |
| `FILE` (image) | Image (screenshot) | Fetched as base64, pre-parsed with Google Gemini → text description |

All other types stripped before Planner call.

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

**Env vars required:** `FILE_SHARE_BASE_URL`, `MEDIA_BASE_URL`

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

---

## What Phase 1 does not include

- `request_evidence` live action (Phase 3)
- Formal dispute path (`is_dispute=true`) (Phase 4)
- Agent summaries for escalated cases (Phase 2)
- Regulatory rationale field (Phase 3)
- Gemma integration (Phase 3)
- Evidence re-entry loop (Phase 5)
- Railsr submission (Phase 4)

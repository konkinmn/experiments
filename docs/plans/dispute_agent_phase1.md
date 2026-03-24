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
}
```

**Risk level derivation (deterministic):**

| Level | Conditions |
|---|---|
| 🔴 Red | Any hard gate signal present (CIFAS, scammer, inactive account, recent Railsr dispute) |
| 🟡 Amber | Account age < 180 days, OR trust score AMBER, OR tier B, OR scam victim count > 0 |
| 🟢 Green | None of the above |

Red profile cases still proceed to hard gates — the profile is informational, not a gate itself.

---

### 2. Eval harness (rubric tester, reframed)

Existing rubric tester is repurposed. Frontend scoring logic (`computeScore`) is replaced with a Planner LLM call. Everything else — BQ fetch, results table, correct/incorrect verdict, export — stays.

**What changes:**
- Case ID → BQ signals → passed to Planner API call
- Planner returns `{thought, decision, credit_timing, args, uncertainty_factors}`
- UI displays: thought, decision, args, uncertainty factors, all raw signals
- Reviewer marks: correct / incorrect + notes
- Result saved to `rubric_results` with full snapshot

**What stays the same:**
- Session summary (total tested, decision distribution)
- Threshold controls (now control which cohort is eligible for live action)
- CSV/XLSX export
- All existing BQ query fixes needed: tier CTE LIMIT 1, Case Created display bug

**Shadow mode:** Executor does NOT fire. No real actions taken. Planner output is captured and reviewed only.

---

### 3. Narrow live cohort definition

Before wiring any live action, define the cohort precisely. Only cases matching ALL of the following qualify for live `credit`:

| Signal | Condition |
|---|---|
| Risk profile | 🟢 Green only |
| Hard gates | All clear |
| Account age | ≥ 365 days |
| CIFAS | 0 |
| Railsr disputes (6m) | 0 |
| Transaction amount | ≤ £25 |
| is_dispute | false (goodwill credit path only) |
| Planner decision | `credit` with `credit_timing=immediately` |
| Planner uncertainty | Empty `uncertainty_factors` |

Everything outside this cohort → shadow mode only, no live action regardless of Planner output.

This cohort maps to `is_dispute=false`, `credit_mode=IMMEDIATELY` in anna-disputes — the simplest, lowest-risk execution path.

---

### 4. Planner — Phase 1 scope

Phase 1 Planner is intentionally simplified. Two decisions only:

```typescript
{
  thought: string
  decision: "credit" | "escalate_to_agent"
  credit_timing: "immediately" | "none"
  args?: {
    is_dispute: false               // Phase 1: goodwill credits only
    is_fraud: boolean
    credit_mode: "IMMEDIATELY"      // Phase 1: immediate only
    reason: DisputeReason
    fraud_type?: FraudType
    fraud_sub_type?: FraudSubType
    crime_reference?: string
  }
  uncertainty_factors: string[]
}
```

`request_evidence`, `chargeback`, `on_notification`, `on_win` are not available in Phase 1. Any case that would need those → `escalate_to_agent`.

**Phase 1 system prompt:**

```
Role:
You are ANNA's Dispute Resolution Agent. Your job is simple: decide whether 
this case can be safely credited immediately, or whether a human should handle it.

When to credit:
- Account is established (365+ days)
- No CIFAS, no scammer flag, no recent Railsr disputes
- Low transaction value (under £25)
- Customer has done what was asked (provided crime ref if fraud)
- No missing information that would change the decision

When to escalate:
- Any doubt whatsoever
- Missing signals
- Complex fraud pattern
- Account health concerns
- Anything outside the simple goodwill credit path

You cannot request evidence in this version. If evidence is needed → escalate.
You cannot raise a formal chargeback. If Railsr is needed → escalate.

Constraints:
- Use only the signals in the dispute profile. Never infer or invent values.
- uncertainty_factors: list what would change your decision. Empty = no reservations.
- When in doubt, escalate. A wrong escalation costs agent time. A wrong credit 
  costs money and regulatory risk.

Output:
Single JSON object only. No other text.
```

---

### 5. Executor — Phase 1

Only fires for cases in the narrow live cohort with `decision=credit`.

```
Planner output received
        ↓
Cohort check (all conditions met?)
        ↓ yes
POST /api/workstation/tasks (anna-disputes)
with args from Planner output
        ↓
Verifier confirms task created
        ↓
Audit log written
```

For all other cases: audit log written, no action taken (shadow mode).

**On executor failure:** retry once with same idempotency key → if still failing, write to audit log with `executor_failure`, surface as alert, do not attempt again.

---

### 6. Verifier — Phase 1

Single check: did anna-disputes return a valid `agent_task_id`?

If yes: audit record marked `verified=true`, pipeline complete.
If no: escalate immediately, attach full Planner output and executor error to the WorkStation task.

---

## Eval metrics — Phase 1

Overall task_success_rate is tracked but not the gate criterion. What matters:

| Metric | Target before expanding live cohort |
|---|---|
| `credit` precision (reviewer agrees) | ≥ 95% |
| `escalate` recall (genuine escalations caught) | ≥ 90% |
| Empty `uncertainty_factors` on correct credits | ≥ 80% |
| Hard gate accuracy | 100% (deterministic, must be perfect) |

Minimum sample before going live: 30 shadow cases within the narrow cohort matching all live eligibility criteria, all reviewed by a human.

---

## Open items to resolve before Phase 1 ships

| Item | Owner | Status |
|---|---|---|
| Fix tier CTE LIMIT 1 in BQ query | Internal Tools | Needed |
| Fix Case Created `[object Object]` display bug | Internal Tools | Needed |
| Fix tx_count_90_days join (always returns 0) | Internal Tools | Needed |
| Dispute profile artifact WorkStation design | Internal Tools | To design |
| Payments team sign-off on narrow cohort definition | Payments | To confirm |
| Hard gate configuration sign-off | Compliance | To confirm |
| anna-disputes API access for Executor | Payments + Internal Tools | To confirm |
| Idempotency key strategy for TaskCreationRequest | Internal Tools | To design |

---

## What Phase 1 does not include

- `request_evidence` live action
- Formal dispute path (`is_dispute=true`)
- Agent summaries for escalated cases (Phase 2)
- Regulatory rationale field (Phase 3)
- Any Gemma integration
- Evidence re-entry loop
- Railsr submission

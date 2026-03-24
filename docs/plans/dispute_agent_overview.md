# Dispute Agent — Overview & Architecture

## What this is

An AI agent that automates the job agents currently do before a dispute task is created in WorkStation. It does not touch the dispute lifecycle after task creation — the chargeback flow, Balance API, credit daemons, and Railsr interactions are already automated and stay untouched.

**The agent's job, in one sentence:** "Can this case be safely credited now, or should a human handle it?"

---

## Why we're building it

**Q1 OKR:** 50% of eligible disputes resolved without human intervention.

Currently every dispute — regardless of complexity — lands in an agent queue. The agent checks signals (account age, CIFAS, dispute history, tier, Money Maker status), reads the form, makes a judgment call, and submits a `TaskCreationRequest`. For straightforward low-risk cases this takes 15-20 minutes of agent time on a decision that was never in doubt.

The agent is doing two jobs: pattern recognition on structured signals, and judgment on ambiguous cases. The first job should be automated. The second job should be supported, not replaced.

---

## What the agent automates

The agent replicates what a CX agent does manually:

1. Pull account signals (CIFAS, age, tier, dispute history, Money Maker, trust score)
2. Review the dispute form (transaction, fraud type, crime reference, card status)
3. Assess risk level
4. Either: submit `TaskCreationRequest` with correct parameters, ask for more evidence, or pass to a human with a summary

Everything after `TaskCreationRequest` is submitted — chargeback lifecycle, credit timing, Balance API calls, Railsr — is unchanged.

---

## Architecture — five layers

```
Dispute form submitted
        ↓
Layer 0 — Signal fetch + dispute profile artifact
        ↓
Layer 1 — Hard gates (deterministic, pre-LLM)
        ↓ (if clear)
Layer 2 — Planner (LLM)
        ↓
Layer 3 — Executor (deterministic)
        ↓
Layer 4 — Verifier + audit log
```

### Layer 0 — Signal fetch + dispute profile

On form submission, a dispute profile artifact is generated from BQ signals and saved to the case. This happens before the Planner fires.

The artifact is one source of truth for two audiences. Agents use it for quick scan — it replaces manual comment-writing. The Planner receives the same artifact as its structured context input. Both reason from identical information.

It contains a risk level and the raw signal values:

| Level | Meaning |
|---|---|
| 🟢 Green | Straightforward, low risk |
| 🟡 Amber | One or more signals need attention |
| 🔴 Red | High risk, requires careful handling |

All signals are DB lookups fetched via a single BQ query. None are LLM-derived. No hallucination risk on binary inputs. Full signal list and sources are in the Phase 1 spec.

---

### Layer 1 — Hard gates

Run before LLM. If any gate fires: immediate `escalate_to_agent`, no scoring, no LLM call.

| Gate | Condition | Flag |
|---|---|---|
| CIFAS hit | `cifas_count > 0` | `cifas_flagged` |
| Account inactive | `account_status !== ACCOUNT_IS_ACTIVE` | `account_inactive` |
| Confirmed scammer | `scammer_count > 0` | `confirmed_scammer` |
| Recent Railsr dispute | `railsr_disputes_last_6_months > 0` | `recent_railsr_dispute` |

All triggered flags are included in the audit log regardless of which gate fired first.

Note: CIFAS should eventually distinguish fraud victim markers from perpetrator markers. For now, all CIFAS hits → `escalate_to_agent`.

---

### Layer 2 — Planner (LLM)

Receives the dispute profile artifact + form data. Outputs one of three decisions.

**Planner output schema:**

```typescript
{
  thought: string              // full reasoning chain — internal, not customer-facing
  decision: "credit" | "request_evidence" | "escalate_to_agent"
  credit_timing: "immediately" | "on_notification" | "on_win" | "none"
  args: TaskCreationRequest    // only populated when decision = "credit"
  uncertainty_factors: string[] // what would change this decision; empty = no reservations
}
```

**The three decisions:**

**`credit`** — case is ready to action. `args` contains the full `TaskCreationRequest` parameters:

```typescript
{
  is_dispute: boolean
  is_fraud: boolean
  credit_mode: "IMMEDIATELY" | "ON_CHARGEBACK_NOTIFICATION" | "ON_WIN" | "NO"
  fraud_type?: FraudType
  fraud_sub_type?: FraudSubType
  reason: DisputeReason
  crime_reference?: string
}
```

Covers both scopes:
- Sub-£25 goodwill credits → `is_dispute=false`, `credit_mode=IMMEDIATELY`
- £25+ formal disputes → `is_dispute=true`, full chargeback lifecycle

**`request_evidence`** — insufficient information. Phase 1: escalate to agent with note. Future: send evidence form via Gemma, re-run pipeline when artifacts arrive.

**`escalate_to_agent`** — complex case, policy edge, or blocked dependency. Planner generates a full case summary for the agent.

**System prompt structure:**

```
Role:
You are ANNA's Dispute Resolution Agent. Your job is to assess whether a dispute 
case can be safely credited now, or whether a human should handle it.

Constraints:
- Never invent or infer signal values. Use only what is in the dispute profile.
- Never use language that implies ANNA admits liability.
- uncertainty_factors must list specific signals that, if different, would have 
  changed your decision. Empty array = no reservations.
- escalate_to_agent is always available. When in doubt, use it.
- auto_deny does not exist. You cannot deny a customer's dispute claim.

Risk guidance:
[rubric weights as advisory prose — account age, Money Maker, tier, etc.]

Output:
Respond with a single JSON object matching the output schema. No other text.
```

---

### Layer 3 — Executor

Stateless. Receives `{decision, args}`. Executes exactly that. Makes zero decisions.

| Decision | Action |
|---|---|
| `credit` | POST `TaskCreationRequest` to anna-disputes API |
| `request_evidence` | Phase 1: escalate with note. Future: send Gemma instruction |
| `escalate_to_agent` | Create WorkStation task with `thought` as agent summary |

On failure: retry once, then escalate with `executor_failure` reason and original Planner output attached.

---

### Layer 4 — Verifier + audit log

Confirms action completed. Writes audit record.

**Verification checks:**

| Decision | Check |
|---|---|
| `credit` | Task created in anna-disputes, credit event queued |
| `escalate_to_agent` | WorkStation task created, assigned to dispute queue |

On verification failure: log, escalate with full context.

**Audit record schema:**

```typescript
{
  case_id: number
  timestamp: string
  pipeline_run: number           // 1 = first run, 2 = after evidence, etc.
  gate_result: {
    passed: boolean
    triggered_gates: string[]
  }
  dispute_profile: DisputeProfile   // full artifact snapshot
  planner_output: {
    thought: string               // verbatim, internal
    decision: string
    credit_timing: string
    args: object
    uncertainty_factors: string[]
  }
  executor_result: {
    success: boolean
    action_taken: string
    error?: string
  }
  verifier_result: {
    success: boolean
    error?: string
  }
  final_decision: string
  decision_type: "hard_gate" | "llm"
}
```

`thought` is internal reasoning only. Regulatory-facing rationale is a separate controlled field added in Phase 3.

---

## Evidence handling

When evidence is requested and the customer responds, the same pipeline runs again on the same case with evidence artifacts as additional context.

```typescript
evidence_artifacts: Artifact[] | null
```

State gate:
```
No evidence artifacts → run Planner normally
Evidence artifacts present → run Planner with artifacts as additional context
```

Pipeline never re-runs while waiting. Re-trigger on evidence form submission only.

Phase 1: evidence request → escalate to agent with note. Evidence loop built in Phase 3.

---

## What is explicitly out of scope — forever

- Chargeback lifecycle management (already automated in anna-disputes)
- Balance API credit execution (daemon-owned)
- Railsr submission workflow (Phase 4)
- Auto-deny (hard gates escalate, never deny)
- Customer-facing LLM output (Gemma is the customer interface)

---

## Key constraints

**FCA auditability:** Every decision produces a full audit record. `thought` is logged verbatim. `decision_type` distinguishes hard gate from LLM decisions. Regulatory rationale is templated separately from Phase 3.

**No hallucination on binary signals:** CIFAS, account status, dispute history are DB lookups. LLM never derives these values.

**Cost efficiency:** LLM fires only on cases that clear hard gates. Hard cases escalate immediately.

**Idempotency:** `TaskCreationRequest` calls use idempotency keys. Duplicate submissions are blocked at the anna-disputes layer.

---

## Phase map

| Phase | Scope | Live actions |
|---|---|---|
| 1 | Shadow mode + dispute profile + narrow live credit | Immediate credit (low-risk cohort only) |
| 2 | Agent summaries for all non-credit cases | Escalate with LLM summary |
| 3 | Evidence request automation + regulatory rationale | Request evidence via Gemma |
| 4 | Railsr / chargeback automation | Submit to Railsr |
| 5 | Evidence re-entry loop | Full stateful evidence workflow |



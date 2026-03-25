# Phases 2–5 — Roadmap

These phases are directional. Detail gets added as Phase 1 completes and real data shapes the decisions.

---

## Phase 2 — Agent summaries for all non-credit cases

**Goal:** Every case that escalates to an agent arrives with a Planner-generated summary. Agent doesn't read from scratch. No financial risk — the Planner is only generating text, not triggering actions.

**What changes from Phase 1:**

The Executor wires `escalate_to_agent` as a live action. When the Planner escalates, it generates a structured summary that becomes the WorkStation task note:

```typescript
{
  risk_level: "green" | "amber" | "red"
  rubric_score: number
  what_customer_claims: string
  key_signals: string[]
  what_planner_considered: string
  what_agent_needs_to_decide: string
  uncertainty_factors: string[]
  recommended_next_step: string       // advisory only, not binding
}
```

Agent sees this the moment they open the task. Replaces reading the full case history.

**Why this before evidence or Railsr:**
- Zero financial risk
- Immediate agent value — saves time even if the Planner credit decision is never used
- Validates `thought` quality in production before it touches money
- Builds the agent feedback loop naturally (agents agree/disagree with summary → eval signal)

**Success metric:** Agent feedback rate on summary quality. Target: agents find summary useful in ≥ 80% of cases (measured via thumbs up/down in WorkStation task).

**Gate to Phase 3:** Summary quality validated AND Phase 1 credit precision sustained at ≥ 95% over 4+ weeks.

---

## Phase 3 — Evidence request automation + regulatory rationale

**Goal:** Wire `request_evidence` as a real action. Add controlled regulatory rationale field separate from raw `thought`.

### Evidence request

When the Planner outputs `request_evidence`:
1. Executor generates an evidence request form
2. Form is attached to the case as an artifact
3. Gemma sends the form to the customer
4. Pipeline re-runs when customer submits evidence (evidence artifacts now present on case)

This is the first Gemma integration. Gemma remains stateless — it receives a plain-English instruction from the Executor and delivers it to the customer. Gemma never makes decisions.

**State gate:**
```
evidence_artifacts = null + first run → Planner runs normally
evidence_artifacts = null + evidence requested → waiting, pipeline does not re-fire
evidence_artifacts present → Planner re-runs with artifacts as additional context
```

Second run Planner has access to: original dispute profile + form data + evidence artifacts. It can now output `credit`, `escalate_to_agent`, or (rarely) `request_evidence` again for a different evidence type.

**File handling in Phase 3:**

Evidence files submitted by the customer arrive as `FILE` artifacts (screenshots/images). The existing file fetch pipeline already handles these — `fetchArtifactAsBase64` fetches from file-share → media service → base64 encodes → passes to LLM proxy as `image_url` content blocks. No new infrastructure needed for this path.

### Regulatory rationale field

Added to Planner output and audit record:

```typescript
customer_rationale: string  // short, controlled, template-constrained
                            // safe for regulatory disclosure
```

`thought` remains internal diagnostic. `customer_rationale` is the regulated explanation.

Template constraints enforced in system prompt:
- Must not imply ANNA admits fraud occurred
- Must not reference internal signals or scoring
- Must use approved language: "following review of your account and transaction history"
- Max 2 sentences

**Gate to Phase 4:** Evidence automation stable in production. Regulatory rationale reviewed and signed off by compliance.

---

## Phase 4 — Railsr / chargeback automation

**Goal:** Wire formal dispute path. Planner can now output `credit` with `is_dispute=true` and full chargeback lifecycle parameters.

**What expands:**

Planner output now includes full chargeback parameters:

```typescript
{
  decision: "credit" | "request_evidence" | "escalate_to_agent"
  credit_timing: "immediately" | "on_notification" | "on_win" | "none"
  args: {
    is_dispute: boolean
    is_fraud: boolean
    credit_mode: CreditMode
    fraud_type?: FraudType
    fraud_sub_type?: FraudSubType
    reason: DisputeReason
    crime_reference?: string
  }
}
```

**New eligibility criteria for formal dispute path** (to be defined with Payments team):
- Transaction ≥ £25 (anna-disputes hard minimum)
- Dispute reason maps to Railsr-eligible type
- No KYB / fincrime dependency flagged
- Crime reference present (if fraud)

**anna-disputes already handles everything after task creation.** This phase is purely about the Planner correctly populating `is_dispute=true` cases and the Executor calling the same API.

**Permission note:** `IMMEDIATELY` credits above £500 require `APPROVE_BIG_IMMEDIATE_CREDIT_PERMISSION`. The Executor service account needs appropriate permissions scoped to the cohort it handles. Define with Payments team before Phase 4 ships.

**Gate to Phase 5:** Formal dispute path stable. Credit timing modes (on_notification, on_win) validated against real chargeback outcomes.

---

## Phase 5 — Evidence re-entry loop + full workflow

**Goal:** Full stateful evidence workflow. Multi-step cases handled end-to-end without agent involvement.

**What this adds:**
- Evidence form creation and attachment (replacing Phase 3 temporary Gemma instruction)
- Automatic pipeline re-trigger on evidence submission
- Loop detection: if customer has been asked for evidence twice with no response, escalate
- SLA tracking: if evidence not received within N days, escalate with context
- Conflict resolution: if agent takes over a case mid-loop, pipeline yields

**Why this is a separate phase:**

This turns the pipeline into a stateful workflow engine. It requires persistent case state between pipeline runs, SLA timers, conflict detection with human agents, and loop termination logic. None of that complexity belongs in Phases 1–4. It is a meaningfully different system built on top of the validated foundation.

**This is the long-horizon agent pattern.** Only design in detail once Phases 1–4 are stable.

---

## Phase map summary

| Phase | Core addition | Financial risk | Gemma involved | Complexity |
|---|---|---|---|---|
| 1 | Shadow mode + narrow live credit | Low (sub-£25, clean accounts) | No | Low |
| 2 | Agent summaries for escalations | None | No | Low |
| 3 | Evidence requests + regulatory rationale | Low | Yes | Medium |
| 4 | Formal disputes + chargeback path | Medium | No | Medium |
| 5 | Full evidence loop + stateful workflow | Medium | Yes | High |

---

## Dependency map

```
Phase 1 must complete before Phase 2
Phase 2 must complete before Phase 3
Phase 3 (Gemma integration) can run in parallel with Phase 4
Phase 5 requires Phase 3 + Phase 4 both complete
```

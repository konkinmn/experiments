# PRD: AI Dispute Pipeline in anna-case

## Problem

Dispute case triage is fully manual today. Every dispute — regardless of complexity — goes to a human agent who reviews signals, assesses risk, and decides whether to credit or investigate further. Simple, low-risk cases take the same amount of agent time as complex ones.

## What We're Building

An AI dispute pipeline inside anna-case that automatically triages dispute cases. After the dispute form is received, the pipeline analyzes the case and makes a decision:

- **Credit** — the case is low-risk and straightforward. The pipeline creates a dispute task pre-filled with its recommendation. A payment agent reviews and approves the credit. The AI never credits on its own.
- **Escalate** — the case needs human judgement. The pipeline escalates the case to an agent with a structured summary of what it found, so the agent can start with context instead of from scratch.

The pipeline has been prototyped and validated in a local test environment (`experiments` repo). This PRD covers what needs to be built in anna-case to bring it to production.

## How the Pipeline Works

The pipeline runs a 4-step analysis on each dispute case:

1. **Signal fetch + risk scoring** — Pulls 15+ signals from BigQuery (account age, trust score, transaction history, CIFAS markers, dispute history, etc.) and scores them on a rubric (0–108 scale). The score maps to a risk level: green (low risk), amber (medium), or red (high).

2. **Hard gates** — Four deterministic checks that run before the AI. If any gate fires, the case is immediately escalated — no AI needed:
   - CIFAS marker present
   - Confirmed scammer flag
   - Account not active
   - Recent Railsr dispute (last 6 months)

3. **Data enrichment** — If hard gates pass, the pipeline fetches additional context in parallel: case actions from the Tasks service, customer dialogue messages (filtered to customer-only, last 50), and uploaded documents parsed via Gemini (PDFs, images). This builds the full context package for the AI.

4. **AI Planner** — An LLM analyzes the enriched context (risk profile, case details, customer dialogue, parsed documents) and outputs a structured decision: credit or escalate, with full reasoning, uncertainty factors, and (when crediting) the parameters needed to issue the credit.

The pipeline always produces a result. If any step fails — LLM response can't be parsed, file parsing fails, dialogue fetch times out — the pipeline defaults to escalation. Enrichment failures are non-fatal: missing files or dialogue don't block the analysis.

---

## What anna-case Needs

### 1. New Case Entity: AI Iteration

AI Iteration is a **new entity on the case**. Each AI iteration represents one complete pipeline run against a case and stores:

- **Risk assessment** — risk level (green/amber/red), numeric score, breakdown by category (account trust, dispute history, transaction risk), individual signals, risk factors in plain language
- **Hard gate result** — whether all gates passed, and which gate (if any) triggered escalation
- **AI decision** — credit or escalate, full reasoning chain, credit timing, uncertainty factors
- **Credit parameters** (when crediting) — is_fraud flag, credit_mode, dispute reason, fraud type, fraud sub-type, crime reference
- **Metadata** — which AI model was used, prompt version, how many files/dialogues were processed, processing time

A case can have multiple AI iterations (e.g., if re-processed after new evidence). They should be ordered by creation time.

### 2. Pipeline Trigger

The pipeline runs automatically after the dispute form is received. A manual re-run API is available for cases where new evidence arrives or a re-analysis is needed.

After the pipeline completes (see "How the Pipeline Works" above), the result is saved as an AI iteration on the case, and anna-case acts on the decision:

- **Credit** → create a dispute task pre-filled with the AI's recommendation and credit parameters for a payment agent to approve
- **Escalate** → escalate the case to a human agent, with the AI iteration's summary available in WorkStation

### 3. Surface AI Iterations in WorkStation

When an agent opens a dispute case that has been processed by the pipeline, they should see the AI's analysis prominently:

- **Decision banner** — what the AI decided and why, in 1–2 sentences
- **Case summary** — what the customer claims, key signals, what the agent needs to decide, recommended next step
- **Risk profile** — color-coded risk level with score and category breakdown
- **Hard gate status** — which gates passed and which (if any) triggered escalation
- **Uncertainty factors** — signals the AI flagged as concerning or ambiguous
- **AI reasoning** — full thought chain (expandable/collapsible)

This is read-only. Agents cannot edit the AI's output but can make their own decision independently — the AI summary is advisory.

When a case has multiple AI iterations, the most recent is shown at the top, with previous iterations listed below in reverse chronological order.

---

## Success Criteria

1. **Pipeline runs inside anna-case** — dispute cases are automatically analyzed after the dispute form is received, with results saved as AI iterations.
2. **Agents see AI analysis** — when opening a dispute case, the AI summary, risk profile, and reasoning are visible in WorkStation without extra clicks.
3. **Dispute tasks are created** — when the AI recommends credit, a pre-filled dispute task is created for a payment agent to approve and a case action is created for the payments team.
4. **Escalations include context** — when the AI escalates, a case action is created and the agent gets the structured summary and reasoning.
5. **No disruption to existing flow** — cases without AI iterations work exactly as before. The integration is purely additive.

---

## Technical Specification

### Hard Gates

Each gate is toggleable per run. If any enabled gate fires, the pipeline skips the AI and escalates immediately.

| Gate | Condition | Signal |
|------|-----------|--------|
| CIFAS | `cifas_count > 0` | CIFAS marker present on account |
| Confirmed scammer | `scammer_count > 0` | Scammer flag from task manager |
| Account not active | `account_status !== 'ACCOUNT_IS_ACTIVE'` | Account status check |
| Railsr dispute | `railsr_disputes_last_6_months > 0` | Railsr dispute filed in last 6 months |

### Risk Scoring Rubric (0–108 scale)

**Account Trust (max 58 points):**
- Account age: 20 pts (365+ days), 12 pts (180+), 5 pts (90+)
- Tier: E=10, D=8, C=5 pts
- Money maker badge: 15 pts
- Trust score: GREEN=8, AMBER=4 pts
- Transaction activity: 5 pts if `tx_count_90_days >= 5`

**Dispute History (max 30 points):**
- 0 disputes=30 pts, ≤2=15 pts, ≤4=5 pts
- Recent dispute penalty: −5 if any in last 30 days
- Scam victim penalty: −5 if `victim_count > 0`

**Transaction Risk (max 20 points):**
- Amount: <£5=20 pts, <£10=14 pts, <£15=9 pts, <£25=5 pts

**Risk level thresholds:** green ≥ 70, amber ≥ 40, red < 40. Any hard gate trigger = red.

### AI Planner Input

The planner receives a JSON context package:

```json
{
  "dispute_profile": {
    "risk_level": "green | amber | red",
    "rubric_score": 0-108,
    "category_scores": { "account_trust": 0-58, "dispute_history": 0-30, "transaction_risk": 0-20 },
    "risk_factors": ["human-readable risk descriptions"]
  },
  "raw_signals": {
    "case_created_at": "ISO date",
    "tx_count_90_days": "number",
    "active_months": "number",
    "prior_payments_to_merchant": "number",
    "railsr_disputes_last_30_days": "number"
  },
  "case_details": {
    "issue_type_id": "string | null",
    "created_at": "ISO date | null"
  },
  "case_actions": [{ "action_type, metadata, created_at, ..." }],
  "customer_dialogue_messages": [{ "last 50 customer-only messages" }],
  "artifact_descriptions": ["parsed file descriptions via Gemini"]
}
```

### AI Planner Output

**Credit decision:**

```json
{
  "thought": "full reasoning chain",
  "decision": "credit",
  "credit_timing": "immediately",
  "args": {
    "is_dispute": false,
    "is_fraud": true,
    "credit_mode": "IMMEDIATELY",
    "reason": "NOT_AUTHORISED",
    "fraud_type": "STOLEN_CARD_FRAUD",
    "fraud_sub_type": "PIN_NOT_USED",
    "crime_reference": "RF26020134020C"
  },
  "uncertainty_factors": ["list of concerns"]
}
```

**Escalate decision:**

```json
{
  "thought": "full reasoning chain",
  "decision": "escalate_to_agent",
  "credit_timing": "none",
  "uncertainty_factors": ["list of concerns"]
}
```

**Enum values:**

- **Dispute reason:** `NOT_AUTHORISED`, `DIFFERENT_AMOUNT`, `DUPLICATE`, `NO_FUNDS_FROM_ATM`, `OTHER`
- **Fraud type:** `LOST_CARD_FRAUD`, `STOLEN_CARD_FRAUD`, `COUNTERFEIT_CARD_FRAUD`, `ACCOUNT_TAKEOVER_FRAUD`, `CARD_NOT_PRESENT_FRAUD`, `BUST_OUT_COLLUSIVE_MERCHANT`, `FIRST_PARTY`, `MODIFICATION_OF_PAYMENT_ORDER`, `MANIPULATION_OF_CARDHOLDER`, `PAYMENT_CREATED_BY_FRAUDSTER`, `MANIPULATION_OF_PAYER_BY_FRAUDSTER`
- **Fraud sub-type:** `CONVENIENCE_OR_BALANCE_TRANSFER`, `PIN_NOT_USED`, `PIN_USED`, `UNKNOWN`, `ADVANCE_FEE`, `IMPERSONATION`, `INVESTMENT`, `PURCHASE`, `ROMANCE`

### AI Iteration Artifact Schema

The data structure stored per pipeline run and surfaced in WorkStation:

```json
{
  "version": "1.0",
  "dispute_profile": {
    "risk_level": "green | amber | red",
    "rubric_score": 0-108,
    "category_scores": { "account_trust", "dispute_history", "transaction_risk" },
    "signals": "full raw signals from BigQuery",
    "risk_factors": ["human-readable descriptions"]
  },
  "hard_gate_result": {
    "passed": true,
    "triggered_gate": null
  },
  "planner_output": "full planner output (null if hard gate triggered)",
  "enrichment": {
    "model": "claude-sonnet-4-5@20250929",
    "prompt_version": "dispute-planner-v1",
    "files_parsed": 2,
    "files_failed": 0,
    "dialogues_fetched": 1,
    "dialogues_failed": 0,
    "case_actions_count": 5,
    "customer_messages_count": 12
  },
  "executor_action": "shadow",
  "pipeline_duration_ms": 4500,
  "created_at": "ISO date",
  "pipeline_run_id": 123
}
```

### WorkStation UI → Data Mapping

| UI Element | Data Source |
|------------|------------|
| Decision banner | `planner_output.decision` + first sentence of `planner_output.thought` |
| Case summary | Derived from `planner_output.thought` — what the customer claims, key signals, recommended action |
| Risk profile | `dispute_profile.risk_level`, `rubric_score`, `category_scores` |
| Hard gate status | `hard_gate_result.passed`, `hard_gate_result.triggered_gate` |
| Uncertainty factors | `planner_output.uncertainty_factors` |
| AI reasoning | `planner_output.thought` (full text) |


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
2. Review the dispute form and any attached evidence files
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

Risk level is derived from the rubric score (0–108). Green: score ≥ 70. Amber: score 40–69. Red: score < 40 or any hard gate signal present.

All signals are DB lookups fetched via a single BQ query. None are LLM-derived. No hallucination risk on binary inputs. Full signal list and sources are in the Phase 1 spec.

---

### Layer 1 — Hard gates

Run before LLM. If any gate fires: immediate `escalate_to_agent`, no scoring, no LLM call. Gates are evaluated in priority order — first hit wins, but all triggered flags are logged.

| Priority | Gate | Condition | Flag |
|---|---|---|---|
| 1 | CIFAS hit | `cifas_count > 0` | `cifas` |
| 2 | Confirmed scammer | `scammer_count > 0` | `confirmed_scammer` |
| 3 | Account inactive | `account_status !== ACCOUNT_IS_ACTIVE` | `account_not_active` |
| 4 | Recent Railsr dispute | `railsr_disputes_last_6_months > 0` | `railsr_dispute_last_6_months` |

Note: CIFAS should eventually distinguish fraud victim markers from perpetrator markers. For now, all CIFAS hits → `escalate_to_agent`.

---

### Layer 2 — Planner (LLM)

Receives the dispute profile + filtered case artifacts. Outputs one of three decisions.

**Planner input includes:**
- Dispute profile (rubric score, risk level, all account signals)
- AI-extracted artifact descriptions (dispute form PDF and evidence screenshots — fetched, pre-parsed with Google Gemini, text summaries passed to Planner)
- Selected raw signals (tx_count_90d, active_months, prior_payments_to_merchant, railsr_disputes_30d)
- Case action metadata (structured records from case workflow — e.g. crime_ref_number from DISPUTE_FORM_FILLED)
- Customer dialogue messages (customer-only chat messages, filtered and capped at last 50)

**Data sources passed to Planner:**
- `FILE` artifacts — customer-uploaded evidence (dispute form PDF, screenshots), pre-parsed with Google Gemini into text descriptions
- `CASE_ACTION` data — fetched directly via Tasks API (`GET /api/workstation/case-actions?case_id={id}`), not from case artifacts. Structured metadata like `crime_ref_number` from `DISPUTE_FORM_FILLED` actions
- `DIALOGUE` messages — dialogue artifact IDs are extracted from case artifacts, then customer messages are fetched via Tasks + Chat APIs. Agent/system/bot messages are filtered out. Capped at last 50 messages sorted by time

All other artifact types (`AGENT_TASK`, `TRANSACTION`, `CALL`) are not passed to the Planner.

**File fetch and parse flow:**
```
artifact.artifact_id
        ↓
GET https://file-share-ag.k1.anna.money/api/workstation/files/{artifact_id}
        ↓
response.data.path
        ↓
GET https://media.k1.anna.money{path}
        ↓
raw bytes → base64
        ↓
Pre-parse with Google Gemini (gemini-2.5-flash) via LLM proxy
        ↓
text description → included in Planner payload as artifact_descriptions
```

The LLM proxy does not support multimodal content for the Anthropic provider. Following the anna-gemma pattern, files are pre-parsed with Google Gemini into structured text descriptions, which are then included in the Planner's text payload. This two-step approach keeps file understanding (Gemini) separate from dispute reasoning (Claude). CASE_ACTION and DIALOGUE data are already structured text — they bypass Gemini entirely and go straight into the Planner payload.

**Case action fetch flow:**
```
GET {TASKS_BASE_URL}/api/workstation/case-actions?case_id={caseId}
        ↓
response.data → CaseAction[]
        ↓
Passed to Planner as case_actions (action_type, status, created_at, metadata)
```

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

**Planner output schema:**

```typescript
{
  thought: string              // full reasoning chain — internal, not customer-facing
  decision: "credit" | "request_evidence" | "escalate_to_agent"
  credit_timing: "immediately" | "on_notification" | "on_win" | "none"
  args?: TaskCreationRequest   // only populated when decision = "credit"
  uncertainty_factors: string[] // what would change this decision; empty = no reservations
}
```

**The three decisions:**

**`credit`** — case is ready to action. `args` maps directly to `POST /api/workstation/tasks` in anna-disputes:

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

**`request_evidence`** — insufficient information to decide. Phase 1: escalate to agent with note "evidence needed." Future: send evidence form via Gemma, re-run pipeline when artifacts arrive.

**`escalate_to_agent`** — complex case, policy edge, or blocked dependency. Planner generates a full case summary for the agent.

---

### Layer 3 — Executor

Stateless. Receives `{decision, args}`. Executes exactly that. Makes zero decisions.

| Decision | Action |
|---|---|
| `credit` | POST `TaskCreationRequest` to anna-disputes API |
| `request_evidence` | Phase 1: escalate with note. Future: send Gemma instruction |
| `escalate_to_agent` | Create WorkStation task with `thought` as agent summary |

On failure: retry once with same idempotency key → if still failing, write to audit log with `executor_failure`, surface as alert, do not attempt again.

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
  pipeline_run: number
  gate_result: {
    passed: boolean
    triggered_gates: string[]
  }
  dispute_profile: DisputeProfile
  planner_output: {
    thought: string               // verbatim, internal
    decision: string
    credit_timing: string
    args?: object
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

State gate:
```
No evidence artifacts → run Planner normally
Evidence artifacts present → run Planner with artifacts as additional context
```

Pipeline never re-runs while waiting. Re-trigger on evidence form submission only.

Phase 1: evidence request → escalate to agent with note. Evidence loop built in Phase 3.

---

## Artifact type reference

All artifact types found on dispute cases:

| Type | What it is | Planner sees it |
|---|---|---|
| `DISPUTE_FORM` | Dispute form metadata (lives on disputes service, not file-share) | No |
| `FILE` | Customer-uploaded evidence (dispute form PDF, screenshots) | Yes |
| `TRANSACTION` | Linked transaction records | No — already in BQ signals |
| `DIALOGUE` | Chat transcripts | Yes — customer messages only (agent/system filtered out, last 50) |
| `AGENT_TASK` | Linked agent tasks | No — reveals resolution history |
| `CASE_ACTION` | Case workflow actions | Yes — structured metadata (crime_ref_number, etc.) |
| `CALL` | Call recordings/logs | No — not parseable |

---

## What is explicitly out of scope — forever

- Chargeback lifecycle management (already automated in anna-disputes)
- Balance API credit execution (daemon-owned)
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

# Dispute Agent — Roadmap

Phases are sequential. Each phase has a gate — criteria that must be met before proceeding.

---

## Phase 1 — Live Credit + Agent Summaries

**Goal:** Go live with two actions simultaneously: auto-credit for a narrow low-risk cohort, and AI-generated summaries for every escalated case. Credit saves ops cost on simple cases. Summaries save agent time on everything else.

### What's done
- Pipeline logic (signals → gates → rubric → planner) — complete
- Full pipeline config per run (hard gate toggles, scoring rules, rubric weights) — complete
- Editable model + prompt per run with full storage — complete
- Dataset Builder with labeling, runs, analytics, comparison — complete
- Run tab with Pipeline vs Human Label side-by-side comparison — complete
- AI iteration artifact schema — defined
- Dynamic max score calculator in New Run modal — complete
- Run rename — complete
- Shadow mode — running

### What's left to build

**Auto-credit (narrow cohort):**

| Component | Effort | Details |
|-----------|--------|---------|
| Narrow cohort gate | ~100 LOC | Code enforcement of 8 criteria (green, gates clear, 365d+, £25, etc.). Currently only in prompt as guidance. |
| Executor (live credit) | ~200 LOC | POST TaskCreationRequest to anna-disputes. Retry once with idempotency key. |
| Verifier | ~100 LOC | Check agent_task_id returned. On failure: escalate + log. New DB columns: verified, agent_task_id, executor_error. |
| DB schema update | ~50 LOC | Add executor/verifier columns to dispute_pipeline_runs. |

**Agent summaries (all escalations):**

| Component | Effort | Details |
|-----------|--------|---------|
| Summary output format | ~50 LOC | Extend planner to produce structured summary (what_customer_claims, key_signals, what_agent_needs_to_decide, recommended_next_step). |
| Executor (escalation) | ~100 LOC | Create WorkStation task with AI iteration artifact containing the summary. |
| Agent feedback UI | TBD | Thumbs up/down on summary quality in WorkStation task. |

### Why ship together
- Agent summaries have **zero financial risk** and deliver value from day one — even while auto-credit is still in shadow validation
- Both require the executor to be wired — building one means building both
- Summaries validate `thought` quality in production, building confidence for auto-credit
- Agents get immediate time savings on every case, not just the narrow credit cohort

### External dependencies (team coordination)
- Payments team sign-off on narrow cohort definition
- Compliance sign-off on hard gate configuration
- anna-disputes API access + credentials
- Idempotency key strategy with Payments
- WorkStation artifact integration for AI iteration (anna-case)

### Success criteria
- Auto-credit: >= 95% precision over 30+ reviewed shadow cases, >= 90% escalate recall, 100% hard gate accuracy
- Summaries: agents find useful in >= 80% of cases (thumbs up/down)

### Gate to Phase 2
Credit precision sustained for 4+ weeks. Summary quality validated.

---

## Phase 2 — Evidence Request + Regulatory Rationale

**Goal:** Wire `request_evidence` as a real action. Add controlled regulatory rationale.

### Evidence request
1. Planner outputs `request_evidence`
2. Executor generates evidence request form, attaches to case
3. Gemma sends form to customer (first Gemma integration — stateless, receives plain-English instruction)
4. Pipeline re-runs when customer submits evidence

### Regulatory rationale
New field in planner output:
```typescript
customer_rationale: string  // short, template-constrained, safe for regulatory disclosure
```
Constraints: must not imply ANNA admits fraud, must not reference internal signals, max 2 sentences, uses approved language.

### Gate to Phase 3
Evidence automation stable. Regulatory rationale signed off by compliance.

---

## Phase 3 — Railsr / Chargeback Automation

**Goal:** Wire formal dispute path. Planner can output `credit` with `is_dispute=true` and full chargeback lifecycle parameters.

### What expands
- `args.credit_mode`: adds `ON_NOTIFICATION`, `ON_WIN` options alongside `IMMEDIATELY`
- `args.is_dispute: true` with full chargeback parameters
- Eligibility: transaction >= £25, Railsr-eligible type, crime reference present

### Key dependency
`IMMEDIATELY` credits above £500 require `APPROVE_BIG_IMMEDIATE_CREDIT_PERMISSION`. Executor service account needs appropriate permissions.

### Gate to Phase 4
Formal dispute path stable. Credit timing modes validated against real chargeback outcomes.

---

## Phase 4 — Evidence Re-entry Loop

**Goal:** Full stateful evidence workflow. Multi-step cases handled end-to-end.

### What it adds
- Evidence form creation + automatic pipeline re-trigger on submission
- Loop detection: asked twice with no response → escalate
- SLA tracking: evidence not received within N days → escalate
- Conflict resolution: agent takes over mid-loop → pipeline yields

### Why this is separate
This turns the pipeline into a **stateful workflow engine** — persistent case state between runs, SLA timers, conflict detection. None of that complexity belongs in earlier phases.

---

## Dependency Map

```
Phase 1 must complete before Phase 2
Phase 2 (Gemma) can run in parallel with Phase 3
Phase 4 requires Phase 2 + Phase 3 both complete
```

## Phase Summary

| Phase | Core Addition | Financial Risk | Complexity |
|-------|--------------|----------------|------------|
| 1 | Live credit + agent summaries | Low (sub-£25, clean accounts) | Low–Medium |
| 2 | Evidence requests + rationale | Low | Medium |
| 3 | Formal disputes + chargeback | Medium | Medium |
| 4 | Full evidence loop | Medium | High |

## Out of Scope — Forever

- Chargeback lifecycle management (already automated in anna-disputes)
- Balance API credit execution (daemon-owned)
- Auto-deny (hard gates escalate, never deny)
- Customer-facing LLM output (Gemma is the customer interface)

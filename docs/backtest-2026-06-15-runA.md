# Backtest — Run A (baseline) results, 2026-06-15

Dataset **15** (`backtest-scoring-recalibration-2026-06-15`), 43 eligible-resolved cases,
answer key loaded (15 credit / 28 escalate, cohorts A/AI-credit/B/C/D in `manual_tags`).
**Run A = `master-2026-06-15`** (run id 34), anna-case `master` @ `daf541f`, model `gemini-2.5-flash`,
prompt `dispute-planner-v2` (`anna-case:1c177ada`). 43/43 completed, 0 errors.

> Required a one-line harness fix first: `anna-case-bridge.ts` `projectEnrichment` was sending
> `parsed_documents` as raw strings, but current anna-case `EnrichmentData` requires `DocumentLabel`
> objects — every case failed Pydantic validation (CLI exits 0, writes nothing). Fixed by wrapping each
> parsed-document string as `{ description }`. No effect on scoring/decisions. (Exactly the bridge-drift
> the brief warned about.)

## Confusion matrix (harness, binary)
```
true_credit=1  false_credit=2  true_escalate=8  false_escalate=11  unlabeled=21  undecided=0
sample=43  agreement=20.9%  credit_precision=33.3%  escalate_recall=80%  false_credit_rate=66.7%
```
**`unlabeled=21` = the 21 `request_evidence` outputs the binary matrix can't bucket** (see below).
The headline metrics are computed over all 43 but treat those 21 as non-agreement, so they read worse
than the pipeline actually behaves. Take the matrix as covering only the 22 credit/escalate cases.

## ⚠️ Finding 1 — `request_evidence` is now dominant (21/43), and the harness drops it
The current master prompt is the post-#442 three-decision model (`credit` / `request_evidence` /
`escalate_to_agent`). The brief assumed the set was "safe" because no *human outcome* was
request-evidence — but that's about the answer key, not the *pipeline*. Master emits `request_evidence`
for **A:3, B:2, C:5, D:11**. The harness analytics/compare are binary and silently count these as
"unlabeled", so any A↔B flip-diff will be blind to ~half the cases. **This caps the backtest** exactly
as the brief's REQUEST_EVIDENCE caveat predicted — reusing this harness on the post-#442 pipeline needs
the analytics extended to a third class before the flip-diff means anything.

## ⚠️ Finding 2 — scoring recalibration alone may not recover cohort A
Cohort A is the "recover target" (should credit). On master **0/13 credit** (10 escalate, 3 request_evidence).
But four A cases **already score GREEN (≥70)** and still don't credit:
`34075 GREEN/79→escalate`, `34732 GREEN/77→escalate`, `35882 GREEN/77→escalate`, `33822 GREEN/72→request_evidence`.
So the gate on cohort A is the **planner's escalate/request-evidence logic, not the score** — pushing
scores higher won't flip these to credit. A scoring recalibration may move AMBER→GREEN, but the planner
still won't credit. This questions the brief's core thesis that recalibrated scoring recovers cohort A;
the bottleneck looks like the planner prompt (the dispute-agent track), not the rubric.

## Decision by cohort (Run A / master)
| cohort | label | credit | escalate | request_evidence |
|---|---|---|---|---|
| A (recover, 13) | credit | 0 | 10 | 3 |
| AI-credit (2) | credit | 1 (35424) | 1 (37075) | 0 |
| B (plumbing, 3) | escalate | 0 | 1 (34081) | 2 |
| C (human, 6) | escalate | 0 | 1 (34073) | 5 |
| D (must-hold, 19) | escalate | **2 (34113, 38007)** | 6 | 11 |

- **False credits on master: 2** — cohort D `34113` (GREEN/79) and `38007` (GREEN/79). Humans found no
  grounds; master credits. If recalibration raises scores, watch these (and the other GREEN/75-79 D cases)
  for *more* false credits — the regression risk the brief flags.
- **False escalates: 11** = all of cohort A's 10 escalates + AI-credit's `37075`. These are the
  "wrongly escalated" cases the recalibration is meant to recover.

Per-case detail: `node scripts/per-case.mjs 34`.

## Next: Run B
Awaiting the recalibration branch (none of the ~70 existing anna-case branches edit the scoring brackets).
Once named: verify it edits `risk_scorer.py`/`ScoringConfig`, `git checkout` + `uv sync`, run
`signal-fix-2026-06-15`, then `compare?runA=34&runB=<B>`. **Before trusting the compare, extend the
harness analytics to handle `request_evidence`** (Finding 1) or the flip-diff will miss half the cases.

# fn1 validation — payment problem classifier

Run `fn1` on snapshot `fortnight-0821-0903` (21 Aug – 3 Sep 2026), validated 7 Sep 2026. Read of what the run already produced; no pipeline LLM calls were made. Pilot `r1` on `pilot-2026-08-19` checked for reconciliation only (§8).

**Where the data is.** The classifier persists nothing to Postgres. `services/db.ts` creates only dataset and queue-analyser tables, and the `experiments-postgres-1` container was stopped throughout. Every number below comes from `data/problem-classifier/fortnight-0821-0903/{population.json,bundles/,runs/fn1/{pass1,pass2,pass3,llm-calls.ndjson}}` and from BigQuery. "DB" in the brief means these files.

**Sampling.** Python `random.Random(20260907)`, drawn from id lists sorted ascending. Sample ids are listed in each section. Hand-reads were done by eight parallel read-only agents against rendered bundles (messages, tasks, identified ledger row, shortlist, reading), one fixed rubric each; their per-thread lines are reproduced verbatim where they matter.

**Outputs written next to the snapshot:** `labels.csv` (1,547 rows), `labels-escalation.csv` (same plus BigQuery escalation and human-touch flags), `category-escalation.csv` (category × escalation for both label sets).

---

## 1 · Population

| check | recorded | found |
|---|---:|---:|
| thread_ids in `population.json` | 1,547 | **1,547**, all distinct |
| per leaf (pending / missing / outgoing) | 600 / 519 / 428 | **600 / 519 / 428** |
| dialogues / customers | 3,972 / 1,205 | **3,972 / 1,205** |
| `first_dialogue_at` = min(dialogue created_at) | — | 1,547 / 1,547 |
| threads dated 3 Sep | — | **128** (46 pending · 49 missing · 33 outgoing) |

Snapshot manifest: created 2026-09-04T15:57:37Z, seed 20260903, selector predicate and three path keys as in the PRD.

**Was 3 Sep partially tagged?** Not more than the rest of the tail. Live selector on 7 Sep vs snapshot, per day:

| day | live | in snapshot | snapshot | dropped since | new since |
|---|---:|---:|---:|---:|---:|
| 21–24 Aug (4 days) | 390 | 383 | 385 | 2 | 7 (1.8%) |
| 25–31 Aug (7 days) | 754 | 685 | 699 | 14 | 69 (9.2%) |
| 1 Sep | 199 | 174 | 181 | 7 | 25 (12.6%) |
| 2 Sep | 160 | 150 | 154 | 4 | 10 (6.3%) |
| 3 Sep | 136 | 121 | 128 | 7 | 15 (11.0%) |
| **total** | **1,639** | **1,513** | **1,547** | **34** | **126** |

The 3 Sep batch landed between 12:00 and 15:57 UTC on 4 Sep (1,407 → 1,547 ≈ 1,407 + 128). Since then the whole window has grown by 126 threads and lost 34; the tail three days grew ~10%, the head four days ~2%. So every day in the window was incomplete at snapshot time, with a recency gradient, and 3 Sep sits inside that gradient rather than outside it.

**Why 34 snapshot threads are no longer selected** (one row per thread, `gemma.thread_scenarios` + `gemma.threads`, 7 Sep):

| reason | n |
|---|---:|
| thread has no `thread_scenarios` row any more | 18 |
| thread_id gone from `gemma.threads` (re-threaded) | 6 |
| primary path re-tagged elsewhere (Misc 2, Document request under review 2, Payment link, Account review, Transfer balance on closure, Pay saved payee, Mark invoice paid, Payment held for check) | 10 |

The threading table revises as well as the scenario table. The snapshot is the population; nothing here changes it. Ids in `/tmp/pcv/dropped_ids.txt` at time of writing (not kept in repo).

---

## 2 · Pass 1 integrity

**Verdicts (files, all 1,547 present):**

| leaf | RESOLVED | ORDER_ONLY | NOT_FOUND | total |
|---|---:|---:|---:|---:|
| Incoming payment status / pending | 478 | 1 | 121 | 600 |
| Missing or failed incoming payment | 279 | 1 | 239 | 519 |
| Payment status / pending (outgoing) | 362 | 17 | 49 | 428 |
| **total** | **1,119** | **19** | **409** | **1,547** |

Matches the recorded 1,119 / 19 / 409. Pass 2 read every thread and its `pass1_state` agrees with pass 1 on all 1,547.

**Resolution in fetched ledger data.** 1,119 / 1,119 RESOLVED `identified.id` values are present in the thread's own `bundle.candidates.ledger`; 19 / 19 ORDER_ONLY ids are present in `candidates.orders_without_ledger` (keyed `public_id`, not `id`). Pick handle → shortlist id → identified id is consistent on all 1,119. **0 unresolved.** Caveat: this is resolution inside the tool's own BigQuery pull for that customer, not an independent check against `balance_virtual_transaction`; the pull is what defines "our records" for this run.

Pick confidence on RESOLVED: high 1,106 · medium 11 · low 2. Pass-1 paths: `regex+pick` 834 · `regex+pick→extract+pick` 453 · `regex+pick→extract` 168 · `regex-empty→extract` 49 · `regex-empty→extract+pick` 43. NOT_FOUND with an empty shortlist: 49; NOT_FOUND where extract said `no_payment_discussed`: 27.

**20 random RESOLVED threads, is the pick the payment the customer talks about?**

| verdict | n |
|---|---:|
| HIT, explicit id / amount+counterparty+date in text | 14 |
| HIT, consistent match (Stripe payout net of fees) | 1 |
| AMBIGUOUS, two or more rows fit equally | 2 |
| MISS | 2 |
| NO-PAYMENT, conversation not about a specific payment | 1 |

Hits 15/20. Misses and ambiguities:

- `317691839` MISS — thread is a to-do prompt "Unfinished payment to HARBOUR GRILL LTD" (an unsent draft); the picked £3,265 to the same payee on 23 Aug is PROCESSED. Nothing should have been picked.
- `317796119` MISS — customer is chasing four expected incoming payments (three £100 Stripe, one SWIFT), none in the ledger yet; the pick is the declined £17.42 ANNA subscription fee that motivated the chase. Should be NOT_FOUND.
- `316856272` NO-PAYMENT — only customer text is "No, thanks" to an invoice prompt amid ~10 identical £60 QR receipts; the picked £60 is arbitrary.
- `319288511` AMBIGUOUS — "Has Stage One paid me recently" on 3 Sep; bot cited 5 Jun £1,285, the pick is a £1,285 row that arrived 4 Sep, after the question. `pick.why` misdates the row.
- `318608660` AMBIGUOUS — "check a transaction from Vital transport"; bot lists three (£96, £210, £48), customer never narrows; £96 picked.

Pattern: the picker never picks a wrong *counterparty*; it fails by picking *something* when the thread has no identifiable payment (a draft, a future payment, a receipt stream). Pick confidence was `high` on all five.

Sample: 317691839 317531808 318773413 317627662 317855470 318961320 317888466 319288511 317199409 317770159 317383928 318527941 319378802 318041966 318612759 316588252 317796119 318608660 316856272 317171152.

**10 random NOT_FOUND threads:**

| verdict | n |
|---|---:|
| GENUINE-ABSENT (specific payment described, nothing in ledger) | 2 |
| NO-SPECIFIC-PAYMENT (no single payment to find) | 5 |
| PICKER-MISS (a matching row is in the bundle) | 2 |
| BUNDLE-GAP (row exists but outside the candidate window) | 1 |

- `317273182` PICKER-MISS — customer asks at 01:39 on 25 Aug whether a ~£100 SEPA credit is pending; shortlist row S11 is SEPA PROCESSED 98.96 GBP (116.9 EUR) from NORTHWIND LTD at 09:20 the same day. Pass 1 said NOT_FOUND.
- `318035592` PICKER-MISS — agent outbound about a held incoming refund of the "second June" AVENSURE direct debit; the DD is S03 (id 4897220f, −212.95 GBP, 2026-06-29), the extraction carried its explicit id and date. The *refund* is a partner hold with no ledger row, so the miss is arguable, but the thread's anchor transaction was in hand.
- `317011610` BUNDLE-GAP — bot answered "£294 from TRACEY MURPHY on 2022-07-01"; every candidate is August 2026. The ledger window (six months back) cannot hold it.
- Genuine absent: `316677019` (blocked refund from TWICE NICE, fraud case), `318136283` (Flow Logistics weekly wage not arrived).
- No specific payment: `316723276` `318910296` `316551817` `316923082` `316656606`.

So of 409 NOT_FOUND, the sample suggests roughly half are "no single payment in the conversation" rather than "payment absent from our records". Design rule 6 wants those two apart; the verdict set does not separate them. `no_payment_discussed` is set on only 27 of 409.

---

## 3 · Pass 2 read quality

**Stratified: 3 threads per label-a category, 33 threads.**

| score | n | % |
|---|---:|---:|
| what-happened CORRECT | 20 | 61% |
| what-happened PARTLY (right core, wrong or invented detail) | 10 | 30% |
| what-happened WRONG | 3 | 9% |
| what-would-remove SENSIBLE | 26 | 79% |
| what-would-remove VAGUE | 0 | — |
| what-would-remove WRONG | 7 | 21% |
| label a FITS | 21 | 64% |
| label a MISFIT | 12 | 36% |

Wrong readings:

- `316593946` (Automated chat gave wrong status) — asserts Gemma misreported a CANCELLED card auth as pending; the row is a post-hoc snapshot of a POS auth that the customer's own app showed pending on 21 Aug. Removal ("surface CANCELLED") would have been wrong at the time.
- `317558137` (Search returned wrong result) — chat 09:49–09:51, payment posted 10:43 on the same clock; reading shifted only the chat time to BST and concluded the payment "had already landed six minutes before". Also reverses payer/payee.
- `319091183` (Search returned wrong result) — customer asked 08:48, the £50 credit posted 09:00; Gemma's "6 Aug" was correct when given. Reading calls it stale and proposes indexing a payment that did not exist yet. Reverses payer/payee.

Misfit direction (12): 8 should be **Payment in transit / No problem** (from Automated chat status ×2, Search ×2, Missing incoming ×3, Inaccurate information ×1) — cases where the payment simply arrived after the chat. 4 should be **Outgoing payment held pending compliance** (from Held by compliance ×2, Declined ×2) — the three compliance categories are one case space cut by outcome. Full per-thread lines in §Appendix A.

**Two systematic reader defects, seen across every sample set:**

1. **Payer/payee inversion on inbound rows.** The reading names `original_payee_account_name` (the customer's own account name on an inbound row) as the *sender*. Seen on 7 of 20 "No problem" readings, 6 of 20 "in transit" readings, 2 of 12 in strata set 2, 1 of 9 in set 3. It does not usually change the verdict but it corrupts every "Payment" section and any category defined by counterparty (wrong account, missing origin).
2. **UTC vs London time mixing.** Ledger timestamps are UTC, messages are rendered UTC, the reader converts one and not the other and then reasons about before/after (`317558137`, `319091183`, `317011220`). Two of the three WRONG readings are this.

Also: `317177905` reading states "No human agent was involved at any point" while a task comment shows a human instructing Gemma; `317358493` quotes customer lines and amounts that are not in the record.

**Probe A — "No problem occurred" (413).** BigQuery over all 413: **9 escalated (2.2%), 19 human-touched (4.6%)**. Random 20 (sample below): label HOLDS 17 · WEAK 2 · WRONG 1; human involved 2; reading account wrong 0. The one WRONG is `317872979`, also in the escalated set.

All 9 escalated "No problem" threads read:

| thread | label verdict | why Gemma handed over |
|---|---|---|
| `319349480` | HOLDS | customer's *receiving* bank had suspended his account; FP was PROCESSED; human gave the same answer |
| `317616809` | HOLDS | FYI about employer/HMRC appended to an open VAT task; human: "info only" |
| `318791905` | HOLDS | advance-fee scam message; URGENT fraud confirmation, not a payment problem |
| `317177905` | WEAK | £100 FP sent Saturday, not received Monday; escalated on the >1-working-day rule; human resolved via task comment. **Reading says no human was involved.** |
| `318161110` | WEAK | "account flagged for fraud" — was Lloyds' scam check on the *sending* side; Gemma cannot check ANNA-side restrictions itself; £150 landed 15 min later |
| `317865792` | WEAK | payer's bank error "authorisation server railsr2 doesn't have a record of the account"; £10,000 arrived 8 min later. Reading misreads payer as "a third party" and blames the sender's bank when the message names Railsr |
| `316294115` | WEAK | customer demanded a human to pre-notify a £350k drawdown so it would not be held like his August £180k; Gemma has no way to record it |
| `317872979` | **WRONG** | thread also carries the £81,597.78 Sporty Internet SWIFT held under risk rule 3003 from 25 Aug to 28 Aug 07:34 (task 1223219, MT103 requests); "No problem" is wrong for the thread |
| `319432824` | **WRONG** | genuine duplicate £39.90 card charge (two POS debits 4 min apart) needing a dispute and refund; escalation itself was administrative |

Two of nine are mislabelled; four more are "payment fine, automation could not answer". The 413 is therefore roughly right as a count but ~1 in 20 of it hides a real problem, and the escalated slice is where they sit.

Sample (20): 317900479 317872979 316887843 319103970 316884086 316534398 318249467 316804320 318527732 317616809 319059789 318794059 317136659 319296986 317073276 317011220 318627746 317811235 318693912 316652565.

**Probe B — "Payment in transit, customer unaware of normal delay" (209).** Population view first, from the identified ledger rows of the 170 RESOLVED threads in this category: status PROCESSED 161 · PENDING 6 · CANCELED 2 · DECLINED 1; rails BACS 65 · FP 64 · POS 25 · SWIFT 5 · SEPA 5; create→post lag p50 18.1 h, p90 72.3 h, max 96.5 h. So the category is mostly BACS/FP that did post, within its rail window.

Random 20, hand-read:

| result | n |
|---|---:|
| arrived, in the record | 15 |
| never arrived in the record | 2 |
| identified row is not the awaited payment | 3 |
| lag within rail window | 14 |
| lag beyond rail window | 4 |
| a hold present | 1 |
| **label HOLDS** | **7** |
| **label WRONG** | **13** |
| reading wrong | 8 (6 of them payer/payee inversion) |

The 13 "wrong" break down as:

- **Already posted before the customer asked** — nothing was in transit: `317388089` (3 days before), `319497842` (10 h before), `317908843` (6 days before). Should be No problem / Search.
- **No payment existed**: `316573303`, `317250914` (YouLend never sent). Should be Missing / No problem.
- **Identified row is an outgoing card charge or a declined fee, not the awaited credit**: `317886786`, `318630373`, `317796119`. Pass-1 miss carried into the label.
- **Scheduled outgoing payment awaiting its 09:00 cut-off**: `318395940`.
- **Sender-side hold**: `316878272` — HSBC paused the £1,900 before release. KKV's "scam checks on the sender's side" group (§4).
- **FP arrived 17–24 h after the chat with no visible hold**: `318983328`, `318840873`. A 24-hour Faster Payment is not a normal in-window delay; the delay was upstream of ANNA.
- **Collateral decline**: `317154169` — the BACS itself cleared in window, but a Thames Water DD was declined for insufficient funds while the credit was pending. Label defensible for the payment, wrong for the customer's problem.

Reading this strictly, 7 hold, 3 are arguable (the two 24 h FPs and the collateral DD), 10 are misfits. Structural point: for Faster Payments the ledger row is created at arrival, so "in transit" is never observable on ANNA's side — the category is being assigned by *the customer's wait* rather than by evidence of transit, which is why already-posted and never-sent cases fall into it.

Sample: 319170127 316573303 318890700 316946939 318395940 317154169 318983328 317388089 319497842 319136078 317886786 318630373 317908843 317250914 316878272 317796119 317986998 318840873 319116177 317743731.

---

## 4 · Pass 3 stability

Both inductions ran `two-step`, induced from the **same** seeded 400-thread sample (seed 20260903; 159 pending / 134 missing / 107 outgoing), then assigned all 1,547 in 74 batches each. Because the induce sample is identical for a and b, the a-vs-b agreement measures induction-plus-assignment noise at a fixed sample, not sensitivity to the sample.

Agreement: **1,197 / 1,518 = 78.9%** over threads both sets assigned (the recorded figure, via `pc-compare-pass3.ts`); **1,197 / 1,547 = 77.4%** over the population, counting the 21 threads unassigned by one side as disagreement. Unassigned: a 16, b 21, both 8.

**Confusion matrix, label a rows × label b columns** (b columns abbreviated; legend below):

| a \ b | NoProb | b-Delay | b-Status | Held | b-Declined | WrongAcct | b-NeverArrived | b-Blocked | b-PartnerHold | b-Search | b-Misinformed | unassigned | total |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| No problem occurred | **395** | 10 | 2 | · | · | 1 | · | · | · | 2 | 2 | 1 | 413 |
| Payment held by compliance or fraud review | · | · | 2 | **70** | 4 | · | 1 | 10 | 22 | · | 2 | · | 111 |
| Payment declined or returned | 1 | 1 | 1 | · | **51** | 2 | 1 | 3 | 3 | · | 3 | · | 66 |
| Payment in transit, normal delay | 12 | **188** | 5 | · | · | · | 1 | · | · | · | 3 | · | 209 |
| Automated chat gave wrong status | · | 1 | **86** | · | · | · | · | · | · | 8 | 11 | · | 106 |
| Payment sent to wrong or closed account | · | · | · | · | · | **57** | 9 | · | 2 | · | · | 1 | 69 |
| Search or lookup wrong result | 5 | · | 5 | 1 | · | · | · | · | · | **37** | 4 | 1 | 53 |
| Outgoing held pending compliance | 1 | · | 2 | 51 | 14 | 1 | · | 4 | **55** | · | 7 | · | 135 |
| Account blocked, incoming declined | 1 | · | · | 1 | 3 | 3 | · | **54** | 1 | · | · | · | 63 |
| Missing incoming, origin unknown | 27 | 5 | · | · | 1 | 2 | **111** | 3 | 4 | 1 | 4 | 3 | 161 |
| Inaccurate information given | 9 | 2 | 11 | · | · | 4 | · | 10 | 7 | 2 | **93** | 7 | 145 |
| unassigned | 1 | 1 | · | · | · | 1 | · | 4 | 1 | · | · | 8 | 16 |

b legend: b-Delay = Normal settlement delay, customer unaware · b-Status = Inaccurate status shown to customer · b-Declined = Payment declined on compliance grounds · b-NeverArrived = Payment never arrived at ANNA · b-Blocked = Account blocked, payments declined as a result · b-PartnerHold = Delayed or poor handling of partner hold · b-Search = Search or lookup returned wrong result · b-Misinformed = Customer misinformed by agent or automation.

**Self-agreement per label-a category** (share landing in its matched b category):

| label a | matched b | agree | stable? |
|---|---|---:|---|
| No problem occurred | No problem occurred | 395/413 · **96%** | yes |
| Payment in transit, normal delay | Normal settlement delay | 188/209 · 90% | borderline |
| Account blocked, incoming declined | Account blocked | 54/63 · 86% | no |
| Payment sent to wrong or closed account | same | 57/69 · 83% | no |
| Automated chat gave wrong status | Inaccurate status shown | 86/106 · 81% | no |
| Payment declined or returned | Declined on compliance grounds | 51/66 · 77% | no |
| Search or lookup wrong result | same | 37/53 · 70% | no |
| Missing incoming, origin unknown | Payment never arrived at ANNA | 111/161 · 69% | no |
| Inaccurate information given | Customer misinformed | 93/145 · 64% | no |
| Payment held by compliance or fraud review | same | 70/111 · 63% | no |
| Outgoing held pending compliance | Delayed handling of partner hold | 55/135 · **41%** | no |

Only "No problem" clears 90%; "in transit" sits on it. **The swaps that matter:**

- **Outgoing held pending compliance (135)** splits three ways in b: 55 partner-hold handling, 51 held by compliance, 14 declined. Label a itself notes it "merged" outgoing with held "per the merge-before-split rule" and then kept both. The three compliance categories in a (Held 111 + Outgoing held 135 + Declined 66 = 312) and the three in b (Held 123 + Partner hold 95 + Declined 73 = 291) are one case space cut differently each time — by direction in a, by whose fault the delay was in b.
- **Missing incoming, origin unknown → No problem: 27.** One induction sees an absent payment, the other sees a customer asking about money nobody sent.
- **Held by compliance → Partner hold handling: 22; → Account blocked: 10.**
- **Inaccurate information** leaks to six b categories (11 status, 10 blocked, 9 no problem, 7 partner hold, 7 unassigned). It is a property of the conversation, not of the payment, so it competes with every other category on every thread.

**The 16 unassigned (label a):** 319201390 · 319394197 · 319299044 · 318582520 · 318066196 · 317584571 · 318018568 · 317521265 · 319214987 · 317380887 · 317812554 · 317115151 · 317445593 · 319056298 · 318572348 · 317907413. Reasons given: unsent draft order (2: 319394197, 317115151-adjacent), card decline on account block (318582520, 318018568), failed recall / DD indemnity process (318066196, 317445593), sender's bank flagged the ANNA account as fraudulent (317380887), APP-fraud claims against a mule account (317907413, 317812554), non-customer (317584571), low-balance / DD insufficient funds UX gap (317521265, 319214987), customer picked the wrong payee (318572348), transfer timed out at the other bank (319056298), thin record (319299044), unanswered query closed overnight (319201390).

**The two hand-named PRD categories:**

- **RFI — request for information on the transaction.** Recognisable in **b** as "Delayed or poor handling of partner hold" (95): its definition is literally "partner intercepted a payment and requested information". In **a** there is no such category; RFI-shaped readings (regex `request(ed) for (further|additional) information|RFI|source of funds|KYB|questionnaire|proof of` over the pass-2 text, 245 hits) sit 69 in Held by compliance and 68 in Outgoing held, i.e. inside the outcome-cut compliance categories. Neither set names the *resolution* ("generate the information request") as the category.
- **Scam checks on the sender's side.** **Absent from both sets.** Reading the pass-2 text for sender-bank holds (tight regex, then snippets read by hand) finds at least **24 threads** where the payer's bank (HSBC, Lloyds, Halifax, Monzo, Revolut, Chase, "their bank") warned, paused, blocked or scam-checked a payment *into* the customer's ANNA account: 319469748 319477630 319247891 318963685 319298943 317896903 318465630 318251122 318161110 316657295 317380887 318955990 319159963 318450451 316743894 318633959 319211179 319373829 318171980 316720469 319424487 316878272 318458392 317128034. Lower bound; a regex on prose. Where they landed in a: Missing incoming 10 · Inaccurate information 8 · No problem 2 · In transit 2 · Declined 1 · unassigned 1. In b: Never arrived 6 · No problem 5 · Misinformed 4 · Blocked 3 · unassigned 3 · others 3. **15 of the 24 escalated (63%), 16 human-touched**, against 20% for the population. Pass 1 said NOT_FOUND on 17 of 24, which is correct — the money never reached ANNA — and is also why both inductions read them as "missing" or "no problem". The group KKV named exists, is small (~1.5% of threads, ~5% of escalations), and neither induction can see it because the readings describe it as an outcome (money absent) rather than as the thing that closes it (a sentence to the payer).

---

## 5 · Category × escalation — the join that matters

Definitions, BigQuery 7 Sep, over the snapshot's own 3,972 dialogue ids (not a re-query of `gemma.threads`): **escalated** = any dialogue in the thread has a `create_support_task` or `amend_support_task` turn in `verified_tables.gemma_turn_events`, `not is_error`, output not starting "Rethink requested", `started_at` 20 Aug – 8 Sep. **human-touched** = any dialogue in `verified_tables.gemma_dialogue_human_touch_reason` (cast INT64), 1 Aug – 8 Sep. Both joined on `dialogue_id`.

| population | threads | escalated | rate | human-touched | rate |
|---|---:|---:|---:|---:|---:|
| all fn1 | 1,547 | **316** | **20.4%** | 510 | 33.0% |
| Incoming payment status / pending | 600 | 62 | 10.3% | 108 | 18.0% |
| Missing or failed incoming payment | 519 | 140 | 27.0% | 227 | 43.7% |
| Payment status / pending (outgoing) | 428 | 114 | 26.6% | 175 | 40.9% |
| pass 1 RESOLVED | 1,119 | 257 | 23.0% | 388 | 34.7% |
| pass 1 ORDER_ONLY | 19 | 1 | 5.3% | 5 | 26.3% |
| pass 1 NOT_FOUND | 409 | 58 | 14.2% | 117 | 28.6% |

The outside check (live population, 1,639) gave 10.2% / 27.2% / **24.2%** per leaf. Incoming leaves agree to 0.2 pp; outgoing is 2.4 pp higher on the snapshot. Different population (428 vs 462 threads); not resolved here. Human-touch reasons at thread level: escalation 290 · outbound 66 · other 39 · skill_handover 36 · blocked 33 · email_in 26 · web_chat 19 · email_out 4. 14 threads escalated without a human touch; 208 human-touched without an escalation (outbound, web chat, e-mail, skill handover).

**Label a × escalation** (`category-escalation.csv`):

| label a category | threads | escalated | escalation rate | share of all 316 escalated | human-touched | ht rate |
|---|---:|---:|---:|---:|---:|---:|
| Outgoing payment held pending compliance, then released or declined | 135 | 58 | 43.0% | 18.4% | 80 | 59.3% |
| Payment held by compliance or fraud review | 111 | 47 | 42.3% | 14.9% | 77 | 69.4% |
| Missing incoming payment, origin unknown | 161 | 44 | 27.3% | 13.9% | 62 | 38.5% |
| Inaccurate information given to customer | 145 | 39 | 26.9% | 12.3% | 77 | 53.1% |
| Payment sent to wrong or closed account | 69 | 30 | 43.5% | 9.5% | 39 | 56.5% |
| Payment declined or returned, funds not received | 66 | 27 | 40.9% | 8.5% | 43 | 65.1% |
| Account blocked, incoming payments declined | 63 | 21 | 33.3% | 6.7% | 39 | 61.9% |
| Payment in transit, customer unaware of normal delay | 209 | 19 | 9.1% | 6.0% | 36 | 17.2% |
| Automated chat gave wrong payment status | 106 | 17 | 16.0% | 5.4% | 24 | 22.6% |
| No problem occurred | 413 | 9 | 2.2% | 2.9% | 19 | 4.6% |
| Payment search or lookup returned wrong result | 53 | 4 | 7.5% | 1.3% | 8 | 15.1% |
| unassigned | 16 | 1 | 6.2% | 0.3% | 6 | 37.5% |

**Label b × escalation:**

| label b category | threads | escalated | escalation rate | share of all 316 | human-touched | ht rate |
|---|---:|---:|---:|---:|---:|---:|
| Delayed or poor handling of partner hold | 95 | 50 | 52.6% | 15.8% | 70 | 73.7% |
| Payment held by compliance or fraud review | 123 | 46 | 37.4% | 14.6% | 72 | 58.5% |
| Payment never arrived at ANNA | 123 | 44 | 35.8% | 13.9% | 58 | 47.1% |
| Customer misinformed by agent or automation | 129 | 37 | 28.7% | 11.7% | 72 | 55.8% |
| Payment declined on compliance grounds | 73 | 30 | 41.1% | 9.5% | 47 | 64.4% |
| Account blocked, payments declined as a result | 88 | 28 | 31.8% | 8.9% | 58 | 65.9% |
| Payment sent to wrong or closed account | 71 | 27 | 38.0% | 8.5% | 39 | 54.9% |
| Normal settlement delay, customer unaware | 208 | 18 | 8.6% | 5.7% | 34 | 16.4% |
| Inaccurate status shown to customer | 114 | 15 | 13.2% | 4.8% | 21 | 18.4% |
| No problem occurred | 452 | 13 | 2.9% | 4.1% | 24 | 5.3% |
| unassigned | 21 | 5 | 23.8% | 1.6% | 8 | 38.1% |
| Search or lookup returned wrong result | 50 | 3 | 6.0% | 0.9% | 7 | 14.0% |

What holds across both label sets, because the escalation flag is independent of the induction:

- **Compliance and fraud control drives about half of the escalations in these leaves.** a: Outgoing held + Held + Declined + Blocked = 153 / 316 = **48.4%**. b: Partner hold + Held + Declined + Blocked = 154 / 316 = 48.7%. These are the alert-driven cases design rule 8 says to separate before counting; here they *are* the escalation load.
- **Missing incoming, origin unknown / never arrived at ANNA = 13.9%** in both sets (44 threads, identical count). The class with no transaction to read.
- **Wrong or misleading information (agent or automation) = 12–18%** (a: 39 + 17 = 56, 17.7%; b: 37 + 15 = 52, 16.5%). Knowledge, not tools.
- **Wrong or closed account = 8.5–9.5%.**
- **The customer-was-simply-early categories carry almost none of it**: No problem + in transit + search = 32 / 316 = 10% in a, 34 in b, at 2–9% escalation rates. They are 44% of threads and 10% of escalations.

Denominators: the 316 are escalations *within these three leaves over 21 Aug – 3 Sep on the snapshot*. KKV's 30% is these leaves' share of *all* escalations on a different window and the live tagger. Multiplying a share here by 30% gives a share of all escalations only if the leaf mix and the tagger's revision are the same on both, which §1 shows they are not (to about ±8%).

---

## 6 · Payment collapse

1,138 identified threads (1,119 ledger + 19 order) → **993 distinct payment keys**. Confirmed.

| threads per payment | payments |
|---:|---:|
| 1 | 898 |
| 2 | 63 |
| 3 | 22 |
| 4 | 5 |
| 5 | 3 |
| 6 | 1 |
| 7 | 1 |

Payments with 4+ threads (all single-customer; leaf mix of the threads):

| payment | threads | thread ids | leaves |
|---|---:|---|---|
| ledger 2977b6da | 7 | 317469981 318543345 318562074 317686406 318542904 317633745 317553402 | pending 5 · missing 2 |
| ledger 73292cc7 | 6 | 317746884 318578985 317782039 317803174 319192495 319015380 | missing 3 · pending 3 |
| ledger 78882406 | 5 | 318212112 317009713 317513045 317009912 317201305 | outgoing 4 · missing 1 |
| ledger 52a79fc5 | 5 | 317054423 317307927 317171152 318702268 318028564 | pending 4 · missing 1 |
| ledger 8017063e | 5 | 318727339 317519673 317640699 317221060 316747513 | outgoing 5 |
| ledger ecbb52d0 | 4 | 319379790 317614799 317233903 318604021 | outgoing 4 |
| ledger fc373061 | 4 | 319279934 318602824 319046277 319072714 | outgoing 3 · pending 1 |
| ledger 7ee612f2 | 4 | 317854297 317878130 318700029 318582389 | outgoing 4 |
| ledger 59eeea7f | 4 | 318243845 318850924 317689232 318812391 | missing 2 · pending 2 |
| ledger adf93905 | 4 | 316891843 316891008 318312883 316923900 | missing 4 |

Six of the ten straddle two leaves: the same payment is tagged "pending" in one thread and "missing" in the next as the customer's wording changes. Threads overstate payments by 14.6% here (phase11: ~16%). NOT_FOUND threads (409) are not collapsed, since there is no key; they could be collapsed by customer instead.

---

## 7 · Cost

`llm-calls.ndjson`, 4,366 lines, sums to **$96.31**; the per-file `usage` sums (pass 1 $15.51 + pass 2 $71.79 + pass 3 a $4.48 + b $4.53 = $96.31) agree to the cent.

| pass | stage | model | calls | ok | input tokens | output tokens | cost |
|---|---|---|---:|---:|---:|---:|---:|
| 1 | extract | claude-haiku-4-5 | 714 | 713 | 2,733,546 | 95,198 | $3.21 |
| 1 | pick | claude-haiku-4-5 | 1,955 | 1,952 | 11,468,015 | 166,015 | $12.30 |
| 2 | read | claude-sonnet-4-6 | 1,547 | 1,547 | 19,522,573 | 881,723 | $71.79 |
| 3 | induce (a, b) | claude-sonnet-4-6 | 2 | 2 | 462,500 | 4,438 | $1.45 |
| 3 | assign (a, b) | claude-sonnet-4-6 | 148 | 148 | 2,061,476 | 91,235 | $7.55 |
| | **total** | | **4,366** | 4,362 | | | **$96.31** |

Four failed calls (3 pick, 1 extract), all `418 Interrupted`, cost $0, all retried successfully. `cache_read_input_tokens` is 0 on every call — no prompt caching happened. Pass 2 is 74.5% of spend; pass 1's pick stage is the second cost because 453 threads went `regex+pick→extract+pick` (paid twice).

---

## 8 · Pilot r1, for reconciliation

Snapshot `pilot-2026-08-19`: **122 threads** (39 missing / 41 pending / 42 outgoing), 378 dialogues, 113 customers, seed 20260819. Run r1: pass 1 = 85 RESOLVED / 1 ORDER_ONLY / 36 NOT_FOUND; pass 2 on `claude-sonnet-4-6`; two inductions, 11 categories each, two-step, no induce sample (n < 400), agreement 97/117 = 82.9%; cost $10.93. Two comparison reads exist on the same 122 threads (`cmp-haiku` $2.83, `cmp-flash` $1.20) each re-induced against the sonnet reading; **no Opus reading exists for any snapshot**. The r1 category set (e.g. "Card authorisation hold", "Declined direct debit, no advance warning", "Refund or return to closed account") does not survive into fn1's, where those cases are `unassigned` or folded into Declined/Inaccurate.

---

## 9 · PRD corrections

Claims in `brain/anna/payments/prd-problem-classifier.md` that the run data contradicts. Not edited there.

1. **§Pilot: "123 threads, split 39 / 42 / 42".** The snapshot has **122**, split 39 / 41 / 42. (§Verification's "reconcile to the snapshotted list exactly" holds at 122.)
2. **§Runtime models: pass 2 "Claude Opus 5 `claude-opus-5`", pass 3 "Opus 5", pass 1 overflow "Sonnet 5".** fn1 and r1 ran pass 2 and pass 3 on **`claude-sonnet-4-6`** via `.env` (`PC_MODEL_READ/INDUCE/ASSIGN`), pass 1 on `claude-haiku-4-5`; code defaults name `claude-opus-4-8`. No `claude-opus-5` or `claude-sonnet-5` call exists in any `llm-calls.ndjson`. The PRD's own rule — "Sonnet is the candidate step-down … only after a measured comparison on the same 20 threads" — has no Opus arm to compare against.
3. **§Runtime models: "Pass 3 is one call".** fn1 ran `two-step`: one induce call over a seeded 400-thread sample plus 74 assign batches per label. The a/b agreement is therefore measured at a fixed induce sample (§4).
4. **§Prompt caching: "verify with `usage.cache_read_input_tokens`".** It is 0 on all 4,366 calls; nothing was cached.
5. **§Design rule 6: "an extracted payment must resolve in `balance_virtual_transaction`".** As built, resolution is against the bundle's own candidate pull for that customer (§2), which is downstream of that table but not the same check; and the verdict set does not separate "no payment in the conversation" from "payment absent from our records" (§2, NOT_FOUND sample).
6. **§Population: "snapshot … and treat that file as the population".** Held. But `gemma.threads` also revises (6 snapshot thread_ids no longer exist, 18 lost their scenario row), so a later join back to BigQuery by thread_id will lose ~1.6% of the snapshot unless it goes through the snapshot's own dialogue list, as §5 does.
7. **§Categories already named by hand.** RFI is recognisable only in label b and only as a partner-hold-handling category; scam checks on the sender's side are in neither set (§4). By the PRD's own test that makes the induction suspect on the second.

---

## Appendix A · Stratified read, per-thread lines (33)

Format: `thread | what-happened | removal | category | evidence`.

**No problem occurred**
- 318802423 | CORRECT | SENSIBLE | FITS | £55 FP to BEN CRESSWELL PROCESSED 06:57 before the 10:46 chat; customer typed "Pay", told it had processed, left.
- 317418430 | CORRECT | SENSIBLE | FITS | £8.49 Microsoft POS pending 14:31 25 Aug, posted 26 Aug 06:52 as the bot said.
- 319443997 | CORRECT | SENSIBLE | FITS | "have I had a payment from P Davies" answered with a 25 Apr 2025 receipt; no P Davies row in window; borderline lookup-quality case.

**Payment held by compliance or fraud review**
- 318454352 | CORRECT | SENSIBLE | MISFIT→Outgoing held | rule 102 OUTBOUND_BLOCK 13:53 28 Aug, resolved 08:56 2 Sep; outgoing and released.
- 316699399 | CORRECT | SENSIBLE | MISFIT→Outgoing held | £1,291.20 held by rule 102 15:00, approved 15:40 (task 1221098), "Sorted"; outgoing hold released in 40 min.
- 318351479 | CORRECT | SENSIBLE | FITS | rule 6009 FULL_BLOCK on £4,555 inbound 17:32; bot said "clears within 2 hours" while the block was live; release 09:17 30 Aug.

**Payment declined or returned, funds not received**
- 317136530 | CORRECT | SENSIBLE | MISFIT→Outgoing held | salary FP held by rule 1001 08:01, "Declining payment, blocking account" 21:12, SAR task 1224374.
- 317581931 | CORRECT | SENSIBLE | FITS | inbound £500 FULL_BLOCK rule 6009 and £400 declined by anti-fraud; the £400 re-landing claim is not in the rendered shortlist.
- 318541638 | PARTLY | SENSIBLE | MISFIT→Outgoing held | hold/decline chain right (rules 3004 + 3001, decline 1 Sep); reading skips the 31 Aug dialogue where the bot called the held SWIFT "within the normal 1–5 day timeframe".

**Payment in transit, customer unaware of normal delay**
- 319235921 | CORRECT | WRONG | FITS | £1,000 + £9,000 from ANGEL INVESTMENTS landed 08:24 3 Sep; a landing notification could not have removed a contact 13 h earlier; what would have is the bot reading the screenshot direction correctly instead of saying the money went to the wrong company and "passed to the team" (no task).
- 317258387 | CORRECT | SENSIBLE | FITS | single-turn Stripe payout timing; £4.62 Stripe FP arrived 26 Aug; reading flags its own weak pick.
- 317552986 | CORRECT | SENSIBLE | FITS | FDMS BACS £2,047.96 created 08:00 26 Aug, estimated and posted 27 Aug 08:30; bot gave the same answer.

**Automated chat gave wrong payment status**
- 317651017 | PARTLY | SENSIBLE | MISFIT→In transit | £11,855 posted 27 Aug 09:56 next morning; reading invents a "closed at 00:09", dates contact inconsistently, omits that Gemma promised an escalation that never registered.
- 316593946 | WRONG | WRONG | MISFIT→In transit | asserts Gemma misreported a CANCELLED auth as pending; the row is a post-hoc snapshot of a POS auth the customer's app showed pending.
- 318554572 | PARTLY | SENSIBLE | FITS | rule 102 block 10:19, Gemma "on its way" 10:21, declined 1 Sep; names the £5,500 inbound "from Signature Vehicle Sales" when the payer is MAINOO KOBBIE paying into it.

**Payment sent to wrong or closed account**
- 319235502 | CORRECT | SENSIBLE | FITS | SWIFT to defunct Currency Cloud IBAN, details changed 26 Jun, bounce over ~10 working days; reminder for customers without an inbound SWIFT on new details is concrete.
- 317935438 | CORRECT | SENSIBLE | FITS | £800 to U HUSSAIN 20 Aug, retrieval 23 Aug, Railsr RBCS-625864, error 2A, DOB supplied 1 Sep.
- 317097824 | PARTLY | WRONG | FITS | £810 with wrong sort code returned 24 Aug; "returned of its own accord" contradicts the agent crediting the retrieval; proposed CoP screen already ran (cop=APPROVED on the misdirected payment).

**Payment search or lookup returned wrong result**
- 317558137 | WRONG | WRONG | MISFIT→In transit | chat 09:49–09:51, £192.90 posted 10:43; reading shifted only chat time to BST and concluded it "had already landed six minutes before"; reverses payer/payee.
- 318049108 | CORRECT | SENSIBLE | FITS | arrived as CHAPS 13 Aug ("never came in as a swift payment, showing as chaps") while Gemma and agent searched SWIFT only.
- 319091183 | WRONG | WRONG | MISFIT→No problem | asked 08:48, £50 NICHOLLS credit posted 09:00; Gemma's "6 Aug" was correct when given; reverses payer/payee.

**Outgoing payment held pending compliance, then released or declined**
- 318706337 | PARTLY | SENSIBLE | FITS | sanctions alert 3001 27 Aug cleared 1 Sep 16:13 with proactive agent message; reading says the hold delayed the DDs, but all four posted 14:16–14:27 against a 14:00 estimate.
- 317427691 | CORRECT | SENSIBLE | FITS | rule 1001 fired 15:15 25 Aug, released 27 Aug 19:47; agent told customer the automatic check and July review were separate.
- 317633871 | CORRECT | SENSIBLE | FITS | rule 3004 hold 11 Aug, KYB chaser 20 Aug, ANNA release 21 Aug, Railsr firewall hold (task 1221261) released 24 Aug.

**Account blocked, incoming payments declined**
- 317083095 | PARTLY | SENSIBLE | FITS | four inbound £22.70 FPs DECLINED; "account had been closed" and "fees written off" inferred, no closure task in record.
- 317358493 | PARTLY | SENSIBLE | FITS | compliance closure confirmed by tasks; reading quotes customer lines and three amounts not in the rendered record.
- 316537017 | CORRECT | SENSIBLE | FITS | closure notice 17 Aug, declined £200 ×2 and £150; tasks match 3 Aug review → 4 Aug closure → 17 Aug notice.

**Missing incoming payment, origin unknown**
- 319206424 | PARTLY | WRONG | MISFIT→In transit | Teya batch settlements PROCESSED 3 Sep 06:35 and 4 Sep; 3p test sale in next-day batch; mislabels BBBPIZZAFOOD as sender; proposes a per-transaction reconciliation ANNA cannot build. Sender-side: no.
- 317987324 | PARTLY | SENSIBLE | MISFIT→In transit | origin known (Akbank receipt); reading cites a £450 FP from "Aytekin Ertan" 1 Sep and dismisses it because not SWIFT-labelled — almost certainly the arrival via correspondent. Sender-side: no.
- 319197850 | CORRECT | SENSIBLE | MISFIT→In transit | identified row is an OUTGOING £1,000 FP, PROCESSED, cop=MATCHED; task opened 15:28 closed 15:31 with a confirmation; nothing here is an incoming payment of unknown origin. Sender-side: no.

**Inaccurate information given to customer**
- 318495428 | CORRECT | SENSIBLE | MISFIT→In transit | £11.77 Uber FP PROCESSED 00:31, 12 min after the 00:19 chat, then swept to subscription arrears; the bot's "not arrived yet" was true when said.
- 319240970 | PARTLY | WRONG | FITS | agent gave contradictory reasons; ledger shows INSUFFICIENT_FUNDS declines 12 Aug and PROCESSED 13 Aug, which the reading calls unresolved; Sixt auth count wrong (6 ≈ £3,534 vs task's 5 = £1,922.71).
- 317221526 | CORRECT | SENSIBLE | FITS | £150 self-transfer DECLINED by anti-fraud 16:01, bot said "pending" 16:16 and card "should work normally" 16:25; hold/SAR/closure tasks match.

---

## 10 · The 258 / 30% denominator

Reproduced the treemap spine verbatim — `anna-simple-reporting` `sources/bigquery/gemma/scenario_dialogues.sql` at commit 42bb4ac (31 Aug, identical to origin/master on 7 Sep), wrapped unchanged and filtered on `event_date`. Unit is the dialogue; "Human touched: Escalated" on the page is `reason = 'escalation'` from `verified_tables.gemma_dialogue_human_touch_reason`, which every dialogue of a thread inherits from the thread's first hand-off. Threads via `gemma.threads`.

**August 2026 (event_date 1–31 Aug), run 7 Sep:**

| population | dialogues | reason = escalation | escalated threads | touched dialogues |
|---|---:|---:|---:|---:|
| Incoming payment status / pending | 2,334 | 282 | 132 | 500 |
| Missing or failed incoming payment | 2,567 | 536 | 317 | 994 |
| Payment status / pending (outgoing) | 2,320 | 432 | 219 | 955 |
| **three leaves** | **7,221** | **1,250** | **668** | 2,449 |
| all other paths | 184,489 | 9,235 | 5,358 | 37,261 |
| **all paths** | 191,710 | **10,485** | **6,026** | 39,710 |

Same query with `gemma.threads` and `gemma.thread_scenarios` at `FOR SYSTEM_TIME AS OF 2026-09-04 12:00 UTC`: 280 / 540 / 429 escalation dialogues in the three leaves, 9,212 elsewhere. **The population the PRD read on 4 Sep was already this size.** 258 conversations / ≈857 escalated is not a state this spine has been in for August at any point in the travel window; it came from another artefact (a stale Evidence build, a week rather than the month, or a different filter). Not recoverable from BigQuery.

**Which denominator gives 30%:**

| denominator (August, reason = escalation) | three leaves' share, dialogues | share, threads |
|---|---:|---:|
| all paths (10,485 dialogues / 6,026 threads) | **11.9%** | **11.1%** |
| l1 = Business account (3,992 / 2,439) | **31.3%** | 27.4% |
| l2 = Incoming + Outgoing payments (2,254 / 1,259) | 55.5% | 53.1% |

"About 30% of all escalations" reproduces only as the three leaves' share of **Business account** escalations. Of all escalations they are 11–12%. Every downstream target that quotes 30% needs to say which of these it means; halving 11.9% of all escalations and halving 31% of Business-account escalations are the same threads but a different promise.

Fortnight 21 Aug – 3 Sep on the same spine: 481 escalation dialogues / **290 escalated threads** in the three leaves (58 pending · 138 missing · 94 outgoing), which is exactly the snapshot's count of threads carrying `reason = escalation` (§5: 290). The cloud read of 293 / 499 is the live population without the spine's served-or-touched gate. So the "~1,000 dialogues a month" is the spine's 1,250, and the 258 was never a monthly count.

Incoming share of escalated threads in the three leaves: August 449 / 668 = **67%** (PRD said 74% on the 258; the live fortnight read said 68%).

## 11 · Cross-check against the outside (BigQuery-only) read of 7 Sep

The cloud session measured the live population (1,639 threads) without access to the run files. Side by side with the snapshot (1,547):

| measure | outside, live 1,639 | this report, snapshot 1,547 | verdict |
|---|---:|---:|---|
| live selector count | 1,639 (636/541/462) | 1,639 (636/541/462) | same |
| 4 Sep 12:00 UTC time-travel | 1,407, no 3 Sep | 1,407 + 128 (3 Sep) ≈ 1,547 | consistent; §1 adds that all days grew, tail ~10%, head ~2% |
| escalated, incoming pending | 65/636 = 10.2% | 62/600 = 10.3% | same |
| escalated, incoming missing | 147/541 = 27.2% | 140/519 = 27.0% | same |
| escalated, outgoing pending | 112/462 = **24.2%** | 114/428 = **26.6%** | 2.4 pp apart; different population, not resolved |
| human-touched per leaf | 17.5% / 43.6% / 38.5% | 18.0% / 43.7% / 40.9% | outgoing 2.4 pp apart, same direction |
| threads with reason = escalation | 293 (58 / 141 / 94) | 290 (55 / 138 / 97) | same within revision noise |
| "no problem" share by leaf | 43% pending, 11% missing | 259/600 = 43%, 55/519 = 11%, 99/428 = 23% outgoing | same |
| fn1 absolutes "~6% low, shares fine" | — | 1,547 vs 1,639 = 5.6% | agrees |
| 258 vs ~1,000 | unresolved | §10: spine gives 1,250 dialogues / 668 threads in August; 258 not reproducible; 30% = share of Business-account escalations | resolved as far as BigQuery allows |

The remainder map in the outside read (inaccurate 145 + wrong status 106; held 135 + fraud review 111; in transit 209; missing 161; wrong account 69; declined 66; lookup 53; blocked 63; no problem 413) matches label a exactly. What this report adds to it: the escalation column. Inaccurate + wrong status = 251 threads, **56 escalated (17.7% of the 316)**; held + fraud review = 246 threads, **105 escalated (33.2%)**; declined + blocked add 48 (15.2%); missing 44 (13.9%); wrong account 30 (9.5%); in transit + no problem + lookup 32 (10.1%).

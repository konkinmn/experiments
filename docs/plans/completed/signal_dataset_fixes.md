# Plan: Dispute Agent — Historical signal accuracy for eval dataset

## Overview

The BQ signals query currently fetches all time-sensitive signals relative to `CURRENT_TIMESTAMP()`. This is correct for production (pipeline runs at filing time), but wrong for historical eval — cases tested weeks or months after filing return signals that have drifted from what they were when the case was created.

This plan fixes the query so all time-windowed signals are calculated relative to `case_created_at`, making the eval dataset accurate for historical cases.

**Important:** These changes apply to `signals-query.ts` only. The production pipeline will inherit the same fix because it runs at filing time — `CURRENT_TIMESTAMP()` and `case_created_at` are effectively the same at that moment. No separate production path needed.

## Validation Commands
- `npx tsc --noEmit -p packages/backend`
- `npm run lint --workspace packages/backend`

---

### Task 1: Fix account_age_days

- [x] In `signals-query.ts`, update the `account_age_days` calculation in the `account_data` CTE:

```sql
-- before
DATE_DIFF(CURRENT_DATE(), DATE(ac.created_at), DAY) AS account_age_days

-- after
DATE_DIFF(DATE(cd.case_created_at), DATE(ac.created_at), DAY) AS account_age_days
```

- [x] Run validation commands
- [x] Mark completed

### Task 2: Fix transaction activity window

- [x] In `signals-query.ts`, update the `transaction_activity` CTE to use `case_created_at` as reference point:

```sql
-- before
AND post_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 90 DAY)

-- after
AND post_timestamp >= TIMESTAMP_SUB(cd.case_created_at, INTERVAL 90 DAY)
AND post_timestamp < cd.case_created_at
```

This fixes `tx_count_90_days`, `active_months`, and `prior_payments_to_merchant` — all three are in the same CTE.

- [x] Run validation commands
- [x] Mark completed

### Task 3: Fix dispute history windows

- [x] In `signals-query.ts`, update the `dispute_history` CTE for both windows:

```sql
-- 6 month window (before)
AND created_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 6 MONTH)

-- 6 month window (after)
AND created_at >= TIMESTAMP_SUB(cd.case_created_at, INTERVAL 6 MONTH)
AND created_at < cd.case_created_at

-- 30 day window (before)
AND created_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)

-- 30 day window (after)
AND created_at >= TIMESTAMP_SUB(cd.case_created_at, INTERVAL 30 DAY)
AND created_at < cd.case_created_at
```

- [x] Run validation commands
- [x] Mark completed

### Task 4: Fix scammer and scam victim upper bound

- [x] In `signals-query.ts`, add upper bound to `scam_check` CTE for both scammer and scam victim counts:

```sql
AND created_at < cd.case_created_at
```

No lower bound — flags from any point in history are still relevant. Only tasks created after the case was filed should be excluded.

- [x] Run validation commands
- [x] Mark completed

### Task 5: Fix tier — use historical log with COALESCE fallback

- [x] In `signals-query.ts`, replace the current `tier_data` CTE with the validated historical logic:

```sql
tier_data AS (
  SELECT COALESCE(
    -- tier at filing: prev_tier of first change AFTER case_created_at
    (SELECT prev_tier_name
     FROM `anna-money.verified_views.compliance_customer_tier_log`
     WHERE company_id = (SELECT company_id FROM case_data)
       AND event_timestamp > (SELECT case_created_at FROM case_data)
     ORDER BY event_timestamp ASC
     LIMIT 1),
    -- no change after filing: most recent tier is correct
    (SELECT tier_name
     FROM `anna-money.verified_views.compliance_customer_tier_log`
     WHERE company_id = (SELECT company_id FROM case_data)
     ORDER BY event_timestamp DESC
     LIMIT 1),
    -- no log at all: fall back to current tier from limits table
    (SELECT tier_name
     FROM `anna-money.verified_views.compliance_tier_limits`
     WHERE company_id = (SELECT company_id FROM case_data)
     LIMIT 1)
  ) AS tier_name
)
```

- [x] Run validation commands
- [x] Mark completed

### Task 6: Fix trust score — use historical changes table

- [x] In `signals-query.ts`, replace the current `trust_score_data` CTE:

```sql
-- before: fetches latest trust score regardless of when case was filed
trust_score_data AS (
  SELECT score AS trust_score
  FROM `anna-money.verified_views.checklist_trust_score`
  WHERE company_id = (SELECT company_id FROM case_data)
  LIMIT 1
)

-- after: fetches trust score as it was on the day of filing
trust_score_data AS (
  SELECT score_color AS trust_score
  FROM `anna-money.expiring_tables.compliance_trust_score_changes`
  WHERE company_id = (SELECT company_id FROM case_data)
    AND day <= DATE((SELECT case_created_at FROM case_data))
  ORDER BY day DESC
  LIMIT 1
)
```

No fallback needed — the table has records from account creation. A case filed before the first trust score row is a race condition too rare to handle.

- [x] Run validation commands
- [x] Mark completed

### Task 7: Integration test — verify signal accuracy for case 29452

- [x] Run pipeline against case 29452 (filed 2026-02-28) and verify:
  - `trust_score` returns BLUE (not AMBER — AMBER only appeared from 2026-03-03)
  - `account_age_days` returns ~432 days from 2026-02-28, not today's date
  - `tx_count_90_days` reflects transactions from 2025-11-30 to 2026-02-28 only
  - `tier` returns C (correct at filing date)
  - `railsr_disputes_last_6_months` counts only disputes before 2026-02-28
- [x] Run validation commands
- [x] Mark completed

### Task 8: Update spec to document eval dataset signal behaviour

- [x] In `docs/specs/phase1.md`, add a new section after the BQ signal table titled **"Eval dataset accuracy"**:

```markdown
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
```

- [x] Run validation commands
- [x] Mark completed

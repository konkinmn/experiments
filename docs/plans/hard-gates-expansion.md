# Plan: Hard Gates Expansion

**Status:** Pending
**Context:** Agreed with Sara-Jade on 2026-03-31 to add three new hard gates and check data sources for each.

---

## New Hard Gates

### 1. `account_balance < 0` → escalate_to_agent
- **Rationale:** Customers in negative balance are more likely to file false disputes (Sara-Jade).
- **Data source:** Needs new BQ signal. Check if `anna-money.export.account_customer` or `anna-money.trusted.business_account__balances` has a current balance field.
- **Implementation:**
  - Add `account_balance` to `CASE_SIGNALS_QUERY` in `signals-query.ts`
  - Add `account_balance` to `CaseSignalsRaw` interface
  - Add `negative_balance` to `HardGateSignals`, `HardGateConfig`
  - Add check in `checkHardGates()` and `deriveHardGates()`
  - Update `DEFAULT_HARD_GATE_CONFIG`
  - Update frontend `HardGateConfig` type if used in run config UI

### 2. `tx_type === CHIP_AND_PIN` → escalate_to_agent
- **Rationale:** Chip and PIN transactions cannot be simply credited — they need review.
- **Data source:** Check `anna-money.trusted.business_account__processed_transactions` for a `payment_method` or `tx_type` field. The transaction is already joined in `case_data` CTE — may just need to add the column.
- **Implementation:**
  - Add `tx_type` (or `payment_method`) to `CASE_SIGNALS_QUERY`
  - Add to `CaseSignalsRaw`
  - Add `chip_and_pin` to `HardGateSignals`, `HardGateConfig`
  - Add check in `checkHardGates()` and `deriveHardGates()`

### 3. `tx_type === CONTACTLESS` → escalate_to_agent
- **Rationale:** Contactless fraud over £25 requires crediting without dispute, under £25 is complex. Simplify by escalating all contactless for now.
- **Data source:** Same as chip_and_pin — depends on finding the tx_type/payment_method column.
- **Implementation:** Same pattern as chip_and_pin gate.

---

## Investigation Steps (before implementation)

1. **BQ schema check** — Run these queries to confirm available columns:
   ```sql
   -- Check for balance field
   SELECT column_name FROM `anna-money.export.INFORMATION_SCHEMA.COLUMNS`
   WHERE table_name = 'account_customer' AND column_name LIKE '%balance%';

   -- Check for tx type field
   SELECT column_name FROM `anna-money.trusted.INFORMATION_SCHEMA.COLUMNS`
   WHERE table_name = 'business_account__processed_transactions'
   AND column_name LIKE '%type%' OR column_name LIKE '%method%' OR column_name LIKE '%channel%';
   ```

2. **Sample data** — Once columns identified, check actual values to confirm the enum values (e.g., is it `CHIP_AND_PIN` or `chip_and_pin` or `CP`?)

3. **Edge cases:**
   - What if a case has mixed tx types (one contactless + one online)? → Use `MAX()` or `STRING_AGG()` to surface all types, gate if ANY is chip_and_pin/contactless
   - Account balance timing — use balance at case creation or current balance?

---

## Files to Modify
- `packages/backend/src/services/signals-query.ts` — add new columns to BQ query
- `packages/backend/src/types/dispute-pipeline.ts` — `CaseSignalsRaw`, `HardGateSignals`, `HardGateConfig`
- `packages/backend/src/services/dispute-pipeline.ts` — `deriveHardGates()`, `checkHardGates()`, `DEFAULT_HARD_GATE_CONFIG`, `buildDisputeProfile()`
- `packages/backend/src/routes/dataset.ts` — update `CreateRunSchema` Zod for new gate toggles
- `packages/backend/src/prompts/dispute-planner-v1.md` — mention new gates
- `packages/frontend/src/types/dataset-builder.ts` — if `HardGateConfig` is mirrored

## Dependencies
- BQ schema investigation must happen first
- Can implement gates independently (balance first since rationale is strongest, then tx_type gates together)

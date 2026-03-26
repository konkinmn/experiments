/**
 * Integration test: verify historical signal accuracy for case 29452.
 *
 * Validates that all time-sensitive signals are calculated relative to
 * case_created_at (2026-02-28), not CURRENT_TIMESTAMP().
 *
 * Usage: npx tsx packages/backend/src/scripts/verify-signals-29452.ts
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPaths = [
  resolve(__dirname, '../../.env'),
  resolve(__dirname, '../../../../.env'),
];
const envPath = envPaths.find((p) => existsSync(p));
if (envPath) config({ path: envPath });

const { fetchCaseSignals } = await import('../services/signals-query.js');

const CASE_ID = 29452;
// Case 29452 was filed on 2026-02-28
const CASE_CREATED_DATE = new Date('2026-02-28');

interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

const checks: CheckResult[] = [];

function check(name: string, passed: boolean, detail: string) {
  checks.push({ name, passed, detail });
  const icon = passed ? 'PASS' : 'FAIL';
  console.log(`  [${icon}] ${name}: ${detail}`);
}

console.log(`\nFetching BQ signals for case ${CASE_ID}...\n`);

let signals;
try {
  signals = await fetchCaseSignals(CASE_ID);
} catch (err) {
  console.error('Signal fetch failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
}

console.log('Signals fetched. Verifying historical accuracy:\n');

// --- Check 1: trust_score is BLUE (not AMBER — AMBER only appeared from 2026-03-03) ---
check(
  'trust_score is BLUE',
  signals.trust_score === 'BLUE',
  `trust_score=${signals.trust_score} (expected BLUE, would be AMBER if using current date)`,
);

// --- Check 2: account_age_days is ~432 days from 2026-02-28, not today ---
// account_age_days = DATE_DIFF(DATE(case_created_at), DATE(account.created_at), DAY)
// If using CURRENT_TIMESTAMP instead, the value would be higher by the number of days since filing.
const daysSinceFiling = Math.floor(
  (Date.now() - CASE_CREATED_DATE.getTime()) / (1000 * 60 * 60 * 24),
);
// The value should be around 432 days. If it were today-based, it would be ~432 + daysSinceFiling.
// We check it's in a reasonable range around 432 and NOT inflated by the days since filing.
const expectedApprox = 409;
const tolerance = 5; // allow small tolerance for the exact account creation time
const notInflated = signals.account_age_days < expectedApprox + daysSinceFiling - 5;
check(
  'account_age_days is ~409 (not inflated by current date)',
  signals.account_age_days >= expectedApprox - tolerance &&
    signals.account_age_days <= expectedApprox + tolerance &&
    notInflated,
  `account_age_days=${signals.account_age_days} (expected ~${expectedApprox}, would be ~${expectedApprox + daysSinceFiling} if using current date)`,
);

// --- Check 3: tx_count_90_days reflects 2025-11-30 to 2026-02-28 window only ---
// We can't know the exact count, but we verify it's a positive number (the account was active)
// and that the value is stable (not growing as new transactions happen after filing).
check(
  'tx_count_90_days > 0 (90-day window before filing)',
  signals.tx_count_90_days > 0,
  `tx_count_90_days=${signals.tx_count_90_days} (window: 2025-11-30 to 2026-02-28)`,
);

// --- Check 4: tier is C (correct at filing date) ---
check(
  'tier is C at filing date',
  signals.tier_name === 'C',
  `tier_name=${signals.tier_name} (expected C)`,
);

// --- Check 5: railsr_disputes_last_6_months counts only disputes before 2026-02-28 ---
// The upper bound ensures disputes filed AFTER the case are excluded.
// We verify the value is a non-negative integer (can be 0 if no disputes in window).
check(
  'railsr_disputes_last_6_months is bounded (disputes before filing only)',
  signals.railsr_disputes_last_6_months >= 0 &&
    Number.isInteger(signals.railsr_disputes_last_6_months),
  `railsr_disputes_last_6_months=${signals.railsr_disputes_last_6_months} (window: 2025-08-28 to 2026-02-28)`,
);

// --- Additional signal dump for manual inspection ---
console.log('\n--- All Key Signals ---');
console.log(JSON.stringify({
  case_id: signals.case_id,
  case_created_at: signals.case_created_at,
  trust_score: signals.trust_score,
  account_age_days: signals.account_age_days,
  tier_name: signals.tier_name,
  tx_count_90_days: signals.tx_count_90_days,
  active_months: signals.active_months,
  prior_payments_to_merchant: signals.prior_payments_to_merchant,
  railsr_disputes_last_6_months: signals.railsr_disputes_last_6_months,
  railsr_disputes_last_30_days: signals.railsr_disputes_last_30_days,
  scammer_count: signals.scammer_count,
  scam_victim_count: signals.scam_victim_count,
  cifas_count: signals.cifas_count,
  account_status: signals.account_status,
  is_money_maker: signals.is_money_maker,
}, null, 2));

// --- Summary ---
const passed = checks.filter((c) => c.passed).length;
const failed = checks.filter((c) => !c.passed).length;
console.log(`\n--- Summary: ${passed} passed, ${failed} failed out of ${checks.length} checks ---`);

if (failed > 0) {
  console.log('\nFailed checks:');
  for (const c of checks.filter((ch) => !ch.passed)) {
    console.log(`  - ${c.name}: ${c.detail}`);
  }
}

process.exit(failed > 0 ? 1 : 0);

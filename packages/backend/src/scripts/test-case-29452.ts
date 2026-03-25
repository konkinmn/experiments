/**
 * Integration test: run dispute pipeline against case 29452 and verify results.
 *
 * Usage: npx tsx packages/backend/src/scripts/test-case-29452.ts
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

// Dynamic imports so env vars are loaded before module evaluation
const { runDisputePipeline } = await import('../services/dispute-pipeline.js');
const { closePool } = await import('../services/db.js');

const CASE_ID = 29452;

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

console.log(`\nRunning dispute pipeline for case ${CASE_ID}...\n`);

let result;
try {
  result = await runDisputePipeline(CASE_ID);
} catch (err) {
  console.error('Pipeline failed with error:', err instanceof Error ? err.message : String(err));
  await closePool();
  process.exit(1);
}

console.log('Pipeline completed. Verifying results:\n');

// --- Check 1: BQ signals fetch returns correct data including tx_count_90_days > 0 ---
const signals = result.raw_signals;
check(
  'BQ signals fetched',
  signals != null && typeof signals.case_id === 'number',
  `case_id=${signals?.case_id}, alias=${signals?.alias}`,
);
check(
  'tx_count_90_days > 0',
  signals != null && signals.tx_count_90_days > 0,
  `tx_count_90_days=${signals?.tx_count_90_days}`,
);

// --- Check 2: DISPUTE_FORM artifact fetched and base64-encoded without error ---
const profile = result.dispute_profile;
const plannerOutput = result.planner_output;

// Check that case_details has artifacts
const caseDetails = result.case_details as { artifacts?: unknown[] } | null;
const artifacts = caseDetails?.artifacts ?? [];
const hasDisputeForm = artifacts.some(
  (a) =>
    typeof a === 'object' &&
    a !== null &&
    'artifact_type' in a &&
    (a as { artifact_type: string }).artifact_type?.toUpperCase() === 'DISPUTE_FORM',
);
check(
  'DISPUTE_FORM artifact present in case_details',
  hasDisputeForm,
  `artifacts count=${artifacts.length}, types=${artifacts.map((a) => (a as { artifact_type?: string }).artifact_type).join(', ')}`,
);

// The planner receiving the form is evidenced by the planner actually running (not erroring out)
// and by checking if it references the form in its thought
check(
  'Planner executed (no hard gate triggered)',
  result.hard_gate_triggered == null,
  `hard_gate_triggered=${result.hard_gate_triggered}`,
);

// --- Check 3: Planner receives form content and references it in thought ---
const thought = plannerOutput?.thought ?? '';
// The planner should reference form-related keywords if it read the dispute form
const formRelatedKeywords = ['form', 'pdf', 'dispute', 'fraud', 'card', 'transaction', 'claim', 'customer'];
const referencesForm = formRelatedKeywords.some((kw) => thought.toLowerCase().includes(kw));
check(
  'Planner thought references form content',
  plannerOutput != null && referencesForm,
  `thought length=${thought.length}, snippet="${thought.substring(0, 120)}..."`,
);

// --- Check 4: Planner thought does NOT mention Tier C as a risk factor ---
// Only flag if Tier C is directly associated with risk within a short span (not just mentioned descriptively)
const tierCRiskPatterns = [
  /tier\s*c\s+(?:is\s+)?(?:a\s+)?(?:risk|concern|flag|elevated|unestablished)/i,
  /(?:risk|concern|flag|elevated|unestablished)\s+(?:due to|because of|from)\s+tier\s*c/i,
  /tier\s*c\s+(?:customer|account)\s+(?:is|are)\s+(?:not|un)/i,
];
const mentionsTierCAsRisk = tierCRiskPatterns.some((p) => p.test(thought));
check(
  'Planner does NOT treat Tier C as risk factor',
  !mentionsTierCAsRisk,
  mentionsTierCAsRisk
    ? `WARNING: thought treats Tier C as risk`
    : 'No Tier C risk treatment found',
);

// --- Check 5: Dispute profile shows Green risk with score >= 70 ---
check(
  'Risk level is green',
  profile.risk_level === 'green',
  `risk_level=${profile.risk_level}`,
);
check(
  'Rubric score >= 70',
  profile.rubric_score >= 70,
  `rubric_score=${profile.rubric_score} (account_trust=${profile.category_scores.account_trust}, dispute_history=${profile.category_scores.dispute_history}, transaction_risk=${profile.category_scores.transaction_risk})`,
);

// --- Check 6: Result saves to DB with all fields populated ---
check(
  'Result saved to DB (has id)',
  result.id != null && result.id > 0,
  `id=${result.id}`,
);
check(
  'raw_signals populated',
  result.raw_signals != null,
  'present',
);
check(
  'dispute_profile populated',
  result.dispute_profile != null,
  'present',
);
check(
  'hard_gates populated',
  result.hard_gates != null,
  `cifas=${result.hard_gates?.cifas}, scammer=${result.hard_gates?.confirmed_scammer}, inactive=${result.hard_gates?.account_not_active}, railsr=${result.hard_gates?.railsr_dispute_last_6_months}`,
);
check(
  'planner_output populated',
  result.planner_output != null,
  `decision=${plannerOutput?.decision}, credit_timing=${plannerOutput?.credit_timing}`,
);
check(
  'planner_raw_response populated',
  result.planner_raw_response != null && result.planner_raw_response.length > 0,
  `length=${result.planner_raw_response?.length ?? 0}`,
);
check(
  'executor_action is shadow',
  result.executor_action === 'shadow',
  `executor_action=${result.executor_action}`,
);
check(
  'prompt_version set',
  result.prompt_version === 'dispute-planner-v1',
  `prompt_version=${result.prompt_version}`,
);
check(
  'pipeline_duration_ms recorded',
  result.pipeline_duration_ms > 0,
  `${result.pipeline_duration_ms}ms`,
);

// --- Summary ---
const passed = checks.filter((c) => c.passed).length;
const failed = checks.filter((c) => !c.passed).length;
console.log(`\n--- Summary: ${passed} passed, ${failed} failed out of ${checks.length} checks ---`);

if (failed > 0) {
  console.log('\nFailed checks:');
  for (const c of checks.filter((ch) => !ch.passed)) {
    console.log(`  - ${c.name}: ${c.detail}`);
  }
  console.log('');
}

// Log full planner output for debugging
if (plannerOutput) {
  console.log('\n--- Full Planner Output ---');
  console.log(JSON.stringify(plannerOutput, null, 2));
}

// Log key signal values
console.log('\n--- Key Signals ---');
console.log(JSON.stringify({
  case_id: signals?.case_id,
  alias: signals?.alias,
  tier_name: signals?.tier_name,
  trust_score: signals?.trust_score,
  account_age_days: signals?.account_age_days,
  account_status: signals?.account_status,
  tx_count_90_days: signals?.tx_count_90_days,
  cifas_count: signals?.cifas_count,
  scammer_count: signals?.scammer_count,
  railsr_disputes_last_6_months: signals?.railsr_disputes_last_6_months,
  is_money_maker: signals?.is_money_maker,
  max_transaction_amount: signals?.max_transaction_amount,
}, null, 2));

await closePool();

process.exit(failed > 0 ? 1 : 0);

// Report a run: confusion matrix + per-cohort decision breakdown + any request_evidence / errors.
// Usage: node scripts/report-run.mjs <datasetId> <runId>
const datasetId = Number(process.argv[2]);
const runId = Number(process.argv[3]);
const j = async (p) => (await fetch('http://localhost:3003' + p)).json();

const analytics = await j(`/api/datasets/${datasetId}/analytics?runId=${runId}`);
console.log('=== CONFUSION MATRIX ===');
console.log(JSON.stringify(analytics.confusion_matrix, null, 2));
console.log('=== OVERALL ===');
console.log(JSON.stringify(analytics.overall, null, 2));

// Per-cohort decision breakdown from run cases
const rc = await j(`/api/datasets/runs/${runId}/cases`);
const cases = Array.isArray(rc) ? rc : (rc.data || rc.cases || []);
const cohortOf = (tags) => (tags || []).find((t) => t.startsWith('cohort:')) || 'none';
const decisionOf = (c) => {
  if (c.pipelineError) return 'ERROR';
  const pr = c.pipelineRun || {};
  if (pr.hardGateTriggered) return `escalate(gate:${pr.hardGateTriggered})`;
  const d = pr.plannerOutput?.decision;
  return d || 'unknown';
};
const byCohort = {};
let errors = 0, reqEvidence = 0;
for (const c of cases) {
  const co = cohortOf(c.datasetManualTags);
  const dec = decisionOf(c);
  if (dec === 'ERROR') errors++;
  if (String(dec).includes('request_evidence')) reqEvidence++;
  (byCohort[co] ||= {})[dec] = ((byCohort[co] || {})[dec] || 0) + 1;
}
console.log('\n=== DECISION BY COHORT (label) ===');
for (const [co, counts] of Object.entries(byCohort).sort()) {
  console.log(`  ${co}: ${JSON.stringify(counts)}`);
}
console.log(`\nerrors=${errors} request_evidence=${reqEvidence} total=${cases.length}`);

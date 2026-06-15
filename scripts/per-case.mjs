const runId = Number(process.argv[2] ?? 34);
const rc = await (await fetch(`http://localhost:3003/api/datasets/runs/${runId}/cases`)).json();
const cases = Array.isArray(rc) ? rc : (rc.data || rc.cases || []);
const cohortOf = (tags) => ((tags || []).find((t) => t.startsWith('cohort:')) || 'cohort:?').replace('cohort:', '');
const dec = (c) => {
  if (c.pipelineError) return 'ERROR';
  const pr = c.pipelineRun || {};
  if (pr.hardGateTriggered) return `GATE:${pr.hardGateTriggered}`;
  return pr.plannerOutput?.decision || '?';
};
const order = { A: 0, 'AI-credit': 1, B: 2, C: 3, D: 4 };
const rows = cases.map((c) => ({
  cohort: cohortOf(c.datasetManualTags),
  caseId: c.caseId,
  label: c.label || c.datasetLabel,
  decision: dec(c),
  risk: c.pipelineRun?.disputeProfile?.risk_level ?? c.pipelineRun?.disputeProfile?.riskLevel ?? '?',
  score: c.pipelineRun?.disputeProfile?.score ?? '?',
}));
rows.sort((a, b) => (order[a.cohort] - order[b.cohort]) || (a.caseId - b.caseId));
console.log('cohort      case    label     -> decision                 risk/score');
for (const r of rows) {
  console.log(
    `${r.cohort.padEnd(10)} ${String(r.caseId).padEnd(7)} ${String(r.label).padEnd(9)} -> ${String(r.decision).padEnd(24)} ${r.risk}/${r.score}`,
  );
}

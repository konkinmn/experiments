// One-off: load the backtest answer key (labels + cohort tags) onto dataset 15.
// Label = what the AI *should* have decided (per the 2026-06-15 assessment brief).
// Run: node scripts/load-backtest-labels.mjs [datasetId]
const BASE = 'http://localhost:3003';
const DATASET_ID = Number(process.argv[2] ?? 15);

const COHORTS = [
  { cohort: 'A', label: 'credit', tags: ['cohort:A', 'recover-target'],
    note: 'A: clear/evidenced claim, escalated only on a bad score signal',
    ids: [35657, 35683, 35608, 34511, 33702, 33825, 36867, 36912, 34732, 33822, 34075, 34425, 35882] },
  { cohort: 'AI-credit', label: 'credit', tags: ['cohort:AI-credit', 'vindicated'],
    note: 'AI-credit: AI already credited; human refunded',
    ids: [37075, 35424] },
  { cohort: 'B', label: 'escalate', tags: ['cohort:B', 'needs-plumbing'],
    note: 'B: claim never reached the planner; scoring alone will not fix',
    ids: [34086, 34072, 34081] },
  { cohort: 'C', label: 'escalate', tags: ['cohort:C', 'genuine-human'],
    note: 'C: real contradiction/vulnerability/contested merchant; refunded but correctly escalated',
    ids: [34087, 36377, 34073, 33967, 34074, 37224] },
  { cohort: 'D', label: 'escalate', tags: ['cohort:D', 'must-hold'],
    note: 'D: human found no grounds; crediting would be wrong',
    ids: [36296, 34905, 37855, 36373, 39399, 32956, 37971, 36728, 34895, 35503, 35668, 38067, 38244, 34930, 37153, 38007, 38465, 38035, 34113] },
];
// Extra tag: railsr-6mo proxy undercounts 35882's 3 lifetime disputes.
const EXTRA_TAGS = { 35882: ['prior-disputes-approx'] };

async function j(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}

const ds = await j('GET', `/api/datasets/${DATASET_ID}`);
const rowByCase = new Map(ds.cases.map((c) => [c.caseId, c.id]));

let n = 0, missing = [];
for (const co of COHORTS) {
  for (const caseId of co.ids) {
    const rowId = rowByCase.get(caseId);
    if (rowId == null) { missing.push(caseId); continue; }
    await j('PATCH', `/api/datasets/cases/${rowId}/label`, {
      label: co.label, labeledBy: 'backtest-answer-key', confidence: 'high', notes: co.note,
    });
    const tags = [...co.tags, ...(EXTRA_TAGS[caseId] ?? [])];
    await j('PATCH', `/api/datasets/cases/${rowId}/tags`, { tags });
    n++;
    process.stdout.write(`  ${caseId} -> ${co.label} [${tags.join(', ')}]\n`);
  }
}
console.log(`\nLabelled ${n} cases.${missing.length ? ' MISSING: ' + missing.join(',') : ''}`);

// Verify
const after = await j('GET', `/api/datasets/${DATASET_ID}`);
const credit = after.cases.filter((c) => c.label === 'credit').length;
const escalate = after.cases.filter((c) => c.label === 'escalate').length;
const unlabeled = after.cases.filter((c) => !c.label).length;
const tagged = after.cases.filter((c) => (c.manualTags || []).length > 0).length;
console.log(`Verify: credit=${credit} escalate=${escalate} unlabeled=${unlabeled} tagged=${tagged} total=${after.cases.length}`);

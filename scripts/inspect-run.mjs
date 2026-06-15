const runId = Number(process.argv[2]);
const r = await fetch(`http://localhost:3003/api/datasets/runs/${runId}/cases`);
const o = await r.json();
const arr = Array.isArray(o) ? o : (o.data || o.cases || []);
console.log('cases:', arr.length);
console.log('sample keys:', Object.keys(arr[0] || {}).join(','));
const errs = {};
let withErr = 0, withRun = 0;
for (const c of arr) {
  const e = c.pipelineError || c.pipeline_error;
  if (e) { withErr++; const k = e.slice(0, 200); errs[k] = (errs[k] || 0) + 1; }
  if (c.pipelineRunId || c.pipeline_run_id) withRun++;
}
console.log('withError:', withErr, ' withPipelineRunId:', withRun);
for (const [k, v] of Object.entries(errs)) console.log(`  [${v}x] ${k}`);

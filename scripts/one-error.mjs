const r = await fetch('http://localhost:3003/api/datasets/runs/33/cases');
const o = await r.json();
const arr = Array.isArray(o) ? o : (o.data || o.cases || []);
const c = arr.find((x) => x.pipelineError) || arr[0];
console.log('caseId:', c.caseId);
console.log('=== FULL pipelineError ===');
console.log(c.pipelineError);

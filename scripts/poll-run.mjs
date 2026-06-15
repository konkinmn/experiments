const datasetId = Number(process.argv[2]);
const runId = Number(process.argv[3]);
for (let i = 1; i <= 120; i++) {
  const r = await fetch(`http://localhost:3003/api/datasets/${datasetId}/runs`);
  const o = await r.json();
  const arr = Array.isArray(o) ? o : (o.data || o.runs || []);
  const run = arr.find((x) => x.id === runId);
  const line = run ? `${run.status} ${run.completed_cases}/${run.total_cases}` : 'not found';
  console.log(`[${i * 10}s] ${line}`);
  if (run && (run.status === 'completed' || run.status === 'failed')) break;
  await new Promise((res) => setTimeout(res, 10000));
}

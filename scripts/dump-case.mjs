const rc = await (await fetch('http://localhost:3003/api/datasets/runs/34/cases')).json();
const cases = Array.isArray(rc) ? rc : (rc.data || rc.cases || []);
const c = cases[0];
console.log('top-level keys:', Object.keys(c).join(','));
console.log('\npipelineRun type:', typeof c.pipelineRun, 'keys:', c.pipelineRun ? Object.keys(c.pipelineRun).join(',') : 'null');
console.log('\nfull pipelineRun:');
console.log(JSON.stringify(c.pipelineRun, null, 2).slice(0, 2500));

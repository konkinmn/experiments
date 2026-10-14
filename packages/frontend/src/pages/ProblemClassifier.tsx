import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AdvancedPanel,
  StatusChip,
  CategoryList,
  UNASSIGNED,
  PassStrip,
  PlanDialog,
  JobPanel,
  ThreadsTable,
  ThreadFilters,
  EMPTY_THREAD_FILTERS,
  RunDetails,
  ThreadDrawer,
  type ThreadFiltersState,
} from '@/components/problem-classifier';
import {
  errorMessage,
  formatInt,
  nextLabel,
  oneLine,
  progressLabel,
} from '@/components/problem-classifier/format';
import {
  usePcDefaults,
  usePcSnapshots,
  usePcSnapshot,
  usePcRuns,
  usePcJobs,
  usePcJob,
  usePcRunThreads,
  usePcThreadDetail,
  usePcReport,
  usePcComparePass3,
  useCreatePcSnapshot,
  useBuildPcBundles,
  useCreatePcRun,
  usePcPlan,
  useStartPcPass,
  useCancelPcJob,
  latestJobForSnapshot,
} from '@/hooks/useProblemClassifier';
import type {
  CreateSnapshotRequest,
  Job,
  Pass3Mode,
  PassKind,
  PassRequest,
  RunSummary,
  SnapshotSummary,
  ThreadRow,
} from '@/types';

/** How far along a snapshot's best run is — used only to pick a default. */
function snapshotScore(s: SnapshotSummary): number {
  const lr = s.latestRun;
  if (lr) {
    return (
      (lr.pass3Labels.length > 0 ? 4 : 0) + (lr.pass2Done > 0 ? 2 : 0) + (lr.pass1Done > 0 ? 1 : 0)
    );
  }
  return s.runs.length > 0 ? 1 : 0;
}

function runScore(r: RunSummary): number {
  return (
    (r.passes.pass3.labels.length > 0 ? 4 : 0) +
    (r.passes.pass2.done > 0 ? 2 : 0) +
    (r.passes.pass1.done > 0 ? 1 : 0)
  );
}

function best<T>(items: T[], score: (item: T) => number, createdAt: (item: T) => string): T | null {
  if (items.length === 0) return null;
  return items.reduce((winner, item) => {
    const diff = score(item) - score(winner);
    if (diff > 0) return item;
    if (diff < 0) return winner;
    return new Date(createdAt(item)).getTime() > new Date(createdAt(winner)).getTime()
      ? item
      : winner;
  });
}

const JOB_PASS_LABELS: Record<string, string> = {
  bundles: 'bundles',
  measure: 'measure',
  pass1: 'pass 1',
  pass2: 'pass 2',
  pass3: 'pass 3',
  all: 'pipeline',
};

/** The last segment of the header chip: what state this run is in. */
function stateSegment(run: RunSummary | null, job: Job | null, pass3Complete: boolean): string {
  if (job?.status === 'running') {
    const { done, total } = job.progress;
    return `${JOB_PASS_LABELS[job.kind] ?? job.kind} ${formatInt(done)} of ${formatInt(total)} running`;
  }
  if (!run) return 'no run';
  const { pass1, pass2, pass3 } = run.passes;
  if (pass1.done < pass1.total) return `pass 1 ${progressLabel(pass1.done, pass1.total)}`;
  if (pass2.done < pass2.total) return `pass 2 ${progressLabel(pass2.done, pass2.total)}`;
  if (pass3.labels.length === 0) return 'pass 3 not started';
  return pass3Complete ? 'complete' : 'pass 3 incomplete';
}

/** `19 Aug 2026`, or `19 Aug to 21 Aug 2026` when the snapshot spans days. */
function windowWords(from: string | null, to: string | null): string | null {
  const day = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  };
  if (!from) return null;
  if (!to || to === from) return day(from);
  return `${day(from)} to ${day(to)}`;
}

/**
 * What the snapshot is, in a word: the name with its date suffix stripped, so
 * `pilot-2026-08-19` reads as `Pilot`. Falls back to the whole name.
 */
function snapshotWords(name: string): string {
  const stem = name.replace(/[-_]?\d{4}-\d{2}-\d{2}$/, '').replace(/[-_]+/g, ' ').trim();
  const words = stem || name;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function ProblemClassifier() {
  // The chosen Gemma scenario is the page's scope, so it lives in the URL and
  // survives a reload; everything else on the page is session state.
  const [searchParams, setSearchParams] = useSearchParams();
  const scenarioParam = searchParams.get('scenario');

  const [snapshotName, setSnapshotName] = useState<string | null>(null);
  const [runName, setRunName] = useState<string | null>(null);
  /** Which induction the page is reading. */
  const [readLabel, setReadLabel] = useState('a');
  /** Which induction a new run would write. */
  const [newLabel, setNewLabel] = useState('a');
  const [initialised, setInitialised] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [measureN, setMeasureN] = useState('');
  const [pass1N, setPass1N] = useState('');
  const [pass1Force, setPass1Force] = useState(false);
  const [pass3Mode, setPass3Mode] = useState<Pass3Mode>('two-step');

  const [planOpen, setPlanOpen] = useState(false);
  const [planPass, setPlanPass] = useState<PassKind | null>(null);
  const [planRequest, setPlanRequest] = useState<PassRequest | null>(null);
  const [startedJobId, setStartedJobId] = useState<string | null>(null);

  const [filters, setFilters] = useState<ThreadFiltersState>(EMPTY_THREAD_FILTERS);
  const [activeRow, setActiveRow] = useState<ThreadRow | null>(null);
  const [compareA, setCompareA] = useState('');
  const [compareB, setCompareB] = useState('');

  const defaultsQuery = usePcDefaults();
  const snapshotsQuery = usePcSnapshots();
  const snapshotQuery = usePcSnapshot(snapshotName);
  const runsQuery = usePcRuns(snapshotName);
  const jobsQuery = usePcJobs();

  const snapshots = snapshotsQuery.data ?? [];
  const snapshot = snapshotQuery.data ?? null;
  const runs = runsQuery.data ?? [];

  // The backend says what to open on. Without that endpoint the page picks the
  // furthest-along run itself, so it never lands on a failed one.
  useEffect(() => {
    if (initialised) return;
    if (defaultsQuery.isLoading || snapshotsQuery.isLoading) return;
    const d = defaultsQuery.data;
    if (d?.snapshot) {
      setSnapshotName(d.snapshot);
      if (d.run) setRunName(d.run);
      if (d.label) setReadLabel(d.label);
    } else {
      const pick = best(snapshots, snapshotScore, (s) => s.createdAt);
      if (pick) setSnapshotName(pick.name);
    }
    setInitialised(true);
  }, [initialised, defaultsQuery.isLoading, defaultsQuery.data, snapshotsQuery.isLoading, snapshots]);

  useEffect(() => {
    if (runs.length === 0) return;
    if (runName && runs.some((r) => r.run === runName)) return;
    const pick = best(runs, runScore, (r) => r.createdAt);
    if (pick) setRunName(pick.run);
  }, [runs, runName]);

  const run = useMemo(() => runs.find((r) => r.run === runName) ?? null, [runs, runName]);
  const labels = run?.passes.pass3.labels ?? [];

  useEffect(() => {
    if (labels.length === 0) return;
    if (!labels.includes(readLabel)) setReadLabel(labels[labels.length - 1]);
  }, [labels, readLabel]);

  useEffect(() => {
    setNewLabel(nextLabel(labels));
  }, [labels]);

  const latestJob = latestJobForSnapshot(jobsQuery.data, snapshotName);
  const jobId = startedJobId ?? latestJob?.id ?? null;
  const jobQuery = usePcJob(jobId);
  const job = jobQuery.data ?? null;
  const jobRunning = job?.status === 'running';
  // A job for a different run says nothing about the run being read, and a job
  // that finished before this session is history, not state.
  const chipJob = job && (job.run === runName || job.kind === 'bundles') ? job : null;
  const showJobPanel = job != null && (jobRunning || startedJobId === job.id);

  const measureJob = useMemo(() => {
    const mine = (jobsQuery.data ?? []).filter(
      (j) => j.snapshot === snapshotName && j.kind === 'measure' && (!runName || j.run === runName),
    );
    if (mine.length === 0) return null;
    return mine.reduce((latest, j) =>
      new Date(j.startedAt).getTime() > new Date(latest.startedAt).getTime() ? j : latest,
    );
  }, [jobsQuery.data, snapshotName, runName]);

  const createSnapshot = useCreatePcSnapshot();
  const buildBundles = useBuildPcBundles();
  const createRun = useCreatePcRun();
  const planMutation = usePcPlan();
  const startMutation = useStartPcPass();
  const cancelJob = useCancelPcJob();

  const threadsQuery = usePcRunThreads(snapshotName, runName, readLabel.trim() || undefined);
  const threadsData = threadsQuery.data ?? null;

  // The report is the only source of counts and of the category definitions,
  // so it is always fetched — the cards are the first thing on the page.
  const reportQuery = usePcReport(snapshotName, runName, readLabel.trim() || undefined);
  const report = reportQuery.data ?? null;

  const compareQuery = usePcComparePass3(snapshotName, runName, compareA || null, compareB || null);

  const detailQuery = usePcThreadDetail(
    snapshotName,
    runName,
    activeRow?.threadId ?? null,
    readLabel.trim() || undefined,
  );

  const handleSelectSnapshot = (name: string) => {
    setSnapshotName(name);
    setRunName(null);
    setStartedJobId(null);
    setActiveRow(null);
    setFilters(EMPTY_THREAD_FILTERS);
  };

  const handleCreateSnapshot = (body: CreateSnapshotRequest) => {
    createSnapshot.mutate(body, { onSuccess: (res) => handleSelectSnapshot(res.data.name) });
  };

  const handleBuildBundles = () => {
    if (!snapshotName) return;
    buildBundles.mutate(
      { name: snapshotName, force: snapshot?.bundlesBuilt ? true : undefined },
      { onSuccess: (res) => setStartedJobId(res.data.jobId) },
    );
  };

  const handleCreateRun = (name: string) => {
    if (!snapshotName) return;
    createRun.mutate({ name: snapshotName, run: name }, { onSuccess: (res) => setRunName(res.data.run) });
  };

  // Plan is the confirmation step — it costs nothing and shows what a run would spend.
  const handlePlan = (request: PassRequest) => {
    if (!snapshotName || !runName) return;
    startMutation.reset();
    setPlanPass(request.pass);
    setPlanRequest(request);
    setPlanOpen(true);
    planMutation.mutate({ name: snapshotName, run: runName, request });
  };

  const handleRunPipeline = () =>
    handlePlan({ pass: 'all', mode: pass3Mode, label: newLabel.trim() || 'a' });

  // The only place the page spends money, and only from inside the plan dialog.
  const handleRun = () => {
    if (!snapshotName || !runName || !planRequest) return;
    startMutation.mutate(
      { name: snapshotName, run: runName, request: planRequest },
      {
        onSuccess: (res) => {
          setStartedJobId(res.data.jobId);
          setPlanOpen(false);
        },
      },
    );
  };

  // Problem names come from the report, so they exist only once pass 3 is complete.
  const categoryOptions = useMemo(() => {
    const pass3 = report?.pass3;
    if (!pass3 || !pass3.complete) return [];
    const names = pass3.categories.map((c) => c.name);
    return pass3.unassigned.length > 0 ? [...names, UNASSIGNED] : names;
  }, [report]);

  // The Gemma scenario leaves, in the snapshot's own order — the switcher's buttons.
  const scenarios = useMemo(() => report?.pass3?.scenarioTotals ?? [], [report]);

  /* The scope, as the report can confirm it. A path key in the URL that this run has no
   * leaf for reads as the whole run rather than as an empty page. */
  const scenarioKey = useMemo(
    () => (scenarios.some((s) => s.pathKey === scenarioParam) ? scenarioParam : null),
    [scenarios, scenarioParam],
  );

  /* Picking a scenario re-scopes the whole page, so the problem filter goes with it: a
   * problem picked in the last scenario may not exist in this one. */
  const handleSelectScenario = (pathKey: string | null) => {
    setSearchParams(
      (params) => {
        if (pathKey) params.set('scenario', pathKey);
        else params.delete('scenario');
        return params;
      },
      { replace: true },
    );
    setFilters({ ...filters, category: '' });
  };

  // Filtering, never re-sorting: rows stay in the order the API returned them.
  const visibleRows = useMemo(() => {
    let rows = threadsData?.rows ?? [];
    // The page's scope first, then the filters inside it.
    if (scenarioKey) rows = rows.filter((r) => r.pathKey === scenarioKey);
    if (filters.category === UNASSIGNED) rows = rows.filter((r) => !r.pass3Category);
    else if (filters.category) rows = rows.filter((r) => r.pass3Category === filters.category);
    if (filters.pass1State) rows = rows.filter((r) => r.pass1?.state === filters.pass1State);
    const q = filters.search.trim().toLowerCase();
    if (q) {
      rows = rows.filter(
        (r) =>
          r.threadId.toLowerCase().includes(q) ||
          r.customerAlias.toLowerCase().includes(q) ||
          oneLine(r.whatHappened).toLowerCase().includes(q),
      );
    }
    return rows;
  }, [threadsData, filters, scenarioKey]);

  const totalThreads = run?.passes.pass1.total ?? null;
  // One sentence naming the run being read. Dates when the snapshot carries
  // them, the snapshot name when it does not.
  const windowPart = windowWords(snapshot?.dateFrom ?? null, snapshot?.dateTo ?? null);
  const chipParts = [
    snapshotName ? snapshotWords(snapshotName) : 'No snapshot',
    ...(windowPart ? [windowPart] : snapshotName ? [snapshotName] : []),
    ...(totalThreads != null ? [`${formatInt(totalThreads)} threads`] : []),
    ...(runName ? [] : ['no run']),
    stateSegment(run, chipJob, Boolean(report?.pass3?.complete)),
  ];

  const passDisabledReason = !snapshotName
    ? 'Select or create a snapshot first.'
    : !runName
      ? 'Create a run before planning a pass.'
      : null;

  const filtered =
    scenarioKey != null ||
    filters.category !== '' ||
    filters.pass1State !== '' ||
    filters.search !== '';

  return (
    <div className="pc-page flex-1 overflow-auto bg-white px-8 py-7">
      <div className="mx-auto max-w-[1240px] space-y-7">
        <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-2">
          <div className="min-w-0 flex-1">
            <h1 className="text-[28px] font-semibold leading-tight tracking-tight">
              Payment problem classifier
            </h1>
            <p className="pc-dim mt-1 text-[15px]">
              What customers came to us about, read thread by thread, grouped into the problems that
              caused them.
            </p>
          </div>
          <StatusChip
            parts={chipParts}
            running={chipJob?.status === 'running'}
            progressPct={
              chipJob?.status === 'running' && chipJob.progress.total > 0
                ? Math.round((chipJob.progress.done / chipJob.progress.total) * 100)
                : null
            }
            open={advancedOpen}
            onToggle={() => setAdvancedOpen(!advancedOpen)}
          />
        </div>

        {advancedOpen && (
          <AdvancedPanel
            snapshots={snapshots}
            snapshotName={snapshotName}
            onSelectSnapshot={handleSelectSnapshot}
            snapshot={snapshot}
            onCreateSnapshot={handleCreateSnapshot}
            creatingSnapshot={createSnapshot.isPending}
            onBuildBundles={handleBuildBundles}
            building={buildBundles.isPending}
            runs={runs}
            runName={runName}
            onSelectRun={setRunName}
            onCreateRun={handleCreateRun}
            creatingRun={createRun.isPending}
            run={run}
            labels={labels}
            readLabel={readLabel}
            onReadLabel={setReadLabel}
            newLabel={newLabel}
            onNewLabel={setNewLabel}
            onRunPipeline={handleRunPipeline}
            runPipelinePlanning={planMutation.isPending && planPass === 'all'}
            error={
              errorMessage(createSnapshot.error) ??
              errorMessage(createRun.error) ??
              errorMessage(buildBundles.error) ??
              errorMessage(snapshotsQuery.error) ??
              errorMessage(runsQuery.error) ??
              (planOpen ? null : errorMessage(planMutation.error))
            }
            passStrip={
              <PassStrip
                run={run}
                measureJob={measureJob}
                onPlan={handlePlan}
                planningPass={planMutation.isPending ? planPass : null}
                disabled={!snapshotName || !runName}
                disabledReason={passDisabledReason}
                planError={null}
                measureN={measureN}
                onMeasureN={setMeasureN}
                pass1N={pass1N}
                onPass1N={setPass1N}
                pass1Force={pass1Force}
                onPass1Force={setPass1Force}
                pass3Mode={pass3Mode}
                onPass3Mode={setPass3Mode}
                label={newLabel}
                onLabel={setNewLabel}
              />
            }
            job={
              showJobPanel && job ? (
                <JobPanel
                  job={job}
                  onCancel={() => cancelJob.mutate(job.id)}
                  cancelling={cancelJob.isPending}
                  cancelError={errorMessage(cancelJob.error)}
                />
              ) : null
            }
            runDetails={
              <RunDetails
                report={report}
                loading={reportQuery.isLoading}
                error={errorMessage(reportQuery.error)}
                labels={labels}
                compareA={compareA}
                compareB={compareB}
                onCompareA={setCompareA}
                onCompareB={setCompareB}
                compare={compareQuery.data}
                compareLoading={compareQuery.isLoading}
                compareError={errorMessage(compareQuery.error)}
              />
            }
          />
        )}

        {!snapshotName && initialised ? (
          <p className="pc-dim text-[15px]">
            Nothing to read yet — open{' '}
            <button
              type="button"
              className="pc-focus text-primary underline-offset-2 hover:underline"
              onClick={() => setAdvancedOpen(true)}
            >
              Advanced
            </button>{' '}
            to create a snapshot and run the pipeline.
          </p>
        ) : (
          <>
            <CategoryList
              report={report}
              loading={reportQuery.isLoading}
              error={errorMessage(reportQuery.error)}
              passes={run?.passes ?? null}
              selected={filters.category || null}
              onSelect={(value) => setFilters({ ...filters, category: value ?? '' })}
              scenarioKey={scenarioKey}
              onSelectScenario={handleSelectScenario}
              hasRun={Boolean(runName)}
            />

            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <ThreadFilters
                  filters={filters}
                  onChange={setFilters}
                  categories={categoryOptions}
                />
                {threadsData?.complete.pass1 && filtered && (
                  <span className="pc-dim pc-tnum text-[13px]">
                    {formatInt(visibleRows.length)} of {formatInt(threadsData.rows.length)} threads
                  </span>
                )}
              </div>
              {threadsQuery.error && (
                <div className="space-y-1">
                  <p className="text-[15px]">The threads did not load. Reload the page.</p>
                  <p className="pc-dim text-[13px]">{errorMessage(threadsQuery.error)}</p>
                </div>
              )}
              <ThreadsTable
                rows={visibleRows}
                loading={threadsQuery.isLoading}
                showScenario={scenarioKey == null}
                onRowClick={setActiveRow}
              />
            </div>
          </>
        )}

        <div>
          <button
            type="button"
            className="pc-focus pc-dim text-[13px] underline-offset-2 hover:text-[var(--pc-ink)] hover:underline"
            onClick={() => setAdvancedOpen(!advancedOpen)}
          >
            {advancedOpen ? 'Hide advanced' : 'Advanced'}
          </button>
        </div>
      </div>

      <PlanDialog
        open={planOpen}
        pass={planPass}
        plan={planMutation.data?.data ?? null}
        loading={planMutation.isPending}
        error={errorMessage(planMutation.error)}
        onClose={() => setPlanOpen(false)}
        onRun={handleRun}
        starting={startMutation.isPending}
        startError={errorMessage(startMutation.error)}
        jobRunning={jobRunning}
      />

      <ThreadDrawer
        threadId={activeRow?.threadId ?? null}
        row={activeRow}
        detail={detailQuery.data}
        loading={detailQuery.isLoading}
        error={errorMessage(detailQuery.error)}
        onClose={() => setActiveRow(null)}
      />
    </div>
  );
}

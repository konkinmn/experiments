import { useEffect, useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { downloadXlsxWorkbook, makeSheet, type ColumnDef } from '@/lib/download-xlsx';
import { QueueRunBar, QueueTaskTable, QueueFilters, QueueGroups } from '@/components/queue-analyser';
import {
  useQueueGroups,
  useQueueRuns,
  useQueueRun,
  useQueueRunTasks,
  useRunQueueAnalysis,
  useDeleteQueueRun,
} from '@/hooks/useQueueAnalyser';
import type { QueueTask, QueueTaskFilters, WorkGroup } from '@/types';

const PAS_GROUP_ID = '5d68f04595296d55702eeea6';

// Action-first column order: the team reads what to do and why before the raw facts.
const TASK_COLUMNS: ColumnDef<QueueTask>[] = [
  { header: 'Task ID', accessor: (t) => t.taskId },
  { header: 'WS Link', accessor: (t) => t.wsLink },
  { header: 'Title', accessor: (t) => t.title },
  { header: 'Group (kind)', accessor: (t) => t.groupName },
  { header: 'Next step', accessor: (t) => t.suggestedAction },
  { header: 'Reasoning', accessor: (t) => t.rationale },
  { header: 'Urgency', accessor: (t) => t.urgency },
  { header: 'Status', accessor: (t) => t.status },
  { header: 'Quick win', accessor: (t) => (t.quickWin ? 'yes' : '') },
  { header: 'Age (days)', accessor: (t) => t.ageDays },
  { header: 'SLA days', accessor: (t) => t.slaDays },
  { header: 'SLA status', accessor: (t) => t.slaStatus },
  { header: 'Wrong queue', accessor: (t) => (t.wrongQueue ? 'yes' : '') },
  { header: 'Suggested queue', accessor: (t) => t.suggestedQueue },
  { header: 'Balance', accessor: (t) => t.balance },
  { header: 'Currency', accessor: (t) => t.currency },
  { header: 'Account status', accessor: (t) => t.accountStatuses },
  { header: 'Company status', accessor: (t) => t.companyStatus },
  { header: 'Ceased on', accessor: (t) => t.dateCeasedOn },
  { header: 'Days since cessation', accessor: (t) => t.daysSinceCessation },
  { header: 'Company number', accessor: (t) => t.companyNumber },
  { header: 'Type', accessor: (t) => t.taskType },
  { header: 'Attachments', accessor: (t) => (t.hasAttachments ? 'yes' : 'no') },
  { header: 'Alias open tasks', accessor: (t) => t.nAliasOpen },
  { header: 'Alias closed tasks', accessor: (t) => t.nAliasClosed },
  { header: 'Cases', accessor: (t) => t.caseStatuses },
  { header: 'No KB process', accessor: (t) => (t.isNewKind ? 'yes' : '') },
  { header: 'Disposition', accessor: (t) => t.disposition },
  { header: 'Destination', accessor: (t) => t.destination },
  { header: 'The work', accessor: (t) => t.theWork },
  { header: 'KB ref', accessor: (t) => t.kbRef },
];

const GROUP_COLUMNS: ColumnDef<WorkGroup>[] = [
  { header: 'Work group', accessor: (g) => g.name },
  { header: 'Tasks', accessor: (g) => g.count },
  { header: 'Urgency', accessor: (g) => g.urgency },
  { header: 'Quick win', accessor: (g) => (g.quickWin ? 'yes' : '') },
  { header: 'SLA days', accessor: (g) => g.slaDays },
  { header: 'Total balance', accessor: (g) => g.totalBalance },
  { header: 'The work', accessor: (g) => g.theWork },
  { header: 'Destination', accessor: (g) => g.destination },
  { header: 'KB ref', accessor: (g) => g.kbRef },
];

const URGENCY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

function byUrgencyThenAge(a: QueueTask, b: QueueTask): number {
  return (
    (URGENCY_RANK[a.urgency ?? ''] ?? 1) - (URGENCY_RANK[b.urgency ?? ''] ?? 1) ||
    (b.ageDays ?? 0) - (a.ageDays ?? 0)
  );
}

export function QueueAnalyser() {
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [model, setModel] = useState('');
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [filters, setFilters] = useState<QueueTaskFilters>({});
  const [view, setView] = useState<'groups' | 'tasks'>('groups');

  const { data: groups } = useQueueGroups();
  const { data: runsResponse } = useQueueRuns(1, 50);
  const { data: activeRun } = useQueueRun(selectedRunId);
  const runMutation = useRunQueueAnalysis();
  const deleteMutation = useDeleteQueueRun();

  const runs = useMemo(() => runsResponse?.data ?? [], [runsResponse]);

  useEffect(() => {
    if (!selectedGroupId && groups && groups.length > 0) {
      const pas = groups.find((g) => g.groupId === PAS_GROUP_ID);
      setSelectedGroupId(pas?.groupId ?? groups[0].groupId);
    }
  }, [groups, selectedGroupId]);

  useEffect(() => {
    if (selectedRunId == null && runs.length > 0) {
      setSelectedRunId(runs[0].id);
    }
  }, [runs, selectedRunId]);

  const ready = activeRun?.status === 'ready';
  // Fetch all tasks for the run (unfiltered) — used for group member chips + the table.
  const { data: allTasks, isLoading: tasksLoading } = useQueueRunTasks(selectedRunId, {}, !!ready);

  const filteredTasks = useMemo(() => {
    let rows = allTasks ?? [];
    if (filters.urgency) rows = rows.filter((t) => t.urgency === filters.urgency);
    if (filters.status) rows = rows.filter((t) => t.status === filters.status);
    if (filters.quickWin !== undefined) rows = rows.filter((t) => !!t.quickWin === filters.quickWin);
    if (filters.wrongQueue !== undefined) rows = rows.filter((t) => !!t.wrongQueue === filters.wrongQueue);
    return rows;
  }, [allTasks, filters]);

  const quickWinCount = useMemo(() => (allTasks ?? []).filter((t) => t.quickWin).length, [allTasks]);

  const handleRun = async () => {
    if (!selectedGroupId) return;
    const run = await runMutation.mutateAsync({ groupId: selectedGroupId, model: model.trim() || undefined });
    setSelectedRunId(run.id);
  };

  const handleExport = () => {
    const tasks = [...(allTasks ?? [])].sort(byUrgencyThenAge);
    if (tasks.length === 0) return;
    const doNow = tasks.filter(
      (t) => t.quickWin || t.status === 'ready' || t.status === 'actionable_now',
    );
    const reroute = tasks.filter((t) => t.wrongQueue);
    const waiting = tasks.filter(
      (t) => t.status === 'waiting_customer' || t.status === 'waiting_third_party',
    );
    const group = (activeRun?.groupName ?? 'queue').replace(/\s+/g, '-').toLowerCase();
    const date = new Date().toISOString().split('T')[0];
    downloadXlsxWorkbook(
      [
        makeSheet('Summary', activeRun?.groups ?? [], GROUP_COLUMNS),
        makeSheet('Do now', doNow, TASK_COLUMNS),
        makeSheet('Reroute', reroute, TASK_COLUMNS),
        makeSheet('Waiting - chase', waiting, TASK_COLUMNS),
        makeSheet('All tasks', tasks, TASK_COLUMNS),
      ],
      `queue-${group}-run${selectedRunId}-${date}`,
    );
  };

  const handleDeleteRun = async (runId: number) => {
    await deleteMutation.mutateAsync(runId);
    if (selectedRunId === runId) {
      const next = runs.find((r) => r.id !== runId);
      setSelectedRunId(next?.id ?? null);
    }
  };

  return (
    <div className="flex-1 overflow-auto bg-gray-50 p-6">
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Queue Analyser</h1>
          <p className="text-sm text-muted-foreground">
            Enriches each open task with balance + company state, then groups the queue into
            real work — case status is not the verdict, the money is.
          </p>
        </div>

        <div className="rounded-lg border bg-white p-6">
          <QueueRunBar
            groups={groups ?? []}
            selectedGroupId={selectedGroupId}
            onSelectGroup={setSelectedGroupId}
            model={model}
            onModelChange={setModel}
            onRun={handleRun}
            running={runMutation.isPending}
            runs={runs}
            selectedRunId={selectedRunId}
            onSelectRun={setSelectedRunId}
            onDeleteRun={handleDeleteRun}
            deleting={deleteMutation.isPending}
            activeRun={activeRun ?? null}
          />
        </div>

        {ready && activeRun && (
          <div className="space-y-4 rounded-lg border bg-white p-6">
            {activeRun.summary && <p className="text-sm text-gray-700">{activeRun.summary}</p>}

            <div className="flex items-center justify-between gap-3">
              <div className="inline-flex rounded-md border p-0.5">
                <button
                  className={cn(
                    'rounded px-3 py-1.5 text-sm font-medium',
                    view === 'groups' ? 'bg-blue-50 text-blue-600' : 'text-gray-600 hover:bg-gray-100',
                  )}
                  onClick={() => setView('groups')}
                >
                  Work groups ({activeRun.groups.length})
                </button>
                <button
                  className={cn(
                    'rounded px-3 py-1.5 text-sm font-medium',
                    view === 'tasks' && !filters.quickWin
                      ? 'bg-blue-50 text-blue-600'
                      : 'text-gray-600 hover:bg-gray-100',
                  )}
                  onClick={() => {
                    setView('tasks');
                    setFilters({ ...filters, quickWin: undefined });
                  }}
                >
                  All tasks ({activeRun.nTasks})
                </button>
                <button
                  className={cn(
                    'rounded px-3 py-1.5 text-sm font-medium',
                    view === 'tasks' && filters.quickWin
                      ? 'bg-green-50 text-green-700'
                      : 'text-gray-600 hover:bg-gray-100',
                  )}
                  onClick={() => {
                    setView('tasks');
                    setFilters({ quickWin: true });
                  }}
                >
                  Quick wins ({quickWinCount})
                </button>
              </div>
              <div className="flex items-center gap-3">
                {view === 'tasks' && <QueueFilters filters={filters} onChange={setFilters} />}
                <Button variant="outline" onClick={handleExport} disabled={!allTasks || allTasks.length === 0}>
                  <Download className="mr-2 h-4 w-4" />
                  Export XLSX
                </Button>
              </div>
            </div>

            {view === 'groups' ? (
              <QueueGroups groups={activeRun.groups} tasks={allTasks ?? []} />
            ) : (
              <QueueTaskTable data={filteredTasks} loading={tasksLoading} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

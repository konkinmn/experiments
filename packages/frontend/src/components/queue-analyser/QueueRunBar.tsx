import { useEffect, useState } from 'react';
import { Play, Loader2, Trash2, ArrowDown, ArrowUp } from 'lucide-react';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { QueueGroup, QueueRun } from '@/types';

interface QueueRunBarProps {
  groups: QueueGroup[];
  selectedGroupId: string;
  onSelectGroup: (groupId: string) => void;
  model: string;
  onModelChange: (model: string) => void;
  onRun: () => void;
  running: boolean;
  runs: QueueRun[];
  selectedRunId: number | null;
  onSelectRun: (runId: number) => void;
  onDeleteRun: (runId: number) => void;
  deleting: boolean;
  activeRun: QueueRun | null;
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

/** Live-ticking elapsed time since `startIso` (updates every second). */
function ElapsedTimer({ startIso }: { startIso: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="tabular-nums">{formatDuration(now - new Date(startIso).getTime())}</span>;
}

function shortTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Most recent ready run of the same group that finished before `run` (runs are desc by date). */
function findPreviousRun(runs: QueueRun[], run: QueueRun): QueueRun | null {
  return (
    runs.find(
      (r) =>
        r.id !== run.id &&
        r.groupId === run.groupId &&
        r.status === 'ready' &&
        r.createdAt < run.createdAt,
    ) ?? null
  );
}

function runLabel(r: QueueRun): string {
  const date = new Date(r.createdAt).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `#${r.id} · ${r.groupName} · ${date}`;
}

export function QueueRunBar({
  groups,
  selectedGroupId,
  onSelectGroup,
  model,
  onModelChange,
  onRun,
  running,
  runs,
  selectedRunId,
  onSelectRun,
  onDeleteRun,
  deleting,
  activeRun,
}: QueueRunBarProps) {
  const previous = activeRun && activeRun.status === 'ready' ? findPreviousRun(runs, activeRun) : null;
  const delta = previous && activeRun ? activeRun.nTasks - previous.nTasks : null;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-64">
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Skill group</label>
          <Select value={selectedGroupId} onChange={(e) => onSelectGroup(e.target.value)}>
            {groups.map((g) => (
              <option key={g.groupId} value={g.groupId}>
                {g.name} (P{g.priority})
              </option>
            ))}
          </Select>
        </div>
        <div className="w-56">
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            Model (optional)
          </label>
          <Input
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
            placeholder="default"
          />
        </div>
        <Button onClick={onRun} disabled={running || !selectedGroupId}>
          {running ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Play className="mr-2 h-4 w-4" />
          )}
          Run analysis
        </Button>

        <div className="ml-auto w-80">
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Run</label>
          <div className="flex items-center gap-2">
            <Select
              value={selectedRunId ?? ''}
              onChange={(e) => onSelectRun(Number(e.target.value))}
              disabled={runs.length === 0}
            >
              {runs.length === 0 && <option value="">No runs yet</option>}
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {runLabel(r)}
                </option>
              ))}
            </Select>
            <Button
              variant="outline"
              size="icon"
              onClick={() => {
                if (selectedRunId != null && window.confirm('Delete this run?')) onDeleteRun(selectedRunId);
              }}
              disabled={selectedRunId == null || deleting}
              title="Delete run"
              aria-label="Delete run"
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </div>

      {activeRun && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-white p-3">
          {activeRun.status === 'running' && (
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Running… <ElapsedTimer startIso={activeRun.createdAt} />
            </span>
          )}
          {activeRun.status === 'error' && (
            <span className="text-sm text-red-600">
              Error: {activeRun.error}
              {activeRun.completedAt && (
                <span className="ml-1 text-muted-foreground">
                  (after {formatDuration(new Date(activeRun.completedAt).getTime() - new Date(activeRun.createdAt).getTime())})
                </span>
              )}
            </span>
          )}
          {activeRun.status === 'ready' && (
            <>
              <Badge variant="gray">{activeRun.nTasks} open tasks</Badge>
              <Badge variant="gray">{activeRun.groups.length} groups</Badge>
              <Badge variant="red">{activeRun.nHighUrgency} high urgency</Badge>
              <Badge variant="green">{activeRun.nQuickWins} quick wins</Badge>
              <Badge variant="amber">{activeRun.nOverdue} overdue</Badge>
              {activeRun.nWrongQueue > 0 && <Badge variant="purple">{activeRun.nWrongQueue} wrong queue</Badge>}
              {activeRun.totalResidualBalance != null && activeRun.totalResidualBalance > 0.005 && (
                <Badge variant="amber">
                  £{activeRun.totalResidualBalance.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} to Crown
                </Badge>
              )}
              {delta !== null && previous && (
                <span
                  className={
                    'flex items-center gap-1 text-xs font-medium ' +
                    (delta < 0 ? 'text-green-700' : delta > 0 ? 'text-red-600' : 'text-muted-foreground')
                  }
                  title={`Previous run #${previous.id} had ${previous.nTasks} open tasks`}
                >
                  {delta < 0 ? (
                    <ArrowDown className="h-3 w-3" />
                  ) : delta > 0 ? (
                    <ArrowUp className="h-3 w-3" />
                  ) : null}
                  {delta === 0
                    ? `no change vs run #${previous.id}`
                    : `${Math.abs(delta)} ${delta < 0 ? 'fewer' : 'more'} than run #${previous.id} (${shortTime(previous.createdAt)})`}
                </span>
              )}
              <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                {activeRun.completedAt && (
                  <span>
                    took {formatDuration(new Date(activeRun.completedAt).getTime() - new Date(activeRun.createdAt).getTime())}
                  </span>
                )}
                {activeRun.model && <span>{activeRun.model}</span>}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

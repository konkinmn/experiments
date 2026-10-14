import { useEffect, useState } from 'react';
import { Loader2, Square } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { Job, JobStatus } from '@/types';
import { formatCost, formatDuration, formatInt, formatLatency, formatTimeSeconds, shortId } from './format';

interface JobPanelProps {
  job: Job;
  onCancel: () => void;
  cancelling: boolean;
  cancelError: string | null;
}

const KIND_LABELS: Record<string, string> = {
  bundles: 'Build bundles',
  measure: 'Measure',
  pass1: 'Pass 1 · identify',
  pass2: 'Pass 2 · read',
  pass3: 'Pass 3 · induce',
};

function statusBadge(status: JobStatus) {
  if (status === 'running') return <Badge variant="default">running</Badge>;
  if (status === 'completed') return <Badge variant="gray">completed</Badge>;
  if (status === 'cancelled') return <Badge variant="gray">cancelled</Badge>;
  return <Badge variant="red">failed</Badge>;
}

/** Live-ticking elapsed time since `startIso`. */
function ElapsedTimer({ startIso }: { startIso: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="tabular-nums">{formatDuration(now - new Date(startIso).getTime())}</span>;
}

export function JobPanel({ job, onCancel, cancelling, cancelError }: JobPanelProps) {
  const { done, total } = job.progress;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const running = job.status === 'running';

  // Newest first — the panel is a live tail, not a chronology.
  const events = [...job.events].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));

  return (
    <div className="space-y-3 rounded-lg border bg-white p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-semibold text-gray-900">
          {KIND_LABELS[job.kind] ?? job.kind}
        </span>
        {statusBadge(job.status)}
        {job.run && <span className="text-xs text-muted-foreground">run {job.run}</span>}
        <span className="text-xs text-muted-foreground">
          {running ? (
            <>
              elapsed <ElapsedTimer startIso={job.startedAt} />
            </>
          ) : (
            <>
              took{' '}
              {job.finishedAt
                ? formatDuration(
                    new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime(),
                  )
                : '—'}
            </>
          )}
        </span>
        {running && (
          <Button variant="outline" size="sm" className="ml-auto" onClick={onCancel} disabled={cancelling}>
            {cancelling ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Square className="mr-2 h-4 w-4" />
            )}
            Cancel
          </Button>
        )}
      </div>

      {/* Progress is done/total only — never a breakdown of what came back. */}
      <div>
        <div className="mb-1 flex items-baseline justify-between text-xs text-muted-foreground">
          <span className="tabular-nums">
            {formatInt(done)} / {formatInt(total)} threads
          </span>
          <span className="tabular-nums">{pct}%</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          current:{' '}
          {job.current ? <span className="font-mono">{job.current}</span> : <span>—</span>}
        </p>
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
        <span>
          <span className="text-muted-foreground">calls </span>
          <span className="font-medium tabular-nums">{formatInt(job.usage.calls)}</span>
        </span>
        <span>
          <span className="text-muted-foreground">tokens in/out </span>
          <span className="font-medium tabular-nums">
            {formatInt(job.usage.inputTokens)} / {formatInt(job.usage.outputTokens)}
          </span>
        </span>
        <span>
          <span className="text-muted-foreground">cost </span>
          <span className="font-medium tabular-nums">{formatCost(job.usage.costUsd)}</span>
        </span>
        <span>
          <span className="text-muted-foreground">errors </span>
          <span className="font-medium tabular-nums">{formatInt(job.usage.errors)}</span>
        </span>
      </div>

      {job.status === 'failed' && job.error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <p className="font-medium">Job failed</p>
          <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs">{job.error}</pre>
        </div>
      )}

      {cancelError && <p className="text-xs text-red-600">{cancelError}</p>}

      <div className="max-h-64 overflow-y-auto rounded-md border bg-gray-50">
        {events.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">No events yet.</p>
        ) : (
          <ul className="divide-y divide-gray-200">
            {events.map((e, i) => (
              <li key={`${e.ts}-${i}`} className="flex flex-wrap items-baseline gap-2 px-3 py-1.5 text-xs">
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {formatTimeSeconds(e.ts)}
                </span>
                <span className="shrink-0 font-mono" title={e.threadId ?? undefined}>
                  {shortId(e.threadId)}
                </span>
                {e.stage && <span className="text-gray-700">{e.stage}</span>}
                {e.state && <span className="font-medium text-gray-900">{e.state}</span>}
                <span className="text-muted-foreground tabular-nums">{formatLatency(e.latencyMs)}</span>
                {!e.ok && <span className="text-red-600">failed</span>}
                {e.error && <span className="break-all text-red-600">{e.error}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

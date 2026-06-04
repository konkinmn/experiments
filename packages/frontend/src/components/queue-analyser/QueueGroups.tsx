import { useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, BookOpen, Zap, AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { WorkGroup, QueueTask, Urgency } from '@/types';

interface QueueGroupsProps {
  groups: WorkGroup[];
  tasks: QueueTask[];
}

function fmtBalance(v: number): string {
  return `£${v.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function urgencyBadge(u: Urgency) {
  if (u === 'high') return <Badge variant="red">High urgency</Badge>;
  if (u === 'medium') return <Badge variant="amber">Medium</Badge>;
  return <Badge variant="gray">Low urgency</Badge>;
}

function GroupCard({ group, taskMap }: { group: WorkGroup; taskMap: Map<number, QueueTask> }) {
  const [open, setOpen] = useState(false);
  const members = group.memberTaskIds.map((id) => taskMap.get(id)).filter(Boolean) as QueueTask[];
  const overdue = members.filter((t) => t.slaStatus === 'overdue').length;
  const wrong = members.filter((t) => t.wrongQueue).length;

  return (
    <div className="rounded-lg border bg-white">
      <button
        className="flex w-full items-start gap-3 p-4 text-left hover:bg-muted/30"
        onClick={() => setOpen((o) => !o)}
      >
        <div className="mt-0.5 text-muted-foreground">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </div>
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {urgencyBadge(group.urgency)}
            {group.quickWin && (
              <Badge variant="green">
                <Zap className="mr-1 inline h-3 w-3" />
                Quick win
              </Badge>
            )}
            <span className="font-medium text-gray-900">{group.name}</span>
            <Badge variant="gray">{group.count} tasks</Badge>
            {group.totalBalance > 0.005 && <Badge variant="amber">{fmtBalance(group.totalBalance)} on account</Badge>}
            {overdue > 0 && <Badge variant="red">{overdue} overdue</Badge>}
            {wrong > 0 && (
              <Badge variant="purple">
                <AlertTriangle className="mr-1 inline h-3 w-3" />
                {wrong} wrong queue
              </Badge>
            )}
            {group.isNewKind && <Badge variant="yellow">no KB process</Badge>}
          </div>
          <p className="mt-2 text-sm text-gray-700">{group.theWork}</p>
          {group.destination && (
            <p className="mt-1 text-xs text-muted-foreground">→ {group.destination}</p>
          )}
          {group.kbRef && (
            <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
              <BookOpen className="h-3 w-3" /> {group.kbRef}
            </p>
          )}
        </div>
      </button>

      {open && (
        <div className="border-t px-4 py-3">
          <div className="flex flex-wrap gap-2">
            {members.map((t) => {
              const bal = t.balance && t.balance > 0.005 ? ` · ${fmtBalance(t.balance)}` : '';
              const label = `#${t.taskId} ${(t.title ?? '').slice(0, 36)}${bal}`;
              const cls =
                'rounded-full border px-2.5 py-1 text-xs ' +
                (t.slaStatus === 'overdue' ? 'border-red-300 bg-red-50 text-red-700' : 'bg-muted/40 text-primary');
              return t.wsLink ? (
                <a key={t.id} href={t.wsLink} target="_blank" rel="noopener noreferrer" className={cls} title={t.title ?? ''}>
                  {label}
                  <ExternalLink className="ml-1 inline h-3 w-3" />
                </a>
              ) : (
                <span key={t.id} className={cls} title={t.title ?? ''}>
                  {label}
                </span>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function QueueGroups({ groups, tasks }: QueueGroupsProps) {
  const taskMap = new Map(tasks.map((t) => [t.taskId, t]));
  if (groups.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-muted-foreground">No work groups for this run</div>
    );
  }
  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <GroupCard key={g.kind} group={g} taskMap={taskMap} />
      ))}
    </div>
  );
}

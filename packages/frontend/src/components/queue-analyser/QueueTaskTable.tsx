import { ExternalLink, Zap } from 'lucide-react';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import type { QueueTask, Urgency, TaskStatus } from '@/types';

interface QueueTaskTableProps {
  data: QueueTask[];
  loading?: boolean;
}

function fmtBalance(v: number | null): string {
  if (v === null) return '—';
  return `£${v.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function urgencyBadge(u: Urgency | null) {
  if (u === 'high') return <Badge variant="red">High</Badge>;
  if (u === 'medium') return <Badge variant="amber">Med</Badge>;
  if (u === 'low') return <Badge variant="gray">Low</Badge>;
  return <span className="text-muted-foreground">—</span>;
}

function statusBadge(s: TaskStatus | null) {
  if (!s) return <span className="text-muted-foreground">—</span>;
  const map: Record<TaskStatus, 'green' | 'blue' | 'amber' | 'gray'> = {
    ready: 'green',
    actionable_now: 'green',
    waiting_customer: 'amber',
    waiting_third_party: 'blue',
    needs_info: 'gray',
  };
  return <Badge variant={map[s]}>{s.replace(/_/g, ' ')}</Badge>;
}

export function QueueTaskTable({ data, loading }: QueueTaskTableProps) {
  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }
  if (data.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-muted-foreground">
        No tasks for this run / filter
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Task</TableHead>
            <TableHead>Title</TableHead>
            <TableHead className="text-right">Balance</TableHead>
            <TableHead>Company</TableHead>
            <TableHead>Group</TableHead>
            <TableHead>Urgency</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Age / SLA</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((t) => (
            <TableRow key={t.id} className="align-top">
              <TableCell className="whitespace-nowrap font-mono text-xs">
                {t.wsLink ? (
                  <a href={t.wsLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                    #{t.taskId}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                ) : (
                  `#${t.taskId}`
                )}
              </TableCell>
              <TableCell className="max-w-[16rem] text-sm">
                <span className="line-clamp-2" title={t.title ?? ''}>{t.title || '—'}</span>
              </TableCell>
              <TableCell className="whitespace-nowrap text-right text-sm font-medium">{fmtBalance(t.balance)}</TableCell>
              <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{t.companyStatus || '—'}</TableCell>
              <TableCell className="max-w-[14rem] text-xs">
                <span className="line-clamp-2" title={t.groupName ?? ''}>{t.groupName || '—'}</span>
                <span className="mt-0.5 flex flex-wrap gap-1">
                  {t.quickWin && (
                    <Badge variant="green">
                      <Zap className="mr-0.5 inline h-3 w-3" />win
                    </Badge>
                  )}
                  {t.wrongQueue && <Badge variant="purple">→ {t.suggestedQueue ?? 'other queue'}</Badge>}
                  {t.isNewKind && <Badge variant="yellow">no KB</Badge>}
                </span>
              </TableCell>
              <TableCell>{urgencyBadge(t.urgency)}</TableCell>
              <TableCell>{statusBadge(t.status)}</TableCell>
              <TableCell className="whitespace-nowrap text-xs">
                {t.ageDays != null ? `${t.ageDays}d` : '—'}
                {t.slaStatus === 'overdue' && <Badge variant="red" className="ml-1">overdue</Badge>}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

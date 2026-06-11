import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, MessageSquare, Zap } from 'lucide-react';
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

const SENDER_STYLES: Record<string, string> = {
  customer: 'bg-blue-100 text-blue-700',
  operator: 'bg-gray-200 text-gray-700',
  bot: 'bg-muted text-muted-foreground italic',
};

/** One chat message row: "YYYY-MM-DD sender: text" with sender-colored badge. */
function MessageLine({ item }: { item: string }) {
  const m = item.match(/^(\d{4}-\d{2}-\d{2}) (customer|operator|bot): (.*)$/);
  if (!m) return <li className="text-foreground/80">{item}</li>;
  const [, day, sender, text] = m;
  return (
    <li className="flex items-baseline gap-2">
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{day}</span>
      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${SENDER_STYLES[sender]}`}>
        {sender}
      </span>
      <span className={sender === 'bot' ? 'italic text-muted-foreground' : 'text-foreground/80'}>{text}</span>
    </li>
  );
}

/** Render the compact case_context block (newline-separated "key=value · …" sections). */
function CaseContextDetail({ context }: { context: string }) {
  const sections = context.split('\n').map((line) => {
    const eq = line.indexOf('=');
    const label = eq > 0 ? line.slice(0, eq) : '';
    const value = eq > 0 ? line.slice(eq + 1) : line;
    return { label, items: value.split(' | ') };
  });
  return (
    <div className="space-y-2 rounded-md bg-muted/50 p-3 text-xs">
      {sections.map((s, i) => (
        <div key={i}>
          {s.label && <span className="font-semibold uppercase text-muted-foreground">{s.label}</span>}
          <ul className={s.label === 'messages' ? 'mt-1 space-y-1' : 'mt-0.5 space-y-0.5'}>
            {s.items.map((it, j) =>
              s.label === 'messages' ? (
                <MessageLine key={j} item={it} />
              ) : (
                <li key={j} className="text-foreground/80">{it}</li>
              ),
            )}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function QueueTaskTable({ data, loading }: QueueTaskTableProps) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
            <TableHead className="w-8" />
            <TableHead>Task</TableHead>
            <TableHead>Title</TableHead>
            <TableHead className="text-right">Balance</TableHead>
            <TableHead>Company</TableHead>
            <TableHead>Group</TableHead>
            <TableHead>Urgency</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Next step</TableHead>
            <TableHead>Reasoning</TableHead>
            <TableHead>Age / SLA</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((t) => (
            <Fragment key={t.id}>
            <TableRow className="align-top">
              <TableCell className="pr-0">
                {t.caseContext ? (
                  <button
                    type="button"
                    onClick={() => toggle(t.id)}
                    className="inline-flex items-center text-muted-foreground hover:text-foreground"
                    title="Show case context"
                  >
                    {expanded.has(t.id) ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </button>
                ) : null}
              </TableCell>
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
              <TableCell className="max-w-[16rem] text-xs">
                {t.suggestedAction ? (
                  <span className="line-clamp-3 font-medium" title={t.suggestedAction}>
                    {t.suggestedAction}
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="max-w-[18rem] text-xs">
                {t.rationale ? (
                  <span className="line-clamp-3 text-muted-foreground" title={t.rationale}>
                    {t.rationale}
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="whitespace-nowrap text-xs">
                {t.ageDays != null ? `${t.ageDays}d` : '—'}
                {t.slaStatus === 'overdue' && <Badge variant="red" className="ml-1">overdue</Badge>}
              </TableCell>
            </TableRow>
            {t.caseContext && expanded.has(t.id) && (
              <TableRow>
                <TableCell />
                <TableCell colSpan={10}>
                  <div className="mb-1 flex items-center gap-1 text-xs font-medium text-muted-foreground">
                    <MessageSquare className="h-3.5 w-3.5" /> Case context
                  </div>
                  <CaseContextDetail context={t.caseContext} />
                </TableCell>
              </TableRow>
            )}
            </Fragment>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

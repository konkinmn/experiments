import { useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { BundleTask, ThreadDetail } from '@/types';
import { formatTime } from '../format';

function TaskCard({ task, url }: { task: BundleTask; url: string | null }) {
  const [showComments, setShowComments] = useState(false);
  const title = task.title || 'untitled';

  return (
    <article className="rounded-md border border-gray-200 p-4">
      <div className="flex flex-wrap items-center gap-2">
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline"
          >
            {title}
            <ExternalLink className="h-3 w-3" />
          </a>
        ) : (
          <span className="text-sm font-semibold text-gray-900">{title}</span>
        )}
        {task.task_type && <Badge variant="gray">{task.task_type}</Badge>}
        {task.status && <Badge variant="gray">{task.status}</Badge>}
        {task.partner_side && <Badge variant="gray">partner side</Badge>}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 text-xs text-muted-foreground">
        <span className="font-mono">#{task.id}</span>
        <span>created {formatTime(task.created_at)}</span>
        <span>closed {formatTime(task.closed_at)}</span>
        {task.created_by && <span>by {task.created_by}</span>}
      </div>
      {task.description && (
        <p className="mt-3 max-w-prose whitespace-pre-wrap text-sm leading-relaxed text-gray-800">
          {task.description}
        </p>
      )}
      {task.comments.length > 0 && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowComments(!showComments)}
            className="inline-flex items-center gap-1 text-xs font-medium text-gray-600 hover:text-gray-900"
          >
            {showComments ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            {task.comments.length} comment{task.comments.length === 1 ? '' : 's'}
          </button>
          {showComments && (
            <ul className="mt-2 space-y-2 border-l-2 border-gray-100 pl-3">
              {task.comments.map((c) => (
                <li key={c.id}>
                  <p className="pc-dim flex flex-wrap gap-x-3 text-[13px]">
                    <span className="font-medium">{c.author || 'unknown'}</span>
                    <span>{formatTime(c.created_at)}</span>
                  </p>
                  <p className="max-w-prose whitespace-pre-wrap text-sm leading-relaxed text-gray-800">
                    {c.description}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </article>
  );
}

export function TasksTab({ detail }: { detail: ThreadDetail }) {
  // Chronological: the order the agents actually worked the thread.
  const tasks = [...detail.bundle.tasks].sort((a, b) =>
    (a.created_at ?? '') < (b.created_at ?? '')
      ? -1
      : (a.created_at ?? '') > (b.created_at ?? '')
        ? 1
        : 0,
  );

  if (tasks.length === 0) {
    return <p className="text-sm text-muted-foreground">No tasks in this thread.</p>;
  }

  const linkFor = (taskId: string): string | null =>
    detail.wsLinks?.tasks.find((t) => String(t.taskId) === String(taskId))?.url ?? null;

  return (
    <div className="space-y-4">
      {tasks.map((t) => (
        <TaskCard key={t.id} task={t} url={linkFor(t.id)} />
      ))}
    </div>
  );
}

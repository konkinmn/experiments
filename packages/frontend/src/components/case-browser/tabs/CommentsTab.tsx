import { useMemo } from 'react';
import type { CaseBundle, CommentRecord } from '@/types';

interface CommentsTabProps {
  bundle: CaseBundle;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface ThreadedComment extends CommentRecord {
  depth: number;
}

function threadComments(comments: CommentRecord[]): ThreadedComment[] {
  const byParent = new Map<string | null, CommentRecord[]>();
  for (const c of comments) {
    const key = c.parentCommentId ?? null;
    const list = byParent.get(key) ?? [];
    list.push(c);
    byParent.set(key, list);
  }
  const out: ThreadedComment[] = [];
  const walk = (parent: string | null, depth: number) => {
    const children = byParent.get(parent) ?? [];
    for (const c of children) {
      out.push({ ...c, depth });
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export function CommentsTab({ bundle }: CommentsTabProps) {
  const threaded = useMemo(() => threadComments(bundle.comments), [bundle.comments]);

  if (threaded.length === 0) {
    return <p className="text-sm text-muted-foreground">No internal comments on this case.</p>;
  }

  return (
    <div className="space-y-3">
      {threaded.map((c) => (
        <div
          key={c.id}
          className="rounded-md border border-gray-200 bg-white p-3"
          style={{ marginLeft: c.depth * 24 }}
        >
          <div className="mb-1 flex items-baseline gap-2 text-xs text-muted-foreground">
            <span className="font-semibold text-gray-900">{c.authorName || c.authorAlias || 'Unknown'}</span>
            <span>·</span>
            <span>{formatDate(c.createdAt)}</span>
          </div>
          <p className="whitespace-pre-wrap break-words text-sm text-gray-900">{c.body || ''}</p>
        </div>
      ))}
    </div>
  );
}

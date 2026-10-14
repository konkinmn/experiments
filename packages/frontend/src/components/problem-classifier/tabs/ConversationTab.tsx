import { ExternalLink } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { ThreadDetail } from '@/types';
import { ThreadMessageBubble } from '../ThreadMessageBubble';
import { formatTime } from '../format';

export function ConversationTab({ detail }: { detail: ThreadDetail }) {
  const dialogues = [...detail.bundle.dialogues].sort(
    (a, b) => (a.thread_position ?? 0) - (b.thread_position ?? 0),
  );

  const linkFor = (dialogueId: string): string | null =>
    detail.wsLinks?.dialogues.find((d) => String(d.dialogueId) === String(dialogueId))?.url ??
    null;

  if (dialogues.length === 0) {
    return <p className="text-sm text-muted-foreground">No dialogues in this bundle.</p>;
  }

  return (
    <div className="space-y-8">
      {dialogues.map((d) => {
        const url = linkFor(d.dialogue_id);
        return (
          <section key={d.dialogue_id} className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 pb-2">
              <span className="text-xs font-semibold text-gray-900">#{d.thread_position}</span>
              {url ? (
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline"
                >
                  {d.dialogue_id}
                  <ExternalLink className="h-3 w-3" />
                </a>
              ) : (
                <span className="font-mono text-xs text-muted-foreground">{d.dialogue_id}</span>
              )}
              {d.kind && <Badge variant="gray">{d.kind}</Badge>}
              {d.container?.status && <Badge variant="gray">{d.container.status}</Badge>}
              <span className="text-xs text-muted-foreground">
                {formatTime(d.container?.created_at ?? null)}
                {d.container?.closed_at ? ` → ${formatTime(d.container.closed_at)}` : ''}
              </span>
            </div>
            <div className="space-y-3">
              {d.messages.map((m) => (
                <ThreadMessageBubble key={m.message_id} message={m} />
              ))}
              {d.messages.length === 0 && (
                <p className="text-sm text-muted-foreground">No messages in this dialogue.</p>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

import { Paperclip } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import type { MessageRecord } from '@/types';

interface MessageBubbleProps {
  message: MessageRecord;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function parseFiles(filesJson: string | null): string[] {
  if (!filesJson) return [];
  try {
    const parsed = JSON.parse(filesJson);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((f) => {
        if (typeof f === 'string') return f;
        if (f && typeof f === 'object') {
          return (f.name as string | undefined) ?? (f.filename as string | undefined) ?? (f.url as string | undefined) ?? null;
        }
        return null;
      })
      .filter((s): s is string => Boolean(s));
  } catch {
    return [];
  }
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const align =
    message.senderType === 'customer'
      ? 'items-end'
      : message.senderType === 'bot'
      ? 'items-center'
      : 'items-start';

  const bubble =
    message.senderType === 'customer'
      ? 'bg-primary/10 text-gray-900'
      : message.senderType === 'bot'
      ? 'bg-gray-50 text-gray-600 italic'
      : 'bg-white text-gray-900 border border-gray-200';

  const senderLabel =
    message.senderName ||
    (message.senderType === 'customer'
      ? 'Customer'
      : message.senderType === 'bot'
      ? 'Bot'
      : message.senderAlias || 'Operator');

  const files = parseFiles(message.files);

  return (
    <div className={cn('flex w-full flex-col gap-1', align)}>
      <div className="flex items-baseline gap-2 px-1 text-xs text-muted-foreground">
        <span className="font-semibold">{senderLabel}</span>
        <span>·</span>
        <span>{formatTime(message.timestamp)}</span>
        {message.skillRoute && (
          <Badge variant="blue" className="ml-1">
            {message.skillRoute}
          </Badge>
        )}
        {message.isHidden && (
          <Badge variant="gray" className="ml-1">
            hidden
          </Badge>
        )}
      </div>
      <div className={cn('max-w-[80%] rounded-lg px-3.5 py-2.5 text-sm', bubble)}>
        {message.text ? (
          <p className="whitespace-pre-wrap break-words">{message.text}</p>
        ) : (
          <p className="text-muted-foreground italic">[no text]</p>
        )}
        {files.length > 0 && (
          <div className="mt-2 flex flex-col gap-1">
            {files.map((f, i) => (
              <span key={i} className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Paperclip className="h-3 w-3" />
                {f}
              </span>
            ))}
          </div>
        )}
        {message.payloadTemplateType && (
          <div className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            {message.payloadTemplateType}
          </div>
        )}
      </div>
    </div>
  );
}

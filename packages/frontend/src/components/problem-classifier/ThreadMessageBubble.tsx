import { Paperclip } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import type { BundleMessage } from '@/types';
import { formatTimeSeconds } from './format';

/**
 * Sibling of case-browser's MessageBubble: the bundle message shape is
 * different (speaker / speaker_alias / payload_type, and a `system` speaker),
 * so the props of that component do not fit.
 */
interface ThreadMessageBubbleProps {
  message: BundleMessage;
}

function parseFiles(files: unknown): string[] {
  let value = files;
  if (typeof value === 'string') {
    const raw = value;
    if (raw.trim() === '') return [];
    try {
      value = JSON.parse(raw);
    } catch {
      return [raw];
    }
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((f) => {
      if (typeof f === 'string') return f;
      if (f && typeof f === 'object') {
        const o = f as Record<string, unknown>;
        return (o.name ?? o.filename ?? o.url ?? null) as string | null;
      }
      return null;
    })
    .filter((s): s is string => Boolean(s));
}

export function ThreadMessageBubble({ message }: ThreadMessageBubbleProps) {
  const isCustomer = message.speaker === 'customer';
  const isQuiet = message.speaker === 'bot' || message.speaker === 'system';

  const align = isCustomer ? 'items-end' : isQuiet ? 'items-center' : 'items-start';
  const bubble = isCustomer
    ? 'bg-primary/10 text-gray-900'
    : isQuiet
      ? 'bg-gray-50 text-gray-600 italic'
      : 'bg-white text-gray-900 border border-gray-200';

  const senderLabel =
    message.speaker_alias ||
    (isCustomer ? 'Customer' : message.speaker === 'agent' ? 'Agent' : message.speaker);

  const files = parseFiles(message.files);

  return (
    <div className={cn('flex w-full flex-col gap-1', align)}>
      <div className="pc-dim flex items-baseline gap-3 px-1 text-[13px]">
        <span className="font-medium">{senderLabel}</span>
        <span>{formatTimeSeconds(message.timestamp)}</span>
        <span className="pc-tnum">#{message.message_num}</span>
        {message.is_hidden && (
          <Badge variant="gray" className="ml-1">
            hidden
          </Badge>
        )}
      </div>
      <div className={cn('max-w-[80%] rounded-lg px-3.5 py-2.5 text-sm', bubble)}>
        {message.text ? (
          <p className="whitespace-pre-wrap break-words">{message.text}</p>
        ) : (
          <p className="italic text-muted-foreground">[no text]</p>
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
        {message.payload_type && (
          <div className="pc-dim mt-1 text-[13px]">
            {message.payload_type}
          </div>
        )}
      </div>
    </div>
  );
}

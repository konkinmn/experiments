import { Badge } from '@/components/ui/badge';
import type { CaseBundle } from '@/types';

interface TimelineTabProps {
  bundle: CaseBundle;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function prettyJson(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed == null || (typeof parsed === 'object' && Object.keys(parsed).length === 0)) return null;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}

export function TimelineTab({ bundle }: TimelineTabProps) {
  if (bundle.events.length === 0) {
    return <p className="text-sm text-muted-foreground">No timeline events recorded for this case.</p>;
  }

  return (
    <ol className="relative space-y-4 border-l border-gray-200 pl-6">
      {bundle.events.map((e) => {
        const meta = prettyJson(e.metadata);
        return (
          <li key={e.id} className="relative">
            <span className="absolute -left-[33px] top-1.5 h-2.5 w-2.5 rounded-full bg-primary" />
            <div className="flex flex-wrap items-baseline gap-3">
              <Badge variant="blue">{e.eventType || 'EVENT'}</Badge>
              <span className="text-xs text-muted-foreground">{formatDate(e.createdAt)}</span>
              {e.actorAlias && <span className="text-xs text-muted-foreground">by {e.actorAlias}</span>}
            </div>
            {meta && (
              <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-gray-50 p-2 font-mono text-[11px] leading-snug text-gray-700">
                {meta}
              </pre>
            )}
          </li>
        );
      })}
    </ol>
  );
}

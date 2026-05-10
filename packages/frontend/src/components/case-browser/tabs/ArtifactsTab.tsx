import { Badge } from '@/components/ui/badge';
import type { CaseBundle } from '@/types';

interface ArtifactsTabProps {
  bundle: CaseBundle;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function prettyJson(raw: string | null): string {
  if (!raw) return '';
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export function ArtifactsTab({ bundle }: ArtifactsTabProps) {
  if (bundle.artifacts.length === 0) {
    return <p className="text-sm text-muted-foreground">No artifacts attached to this case.</p>;
  }

  return (
    <div className="space-y-4">
      {bundle.artifacts.map((a) => (
        <div key={a.id} className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="mb-2 flex items-center gap-3">
            <Badge variant="purple">{a.artifactType || 'UNKNOWN'}</Badge>
            <span className="font-mono text-xs text-muted-foreground">{a.artifactId || '—'}</span>
            <span className="ml-auto text-xs text-muted-foreground">{formatDate(a.createdAt)}</span>
          </div>
          {a.form && (
            <div className="space-y-2 text-sm">
              {a.form.title && <p className="font-medium text-gray-900">{a.form.title}</p>}
              <div className="flex gap-4 text-xs text-muted-foreground">
                {a.form.type && <span>type: {a.form.type}</span>}
                {a.form.status && <span>status: {a.form.status}</span>}
                {a.form.uploadedAt && <span>uploaded: {formatDate(a.form.uploadedAt)}</span>}
              </div>
              {a.form.fields && (
                <details>
                  <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Form fields
                  </summary>
                  <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-gray-50 p-3 font-mono text-[11px] leading-snug text-gray-800">
                    {prettyJson(a.form.fields)}
                  </pre>
                </details>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

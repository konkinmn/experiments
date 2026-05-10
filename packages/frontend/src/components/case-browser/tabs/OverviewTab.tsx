import { AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { CaseBundle } from '@/types';

interface OverviewTabProps {
  bundle: CaseBundle;
}

function formatDate(dateString: string | null): string {
  if (!dateString) return '—';
  return new Date(dateString).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function decisionBadge(decision: string | null) {
  if (!decision) return <span className="text-muted-foreground">—</span>;
  const key = decision.toUpperCase();
  if (key === 'CREDIT') return <Badge variant="green">Credit</Badge>;
  if (key === 'ESCALATE') return <Badge variant="amber">Escalate</Badge>;
  return <Badge variant="gray">{decision}</Badge>;
}

function riskBadge(risk: string | null) {
  if (!risk) return <span className="text-muted-foreground">—</span>;
  const key = risk.toLowerCase();
  if (key === 'green') return <Badge variant="green">Green</Badge>;
  if (key === 'amber') return <Badge variant="amber">Amber</Badge>;
  if (key === 'red') return <Badge variant="red">Red</Badge>;
  return <Badge variant="gray">{risk}</Badge>;
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 py-1.5 text-sm">
      <span className="w-32 shrink-0 text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-gray-900">{children}</span>
    </div>
  );
}

export function OverviewTab({ bundle }: OverviewTabProps) {
  const c = bundle.case;
  const a = bundle.assessment;

  if (!c) {
    return <p className="text-sm text-muted-foreground">Case not found.</p>;
  }

  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Case</h3>
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <MetaRow label="Ref ID">{c.refId || '—'}</MetaRow>
          <MetaRow label="Alias">{c.alias || '—'}</MetaRow>
          <MetaRow label="Status">{c.status}</MetaRow>
          <MetaRow label="Outcome">{c.outcome || '—'}</MetaRow>
          <MetaRow label="Issue type">{c.issueTypeId || '—'}</MetaRow>
          <MetaRow label="Business area">{c.businessAreaId || '—'}</MetaRow>
          <MetaRow label="Owner">{c.owner || '—'}</MetaRow>
          <MetaRow label="Created">{formatDate(c.createdAt)}</MetaRow>
          <MetaRow label="Updated">{formatDate(c.updatedAt)}</MetaRow>
          {c.summary && (
            <div className="mt-3 border-t border-gray-100 pt-3">
              <p className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">Summary</p>
              <p className="whitespace-pre-wrap text-sm text-gray-900">{c.summary}</p>
            </div>
          )}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Assessment</h3>
        {a ? (
          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <MetaRow label="Decision">{decisionBadge(a.decision)}</MetaRow>
            <MetaRow label="Risk level">{riskBadge(a.riskLevel)}</MetaRow>
            <MetaRow label="Risk score">{a.riskScore != null ? a.riskScore : '—'}</MetaRow>
            <MetaRow label="Hard gate">
              {a.trigger ? <Badge variant="red">{a.trigger}</Badge> : <span className="text-muted-foreground">none</span>}
            </MetaRow>
            <MetaRow label="Status">{a.status || '—'}</MetaRow>
            <MetaRow label="Duration">{a.durationMs != null ? `${a.durationMs} ms` : '—'}</MetaRow>
            <MetaRow label="Created">{formatDate(a.createdAt)}</MetaRow>
            {a.error && (
              <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-xs">
                <p className="mb-1 flex items-center gap-1 font-semibold uppercase tracking-wide text-red-700">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Error
                </p>
                <p className="whitespace-pre-wrap break-words font-mono text-red-800">{a.error}</p>
              </div>
            )}
            {a.data && (
              <details className="mt-3">
                <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Raw pipeline data
                </summary>
                <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-gray-50 p-3 font-mono text-[11px] leading-snug text-gray-800">
                  {a.data}
                </pre>
              </details>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No assessment recorded for this case.</p>
        )}
      </section>
    </div>
  );
}

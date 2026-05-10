import { useEffect, useMemo, useState } from 'react';
import { X, ExternalLink, Download, AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useCaseBrowserDetail } from '@/hooks/useCaseBrowser';
import { TabNav } from './TabNav';
import { OverviewTab } from './tabs/OverviewTab';
import { DialoguesTab } from './tabs/DialoguesTab';
import { MessagesTab } from './tabs/MessagesTab';
import { CommentsTab } from './tabs/CommentsTab';
import { ArtifactsTab } from './tabs/ArtifactsTab';
import { TimelineTab } from './tabs/TimelineTab';

interface CaseDetailDrawerProps {
  caseId: string | null;
  onClose: () => void;
}

type TabId = 'overview' | 'dialogues' | 'messages' | 'comments' | 'artifacts' | 'timeline';

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function CaseDetailDrawer({ caseId, onClose }: CaseDetailDrawerProps) {
  const open = caseId != null;
  const { data: bundle, isLoading, error } = useCaseBrowserDetail(caseId);

  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  useEffect(() => {
    setActiveTab('overview');
  }, [caseId]);

  const showLagBanner = useMemo(() => {
    if (!bundle?.case || !bundle.dataFreshness.bqMaxTimestamp) return false;
    return new Date(bundle.case.createdAt).getTime() > new Date(bundle.dataFreshness.bqMaxTimestamp).getTime();
  }, [bundle?.case, bundle?.dataFreshness.bqMaxTimestamp]);

  const tabs = useMemo(() => {
    if (!bundle) return [];
    return [
      { id: 'overview' as const, label: 'Overview' },
      { id: 'dialogues' as const, label: 'Dialogues', count: bundle.dialogues.length },
      {
        id: 'messages' as const,
        label: 'Messages',
        count: bundle.dialogues.reduce((sum, d) => sum + d.messages.length, 0),
      },
      { id: 'comments' as const, label: 'Comments', count: bundle.comments.length },
      { id: 'artifacts' as const, label: 'Artifacts', count: bundle.artifacts.length },
      { id: 'timeline' as const, label: 'Timeline', count: bundle.events.length },
    ];
  }, [bundle]);

  const handleDownload = async () => {
    if (!caseId) return;
    setDownloading(true);
    try {
      const blob = await api.exportCaseBrowserSingle(caseId);
      downloadBlob(blob, `case-${caseId}.json`);
    } finally {
      setDownloading(false);
    }
  };

  const handleSelectDialogue = (_dialogueId: string) => {
    setActiveTab('messages');
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/40 transition-opacity" onClick={onClose} aria-hidden />
      <div className="flex h-full w-full max-w-5xl flex-col overflow-y-auto bg-white shadow-2xl">
        <div className="sticky top-0 z-10 border-b border-gray-200 bg-white/95 px-8 py-5 backdrop-blur">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="font-mono text-xl font-semibold tracking-tight">
                  {bundle?.case?.refId || `Case #${caseId}`}
                </h2>
                {bundle?.case && (
                  <Badge variant={bundle.case.status === 'RESOLVED' ? 'green' : bundle.case.status === 'DISMISSED' ? 'gray' : 'blue'}>
                    {bundle.case.status}
                  </Badge>
                )}
                {bundle?.assessment?.decision && (
                  <Badge variant={bundle.assessment.decision.toUpperCase() === 'CREDIT' ? 'green' : 'amber'}>
                    {bundle.assessment.decision}
                  </Badge>
                )}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                <span className="font-mono">#{caseId}</span>
                {bundle?.case?.alias && (
                  <>
                    <span>·</span>
                    <span>{bundle.case.alias}</span>
                    <a
                      href={`https://chat-workstation.k1.anna.money/${bundle.case.alias}/tasks/cases?chatWindow=chat&caseId=${caseId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      Open in WS
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={handleDownload} disabled={downloading || !bundle?.case}>
                <Download className="mr-2 h-4 w-4" />
                {downloading ? 'Downloading…' : 'Download JSON'}
              </Button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-900"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>
        </div>

        {showLagBanner && (
          <div className="flex items-start gap-3 border-b border-amber-200 bg-amber-50 px-8 py-3 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">Messages may not be exported yet.</p>
              <p className="text-xs">
                Last BQ refresh {formatTime(bundle?.dataFreshness.bqMaxTimestamp ?? null)} — case created{' '}
                {formatTime(bundle?.case?.createdAt ?? null)}. Check back in a few hours.
              </p>
            </div>
          </div>
        )}

        <div className="flex-1 px-8 py-4">
          {isLoading && (
            <div className="flex h-64 items-center justify-center">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
            </div>
          )}

          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
              Failed to load case: {error.message}
            </div>
          )}

          {bundle && (
            <>
              <TabNav tabs={tabs} active={activeTab} onChange={(id) => setActiveTab(id as TabId)} />
              <div className="pt-5">
                {activeTab === 'overview' && <OverviewTab bundle={bundle} />}
                {activeTab === 'dialogues' && (
                  <DialoguesTab bundle={bundle} onSelectDialogue={handleSelectDialogue} />
                )}
                {activeTab === 'messages' && <MessagesTab bundle={bundle} />}
                {activeTab === 'comments' && <CommentsTab bundle={bundle} />}
                {activeTab === 'artifacts' && <ArtifactsTab bundle={bundle} />}
                {activeTab === 'timeline' && <TimelineTab bundle={bundle} />}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

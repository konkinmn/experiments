import { useEffect, useState } from 'react';
import { ExternalLink, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TabNav } from '@/components/case-browser';
import { ConversationTab } from './tabs/ConversationTab';
import { TasksTab } from './tabs/TasksTab';
import { ReadingTab } from './tabs/ReadingTab';
import { DetailsTab } from './tabs/DetailsTab';
import type { ThreadDetail, ThreadRow } from '@/types';
import { formatInt, wsCustomerLink } from './format';

type TabId = 'reading' | 'conversation' | 'tasks' | 'details';

interface ThreadDrawerProps {
  threadId: string | null;
  /** The row the drawer was opened from — header renders before detail lands. */
  row: ThreadRow | null;
  detail: ThreadDetail | undefined;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}

function metaString(meta: Record<string, unknown> | undefined, key: string): string | null {
  if (!meta) return null;
  const v = meta[key];
  if (v == null) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

/** `2 dialogues, 22 messages, no tasks` — a sentence, not a dot-joined string. */
function sizeSentence(dialogues: number, messages: number, tasks: number): string {
  const part = (n: number, one: string, many: string) =>
    n === 0 ? `no ${many}` : `${formatInt(n)} ${n === 1 ? one : many}`;
  return [
    part(dialogues, 'dialogue', 'dialogues'),
    part(messages, 'message', 'messages'),
    part(tasks, 'task', 'tasks'),
  ].join(', ');
}

export function ThreadDrawer({
  threadId,
  row,
  detail,
  loading,
  error,
  onClose,
}: ThreadDrawerProps) {
  const open = threadId != null;
  const [activeTab, setActiveTab] = useState<TabId>('reading');

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  useEffect(() => {
    setActiveTab('reading');
  }, [threadId]);

  if (!open) return null;

  const dialogues = detail?.bundle.dialogues.length ?? row?.nDialogues ?? 0;
  const messages =
    detail?.bundle.dialogues.reduce((sum, d) => sum + d.messages.length, 0) ?? row?.nMessages ?? 0;
  const tasks = detail?.bundle.tasks.length ?? row?.nTasks ?? 0;

  /* The Gemma scenario leaf the thread was selected by — named as such, so it is not
   * read as the induced problem on the line above it. */
  const scenario = row?.category ?? metaString(detail?.meta, 'category');
  const alias = row?.customerAlias ?? metaString(detail?.meta, 'customer_alias');
  const category = detail?.pass3?.category ?? row?.pass3Category ?? null;
  const wsHref = row?.wsLink || wsCustomerLink(alias);

  const tabs = [
    { id: 'reading', label: 'Reading' },
    { id: 'conversation', label: 'Conversation', count: dialogues || undefined },
    { id: 'tasks', label: 'Tasks', count: tasks || undefined },
    { id: 'details', label: 'Details' },
  ];

  return (
    <div className="pc-page fixed inset-0 z-50 flex">
      <div className="pc-scrim flex-1 bg-black/30" onClick={onClose} aria-hidden />
      <div className="pc-drawer flex h-full w-full max-w-5xl flex-col overflow-y-auto bg-white shadow-2xl">
        <div className="sticky top-0 z-10 border-b border-[var(--pc-line)] bg-white/95 px-8 py-6 backdrop-blur">
          <div className="flex items-start justify-between gap-6">
            <div className="min-w-0">
              <h2 className="pc-tnum text-[22px] font-semibold tracking-tight">{threadId}</h2>
              {category && <p className="mt-1 text-[17px]">{category}</p>}
              <div className="pc-dim mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
                {scenario && <span>Scenario: {scenario}</span>}
                {alias && <span className="pc-tnum">{alias}</span>}
                <span>{sizeSentence(dialogues, messages, tasks)}</span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {wsHref && (
                <Button size="sm" className="pc-focus" asChild>
                  <a
                    href={wsHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={
                      row?.wsLink
                        ? 'Open this thread in Workstation'
                        : 'Open this customer in Workstation'
                    }
                  >
                    Open in Workstation
                    <ExternalLink className="ml-2 h-3.5 w-3.5" />
                  </a>
                </Button>
              )}
              <button
                type="button"
                onClick={onClose}
                className="pc-focus pc-dim rounded-md p-1 hover:bg-[var(--pc-shade)] hover:text-[var(--pc-ink)]"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>
        </div>

        <div className="flex-1 px-8 py-4">
          {loading && (
            <div className="flex h-64 items-center justify-center">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
            </div>
          )}

          {error && !loading && (
            <div className="space-y-1">
              <p className="text-[15px]">This thread did not load. Close the panel and open it again.</p>
              <p className="pc-dim text-[13px]">{error}</p>
            </div>
          )}

          {detail && (
            <>
              <TabNav tabs={tabs} active={activeTab} onChange={(id) => setActiveTab(id as TabId)} />
              <div className="pt-7">
                {activeTab === 'reading' && <ReadingTab detail={detail} row={row} />}
                {activeTab === 'conversation' && <ConversationTab detail={detail} />}
                {activeTab === 'tasks' && <TasksTab detail={detail} />}
                {activeTab === 'details' && <DetailsTab detail={detail} />}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

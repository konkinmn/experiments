import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { MessageBubble } from '../MessageBubble';
import type { CaseBundle, DialogueRecord } from '@/types';

interface MessagesTabProps {
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

function roleBadge(role: 'prior' | 'active' | 'after') {
  if (role === 'prior') return <Badge variant="gray">prior</Badge>;
  if (role === 'active') return <Badge variant="blue">active</Badge>;
  return <Badge variant="purple">after</Badge>;
}

function isCaseRelated(type: string | null): boolean {
  if (!type) return false;
  return type.startsWith('case.') || type.startsWith('disputes.');
}

function DialogueGroup({
  dialogue,
  showBot,
}: {
  dialogue: DialogueRecord;
  showBot: boolean;
}) {
  const [open, setOpen] = useState(true);
  const c = dialogue.messageCounts;
  // Case-workflow dialogues (attached + case.*/disputes.*) are part of the dispute itself;
  // always show their full message stream regardless of the bot toggle.
  const showAll = showBot || dialogue.attached || isCaseRelated(dialogue.type);

  const visibleMessages = useMemo(
    () => (showAll ? dialogue.messages : dialogue.messages.filter((m) => m.senderType !== 'bot')),
    [dialogue.messages, showAll]
  );
  const empty = visibleMessages.length === 0;

  return (
    <section className="rounded-lg border border-gray-200 bg-white">
      <button
        type="button"
        onClick={() => !empty && setOpen((v) => !v)}
        disabled={empty}
        className={cn(
          'flex w-full items-center gap-3 px-4 py-3 text-left',
          !empty && 'cursor-pointer hover:bg-gray-50',
          empty && 'cursor-default'
        )}
      >
        {!empty &&
          (open ? (
            <ChevronDown className="h-4 w-4 text-gray-500" />
          ) : (
            <ChevronRight className="h-4 w-4 text-gray-500" />
          ))}
        {empty && <span className="h-4 w-4" />}
        <span className="font-mono text-sm text-gray-900">#{dialogue.id}</span>
        <span className="text-sm text-muted-foreground">{dialogue.type || 'unknown'}</span>
        {roleBadge(dialogue.dialogueRole)}
        {dialogue.attached && <Badge variant="green">attached</Badge>}
        {dialogue.lastAgentName && (
          <span className="text-xs text-muted-foreground">· {dialogue.lastAgentName}</span>
        )}
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {visibleMessages.length} msg · {c.customer}c / {c.operator}o
          {showAll && ` / ${c.bot}b`}
        </span>
        <span className="text-xs text-muted-foreground">{formatDate(dialogue.createdAt)}</span>
      </button>

      {!empty && open && (
        <div className="flex flex-col gap-3 border-t border-gray-100 px-4 py-4">
          {visibleMessages.map((m, i) => (
            <MessageBubble key={`${m.timestamp}-${m.messageNum ?? i}`} message={m} />
          ))}
        </div>
      )}
    </section>
  );
}

export function MessagesTab({ bundle }: MessagesTabProps) {
  const [showBot, setShowBot] = useState(false);

  if (bundle.dialogues.length === 0) {
    return <p className="text-sm text-muted-foreground">No dialogues exported for this alias yet.</p>;
  }

  // Hide pure-noise dialogues (bot-only AND not part of the case workflow) when showBot is off.
  // Attached dialogues + case.*/disputes.* types are always shown — they ARE the case.
  const visibleDialogues = bundle.dialogues.filter((d) => {
    if (d.messages.length === 0) return false;
    if (showBot) return true;
    if (d.attached || isCaseRelated(d.type)) return true;
    return d.messageCounts.customer + d.messageCounts.operator > 0;
  });

  const visibleMessageCount = visibleDialogues.reduce((sum, d) => {
    if (showBot || d.attached || isCaseRelated(d.type)) return sum + d.messages.length;
    return sum + d.messageCounts.customer + d.messageCounts.operator;
  }, 0);

  const totalBot = bundle.dialogues.reduce((sum, d) => sum + d.messageCounts.bot, 0);
  const hiddenDialogueCount = bundle.dialogues.length - visibleDialogues.length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {visibleMessageCount} messages across {visibleDialogues.length} dialogues
          {!showBot && hiddenDialogueCount > 0 && (
            <> · {hiddenDialogueCount} bot-only dialogues hidden</>
          )}
        </p>
        <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-gray-700">
          <input
            type="checkbox"
            checked={showBot}
            onChange={(e) => setShowBot(e.target.checked)}
            className="h-3.5 w-3.5 cursor-pointer"
          />
          Show bot/system messages
          {totalBot > 0 && <span className="text-muted-foreground">({totalBot})</span>}
        </label>
      </div>

      {visibleDialogues.length === 0 ? (
        <p className="rounded-md border border-dashed border-gray-300 p-6 text-center text-sm text-muted-foreground">
          No customer/operator messages in this case. All {totalBot} messages are bot/system —
          enable the toggle above to view them.
        </p>
      ) : (
        visibleDialogues.map((d) => <DialogueGroup key={d.id} dialogue={d} showBot={showBot} />)
      )}
    </div>
  );
}

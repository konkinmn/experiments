import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import type { CaseBundle } from '@/types';

interface DialoguesTabProps {
  bundle: CaseBundle;
  onSelectDialogue: (dialogueId: string) => void;
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

export function DialoguesTab({ bundle, onSelectDialogue }: DialoguesTabProps) {
  if (bundle.dialogues.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No dialogues found for this alias around case creation.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Dialogue</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Last agent</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Attached</TableHead>
          <TableHead className="text-right">Messages</TableHead>
          <TableHead>Created</TableHead>
          <TableHead>Closed</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {bundle.dialogues.map((d) => (
          <TableRow
            key={d.id}
            className="cursor-pointer hover:bg-muted/40"
            onClick={() => onSelectDialogue(d.id)}
          >
            <TableCell className="font-mono text-sm">#{d.id}</TableCell>
            <TableCell className="text-sm">{d.type || '—'}</TableCell>
            <TableCell className="text-sm">{d.status ? <Badge variant="gray">{d.status}</Badge> : '—'}</TableCell>
            <TableCell className="text-sm">{d.lastAgentName || d.lastAgent || '—'}</TableCell>
            <TableCell>{roleBadge(d.dialogueRole)}</TableCell>
            <TableCell>{d.attached ? <Badge variant="green">yes</Badge> : <span className="text-muted-foreground">—</span>}</TableCell>
            <TableCell className="text-right text-sm tabular-nums">
              <span className="text-gray-900">{d.messages.length}</span>
              <span className="ml-2 text-xs text-muted-foreground">
                {d.messageCounts.customer}c · {d.messageCounts.operator}o · {d.messageCounts.bot}b
              </span>
            </TableCell>
            <TableCell className="text-sm text-muted-foreground">{formatDate(d.createdAt)}</TableCell>
            <TableCell className="text-sm text-muted-foreground">{formatDate(d.closedAt)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

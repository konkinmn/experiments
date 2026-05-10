import { ArrowUp, ArrowDown, ExternalLink } from 'lucide-react';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import type { CaseBrowserItem, CaseBrowserSortField } from '@/types';

interface CaseBrowserTableProps {
  data: CaseBrowserItem[];
  loading?: boolean;
  sortField: CaseBrowserSortField;
  sortOrder: 'asc' | 'desc';
  onSort: (field: CaseBrowserSortField) => void;
  onRowClick: (item: CaseBrowserItem) => void;
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
}

function formatDate(dateString: string | null): string {
  if (!dateString) return '—';
  return new Date(dateString).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function buildWorkstationUrl(alias: string, caseId: string): string {
  return `https://chat-workstation.k1.anna.money/${alias}/tasks/cases?chatWindow=chat&caseId=${caseId}`;
}

function statusBadge(status: string) {
  if (status === 'IN_PROGRESS') return <Badge variant="blue">In progress</Badge>;
  if (status === 'RESOLVED') return <Badge variant="green">Resolved</Badge>;
  if (status === 'DISMISSED') return <Badge variant="gray">Dismissed</Badge>;
  return <Badge variant="gray">{status}</Badge>;
}

function decisionBadge(decision: string | null) {
  if (!decision) return <span className="text-muted-foreground">—</span>;
  const key = decision.toUpperCase();
  if (key === 'CREDIT') return <Badge variant="green">Credit</Badge>;
  if (key === 'ESCALATE') return <Badge variant="amber">Escalate</Badge>;
  return <Badge variant="gray">{decision}</Badge>;
}

function riskBadge(riskLevel: string | null) {
  if (!riskLevel) return <span className="text-muted-foreground">—</span>;
  const key = riskLevel.toLowerCase();
  if (key === 'green') return <Badge variant="green">Green</Badge>;
  if (key === 'amber') return <Badge variant="amber">Amber</Badge>;
  if (key === 'red') return <Badge variant="red">Red</Badge>;
  return <Badge variant="gray">{riskLevel}</Badge>;
}

function SortHeader({
  label,
  field,
  sortField,
  sortOrder,
  onSort,
}: {
  label: string;
  field: CaseBrowserSortField;
  sortField: CaseBrowserSortField;
  sortOrder: 'asc' | 'desc';
  onSort: (field: CaseBrowserSortField) => void;
}) {
  return (
    <TableHead className="cursor-pointer select-none hover:bg-muted/50" onClick={() => onSort(field)}>
      <span className="flex items-center gap-1">
        {label}
        {sortField === field &&
          (sortOrder === 'asc' ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />)}
      </span>
    </TableHead>
  );
}

export function CaseBrowserTable({
  data,
  loading,
  sortField,
  sortOrder,
  onSort,
  onRowClick,
  selected,
  onToggleSelect,
  onToggleSelectAll,
}: CaseBrowserTableProps) {
  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-muted-foreground">
        No cases match your filters
      </div>
    );
  }

  const allSelected = data.every((d) => selected.has(d.id));
  const someSelected = data.some((d) => selected.has(d.id));

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-10">
            <input
              type="checkbox"
              aria-label="Select all on page"
              checked={allSelected}
              ref={(el) => {
                if (el) el.indeterminate = !allSelected && someSelected;
              }}
              onChange={onToggleSelectAll}
              className="h-4 w-4 cursor-pointer"
            />
          </TableHead>
          <SortHeader label="Ref ID" field="refId" sortField={sortField} sortOrder={sortOrder} onSort={onSort} />
          <TableHead>Alias</TableHead>
          <TableHead>Issue</TableHead>
          <SortHeader label="Status" field="status" sortField={sortField} sortOrder={sortOrder} onSort={onSort} />
          <TableHead>Outcome</TableHead>
          <TableHead>Decision</TableHead>
          <TableHead>Risk</TableHead>
          <SortHeader label="Score" field="riskScore" sortField={sortField} sortOrder={sortOrder} onSort={onSort} />
          <SortHeader label="Created" field="createdAt" sortField={sortField} sortOrder={sortOrder} onSort={onSort} />
          <TableHead></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((item) => (
          <TableRow
            key={item.id}
            className="cursor-pointer hover:bg-muted/40"
            onClick={() => onRowClick(item)}
          >
            <TableCell onClick={(e) => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={selected.has(item.id)}
                onChange={() => onToggleSelect(item.id)}
                className="h-4 w-4 cursor-pointer"
                aria-label={`Select case ${item.refId ?? item.id}`}
              />
            </TableCell>
            <TableCell className="font-mono text-sm">{item.refId || `#${item.id}`}</TableCell>
            <TableCell className="text-sm font-semibold">{item.alias || '—'}</TableCell>
            <TableCell className="text-sm">
              {item.issueType ? <Badge variant="gray">{item.issueType}</Badge> : '—'}
            </TableCell>
            <TableCell>{statusBadge(item.status)}</TableCell>
            <TableCell className="text-sm">
              {item.outcome ? <span className="text-muted-foreground">{item.outcome}</span> : '—'}
            </TableCell>
            <TableCell>{decisionBadge(item.decision)}</TableCell>
            <TableCell>{riskBadge(item.riskLevel)}</TableCell>
            <TableCell className="text-sm">{item.riskScore != null ? item.riskScore : '—'}</TableCell>
            <TableCell className="text-sm text-muted-foreground">{formatDate(item.createdAt)}</TableCell>
            <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
              {item.alias ? (
                <a
                  href={buildWorkstationUrl(item.alias, item.id)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                >
                  WS
                  <ExternalLink className="h-3 w-3" />
                </a>
              ) : (
                '—'
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

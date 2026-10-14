import { ExternalLink } from 'lucide-react';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import type { ThreadRow } from '@/types';
import { StateBadge } from './StateBadge';
import { oneLine, shortId, wsCustomerLink } from './format';

interface ThreadsTableProps {
  rows: ThreadRow[];
  loading?: boolean;
  /**
   * Whether to show the Gemma scenario a thread was selected by. Off once the page is
   * scoped to one scenario: every row would then repeat the same words.
   */
  showScenario: boolean;
  onRowClick: (row: ThreadRow) => void;
}

/**
 * The payment cell. `identifiedSummary` is the backend's sentence; without it
 * the row still says which payment was picked, from the pass-1 fields that
 * have always been there.
 */
function paymentText(r: ThreadRow): string {
  if (r.identifiedSummary) return oneLine(r.identifiedSummary);
  if (r.pass1?.identifiedId) {
    const kind = r.pass1.identifiedKind ? `${r.pass1.identifiedKind} ` : '';
    return `${kind}${shortId(r.pass1.identifiedId, 12)}`;
  }
  if (r.pass1?.state === 'NOT_FOUND') return 'no payment found';
  return '—';
}

export function ThreadsTable({ rows, loading, showScenario, onRowClick }: ThreadsTableProps) {
  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="pc-dim py-10 text-center text-[15px]">
        No threads match this filter — clear it to see the whole run.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table className="table-fixed border-collapse">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="pc-dim h-9 w-9 px-2 text-[13px] font-normal" />
            <TableHead className="pc-dim h-9 w-48 px-3 text-[13px] font-normal">Problem</TableHead>
            {showScenario && (
              <TableHead className="pc-dim h-9 w-44 px-3 text-[13px] font-normal">
                Scenario
              </TableHead>
            )}
            <TableHead className="pc-dim h-9 px-3 text-[13px] font-normal">What happened</TableHead>
            <TableHead className="pc-dim h-9 w-40 px-3 text-[13px] font-normal">Payment</TableHead>
            <TableHead className="pc-dim h-9 w-32 px-3 text-[13px] font-normal">
              Payment found?
            </TableHead>
            <TableHead className="pc-dim h-9 w-28 px-3 text-[13px] font-normal">Thread</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {/* Row order is the order the API returned — no client-side re-sort. */}
          {rows.map((r) => {
            const href = r.wsLink || wsCustomerLink(r.customerAlias);
            const whatHappened = oneLine(r.whatHappened);
            return (
              <TableRow
                key={r.threadId}
                tabIndex={0}
                className="pc-focus pc-band cursor-pointer hover:bg-[var(--pc-shade)]"
                onClick={() => onRowClick(r)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onRowClick(r);
                  }
                }}
              >
                <TableCell className="p-2 pl-2 align-top">
                  {href ? (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      title={
                        r.wsLink
                          ? 'Open this thread in Workstation'
                          : 'Open this customer in Workstation'
                      }
                      className="pc-focus pc-dim inline-flex rounded p-1 hover:text-primary"
                      aria-label="Open in Workstation"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  ) : (
                    <span className="pc-dim pl-1">—</span>
                  )}
                </TableCell>
                <TableCell className="p-3 align-top text-[13px]">
                  <span className="block truncate" title={r.pass3Category ?? undefined}>
                    {r.pass3Category ?? '—'}
                  </span>
                </TableCell>
                {/* The Gemma leaf the thread was selected by — not the induced problem. */}
                {showScenario && (
                  <TableCell className="pc-dim p-3 align-top text-[13px]">
                    <span className="block truncate" title={r.category}>
                      {r.category || '—'}
                    </span>
                  </TableCell>
                )}
                <TableCell className="p-3 align-top text-[15px]">
                  <span className="block truncate" title={whatHappened || undefined}>
                    {whatHappened || '—'}
                  </span>
                </TableCell>
                <TableCell className="pc-dim p-3 align-top text-[13px]">
                  <span className="block truncate" title={paymentText(r)}>
                    {paymentText(r)}
                  </span>
                </TableCell>
                <TableCell className="p-3 align-top">
                  <StateBadge state={r.pass1?.state} />
                </TableCell>
                <TableCell
                  className="pc-dim pc-tnum truncate p-3 align-top text-[13px]"
                  title={r.threadId}
                >
                  {r.threadId}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

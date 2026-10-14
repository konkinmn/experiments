import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import type { ThreadDetail } from '@/types';

function Disclosure({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-gray-200">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-gray-900 hover:bg-gray-50"
      >
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        {title}
        {meta && <span className="ml-auto text-xs font-normal text-muted-foreground">{meta}</span>}
      </button>
      {open && <div className="border-t border-gray-200 p-3">{children}</div>}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="pc-dim text-[13px]">{label}</p>
      <p className="text-[15px]">{value}</p>
    </div>
  );
}

function list(values: string[] | null | undefined): string {
  if (!values || values.length === 0) return '—';
  return values.join(', ');
}

function reasonsText(reasons: string[] | string | null): string {
  if (!reasons) return '—';
  return Array.isArray(reasons) ? reasons.join('; ') : reasons;
}

/** Everything a reader only wants when they distrust the reading above. */
export function DetailsTab({ detail }: { detail: ThreadDetail }) {
  const pass1 = detail.pass1;
  const ex = pass1?.extraction;
  const amounts =
    ex?.amounts && ex.amounts.length > 0
      ? ex.amounts.map((a) => `${a.value ?? '?'} ${a.currency ?? ''}`.trim()).join(', ')
      : '—';

  return (
    <div className="space-y-3">
      <Disclosure title="How pass 1 picked the payment">
        {pass1 ? (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Explicit ids" value={list(ex?.explicit_ids)} />
              <Field label="Amounts" value={amounts} />
              <Field label="Counterparties" value={list(ex?.counterparties)} />
              <Field label="Direction" value={ex?.direction ?? '—'} />
              <Field label="Dates" value={list(ex?.dates)} />
              <Field
                label="No payment discussed"
                value={
                  ex?.no_payment_discussed == null ? '—' : ex.no_payment_discussed ? 'yes' : 'no'
                }
              />
            </div>
            {pass1.shortlist && pass1.shortlist.rows.length > 0 ? (
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="h-9 px-3">Handle</TableHead>
                      <TableHead className="h-9 px-3">Id</TableHead>
                      <TableHead className="h-9 px-3">Kind</TableHead>
                      <TableHead className="h-9 px-3">Reasons</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pass1.shortlist.rows.map((r, i) => (
                      <TableRow key={`${r.handle}-${i}`}>
                        <TableCell className="p-3 font-mono text-xs">{r.handle}</TableCell>
                        <TableCell className="p-3 font-mono text-xs">{r.id ?? '—'}</TableCell>
                        <TableCell className="p-3 text-xs">{r.kind ?? '—'}</TableCell>
                        <TableCell className="p-3 text-xs text-gray-700">
                          {reasonsText(r.reasons)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">The shortlist was empty.</p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Pass 1 has not run for this thread.</p>
        )}
      </Disclosure>

      <Disclosure title="Why pass 3 chose this problem">
        {detail.pass3 ? (
          <div className="space-y-2">
            <p className="text-sm font-medium text-gray-900">
              {detail.pass3.category ?? 'unassigned'}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                label {detail.pass3.label}
              </span>
            </p>
            <p className="max-w-prose whitespace-pre-wrap text-sm leading-relaxed text-gray-800">
              {detail.pass3.reason ?? 'The induction returned no reason for this thread.'}
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Pass 3 has not run for this thread.</p>
        )}
      </Disclosure>

      <Disclosure
        title="What pass 1 was shown"
        meta={`${(detail.renderedExtract ?? '').length.toLocaleString('en-GB')} chars`}
      >
        <pre className="max-h-[32rem] overflow-auto bg-gray-50 p-3 font-mono text-xs leading-relaxed">
          {detail.renderedExtract ?? ''}
        </pre>
      </Disclosure>

      <Disclosure
        title="What pass 2 was shown"
        meta={`${(detail.renderedRead ?? '').length.toLocaleString('en-GB')} chars`}
      >
        <pre className="max-h-[32rem] overflow-auto bg-gray-50 p-3 font-mono text-xs leading-relaxed">
          {detail.renderedRead ?? ''}
        </pre>
      </Disclosure>
    </div>
  );
}

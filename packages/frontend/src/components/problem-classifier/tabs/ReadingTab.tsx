import type { ReactNode } from 'react';
import type { ThreadDetail, ThreadRow } from '@/types';
import { ReadingProse } from '../ReadingProse';
import { paymentFoundWord } from '../StateBadge';
import { oneLine } from '../format';

interface ReadingTabProps {
  detail: ThreadDetail;
  /** The table row, when the drawer was opened from it — carries the summary. */
  row: ThreadRow | null;
}

/** The identified payment, in the plainest form the data allows. */
function paymentLine(detail: ThreadDetail, row: ThreadRow | null): string {
  if (row?.identifiedSummary) return oneLine(row.identifiedSummary);
  const identified = detail.pass1?.identified;
  if (identified) return `${identified.kind ?? 'payment'} ${identified.id}`;
  return 'No payment found in this thread.';
}

/** One row of the payment list, on the same label grid as the reading above. */
function Entry({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="pc-labelled">
      <dt className="pc-dim pt-0.5 text-[13px]">{label}</dt>
      <dd className="max-w-[68ch] text-[15px]">{children}</dd>
    </div>
  );
}

export function ReadingTab({ detail, row }: ReadingTabProps) {
  const found = paymentFoundWord(detail.pass1?.state);
  const why = detail.pass1?.pick?.why;
  const confidence = detail.pass1?.pick?.confidence;

  return (
    <div className="space-y-10">
      <section>
        {detail.pass2 ? (
          <ReadingProse text={detail.pass2.reading} />
        ) : (
          <p className="pc-dim text-[15px]">Pass 2 has not read this thread yet.</p>
        )}
      </section>

      <dl className="space-y-4 border-t border-[var(--pc-line)] pt-6">
        <Entry label="Payment found">{found ?? '—'}</Entry>
        <Entry label="Payment">{paymentLine(detail, row)}</Entry>
        {why && (
          <Entry label="Why this one">
            {why}
            {confidence ? ` (${confidence} confidence)` : ''}
          </Entry>
        )}
        {!detail.pass1 && (
          <Entry label="Payment found">
            <span className="pc-dim">Pass 1 has not run for this thread.</span>
          </Entry>
        )}
      </dl>
    </div>
  );
}

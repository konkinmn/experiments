import type { Pass1State } from '@/types';

/**
 * Pass 1 answers one reader-facing question: was the payment the customer was
 * talking about found? These are the words for its four answers — the state
 * names themselves are pipeline vocabulary and stay out of the reader's way.
 */
export const PAYMENT_FOUND_WORDS: Record<Pass1State, string> = {
  RESOLVED: 'yes',
  ORDER_ONLY: 'order only',
  NOT_FOUND: 'no',
  UNRESOLVED_HANDLE: 'unclear',
};

export function paymentFoundWord(state: string | null | undefined): string | null {
  if (!state) return null;
  return PAYMENT_FOUND_WORDS[state as Pass1State] ?? state.toLowerCase().replace(/_/g, ' ');
}

/**
 * All greys, no accent and no red/green: "no" is a legitimate answer, not a
 * failure, and the answer is not the point of the row.
 */
export function StateBadge({ state }: { state: string | null | undefined }) {
  const word = paymentFoundWord(state);
  if (!word) return <span className="pc-dim">—</span>;
  return (
    <span className="pc-dim inline-flex items-center whitespace-nowrap rounded-full bg-[var(--pc-shade)] px-2 py-0.5 text-[13px]">
      {word}
    </span>
  );
}

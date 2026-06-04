/**
 * KB-grounded process catalog for the Queue Analyser (v3).
 *
 * Each entry is a known payments work-type distilled from anna-knowledge-base
 * (paths in `kb_refs`, relative to anna-knowledge-base/kb/UK/). The catalog is the
 * authoritative process layer: it supplies the canonical action, destination, SLA,
 * and the two priority axes — urgency (how much the customer is waiting) and
 * quick_win (how little effort to clear) — so these are correct and reproducible
 * rather than the LLM's guess. The LLM only maps each task to a `kind` (+ proposes
 * new emergent kinds for anything unmatched) and sets a per-task status.
 *
 * Source: 2026-06-04 SJ review + KB. Linchpin SLA doc:
 * business_account/task_management_payments_team.md.
 */

export type Urgency = 'high' | 'medium' | 'low';

export type Disposition =
  | 'return_to_crown'
  | 'send_to_practitioner'
  | 'investigate'
  | 'chase_customer'
  | 'recover'
  | 'consolidate'
  | 'safe_close'
  | 'reroute';

export interface ProcessType {
  kind: string;
  name: string;
  /** Short cue that helps the LLM recognise this work-type from a task. */
  match_hint: string;
  /** Canonical action (from the KB). */
  the_work: string;
  /** Where it goes / who actions it. */
  destination: string | null;
  disposition: Disposition;
  /** Axis 1 — customer-waiting / SLA pressure. */
  urgency: Urgency;
  /** Axis 2 — low effort to clear. */
  quick_win: boolean;
  /** Chase/close SLA in days (task_management_payments_team.md); null = no SLA pressure. */
  sla_days: number | null;
  /** What makes it actionable now (Angela's "ready to raise"). */
  ready_criteria: string | null;
  /** Queue group names this work-type belongs in; ['*'] = any. Drives wrong-queue detection. */
  belongs_to_queues: string[];
  kb_refs: string[];
}

const PAS = 'Payments Account Support';

export const PROCESS_CATALOG: ProcessType[] = [
  {
    kind: 'dissolved_to_crown',
    name: 'Dissolved company with residual balance → return to Crown',
    match_hint: 'company dissolved / struck-off (compulsory or voluntary) and the account still holds funds',
    the_work:
      'Return the residual balance to the Crown (Bona Vacantia). Account is blocked; empty funds then close after a 2-day bounce-back wait.',
    destination:
      'Crown Nominee Account (England & Wales): sort 60-70-80, acct 10004467, ref = CRN + company name (18 chars). Check postcode for Duchy of Cornwall/Lancaster jurisdiction.',
    disposition: 'return_to_crown',
    urgency: 'low', // SJ: funds aren't going anywhere — quick but not urgent
    quick_win: true,
    sla_days: null,
    ready_criteria: 'Account emptied & blocked; company registration number (CRN) known',
    belongs_to_queues: [PAS],
    kb_refs: [
      'business_account/accounts/crown_nominee_account.md',
      'chatters_essentials/dissolved_businesses.md',
      'business_account/accounts/account_closure_process_for_payments_team.md',
    ],
  },
  {
    kind: 'liquidation_to_practitioner',
    name: 'Liquidation / administration → send funds to the practitioner',
    match_hint: 'company in liquidation or administration (insolvency letter/email); funds remain',
    the_work:
      'Block the account, raise to HQ Cardiff Admin (title "insolvency"), request the liquidator/administrator bank details, then send funds. Send the customer the insolvency banner.',
    destination:
      'Liquidator / administrator (request bank details). Funds < £2,000 → Payments Account Support; > £2,000 → BAS Handover.',
    disposition: 'send_to_practitioner',
    urgency: 'medium',
    quick_win: false,
    sla_days: null,
    ready_criteria: 'Liquidator/administrator bank details received',
    belongs_to_queues: [PAS],
    kb_refs: ['compliance/insolvency_emails_letters.md'],
  },
  {
    kind: 'missing_intl_payment',
    name: 'Missing / delayed international payment',
    match_hint: 'missing or delayed inbound/outbound SWIFT/SEPA payment; GPI tracker or MT103 mentioned',
    the_work:
      'Investigate the missing INTL payment. Need MT103 + GPI tracker; check ANNA IBAN/BIC correct. SWIFT ≤5 working days, SEPA ≤2. Recalls → Scam Squad (fraud) / Retrievals (non-fraud).',
    destination: 'Investigate; request MT103 + GPI tracker from the sending bank',
    disposition: 'investigate',
    urgency: 'high', // SJ: customer is waiting on their money
    quick_win: false,
    sla_days: 4,
    ready_criteria: 'MT103 + GPI tracker present and ANNA IBAN/BIC confirmed correct',
    belongs_to_queues: [PAS, 'Retrievals'],
    kb_refs: [
      'business_account/international_payments/receiving_international_payments.md',
      'business_account/international_payments/payments_team/recalling_swift_sepa_payments.md',
    ],
  },
  {
    kind: 'pos_card_decline',
    name: 'POS / card decline',
    match_hint: 'declined card/POS payment, 3DS failure, BIN issue, contactless/SCA',
    the_work:
      'Identify the decline reason in GPS/Cardinal and advise the customer. 3DS authenticated but declined → check GPS reason; wrong 3DS code ×3 → Advanced Payments Team to unblock in Cardinal.',
    destination: 'Check GPS/Cardinal decline reason; 3DS×3 lockout → Advanced Payments Team',
    disposition: 'investigate',
    urgency: 'medium',
    quick_win: true,
    sla_days: 4,
    ready_criteria: 'Decline reason identified (time, card last 4, merchant, amount captured)',
    belongs_to_queues: [PAS],
    kb_refs: [
      'business_account/cards/declines_on_the_debit_card.md',
      'business_account/cards/what_is_3ds.md',
    ],
  },
  {
    kind: 'retrieval_request',
    name: 'Retrieval request (Faster Payments / SWIFT)',
    match_hint: 'customer wants funds back from a payment sent to wrong/closed details; retrieval/recall',
    the_work:
      'Raise a retrieval to Railsr. Up to 36 months back, min £25, claim within ~2 months of payment. Gather transaction details, recipient relationship, correct details. When all info present, mark ready to raise.',
    destination: 'Raise retrieval to Railsr (retrieval form)',
    disposition: 'investigate',
    urgency: 'medium',
    quick_win: true,
    sla_days: 4,
    ready_criteria: 'Transaction details (FPID/SWIFT), recipient relationship, and intended account details all present',
    belongs_to_queues: ['Retrievals', PAS],
    kb_refs: ['business_account/local_payments/payments_team/retrievals_process.md'],
  },
  {
    kind: 'negative_balance',
    name: 'Negative balance recovery',
    match_hint: 'account in negative balance / debt recovery',
    the_work:
      'Auto-chased for 42 days; if unresolved, raise a chargeback to Railsr (schedule 2 wd to confirm) or write off. Never use the word "overdrawn".',
    destination: '42-day auto-chase, then chargeback to Railsr',
    disposition: 'recover',
    urgency: 'medium',
    quick_win: false,
    sla_days: 42,
    ready_criteria: null,
    belongs_to_queues: ['Negative Balance'],
    kb_refs: ['business_account/cards/payments_team/negative_balances.md'],
  },
  {
    kind: 'closed_account_return',
    name: 'Payment sent to a closed account',
    match_hint: 'payment sent to a closed recipient account; awaiting auto-return',
    the_work:
      'Auto-returns within ≤3 working days. If not returned, give the customer the payment reference to share with the recipient bank; escalate to a retrieval if needed.',
    destination: 'Auto-return ≤3 wd; else payment reference / retrieval',
    disposition: 'investigate',
    urgency: 'medium',
    quick_win: true,
    sla_days: 4,
    ready_criteria: null,
    belongs_to_queues: [PAS, 'Return funds to source', 'Retrievals'],
    kb_refs: [
      'business_account/local_payments/how_to_help_when_a_payment_is_sent_from_anna_to_a_closed_account.md',
    ],
  },
  {
    kind: 'fund_return_to_source',
    name: 'Return funds to source',
    match_hint: 'returning funds to the original sender / source account',
    the_work: 'Return the funds to source; sync the Railsr ticket to Workstation and chase every 2 working days.',
    destination: 'Return to source / Railsr',
    disposition: 'investigate',
    urgency: 'medium',
    quick_win: false,
    sla_days: 4,
    ready_criteria: null,
    belongs_to_queues: ['Return funds to source', PAS],
    kb_refs: ['business_account/task_management_payments_team.md'],
  },
  {
    kind: 'dd_indemnity',
    name: 'Direct debit indemnity claim',
    match_hint: 'direct debit indemnity claim',
    the_work: 'Work the DD indemnity claim; chase the customer on day 3, close day 4 if no reply.',
    destination: 'DD indemnity process',
    disposition: 'investigate',
    urgency: 'medium',
    quick_win: false,
    sla_days: 4,
    ready_criteria: null,
    belongs_to_queues: ['DD Indemnity Claims', PAS],
    kb_refs: ['business_account/task_management_payments_team.md'],
  },
  {
    kind: 'consolidate_duplicates',
    name: 'Multiple tasks on the same account — consolidate',
    match_hint: 'more than one open task on the same alias/account',
    the_work: 'Review the tasks on this account together and de-duplicate; work as one.',
    destination: null,
    disposition: 'consolidate',
    urgency: 'medium',
    quick_win: false,
    sla_days: null,
    ready_criteria: null,
    belongs_to_queues: ['*'],
    kb_refs: [],
  },
  {
    kind: 'safe_close',
    name: 'Empty account, cases done — safe close',
    match_hint: 'balance ~0 and all linked cases resolved/dismissed; nothing outstanding',
    the_work: 'Close — "Dismissed: case not required". Balance is ~0 and cases are resolved/dismissed.',
    destination: 'Close (Dismissed: case not required)',
    disposition: 'safe_close',
    urgency: 'low',
    quick_win: true,
    sla_days: null,
    ready_criteria: null,
    belongs_to_queues: ['*'],
    kb_refs: ['business_account/task_management_payments_team.md'],
  },
  {
    kind: 'reroute_other_team',
    name: 'Belongs to another team — reroute',
    match_hint: 'dispute/chargeback, fraud, FOS complaint, compliance/KYB, or another team\'s work',
    the_work: 'Reroute to the owning team (disputes, fraud/scam, compliance/KYB, etc.).',
    destination: 'Reroute to the owning team',
    disposition: 'reroute',
    urgency: 'medium',
    quick_win: false,
    sla_days: null,
    ready_criteria: null,
    belongs_to_queues: ['*'],
    kb_refs: [],
  },
];

const CATALOG_BY_KIND = new Map(PROCESS_CATALOG.map((p) => [p.kind, p]));

export function getProcessType(kind: string): ProcessType | undefined {
  return CATALOG_BY_KIND.get(kind);
}

export const CATALOG_KINDS = PROCESS_CATALOG.map((p) => p.kind);

/** Compact catalog for the LLM define/assign prompts (no authoritative fields — those stay server-side). */
export function catalogForPrompt(): string {
  return PROCESS_CATALOG.map((p) => `${p.kind} | ${p.name} | ${p.match_hint}`).join('\n');
}

/** Wrong-queue check: is this kind in-scope for the given queue group? */
export function isWrongQueue(kind: string, queueName: string): { wrong: boolean; suggested: string | null } {
  const p = CATALOG_BY_KIND.get(kind);
  if (!p || p.belongs_to_queues.includes('*')) return { wrong: false, suggested: null };
  if (p.belongs_to_queues.includes(queueName)) return { wrong: false, suggested: null };
  return { wrong: true, suggested: p.belongs_to_queues[0] ?? null };
}

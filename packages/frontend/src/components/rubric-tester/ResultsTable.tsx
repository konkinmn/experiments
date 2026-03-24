import { useState } from 'react';
import { ChevronDown, ChevronRight, Trash2, Check, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { PipelineResult, RiskLevel, CaseSignalsRaw } from '@/types';

interface ResultsTableProps {
  results: PipelineResult[];
  onDelete?: (id: number) => void;
  onReview?: (id: number, verdict: 'correct' | 'incorrect', notes?: string) => void;
}

const RISK_BADGE: Record<RiskLevel, { label: string; variant: 'green' | 'amber' | 'red' }> = {
  green: { label: 'Green', variant: 'green' },
  amber: { label: 'Amber', variant: 'amber' },
  red: { label: 'Red', variant: 'red' },
};

const DECISION_BADGE: Record<string, { label: string; variant: 'green' | 'amber' | 'red' }> = {
  credit: { label: 'Credit', variant: 'green' },
  escalate_to_agent: { label: 'Escalate', variant: 'amber' },
};

const HARD_GATE_LABELS: Record<string, string> = {
  cifas: 'CIFAS marker',
  railsr_dispute_last_6_months: 'Railsr dispute (6m)',
  confirmed_scammer: 'Confirmed scammer',
  account_not_active: 'Account inactive',
};

const RAW_SIGNAL_LABELS: Record<keyof CaseSignalsRaw, string> = {
  case_id: 'Case ID',
  company_id: 'Company ID',
  alias: 'Alias',
  case_created_at: 'Case Created',
  total_amount: 'Total Amount',
  max_transaction_amount: 'Max Transaction Amount',
  merchants: 'Merchants',
  account_age_days: 'Account Age (days)',
  account_status: 'Account Status',
  cifas_count: 'CIFAS Count',
  tier_name: 'Tier',
  is_money_maker: 'Money Maker',
  trust_score: 'Trust Score',
  scammer_count: 'Scammer Count',
  scam_victim_count: 'Scam Victim Count',
  tx_count_90_days: 'Txns (90 days)',
  active_months: 'Active Months',
  prior_payments_to_merchant: 'Prior Payments to Merchant',
  railsr_disputes_last_6_months: 'Railsr Disputes (6 months)',
  railsr_disputes_last_30_days: 'Railsr Disputes (30 days)',
};

function SignalRow({ label, value, pts }: { label: string; value: string; pts?: number }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-2">
        <span className="font-medium truncate max-w-[180px]">{value}</span>
        {pts !== undefined && (
          <span className={`text-xs font-mono w-10 text-right ${pts > 0 ? 'text-green-600' : pts < 0 ? 'text-red-600' : 'text-gray-400'}`}>
            {pts > 0 ? `+${pts}` : pts < 0 ? String(pts) : '0'}
          </span>
        )}
      </span>
    </div>
  );
}

function formatSignalValue(value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'object') {
    // BQ Timestamp objects have a `value` property
    if ('value' in value && typeof (value as { value: unknown }).value === 'string') {
      return (value as { value: string }).value;
    }
    return JSON.stringify(value);
  }
  return String(value);
}

export function ResultsTable({ results, onDelete, onReview }: ResultsTableProps) {
  if (results.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-sm text-muted-foreground">
        No pipeline runs yet. Enter a Case ID above and click Run.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {results.map((r) => {
        const risk = RISK_BADGE[r.disputeProfile.risk_level];
        const decision = r.hardGateTriggered
          ? { label: HARD_GATE_LABELS[r.hardGateTriggered] ?? r.hardGateTriggered, variant: 'red' as const }
          : DECISION_BADGE[r.plannerOutput?.decision ?? 'escalate_to_agent'];

        return (
          <div key={r.id} className="rounded-lg border border-gray-200 bg-white">
            {/* Card header */}
            <div className="flex items-center gap-8 px-5 py-4">
              <div className="min-w-0">
                <span className="text-xs text-muted-foreground">Case</span>
                <p className="font-mono text-lg font-bold">{r.caseId}</p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Risk</span>
                <div className="mt-1">
                  <Badge variant={risk.variant}>{risk.label}</Badge>
                </div>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Decision</span>
                <div className="mt-1">
                  <Badge variant={decision.variant}>{decision.label}</Badge>
                </div>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Duration</span>
                <p className="text-sm mt-1">{(r.pipelineDurationMs / 1000).toFixed(1)}s</p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Verdict</span>
                <div className="mt-1">
                  {r.reviewerVerdict === 'correct' && <Badge variant="green">Correct</Badge>}
                  {r.reviewerVerdict === 'incorrect' && <Badge variant="red">Incorrect</Badge>}
                  {!r.reviewerVerdict && <span className="text-sm text-muted-foreground">Pending</span>}
                </div>
              </div>
              {onDelete && (
                <div className="ml-auto">
                  <button
                    className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-red-500 transition-colors"
                    onClick={() => onDelete(r.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>
            {/* Card body */}
            <div className="border-t px-5 py-4">
              <ExpandedDetail result={r} onReview={onReview} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ExpandedDetail({
  result,
  onReview,
}: {
  result: PipelineResult;
  onReview?: (id: number, verdict: 'correct' | 'incorrect', notes?: string) => void;
}) {
  const [reviewNotes, setReviewNotes] = useState(result.reviewerNotes ?? '');
  const [showRawData, setShowRawData] = useState(false);

  return (
    <div className="space-y-4">
      {/* Hard Gate */}
      {result.hardGateTriggered && (
        <div>
          <h4 className="text-xs font-medium text-muted-foreground mb-1">Hard Gate Triggered</h4>
          <Badge variant="red">
            {HARD_GATE_LABELS[result.hardGateTriggered] ?? result.hardGateTriggered}
          </Badge>
          <p className="text-sm text-muted-foreground mt-1">
            Planner was not called. Case automatically escalated.
          </p>
        </div>
      )}

      {/* Planner Output */}
      {result.plannerOutput && (
        <>
          <div>
            <h4 className="text-xs font-medium text-muted-foreground mb-1">Planner Thought</h4>
            <blockquote className="border-l-2 border-gray-300 pl-3 text-sm text-gray-700 whitespace-pre-wrap">
              {result.plannerOutput.thought}
            </blockquote>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <h4 className="text-xs font-medium text-muted-foreground mb-1">Decision</h4>
              <Badge variant={result.plannerOutput.decision === 'credit' ? 'green' : 'amber'}>
                {result.plannerOutput.decision === 'credit' ? 'Credit' : 'Escalate to Agent'}
              </Badge>
              <span className="ml-2 text-sm text-muted-foreground">
                timing: {result.plannerOutput.credit_timing}
              </span>
            </div>
            {result.plannerOutput.args && (
              <div>
                <h4 className="text-xs font-medium text-muted-foreground mb-1">Credit Args</h4>
                <div className="text-sm space-y-0.5">
                  <p><span className="text-muted-foreground">Reason:</span> {result.plannerOutput.args.reason}</p>
                  <p><span className="text-muted-foreground">Is fraud:</span> {String(result.plannerOutput.args.is_fraud)}</p>
                  {result.plannerOutput.args.fraud_type && (
                    <p><span className="text-muted-foreground">Fraud type:</span> {result.plannerOutput.args.fraud_type}</p>
                  )}
                  {result.plannerOutput.args.crime_reference && (
                    <p><span className="text-muted-foreground">Crime ref:</span> {result.plannerOutput.args.crime_reference}</p>
                  )}
                </div>
              </div>
            )}
          </div>

          {result.plannerOutput.uncertainty_factors.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-muted-foreground mb-1">Uncertainty Factors</h4>
              <div className="flex flex-wrap gap-1.5">
                {result.plannerOutput.uncertainty_factors.map((factor, i) => (
                  <Badge key={i} variant="gray">{factor}</Badge>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Dispute Profile */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <h4 className="text-xs font-medium text-muted-foreground">Dispute Profile</h4>
          <Badge variant={RISK_BADGE[result.disputeProfile.risk_level].variant}>
            {RISK_BADGE[result.disputeProfile.risk_level].label} Risk
          </Badge>
          <span className="text-sm font-bold">
            {result.disputeProfile.rubric_score}/108
          </span>
        </div>

        {/* Score breakdown bar */}
        <div className="mb-3">
          <div className="flex h-3 rounded-full overflow-hidden bg-gray-100">
            <div
              className="bg-blue-400"
              style={{ width: `${(result.disputeProfile.category_scores.account_trust / 108) * 100}%` }}
              title={`Account Trust: ${result.disputeProfile.category_scores.account_trust}/58`}
            />
            <div
              className="bg-purple-400"
              style={{ width: `${(result.disputeProfile.category_scores.dispute_history / 108) * 100}%` }}
              title={`Dispute History: ${result.disputeProfile.category_scores.dispute_history}/30`}
            />
            <div
              className="bg-emerald-400"
              style={{ width: `${(result.disputeProfile.category_scores.transaction_risk / 108) * 100}%` }}
              title={`Transaction Risk: ${result.disputeProfile.category_scores.transaction_risk}/20`}
            />
          </div>
          <div className="flex gap-4 mt-1.5 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full bg-blue-400" />
              Account Trust: {result.disputeProfile.category_scores.account_trust}/58
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full bg-purple-400" />
              Dispute History: {result.disputeProfile.category_scores.dispute_history}/30
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
              Txn Risk: {result.disputeProfile.category_scores.transaction_risk}/20
            </span>
          </div>
        </div>

        {/* Signal details */}
        <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm">
          {/* Left column — Account signals */}
          <div className="space-y-1">
            <SignalRow label="Account Age" value={`${result.disputeProfile.account_age_days} days`} pts={result.disputeProfile.account_age_days >= 365 ? 20 : result.disputeProfile.account_age_days >= 180 ? 12 : result.disputeProfile.account_age_days >= 90 ? 5 : 0} />
            <SignalRow label="Tier" value={result.disputeProfile.tier_name ?? '—'} pts={({'E':10,'D':8,'C':5} as Record<string,number>)[result.disputeProfile.tier_name?.toUpperCase() ?? ''] ?? 0} />
            <SignalRow label="Money Maker" value={result.disputeProfile.is_money_maker ? 'Yes' : 'No'} pts={result.disputeProfile.is_money_maker ? 15 : 0} />
            <SignalRow label="Trust Score" value={result.disputeProfile.trust_score ?? '—'} pts={result.disputeProfile.trust_score?.toUpperCase() === 'GREEN' ? 8 : result.disputeProfile.trust_score?.toUpperCase() === 'BLUE' ? 4 : 0} />
            <SignalRow label="Txns (90d)" value={String(result.rawSignals.tx_count_90_days)} pts={result.rawSignals.tx_count_90_days >= 5 ? 5 : 0} />
          </div>
          {/* Right column — Risk signals */}
          <div className="space-y-1">
            <SignalRow label="Disputes (6m)" value={String(result.rawSignals.railsr_disputes_last_6_months)} pts={result.rawSignals.railsr_disputes_last_6_months === 0 ? 30 : result.rawSignals.railsr_disputes_last_6_months <= 2 ? 15 : result.rawSignals.railsr_disputes_last_6_months <= 4 ? 5 : 0} />
            <SignalRow label="Disputes (30d)" value={String(result.rawSignals.railsr_disputes_last_30_days)} pts={result.rawSignals.railsr_disputes_last_30_days > 0 ? -5 : 0} />
            <SignalRow label="Scam Victim" value={String(result.rawSignals.scam_victim_count)} pts={result.rawSignals.scam_victim_count > 0 ? -5 : 0} />
            <SignalRow label="Max Txn" value={`£${Number(result.disputeProfile.max_transaction_amount ?? 0).toFixed(2)}`} pts={Number(result.disputeProfile.max_transaction_amount) < 5 ? 20 : Number(result.disputeProfile.max_transaction_amount) < 10 ? 14 : Number(result.disputeProfile.max_transaction_amount) < 15 ? 9 : Number(result.disputeProfile.max_transaction_amount) <= 25 ? 5 : 0} />
            <SignalRow label="Merchants" value={result.disputeProfile.merchants ?? '—'} />
          </div>
        </div>

        {result.disputeProfile.risk_factors.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {result.disputeProfile.risk_factors.map((f, i) => (
              <Badge key={i} variant="amber">{f}</Badge>
            ))}
          </div>
        )}
      </div>

      {/* Reviewer Controls */}
      {onReview && (
        <div className="border-t pt-3">
          <h4 className="text-xs font-medium text-muted-foreground mb-2">Reviewer Verdict</h4>
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              variant={result.reviewerVerdict === 'correct' ? 'default' : 'outline'}
              className={result.reviewerVerdict === 'correct' ? 'bg-green-600 hover:bg-green-700' : ''}
              onClick={() => onReview(result.id, 'correct', reviewNotes || undefined)}
            >
              <Check className="h-4 w-4 mr-1" />
              Correct
            </Button>
            <Button
              size="sm"
              variant={result.reviewerVerdict === 'incorrect' ? 'default' : 'outline'}
              className={result.reviewerVerdict === 'incorrect' ? 'bg-red-600 hover:bg-red-700' : ''}
              onClick={() => onReview(result.id, 'incorrect', reviewNotes || undefined)}
            >
              <X className="h-4 w-4 mr-1" />
              Incorrect
            </Button>
            <Input
              className="flex-1 max-w-sm"
              placeholder="Notes (optional)"
              value={reviewNotes}
              onChange={(e) => setReviewNotes(e.target.value)}
            />
          </div>
        </div>
      )}

      {/* Raw BQ Data (collapsible) */}
      <div className="border-t pt-3">
        <button
          onClick={() => setShowRawData(!showRawData)}
          className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-gray-700"
        >
          {showRawData ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
          Raw BQ Data
        </button>
        {showRawData && (
          <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
            {(Object.keys(RAW_SIGNAL_LABELS) as (keyof CaseSignalsRaw)[]).map((key) => (
              <div key={key} className="flex justify-between gap-2">
                <span className="text-muted-foreground">{RAW_SIGNAL_LABELS[key]}</span>
                <span className="font-mono text-right">
                  {formatSignalValue(result.rawSignals[key])}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

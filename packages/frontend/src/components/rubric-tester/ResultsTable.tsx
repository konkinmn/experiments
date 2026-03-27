import { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight, Trash2, Check, X, AlertTriangle, MessageSquare, FileText, Code, BookOpen, Terminal, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { PipelineResult, RiskLevel, CaseSignalsRaw, DatasetCase, DatasetLabel } from '@/types';

const WS_CASE_URL = (alias: string, caseId: number) =>
  `https://chat-workstation.k1.anna.money/${alias}/tasks/cases?caseId=${caseId}`;

interface ResultsTableProps {
  results: PipelineResult[];
  onDelete?: (id: number) => void;
  onReview?: (id: number, verdict: 'correct' | 'incorrect', notes?: string) => void;
  verdictOptions?: 'eval' | 'dataset';
  datasetCases?: DatasetCase[];
  onDatasetLabel?: (datasetCaseId: number, label: DatasetLabel, notes?: string) => void;
  onDeleteCase?: (datasetCaseId: number) => void;
  agreementMap?: Record<number, boolean | null>;
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

const LABEL_BADGE: Record<DatasetLabel, { label: string; variant: 'green' | 'amber' | 'blue' }> = {
  credit: { label: 'Credit', variant: 'green' },
  escalate: { label: 'Escalate', variant: 'amber' },
  undecided: { label: "Can't decide yet", variant: 'blue' },
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

// Rubric scoring rules — must match backend computeRubricScore()
const TIER_POINTS: Record<string, number> = { E: 10, D: 8, C: 5 };

function accountAgePts(days: number): number {
  if (days >= 365) return 20;
  if (days >= 180) return 12;
  if (days >= 90) return 5;
  return 0;
}

function trustScorePts(score: string | null): number {
  const s = score?.toUpperCase();
  if (s === 'GREEN') return 8;
  if (s === 'AMBER') return 4;
  return 0;
}

function disputes6mPts(count: number): number {
  if (count === 0) return 30;
  if (count <= 2) return 15;
  if (count <= 4) return 5;
  return 0;
}

function maxTxnPts(amount: number): number {
  if (amount < 5) return 20;
  if (amount < 10) return 14;
  if (amount < 15) return 9;
  if (amount <= 25) return 5;
  return 0;
}

interface ChatFetchFailure {
  dialogue_id: number;
  alias: string;
  status: number;
  error_body: string;
}

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

export function ResultsTable({ results, onDelete, onReview, verdictOptions = 'eval', datasetCases, onDatasetLabel, onDeleteCase, agreementMap }: ResultsTableProps) {
  if (verdictOptions === 'dataset') {
    const cases = datasetCases ?? [];
    if (cases.length === 0) {
      return (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-sm text-muted-foreground">
          No cases in this dataset.
        </div>
      );
    }

    return (
      <div className="space-y-4">
        {cases.map((dc) => {
          if (!dc.pipelineRun) {
            const isFailed = !!dc.pipelineError;
            return (
              <div key={dc.id} className={`rounded-lg border bg-white ${isFailed ? 'border-red-200' : 'border-gray-200'}`}>
                <div className="flex items-center gap-8 px-5 py-4">
                  <div className="min-w-0">
                    <span className="text-xs text-muted-foreground">Case</span>
                    <p className="font-mono text-lg font-bold">{dc.caseId}</p>
                  </div>
                  {isFailed ? (
                    <div className="flex items-center gap-2 text-sm text-red-600">
                      <AlertTriangle className="h-4 w-4" />
                      Pipeline failed
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Running pipeline...
                    </div>
                  )}
                  {onDeleteCase && (
                    <div className="ml-auto">
                      <button
                        className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-red-500 transition-colors"
                        onClick={() => onDeleteCase(dc.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                </div>
                <div className="border-t px-5 py-4">
                  {isFailed ? (
                    <p className="text-sm text-red-600">{dc.pipelineError}</p>
                  ) : (
                    <div className="space-y-3 animate-pulse">
                      <div className="h-4 bg-gray-200 rounded w-3/4" />
                      <div className="h-4 bg-gray-200 rounded w-1/2" />
                      <div className="h-20 bg-gray-200 rounded" />
                    </div>
                  )}
                </div>
              </div>
            );
          }

          const r = dc.pipelineRun;
          const risk = RISK_BADGE[r.disputeProfile.risk_level];
          const decision = r.hardGateTriggered
            ? { label: HARD_GATE_LABELS[r.hardGateTriggered] ?? r.hardGateTriggered, variant: 'red' as const }
            : DECISION_BADGE[r.plannerOutput?.decision ?? 'escalate_to_agent'];
          const labelBadge = dc.label ? LABEL_BADGE[dc.label] : null;

          return (
            <div key={dc.id} className="rounded-lg border border-gray-200 bg-white">
              <div className="flex items-center gap-8 px-5 py-4">
                <div className="min-w-0">
                  <span className="text-xs text-muted-foreground">Case</span>
                  <p className="font-mono text-lg font-bold">
                    <a href={WS_CASE_URL(r.rawSignals.alias, dc.caseId)} target="_blank" rel="noopener noreferrer" className="hover:text-blue-600 hover:underline">{dc.caseId}</a>
                  </p>
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
                  <span className="text-xs text-muted-foreground">Label</span>
                  <div className="mt-1">
                    {labelBadge ? (
                      <Badge variant={labelBadge.variant}>{labelBadge.label}</Badge>
                    ) : (
                      <span className="text-sm text-muted-foreground">Pending</span>
                    )}
                  </div>
                </div>
                {agreementMap && (
                  <div className="ml-auto">
                    {agreementMap[dc.id] === true && (
                      <div className="h-7 w-7 rounded-full bg-green-100 flex items-center justify-center" title="Agrees with label">
                        <Check className="h-4 w-4 text-green-600" />
                      </div>
                    )}
                    {agreementMap[dc.id] === false && (
                      <div className="h-7 w-7 rounded-full bg-red-100 flex items-center justify-center" title="Disagrees with label">
                        <X className="h-4 w-4 text-red-600" />
                      </div>
                    )}
                    {agreementMap[dc.id] == null && (
                      <div className="h-7 w-7 rounded-full bg-gray-100 flex items-center justify-center" title="No agreement data">
                        <span className="text-gray-400 text-sm">—</span>
                      </div>
                    )}
                  </div>
                )}
                {!agreementMap && onDeleteCase && (
                  <div className="ml-auto">
                    <button
                      className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-red-500 transition-colors"
                      onClick={() => onDeleteCase(dc.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>
              <div className="border-t px-5 py-4">
                <ExpandedDetail
                  result={r}
                  verdictOptions="dataset"
                  datasetCaseId={dc.id}
                  datasetLabel={dc.label}
                  datasetLabelNotes={dc.labelNotes}
                  onDatasetLabel={onDatasetLabel}
                />
              </div>
            </div>
          );
        })}
      </div>
    );
  }

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
                <p className="font-mono text-lg font-bold">
                  <a href={WS_CASE_URL(r.rawSignals.alias, r.caseId)} target="_blank" rel="noopener noreferrer" className="hover:text-blue-600 hover:underline">{r.caseId}</a>
                </p>
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
  verdictOptions = 'eval',
  datasetCaseId,
  datasetLabel,
  datasetLabelNotes,
  onDatasetLabel,
}: {
  result: PipelineResult;
  onReview?: (id: number, verdict: 'correct' | 'incorrect', notes?: string) => void;
  verdictOptions?: 'eval' | 'dataset';
  datasetCaseId?: number;
  datasetLabel?: DatasetLabel | null;
  datasetLabelNotes?: string | null;
  onDatasetLabel?: (datasetCaseId: number, label: DatasetLabel, notes?: string) => void;
}) {
  const [reviewNotes, setReviewNotes] = useState(
    verdictOptions === 'dataset' ? (datasetLabelNotes ?? '') : (result.reviewerNotes ?? ''),
  );
  useEffect(() => {
    setReviewNotes(verdictOptions === 'dataset' ? (datasetLabelNotes ?? '') : (result.reviewerNotes ?? ''));
  }, [verdictOptions, datasetLabelNotes, result.reviewerNotes]);
  const [showRawData, setShowRawData] = useState(false);
  const [showEnrichment, setShowEnrichment] = useState(false);
  const [showDialogue, setShowDialogue] = useState(false);
  const [showFileResults, setShowFileResults] = useState(false);
  const [showPlannerRequest, setShowPlannerRequest] = useState(false);
  const [showSystemPrompt, setShowSystemPrompt] = useState(false);
  const [showRawResponse, setShowRawResponse] = useState(false);

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
            <SignalRow label="Account Age" value={`${result.disputeProfile.account_age_days} days`} pts={accountAgePts(result.disputeProfile.account_age_days)} />
            <SignalRow label="Tier" value={result.disputeProfile.tier_name ?? '—'} pts={TIER_POINTS[result.disputeProfile.tier_name?.toUpperCase() ?? ''] ?? 0} />
            <SignalRow label="Money Maker" value={result.disputeProfile.is_money_maker ? 'Yes' : 'No'} pts={result.disputeProfile.is_money_maker ? 15 : 0} />
            <SignalRow label="Trust Score" value={result.disputeProfile.trust_score ?? '—'} pts={trustScorePts(result.disputeProfile.trust_score)} />
            <SignalRow label="Txns (90d)" value={String(result.rawSignals.tx_count_90_days)} pts={result.rawSignals.tx_count_90_days >= 5 ? 5 : 0} />
          </div>
          {/* Right column — Risk signals */}
          <div className="space-y-1">
            <SignalRow label="Disputes (6m)" value={String(result.rawSignals.railsr_disputes_last_6_months)} pts={disputes6mPts(result.rawSignals.railsr_disputes_last_6_months)} />
            <SignalRow label="Disputes (30d)" value={String(result.rawSignals.railsr_disputes_last_30_days)} pts={result.rawSignals.railsr_disputes_last_30_days > 0 ? -5 : 0} />
            <SignalRow label="Scam Victim" value={String(result.rawSignals.scam_victim_count)} pts={result.rawSignals.scam_victim_count > 0 ? -5 : 0} />
            <SignalRow label="Max Txn" value={`£${Number(result.disputeProfile.max_transaction_amount ?? 0).toFixed(2)}`} pts={maxTxnPts(Number(result.disputeProfile.max_transaction_amount ?? 0))} />
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

      {/* Enrichment Summary */}
      {result.enrichmentMetadata && (() => {
        const failures = (result.enrichmentMetadata.chat_fetch_failures ?? []) as ChatFetchFailure[];
        return (
          <div className="border-t pt-3">
            <button
              onClick={() => setShowEnrichment(!showEnrichment)}
              aria-expanded={showEnrichment}
              className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-gray-700"
            >
              {showEnrichment ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              <AlertTriangle className="h-3 w-3" />
              Enrichment Summary
              {failures.length > 0 && (
                <Badge variant="amber" className="ml-1">
                  {failures.length} failed
                </Badge>
              )}
            </button>
            {showEnrichment && (
              <div className="mt-2 space-y-3">
                <div className="grid grid-cols-3 gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground">Dialogues</span>
                    <p className="font-medium">
                      {result.enrichmentMetadata.dialogues_found ?? 0} found / {result.enrichmentMetadata.dialogues_requested ?? 0} requested
                    </p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Files</span>
                    <p className="font-medium">
                      {result.enrichmentMetadata.file_descriptions_parsed ?? 0} parsed / {result.enrichmentMetadata.file_artifacts_found ?? 0} found
                    </p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Messages to planner</span>
                    <p className="font-medium">{result.enrichmentMetadata.customer_messages_sent_to_planner ?? 0}</p>
                  </div>
                </div>
                {failures.length > 0 && (
                  <div>
                    <h5 className="text-xs font-medium text-red-600 mb-1">Chat Fetch Failures</h5>
                    <div className="bg-red-50 rounded p-2 text-xs space-y-1 max-h-40 overflow-auto">
                      {failures.map((f) => (
                        <div key={f.dialogue_id} className="font-mono">
                          <span className="text-red-600">{f.status}</span>{' '}
                          dialogue {f.dialogue_id} (alias={f.alias})
                          {f.error_body && <span className="text-muted-foreground"> — {f.error_body}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* Customer Dialogue */}
      {result.dialogueMessages && result.dialogueMessages.length > 0 && (
        <div className="border-t pt-3">
          <button
            onClick={() => setShowDialogue(!showDialogue)}
            aria-expanded={showDialogue}
            className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-gray-700"
          >
            {showDialogue ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <MessageSquare className="h-3 w-3" />
            Customer Dialogue ({result.dialogueMessages.length} messages)
          </button>
          {showDialogue && (
            <div className="mt-2 space-y-2 max-h-96 overflow-auto">
              {result.dialogueMessages.map((msg, i) => (
                <div key={i} className="flex gap-2 text-sm">
                  <Badge variant="gray" className="shrink-0 h-5 text-[10px]">{msg.role}</Badge>
                  <div className="min-w-0">
                    <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">{msg.created_at}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* File Parse Results */}
      {result.fileParseResults && result.fileParseResults.length > 0 && (
        <div className="border-t pt-3">
          <button
            onClick={() => setShowFileResults(!showFileResults)}
            aria-expanded={showFileResults}
            className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-gray-700"
          >
            {showFileResults ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <FileText className="h-3 w-3" />
            File Parse Results ({result.fileParseResults.length} files)
          </button>
          {showFileResults && (
            <div className="mt-2 space-y-2">
              {result.fileParseResults.map((desc, i) => (
                <div key={i} className="bg-gray-50 rounded p-3 text-sm whitespace-pre-wrap">{desc}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Planner Request Payload */}
      {result.plannerRequest && (
        <div className="border-t pt-3">
          <button
            onClick={() => setShowPlannerRequest(!showPlannerRequest)}
            aria-expanded={showPlannerRequest}
            className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-gray-700"
          >
            {showPlannerRequest ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <Code className="h-3 w-3" />
            Planner Request Payload
          </button>
          {showPlannerRequest && (
            <pre className="mt-2 bg-gray-50 rounded p-3 text-xs font-mono overflow-auto max-h-96">
              {JSON.stringify(result.plannerRequest, null, 2)}
            </pre>
          )}
        </div>
      )}

      {/* System Prompt */}
      {result.plannerSystemPrompt && (
        <div className="border-t pt-3">
          <button
            onClick={() => setShowSystemPrompt(!showSystemPrompt)}
            aria-expanded={showSystemPrompt}
            className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-gray-700"
          >
            {showSystemPrompt ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <BookOpen className="h-3 w-3" />
            System Prompt
          </button>
          {showSystemPrompt && (
            <pre className="mt-2 bg-gray-50 rounded p-3 text-xs font-mono overflow-auto max-h-96 whitespace-pre-wrap">
              {result.plannerSystemPrompt}
            </pre>
          )}
        </div>
      )}

      {/* Raw LLM Response */}
      {result.plannerRawResponse && (
        <div className="border-t pt-3">
          <button
            onClick={() => setShowRawResponse(!showRawResponse)}
            aria-expanded={showRawResponse}
            className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-gray-700"
          >
            {showRawResponse ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <Terminal className="h-3 w-3" />
            Raw LLM Response
          </button>
          {showRawResponse && (
            <pre className="mt-2 bg-gray-50 rounded p-3 text-xs font-mono overflow-auto max-h-96 whitespace-pre-wrap">
              {result.plannerRawResponse}
            </pre>
          )}
        </div>
      )}

      {/* Reviewer Controls — eval mode */}
      {verdictOptions === 'eval' && onReview && (
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

      {/* Reviewer Controls — dataset mode */}
      {verdictOptions === 'dataset' && onDatasetLabel && datasetCaseId != null && (
        <div className="border-t pt-3">
          <h4 className="text-xs font-medium text-muted-foreground mb-2">Reviewer Verdict</h4>
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              variant={datasetLabel === 'credit' ? 'default' : 'outline'}
              className={datasetLabel === 'credit' ? 'bg-green-600 hover:bg-green-700' : ''}
              onClick={() => onDatasetLabel(datasetCaseId, 'credit', reviewNotes || undefined)}
            >
              <Check className="h-4 w-4 mr-1" />
              Credit
            </Button>
            <Button
              size="sm"
              variant={datasetLabel === 'escalate' ? 'default' : 'outline'}
              className={datasetLabel === 'escalate' ? 'bg-amber-600 hover:bg-amber-700' : ''}
              onClick={() => onDatasetLabel(datasetCaseId, 'escalate', reviewNotes || undefined)}
            >
              <AlertTriangle className="h-4 w-4 mr-1" />
              Escalate
            </Button>
            <Button
              size="sm"
              variant={datasetLabel === 'undecided' ? 'default' : 'outline'}
              className={datasetLabel === 'undecided' ? 'bg-blue-600 hover:bg-blue-700' : ''}
              onClick={() => onDatasetLabel(datasetCaseId, 'undecided', reviewNotes || undefined)}
            >
              <MessageSquare className="h-4 w-4 mr-1" />
              Can't decide yet
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
          aria-expanded={showRawData}
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

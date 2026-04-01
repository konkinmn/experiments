import { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight, Trash2, Check, X, AlertTriangle, MessageSquare, FileText, Code, BookOpen, Terminal, Loader2, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import type { PipelineResult, RiskLevel, CaseSignalsRaw, DatasetCase, DatasetLabel } from '@/types';

const WS_CASE_URL = (alias: string, caseId: number) =>
  `https://chat-workstation.k1.anna.money/${alias}/tasks/cases?caseId=${caseId}`;

function formatBqDate(val: unknown): string {
  if (!val) return '—';
  const s = typeof val === 'object' && val !== null && 'value' in val ? String((val as { value: unknown }).value) : String(val);
  return s.slice(0, 10) || '—';
}

interface ResultsTableProps {
  results: PipelineResult[];
  onDelete?: (id: number) => void;
  onReview?: (id: number, verdict: 'correct' | 'incorrect', notes?: string) => void;
  verdictOptions?: 'eval' | 'dataset';
  datasetCases?: DatasetCase[];
  onDatasetLabel?: (datasetCaseId: number, label: DatasetLabel, notes?: string, confidence?: string | null, disagreementReason?: string | null, disagreementNotes?: string | null) => void;
  onDeleteCase?: (datasetCaseId: number) => void;
  onTagCase?: (datasetCaseId: number, tags: string[]) => void;
  onDatasetLabel2?: (datasetCaseId: number, label: DatasetLabel, notes?: string, confidence?: string | null) => void;
  agreementMap?: Record<number, boolean | null>;
  tagSuggestions?: string[];
  onRetryCase?: (runCaseId: number) => void;
  retryingCaseIds?: Set<number>;
  onActionNote?: (runCaseId: number, note: string | null) => void;
  actionNotes?: Record<number, string | null>;
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

function formatSignalValue(value: unknown, key?: string): string {
  if (value == null) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  // BQ Timestamp objects have a `value` property
  if (typeof value === 'object' && value !== null && 'value' in value) {
    const inner = (value as { value: unknown }).value;
    if (typeof inner === 'string') {
      // Try formatting as date if it looks like a timestamp
      if (key === 'case_created_at' && inner.includes('T')) {
        return new Date(inner).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
      }
      return inner;
    }
  }
  if (typeof value === 'object') return JSON.stringify(value);
  // Format amounts with £
  if (key && (key === 'total_amount' || key === 'max_transaction_amount')) {
    return `£${Number(value).toFixed(2)}`;
  }
  // Format timestamps
  if (key === 'case_created_at' && typeof value === 'string' && value.includes('T')) {
    return new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  return String(value);
}

/** Signal groups for the Dataset tab — organized by category for readability */
const SIGNAL_GROUPS: { title: string; signals: { key: keyof CaseSignalsRaw; label: string }[] }[] = [
  {
    title: 'Transaction',
    signals: [
      { key: 'total_amount', label: 'Total Amount' },
      { key: 'max_transaction_amount', label: 'Max Transaction' },
      { key: 'merchants', label: 'Merchants' },
      { key: 'case_created_at', label: 'Case Created' },
    ],
  },
  {
    title: 'Account',
    signals: [
      { key: 'account_age_days', label: 'Account Age (days)' },
      { key: 'account_status', label: 'Status' },
      { key: 'tier_name', label: 'Tier' },
      { key: 'trust_score', label: 'Trust Score' },
      { key: 'is_money_maker', label: 'Money Maker' },
    ],
  },
  {
    title: 'Risk Flags',
    signals: [
      { key: 'cifas_count', label: 'CIFAS' },
      { key: 'scammer_count', label: 'Scammer' },
      { key: 'scam_victim_count', label: 'Scam Victim' },
      { key: 'railsr_disputes_last_6_months', label: 'Disputes (6m)' },
      { key: 'railsr_disputes_last_30_days', label: 'Disputes (30d)' },
    ],
  },
  {
    title: 'Activity',
    signals: [
      { key: 'tx_count_90_days', label: 'Txns (90d)' },
      { key: 'active_months', label: 'Active Months' },
      { key: 'prior_payments_to_merchant', label: 'Prior Merchant Payments' },
    ],
  },
];

export function ResultsTable({ results, onDelete, onReview, verdictOptions = 'eval', datasetCases, onDatasetLabel, onDeleteCase, onTagCase, onDatasetLabel2, agreementMap, tagSuggestions, onRetryCase, retryingCaseIds, onActionNote, actionNotes }: ResultsTableProps) {
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
          // New architecture: show context data (no pipeline run needed)
          const hasContext = !!dc.rawSignals;
          const isContextFailed = !!dc.contextError;
          // Legacy: fall back to pipeline data if available
          const hasPipelineRun = !!dc.pipelineRun;

          if (!hasContext && !hasPipelineRun) {
            const isFailed = isContextFailed || !!dc.pipelineError;
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
                      {dc.contextError ? 'Context fetch failed' : 'Pipeline failed'}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Fetching context...
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
                    <div className="flex items-center justify-between">
                      <p className="text-sm text-red-600">{dc.contextError || dc.pipelineError}</p>
                      {dc.pipelineError && onRetryCase && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => onRetryCase(dc.id)}
                          disabled={retryingCaseIds?.has(dc.id)}
                        >
                          <RefreshCw className={`h-3 w-3 mr-1.5 ${retryingCaseIds?.has(dc.id) ? 'animate-spin' : ''}`} />
                          Retry
                        </Button>
                      )}
                    </div>
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

          // For pipeline run data (run tabs or legacy datasets), use original rendering
          if (hasPipelineRun && !hasContext) {
            const r = dc.pipelineRun!;
            const risk = RISK_BADGE[r.disputeProfile.risk_level];
            const decision = r.hardGateTriggered
              ? { label: 'Escalate', variant: 'amber' as const }
              : DECISION_BADGE[r.plannerOutput?.decision ?? 'escalate_to_agent'];
            const labelBadge = dc.label ? LABEL_BADGE[dc.label] : null;
            // Fall through to the existing pipeline-based rendering below
            return <DatasetCaseCard key={dc.id} dc={dc} r={r} risk={risk} decision={decision} labelBadge={labelBadge} onDatasetLabel={onDatasetLabel} onDeleteCase={onDeleteCase} onTagCase={onTagCase} onDatasetLabel2={onDatasetLabel2} agreementMap={agreementMap} tagSuggestions={tagSuggestions} onRetryCase={onRetryCase} retryingCaseIds={retryingCaseIds} onActionNote={onActionNote} actionNote={actionNotes?.[dc.id] ?? null} />;
          }

          // New: render context-only card (Dataset tab)
          const signals = dc.rawSignals!;
          const labelBadge = dc.label ? LABEL_BADGE[dc.label] : null;

          return (
            <ContextCaseCard
              key={dc.id}
              dc={dc}
              signals={signals}
              labelBadge={labelBadge}
              onDatasetLabel={onDatasetLabel}
              onDeleteCase={onDeleteCase}
              onTagCase={onTagCase}
              onDatasetLabel2={onDatasetLabel2}
              tagSuggestions={tagSuggestions}
            />
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
          ? { label: 'Escalate', variant: 'amber' as const }
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

/** Context-only card for the Dataset tab (no pipeline output) */
function ContextCaseCard({
  dc,
  signals,
  labelBadge,
  onDatasetLabel,
  onDeleteCase,
  onTagCase,
  onDatasetLabel2,
  tagSuggestions,
}: {
  dc: DatasetCase;
  signals: CaseSignalsRaw;
  labelBadge: { label: string; variant: 'green' | 'amber' | 'blue' } | null;
  onDatasetLabel?: (id: number, label: DatasetLabel, notes?: string, confidence?: string | null, disagreementReason?: string | null, disagreementNotes?: string | null) => void;
  onDeleteCase?: (id: number) => void;
  onTagCase?: (id: number, tags: string[]) => void;
  onDatasetLabel2?: (id: number, label: DatasetLabel, notes?: string, confidence?: string | null) => void;
  tagSuggestions?: string[];
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <div className="flex items-center gap-8 px-5 py-4 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <div className="flex items-center gap-1 text-gray-400">
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </div>
        <div className="min-w-0">
          <span className="text-xs text-muted-foreground">Case</span>
          <p className="font-mono text-lg font-bold">
            <a href={WS_CASE_URL(signals.alias, dc.caseId)} target="_blank" rel="noopener noreferrer" className="hover:text-blue-600 hover:underline" onClick={(e) => e.stopPropagation()}>{dc.caseId}</a>
          </p>
        </div>
        <div>
          <span className="text-xs text-muted-foreground">Amount</span>
          <p className="text-sm mt-1 font-medium">{signals.total_amount != null ? `£${Number(signals.total_amount).toFixed(2)}` : '—'}</p>
        </div>
        <div>
          <span className="text-xs text-muted-foreground">Account Age</span>
          <p className="text-sm mt-1">{signals.account_age_days}d</p>
        </div>
        <div>
          <span className="text-xs text-muted-foreground">CIFAS</span>
          <p className="text-sm mt-1">{signals.cifas_count}</p>
        </div>
        <div>
          <span className="text-xs text-muted-foreground">Trust</span>
          <p className="text-sm mt-1">{signals.trust_score ?? '—'}</p>
        </div>
        <div>
          <span className="text-xs text-muted-foreground">Case created at</span>
          <p className="text-sm mt-1">{formatBqDate(signals.case_created_at)}</p>
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
        {dc.manualTags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {dc.manualTags.map((tag) => (
              <Badge key={tag} variant="gray" className="text-xs">{tag}</Badge>
            ))}
          </div>
        )}
        {dc.labelNotes && (
          <div className="min-w-0 flex-1">
            <span className="text-xs text-muted-foreground italic">{dc.labelNotes}</span>
          </div>
        )}
        {onDeleteCase && (
          <div className="ml-auto">
            <button
              className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-red-500 transition-colors"
              onClick={(e) => { e.stopPropagation(); onDeleteCase(dc.id); }}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
      {expanded && (
        <div className="border-t px-5 py-4 space-y-4">
          {/* Signals — grouped by category */}
          <div className="grid grid-cols-2 gap-4">
            {SIGNAL_GROUPS.map((group) => (
              <div key={group.title} className="rounded-md border border-gray-100 bg-gray-50/50 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-2">{group.title}</p>
                <div className="space-y-1.5">
                  {group.signals.map(({ key, label }) => (
                    <div key={key} className="flex items-baseline justify-between gap-2 text-sm overflow-hidden">
                      <span className="text-muted-foreground shrink-0">{label}</span>
                      <span className="border-b border-dotted border-gray-200 flex-1 min-w-4 mx-1 translate-y-[-3px]" />
                      <span className="font-mono text-right truncate min-w-0" title={formatSignalValue(signals[key], key)}>{formatSignalValue(signals[key], key)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Customer Dialogue */}
          {dc.dialogueMessages && dc.dialogueMessages.length > 0 && (
            <CollapsibleSection title="Customer Dialogue" icon={<MessageSquare className="h-4 w-4" />} count={dc.dialogueMessages.length}>
              <div className="space-y-2">
                {dc.dialogueMessages.map((m, i) => (
                  <div key={i} className="text-sm">
                    <span className="font-medium text-gray-700">{m.role}:</span>{' '}
                    <span className="text-gray-600">{m.content}</span>
                  </div>
                ))}
              </div>
            </CollapsibleSection>
          )}

          {/* File Parse Results */}
          {dc.fileParseResults && dc.fileParseResults.length > 0 && (
            <CollapsibleSection title="Parsed Files" icon={<FileText className="h-4 w-4" />} count={dc.fileParseResults.length}>
              <div className="space-y-2">
                {dc.fileParseResults.map((desc, i) => (
                  <pre key={i} className="text-xs bg-gray-50 p-3 rounded whitespace-pre-wrap">{desc}</pre>
                ))}
              </div>
            </CollapsibleSection>
          )}

          {/* Case Actions */}
          {dc.caseActions && dc.caseActions.length > 0 && (
            <CollapsibleSection title="Case Actions" icon={<Code className="h-4 w-4" />} count={dc.caseActions.length}>
              <div className="space-y-1 text-sm">
                {dc.caseActions.map((a, i) => (
                  <div key={i} className="flex gap-2">
                    <Badge variant="gray">{a.action_type}</Badge>
                    <span className="text-muted-foreground">{a.status}</span>
                  </div>
                ))}
              </div>
            </CollapsibleSection>
          )}

          {/* Label controls */}
          {onDatasetLabel && (
            <DatasetLabelControls
              datasetCaseId={dc.id}
              label={dc.label}
              labelNotes={dc.labelNotes}
              labelConfidence={dc.labelConfidence}
              onLabel={onDatasetLabel}
            />
          )}

          {/* Second labeler */}
          {onDatasetLabel2 && (
            <DatasetLabel2Controls
              datasetCaseId={dc.id}
              label2={dc.label2}
              label2Notes={dc.label2Notes}
              label2Confidence={dc.label2Confidence}
              onLabel2={onDatasetLabel2}
            />
          )}

          {/* Tags */}
          {onTagCase && (
            <TagControls
              datasetCaseId={dc.id}
              tags={dc.manualTags}
              onTagCase={onTagCase}
              suggestions={tagSuggestions}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** Wrapper for legacy datasets that still have pipelineRun data */
function DatasetCaseCard({
  dc,
  r,
  risk,
  decision,
  labelBadge,
  onDatasetLabel,
  onDeleteCase,
  onTagCase,
  onDatasetLabel2,
  agreementMap,
  tagSuggestions,
  onRetryCase,
  retryingCaseIds,
  onActionNote,
  actionNote,
}: {
  dc: DatasetCase;
  r: PipelineResult;
  risk: { label: string; variant: 'green' | 'amber' | 'red' };
  decision: { label: string; variant: string };
  labelBadge: { label: string; variant: 'green' | 'amber' | 'blue' } | null;
  onDatasetLabel?: (id: number, label: DatasetLabel, notes?: string, confidence?: string | null, disagreementReason?: string | null, disagreementNotes?: string | null) => void;
  onDeleteCase?: (id: number) => void;
  onTagCase?: (id: number, tags: string[]) => void;
  onDatasetLabel2?: (id: number, label: DatasetLabel, notes?: string, confidence?: string | null) => void;
  agreementMap?: Record<number, boolean | null>;
  tagSuggestions?: string[];
  onRetryCase?: (id: number) => void;
  retryingCaseIds?: Set<number>;
  onActionNote?: (id: number, note: string | null) => void;
  actionNote?: string | null;
}) {
  return (
    <div className={`rounded-lg border bg-white ${agreementMap?.[dc.id] === false ? 'border-red-200' : 'border-gray-200'}`}>
      <div className="px-5 py-4">
        {/* Top: Case ID + actions */}
        <div className="flex items-center justify-between mb-3">
          <p className="font-mono text-lg font-bold">
            <a href={WS_CASE_URL(r.rawSignals.alias, dc.caseId)} target="_blank" rel="noopener noreferrer" className="hover:text-blue-600 hover:underline">Case {dc.caseId}</a>
          </p>
          <div className="flex items-center gap-2">
            {agreementMap && onRetryCase && (
              <button
                className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-blue-600 transition-colors"
                onClick={() => onRetryCase(dc.id)}
                disabled={retryingCaseIds?.has(dc.id)}
                title="Rerun this case"
              >
                <RefreshCw className={`h-4 w-4 ${retryingCaseIds?.has(dc.id) ? 'animate-spin text-blue-600' : ''}`} />
              </button>
            )}
            {agreementMap && agreementMap[dc.id] === true && <div className="h-7 w-7 rounded-full bg-green-100 flex items-center justify-center" title="Match"><Check className="h-4 w-4 text-green-600" /></div>}
            {agreementMap && agreementMap[dc.id] === false && <div className="h-7 w-7 rounded-full bg-red-100 flex items-center justify-center" title="Disagree"><X className="h-4 w-4 text-red-600" /></div>}
            {agreementMap && agreementMap[dc.id] == null && <div className="h-7 w-7 rounded-full bg-gray-100 flex items-center justify-center" title="No label"><span className="text-gray-400 text-sm">—</span></div>}
            {!agreementMap && onDeleteCase && (
              <button className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-red-500 transition-colors" onClick={() => onDeleteCase(dc.id)}>
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* Two columns: Pipeline vs Dataset */}
        <div className="grid grid-cols-2 gap-4">
          {/* Left: Pipeline output */}
          <div className="rounded-md border border-gray-100 bg-gray-50 px-4 py-3">
            <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wider mb-2">Pipeline</p>
            <div className="flex items-center gap-4">
              <div>
                <span className="text-xs text-muted-foreground">Risk</span>
                <div className="mt-0.5"><Badge variant={risk.variant}>{risk.label}</Badge></div>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Decision</span>
                <div className="mt-0.5"><Badge variant={decision.variant as 'green' | 'amber' | 'red'}>{decision.label}</Badge></div>
              </div>
              {r.hardGateTriggered && (
                <div>
                  <span className="text-xs text-muted-foreground">Hard Gate</span>
                  <div className="mt-0.5"><Badge variant="red">{HARD_GATE_LABELS[r.hardGateTriggered] ?? r.hardGateTriggered}</Badge></div>
                </div>
              )}
              <div>
                <span className="text-xs text-muted-foreground">Duration</span>
                <p className="text-sm mt-0.5">{(r.pipelineDurationMs / 1000).toFixed(1)}s</p>
              </div>
            </div>
          </div>

          {/* Right: Dataset label */}
          <div className="rounded-md border border-gray-100 bg-blue-50/50 px-4 py-3">
            <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wider mb-2">Human Label</p>
            <div className="flex items-center gap-3">
              {labelBadge ? <Badge variant={labelBadge.variant}>{labelBadge.label}</Badge> : <span className="text-sm text-muted-foreground">Pending</span>}
              {dc.labelConfidence && (
                <span className="text-xs text-gray-500 capitalize">{dc.labelConfidence}</span>
              )}
              {dc.manualTags && dc.manualTags.length > 0 && dc.manualTags.map((tag) => (
                <span key={tag} className="inline-flex items-center rounded-full bg-white border border-gray-200 px-2.5 py-0.5 text-xs font-medium text-gray-700">{tag}</span>
              ))}
            </div>
            {dc.labelNotes && (
              <p className="mt-2 text-sm text-gray-600">{dc.labelNotes}</p>
            )}
          </div>
        </div>
      </div>
      <div className="border-t px-5 py-4">
        <ExpandedDetail
          result={r}
          verdictOptions="dataset"
          datasetCaseId={dc.id}
          datasetLabel={dc.label}
          datasetLabelNotes={dc.labelNotes}
          datasetLabelConfidence={dc.labelConfidence}
          datasetDisagreementReason={dc.disagreementReason}
          datasetDisagreementNotes={dc.disagreementNotes}
          datasetManualTags={dc.manualTags}
          datasetLabel2={dc.label2}
          datasetLabel2Notes={dc.label2Notes}
          datasetLabel2Confidence={dc.label2Confidence}
          onDatasetLabel={onDatasetLabel}
          onDatasetLabel2={onDatasetLabel2}
          onTagCase={onTagCase}
          tagSuggestions={tagSuggestions}
          isRunMode={!!agreementMap}
          onActionNote={onActionNote}
          initialActionNote={actionNote}
        />
      </div>
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
  datasetLabelConfidence,
  datasetDisagreementReason,
  datasetDisagreementNotes,
  datasetManualTags,
  datasetLabel2,
  datasetLabel2Notes,
  datasetLabel2Confidence,
  onDatasetLabel,
  onDatasetLabel2,
  onTagCase,
  tagSuggestions,
  isRunMode,
  onActionNote,
  initialActionNote,
}: {
  result: PipelineResult;
  onReview?: (id: number, verdict: 'correct' | 'incorrect', notes?: string) => void;
  verdictOptions?: 'eval' | 'dataset';
  datasetCaseId?: number;
  datasetLabel?: DatasetLabel | null;
  datasetLabelNotes?: string | null;
  datasetLabelConfidence?: string | null;
  datasetDisagreementReason?: string | null;
  datasetDisagreementNotes?: string | null;
  datasetManualTags?: string[];
  datasetLabel2?: DatasetLabel | null;
  datasetLabel2Notes?: string | null;
  datasetLabel2Confidence?: string | null;
  onDatasetLabel?: (datasetCaseId: number, label: DatasetLabel, notes?: string, confidence?: string | null, disagreementReason?: string | null, disagreementNotes?: string | null) => void;
  onDatasetLabel2?: (datasetCaseId: number, label: DatasetLabel, notes?: string, confidence?: string | null) => void;
  onTagCase?: (datasetCaseId: number, tags: string[]) => void;
  tagSuggestions?: string[];
  isRunMode?: boolean;
  onActionNote?: (id: number, note: string | null) => void;
  initialActionNote?: string | null;
}) {
  const [actionNoteValue, setActionNoteValue] = useState(initialActionNote ?? '');
  useEffect(() => {
    setActionNoteValue(initialActionNote ?? '');
  }, [initialActionNote]);
  const [reviewNotes, setReviewNotes] = useState(
    verdictOptions === 'dataset' ? (datasetLabelNotes ?? '') : (result.reviewerNotes ?? ''),
  );
  useEffect(() => {
    setReviewNotes(verdictOptions === 'dataset' ? (datasetLabelNotes ?? '') : (result.reviewerNotes ?? ''));
  }, [verdictOptions, datasetLabelNotes, result.reviewerNotes]);
  const [confidence, setConfidence] = useState<string | null>(datasetLabelConfidence ?? null);
  const [disagreementReason, setDisagreementReason] = useState<string | null>(datasetDisagreementReason ?? null);
  const [disNotes, setDisNotes] = useState(datasetDisagreementNotes ?? '');
  useEffect(() => {
    setConfidence(datasetLabelConfidence ?? null);
    setDisagreementReason(datasetDisagreementReason ?? null);
    setDisNotes(datasetDisagreementNotes ?? '');
  }, [datasetLabelConfidence, datasetDisagreementReason, datasetDisagreementNotes]);
  const [showLabel2, setShowLabel2] = useState(!!datasetLabel2);
  const [label2Notes, setLabel2Notes] = useState(datasetLabel2Notes ?? '');
  const [label2Confidence, setLabel2Confidence] = useState<string | null>(datasetLabel2Confidence ?? null);
  useEffect(() => {
    setShowLabel2(!!datasetLabel2);
    setLabel2Notes(datasetLabel2Notes ?? '');
    setLabel2Confidence(datasetLabel2Confidence ?? null);
  }, [datasetLabel2, datasetLabel2Notes, datasetLabel2Confidence]);
  const [tagInput, setTagInput] = useState('');
  const [showRawData, setShowRawData] = useState(false);
  const [showEnrichment, setShowEnrichment] = useState(false);
  const [showDialogue, setShowDialogue] = useState(false);
  const [showFileResults, setShowFileResults] = useState(false);
  const [showPlannerRequest, setShowPlannerRequest] = useState(false);
  const [showSystemPrompt, setShowSystemPrompt] = useState(false);
  const [showRawResponse, setShowRawResponse] = useState(false);

  const pipelineDecision = result.hardGateTriggered ? 'escalate' : result.plannerOutput?.decision === 'credit' ? 'credit' : 'escalate';
  const currentDisagreement = datasetLabel && datasetLabel !== 'undecided' && datasetLabel !== pipelineDecision;

  return (
    <div className="space-y-4">
      {/* Run mode: Action note at the top */}
      {isRunMode && datasetCaseId != null && onActionNote && (
        <div className="rounded-md border border-blue-100 bg-blue-50/50 px-4 py-3">
          <div className="flex items-center gap-2 mb-2">
            <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wider">What to do</h4>
            {currentDisagreement && (
              <span className="text-xs text-red-600 font-medium">Disagrees with pipeline</span>
            )}
          </div>
          <textarea
            className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm placeholder:text-muted-foreground resize-y min-h-[36px]"
            placeholder="Write what should happen with this case..."
            rows={2}
            value={actionNoteValue}
            onChange={(e) => setActionNoteValue(e.target.value)}
            onBlur={() => {
              const trimmed = actionNoteValue.trim() || null;
              if (trimmed !== (initialActionNote ?? null)) {
                onActionNote(datasetCaseId, trimmed);
              }
            }}
          />
        </div>
      )}

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
            <textarea
              className="flex-1 max-w-sm rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground resize-y min-h-[36px]"
              placeholder="Notes (optional)"
              rows={3  }
              value={reviewNotes}
              onChange={(e) => setReviewNotes(e.target.value)}
            />
          </div>
        </div>
      )}

      {/* Reviewer Controls — dataset mode only (not run mode) */}
      {verdictOptions === 'dataset' && !isRunMode && onDatasetLabel && datasetCaseId != null && (() => {
        const handleLabel = (label: DatasetLabel) => {
          const isDisagreement = label !== 'undecided' && label !== pipelineDecision;
          onDatasetLabel(
            datasetCaseId, label, reviewNotes || undefined,
            confidence, isDisagreement ? disagreementReason : null,
            isDisagreement ? (disNotes || null) : null,
          );
        };

        return (
        <div className="border-t pt-3 space-y-3">
          <h4 className="text-xs font-medium text-muted-foreground mb-2">Reviewer Verdict</h4>
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              variant={datasetLabel === 'credit' ? 'default' : 'outline'}
              className={datasetLabel === 'credit' ? 'bg-green-600 hover:bg-green-700' : ''}
              onClick={() => handleLabel('credit')}
            >
              <Check className="h-4 w-4 mr-1" />
              Credit
            </Button>
            <Button
              size="sm"
              variant={datasetLabel === 'escalate' ? 'default' : 'outline'}
              className={datasetLabel === 'escalate' ? 'bg-amber-600 hover:bg-amber-700' : ''}
              onClick={() => handleLabel('escalate')}
            >
              <AlertTriangle className="h-4 w-4 mr-1" />
              Escalate
            </Button>
            <Button
              size="sm"
              variant={datasetLabel === 'undecided' ? 'default' : 'outline'}
              className={datasetLabel === 'undecided' ? 'bg-blue-600 hover:bg-blue-700' : ''}
              onClick={() => handleLabel('undecided')}
            >
              <MessageSquare className="h-4 w-4 mr-1" />
              Can't decide yet
            </Button>
            <textarea
              className="flex-1 max-w-sm rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground resize-y min-h-[36px]"
              placeholder="Notes (optional)"
              rows={3  }
              value={reviewNotes}
              onChange={(e) => setReviewNotes(e.target.value)}
            />
          </div>

          {/* Confidence + Disagreement row */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground">Confidence</label>
              <Select
                className="h-8 text-xs w-[110px]"
                value={confidence ?? ''}
                onChange={(e) => {
                  const val = e.target.value || null;
                  setConfidence(val);
                  if (datasetLabel && datasetCaseId != null) {
                    const isDisagreement = datasetLabel !== 'undecided' && datasetLabel !== pipelineDecision;
                    onDatasetLabel(datasetCaseId, datasetLabel, reviewNotes || undefined, val, isDisagreement ? disagreementReason : null, isDisagreement ? (disNotes || null) : null);
                  }
                }}
              >
                <option value="">—</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </Select>
            </div>

            {currentDisagreement && (
              <>
                <div className="flex items-center gap-1.5">
                  <label className="text-xs text-red-600 font-medium">Disagrees with pipeline</label>
                  <Select
                    className="h-8 text-xs w-[160px]"
                    value={disagreementReason ?? ''}
                    onChange={(e) => {
                      const val = e.target.value || null;
                      setDisagreementReason(val);
                      if (datasetLabel && datasetCaseId != null) {
                        onDatasetLabel(datasetCaseId, datasetLabel, reviewNotes || undefined, confidence, val, disNotes || null);
                      }
                    }}
                  >
                    <option value="">Select reason...</option>
                    <option value="signal_quality">Bad signals</option>
                    <option value="rubric_issue">Rubric issue</option>
                    <option value="llm_reasoning">LLM reasoning</option>
                    <option value="human_label_wrong">My label may be wrong</option>
                    <option value="edge_case">Edge case</option>
                    <option value="other">Other</option>
                  </Select>
                </div>
                <Input
                  className="h-8 text-xs flex-1 max-w-xs"
                  placeholder="Disagreement notes (optional)"
                  value={disNotes}
                  onChange={(e) => setDisNotes(e.target.value)}
                  onBlur={() => {
                    if (datasetLabel && datasetCaseId != null) {
                      onDatasetLabel(datasetCaseId, datasetLabel, reviewNotes || undefined, confidence, disagreementReason, disNotes || null);
                    }
                  }}
                />
              </>
            )}
          </div>

        </div>
        );
      })()}

      {/* Manual Tags — dataset mode only */}
      {verdictOptions === 'dataset' && !isRunMode && onTagCase && datasetCaseId != null && (
        <div className="border-t pt-3">
          <h4 className="text-xs font-medium text-muted-foreground mb-2">Tags</h4>
          <div className="flex items-center gap-2 flex-wrap">
            {(datasetManualTags ?? []).map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 text-xs bg-gray-100 text-gray-700 px-2 py-1 rounded-full"
              >
                {tag}
                <button
                  className="text-gray-400 hover:text-gray-600"
                  onClick={() => onTagCase(datasetCaseId, (datasetManualTags ?? []).filter((t) => t !== tag))}
                >
                  &times;
                </button>
              </span>
            ))}
            <TagSuggestInput
              value={tagInput}
              onChange={setTagInput}
              suggestions={tagSuggestions}
              existingTags={datasetManualTags ?? []}
              onAdd={(tag) => {
                const newTags = [...(datasetManualTags ?? []), tag];
                onTagCase(datasetCaseId, [...new Set(newTags)]);
                setTagInput('');
              }}
            />
          </div>
        </div>
      )}

      {/* Second Labeler — dataset mode */}
      {verdictOptions === 'dataset' && onDatasetLabel2 && datasetCaseId != null && (
        <div className="border-t pt-3">
          <button
            className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-gray-700 mb-2"
            onClick={() => setShowLabel2(!showLabel2)}
          >
            {showLabel2 ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Second Labeler
            {datasetLabel2 && (
              <Badge variant={datasetLabel2 === 'credit' ? 'green' : datasetLabel2 === 'escalate' ? 'amber' : 'blue'} className="ml-1">
                {datasetLabel2}
              </Badge>
            )}
          </button>
          {showLabel2 && (
            <div className="ml-4 space-y-2">
              <div className="flex items-center gap-3">
                <Button
                  size="sm"
                  variant={datasetLabel2 === 'credit' ? 'default' : 'outline'}
                  className={datasetLabel2 === 'credit' ? 'bg-green-600 hover:bg-green-700' : ''}
                  onClick={() => onDatasetLabel2(datasetCaseId, 'credit', label2Notes || undefined, label2Confidence)}
                >
                  <Check className="h-4 w-4 mr-1" />
                  Credit
                </Button>
                <Button
                  size="sm"
                  variant={datasetLabel2 === 'escalate' ? 'default' : 'outline'}
                  className={datasetLabel2 === 'escalate' ? 'bg-amber-600 hover:bg-amber-700' : ''}
                  onClick={() => onDatasetLabel2(datasetCaseId, 'escalate', label2Notes || undefined, label2Confidence)}
                >
                  <AlertTriangle className="h-4 w-4 mr-1" />
                  Escalate
                </Button>
                <Button
                  size="sm"
                  variant={datasetLabel2 === 'undecided' ? 'default' : 'outline'}
                  className={datasetLabel2 === 'undecided' ? 'bg-blue-600 hover:bg-blue-700' : ''}
                  onClick={() => onDatasetLabel2(datasetCaseId, 'undecided', label2Notes || undefined, label2Confidence)}
                >
                  <MessageSquare className="h-4 w-4 mr-1" />
                  Can't decide yet
                </Button>
                <textarea
                  className="flex-1 max-w-xs rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground resize-y min-h-[36px]"
                  placeholder="Notes (optional)"
                  rows={3  }
                  value={label2Notes}
                  onChange={(e) => setLabel2Notes(e.target.value)}
                />
              </div>
              <div className="flex items-center gap-1.5">
                <label className="text-xs text-muted-foreground">Confidence</label>
                <Select
                  className="h-8 text-xs w-[110px]"
                  value={label2Confidence ?? ''}
                  onChange={(e) => {
                    const val = e.target.value || null;
                    setLabel2Confidence(val);
                    if (datasetLabel2 && datasetCaseId != null) {
                      onDatasetLabel2(datasetCaseId, datasetLabel2, label2Notes || undefined, val);
                    }
                  }}
                >
                  <option value="">—</option>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </Select>
              </div>
            </div>
          )}
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

function CollapsibleSection({ title, icon, count, children }: { title: string; icon: React.ReactNode; count?: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button className="flex items-center gap-2 text-sm font-medium text-gray-700 hover:text-gray-900" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {icon}
        {title}{count != null && ` (${count})`}
      </button>
      {open && <div className="mt-2 ml-5">{children}</div>}
    </div>
  );
}

function DatasetLabelControls({
  datasetCaseId,
  label,
  labelNotes,
  labelConfidence,
  onLabel,
}: {
  datasetCaseId: number;
  label: DatasetLabel | null;
  labelNotes: string | null;
  labelConfidence: string | null;
  onLabel: (id: number, label: DatasetLabel, notes?: string, confidence?: string | null) => void;
}) {
  const [notes, setNotes] = useState(labelNotes ?? '');
  const [confidence, setConfidence] = useState(labelConfidence ?? '');

  const handleLabel = (l: DatasetLabel) => {
    onLabel(datasetCaseId, l, notes || undefined, confidence || null);
  };

  return (
    <div className="border-t pt-4 space-y-3">
      <h4 className="text-sm font-medium text-gray-700">Label</h4>
      <div className="flex items-center gap-2">
        <Button size="sm" variant={label === 'credit' ? 'default' : 'outline'} onClick={() => handleLabel('credit')}>Credit</Button>
        <Button size="sm" variant={label === 'escalate' ? 'default' : 'outline'} onClick={() => handleLabel('escalate')}>Escalate</Button>
        <Button size="sm" variant={label === 'undecided' ? 'default' : 'outline'} onClick={() => handleLabel('undecided')}>Can't decide</Button>
        <Select className="h-8 text-xs w-[100px]" value={confidence} onChange={(e) => setConfidence(e.target.value)}>
          <option value="">Confidence</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </Select>
      </div>
      <textarea
        placeholder="Notes (optional)"
        rows={3  }
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        onBlur={() => { if (label) onLabel(datasetCaseId, label, notes || undefined, confidence || null); }}
        className="rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground resize-y min-h-[36px] w-full"
      />
    </div>
  );
}

function DatasetLabel2Controls({
  datasetCaseId,
  label2,
  label2Notes,
  label2Confidence,
  onLabel2,
}: {
  datasetCaseId: number;
  label2: DatasetLabel | null;
  label2Notes: string | null;
  label2Confidence: string | null;
  onLabel2: (id: number, label: DatasetLabel, notes?: string, confidence?: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState(label2Notes ?? '');
  const [confidence, setConfidence] = useState(label2Confidence ?? '');

  const handleLabel = (l: DatasetLabel) => {
    onLabel2(datasetCaseId, l, notes || undefined, confidence || null);
  };

  return (
    <div className="border-t pt-4 space-y-2">
      <button className="text-sm font-medium text-gray-500 hover:text-gray-700 flex items-center gap-1" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        Second Labeler {label2 && <Badge variant={LABEL_BADGE[label2].variant} className="ml-1">{LABEL_BADGE[label2].label}</Badge>}
      </button>
      {open && (
        <div className="space-y-2 ml-4">
          <div className="flex items-center gap-2">
            <Button size="sm" variant={label2 === 'credit' ? 'default' : 'outline'} onClick={() => handleLabel('credit')}>Credit</Button>
            <Button size="sm" variant={label2 === 'escalate' ? 'default' : 'outline'} onClick={() => handleLabel('escalate')}>Escalate</Button>
            <Button size="sm" variant={label2 === 'undecided' ? 'default' : 'outline'} onClick={() => handleLabel('undecided')}>Can't decide</Button>
            <Select className="h-8 text-xs w-[100px]" value={confidence} onChange={(e) => setConfidence(e.target.value)}>
              <option value="">Confidence</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </Select>
          </div>
          <Input
            placeholder="Notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => { if (label2) onLabel2(datasetCaseId, label2, notes || undefined, confidence || null); }}
            className="text-sm"
          />
        </div>
      )}
    </div>
  );
}

function TagSuggestInput({
  value,
  onChange,
  suggestions = [],
  existingTags,
  onAdd,
}: {
  value: string;
  onChange: (v: string) => void;
  suggestions?: string[];
  existingTags: string[];
  onAdd: (tag: string) => void;
}) {
  const [focused, setFocused] = useState(false);

  const filtered = value.trim()
    ? suggestions.filter((s) => !existingTags.includes(s) && s.toLowerCase().includes(value.trim().toLowerCase()))
    : suggestions.filter((s) => !existingTags.includes(s));

  const showSuggestions = focused && filtered.length > 0;

  return (
    <div className="relative">
      <Input
        className="h-7 text-xs w-32"
        placeholder="Add tag..."
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && value.trim()) { e.preventDefault(); onAdd(value.trim()); }
          if (e.key === 'Escape') onChange('');
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 150)}
      />
      {showSuggestions && (
        <div className="absolute top-full left-0 mt-1 z-50 bg-white border border-gray-200 rounded shadow-lg max-h-40 overflow-y-auto min-w-[160px]">
          {filtered.map((s) => (
            <button
              key={s}
              type="button"
              className="block w-full text-left px-2 py-1 text-xs hover:bg-gray-100"
              onMouseDown={(e) => { e.preventDefault(); onAdd(s); }}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TagControls({
  datasetCaseId,
  tags,
  onTagCase,
  suggestions = [],
}: {
  datasetCaseId: number;
  tags: string[];
  onTagCase: (id: number, tags: string[]) => void;
  suggestions?: string[];
}) {
  const [newTag, setNewTag] = useState('');
  const [focused, setFocused] = useState(false);

  const addTag = (value?: string) => {
    const tag = (value ?? newTag).trim();
    if (tag && !tags.includes(tag)) {
      onTagCase(datasetCaseId, [...tags, tag]);
    }
    setNewTag('');
  };

  const filtered = newTag.trim()
    ? suggestions.filter((s) => !tags.includes(s) && s.toLowerCase().includes(newTag.trim().toLowerCase()))
    : suggestions.filter((s) => !tags.includes(s));

  const showSuggestions = focused && filtered.length > 0;

  return (
    <div className="border-t pt-4 space-y-2">
      <h4 className="text-sm font-medium text-gray-700">Tags</h4>
      <div className="flex flex-wrap gap-1">
        {tags.map((tag) => (
          <Badge key={tag} variant="gray" className="cursor-pointer" onClick={() => onTagCase(datasetCaseId, tags.filter((t) => t !== tag))}>
            {tag} <X className="h-3 w-3 ml-1" />
          </Badge>
        ))}
        <div className="relative">
          <Input
            className="h-6 w-24 text-xs"
            placeholder="+ tag"
            value={newTag}
            onChange={(e) => setNewTag(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } if (e.key === 'Escape') setNewTag(''); }}
            onFocus={() => setFocused(true)}
            onBlur={() => { setTimeout(() => setFocused(false), 150); if (newTag.trim()) addTag(); }}
          />
          {showSuggestions && (
            <div className="absolute top-full left-0 mt-1 z-50 bg-white border border-gray-200 rounded shadow-lg max-h-40 overflow-y-auto min-w-[160px]">
              {filtered.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="block w-full text-left px-2 py-1 text-xs hover:bg-gray-100"
                  onMouseDown={(e) => { e.preventDefault(); addTag(s); }}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

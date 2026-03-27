import type { PipelineRunRow } from '../types/dispute-pipeline.js';

export function deriveAutoTags(run: PipelineRunRow): Record<string, string | boolean> {
  const score = run.dispute_profile.rubric_score;
  const scoreBucket = score >= 70 ? '70-108' : score >= 40 ? '40-69' : '0-39';

  return {
    risk_level: run.dispute_profile.risk_level,
    amount_bucket: 'under_25',
    rubric_score_bucket: scoreBucket,
    hard_gate_hit: run.hard_gate_triggered != null,
    dispute_type: run.planner_output?.args?.fraud_type ?? 'unknown',
    dispute_sub_type: run.planner_output?.args?.fraud_sub_type ?? 'unknown',
    has_uncertainty: (run.planner_output?.uncertainty_factors?.length ?? 0) > 0,
    merchant: run.raw_signals.merchants,
  };
}

export interface SegmentMetrics {
  sample_size: number;
  agreement_rate: number | null;
  credit_precision: number | null;
  escalate_recall: number | null;
  false_credit_rate: number | null;
}

export interface ConfusionMatrix {
  true_credit: number;
  false_credit: number;
  true_escalate: number;
  false_escalate: number;
  unlabeled: number;
  undecided: number;
}

export interface DisagreementBreakdown {
  [reason: string]: { count: number; percentage: number };
}

export interface InterAnnotatorAgreement {
  kappa: number | null;
  agreement_rate: number | null;
  dual_labeled_count: number;
}

export interface DatasetAnalyticsResult {
  confusion_matrix: ConfusionMatrix;
  overall: SegmentMetrics;
  stratified: {
    by_risk_level: Record<string, SegmentMetrics>;
    by_dispute_type: Record<string, SegmentMetrics>;
    by_hard_gate: Record<string, SegmentMetrics>;
    by_rubric_bucket: Record<string, SegmentMetrics>;
    by_label_confidence: Record<string, SegmentMetrics>;
  };
  disagreement_breakdown: DisagreementBreakdown;
  inter_annotator: InterAnnotatorAgreement | null;
}

export interface AnalyticsRow {
  auto_tags: Record<string, string | boolean>;
  label: string | null;
  pipeline_decision: string | null;
  hard_gate_triggered: string | null;
  label_confidence: string | null;
  disagreement_reason: string | null;
  label_2: string | null;
}

function computeSegmentMetrics(rows: AnalyticsRow[]): SegmentMetrics {
  let trueCredit = 0, falseCredit = 0, trueEscalate = 0, _falseEscalate = 0;
  let sampleSize = 0;

  for (const r of rows) {
    if (!r.label || r.label === 'undecided') continue;
    const pipelineEscalated = r.hard_gate_triggered != null || r.pipeline_decision === 'escalate_to_agent';
    const pipelineCredited = !pipelineEscalated && r.pipeline_decision === 'credit';

    if (r.pipeline_decision == null && r.hard_gate_triggered == null) continue; // no pipeline result

    sampleSize++;
    if (r.label === 'credit' && pipelineCredited) trueCredit++;
    else if (r.label === 'escalate' && pipelineCredited) falseCredit++;
    else if (r.label === 'escalate' && pipelineEscalated) trueEscalate++;
    else if (r.label === 'credit' && pipelineEscalated) _falseEscalate++;
  }

  const totalPredictedCredit = trueCredit + falseCredit;
  const totalLabeledEscalate = trueEscalate + falseCredit;
  const totalCorrect = trueCredit + trueEscalate;

  return {
    sample_size: sampleSize,
    agreement_rate: sampleSize > 0 ? round((totalCorrect / sampleSize) * 100) : null,
    credit_precision: totalPredictedCredit > 0 ? round((trueCredit / totalPredictedCredit) * 100) : null,
    escalate_recall: totalLabeledEscalate > 0 ? round((trueEscalate / totalLabeledEscalate) * 100) : null,
    false_credit_rate: totalPredictedCredit > 0 ? round((falseCredit / totalPredictedCredit) * 100) : null,
  };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function computeDisagreementBreakdown(rows: AnalyticsRow[]): DisagreementBreakdown {
  const counts: Record<string, number> = {};
  let totalDisagreements = 0;

  for (const r of rows) {
    if (!r.label || r.label === 'undecided') continue;
    const pipelineEscalated = r.hard_gate_triggered != null || r.pipeline_decision === 'escalate_to_agent';
    const pipelineCredited = !pipelineEscalated && r.pipeline_decision === 'credit';
    if (r.pipeline_decision == null && r.hard_gate_triggered == null) continue;

    const isDisagreement =
      (r.label === 'credit' && !pipelineCredited) ||
      (r.label === 'escalate' && !pipelineEscalated);

    if (isDisagreement) {
      totalDisagreements++;
      const reason = r.disagreement_reason ?? 'no_reason';
      counts[reason] = (counts[reason] ?? 0) + 1;
    }
  }

  const result: DisagreementBreakdown = {};
  for (const [reason, count] of Object.entries(counts)) {
    result[reason] = {
      count,
      percentage: totalDisagreements > 0 ? round((count / totalDisagreements) * 100) : 0,
    };
  }
  return result;
}

export function computeFullAnalytics(
  confusionMatrix: ConfusionMatrix,
  rows: AnalyticsRow[],
): DatasetAnalyticsResult {
  const overall = computeSegmentMetrics(rows);

  // Group by dimensions
  const byRiskLevel: Record<string, AnalyticsRow[]> = {};
  const byDisputeType: Record<string, AnalyticsRow[]> = {};
  const byHardGate: Record<string, AnalyticsRow[]> = {};
  const byRubricBucket: Record<string, AnalyticsRow[]> = {};
  const byLabelConfidence: Record<string, AnalyticsRow[]> = {};

  for (const r of rows) {
    const tags = r.auto_tags ?? {};
    const riskLevel = String(tags.risk_level ?? 'unknown');
    const disputeType = String(tags.dispute_type ?? 'unknown');
    const hardGate = tags.hard_gate_hit ? 'hit' : 'clear';
    const rubricBucket = String(tags.rubric_score_bucket ?? 'unknown');

    (byRiskLevel[riskLevel] ??= []).push(r);
    (byDisputeType[disputeType] ??= []).push(r);
    (byHardGate[hardGate] ??= []).push(r);
    (byRubricBucket[rubricBucket] ??= []).push(r);

    if (r.label_confidence) {
      (byLabelConfidence[r.label_confidence] ??= []).push(r);
    }
  }

  return {
    confusion_matrix: confusionMatrix,
    overall,
    stratified: {
      by_risk_level: mapValues(byRiskLevel, computeSegmentMetrics),
      by_dispute_type: mapValues(byDisputeType, computeSegmentMetrics),
      by_hard_gate: mapValues(byHardGate, computeSegmentMetrics),
      by_rubric_bucket: mapValues(byRubricBucket, computeSegmentMetrics),
      by_label_confidence: mapValues(byLabelConfidence, computeSegmentMetrics),
    },
    disagreement_breakdown: computeDisagreementBreakdown(rows),
    inter_annotator: computeInterAnnotator(rows),
  };
}

function computeInterAnnotator(rows: AnalyticsRow[]): InterAnnotatorAgreement | null {
  // Only consider cases with both labels, excluding 'undecided'
  const dualLabeled = rows.filter(
    (r) => r.label && r.label !== 'undecided' && r.label_2 && r.label_2 !== 'undecided',
  );

  if (dualLabeled.length === 0) return null;

  const n = dualLabeled.length;
  let agreed = 0;
  const label1Counts: Record<string, number> = {};
  const label2Counts: Record<string, number> = {};

  for (const r of dualLabeled) {
    const l1 = r.label!;
    const l2 = r.label_2!;
    if (l1 === l2) agreed++;
    label1Counts[l1] = (label1Counts[l1] ?? 0) + 1;
    label2Counts[l2] = (label2Counts[l2] ?? 0) + 1;
  }

  const p_o = agreed / n; // observed agreement

  // Expected agreement by chance
  const categories = [...new Set([...Object.keys(label1Counts), ...Object.keys(label2Counts)])];
  let p_e = 0;
  for (const cat of categories) {
    p_e += ((label1Counts[cat] ?? 0) / n) * ((label2Counts[cat] ?? 0) / n);
  }

  const kappa = p_e < 1 ? round((p_o - p_e) / (1 - p_e)) : (p_o === 1 ? 1 : null);

  return {
    kappa,
    agreement_rate: round(p_o * 100),
    dual_labeled_count: n,
  };
}

function mapValues<V, R>(obj: Record<string, V>, fn: (v: V) => R): Record<string, R> {
  const result: Record<string, R> = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = fn(v);
  }
  return result;
}

// --- Run Comparison ---

import type { ComparisonRow } from './db.js';

export interface FlippedCase {
  caseId: number;
  datasetCaseId: number;
  label: string | null;
  runA_decision: string;
  runB_decision: string;
  direction: 'improved' | 'regressed' | 'changed';
}

export interface RunComparisonResult {
  summary: {
    runA: SegmentMetrics;
    runB: SegmentMetrics;
    delta: {
      agreement_rate: number | null;
      credit_precision: number | null;
      escalate_recall: number | null;
      false_credit_rate: number | null;
    };
  };
  flipped_cases: FlippedCase[];
  net_improvement: number;
}

function resolveDecision(decision: string | null, hardGate: string | null): 'credit' | 'escalate' {
  if (hardGate != null) return 'escalate';
  return decision === 'credit' ? 'credit' : 'escalate';
}

function isCorrect(label: string | null, pipelineDecision: 'credit' | 'escalate'): boolean | null {
  if (!label || label === 'undecided') return null;
  if (label === 'credit' && pipelineDecision === 'credit') return true;
  if (label === 'escalate' && pipelineDecision === 'escalate') return true;
  return false;
}

function computeMetricsFromComparison(
  rows: ComparisonRow[],
  decisionKey: 'a' | 'b',
): SegmentMetrics {
  let trueCredit = 0, falseCredit = 0, trueEscalate = 0, _falseEscalate = 0;
  let sampleSize = 0;

  for (const r of rows) {
    if (!r.label || r.label === 'undecided') continue;
    const decision = decisionKey === 'a'
      ? resolveDecision(r.run_a_decision, r.run_a_hard_gate)
      : resolveDecision(r.run_b_decision, r.run_b_hard_gate);

    sampleSize++;
    if (r.label === 'credit' && decision === 'credit') trueCredit++;
    else if (r.label === 'escalate' && decision === 'credit') falseCredit++;
    else if (r.label === 'escalate' && decision === 'escalate') trueEscalate++;
    else if (r.label === 'credit' && decision === 'escalate') _falseEscalate++;
  }

  const totalPredictedCredit = trueCredit + falseCredit;
  const totalLabeledEscalate = trueEscalate + falseCredit;
  const totalCorrect = trueCredit + trueEscalate;

  return {
    sample_size: sampleSize,
    agreement_rate: sampleSize > 0 ? round((totalCorrect / sampleSize) * 100) : null,
    credit_precision: totalPredictedCredit > 0 ? round((trueCredit / totalPredictedCredit) * 100) : null,
    escalate_recall: totalLabeledEscalate > 0 ? round((trueEscalate / totalLabeledEscalate) * 100) : null,
    false_credit_rate: totalPredictedCredit > 0 ? round((falseCredit / totalPredictedCredit) * 100) : null,
  };
}

function computeDelta(a: number | null, b: number | null): number | null {
  if (a == null || b == null) return null;
  return round(b - a);
}

export function computeRunComparison(rows: ComparisonRow[]): RunComparisonResult {
  const runA = computeMetricsFromComparison(rows, 'a');
  const runB = computeMetricsFromComparison(rows, 'b');

  const flipped_cases: FlippedCase[] = [];
  let improved = 0, regressed = 0;

  for (const r of rows) {
    const decA = resolveDecision(r.run_a_decision, r.run_a_hard_gate);
    const decB = resolveDecision(r.run_b_decision, r.run_b_hard_gate);

    if (decA === decB) continue; // no flip

    const correctA = isCorrect(r.label, decA);
    const correctB = isCorrect(r.label, decB);

    let direction: 'improved' | 'regressed' | 'changed';
    if (correctA === false && correctB === true) {
      direction = 'improved';
      improved++;
    } else if (correctA === true && correctB === false) {
      direction = 'regressed';
      regressed++;
    } else {
      direction = 'changed';
    }

    flipped_cases.push({
      caseId: r.case_id,
      datasetCaseId: r.dataset_case_id,
      label: r.label,
      runA_decision: decA,
      runB_decision: decB,
      direction,
    });
  }

  return {
    summary: {
      runA,
      runB,
      delta: {
        agreement_rate: computeDelta(runA.agreement_rate, runB.agreement_rate),
        credit_precision: computeDelta(runA.credit_precision, runB.credit_precision),
        escalate_recall: computeDelta(runA.escalate_recall, runB.escalate_recall),
        false_credit_rate: computeDelta(runA.false_credit_rate, runB.false_credit_rate),
      },
    },
    flipped_cases,
    net_improvement: improved - regressed,
  };
}

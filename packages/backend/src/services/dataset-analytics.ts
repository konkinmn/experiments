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
  needs_more_info: number;
}

export interface DatasetAnalyticsResult {
  confusion_matrix: ConfusionMatrix;
  overall: SegmentMetrics;
  stratified: {
    by_risk_level: Record<string, SegmentMetrics>;
    by_dispute_type: Record<string, SegmentMetrics>;
    by_hard_gate: Record<string, SegmentMetrics>;
    by_rubric_bucket: Record<string, SegmentMetrics>;
  };
}

export interface AnalyticsRow {
  auto_tags: Record<string, string | boolean>;
  label: string | null;
  pipeline_decision: string | null;
  hard_gate_triggered: string | null;
}

function computeSegmentMetrics(rows: AnalyticsRow[]): SegmentMetrics {
  let trueCredit = 0, falseCredit = 0, trueEscalate = 0, falseEscalate = 0;
  let sampleSize = 0;

  for (const r of rows) {
    if (!r.label || r.label === 'needs_more_info') continue;
    const pipelineEscalated = r.hard_gate_triggered != null || r.pipeline_decision === 'escalate_to_agent';
    const pipelineCredited = !pipelineEscalated && r.pipeline_decision === 'credit';

    if (r.pipeline_decision == null && r.hard_gate_triggered == null) continue; // no pipeline result

    sampleSize++;
    if (r.label === 'credit' && pipelineCredited) trueCredit++;
    else if (r.label === 'escalate' && pipelineCredited) falseCredit++;
    else if (r.label === 'escalate' && pipelineEscalated) trueEscalate++;
    else if (r.label === 'credit' && pipelineEscalated) falseEscalate++;
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
  }

  return {
    confusion_matrix: confusionMatrix,
    overall,
    stratified: {
      by_risk_level: mapValues(byRiskLevel, computeSegmentMetrics),
      by_dispute_type: mapValues(byDisputeType, computeSegmentMetrics),
      by_hard_gate: mapValues(byHardGate, computeSegmentMetrics),
      by_rubric_bucket: mapValues(byRubricBucket, computeSegmentMetrics),
    },
  };
}

function mapValues<V, R>(obj: Record<string, V>, fn: (v: V) => R): Record<string, R> {
  const result: Record<string, R> = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = fn(v);
  }
  return result;
}

import { FlaskConical, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RubricForm, ResultsTable, SessionSummary } from '@/components/rubric-tester';
import { usePipelineResults, useRunPipeline, useSubmitReview, useDeletePipelineRun } from '@/hooks/useDisputePipeline';
import { downloadXlsx, type ColumnDef } from '@/lib/download-xlsx';
import type { PipelineResult } from '@/types';

const EXPORT_COLUMNS: ColumnDef<PipelineResult>[] = [
  { header: 'Case ID', accessor: (r) => r.caseId },
  { header: 'Risk Level', accessor: (r) => r.disputeProfile.risk_level },
  // Raw BQ values
  { header: 'Company ID', accessor: (r) => r.rawSignals.company_id },
  { header: 'Alias', accessor: (r) => r.rawSignals.alias },
  { header: 'Case Created', accessor: (r) => r.rawSignals.case_created_at },
  { header: 'Total Amount', accessor: (r) => r.rawSignals.total_amount },
  { header: 'Max Txn Amount', accessor: (r) => r.rawSignals.max_transaction_amount },
  { header: 'Merchants', accessor: (r) => r.rawSignals.merchants },
  { header: 'Account Age (days)', accessor: (r) => r.rawSignals.account_age_days },
  { header: 'Account Status', accessor: (r) => r.rawSignals.account_status },
  { header: 'CIFAS Count', accessor: (r) => r.rawSignals.cifas_count },
  { header: 'Tier', accessor: (r) => r.rawSignals.tier_name },
  { header: 'Money Maker', accessor: (r) => r.rawSignals.is_money_maker },
  { header: 'Trust Score', accessor: (r) => r.rawSignals.trust_score },
  { header: 'Scammer Count', accessor: (r) => r.rawSignals.scammer_count },
  { header: 'Scam Victim Count', accessor: (r) => r.rawSignals.scam_victim_count },
  { header: 'Txns (90d)', accessor: (r) => r.rawSignals.tx_count_90_days },
  { header: 'Railsr Disputes (6m)', accessor: (r) => r.rawSignals.railsr_disputes_last_6_months },
  { header: 'Railsr Disputes (30d)', accessor: (r) => r.rawSignals.railsr_disputes_last_30_days },
  // Pipeline results
  { header: 'Hard Gate', accessor: (r) => r.hardGateTriggered ?? '' },
  { header: 'Decision', accessor: (r) => r.plannerOutput?.decision ?? (r.hardGateTriggered ? 'hard_gate' : '') },
  { header: 'Credit Timing', accessor: (r) => r.plannerOutput?.credit_timing ?? '' },
  { header: 'Reason', accessor: (r) => r.plannerOutput?.args?.reason ?? '' },
  { header: 'Is Fraud', accessor: (r) => r.plannerOutput?.args?.is_fraud ?? '' },
  { header: 'Thought', accessor: (r) => r.plannerOutput?.thought ?? '' },
  { header: 'Uncertainty Factors', accessor: (r) => r.plannerOutput?.uncertainty_factors?.join('; ') ?? '' },
  { header: 'Duration (ms)', accessor: (r) => r.pipelineDurationMs },
  { header: 'Reviewer Verdict', accessor: (r) => r.reviewerVerdict ?? '' },
  { header: 'Reviewer Notes', accessor: (r) => r.reviewerNotes ?? '' },
];

export function RubricTester() {
  const { data: results = [] } = usePipelineResults();
  const runPipeline = useRunPipeline();
  const submitReview = useSubmitReview();
  const deleteRun = useDeletePipelineRun();

  const handleSubmit = async (caseId: number) => {
    await runPipeline.mutateAsync(caseId);
  };

  const handleReview = (id: number, verdict: 'correct' | 'incorrect', notes?: string) => {
    submitReview.mutate({ id, verdict, notes });
  };

  const handleDelete = (id: number) => {
    deleteRun.mutate(id);
  };

  const handleExport = () => {
    downloadXlsx(results, EXPORT_COLUMNS, 'dispute-pipeline-results');
  };

  return (
    <div className="flex-1 p-6 bg-gray-50 overflow-auto">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-blue-100 flex items-center justify-center">
              <FlaskConical className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold text-gray-900">Dispute Agent Eval</h1>
              <p className="text-sm text-gray-500">
                Test the dispute pipeline against real cases — shadow mode (Phase 1)
              </p>
            </div>
          </div>
          {results.length > 0 && (
            <Button variant="outline" onClick={handleExport}>
              <Download className="h-4 w-4 mr-2" />
              Export
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-6">
        {/* Form */}
        <RubricForm onSubmit={handleSubmit} isPending={runPipeline.isPending} />

        {runPipeline.isError && (
          <p className="text-sm text-red-600">
            {runPipeline.error?.message?.includes('404')
              ? 'Case not found'
              : `Pipeline error: ${runPipeline.error?.message}`}
          </p>
        )}

        {/* Session Summary */}
        <SessionSummary results={results} />

        {/* Results Table */}
        <ResultsTable
          results={results}
          onDelete={handleDelete}
          onReview={handleReview}
        />
      </div>
    </div>
  );
}

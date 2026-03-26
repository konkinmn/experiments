import type { PipelineResult } from './rubric-tester';

export type DatasetLabel = 'credit' | 'escalate' | 'needs_more_info';

export interface DatasetCase {
  id: number;
  caseId: number;
  segment: string;
  pipelineRunId: number | null;
  pipelineRun: PipelineResult | null;
  label: DatasetLabel | null;
  labelNotes: string | null;
  labeledBy: string | null;
  labeledAt: string | null;
  createdAt: string;
}

export interface SegmentInfo {
  key: string;
  label: string;
  description: string;
  labeledCount: number;
  totalCount: number;
}

export type QueueRunStatus = 'running' | 'ready' | 'error';
export type Urgency = 'high' | 'medium' | 'low';
export type TaskStatus =
  | 'ready'
  | 'waiting_customer'
  | 'waiting_third_party'
  | 'needs_info'
  | 'actionable_now';

export interface QueueGroup {
  groupId: string;
  name: string;
  priority: number;
}

export interface WorkGroup {
  name: string;
  kind: string;
  isNewKind: boolean;
  disposition: string;
  urgency: Urgency;
  quickWin: boolean;
  slaDays: number | null;
  theWork: string;
  destination: string | null;
  kbRef: string | null;
  count: number;
  totalBalance: number;
  memberTaskIds: number[];
}

export interface QueueRun {
  id: number;
  groupId: string;
  groupName: string;
  model: string | null;
  promptMd5: string | null;
  status: QueueRunStatus;
  nTasks: number;
  nHighUrgency: number;
  totalResidualBalance: number | null;
  nSafeClose: number;
  nQuickWins: number;
  nOverdue: number;
  nWrongQueue: number;
  summary: string | null;
  groups: WorkGroup[];
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface QueueTask {
  id: number;
  runId: number;
  taskId: number;
  wsLink: string | null;
  alias: string | null;
  title: string | null;
  taskType: string | null;
  ageDays: number | null;
  createdBy: string | null;
  takenBy: string | null;
  rbJiraSync: boolean | null;
  nCases: number | null;
  nActive: number | null;
  nDone: number | null;
  caseStatuses: string | null;
  balance: number | null;
  currency: string | null;
  accountStatuses: string | null;
  accountClosed: boolean | null;
  companyStatus: string | null;
  dateCeasedOn: string | null;
  daysSinceCessation: number | null;
  companyNumber: string | null;
  companyTitle: string | null;
  nAliasOpen: number | null;
  nAliasClosed: number | null;
  hasAttachments: boolean | null;
  groupName: string | null;
  kind: string | null;
  isNewKind: boolean | null;
  disposition: string | null;
  theWork: string | null;
  urgency: Urgency | null;
  quickWin: boolean | null;
  status: TaskStatus | null;
  slaDays: number | null;
  slaStatus: string | null;
  wrongQueue: boolean | null;
  suggestedQueue: string | null;
  destination: string | null;
  kbRef: string | null;
  suggestedAction: string | null;
  rationale: string | null;
  caseContext: string | null;
  createdAt: string;
}

export interface QueueRunsResponse {
  data: QueueRun[];
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface QueueTaskFilters {
  urgency?: Urgency;
  quickWin?: boolean;
  status?: TaskStatus;
  kind?: string;
  wrongQueue?: boolean;
  groupName?: string;
}

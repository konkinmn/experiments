export type CaseBrowserSortField = 'createdAt' | 'refId' | 'status' | 'riskScore';

export interface CaseBrowserItem {
  id: string;
  refId: string | null;
  alias: string | null;
  issueType: string | null;
  businessArea: string | null;
  status: string;
  outcome: string | null;
  owner: string | null;
  decision: string | null;
  riskLevel: string | null;
  riskScore: number | null;
  trigger: string | null;
  hasAssessment: boolean;
  createdAt: string;
}

export interface CaseBrowserListParams {
  startDate: string;
  endDate: string;
  page?: number;
  pageSize?: number;
  search?: string;
  issueType?: string;
  businessArea?: string;
  status?: 'IN_PROGRESS' | 'RESOLVED' | 'DISMISSED';
  outcome?: string;
  owner?: string;
  hasAssessment?: 'true' | 'false';
  decision?: 'CREDIT' | 'ESCALATE';
  riskLevel?: 'green' | 'amber' | 'red';
  trigger?: string;
  sortBy?: CaseBrowserSortField;
  sortOrder?: 'asc' | 'desc';
}

export interface CaseBrowserListResponse {
  data: CaseBrowserItem[];
  count: number;
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface CaseBrowserIdsResponse {
  data: {
    ids: number[];
    totalMatching: number;
    returned: number;
    capped: boolean;
    limit: number;
  };
}

export interface CaseRecord {
  id: string;
  refId: string | null;
  alias: string | null;
  status: string;
  outcome: string | null;
  issueTypeId: string | null;
  businessAreaId: string | null;
  owner: string | null;
  summary: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface AssessmentRecord {
  id: string;
  decision: string | null;
  riskLevel: string | null;
  riskScore: number | null;
  trigger: string | null;
  status: string;
  durationMs: number | null;
  error: string | null;
  data: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export type SenderType = 'customer' | 'operator' | 'bot';
export type DialogueRole = 'prior' | 'active' | 'after';

export interface MessageRecord {
  messageNum: number | null;
  timestamp: string;
  senderType: SenderType;
  senderAlias: string | null;
  senderName: string | null;
  text: string | null;
  skillRoute: string | null;
  payloadTemplateType: string | null;
  files: string | null;
  isHidden: boolean;
  channel: string | null;
}

export interface DialogueRecord {
  id: string;
  type: string | null;
  status: string | null;
  lastAgent: string | null;
  lastAgentName: string | null;
  dialogueRole: DialogueRole;
  attached: boolean;
  createdAt: string;
  closedAt: string | null;
  messages: MessageRecord[];
  messageCounts: { customer: number; operator: number; bot: number };
}

export interface CommentRecord {
  id: string;
  parentCommentId: string | null;
  body: string | null;
  authorAlias: string | null;
  authorName: string | null;
  createdAt: string;
}

export interface ArtifactRecord {
  id: string;
  artifactType: string | null;
  artifactId: string | null;
  createdAt: string;
  form: {
    type: string | null;
    status: string | null;
    title: string | null;
    fields: string | null;
    uploadedAt: string | null;
  } | null;
}

export interface CaseEventRecord {
  id: string;
  eventType: string | null;
  actorAlias: string | null;
  metadata: string | null;
  createdAt: string;
}

export interface CaseBundle {
  case: CaseRecord | null;
  assessment: AssessmentRecord | null;
  dialogues: DialogueRecord[];
  comments: CommentRecord[];
  artifacts: ArtifactRecord[];
  events: CaseEventRecord[];
  dataFreshness: { messagesSource: 'bq'; bqMaxTimestamp: string | null };
  exportedAt: string;
}

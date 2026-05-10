import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getBigQueryService } from '../services/bigquery.js';

const CASE_TABLE = 'case_case';
const ASSESSMENT_TABLE = 'case_case_dispute_assessment';
const EVENT_TABLE = 'case_case_event';
const ARTIFACT_TABLE = 'case_case_artifact';
const TASKS_TABLE = 'task_manager_tasks';
const COMMENT_TABLE = 'comment_comment';
const AGENT_TABLE = 'agent_agent';
const FORMS_TABLE = 'forms_form';
const VERIFIED_DATASET = 'verified_tables';
const MESSAGES_TABLE = 'assistance_processed_message';

const DIALOGUES_BEFORE = 10;
const DIALOGUES_AFTER = 10;
const MESSAGE_WINDOW_BUFFER_DAYS = 1;
const BULK_EXPORT_LIMIT = 500;
const BULK_CONCURRENCY = 4;
const FRESHNESS_CACHE_MS = 60 * 60 * 1000;

const DateRangeSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD format'),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD format'),
});

const CaseBrowserListQuerySchema = DateRangeSchema.extend({
  page: z.coerce.number().int().positive().optional().default(1),
  pageSize: z.coerce.number().int().positive().max(100).optional().default(20),
  search: z.string().optional(),
  issueType: z.string().optional(),
  businessArea: z.string().optional(),
  status: z.enum(['IN_PROGRESS', 'RESOLVED', 'DISMISSED']).optional(),
  outcome: z.string().optional(),
  owner: z.string().optional(),
  hasAssessment: z.enum(['true', 'false']).optional(),
  decision: z.enum(['CREDIT', 'ESCALATE']).optional(),
  riskLevel: z.enum(['green', 'amber', 'red']).optional(),
  trigger: z.string().optional(),
  sortBy: z.enum(['createdAt', 'refId', 'status', 'riskScore']).optional().default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
});

const BulkExportSchema = z.object({
  caseIds: z.array(z.coerce.number().int().positive()).min(1).max(BULK_EXPORT_LIMIT),
});

interface CaseBrowserItem {
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

interface CaseBundle {
  case: CaseRecord | null;
  assessment: AssessmentRecord | null;
  dialogues: DialogueWithMessages[];
  comments: CommentRecord[];
  artifacts: ArtifactRecord[];
  events: EventRecord[];
  dataFreshness: { messagesSource: 'bq'; bqMaxTimestamp: string | null };
  exportedAt: string;
}

interface CaseRecord {
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

interface AssessmentRecord {
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

interface DialogueRow {
  id: string;
  type: string | null;
  status: string | null;
  lastAgent: string | null;
  lastAgentName: string | null;
  dialogueRole: 'prior' | 'active' | 'after';
  attached: boolean;
  createdAt: string;
  closedAt: string | null;
}

interface MessageRow {
  taskId: string;
  messageNum: number | null;
  timestamp: string;
  senderType: 'customer' | 'operator' | 'bot';
  senderAlias: string | null;
  senderName: string | null;
  text: string | null;
  skillRoute: string | null;
  payloadTemplateType: string | null;
  files: string | null;
  isHidden: boolean;
  channel: string | null;
}

interface DialogueWithMessages extends DialogueRow {
  messages: Omit<MessageRow, 'taskId'>[];
  messageCounts: { customer: number; operator: number; bot: number };
}

interface CommentRecord {
  id: string;
  parentCommentId: string | null;
  body: string | null;
  authorAlias: string | null;
  authorName: string | null;
  createdAt: string;
}

interface ArtifactRecord {
  id: string;
  artifactType: string | null;
  artifactId: string | null;
  createdAt: string;
  form: { type: string | null; status: string | null; title: string | null; fields: string | null; uploadedAt: string | null } | null;
}

interface EventRecord {
  id: string;
  eventType: string | null;
  actorAlias: string | null;
  metadata: string | null;
  createdAt: string;
}

let cachedMaxTs: { ts: string | null; fetchedAt: number } | null = null;

export async function caseBrowserRoutes(app: FastifyInstance) {
  const bq = getBigQueryService();
  const projectId = bq.getProjectId();
  const dataset = bq.getDataset();

  const caseTable = `\`${projectId}.${dataset}.${CASE_TABLE}\``;
  const assessmentTable = `\`${projectId}.${dataset}.${ASSESSMENT_TABLE}\``;
  const eventTable = `\`${projectId}.${dataset}.${EVENT_TABLE}\``;
  const artifactTable = `\`${projectId}.${dataset}.${ARTIFACT_TABLE}\``;
  const tasksTable = `\`${projectId}.${dataset}.${TASKS_TABLE}\``;
  const commentTable = `\`${projectId}.${dataset}.${COMMENT_TABLE}\``;
  const agentTable = `\`${projectId}.${dataset}.${AGENT_TABLE}\``;
  const formsTable = `\`${projectId}.${dataset}.${FORMS_TABLE}\``;
  const messagesTable = `\`${projectId}.${VERIFIED_DATASET}.${MESSAGES_TABLE}\``;

  async function getBqMaxTimestamp(): Promise<string | null> {
    const now = Date.now();
    if (cachedMaxTs && now - cachedMaxTs.fetchedAt < FRESHNESS_CACHE_MS) {
      return cachedMaxTs.ts;
    }
    const sql = `
      SELECT FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', MAX(timestamp)) AS maxTs
      FROM ${messagesTable}
      WHERE DATE(timestamp) >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)
    `;
    try {
      const rows = await bq.query<{ maxTs: string | null }>(sql);
      cachedMaxTs = { ts: rows[0]?.maxTs ?? null, fetchedAt: now };
    } catch (err) {
      app.log.warn({ err }, 'Failed to fetch BQ message freshness');
      cachedMaxTs = { ts: null, fetchedAt: now };
    }
    return cachedMaxTs.ts;
  }

  async function buildCaseBundle(caseId: number): Promise<CaseBundle> {
    const caseSql = `
      SELECT
        CAST(id AS STRING) AS id,
        ref_id AS refId,
        alias AS alias,
        COALESCE(status, '') AS status,
        outcome AS outcome,
        issue_type_id AS issueTypeId,
        business_area_id AS businessAreaId,
        owner AS owner,
        summary AS summary,
        FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', created_at) AS createdAt,
        FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', updated_at) AS updatedAt
      FROM ${caseTable}
      WHERE id = @caseId
      LIMIT 1
    `;
    const caseRows = await bq.query<CaseRecord>(caseSql, { caseId });
    const caseRecord = caseRows[0] ?? null;

    if (!caseRecord) {
      const exportedAt = new Date().toISOString();
      return {
        case: null,
        assessment: null,
        dialogues: [],
        comments: [],
        artifacts: [],
        events: [],
        dataFreshness: { messagesSource: 'bq', bqMaxTimestamp: await getBqMaxTimestamp() },
        exportedAt,
      };
    }

    const assessmentSql = `
      SELECT
        CAST(id AS STRING) AS id,
        decision AS decision,
        risk_level AS riskLevel,
        risk_score AS riskScore,
        trigger AS trigger,
        COALESCE(status, '') AS status,
        duration_ms AS durationMs,
        error AS error,
        data AS data,
        FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', created_at) AS createdAt,
        FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', updated_at) AS updatedAt
      FROM ${assessmentTable}
      WHERE case_id = @caseId
      ORDER BY created_at DESC
      LIMIT 1
    `;

    const attachedDialogueIdsSql = `
      SELECT artifact_id AS dialogueId
      FROM ${artifactTable}
      WHERE case_id = @caseId AND artifact_type = 'DIALOGUE'
    `;

    // Three-bucket selection of alias dialogues:
    //   prior   — closed strictly before case_start, take 10 most recent (by close time)
    //   during  — overlap [case_start, case_end] (created before/at case_end AND
    //             still-open OR closed at/after case_start), no limit
    //   after   — started strictly after case_end, take 10 earliest
    // Plus: all dialogues formally attached via case_case_artifact.DIALOGUE, regardless
    // of position. Each row carries an `attached` flag.
    const dialoguesSql = `
      WITH alias_tasks AS (
        SELECT
          CAST(t.id AS STRING) AS id,
          t.type,
          t.status,
          t.last_agent,
          t.created_at,
          t.closed_at
        FROM ${tasksTable} t
        WHERE t.alias = @alias
      ),
      before_dialogues AS (
        SELECT * FROM alias_tasks
        WHERE closed_at IS NOT NULL AND closed_at < @caseStart
        ORDER BY closed_at DESC
        LIMIT @beforeLimit
      ),
      during_dialogues AS (
        SELECT * FROM alias_tasks
        WHERE created_at <= @caseEnd
          AND (closed_at IS NULL OR closed_at >= @caseStart)
      ),
      after_dialogues AS (
        SELECT * FROM alias_tasks
        WHERE created_at > @caseEnd
        ORDER BY created_at ASC
        LIMIT @afterLimit
      ),
      attached_dialogues AS (
        SELECT * FROM alias_tasks
        WHERE id IN UNNEST(@attachedIds)
      ),
      selected AS (
        SELECT * FROM before_dialogues
        UNION ALL
        SELECT * FROM during_dialogues
        UNION ALL
        SELECT * FROM after_dialogues
        UNION ALL
        SELECT * FROM attached_dialogues
      ),
      deduped AS (
        SELECT * EXCEPT(rn) FROM (
          SELECT s.*, ROW_NUMBER() OVER (PARTITION BY s.id ORDER BY s.created_at) AS rn
          FROM selected s
        )
        WHERE rn = 1
      )
      SELECT
        d.id AS id,
        d.type AS type,
        d.status AS status,
        d.last_agent AS lastAgent,
        NULLIF(TRIM(CONCAT(COALESCE(a.first_name, ''), ' ', COALESCE(a.last_name, ''))), '') AS lastAgentName,
        CASE
          WHEN d.closed_at IS NOT NULL AND d.closed_at < @caseStart THEN 'prior'
          WHEN d.created_at > @caseEnd THEN 'after'
          ELSE 'active'
        END AS dialogueRole,
        d.id IN UNNEST(@attachedIds) AS attached,
        FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', d.created_at) AS createdAt,
        FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', d.closed_at) AS closedAt
      FROM deduped d
      LEFT JOIN ${agentTable} a ON a.alias = d.last_agent
      ORDER BY d.created_at ASC
    `;

    const commentsSql = `
      SELECT
        CAST(c.id AS STRING) AS id,
        CAST(c.parent_comment_id AS STRING) AS parentCommentId,
        c.body AS body,
        c.author_alias AS authorAlias,
        NULLIF(TRIM(CONCAT(COALESCE(a.first_name, ''), ' ', COALESCE(a.last_name, ''))), '') AS authorName,
        FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', c.created_at) AS createdAt
      FROM ${commentTable} c
      LEFT JOIN ${agentTable} a ON a.alias = c.author_alias
      WHERE c.page_id = @pageId
        AND c.deleted_at IS NULL
      ORDER BY c.created_at ASC
    `;

    const artifactsSql = `
      SELECT
        CAST(a.id AS STRING) AS id,
        a.artifact_type AS artifactType,
        a.artifact_id AS artifactId,
        FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', a.created_at) AS createdAt,
        f.type AS formType,
        f.status AS formStatus,
        f.title AS formTitle,
        TO_JSON_STRING(f.fields) AS formFields,
        FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', f.uploaded_at) AS formUploadedAt
      FROM ${artifactTable} a
      LEFT JOIN ${formsTable} f ON f.public_id = a.artifact_id
      WHERE a.case_id = @caseId
      ORDER BY a.created_at ASC
    `;

    const eventsSql = `
      SELECT
        CAST(id AS STRING) AS id,
        event_type AS eventType,
        actor_alias AS actorAlias,
        TO_JSON_STRING(metadata) AS metadata,
        FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', created_at) AS createdAt
      FROM ${eventTable}
      WHERE case_id = @caseId
      ORDER BY created_at ASC
    `;

    const caseStart = caseRecord.createdAt;
    // case_end = updated_at when later than created_at; otherwise fall back to created_at so that
    // bucket boundaries remain monotonic. For IN_PROGRESS cases updated_at is recent enough to
    // capture currently-open dialogues as "during".
    const caseEnd =
      caseRecord.updatedAt && new Date(caseRecord.updatedAt) > new Date(caseStart)
        ? caseRecord.updatedAt
        : caseStart;

    const [assessmentRows, attachedRows, commentRows, artifactRows, eventRows, bqMaxTimestamp] = await Promise.all([
      bq.query<AssessmentRecord>(assessmentSql, { caseId }),
      bq.query<{ dialogueId: string | null }>(attachedDialogueIdsSql, { caseId }),
      bq.query<CommentRecord>(commentsSql, { pageId: `case:${caseRecord.id}` }),
      bq.query<{
        id: string;
        artifactType: string | null;
        artifactId: string | null;
        createdAt: string;
        formType: string | null;
        formStatus: string | null;
        formTitle: string | null;
        formFields: string | null;
        formUploadedAt: string | null;
      }>(artifactsSql, { caseId }),
      bq.query<EventRecord>(eventsSql, { caseId }),
      getBqMaxTimestamp(),
    ]);

    const attachedIds = Array.from(
      new Set(attachedRows.map((r) => r.dialogueId).filter((id): id is string => Boolean(id)))
    );

    const dialogueRows: DialogueRow[] = caseRecord.alias
      ? await bq.query<DialogueRow>(dialoguesSql, {
          alias: caseRecord.alias,
          caseStart,
          caseEnd,
          beforeLimit: DIALOGUES_BEFORE,
          afterLimit: DIALOGUES_AFTER,
          attachedIds,
        })
      : [];

    const dialogueIds = dialogueRows.map((d) => d.id);
    let messageRows: MessageRow[] = [];

    if (dialogueIds.length > 0) {
      // Tight partition prune for messages: span of selected dialogues + small buffer.
      const starts = dialogueRows.map((d) => new Date(d.createdAt).getTime());
      const ends = dialogueRows.map((d) =>
        d.closedAt ? new Date(d.closedAt).getTime() : Date.now()
      );
      const windowStart = new Date(
        Math.min(...starts) - MESSAGE_WINDOW_BUFFER_DAYS * 86_400_000
      ).toISOString();
      const windowEnd = new Date(
        Math.max(...ends) + MESSAGE_WINDOW_BUFFER_DAYS * 86_400_000
      ).toISOString();

      const messagesSql = `
        SELECT
          CAST(pm.task_id AS STRING) AS taskId,
          pm.message_num AS messageNum,
          FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', pm.timestamp) AS timestamp,
          CASE
            WHEN pm.is_user THEN 'customer'
            WHEN pm.is_bot OR pm.is_llm THEN 'bot'
            ELSE 'operator'
          END AS senderType,
          pm.alias AS senderAlias,
          NULLIF(TRIM(CONCAT(COALESCE(a.first_name, ''), ' ', COALESCE(a.last_name, ''))), '') AS senderName,
          pm.text AS text,
          pm.skill_route AS skillRoute,
          pm.payload_template_type AS payloadTemplateType,
          TO_JSON_STRING(pm.files) AS files,
          COALESCE(pm.is_hidden, FALSE) AS isHidden,
          pm.channel AS channel
        FROM ${messagesTable} pm
        LEFT JOIN ${agentTable} a ON a.alias = pm.alias
        WHERE CAST(pm.task_id AS STRING) IN UNNEST(@dialogueIds)
          AND DATE(pm.timestamp) >= DATE(@windowStart)
          AND DATE(pm.timestamp) <= DATE(@windowEnd)
        ORDER BY pm.timestamp ASC, pm.message_num ASC
      `;
      messageRows = await bq.query<MessageRow>(messagesSql, {
        dialogueIds,
        windowStart,
        windowEnd,
      });
    }

    const messagesByTaskId = new Map<string, Omit<MessageRow, 'taskId'>[]>();
    const counts = new Map<string, { customer: number; operator: number; bot: number }>();
    for (const m of messageRows) {
      const list = messagesByTaskId.get(m.taskId) ?? [];
      list.push({
        messageNum: m.messageNum != null ? Number(m.messageNum) : null,
        timestamp: m.timestamp,
        senderType: m.senderType,
        senderAlias: m.senderAlias,
        senderName: m.senderName,
        text: m.text,
        skillRoute: m.skillRoute,
        payloadTemplateType: m.payloadTemplateType,
        files: m.files,
        isHidden: Boolean(m.isHidden),
        channel: m.channel,
      });
      messagesByTaskId.set(m.taskId, list);

      const c = counts.get(m.taskId) ?? { customer: 0, operator: 0, bot: 0 };
      c[m.senderType] += 1;
      counts.set(m.taskId, c);
    }

    const dialogues: DialogueWithMessages[] = dialogueRows.map((d) => ({
      ...d,
      messages: messagesByTaskId.get(d.id) ?? [],
      messageCounts: counts.get(d.id) ?? { customer: 0, operator: 0, bot: 0 },
    }));

    const assessment = assessmentRows[0]
      ? {
          ...assessmentRows[0],
          riskScore: assessmentRows[0].riskScore != null ? Number(assessmentRows[0].riskScore) : null,
          durationMs: assessmentRows[0].durationMs != null ? Number(assessmentRows[0].durationMs) : null,
        }
      : null;

    const artifacts: ArtifactRecord[] = artifactRows.map((row) => ({
      id: row.id,
      artifactType: row.artifactType,
      artifactId: row.artifactId,
      createdAt: row.createdAt,
      form:
        row.formType || row.formStatus || row.formTitle || row.formFields
          ? {
              type: row.formType,
              status: row.formStatus,
              title: row.formTitle,
              fields: row.formFields,
              uploadedAt: row.formUploadedAt,
            }
          : null,
    }));

    return {
      case: caseRecord,
      assessment,
      dialogues,
      comments: commentRows,
      artifacts,
      events: eventRows,
      dataFreshness: { messagesSource: 'bq', bqMaxTimestamp },
      exportedAt: new Date().toISOString(),
    };
  }

  app.get('/list', async (request, reply) => {
    try {
      const query = CaseBrowserListQuerySchema.parse(request.query);
      const offset = (query.page - 1) * query.pageSize;

      const conditions: string[] = [
        'DATE(c.created_at) >= @startDate',
        'DATE(c.created_at) <= @endDate',
      ];
      const params: Record<string, unknown> = {
        startDate: query.startDate,
        endDate: query.endDate,
      };

      if (query.search) {
        conditions.push(`(
          LOWER(COALESCE(c.ref_id, '')) LIKE LOWER(@search)
          OR LOWER(COALESCE(c.alias, '')) LIKE LOWER(@search)
          OR CAST(c.id AS STRING) LIKE @search
        )`);
        params.search = `%${query.search}%`;
      }
      if (query.issueType) {
        conditions.push('c.issue_type_id = @issueType');
        params.issueType = query.issueType;
      }
      if (query.businessArea) {
        conditions.push('c.business_area_id = @businessArea');
        params.businessArea = query.businessArea;
      }
      if (query.status) {
        conditions.push('c.status = @status');
        params.status = query.status;
      }
      if (query.outcome) {
        conditions.push('c.outcome = @outcome');
        params.outcome = query.outcome;
      }
      if (query.owner) {
        conditions.push('c.owner = @owner');
        params.owner = query.owner;
      }
      if (query.hasAssessment === 'true') {
        conditions.push('a.case_id IS NOT NULL');
      } else if (query.hasAssessment === 'false') {
        conditions.push('a.case_id IS NULL');
      }
      if (query.decision) {
        conditions.push('UPPER(a.decision) = @decision');
        params.decision = query.decision;
      }
      if (query.riskLevel) {
        conditions.push('LOWER(a.risk_level) = @riskLevel');
        params.riskLevel = query.riskLevel;
      }
      if (query.trigger) {
        conditions.push('a.trigger = @trigger');
        params.trigger = query.trigger;
      }

      const whereClause = conditions.join(' AND ');

      const sortColumnMap: Record<string, string> = {
        createdAt: 'c.created_at',
        refId: 'c.ref_id',
        status: 'c.status',
        riskScore: 'a.risk_score',
      };
      const sortColumn = sortColumnMap[query.sortBy] ?? 'c.created_at';
      const sortDirection = query.sortOrder.toUpperCase();

      const latestAssessmentCte = `
        latest_assessment AS (
          SELECT *
          FROM (
            SELECT
              case_id, decision, risk_level, risk_score, trigger, created_at,
              ROW_NUMBER() OVER (PARTITION BY case_id ORDER BY created_at DESC) AS rn
            FROM ${assessmentTable}
          )
          WHERE rn = 1
        )
      `;

      const countSql = `
        WITH ${latestAssessmentCte}
        SELECT COUNT(*) AS total
        FROM ${caseTable} c
        LEFT JOIN latest_assessment a ON a.case_id = c.id
        WHERE ${whereClause}
      `;

      const countResult = await bq.query<{ total: number }>(countSql, params);
      const totalCount = Number(countResult[0]?.total || 0);
      const totalPages = Math.ceil(totalCount / query.pageSize);

      const dataSql = `
        WITH ${latestAssessmentCte}
        SELECT
          CAST(c.id AS STRING) AS id,
          c.ref_id AS refId,
          c.alias AS alias,
          c.issue_type_id AS issueType,
          c.business_area_id AS businessArea,
          COALESCE(c.status, '') AS status,
          c.outcome AS outcome,
          c.owner AS owner,
          a.decision AS decision,
          a.risk_level AS riskLevel,
          a.risk_score AS riskScore,
          a.trigger AS trigger,
          a.case_id IS NOT NULL AS hasAssessment,
          FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', c.created_at) AS createdAt
        FROM ${caseTable} c
        LEFT JOIN latest_assessment a ON a.case_id = c.id
        WHERE ${whereClause}
        ORDER BY ${sortColumn} ${sortDirection} NULLS LAST, c.created_at DESC
        LIMIT @limit OFFSET @offset
      `;

      const results = await bq.query<{
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
      }>(dataSql, {
        ...params,
        limit: query.pageSize,
        offset,
      });

      const data: CaseBrowserItem[] = results.map((row) => ({
        id: row.id,
        refId: row.refId,
        alias: row.alias,
        issueType: row.issueType,
        businessArea: row.businessArea,
        status: row.status,
        outcome: row.outcome,
        owner: row.owner,
        decision: row.decision,
        riskLevel: row.riskLevel,
        riskScore: row.riskScore != null ? Number(row.riskScore) : null,
        trigger: row.trigger,
        hasAssessment: Boolean(row.hasAssessment),
        createdAt: row.createdAt,
      }));

      return {
        data,
        count: data.length,
        totalCount,
        page: query.page,
        pageSize: query.pageSize,
        totalPages,
      };
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ error: 'Validation error', details: error.errors });
      }
      throw error;
    }
  });

  app.get('/ids', async (request, reply) => {
    try {
      // Reuse the list query schema but ignore pagination/sort.
      const query = CaseBrowserListQuerySchema.parse(request.query);

      const conditions: string[] = [
        'DATE(c.created_at) >= @startDate',
        'DATE(c.created_at) <= @endDate',
      ];
      const params: Record<string, unknown> = {
        startDate: query.startDate,
        endDate: query.endDate,
      };

      if (query.search) {
        conditions.push(`(
          LOWER(COALESCE(c.ref_id, '')) LIKE LOWER(@search)
          OR LOWER(COALESCE(c.alias, '')) LIKE LOWER(@search)
          OR CAST(c.id AS STRING) LIKE @search
        )`);
        params.search = `%${query.search}%`;
      }
      if (query.issueType) {
        conditions.push('c.issue_type_id = @issueType');
        params.issueType = query.issueType;
      }
      if (query.businessArea) {
        conditions.push('c.business_area_id = @businessArea');
        params.businessArea = query.businessArea;
      }
      if (query.status) {
        conditions.push('c.status = @status');
        params.status = query.status;
      }
      if (query.outcome) {
        conditions.push('c.outcome = @outcome');
        params.outcome = query.outcome;
      }
      if (query.owner) {
        conditions.push('c.owner = @owner');
        params.owner = query.owner;
      }
      if (query.hasAssessment === 'true') {
        conditions.push('a.case_id IS NOT NULL');
      } else if (query.hasAssessment === 'false') {
        conditions.push('a.case_id IS NULL');
      }
      if (query.decision) {
        conditions.push('UPPER(a.decision) = @decision');
        params.decision = query.decision;
      }
      if (query.riskLevel) {
        conditions.push('LOWER(a.risk_level) = @riskLevel');
        params.riskLevel = query.riskLevel;
      }
      if (query.trigger) {
        conditions.push('a.trigger = @trigger');
        params.trigger = query.trigger;
      }

      const whereClause = conditions.join(' AND ');

      const latestAssessmentCte = `
        latest_assessment AS (
          SELECT *
          FROM (
            SELECT
              case_id, decision, risk_level, risk_score, trigger, created_at,
              ROW_NUMBER() OVER (PARTITION BY case_id ORDER BY created_at DESC) AS rn
            FROM ${assessmentTable}
          )
          WHERE rn = 1
        )
      `;

      // Two queries: total matching count + capped id list. Cap matches BULK_EXPORT_LIMIT.
      const countSql = `
        WITH ${latestAssessmentCte}
        SELECT COUNT(*) AS total
        FROM ${caseTable} c
        LEFT JOIN latest_assessment a ON a.case_id = c.id
        WHERE ${whereClause}
      `;
      const idsSql = `
        WITH ${latestAssessmentCte}
        SELECT c.id AS id
        FROM ${caseTable} c
        LEFT JOIN latest_assessment a ON a.case_id = c.id
        WHERE ${whereClause}
        ORDER BY c.created_at DESC
        LIMIT @limit
      `;

      const [countResult, idResult] = await Promise.all([
        bq.query<{ total: number }>(countSql, params),
        bq.query<{ id: number }>(idsSql, { ...params, limit: BULK_EXPORT_LIMIT }),
      ]);

      const totalMatching = Number(countResult[0]?.total || 0);
      const ids = idResult.map((row) => Number(row.id));

      return {
        data: {
          ids,
          totalMatching,
          returned: ids.length,
          capped: totalMatching > BULK_EXPORT_LIMIT,
          limit: BULK_EXPORT_LIMIT,
        },
      };
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ error: 'Validation error', details: error.errors });
      }
      throw error;
    }
  });

  app.get<{ Params: { caseId: string } }>('/:caseId', async (request, reply) => {
    const caseId = Number(request.params.caseId);
    if (!Number.isFinite(caseId) || caseId <= 0) {
      return reply.status(400).send({ error: 'Invalid caseId' });
    }
    const bundle = await buildCaseBundle(caseId);
    if (!bundle.case) {
      return reply.status(404).send({ error: 'Case not found' });
    }
    return { data: bundle };
  });

  app.get<{ Params: { caseId: string } }>('/:caseId/export', async (request, reply) => {
    const caseId = Number(request.params.caseId);
    if (!Number.isFinite(caseId) || caseId <= 0) {
      return reply.status(400).send({ error: 'Invalid caseId' });
    }
    const bundle = await buildCaseBundle(caseId);
    if (!bundle.case) {
      return reply.status(404).send({ error: 'Case not found' });
    }
    reply.header('Content-Type', 'application/json');
    reply.header('Content-Disposition', `attachment; filename="case-${caseId}.json"`);
    return bundle;
  });

  app.post('/bulk-export', async (request, reply) => {
    let body: z.infer<typeof BulkExportSchema>;
    try {
      body = BulkExportSchema.parse(request.body);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ error: 'Validation error', details: error.errors });
      }
      throw error;
    }

    // Build bundles with bounded concurrency, then return a single JSON array.
    // 500-cap × ~150 KB/bundle ≈ 75 MB worst-case in memory — acceptable for a single user
    // download flow. Drops the prior NDJSON-stream complexity in exchange for a plain `.json`
    // file that any JSON viewer can open.
    const queue = [...body.caseIds];
    const results: Array<
      | { ok: true; caseId: number; bundle: CaseBundle }
      | { ok: false; caseId: number; error: string }
    > = [];

    const worker = async () => {
      while (queue.length > 0) {
        const caseId = queue.shift();
        if (caseId === undefined) return;
        try {
          const bundle = await buildCaseBundle(caseId);
          results.push({ ok: true, caseId, bundle });
        } catch (err) {
          app.log.error({ err, caseId }, 'bulk-export case failed');
          results.push({ ok: false, caseId, error: String(err) });
        }
      }
    };

    const workers = Array.from({ length: Math.min(BULK_CONCURRENCY, body.caseIds.length) }, () => worker());
    await Promise.all(workers);

    // Preserve the user's input order in the response.
    const indexById = new Map(body.caseIds.map((id, i) => [id, i]));
    results.sort((a, b) => (indexById.get(a.caseId) ?? 0) - (indexById.get(b.caseId) ?? 0));

    const data = results.filter((r) => r.ok).map((r) => (r as { ok: true; bundle: CaseBundle }).bundle);
    const errors = results
      .filter((r) => !r.ok)
      .map((r) => ({ caseId: r.caseId, error: (r as { error: string }).error }));

    reply.header('Content-Type', 'application/json');
    reply.header(
      'Content-Disposition',
      `attachment; filename="case-bundles-${new Date().toISOString().slice(0, 10)}.json"`
    );
    return {
      exportedAt: new Date().toISOString(),
      requestedCount: body.caseIds.length,
      successCount: data.length,
      errorCount: errors.length,
      cases: data,
      errors,
    };
  });
}


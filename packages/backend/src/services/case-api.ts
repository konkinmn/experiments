import type { CaseAction, DialogueMessage } from '../types/dispute-pipeline.js';

export interface TimelineEntry {
  id: number;
  category: string;
  title: string;
  description: string;
  occurred_at: string;
  sources: unknown[];
}

export interface CaseTimeline {
  caseId: number;
  timeline: TimelineEntry[];
}

export interface CaseDetails {
  id: number;
  ref_id: string;
  alias: string;
  artifacts: unknown[];
  attention_markers: unknown[];
  business_area_id: string;
  company_id: string;
  created_at: string;
  issue_type_id: string;
  members: string[];
  outcome: string | null;
  owner: string | null;
  scope: string;
  status: string;
  summary: string;
  updated_at: string;
}

const CASE_API_BASE_URL = process.env.CASE_API_BASE_URL || 'https://case-ag.k1.anna.money';
const FILE_SHARE_BASE_URL = process.env.FILE_SHARE_BASE_URL || 'https://file-share-ag.k1.anna.money';
const MEDIA_BASE_URL = process.env.MEDIA_BASE_URL || 'https://media.k1.anna.money';
const TASKS_BASE_URL = process.env.TASKS_BASE_URL || 'https://tasks.k1.anna.money';
const CHAT_BASE_URL = process.env.CHAT_BASE_URL || 'https://chat.k1.anna.money';
const API_TOKEN = process.env.API_TOKEN || '';
const FETCH_TIMEOUT_MS = 30_000;

/** One agent task as the live tasks service returns it (GET /api/v3/agent-tasks). */
export interface WsAgentTask {
  id: number;
  alias: string | null;
  title: string | null;
  description: string | null;
  task_type: string | null;
  rb_jira_sync: boolean | null;
  created_by: string | null;
  taken_by: string | null;
  created_at: string;
  status: string;
  group_id: string;
  attachments: unknown[];
}

const AGENT_TASKS_PAGE_SIZE = 100;

/**
 * The authoritative live list of OPEN tasks for a skill group — the BigQuery export
 * lags (closed tasks linger, fresh tasks missing). THROWS on any failure: a queue run
 * must fail visibly rather than proceed on a wrong task list.
 */
export async function fetchOpenAgentTasks(groupId: string): Promise<WsAgentTask[]> {
  const tasks: WsAgentTask[] = [];
  for (let page = 1; ; page++) {
    const url =
      `${TASKS_BASE_URL}/api/v3/agent-tasks?group_id=${encodeURIComponent(groupId)}` +
      `&status=OPEN&page=${page}&page_size=${AGENT_TASKS_PAGE_SIZE}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Tasks API error: agent-tasks page ${page}: ${response.status} ${response.statusText}`);
    }
    const body = (await response.json()) as { data?: WsAgentTask[]; error?: Record<string, unknown> };
    if (body.error && Object.keys(body.error).length > 0) {
      throw new Error(`Tasks API error: agent-tasks page ${page}: ${JSON.stringify(body.error)}`);
    }
    const batch = body.data ?? [];
    tasks.push(...batch);
    if (batch.length < AGENT_TASKS_PAGE_SIZE) break;
  }
  return tasks;
}

/** One OPEN case action from the skill queue (the workstation's "Case action" items). */
export interface WsQueueCaseAction {
  id: number;
  action_type: string;
  status: string;
  alias: string | null;
  case_id: number;
  queue_id: string | null;
  created_at: string;
  priority: number | null;
  activate_at: string | null;
}

/**
 * Open case actions queued for a skill (workstation queue, item_type=case_action).
 * Case actions queue by SKILL (queue_id = "skill:<id>"), not by task group — today they
 * all land in skill:payments (the service default). THROWS on failure, same policy as
 * fetchOpenAgentTasks: these are queue items, a wrong list invalidates the run.
 */
export async function fetchOpenCaseActions(skillId: string): Promise<WsQueueCaseAction[]> {
  const items: WsQueueCaseAction[] = [];
  for (let page = 1; ; page++) {
    const url =
      `${TASKS_BASE_URL}/api/workstation/agent-tasks/queue?skill_id=${encodeURIComponent(skillId)}` +
      `&item_type=case_action&page=${page}&page_size=${AGENT_TASKS_PAGE_SIZE}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Tasks API error: skill queue page ${page}: ${response.status} ${response.statusText}`);
    }
    const body = (await response.json()) as {
      data?: { items?: WsQueueCaseAction[]; total_count?: number };
      error?: Record<string, unknown>;
    };
    if (body.error && Object.keys(body.error).length > 0) {
      throw new Error(`Tasks API error: skill queue page ${page}: ${JSON.stringify(body.error)}`);
    }
    const batch = body.data?.items ?? [];
    items.push(...batch);
    if (batch.length < AGENT_TASKS_PAGE_SIZE) break;
  }
  return items;
}

// ---- Queue-analyser live content fetchers -------------------------------------------------
// All of these DEGRADE on failure (warn + return empty) — a single flaky call must not kill
// a queue run. The caller records failures and surfaces them on the run. Only
// fetchOpenAgentTasks above throws (a wrong task list invalidates the whole run).

async function getJson<T>(url: string, label: string): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`${label}: ${response.status} ${response.statusText}`);
      return null;
    }
    const body = (await response.json()) as { data?: T; error?: Record<string, unknown> };
    if (body.error && Object.keys(body.error).length > 0) {
      console.warn(`${label}: ${JSON.stringify(body.error).slice(0, 200)}`);
      return null;
    }
    return body.data ?? null;
  } catch (err) {
    console.warn(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function day(ts: string | undefined | null): string {
  return (ts ?? '').slice(0, 10);
}

export interface TaskActivityNote {
  day: string;
  author: string;
  text: string;
}
export interface TaskActivityChange {
  day: string;
  status: string | null;
  group_id: string | null;
}
export interface TaskActivity {
  notes: TaskActivityNote[];
  history: TaskActivityChange[];
}

interface ActivityItem {
  type: string; // COMMENT | HISTORY
  timestamp?: string;
  data?: {
    author?: string;
    description?: string;
    changed_by?: string;
    changes?: Array<{ field?: string; old?: unknown; new?: unknown }>;
  };
}

/** Operator notes + status/group history for one agent task, oldest→newest. Null on failure. */
export async function fetchTaskActivity(taskId: number): Promise<TaskActivity | null> {
  const data = await getJson<{ items?: ActivityItem[] }>(
    `${TASKS_BASE_URL}/api/workstation/agent-tasks/${taskId}/activity?limit=100`,
    `activity:${taskId}`,
  );
  if (!data) return null;
  const notes: TaskActivityNote[] = [];
  const history: TaskActivityChange[] = [];
  for (const item of data.items ?? []) {
    const d = day(item.timestamp);
    if (item.type === 'COMMENT' && item.data?.description) {
      notes.push({ day: d, author: item.data.author ?? '?', text: item.data.description });
    } else if (item.type === 'HISTORY') {
      const changes = item.data?.changes ?? [];
      const status = changes.find((c) => c.field === 'status');
      const group = changes.find((c) => c.field === 'group_id');
      if (status || group) {
        history.push({
          day: d,
          status: status ? String(status.new ?? '') : null,
          group_id: group ? String(group.new ?? '') : null,
        });
      }
    }
  }
  // Activity arrives newest-first; flip to oldest→newest for the context format.
  notes.reverse();
  history.reverse();
  return { notes, history };
}

export interface WsCaseArtifact {
  artifact_type: string; // DIALOGUE | AGENT_TASK | TRANSACTION | CALL | FILE | …
  artifact_id: string;
}
export interface WsCase {
  id: number;
  status: string; // IN_PROGRESS | RESOLVED | DISMISSED
  created_at: string;
  issue_type_id: string | null;
  artifacts: WsCaseArtifact[];
}

/** All cases for an alias, incl. artifacts (task links + attached dialogues). Null on failure. */
export async function fetchCasesByAlias(alias: string): Promise<WsCase[] | null> {
  const data = await getJson<{ cases?: WsCase[] }>(
    `${CASE_API_BASE_URL}/api/workstation/cases?alias=${encodeURIComponent(alias)}`,
    `cases:${alias}`,
  );
  return data ? (data.cases ?? []) : null;
}

export interface WsCaseEvent {
  day: string;
  event_type: string;
}

/** Most recent events for a case (one page), oldest→newest. Null on failure. */
export async function fetchCaseEvents(caseId: number, pageSize = 10): Promise<WsCaseEvent[] | null> {
  const data = await getJson<{ events?: Array<{ event_type?: string; created_at?: string }> }>(
    `${CASE_API_BASE_URL}/api/workstation/cases/${caseId}/events?page=1&page_size=${pageSize}`,
    `events:${caseId}`,
  );
  if (!data) return null;
  const events = (data.events ?? [])
    .filter((e) => e.event_type)
    .map((e) => ({ day: day(e.created_at), event_type: e.event_type as string }));
  return events.sort((a, b) => a.day.localeCompare(b.day));
}

export interface WsDisputeAssessment {
  day: string;
  decision: string;
  risk_level: string;
  status: string;
}

/** Dispute assessments for a case, oldest→newest. Null on failure. */
export async function fetchCaseDisputeAssessments(caseId: number): Promise<WsDisputeAssessment[] | null> {
  const data = await getJson<{
    assessments?: Array<{ decision?: string; risk_level?: string; status?: string; created_at?: string }>;
  }>(
    `${CASE_API_BASE_URL}/api/workstation/cases/${caseId}/dispute-assessments`,
    `assessments:${caseId}`,
  );
  if (!data) return null;
  return (data.assessments ?? [])
    .map((a) => ({
      day: day(a.created_at),
      decision: a.decision ?? '?',
      risk_level: a.risk_level ?? '?',
      status: a.status ?? '?',
    }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

/** Skill group id → title (for readable history lines). Empty map on failure. */
export async function fetchGroupTitles(): Promise<Map<string, string>> {
  const data = await getJson<Array<{ id?: string; title?: string }>>(
    `${TASKS_BASE_URL}/api/v3/groups`,
    'groups',
  );
  const map = new Map<string, string>();
  for (const g of data ?? []) {
    if (g.id && g.title) map.set(String(g.id), g.title);
  }
  return map;
}

export interface WsDialogue {
  id: number;
  alias: string;
  type: string | null;
  created_at: string;
  updated_at?: string;
}

/** The alias's most recently updated dialogues (fallback thread discovery). Null on failure. */
export async function fetchDialoguesByAlias(alias: string, limit = 10): Promise<WsDialogue[] | null> {
  const base = `${TASKS_BASE_URL}/api/v3/dialogues?alias=${encodeURIComponent(alias)}&page=1&page_size=${limit}`;
  const data =
    (await getJson<WsDialogue[]>(`${base}&sort_by=-updated_at`, `dialogues:${alias}`)) ??
    (await getJson<WsDialogue[]>(`${base}&sort_by=-created_at`, `dialogues:${alias}`));
  return data;
}

export interface WsChatMessage {
  day: string;
  sender: string; // customer | operator | bot
  text: string;
}

const MSG_TEXT_MAX = 150; // parity with the BQ pipeline's SUBSTR

/** Last `n` messages of one dialogue with content, oldest→newest. Null on failure. */
export async function fetchDialogueTail(
  dialogueId: number,
  alias: string,
  n = 60,
): Promise<WsChatMessage[] | null> {
  const ids = await getJson<Array<{ message_id: string }>>(
    `${TASKS_BASE_URL}/api/v3/messages?dialogue_id=${dialogueId}&tail_per_dialogue=${n}`,
    `msg-ids:${dialogueId}`,
  );
  if (!ids) return null;
  if (ids.length === 0) return [];

  try {
    const idParams = ids.map((m) => `id[]=${encodeURIComponent(m.message_id)}`).join('&');
    const response = await fetch(`${CHAT_BASE_URL}/api/2/user/${alias}/messages?${idParams}`, {
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`msg-content:${dialogueId}: ${response.status} ${response.statusText}`);
      return null;
    }
    const body = (await response.json()) as {
      messages?: Array<{
        sender?: { name?: string; is_client?: boolean; role?: string };
        message?: string | null;
        created_at?: number;
        timestamp?: string;
        is_hidden?: boolean;
      }>;
    };
    const out: WsChatMessage[] = [];
    for (const msg of body.messages ?? []) {
      if (msg.is_hidden || !msg.message) continue;
      const roleName = `${msg.sender?.role ?? ''} ${msg.sender?.name ?? ''}`.toLowerCase();
      const sender = msg.sender?.is_client
        ? 'customer'
        : /bot|assistant|llm/.test(roleName)
          ? 'bot'
          : 'operator';
      const ts = msg.timestamp || (msg.created_at ? new Date(msg.created_at).toISOString() : '');
      out.push({
        day: day(ts),
        sender,
        text: msg.message.replace(/\s+/g, ' ').trim().slice(0, MSG_TEXT_MAX),
      });
    }
    return out.sort((a, b) => a.day.localeCompare(b.day));
  } catch (err) {
    console.warn(`msg-content:${dialogueId}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function fetchCaseTimeline(caseId: number): Promise<CaseTimeline> {
  const url = `${CASE_API_BASE_URL}/api/workstation/cases/${caseId}/timeline`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Case API error: Failed to fetch timeline for case ${caseId}: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as { data?: { entries?: TimelineEntry[] } };
  return {
    caseId,
    timeline: data.data?.entries || [],
  };
}

export async function fetchCaseDetails(caseId: number): Promise<CaseDetails> {
  const url = `${CASE_API_BASE_URL}/api/workstation/cases/${caseId}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Case API error: Failed to fetch details for case ${caseId}: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as { data?: CaseDetails };
  if (!data.data) {
    throw new Error(`Case API error: No data returned for case ${caseId}`);
  }
  return data.data;
}

export interface CaseListItem {
  id: number;
  [key: string]: unknown;
}

export interface FetchCasesParams {
  issueTypeId?: string;
  status?: string;
  createdAtFrom?: string;  // YYYY-MM-DD
  createdAtTo?: string;    // YYYY-MM-DD
}

export async function fetchFilteredCaseIds(params: FetchCasesParams): Promise<number[]> {
  const allCaseIds: number[] = [];
  let currentPage = 1;
  let hasMorePages = true;

  while (hasMorePages) {
    const queryParams = new URLSearchParams();
    if (params.issueTypeId) queryParams.set('issue_type_id', params.issueTypeId);
    if (params.status) queryParams.set('status', params.status);
    if (params.createdAtFrom) queryParams.set('created_at_from', params.createdAtFrom);
    if (params.createdAtTo) queryParams.set('created_at_to', params.createdAtTo);
    queryParams.set('page', String(currentPage));
    queryParams.set('page_size', '100');

    const url = `${CASE_API_BASE_URL}/api/workstation/agent-cases?${queryParams}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Case API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as {
      data?: {
        cases?: CaseListItem[];
        pagination?: { has_next?: boolean };
      };
    };
    const cases = data?.data?.cases || [];
    allCaseIds.push(...cases.map((c) => c.id));

    hasMorePages = data?.data?.pagination?.has_next || false;
    currentPage++;
  }

  return allCaseIds;
}

export interface ArtifactFile {
  base64: string;
  mimeType: string;
  filename: string;
}

export async function fetchArtifactAsBase64(artifactId: string): Promise<ArtifactFile | null> {
  try {
    // Step 1: Get file metadata from file-share service
    const metaUrl = `${FILE_SHARE_BASE_URL}/api/workstation/files/${artifactId}`;
    const metaResponse = await fetch(metaUrl, {
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!metaResponse.ok) {
      console.warn(`File-share fetch failed for artifact ${artifactId}: ${metaResponse.status} ${metaResponse.statusText}`);
      return null;
    }

    const metaData = await metaResponse.json() as {
      data?: { path?: string; mime_type?: string; name?: string };
    };

    const filePath = metaData.data?.path;
    const mimeType = metaData.data?.mime_type || 'application/octet-stream';
    const filename = metaData.data?.name || artifactId;

    if (!filePath) {
      console.warn(`No file path in file-share response for artifact ${artifactId}`);
      return null;
    }

    // Step 2: Fetch raw bytes from media service
    const mediaUrl = `${MEDIA_BASE_URL}${filePath}`;
    const mediaResponse = await fetch(mediaUrl, {
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!mediaResponse.ok) {
      console.warn(`Media fetch failed for artifact ${artifactId}: ${mediaResponse.status} ${mediaResponse.statusText}`);
      return null;
    }

    const arrayBuffer = await mediaResponse.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');

    return { base64, mimeType, filename };
  } catch (err) {
    console.warn(`Failed to fetch artifact ${artifactId}:`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

export async function fetchCaseActions(caseId: number): Promise<CaseAction[]> {
  try {
    const url = `${TASKS_BASE_URL}/api/workstation/case-actions?case_id=${caseId}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      console.warn(`Failed to fetch case actions for case ${caseId}: ${response.status} ${response.statusText}`);
      return [];
    }

    const body = await response.json() as { data?: CaseAction[] };
    return body.data || [];
  } catch (err) {
    console.warn(`Failed to fetch case actions for case ${caseId}:`, err instanceof Error ? err.message : String(err));
    return [];
  }
}

import type { DialogueFetchMetadata } from '../types/dispute-pipeline.js';

export interface DialoguesFetchResult {
  messages: DialogueMessage[];
  metadata: DialogueFetchMetadata;
}

export async function fetchCaseDialogues(artifactIds: string[]): Promise<DialoguesFetchResult> {
  const emptyMetadata: DialogueFetchMetadata = {
    dialogues_requested: artifactIds.length,
    dialogues_found: 0,
    dialogues_with_messages: 0,
    chat_fetch_failures: [],
  };

  if (artifactIds.length === 0) return { messages: [], metadata: emptyMetadata };

  const allMessages: DialogueMessage[] = [];
  const metadata: DialogueFetchMetadata = { ...emptyMetadata };

  try {
    // Step 1: Get dialogue records including alias
    const dialoguesUrl = `${TASKS_BASE_URL}/api/v3/dialogues?id=${artifactIds.join(',')}`;
    const dialoguesResponse = await fetch(dialoguesUrl, {
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!dialoguesResponse.ok) {
      console.warn(`Failed to fetch dialogues: ${dialoguesResponse.status} ${dialoguesResponse.statusText}`);
      return { messages: [], metadata };
    }

    const dialoguesBody = await dialoguesResponse.json() as {
      data?: Array<{ id: number; alias: string }>;
    };
    const dialogues = dialoguesBody.data || [];
    metadata.dialogues_found = dialogues.length;

    // Process each dialogue
    for (const dialogue of dialogues) {
      try {
        // Step 2: Get message IDs for this dialogue
        const messagesUrl = `${TASKS_BASE_URL}/api/v3/messages?dialogue_id=${dialogue.id}`;
        const messagesResponse = await fetch(messagesUrl, {
          headers: {
            Authorization: `Bearer ${API_TOKEN}`,
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if (!messagesResponse.ok) {
          console.warn(`Failed to fetch messages for dialogue ${dialogue.id}: ${messagesResponse.status}`);
          continue;
        }

        const messagesBody = await messagesResponse.json() as {
          data?: Array<{ dialogue_id: number; message_id: string }>;
        };
        const messageRecords = messagesBody.data || [];
        if (messageRecords.length === 0) continue;

        metadata.dialogues_with_messages++;

        // Step 3: Get message content from chat service
        const messageIdParams = messageRecords.map((m) => `id[]=${m.message_id}`).join('&');
        const chatUrl = `${CHAT_BASE_URL}/api/2/user/${dialogue.alias}/messages?${messageIdParams}`;
        const chatResponse = await fetch(chatUrl, {
          headers: {
            Authorization: `Bearer ${API_TOKEN}`,
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if (!chatResponse.ok) {
          const errorBody = await chatResponse.text().catch(() => '');
          console.warn(
            `Failed to fetch chat messages for dialogue ${dialogue.id} (alias=${dialogue.alias}, ${messageRecords.length} msg IDs): ${chatResponse.status} — ${errorBody.slice(0, 500)}`,
          );
          metadata.chat_fetch_failures.push({
            dialogue_id: dialogue.id,
            alias: dialogue.alias,
            status: chatResponse.status,
            error_body: errorBody.slice(0, 500),
          });
          continue;
        }

        const chatBody = await chatResponse.json() as {
          messages?: Array<{
            sender?: { name?: string; is_client?: boolean; role?: string };
            message?: string | null;
            created_at?: number;
            timestamp?: string;
            is_hidden?: boolean;
          }>;
        };
        const chatMessages = chatBody.messages || [];

        for (const msg of chatMessages) {
          if (msg.is_hidden) continue;
          allMessages.push({
            role: msg.sender?.role || msg.sender?.name || 'unknown',
            content: msg.message || '',
            created_at: msg.timestamp || (msg.created_at ? new Date(msg.created_at).toISOString() : ''),
          });
        }
      } catch (err) {
        console.warn(`Failed to process dialogue ${dialogue.id}:`, err instanceof Error ? err.message : String(err));
      }
    }
  } catch (err) {
    console.warn('Failed to fetch dialogues:', err instanceof Error ? err.message : String(err));
  }

  return { messages: allMessages, metadata };
}

export async function fetchCaseTimelines(caseIds: number[]): Promise<Map<number, CaseTimeline>> {
  const results = new Map<number, CaseTimeline>();

  // Fetch timelines in parallel with concurrency limit
  const BATCH_SIZE = 5;
  for (let i = 0; i < caseIds.length; i += BATCH_SIZE) {
    const batch = caseIds.slice(i, i + BATCH_SIZE);
    const promises = batch.map(async (caseId) => {
      try {
        const timeline = await fetchCaseTimeline(caseId);
        return { caseId, timeline, error: null };
      } catch (error) {
        return { caseId, timeline: null, error: error instanceof Error ? error.message : String(error) };
      }
    });

    const batchResults = await Promise.all(promises);
    for (const result of batchResults) {
      if (result.timeline) {
        results.set(result.caseId, result.timeline);
      }
    }
  }

  return results;
}

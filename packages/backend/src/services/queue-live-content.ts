import {
  fetchTaskActivity,
  fetchCasesByAlias,
  fetchCaseEvents,
  fetchCaseDisputeAssessments,
  fetchGroupTitles,
  fetchDialoguesByAlias,
  fetchDialogueTail,
  type WsCase,
} from './case-api.js';
import {
  fetchCaseCommentsByCaseIds,
  buildTaskMessages,
  TASK_WINDOW_LEAD_DAYS,
  RAW_MSGS_PER_TASK,
  DIALOGUES_PER_TASK,
  type TaskRef,
  type CaseAggregate,
  type TaskMessages,
  type TaskMessageRow,
} from './queue-analyser-query.js';
import { runWithConcurrency } from '../utils/concurrency.js';

// Polite ceiling for the per-run fan-out against the live WS services (one shared
// limiter across activity / cases / events / assessments / dialogues / message calls).
const CONCURRENCY = 8;

export interface TaskCaseStats {
  n_cases: number;
  n_active: number;
  n_done: number;
  case_statuses: string | null;
}

export interface LiveContent {
  aggs: Map<number, CaseAggregate>;
  msgs: Map<number, TaskMessages>;
  caseStats: Map<number, TaskCaseStats>;
  /** Case ids per task, IN_PROGRESS-first then newest — [0] is the dispute "primary case". */
  casesByTask: Map<number, number[]>;
  nAttached: number;
  failures: string[];
}

interface TaskCaseLink {
  cases: WsCase[]; // sorted primary-first
  attachedDialogueIds: number[];
}

function sortCasesPrimaryFirst(cases: WsCase[]): WsCase[] {
  return [...cases].sort(
    (a, b) =>
      Number(b.status === 'IN_PROGRESS') - Number(a.status === 'IN_PROGRESS') ||
      b.created_at.localeCompare(a.created_at),
  );
}

/**
 * All case-framed context for a queue run, fetched LIVE from the WS services (task
 * activity, cases + artifacts, events, dispute assessments, dialogue messages). The one
 * exception is case comments — no live API — which come from a slim BigQuery query.
 * Every fetch degrades on failure: the task just misses that section and the failure is
 * recorded for the run marker.
 */
export async function fetchLiveCaseContent(tasks: TaskRef[]): Promise<LiveContent> {
  const failures: string[] = [];
  const aggs = new Map<number, CaseAggregate>();
  const msgs = new Map<number, TaskMessages>();
  const caseStats = new Map<number, TaskCaseStats>();
  const casesByTask = new Map<number, number[]>();
  let nAttached = 0;

  if (tasks.length === 0) {
    return { aggs, msgs, caseStats, casesByTask, nAttached, failures };
  }

  const groupTitles = await fetchGroupTitles();

  // ---- Stage A: cases per alias (task↔case links + attached dialogues + case stats) ----
  const uniqueAliases = [...new Set(tasks.map((t) => t.alias).filter((a): a is string => Boolean(a)))];
  const casesByAlias = new Map<string, WsCase[]>();
  await runWithConcurrency(
    uniqueAliases.map((alias) => async () => {
      const cases = await fetchCasesByAlias(alias);
      if (cases === null) failures.push(`cases:${alias}`);
      else casesByAlias.set(alias, cases);
    }),
    CONCURRENCY,
  );

  const linkByTask = new Map<number, TaskCaseLink>();
  for (const t of tasks) {
    const aliasCases = t.alias ? (casesByAlias.get(t.alias) ?? []) : [];
    // Case-action items know their case directly; agent tasks link via case artifacts.
    const linked = t.direct_case_id
      ? aliasCases.filter((c) => c.id === t.direct_case_id)
      : aliasCases.filter((c) =>
          (c.artifacts ?? []).some(
            (a) => a.artifact_type === 'AGENT_TASK' && String(a.artifact_id) === String(t.task_id),
          ),
        );
    const sorted = sortCasesPrimaryFirst(linked);
    const attachedDialogueIds = [
      ...new Set(
        sorted.flatMap((c) =>
          (c.artifacts ?? [])
            .filter((a) => a.artifact_type === 'DIALOGUE')
            .map((a) => Number(a.artifact_id))
            .filter((id) => Number.isFinite(id)),
        ),
      ),
    ];
    linkByTask.set(t.task_id, { cases: sorted, attachedDialogueIds });
    // A case-action's case is authoritative even if it didn't surface via the alias
    // lookup (e.g. cases:alias fetch failed) — the action payload names it directly.
    casesByTask.set(
      t.task_id,
      sorted.length > 0 ? sorted.map((c) => c.id) : t.direct_case_id ? [t.direct_case_id] : [],
    );
    caseStats.set(t.task_id, {
      n_cases: sorted.length,
      n_active: sorted.filter((c) => c.status === 'IN_PROGRESS').length,
      n_done: sorted.filter((c) => c.status === 'RESOLVED' || c.status === 'DISMISSED').length,
      case_statuses: sorted.length ? [...new Set(sorted.map((c) => c.status))].join(', ') : null,
    });
  }

  // ---- Stage B (parallel batches): activity, events, assessments, comments, messages ----
  const notesByTask = new Map<number, string>();
  const historyByTask = new Map<number, string>();
  // Case-action items are not agent tasks — they have no /activity feed.
  const activityJobs = tasks.filter((t) => !t.is_case_action).map((t) => async () => {
    const activity = await fetchTaskActivity(t.task_id);
    if (activity === null) {
      failures.push(`activity:${t.task_id}`);
      return;
    }
    if (activity.notes.length > 0) {
      notesByTask.set(
        t.task_id,
        activity.notes
          .map((n) => `${n.day} ${n.author}: ${n.text.replace(/\s+/g, ' ').trim()}`)
          .join(' | '),
      );
    }
    if (activity.history.length > 0) {
      historyByTask.set(
        t.task_id,
        activity.history
          .map((h) => {
            const group = h.group_id ? ` @${groupTitles.get(h.group_id) ?? h.group_id}` : '';
            return `${h.day} ${h.status ?? '?'}${group}`;
          })
          .join(' -> '),
      );
    }
  });

  const allCaseIds = [...new Set([...casesByTask.values()].flat())];
  const eventsByCase = new Map<number, string>();
  const assessByCase = new Map<number, string>();
  const caseJobs = allCaseIds.flatMap((caseId) => [
    async () => {
      const events = await fetchCaseEvents(caseId);
      if (events === null) failures.push(`events:${caseId}`);
      else if (events.length > 0) {
        eventsByCase.set(caseId, events.map((e) => `${e.day} ${e.event_type}`).join(' | '));
      }
    },
    async () => {
      const assessments = await fetchCaseDisputeAssessments(caseId);
      if (assessments === null) failures.push(`assessments:${caseId}`);
      else if (assessments.length > 0) {
        assessByCase.set(
          caseId,
          assessments.map((a) => `${a.day} ${a.decision} · ${a.risk_level} · ${a.status}`).join(' | '),
        );
      }
    },
  ]);

  // Messages: attached dialogues first; else fall back to the alias's recent threads.
  // The fallback PROBES candidates until DIALOGUES_PER_TASK actually contain messages —
  // an alias's most recently updated threads are usually message-less notification
  // dialogues (notification_transaction etc.), the same trap the BQ picker had.
  const FALLBACK_DIALOGUE_CANDIDATES = 30;
  const msgRowsByTask = new Map<number, TaskMessageRow[]>();
  const messageJobs = tasks.map((t) => async () => {
    if (!t.alias) return;
    const alias = t.alias;
    const link = linkByTask.get(t.task_id);
    let candidates: number[];
    let budget: number;
    if (link && link.attachedDialogueIds.length > 0) {
      candidates = link.attachedDialogueIds.slice(0, DIALOGUES_PER_TASK);
      budget = candidates.length;
      nAttached++;
    } else {
      const found = await fetchDialoguesByAlias(alias, FALLBACK_DIALOGUE_CANDIDATES);
      if (found === null) {
        failures.push(`dialogues:${alias}`);
        return;
      }
      // Notification threads (transaction pings etc.) are bot broadcasts with no
      // conversation — skip them instead of burning probe budget on them.
      candidates = found
        .filter((d) => !(d.type ?? '').toLowerCase().startsWith('notification'))
        .map((d) => d.id);
      budget = DIALOGUES_PER_TASK;
    }
    if (candidates.length === 0) return;

    const windowStart = new Date(
      new Date(t.created_at).getTime() - TASK_WINDOW_LEAD_DAYS * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);

    const rows: TaskMessageRow[] = [];
    let dialoguesWithMessages = 0;
    for (const dialogueId of candidates) {
      if (dialoguesWithMessages >= budget) break;
      const tail = await fetchDialogueTail(dialogueId, alias, RAW_MSGS_PER_TASK);
      if (tail === null) {
        failures.push(`messages:${dialogueId}`);
        continue;
      }
      const inWindow = tail.filter((m) => m.day >= windowStart && m.text);
      if (inWindow.length === 0) continue;
      dialoguesWithMessages++;
      for (const m of inWindow) {
        rows.push({ task_id: t.task_id, day: m.day, sender: m.sender, text: m.text });
      }
    }
    if (rows.length > 0) {
      rows.sort((a, b) => a.day.localeCompare(b.day));
      msgRowsByTask.set(t.task_id, rows);
    }
  });

  const commentsByCase = new Map<number, string>();
  const commentsJob = async () => {
    try {
      const map = await fetchCaseCommentsByCaseIds(allCaseIds);
      for (const [k, v] of map) commentsByCase.set(k, v);
    } catch (err) {
      failures.push(`case-comments-bq: ${err instanceof Error ? err.message.slice(0, 80) : err}`);
    }
  };

  await runWithConcurrency([...activityJobs, ...caseJobs, ...messageJobs, commentsJob], CONCURRENCY);

  // ---- Assemble per-task aggregates + messages ----
  for (const t of tasks) {
    const caseIds = casesByTask.get(t.task_id) ?? [];
    const joinCase = (m: Map<number, string>) => {
      const parts = caseIds.map((id) => m.get(id)).filter(Boolean);
      return parts.length > 0 ? parts.join(' | ') : null;
    };
    const agg: CaseAggregate = {
      task_id: t.task_id,
      task_notes_text: notesByTask.get(t.task_id) ?? null,
      history_text: historyByTask.get(t.task_id) ?? null,
      comments_text: joinCase(commentsByCase),
      events_text: joinCase(eventsByCase),
      assessment_text: joinCase(assessByCase),
    };
    if (Object.values(agg).some((v) => typeof v === 'string' && v)) aggs.set(t.task_id, agg);

    const rows = msgRowsByTask.get(t.task_id);
    if (rows) {
      const built = buildTaskMessages(rows).get(t.task_id);
      if (built) msgs.set(t.task_id, built);
    }
  }

  return { aggs, msgs, caseStats, casesByTask, nAttached, failures };
}

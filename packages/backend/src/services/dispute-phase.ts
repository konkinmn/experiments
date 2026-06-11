import { getPromptById } from './prompts.js';
import {
  fetchCaseTimeline,
  fetchCaseDetails,
  type CaseTimeline,
  type CaseDetails,
} from './case-api.js';
import { analyzeWithLLM, type Message } from './llm-api.js';

const PHASE_PROMPT_ID = 'dispute-phase-check';

/** Parsed output of the dispute-phase-check prompt (Phase 0–5 / NEW / UNKNOWN). */
export interface PhaseResult {
  current_phase: string;
  phase_title: string;
  next_action: string;
  timeline_events?: Record<string, boolean>;
  key_dates?: Record<string, string | null>;
  dispute_details?: { amount: string | null; merchant: string | null; customer_name: string | null };
  notes?: string;
  [key: string]: unknown;
}

/**
 * Extract the first top-level JSON object from a string that may carry trailing
 * text after the closing brace. Brace counting that respects string literals.
 */
export function extractJsonObject(text: string): unknown | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(text.substring(start, i + 1));
    }
  }
  return null;
}

/** 3-tier LLM JSON parse: markdown code block → full parse → brace extraction. Returns the raw string on failure. */
export function parseAnalysisJson(content: string): unknown {
  try {
    const m = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (m) return JSON.parse(m[1]);
    return JSON.parse(content);
  } catch {
    try {
      const extracted = extractJsonObject(content);
      return extracted !== null ? extracted : content;
    } catch {
      return content;
    }
  }
}

/** Build the LLM messages for a phase check: prompt + case metadata (system), timeline (+ optional context) (user). */
export function buildPhaseMessages(
  caseDetails: CaseDetails,
  timeline: CaseTimeline,
  promptContent: string,
  extraContext?: string,
): Message[] {
  const wsLink = `https://chat-workstation.k1.anna.money/${caseDetails.alias}/tasks/cases?chatWindow=chat&caseId=${caseDetails.id}`;
  const caseMetadata = JSON.stringify({ ...caseDetails, ws_link: wsLink }, null, 2);
  const messages: Message[] = [
    {
      role: 'system',
      content: `${promptContent}\n\n## Case metadata:\n\`\`\`json\n${caseMetadata}\n\`\`\``,
    },
  ];
  let user = `Analyze this case timeline:\n\n${JSON.stringify(timeline.timeline, null, 2)}`;
  if (extraContext) user += `\n\n## Dispute case actions (structured lifecycle):\n${extraContext}`;
  messages.push({ role: 'user', content: user });
  return messages;
}

/**
 * Run the dispute phase-check for a single case: fetch its timeline + details, run the
 * `dispute-phase-check` prompt through the LLM, and return the parsed phase. `extraContext`
 * (e.g. the structured dispute case actions) is appended to the timeline so the LLM grounds
 * the phase in the real form/evidence/handover state.
 */
export async function runPhaseCheck(
  caseId: number,
  opts?: { extraContext?: string },
): Promise<PhaseResult | null> {
  const prompt = await getPromptById(PHASE_PROMPT_ID);
  if (!prompt) throw new Error(`Prompt not found: ${PHASE_PROMPT_ID}`);
  const [timeline, caseDetails] = await Promise.all([
    fetchCaseTimeline(caseId),
    fetchCaseDetails(caseId),
  ]);
  const messages = buildPhaseMessages(caseDetails, timeline, prompt.content, opts?.extraContext);
  const response = await analyzeWithLLM(messages);
  const parsed = parseAnalysisJson(response.content);
  return parsed && typeof parsed === 'object' ? (parsed as PhaseResult) : null;
}

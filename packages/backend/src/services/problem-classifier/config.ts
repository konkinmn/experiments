/**
 * Payment problem classifier — the one place a model, a transport or a tuning knob is
 * chosen.
 *
 * Nothing else in the classifier names a model: the stages are picked here so a
 * measurement run, a pilot run and a production run differ by environment only.
 * The provider is `VERTEX_AI` because that is what anna-llm-proxy routes Claude
 * through — `ANTHROPIC` is deprecated for routing there (it survives only in cost
 * calculation), so it is not a default worth carrying.
 *
 * Env keys: PC_MODEL_EXTRACT, PC_MODEL_PICK, PC_MODEL_READ, PC_MODEL_INDUCE,
 * PC_MODEL_ASSIGN, PC_LLM_PROVIDER, PC_LLM_BASE_URL, PC_LLM_STREAM, PC_CONCURRENCY,
 * PC_INDUCE_SAMPLE.
 */

export type ProblemClassifierStage = 'extract' | 'pick' | 'read' | 'induce' | 'assign';

export interface ProblemClassifierModels {
  /** pass 1a — what the text says about the payment. */
  extract: string;
  /** pass 1b — one shortlist handle or NOT_FOUND. */
  pick: string;
  /** pass 2 — read the thread against the identified payment. */
  read: string;
  /** the taxonomy-induction pass over pass-2 output. */
  induce: string;
  /** pass 3 two-step — place each reading against the induced category set. */
  assign: string;
  /** anna-llm-proxy `LLMProvider`. */
  provider: string;
}

function env(key: string, fallback: string): string {
  const value = process.env[key];
  return value == null || value.trim() === '' ? fallback : value.trim();
}

function optionalEnv(key: string): string | undefined {
  const value = process.env[key];
  return value == null || value.trim() === '' ? undefined : value.trim();
}

/**
 * A count from the environment. Refused rather than clamped when it is not a positive
 * integer: a silently corrected `PC_CONCURRENCY=0` would look exactly like the run that
 * was asked for, and this throws at import so it fails before a plan is printed.
 */
function intEnv(key: string, fallback: number): number {
  const raw = optionalEnv(key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${key} must be a positive integer, got "${raw}"`);
  }
  return value;
}

const INDUCE_MODEL = env('PC_MODEL_INDUCE', 'claude-opus-4-8');

export const PROBLEM_CLASSIFIER_MODELS: ProblemClassifierModels = {
  extract: env('PC_MODEL_EXTRACT', 'claude-haiku-4-5'),
  pick: env('PC_MODEL_PICK', 'claude-haiku-4-5'),
  read: env('PC_MODEL_READ', 'claude-opus-4-8'),
  induce: INDUCE_MODEL,
  /* Assignment is the same taxonomy judgement as induction, so it follows the induce
   * model unless it is overridden on its own. */
  assign: env('PC_MODEL_ASSIGN', INDUCE_MODEL),
  provider: env('PC_LLM_PROVIDER', 'VERTEX_AI'),
};

export function modelForStage(stage: ProblemClassifierStage): string {
  return PROBLEM_CLASSIFIER_MODELS[stage];
}

export interface ProblemClassifierTuning {
  /**
   * `PC_CONCURRENCY` — how many calls a pass has in flight at once: pass 1 and pass 2
   * at thread level, pass 3 at assign-batch level. Three keeps the stage proxy
   * comfortable; it tolerates 6.
   */
  concurrency: number;
  /**
   * `PC_INDUCE_SAMPLE` — the most readings a pass-3 induce call is sent. Over this,
   * two-step mode induces the categories from a seeded random sample of that many and
   * still assigns every reading; one-call mode refuses, because inducing and assigning
   * in the same answer cannot be done over a sample.
   */
  induceSampleSize: number;
}

export const PROBLEM_CLASSIFIER_TUNING: ProblemClassifierTuning = {
  concurrency: intEnv('PC_CONCURRENCY', 3),
  induceSampleSize: intEnv('PC_INDUCE_SAMPLE', 400),
};

export interface ProblemClassifierTransport {
  /**
   * `PC_LLM_BASE_URL` — the proxy this tool alone talks to, overriding
   * `LLM_API_BASE_URL`/`ANNA_LLM_PROXY_URL`. `undefined` leaves the client's default in
   * place. The reason it exists: the stage proxy enforces a 60 s `REQUEST_TIMEOUT` on
   * the buffered endpoint, and pointing this one tool at the production proxy is a
   * smaller change than moving the whole repo's LLM config. Since streaming is not
   * available (below), this is *the* mitigation for that timeout, together with pass 3's
   * two-step mode.
   */
  baseUrl: string | undefined;
  /**
   * `PC_LLM_STREAM` — `1` sends every classifier call over `/api/chat/stream`; anything
   * else, the default included, uses the buffered `/api/chat`.
   *
   * The default is `0` because the proxy cannot stream Claude at all: every
   * `/api/chat/stream` call to stage came back
   * `400 {"error":{"code":4,"message":"Streaming is not supported by
   * AnthropicSDKAdapter"}}`. Setting it to `1` is only worth trying if the proxy gains
   * support; until then `runner.ts` catches that 400 on the first call and falls back to
   * the buffered client for the rest of the process.
   */
  stream: boolean;
}

export const PROBLEM_CLASSIFIER_TRANSPORT: ProblemClassifierTransport = {
  baseUrl: optionalEnv('PC_LLM_BASE_URL'),
  stream: env('PC_LLM_STREAM', '0') === '1',
};

export interface TextContent {
  type: 'text';
  text: string;
}

export interface FileContent {
  type: 'file';
  file: {
    filename: string;
    file_data: string;
  };
}

export interface ImageUrlContent {
  type: 'image_url';
  image_url: {
    url: string;
  };
}

export type ContentPart = TextContent | FileContent | ImageUrlContent;

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

export interface LLMResponse {
  content: string;
}

// Prefer LLM_API_BASE_URL; fall back to ANNA_LLM_PROXY_URL (the anna-case bridge convention
// used by this repo's .env) so the standalone LLM client works without duplicate config.
const LLM_API_BASE_URL = process.env.LLM_API_BASE_URL || process.env.ANNA_LLM_PROXY_URL || '';
const LLM_PROVIDER = process.env.LLM_PROVIDER || 'ANTHROPIC';
const LLM_MODEL = process.env.LLM_MODEL || 'claude-sonnet-4-5@20250929';

const FILE_PARSE_PROVIDER = process.env.FILE_PARSE_PROVIDER || 'GOOGLE';
const FILE_PARSE_MODEL = process.env.FILE_PARSE_MODEL || 'gemini-2.5-flash';
const LLM_FETCH_TIMEOUT_MS = 120_000;

interface ChatResponse {
  data?: {
    message?: string;
  };
  error?: Record<string, unknown>;
}

/**
 * The proxy's `Usage` (anna-llm-proxy `llm_proxy/schema/data.py`), snake_case over the
 * wire. `total_cost_usd` is `float | None` there — the proxy prices only the models it
 * holds a rate card for, so a null is a legitimate answer, not an error.
 */
export interface LLMUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  total_cost_usd: number | null;
}

export interface LLMUsageResponse {
  content: string;
  usage: LLMUsage;
  model: string;
  provider: string;
}

type RawUsage = Partial<Record<keyof LLMUsage, unknown>>;

interface ChatUsageResponse {
  data?: {
    message?: string | null;
    usage?: RawUsage;
  };
  error?: Record<string, unknown>;
}

function usageInt(raw: unknown): number {
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

function readUsage(raw: RawUsage | undefined): LLMUsage {
  const cost = Number(raw?.total_cost_usd);
  return {
    input_tokens: usageInt(raw?.input_tokens),
    output_tokens: usageInt(raw?.output_tokens),
    cache_creation_input_tokens: usageInt(raw?.cache_creation_input_tokens),
    cache_read_input_tokens: usageInt(raw?.cache_read_input_tokens),
    total_cost_usd: raw?.total_cost_usd == null || !Number.isFinite(cost) ? null : cost,
  };
}

/**
 * `analyzeWithLLM` plus the token accounting, with the provider as an explicit option
 * rather than derived from the model name — `VERTEX_AI` serves both Claude and Gemini,
 * so the name cannot decide it.
 *
 * Unlike `analyzeWithLLM` this does not throw on an empty `message`: a caller sending
 * `max_tokens: 1` to size a prompt wants the usage, and the content may be blank.
 */
export interface LLMUsageOptions {
  model?: string;
  maxTokens?: number;
  provider?: string;
  temperature?: number;
  /**
   * Proxy `ResponseFormat`. `JSON` is accepted for every provider by the proxy's
   * request schema, but the Anthropic SDK adapter ignores anything short of
   * `JSON_SCHEMA` — so on `VERTEX_AI` + Claude this is a no-op and the caller still
   * has to parse loosely. Sent only when set, so the default stays `TEXT`.
   */
  responseFormat?: 'TEXT' | 'JSON';
  /**
   * Override the proxy this one call goes to. The module constant stays the default;
   * a caller passes this when stage and production have to be told apart per tool
   * rather than per process.
   */
  baseUrl?: string;
}

/** The JSON body both transports post — the only difference is the path. */
function chatRequestBody(messages: Message[], options: {
  model: string;
  provider: string;
  maxTokens: number;
  temperature: number;
  responseFormat?: 'TEXT' | 'JSON';
}): string {
  return JSON.stringify({
    messages,
    provider: options.provider,
    model: options.model,
    temperature: options.temperature,
    seed: 777,
    max_tokens: options.maxTokens,
    ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
  });
}

export async function analyzeWithLLMUsage(
  messages: Message[],
  options?: LLMUsageOptions,
): Promise<LLMUsageResponse> {
  const baseUrl = options?.baseUrl || LLM_API_BASE_URL;
  if (!baseUrl) {
    throw new Error('LLM_API_BASE_URL is not configured');
  }

  const model = options?.model || LLM_MODEL;
  const provider = options?.provider || LLM_PROVIDER;
  const maxTokens = options?.maxTokens ?? 4096;
  const temperature = options?.temperature ?? 0;

  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.API_TOKEN || ''}`,
    },
    body: chatRequestBody(messages, {
      model,
      provider,
      maxTokens,
      temperature,
      responseFormat: options?.responseFormat,
    }),
    signal: AbortSignal.timeout(LLM_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM API error: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as ChatUsageResponse;

  if (data.error && Object.keys(data.error).length > 0) {
    throw new Error(`LLM API error: ${JSON.stringify(data.error)}`);
  }

  return {
    content: data.data?.message ?? '',
    usage: readUsage(data.data?.usage),
    model,
    provider,
  };
}

/* ------------------------------------------------------------ the SSE transport */

/**
 * `/api/chat/stream`'s frames, verified against anna-llm-proxy `llm_proxy/views.py`
 * (`ChatStreamView._sse_event`, `_write_terminal`, `_stream_error_payload`).
 *
 * The error frame nests its fields under `error` — `{"type":"error","error":{code,
 * message}}` — not flat at the top level. Both shapes are read here so a flat variant
 * would still surface a message rather than an empty string.
 */
interface StreamFrame {
  type?: string;
  delta?: unknown;
  usage?: RawUsage;
  error?: { code?: unknown; message?: unknown };
  code?: unknown;
  message?: unknown;
}

/** What a completed SSE read yields; `model` and `provider` come from the request. */
export interface SseStreamResult {
  content: string;
  usage: LLMUsage;
}

/**
 * A stream that stopped before its terminal frame. Carries no `LLM API error:` prefix
 * on purpose: the classifier's `isRetryableCallError` reads that prefix as "the proxy
 * answered and said no", and a truncated stream is the opposite — nothing was answered,
 * so it is worth one retry.
 */
const STREAM_TRUNCATED = 'LLM stream ended without a terminal done or error event';

/**
 * Concatenate an SSE response body into one message plus its usage.
 *
 * Exported so the frame handling can be exercised against a fabricated byte stream:
 * every branch that matters here (a frame split across two chunks, a keepalive comment,
 * a terminal frame that never arrives) is invisible to a test that can only call the
 * fetch wrapper.
 *
 * Returns on the first terminal frame rather than waiting for `data: [DONE]`, so a
 * proxy that dies between the two is a completed read and not a truncation.
 */
export async function readChatSseStream(
  body: ReadableStream<Uint8Array>,
): Promise<SseStreamResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let usage: LLMUsage | null = null;
  let errorMessage: string | null = null;

  /** Returns true once a terminal frame has been seen and reading should stop. */
  const handleLine = (rawLine: string): boolean => {
    const line = rawLine.replace(/\r$/, '');
    if (line.trim() === '') return false;
    /* `: keepalive` — a comment, and the only thing the proxy sends while it waits. */
    if (line.startsWith(':')) return false;
    if (!line.startsWith('data:')) return false;
    const payload = line.slice('data:'.length).trim();
    if (payload === '' || payload === '[DONE]') return false;

    let frame: StreamFrame;
    try {
      frame = JSON.parse(payload) as StreamFrame;
    } catch {
      /* Unparseable frame: the transport, not the model. Retryable, like a truncation. */
      throw new Error(`LLM stream frame is not JSON: ${payload.slice(0, 200)}`);
    }

    if (frame.type === 'delta') {
      if (typeof frame.delta === 'string') content += frame.delta;
      return false;
    }
    if (frame.type === 'done') {
      usage = readUsage(frame.usage);
      return true;
    }
    if (frame.type === 'error') {
      const message = frame.error?.message ?? frame.message;
      const code = frame.error?.code ?? frame.code;
      errorMessage = typeof message === 'string' && message !== ''
        ? message
        : 'the proxy reported a stream error with no message';
      if (code != null) errorMessage += ` (stream error code ${String(code)})`;
      return true;
    }
    /* An unknown `type` is a proxy the client has not been taught yet; ignore it. */
    return false;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value !== undefined) buffer += decoder.decode(value, { stream: true });
      if (done) buffer += decoder.decode();

      let terminal = false;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (handleLine(line)) {
          terminal = true;
          break;
        }
      }
      if (terminal) break;
      if (done) {
        /* A last line with no trailing newline still counts. */
        if (buffer !== '') handleLine(buffer);
        break;
      }
    }
  } finally {
    /* Returning early leaves the socket open otherwise. */
    await reader.cancel().catch(() => undefined);
  }

  if (errorMessage != null) {
    /* Same prefix the buffered path uses for a proxy-reported failure, so the
     * classifier's retry rule treats the two identically: not worth a second call. */
    throw new Error(`LLM API error: ${errorMessage}`);
  }
  if (usage == null) {
    throw new Error(STREAM_TRUNCATED);
  }
  return { content, usage };
}

/**
 * `analyzeWithLLMUsage` over `/api/chat/stream` instead of `/api/chat` — same request
 * body, same return type.
 *
 * The reason to prefer it: the stage proxy enforces `REQUEST_TIMEOUT=60` s on the
 * buffered endpoint, which a long Opus call with a large `max_tokens` will exceed. The
 * streaming endpoint is governed by `MAX_STREAM_DURATION` (90 s by default) instead and
 * sends keepalive comments while it waits, so the same call survives.
 *
 * Provider and setup failures still arrive as a normal non-2xx JSON response, because
 * the proxy opens the provider stream before committing the 200 headers. Only a failure
 * after that point comes back in-band as an `error` frame.
 */
export async function analyzeWithLLMUsageStream(
  messages: Message[],
  options?: LLMUsageOptions,
): Promise<LLMUsageResponse> {
  const baseUrl = options?.baseUrl || LLM_API_BASE_URL;
  if (!baseUrl) {
    throw new Error('LLM_API_BASE_URL is not configured');
  }

  const model = options?.model || LLM_MODEL;
  const provider = options?.provider || LLM_PROVIDER;
  const maxTokens = options?.maxTokens ?? 4096;
  const temperature = options?.temperature ?? 0;

  const response = await fetch(`${baseUrl}/api/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${process.env.API_TOKEN || ''}`,
    },
    body: chatRequestBody(messages, {
      model,
      provider,
      maxTokens,
      temperature,
      responseFormat: options?.responseFormat,
    }),
    signal: AbortSignal.timeout(LLM_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM API error: ${response.status} ${errorText}`);
  }
  if (!response.body) {
    throw new Error('LLM stream response carried no body');
  }

  const { content, usage } = await readChatSseStream(response.body);
  return { content, usage, model, provider };
}

function deriveProvider(model: string): string {
  if (model.startsWith('gemini')) return 'GOOGLE';
  return 'ANTHROPIC';
}

export async function analyzeWithLLM(
  messages: Message[],
  options?: { model?: string; maxTokens?: number },
): Promise<LLMResponse> {
  if (!LLM_API_BASE_URL) {
    throw new Error('LLM_API_BASE_URL is not configured');
  }

  const model = options?.model || LLM_MODEL;
  const provider = options?.model ? deriveProvider(options.model) : LLM_PROVIDER;
  const maxTokens = options?.maxTokens ?? 4096;

  const response = await fetch(`${LLM_API_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.API_TOKEN || ''}`,
    },
    body: JSON.stringify({
      messages,
      provider,
      model,
      temperature: 0,
      seed: 777,
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(LLM_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM API error: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as ChatResponse;

  if (data.error && Object.keys(data.error).length > 0) {
    throw new Error(`LLM API error: ${JSON.stringify(data.error)}`);
  }

  if (!data.data?.message) {
    throw new Error('LLM API response missing message');
  }

  return {
    content: data.data.message,
  };
}

export async function parseFileWithLLM(
  systemPrompt: string,
  userPrompt: string,
  filePart: ContentPart,
): Promise<string> {
  if (!LLM_API_BASE_URL) {
    throw new Error('LLM_API_BASE_URL is not configured');
  }

  const filePartSummary = filePart.type === 'file'
    ? { type: filePart.type, filename: filePart.file.filename, data_length: filePart.file.file_data.length }
    : filePart.type === 'image_url'
      ? { type: filePart.type, url_length: filePart.image_url.url.length }
      : { type: filePart.type };

  console.log('[FileParser] Sending request to Gemini:', JSON.stringify({
    provider: FILE_PARSE_PROVIDER,
    model: FILE_PARSE_MODEL,
    systemPrompt: `[${systemPrompt.length} chars]`,
    userPrompt,
    filePart: filePartSummary,
  }));

  const response = await fetch(`${LLM_API_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.API_TOKEN || ''}`,
    },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: [filePart, { type: 'text', text: userPrompt }] },
      ],
      provider: FILE_PARSE_PROVIDER,
      model: FILE_PARSE_MODEL,
      temperature: 0.2,
      max_tokens: 4096,
    }),
    signal: AbortSignal.timeout(LLM_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`File parse LLM error: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as ChatResponse;

  if (data.error && Object.keys(data.error).length > 0) {
    throw new Error(`File parse LLM error: ${JSON.stringify(data.error)}`);
  }

  if (!data.data?.message) {
    throw new Error('File parse LLM response missing message');
  }

  return data.data.message;
}

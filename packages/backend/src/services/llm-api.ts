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

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResponse {
  content: string;
}

const LLM_API_BASE_URL = process.env.LLM_API_BASE_URL || '';
const LLM_PROVIDER = process.env.LLM_PROVIDER || 'ANTHROPIC';
const LLM_MODEL = process.env.LLM_MODEL || 'claude-sonnet-4-5@20250929';

interface ChatResponse {
  data?: {
    message?: string;
  };
  error?: Record<string, unknown>;
}

export async function analyzeWithLLM(messages: Message[]): Promise<LLMResponse> {
  if (!LLM_API_BASE_URL) {
    throw new Error('LLM_API_BASE_URL is not configured');
  }

  const response = await fetch(`${LLM_API_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.API_TOKEN || ''}`,
    },
    body: JSON.stringify({
      messages,
      provider: LLM_PROVIDER,
      model: LLM_MODEL,
      temperature: 0,
      seed: 777,
    }),
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

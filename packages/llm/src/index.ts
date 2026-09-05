import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  StreamChunk,
  TokenUsage,
  ToolDefinition,
  AiProvider,
  ProviderConfig,
} from '@deepseek-ide/shared';
import { DEFAULT_LLM_BASE_URL, DEFAULT_LLM_MODEL } from '@deepseek-ide/shared';
import { AnthropicClient } from './anthropic';

export interface LlmClientOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
  fetchImpl?: typeof fetch;
}

export interface ChatParams {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  model?: string;
  signal?: AbortSignal;
}

export interface ChatStreamResult {
  message: ChatMessage;
  usage?: TokenUsage;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function buildHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function usageFromApi(usage?: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}): TokenUsage | undefined {
  if (!usage) return undefined;
  const promptTokens = usage.prompt_tokens;
  const completionTokens = usage.completion_tokens;
  const totalTokens =
    usage.total_tokens ??
    (promptTokens != null || completionTokens != null
      ? (promptTokens ?? 0) + (completionTokens ?? 0)
      : undefined);
  if (promptTokens == null && completionTokens == null && totalTokens == null) return undefined;
  return { promptTokens, completionTokens, totalTokens };
}

/** Rough heuristic when the gateway does not return usage. */
export function estimateTokensFromMessages(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length;
    if (m.name) chars += m.name.length;
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
    if (m.tool_call_id) chars += m.tool_call_id.length;
  }
  return Math.max(1, Math.ceil(chars / 4));
}

export function formatOpenAIMessages(messages: ChatMessage[]): any[] {
  return messages.map((m) => {
    if (m.role === 'user' && m.images && m.images.length > 0) {
      const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
      if (m.content) {
        parts.push({ type: 'text', text: m.content });
      }
      for (const img of m.images) {
        parts.push({
          type: 'image_url',
          image_url: { url: img.dataUrl },
        });
      }
      return {
        ...m,
        content: parts,
      };
    }
    return m;
  });
}

export class LlmClient {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly temperature: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LlmClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_LLM_BASE_URL);
    this.apiKey = options.apiKey ?? '';
    this.model = options.model ?? DEFAULT_LLM_MODEL;
    this.temperature = options.temperature ?? 0.2;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  withOptions(partial: LlmClientOptions): LlmClient {
    return new LlmClient({
      baseUrl: partial.baseUrl ?? this.baseUrl,
      apiKey: partial.apiKey ?? this.apiKey,
      model: partial.model ?? this.model,
      temperature: partial.temperature ?? this.temperature,
      fetchImpl: partial.fetchImpl ?? this.fetchImpl,
    });
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/models`, {
      method: 'GET',
      headers: buildHeaders(this.apiKey),
      signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`listModels failed (${res.status}): ${text}`);
    }
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    return (data.data ?? []).map((m) => m.id);
  }

  async chat(params: ChatParams): Promise<ChatMessage> {
    const body: ChatCompletionRequest = {
      model: params.model ?? this.model,
      messages: formatOpenAIMessages(params.messages),
      temperature: params.temperature ?? this.temperature,
      stream: false,
      tools: params.tools,
      tool_choice: params.tools?.length ? 'auto' : undefined,
    };

    const res = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(this.apiKey),
      body: JSON.stringify(body),
      signal: params.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`chat failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as ChatCompletionResponse;
    const message = data.choices?.[0]?.message;
    if (!message) {
      throw new Error('chat response missing message');
    }
    return message;
  }

  async *chatStream(params: ChatParams): AsyncGenerator<StreamChunk, ChatStreamResult, void> {
    const body: ChatCompletionRequest = {
      model: params.model ?? this.model,
      messages: formatOpenAIMessages(params.messages),
      temperature: params.temperature ?? this.temperature,
      stream: true,
      tools: params.tools,
      tool_choice: params.tools?.length ? 'auto' : undefined,
    };

    const res = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(this.apiKey),
      body: JSON.stringify(body),
      signal: params.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`chatStream failed (${res.status}): ${text}`);
    }
    if (!res.body) {
      throw new Error('chatStream response has no body');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    const toolCalls: NonNullable<ChatMessage['tool_calls']> = [];
    let role: ChatMessage['role'] = 'assistant';
    let usage: TokenUsage | undefined;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || !line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          continue;
        }
        let chunk: StreamChunk;
        try {
          chunk = JSON.parse(payload) as StreamChunk;
        } catch {
          continue;
        }
        const parsedUsage = usageFromApi(chunk.usage);
        if (parsedUsage) usage = parsedUsage;
        yield chunk;

        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.role) role = delta.role;
        if (typeof delta.content === 'string') content += delta.content;
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCalls[idx]) {
              toolCalls[idx] = {
                id: tc.id ?? `call_${idx}`,
                type: 'function',
                function: {
                  name: tc.function?.name ?? '',
                  arguments: tc.function?.arguments ?? '',
                },
              };
            } else {
              if (tc.id) toolCalls[idx].id = tc.id;
              if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
              if (tc.function?.arguments) {
                toolCalls[idx].function.arguments += tc.function.arguments;
              }
            }
          }
        }
      }
    }

    const message: ChatMessage = {
      role,
      content: content || null,
      tool_calls: toolCalls.length ? toolCalls : undefined,
    };
    return { message, usage };
  }

  /**
   * Collect a streamed response into a final assistant message while
   * optionally forwarding content tokens.
   */
  async chatStreamCollect(
    params: ChatParams,
    onToken?: (text: string) => void,
  ): Promise<ChatStreamResult> {
    const gen = this.chatStream(params);
    let final: ChatStreamResult | null = null;
    while (true) {
      const next = await gen.next();
      if (next.done) {
        final = next.value;
        break;
      }
      const delta = next.value.choices?.[0]?.delta;
      if (delta?.content) onToken?.(delta.content);
    }
    if (!final) {
      throw new Error('stream ended without message');
    }
    return final;
  }
}

/**
 * Unified LLM adapter that works with different providers
 */
export class UnifiedLlmClient {
  private openaiClient?: LlmClient;
  private anthropicClient?: AnthropicClient;
  readonly provider: AiProvider;
  readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.provider = config.provider;
    this.config = config;

    if (config.provider === 'anthropic') {
      this.anthropicClient = new AnthropicClient({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        enableThinking: config.enableThinking,
        thinkingTokens: config.thinkingTokens,
      });
    } else {
      // OpenAI, Deepseek, Custom all use OpenAI-compatible API
      this.openaiClient = new LlmClient({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
      });
    }
  }

  async chat(params: ChatParams): Promise<ChatMessage> {
    if (this.anthropicClient) {
      return this.anthropicClient.chat(params);
    }
    if (this.openaiClient) {
      return this.openaiClient.chat(params);
    }
    throw new Error('No client initialized');
  }

  async chatStreamCollect(
    params: ChatParams,
    onToken?: (text: string) => void,
    onThinking?: (thinking: string) => void,
  ): Promise<ChatStreamResult> {
    if (this.anthropicClient) {
      return this.anthropicClient.chatStreamCollect(params, onToken, onThinking);
    }
    if (this.openaiClient) {
      return this.openaiClient.chatStreamCollect(params, onToken);
    }
    throw new Error('No client initialized');
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    if (this.openaiClient) {
      return this.openaiClient.listModels(signal);
    }
    // Anthropic doesn't have a models list endpoint, return defaults
    return [
      'claude-opus-4-20250514',
      'claude-sonnet-4-20250514',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
    ];
  }
}

export { AnthropicClient };

export async function probeLlm(options: LlmClientOptions = {}): Promise<{
  ok: boolean;
  detail: string;
  models?: string[];
  supportsTools?: boolean;
}> {
  const client = new LlmClient(options);
  try {
    let models: string[] = [];
    try {
      models = await client.listModels();
    } catch (err) {
      models = [];
      void err;
    }

    const message = await client.chat({
      messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
      temperature: 0,
    });

    let supportsTools = false;
    try {
      const toolMsg = await client.chat({
        messages: [{ role: 'user', content: 'Call the ping tool once.' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'ping',
              description: 'A simple ping tool',
              parameters: {
                type: 'object',
                properties: {
                  note: { type: 'string' },
                },
              },
            },
          },
        ],
      });
      supportsTools = Boolean(toolMsg.tool_calls?.length);
    } catch {
      supportsTools = false;
    }

    return {
      ok: true,
      detail: `chat ok; content=${JSON.stringify(message.content)}; tools=${supportsTools}`,
      models,
      supportsTools,
    };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

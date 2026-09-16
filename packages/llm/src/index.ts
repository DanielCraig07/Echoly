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
import { AnthropicClient, formatLlmErrorMessage } from './anthropic';

export type LlmTimeoutCode = 'FIRST_TOKEN_TIMEOUT' | 'STREAM_STALL_TIMEOUT' | 'REQUEST_TIMEOUT';

export class LlmTimeoutError extends Error {
  readonly code: LlmTimeoutCode;
  readonly timeoutMs: number;

  constructor(message: string, code: LlmTimeoutCode, timeoutMs: number) {
    super(message);
    this.name = 'LlmTimeoutError';
    this.code = code;
    this.timeoutMs = timeoutMs;
  }
}

export function isLlmTimeoutError(err: unknown): err is LlmTimeoutError {
  return (
    err instanceof LlmTimeoutError ||
    (err instanceof Error &&
      (err.name === 'LlmTimeoutError' ||
        /FIRST_TOKEN_TIMEOUT|STREAM_STALL_TIMEOUT|REQUEST_TIMEOUT/i.test(err.message)))
  );
}

export interface LlmClientOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
  fetchImpl?: typeof fetch;
  firstTokenTimeoutMs?: number;
  streamStallTimeoutMs?: number;
}

export interface ChatParams {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  model?: string;
  signal?: AbortSignal;
  firstTokenTimeoutMs?: number;
  streamStallTimeoutMs?: number;
}

export interface ChatStreamResult {
  message: ChatMessage;
  usage?: TokenUsage;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

function buildHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'claude-cli/2.1.158 (external, cli)',
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
    const hasImages = Boolean(m.images && m.images.length > 0);
    const hasDocs = Boolean(m.documents && m.documents.length > 0);

    if (m.role === 'user' && (hasImages || hasDocs)) {
      const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
      if (m.content) {
        parts.push({ type: 'text', text: m.content });
      }
      if (hasImages && m.images) {
        for (const img of m.images) {
          parts.push({
            type: 'image_url',
            image_url: { url: img.dataUrl },
          });
        }
      }
      if (hasDocs && m.documents) {
        for (const doc of m.documents) {
          // For documents with dataUrl: many multimodal gateways (e.g. GPT-4o, Claude proxy) accept dataUrl as image_url or file reference
          if (doc.dataUrl) {
            parts.push({
              type: 'image_url',
              image_url: { url: doc.dataUrl },
            });
          }
        }
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
  readonly firstTokenTimeoutMs: number;
  readonly streamStallTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LlmClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_LLM_BASE_URL);
    this.apiKey = options.apiKey ?? '';
    this.model = options.model ?? DEFAULT_LLM_MODEL;
    this.temperature = options.temperature ?? 0.2;
    this.firstTokenTimeoutMs = options.firstTokenTimeoutMs ?? 60_000;
    this.streamStallTimeoutMs = options.streamStallTimeoutMs ?? 90_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  withOptions(partial: LlmClientOptions): LlmClient {
    return new LlmClient({
      baseUrl: partial.baseUrl ?? this.baseUrl,
      apiKey: partial.apiKey ?? this.apiKey,
      model: partial.model ?? this.model,
      temperature: partial.temperature ?? this.temperature,
      firstTokenTimeoutMs: partial.firstTokenTimeoutMs ?? this.firstTokenTimeoutMs,
      streamStallTimeoutMs: partial.streamStallTimeoutMs ?? this.streamStallTimeoutMs,
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
      throw new Error(`listModels: ${formatLlmErrorMessage(res.status, text)}`);
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

    const firstTokenTimeout = params.firstTokenTimeoutMs ?? this.firstTokenTimeoutMs;
    const abortController = new AbortController();
    let timedOutError: LlmTimeoutError | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    if (firstTokenTimeout > 0) {
      timer = setTimeout(() => {
        timedOutError = new LlmTimeoutError(
          `模型请求响应超时（已等待 ${Math.round(firstTokenTimeout / 1000)} 秒），推理节点响应挂起`,
          'REQUEST_TIMEOUT',
          firstTokenTimeout,
        );
        abortController.abort();
      }, firstTokenTimeout);
    }

    const onAbort = () => abortController.abort();
    if (params.signal) {
      if (params.signal.aborted) abortController.abort();
      else params.signal.addEventListener('abort', onAbort, { once: true });
    }

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: buildHeaders(this.apiKey),
        body: JSON.stringify(body),
        signal: abortController.signal,
      });
    } catch (fetchErr) {
      if (timedOutError) throw timedOutError;
      throw fetchErr;
    } finally {
      if (timer) clearTimeout(timer);
      if (params.signal) params.signal.removeEventListener('abort', onAbort);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(formatLlmErrorMessage(res.status, text));
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

    const firstTokenTimeout = params.firstTokenTimeoutMs ?? this.firstTokenTimeoutMs;
    const streamStallTimeout = params.streamStallTimeoutMs ?? this.streamStallTimeoutMs;

    const abortController = new AbortController();
    let timedOutError: LlmTimeoutError | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const resetWatchdog = (ms: number, code: LlmTimeoutCode, msg: string) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (ms <= 0) return;
      timeoutTimer = setTimeout(() => {
        timedOutError = new LlmTimeoutError(msg, code, ms);
        abortController.abort();
      }, ms);
    };

    const onAbort = () => abortController.abort();
    if (params.signal) {
      if (params.signal.aborted) abortController.abort();
      else params.signal.addEventListener('abort', onAbort, { once: true });
    }

    resetWatchdog(
      firstTokenTimeout,
      'FIRST_TOKEN_TIMEOUT',
      `首个 Token 响应超时（已等待 ${Math.round(firstTokenTimeout / 1000)} 秒），推理节点响应挂起或显存过载`,
    );

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: buildHeaders(this.apiKey),
        body: JSON.stringify(body),
        signal: abortController.signal,
      });
    } catch (fetchErr) {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (params.signal) params.signal.removeEventListener('abort', onAbort);
      if (timedOutError) throw timedOutError;
      throw fetchErr;
    }

    if (!res.ok) {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (params.signal) params.signal.removeEventListener('abort', onAbort);
      const text = await res.text();
      throw new Error(formatLlmErrorMessage(res.status, text));
    }
    if (!res.body) {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (params.signal) params.signal.removeEventListener('abort', onAbort);
      throw new Error('chatStream response has no body');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let reasoningContent = '';
    const toolCalls: NonNullable<ChatMessage['tool_calls']> = [];
    let role: ChatMessage['role'] = 'assistant';
    let usage: TokenUsage | undefined;
    let receivedFirstChunk = false;

    try {
      while (true) {
        let readResult: { done: boolean; value?: Uint8Array };
        try {
          readResult = await reader.read();
        } catch (readErr) {
          if (timedOutError) throw timedOutError;
          throw readErr;
        }

        const { done, value } = readResult;
        if (done) break;

        if (!receivedFirstChunk) {
          receivedFirstChunk = true;
        }
        resetWatchdog(
          streamStallTimeout,
          'STREAM_STALL_TIMEOUT',
          `流式输出停滞超过 ${Math.round(streamStallTimeout / 1000)} 秒未产生新内容`,
        );

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
          const reasoningDelta = delta.reasoning_content ?? (delta as any).reasoning;
          if (typeof reasoningDelta === 'string') reasoningContent += reasoningDelta;
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
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (params.signal) params.signal.removeEventListener('abort', onAbort);
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }

    const message: ChatMessage = {
      role,
      content: content || null,
      reasoning_content: reasoningContent || undefined,
      tool_calls: toolCalls.length ? toolCalls : undefined,
    };
    return { message, usage };
  }

  /**
   * Collect a streamed response into a final assistant message while
   * optionally forwarding content tokens and thinking tokens.
   */
  async chatStreamCollect(
    params: ChatParams,
    onToken?: (text: string) => void,
    onThinking?: (thinking: string) => void,
  ): Promise<ChatStreamResult> {
    const gen = this.chatStream(params);
    let final: ChatStreamResult | null = null;
    let inThinkTag = false;

    while (true) {
      const next = await gen.next();
      if (next.done) {
        final = next.value;
        break;
      }
      const delta = next.value.choices?.[0]?.delta;
      const reasoningDelta = delta?.reasoning_content ?? (delta as any)?.reasoning;
      if (typeof reasoningDelta === 'string' && reasoningDelta) {
        onThinking?.(reasoningDelta);
      }

      if (delta?.content) {
        let text = delta.content;
        if (text.includes('<think>')) {
          inThinkTag = true;
          const parts = text.split('<think>');
          if (parts[0]) onToken?.(parts[0]);
          text = parts.slice(1).join('<think>');
        }
        if (inThinkTag) {
          if (text.includes('</think>')) {
            const parts = text.split('</think>');
            if (parts[0]) onThinking?.(parts[0]);
            inThinkTag = false;
            const remaining = parts.slice(1).join('</think>');
            if (remaining) onToken?.(remaining);
          } else {
            onThinking?.(text);
          }
        } else {
          onToken?.(text);
        }
      }
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
      return this.openaiClient.chatStreamCollect(params, onToken, onThinking);
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

export interface ProbeLlmOptions extends LlmClientOptions {
  provider?: AiProvider | string;
  enableThinking?: boolean;
  thinkingTokens?: number;
}

export async function probeLlm(options: ProbeLlmOptions = {}): Promise<{
  ok: boolean;
  detail: string;
  models?: string[];
  supportsTools?: boolean;
}> {
  if (options.provider === 'anthropic') {
    const client = new AnthropicClient({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey || '',
      model: options.model,
      enableThinking: options.enableThinking,
      thinkingTokens: options.thinkingTokens,
      fetchImpl: options.fetchImpl,
    });
    try {
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

      const models = [
        'claude-3-7-sonnet-20250219',
        'claude-3-5-sonnet-20241022',
        'claude-3-5-haiku-20241022',
      ];

      return {
        ok: true,
        detail: `连接成功; 返回内容=${JSON.stringify(message.content)}; 支持工具=${supportsTools}`,
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

  const client = new LlmClient(options);
  try {
    let models: string[] = [];
    try {
      models = await client.listModels();
    } catch {
      models = [];
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
      detail: `连接成功; 返回内容=${JSON.stringify(message.content)}; 支持工具=${supportsTools}`,
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

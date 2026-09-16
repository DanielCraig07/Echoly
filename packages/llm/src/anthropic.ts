import type {
  ChatMessage,
  TokenUsage,
  ToolDefinition,
  ThinkingBlock,
} from '@deepseek-ide/shared';
import { LlmTimeoutError, type LlmTimeoutCode } from './index';

export interface AnthropicClientOptions {
  baseUrl?: string;
  apiKey: string;
  model?: string;
  temperature?: number;
  enableThinking?: boolean;
  thinkingTokens?: number;
  fetchImpl?: typeof fetch;
  firstTokenTimeoutMs?: number;
  streamStallTimeoutMs?: number;
}

export interface AnthropicChatParams {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  model?: string;
  signal?: AbortSignal;
  firstTokenTimeoutMs?: number;
  streamStallTimeoutMs?: number;
}

export interface AnthropicChatResult {
  message: ChatMessage;
  usage?: TokenUsage;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'thinking'; thinking: string }
    | {
        type: 'tool_use';
        id: string;
        name: string;
        input: Record<string, unknown>;
      }
    | { type: 'tool_result'; tool_use_id: string; content: string }
    | {
        type: 'image';
        source: {
          type: 'base64';
          media_type: string;
          data: string;
        };
      }
    | {
        type: 'document';
        source: {
          type: 'base64';
          media_type: string;
          data: string;
        };
      }
  >;
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

function convertToAnthropicMessages(messages: ChatMessage[]): AnthropicMessage[] {
  return messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      const content: AnthropicMessage['content'] = [];

      // Handle text content
      if (m.content) {
        content.push({ type: 'text', text: m.content });
      }

      // Handle image attachments
      if (m.images?.length) {
        for (const img of m.images) {
          const rawBase64 = img.dataUrl.includes('base64,')
            ? img.dataUrl.split('base64,')[1]
            : img.dataUrl;
          content.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: (img.mediaType || 'image/png') as
                'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: rawBase64,
            },
          });
        }
      }

      // Handle document attachments (e.g. PDF)
      if (m.documents?.length) {
        for (const doc of m.documents) {
          const rawBase64 = doc.dataUrl.includes('base64,')
            ? doc.dataUrl.split('base64,')[1]
            : doc.dataUrl;
          if (doc.mediaType === 'application/pdf' || doc.mediaType?.includes('pdf')) {
            content.push({
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: rawBase64,
              },
            });
          } else if (doc.mediaType?.startsWith('image/')) {
            content.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: doc.mediaType,
                data: rawBase64,
              },
            });
          }
        }
      }

      // Handle thinking blocks
      if (m.thinking?.length) {
        content.push(...m.thinking);
      }

      // Handle tool calls (from assistant)
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          let parsedInput: Record<string, unknown> = {};
          try {
            parsedInput = JSON.parse(tc.function.arguments || '{}');
          } catch {
            parsedInput = {};
          }
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: parsedInput,
          });
        }
      }

      // Handle tool results (from tool role)
      if (m.role === 'tool' && m.tool_call_id && m.content) {
        content.push({
          type: 'tool_result',
          tool_use_id: m.tool_call_id,
          content: m.content,
        });
      }

      return {
        role: m.role === 'user' ? 'user' : 'assistant',
        content,
      };
    });
}

function convertToAnthropicTools(tools?: ToolDefinition[]): AnthropicTool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

function convertFromAnthropicMessage(response: any): ChatMessage {
  const message: ChatMessage = {
    role: 'assistant',
    content: '',
  };

  const thinking: ThinkingBlock[] = [];
  const textParts: string[] = [];
  const toolCalls: NonNullable<ChatMessage['tool_calls']> = [];

  for (const block of response.content || []) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'thinking') {
      thinking.push({ type: 'thinking', thinking: block.thinking });
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    }
  }

  message.content = textParts.join('\n') || null;
  if (thinking.length) message.thinking = thinking;
  if (toolCalls.length) message.tool_calls = toolCalls;

  return message;
}

export function formatLlmErrorMessage(status: number, rawText: string): string {
  let detail = '';
  try {
    const parsed = JSON.parse(rawText);
    detail =
      parsed.error?.message ||
      parsed.message ||
      parsed.error?.detail ||
      (typeof parsed.error === 'string' ? parsed.error : '');
  } catch {
    detail = rawText.trim();
  }

  let statusText = `HTTP ${status}`;
  if (status === 401) statusText += ' (认证失败)';
  else if (status === 403) statusText += ' (权限拒绝)';
  else if (status === 404) statusText += ' (端点不存在)';
  else if (status === 429) statusText += ' (频次受限/余额不足)';
  else if (status >= 500) statusText += ' (服务端异常)';

  if (detail) {
    if (detail.length > 250) {
      detail = detail.slice(0, 250) + '...';
    }
    return `${statusText}: ${detail}`;
  }
  return `${statusText}: 请求失败`;
}

function buildHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14',
    'User-Agent': 'claude-cli/2.1.158 (external, cli)',
  };
  if (apiKey) {
    headers['x-api-key'] = apiKey;
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  return headers;
}

function extractSystemPrompt(messages: ChatMessage[]): string {
  const systemMsg = messages.find((m) => m.role === 'system');
  return systemMsg?.content || '';
}

export class AnthropicClient {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly temperature: number;
  readonly enableThinking: boolean;
  readonly thinkingTokens: number;
  readonly firstTokenTimeoutMs: number;
  readonly streamStallTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnthropicClientOptions) {
    this.baseUrl = (options.baseUrl || 'https://api.anthropic.com')
      .trim()
      .replace(/\/+$/, '')
      .replace(/\/v1$/, '');
    this.apiKey = options.apiKey;
    this.model = options.model || 'claude-sonnet-4-20250514';
    this.temperature = options.temperature ?? 0.2;
    this.enableThinking = options.enableThinking ?? true;
    this.thinkingTokens = options.thinkingTokens ?? 10000;
    this.firstTokenTimeoutMs = options.firstTokenTimeoutMs ?? 60_000;
    this.streamStallTimeoutMs = options.streamStallTimeoutMs ?? 90_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async chat(params: AnthropicChatParams): Promise<ChatMessage> {
    const system = extractSystemPrompt(params.messages);
    const messages = convertToAnthropicMessages(params.messages);
    const tools = convertToAnthropicTools(params.tools);

    const body: any = {
      model: params.model || this.model,
      messages,
      max_tokens: 8192,
      temperature: params.temperature ?? this.temperature,
    };

    if (system) body.system = system;
    if (tools) body.tools = tools;

    // Enable Extended Thinking
    if (this.enableThinking) {
      body.thinking = {
        type: 'enabled',
        budget_tokens: this.thinkingTokens,
      };
    }

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
      res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
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

    const data = await res.json();
    return convertFromAnthropicMessage(data);
  }

  async *chatStream(params: AnthropicChatParams): AsyncGenerator<any, AnthropicChatResult, void> {
    const system = extractSystemPrompt(params.messages);
    const messages = convertToAnthropicMessages(params.messages);
    const tools = convertToAnthropicTools(params.tools);

    const body: any = {
      model: params.model || this.model,
      messages,
      max_tokens: 8192,
      temperature: params.temperature ?? this.temperature,
      stream: true,
    };

    if (system) body.system = system;
    if (tools) body.tools = tools;

    if (this.enableThinking) {
      body.thinking = {
        type: 'enabled',
        budget_tokens: this.thinkingTokens,
      };
    }

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
      res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
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
      throw new Error('Anthropic stream has no body');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const thinking: ThinkingBlock[] = [];
    const textParts: string[] = [];
    const toolCalls: NonNullable<ChatMessage['tool_calls']> = [];
    const toolCallByIndex = new Map<number, NonNullable<ChatMessage['tool_calls']>[number]>();
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
        if (!line.startsWith('data:')) continue;

        const payload = line.slice(5).trim();
        if (!payload) continue;

        let event: any;
        try {
          event = JSON.parse(payload);
        } catch {
          continue;
        }

        yield event; // Forward raw event for UI

        if (event.type === 'content_block_delta') {
          const delta = event.delta;
          if (delta.type === 'text_delta') {
            textParts.push(delta.text);
          } else if (delta.type === 'thinking_delta') {
            const lastThinking = thinking[thinking.length - 1];
            if (lastThinking) {
              lastThinking.thinking += delta.thinking;
            }
          } else if (delta.type === 'input_json_delta') {
            const tc =
              typeof event.index === 'number'
                ? toolCallByIndex.get(event.index)
                : toolCalls[toolCalls.length - 1];
            if (tc && delta.partial_json) {
              tc.function.arguments += delta.partial_json;
            }
          }
        } else if (event.type === 'content_block_start') {
          const block = event.content_block;
          if (block.type === 'thinking') {
            thinking.push({ type: 'thinking', thinking: '' });
          } else if (block.type === 'tool_use') {
            const initialArgs =
              block.input && typeof block.input === 'object' && Object.keys(block.input).length > 0
                ? JSON.stringify(block.input)
                : '';
            const tc: NonNullable<ChatMessage['tool_calls']>[number] = {
              id: block.id,
              type: 'function',
              function: { name: block.name, arguments: initialArgs },
            };
            toolCalls.push(tc);
            if (typeof event.index === 'number') {
              toolCallByIndex.set(event.index, tc);
            }
          }
        } else if (event.type === 'message_start' && event.message?.usage) {
          usage = {
            promptTokens: event.message.usage.input_tokens,
            completionTokens: event.message.usage.output_tokens,
            totalTokens:
              (event.message.usage.input_tokens || 0) + (event.message.usage.output_tokens || 0),
          };
        } else if (event.type === 'message_delta' && event.usage) {
          const promptTokens = usage?.promptTokens ?? 0;
          const completionTokens = event.usage.output_tokens ?? usage?.completionTokens ?? 0;
          usage = {
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
          };
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

    // Default any empty tool arguments to "{}" to prevent downstream JSON parse issues
    for (const tc of toolCalls) {
      if (!tc.function.arguments || !tc.function.arguments.trim()) {
        tc.function.arguments = '{}';
      }
    }

    const message: ChatMessage = {
      role: 'assistant',
      content: textParts.join('') || null,
    };
    if (thinking.length) message.thinking = thinking;
    if (toolCalls.length) message.tool_calls = toolCalls;

    return { message, usage };
  }

  async chatStreamCollect(
    params: AnthropicChatParams,
    onToken?: (text: string) => void,
    onThinking?: (thinking: string) => void,
  ): Promise<AnthropicChatResult> {
    const gen = this.chatStream(params);
    let final: AnthropicChatResult | null = null;

    while (true) {
      const next = await gen.next();
      if (next.done) {
        final = next.value;
        break;
      }

      const event = next.value;
      if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta.type === 'text_delta') {
          onToken?.(delta.text);
        } else if (delta.type === 'thinking_delta') {
          onThinking?.(delta.thinking);
        }
      }
    }

    if (!final) {
      throw new Error('stream ended without message');
    }
    return final;
  }
}

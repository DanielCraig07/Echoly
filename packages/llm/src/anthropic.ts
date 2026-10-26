import type { ChatMessage, TokenUsage, ToolDefinition, ThinkingBlock } from '@deepseek-ide/shared';
import { LlmTimeoutError, type LlmTimeoutCode } from './index';
import {
  Semaphore,
  defaultRequestGate,
  discardResponse,
  isRetryableNetworkError,
  isRetryableStatus,
  retryAfterMs,
  withRetry,
} from './requestControl';
import {
  CONTENT_GUARD_OPTIONS,
  REASONING_GUARD_OPTIONS,
  RepetitionGuard,
  repetitionChannelLabel,
  trimTrailingRepeats,
  type RepetitionFuseInfo,
  type RepetitionHit,
} from './repetitionGuard';

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
  /** 单次生成的最大 token 数，作为复读退化的兜底上界。 */
  maxTokens?: number;
  /** 可重试失败的重试次数上限（不含首次请求）。默认 2，与 OpenAI 通道一致。 */
  maxRetries?: number;
  /** 并发闸门上限；未指定时共用全局闸门。 */
  maxConcurrency?: number;
}

export interface AnthropicChatParams {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  model?: string;
  signal?: AbortSignal;
  firstTokenTimeoutMs?: number;
  streamStallTimeoutMs?: number;
  maxTokens?: number;
}

export interface AnthropicChatResult {
  message: ChatMessage;
  usage?: TokenUsage;
  /** 服务端停止原因（Anthropic 的 `stop_reason`），供上层区分正常结束与被截断。 */
  finishReason?: string;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'thinking'; thinking: string; signature?: string }
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
        for (const block of m.thinking) {
          // 带签名的思考块原样回传，模型才能看到自己上一轮的推理。
          // 没有签名的（例如来自别的 provider、或服务端没下发）只能丢掉：
          // 接口要求带 thinking 的 assistant 消息必须附签名，不附会 400，
          // 而一次 400 会让整个回合失败 —— 丢一段推理总好过整轮报错。
          if (block.signature) {
            content.push({
              type: 'thinking',
              thinking: block.thinking,
              signature: block.signature,
            });
          }
        }
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
      thinking.push({
        type: 'thinking',
        thinking: block.thinking,
        // 签名必须在非流式路径上也带上，否则拿 chat() 生成的助手消息无法再回传。
        ...(typeof block.signature === 'string' && block.signature
          ? { signature: block.signature }
          : {}),
      });
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

/**
 * 把消息里所有 `system` 抽出来，拼接成顶层的 `system`。
 *
 * 不能用「取第一条」：上下文压缩产生的摘要、v0.0.50 的防复读提示词、以及
 * 压缩锚点之后插入的指令，**全部**是 `role: 'system'` 的数组中间元素。
 * 原先这里既 `filter` 掉它们、又只取第一条，结果是这些指令对模型完全不存在 ——
 * 表现出来就是「换到 Anthropic 通道之后，长会话的压缩摘要像没生效一样」，
 * 而日志里一切正常。
 *
 * 顺序必须保持：靠后的 system 通常是对更早内容的修正，拼接时放在后面才符合语义。
 */
function extractSystemPrompt(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role !== 'system') continue;
    const text = typeof m.content === 'string' ? m.content.trim() : '';
    if (text) parts.push(text);
  }
  return parts.join('\n\n');
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
  readonly maxTokens: number;
  readonly maxRetries: number;
  /** 与 OpenAI 通道共用同一个闸门实例，两个 provider 才不会被分别限流成两倍并发。 */
  readonly requestGate: Semaphore;
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
    this.maxTokens = options.maxTokens ?? 8192;
    this.maxRetries = options.maxRetries ?? 2;
    this.requestGate =
      options.maxConcurrency != null && options.maxConcurrency > 0
        ? new Semaphore(options.maxConcurrency)
        : defaultRequestGate;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * 发请求，并对「还没开始读 body」的失败重试。
   *
   * 与 OpenAI 通道同一套判断：只重试可重试状态码与网络层异常，400/401 这类
   * 参数或认证错误一次就抛。丢掉不读的响应必须 cancel body —— 否则连接被占住，
   * 重试反而让后续请求更容易超时。
   */
  private async postMessages(body: unknown, signal: AbortSignal): Promise<Response> {
    const outcome = await withRetry(
      () =>
        this.fetchImpl(`${this.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: buildHeaders(this.apiKey),
          body: JSON.stringify(body),
          signal,
        }),
      (res, err) => {
        if (err) return isRetryableNetworkError(err);
        if (!res) return false;
        return isRetryableStatus(res.status);
      },
      {
        maxAttempts: this.maxRetries,
        signal,
        delayHintMs: (res) => retryAfterMs(res),
        dispose: (res) => discardResponse(res),
      },
    );
    if (outcome.ok) return outcome.value;
    throw outcome.lastError;
  }

  /**
   * Anthropic 要求 max_tokens 必须大于 thinking.budget_tokens，
   * 否则整个请求会被拒。开启 thinking 时按「预算 + 输出余量」给足上限。
   */
  private resolveMaxTokens(params: AnthropicChatParams): number {
    const requested = params.maxTokens ?? this.maxTokens;
    if (!this.enableThinking) return requested;
    return Math.max(requested, this.thinkingTokens + 8192);
  }

  async chat(params: AnthropicChatParams): Promise<ChatMessage> {
    const system = extractSystemPrompt(params.messages);
    const messages = convertToAnthropicMessages(params.messages);
    const tools = convertToAnthropicTools(params.tools);

    const body: any = {
      model: params.model || this.model,
      messages,
      max_tokens: this.resolveMaxTokens(params),
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
      res = await this.postMessages(body, abortController.signal);
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

  /**
   * 流式请求。并发闸门包住整个生成过程 —— SSE 响应头立刻返回，真正占着推理节点的
   * 是后面读 body 的那几十秒；只圈住「拿到响应头」等于没有闸门。
   *
   * 用包装生成器而不是在内部 acquire：`for await` 提前 break 时 JS 会对生成器
   * 调用 `return()`，`finally` 因而会执行，名额不会泄漏。
   */
  async *chatStream(params: AnthropicChatParams): AsyncGenerator<any, AnthropicChatResult, void> {
    const release = await this.requestGate.acquire();
    try {
      return yield* this.chatStreamInner(params);
    } finally {
      release();
    }
  }

  private async *chatStreamInner(
    params: AnthropicChatParams,
  ): AsyncGenerator<any, AnthropicChatResult, void> {
    const system = extractSystemPrompt(params.messages);
    const messages = convertToAnthropicMessages(params.messages);
    const tools = convertToAnthropicTools(params.tools);

    const body: any = {
      model: params.model || this.model,
      messages,
      max_tokens: this.resolveMaxTokens(params),
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
      res = await this.postMessages(body, abortController.signal);
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
    // 思考块也要按 content_block 的 index 定位：`signature_delta` 只带 index，
    // 而同一轮里可能有多个思考块（交错思考），按「最后一个」取会串台。
    const thinkingIndexByEventIndex = new Map<number, number>();
    let usage: TokenUsage | undefined;
    let finishReason: string | undefined;
    let receivedFirstChunk = false;

    // ── 防复读保护 ──────────────────────────────────────────────────────────────
    // 与 OpenAI 分支同一套逻辑：在累积文本上做后缀周期检测，thinking / text 两条通道分别监控。
    // thinking 通道的硬上限 = budget_tokens × 4（每 token 约 4 字节），最少 40000 字符。
    const thinkingCharLimit = Math.max(this.thinkingTokens * 4, 40_000);
    const thinkingGuard = new RepetitionGuard(REASONING_GUARD_OPTIONS);
    const textGuard = new RepetitionGuard(CONTENT_GUARD_OPTIONS);
    const fusion: { info: RepetitionFuseInfo | null } = { info: null };
    const fuseInfo = (): RepetitionFuseInfo | null => fusion.info;
    const fuse = (channel: RepetitionFuseInfo['channel'], hit: RepetitionHit | null) => {
      if (fusion.info || !hit) return;
      fusion.info = { channel, period: hit.period, repeats: hit.repeats, source: 'client' };
      abortController.abort();
    };
    // ────────────────────────────────────────────────────────────────────────────

    try {
      while (true) {
        let readResult: { done: boolean; value?: Uint8Array };
        try {
          readResult = await reader.read();
        } catch (readErr) {
          // 熔断是主动决策，优先级高于可能同时触发的看门狗超时
          if (fuseInfo()) break;
          if (timedOutError) throw timedOutError;
          throw readErr;
        }

        const { done, value } = readResult;
        if (done) {
          // 与 OpenAI 通道同理：最后一行往往没有换行符收尾，不 flush 就会丢掉
          // 末尾的 `message_delta`（stop_reason 与 usage 都在它里面）。
          buffer += decoder.decode();
          const tailLines = buffer.split(/\r?\n/);
          buffer = '';
          for (const rawLine of tailLines) {
            const line = rawLine.trim();
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            try {
              const event = JSON.parse(payload);
              if (event.type === 'message_delta') {
                if (event.delta?.stop_reason) finishReason = event.delta.stop_reason;
                if (event.usage) {
                  const promptTokens = usage?.promptTokens ?? 0;
                  const completionTokens =
                    event.usage.output_tokens ?? usage?.completionTokens ?? 0;
                  usage = {
                    promptTokens,
                    completionTokens,
                    totalTokens: promptTokens + completionTokens,
                  };
                }
              } else if (event.type === 'error') {
                // Anthropic 用 `error` 事件报告流内错误，并且**不会**断开连接。
                // 不认它的话这次调用会被当成「模型没说话」正常返回。
                throw new Error(
                  `流式响应中返回了错误: ${event.error?.message ?? JSON.stringify(event).slice(0, 300)}`,
                );
              }
            } catch (err) {
              if (err instanceof Error && err.message.startsWith('流式响应中返回了错误')) throw err;
            }
          }
          break;
        }

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
          if (fuseInfo()) break;
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

          // 熔断时不再把退化 token 转发给 UI，避免渲染层继续堆积复读内容
          if (!fuseInfo()) yield event; // Forward raw event for UI

          if (event.type === 'content_block_delta') {
            const delta = event.delta;
            if (delta.type === 'text_delta') {
              const textDelta: string = delta.text ?? '';
              textParts.push(textDelta);
              if (textGuard.feed(textDelta)) {
                fuse('content', textGuard.hit);
              }
            } else if (delta.type === 'thinking_delta') {
              const deltaText: string = delta.thinking ?? '';
              if (!deltaText) continue;

              // ── 防护层1：thinking 总字符上限 ──────────────────────────────────
              if (thinkingGuard.chars > thinkingCharLimit) {
                timedOutError = new LlmTimeoutError(
                  `Thinking 内容超出最大限制（${thinkingCharLimit} 字符），已强制中止以防止无限循环`,
                  'STREAM_STALL_TIMEOUT',
                  streamStallTimeout,
                );
                abortController.abort();
                break;
              }

              // ── 防护层2：周期性重复检测 ──────────────────────────────────────
              if (thinkingGuard.feed(deltaText)) {
                fuse('reasoning', thinkingGuard.hit);
              }

              const targetIdx =
                typeof event.index === 'number'
                  ? (thinkingIndexByEventIndex.get(event.index) ?? thinking.length - 1)
                  : thinking.length - 1;
              const lastThinking = thinking[targetIdx];
              if (lastThinking) {
                lastThinking.thinking += deltaText;
              }
            } else if (delta.type === 'signature_delta') {
              // 签名单独一个 delta 下发，且**紧跟在**该思考块的所有 thinking_delta 之后。
              // 不接住它，这一轮生成的思考就无法回传（缺签名回传会 400），
              // 于是「开启思考」在带工具的多轮对话里等于每轮都从零开始推理。
              const sig: string = delta.signature ?? '';
              const targetIdx =
                typeof event.index === 'number'
                  ? (thinkingIndexByEventIndex.get(event.index) ?? thinking.length - 1)
                  : thinking.length - 1;
              const target = thinking[targetIdx];
              if (target && sig) target.signature = sig;
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
              if (typeof event.index === 'number') {
                thinkingIndexByEventIndex.set(event.index, thinking.length);
              }
              thinking.push({ type: 'thinking', thinking: '' });
            } else if (block.type === 'tool_use') {
              const initialArgs =
                block.input &&
                typeof block.input === 'object' &&
                Object.keys(block.input).length > 0
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
          } else if (event.type === 'message_delta') {
            // stop_reason 与 usage 一起到（Anthropic 的 message_delta 两者都可能带）。
            // 记下来是为了让上层能区分 end_turn / max_tokens / refusal，
            // 而不是只能看到「流结束了」。
            if (event.delta?.stop_reason) finishReason = event.delta.stop_reason;
            if (event.usage) {
              const promptTokens = usage?.promptTokens ?? 0;
              const completionTokens = event.usage.output_tokens ?? usage?.completionTokens ?? 0;
              usage = {
                promptTokens,
                completionTokens,
                totalTokens: promptTokens + completionTokens,
              };
            }
          } else if (event.type === 'error') {
            // 流内错误**不会**断开连接：不认它，这次调用会被当成「模型没说话」正常返回。
            throw new Error(
              `流式响应中返回了错误: ${event.error?.message ?? JSON.stringify(event).slice(0, 300)}`,
            );
          }
        }
        if (fuseInfo()) break;
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

    const fuseHit = fuseInfo();
    if (fuseHit) {
      // 复读退化：裁掉重复副本后把已有内容交给上层优雅收尾。
      // 抛 REPETITION_LOOP 而非超时码，让 agent 层直接结束而不重试（退化文本回灌会二次诱发复读）。
      const partial: ChatMessage = {
        role: 'assistant',
        content: textGuard.hit
          ? trimTrailingRepeats(textParts.join(''), textGuard.hit)
          : textParts.join('') || null,
      };
      if (thinking.length) {
        const lastIdx = thinking.length - 1;
        partial.thinking = thinking.map((b, i) =>
          i === lastIdx && thinkingGuard.hit
            ? { ...b, thinking: trimTrailingRepeats(b.thinking, thinkingGuard.hit) }
            : b,
        );
      }
      // 故意不带上 toolCalls：生成是被中途掐断的，参数 JSON 极可能只序列化了一半。
      const channelLabel = repetitionChannelLabel(fuseHit.channel);
      throw new LlmTimeoutError(
        `检测到${channelLabel}周期性重复（${fuseHit.period} 字符的片段连续重复 ${fuseHit.repeats} 次），已熔断以终止无限复读`,
        'REPETITION_LOOP',
        0,
        { message: partial, usage },
      );
    }

    const message: ChatMessage = {
      role: 'assistant',
      content: textParts.join('') || null,
    };
    if (thinking.length) message.thinking = thinking;
    if (toolCalls.length) message.tool_calls = toolCalls;

    return { message, usage, finishReason };
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

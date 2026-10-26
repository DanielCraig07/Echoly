import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  StreamChunk,
  TokenUsage,
  ToolDefinition,
  AiProvider,
  ProviderConfig,
  ReasoningEffort,
} from '@deepseek-ide/shared';
import { DEFAULT_LLM_BASE_URL, DEFAULT_LLM_MODEL } from '@deepseek-ide/shared';
import { AnthropicClient, formatLlmErrorMessage } from './anthropic';
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
  SERVER_TRIM_OPTIONS,
  RepetitionGuard,
  detectTrailingRepeat,
  repetitionChannelLabel,
  trimTrailingRepeats,
  type RepetitionFuseInfo,
  type RepetitionHit,
} from './repetitionGuard';

export type LlmTimeoutCode =
  | 'FIRST_TOKEN_TIMEOUT'
  | 'STREAM_STALL_TIMEOUT'
  | 'REQUEST_TIMEOUT'
  /** 检测到周期性重复输出（复读机退化），已主动熔断 */
  | 'REPETITION_LOOP';

export class LlmTimeoutError extends Error {
  readonly code: LlmTimeoutCode;
  readonly timeoutMs: number;
  /** 熔断（REPETITION_LOOP）时已生成的部分内容，供上层优雅收尾而非重试。 */
  readonly partialMessage?: ChatMessage;
  readonly partialUsage?: TokenUsage;

  constructor(
    message: string,
    code: LlmTimeoutCode,
    timeoutMs: number,
    partial?: { message: ChatMessage; usage?: TokenUsage },
  ) {
    super(message);
    this.name = 'LlmTimeoutError';
    this.code = code;
    this.timeoutMs = timeoutMs;
    this.partialMessage = partial?.message;
    this.partialUsage = partial?.usage;
  }
}

export function isLlmTimeoutError(err: unknown): err is LlmTimeoutError {
  return (
    err instanceof LlmTimeoutError ||
    (err instanceof Error &&
      (err.name === 'LlmTimeoutError' ||
        /FIRST_TOKEN_TIMEOUT|STREAM_STALL_TIMEOUT|REQUEST_TIMEOUT|REPETITION_LOOP/i.test(
          err.message,
        )))
  );
}

/**
 * 是否为「重复输出熔断」。
 * 与超时不同，此时模型已产出可用内容，上层应直接收尾，**不能**重试 ——
 * 退化文本留在上下文里会立刻二次诱发复读。
 */
export function isRepetitionLoopError(err: unknown): boolean {
  return (
    (err instanceof LlmTimeoutError && err.code === 'REPETITION_LOOP') ||
    (err instanceof Error && /REPETITION_LOOP|重复输出|复读/i.test(err.message))
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
  /** 单次生成的最大 token 数，作为复读退化的兜底上界。0 表示不发送该字段。 */
  maxTokens?: number;
  /** 频率惩罚，抑制逐字复读。 */
  frequencyPenalty?: number;
  /** 存在惩罚，抑制复述已有内容。 */
  presencePenalty?: number;
  /** 是否启用周期性重复检测熔断。默认 true。 */
  repetitionGuard?: boolean;
  /** 思考深度档位（`reasoning_effort`）。未设置表示沿用服务端默认档。 */
  reasoningEffort?: ReasoningEffort;
  /** 细粒度思考深度（1–100），走 `chat_template_kwargs.reasoning_effort`。 */
  reasoningEffortFine?: number;
  /** 思考 token 硬上限（`thinking_token_budget`）。0 表示不发送。 */
  thinkingTokenBudget?: number;
  /** 是否请求服务端原生重复检测（vLLM `repetition_detection`）。默认 false。 */
  serverRepetitionDetection?: boolean;
  /** 可重试失败的重试次数上限（不含首次请求）。默认 2。 */
  maxRetries?: number;
  /** 并发闸门：同时允许在途的请求数上限。默认继承全局闸门。 */
  maxConcurrency?: number;
}

export interface ChatParams {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  model?: string;
  signal?: AbortSignal;
  firstTokenTimeoutMs?: number;
  streamStallTimeoutMs?: number;
  maxTokens?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  reasoningEffort?: ReasoningEffort;
  reasoningEffortFine?: number;
  thinkingTokenBudget?: number;
}

/**
 * 服务端原生重复检测参数。
 *
 * 比客户端的周期熔断更早生效 —— 生成在推理引擎内部就被终止，退化 token 根本
 * 不会发出来，因此省掉的是真实的算力而不只是网络传输。阈值取的是实测下来
 * 既不误杀合法长输出（列表 / 代码 / 表格 / 文档四种都验过）、又能掐住复读的档位。
 */
export const SERVER_REPETITION_DETECTION = {
  min_count: 8,
  min_pattern_size: 16,
  max_pattern_size: 256,
} as const;

/**
 * 复读退化的兜底参数。
 *
 * max_tokens 只是「最后一道闸」：真正止住复读的是下面的周期检测（秒级命中），
 * 这里给一个足够宽松的上界，既能终结失控生成，又不会截断正常的超长文件写入。
 * reasoning 模型的思考 token 也计入该上限，所以不能按「正文长度」来估。
 * 与 shared 的 DEFAULT_SETTINGS.maxOutputTokens 保持一致。
 */
export const DEFAULT_MAX_TOKENS = 32768;
export const DEFAULT_FREQUENCY_PENALTY = 0.3;
export const DEFAULT_PRESENCE_PENALTY = 0.3;

export interface ChatStreamResult {
  message: ChatMessage;
  usage?: TokenUsage;
  /**
   * 服务端给出的停止原因（`finish_reason`）。
   *
   * 之所以要留出来：`stop`（正常说完了）、`length`（撞到 max_tokens 被截断）、
   * `repetition`（推理引擎自己判定复读并掐断，见 `repetition_detection`）三者对上层
   * 意味着完全不同的收尾策略 —— 前两者可以照常使用内容，后者要和客户端熔断走同一条路。
   * 旧实现直接把它丢掉了，导致服务端那层防护即使生效也无从感知。
   */
  finishReason?: string;
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

/** 把一行 SSE `data:` 解析成 chunk；不是数据行、是 `[DONE]`、或 JSON 坏了都返回 null。 */
function parseSseDataLine(rawLine: string): StreamChunk | null {
  const line = rawLine.trim();
  if (!line || !line.startsWith('data:')) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;
  try {
    return JSON.parse(payload) as StreamChunk;
  } catch {
    return null;
  }
}

/**
 * 从 chunk 里取出流内错误。
 *
 * 有些网关**不断开连接**，而是在生成中途发一条 `{"error":{...}}`（或
 * `{"type":"error","message":...}`）然后正常 EOF。不认它的话，这次调用会被当成
 * 「模型输出为空」正常返回 —— 用户看到一个什么都没做的回合，日志里没有任何异常。
 * 这里只负责把错误**取出来**，由调用方决定是抛还是重试。
 */
function extractStreamError(chunk: unknown): string | null {
  if (!chunk || typeof chunk !== 'object') return null;
  const obj = chunk as Record<string, unknown>;

  const err = obj.error;
  if (err) {
    if (typeof err === 'string' && err.trim()) return `流式响应中返回了错误: ${err.trim()}`;
    if (typeof err === 'object') {
      const e = err as Record<string, unknown>;
      const msg = e.message ?? e.detail ?? e.code;
      if (typeof msg === 'string' && msg.trim()) {
        // 带上 code：网关的错误码（如 context_length_exceeded）比一句人话更能定位问题
        const code = typeof e.code === 'string' && e.code !== msg ? ` (${e.code})` : '';
        return `流式响应中返回了错误: ${msg.trim()}${code}`;
      }
      return `流式响应中返回了错误: ${JSON.stringify(err).slice(0, 300)}`;
    }
  }

  // Anthropic / 部分兼容层用 type: 'error'
  if (obj.type === 'error') {
    const e = (obj.error ?? obj) as Record<string, unknown>;
    const msg = e.message ?? obj.message;
    if (typeof msg === 'string' && msg.trim()) {
      return `流式响应中返回了错误: ${msg.trim()}`;
    }
  }

  return null;
}

/**
 * 无 usage 时的 token 粗估。
 *
 * 估算值唯一的用途是**决定要不要压缩上下文**，所以它的错误方向必须是「估多」：
 * 估少了 → 压缩不触发 → 请求超过窗口 → 后端 400，用户看到的是「莫名其妙的报错」；
 * 估多了 → 提前压缩一次，浪费一点 token 但功能正常。
 *
 * 因此这里刻意不精确，但必须**不遗漏大块内容**。早先只数 `content` 与 tool_calls 的
 * 字符数，于是：
 * - 图片 / PDF 附件一个字节都不算 —— 而它们恰恰是单条消息里最大的那部分
 *   （一张 1MB 的图 base64 后约 133 万字符），带图会话永远等不到压缩；
 * - 思考链（`reasoning_content` / `thinking`）不算 —— 服务端按它计费并占用窗口；
 * - 中文按 1/4 字符估 —— 中文实际接近一字一 token，混排文档会低估约 4 倍。
 */
export function estimateTokensFromMessages(messages: ChatMessage[]): number {
  let tokens = 0;

  const addText = (text: string | null | undefined): void => {
    if (!text) return;
    tokens += textToTokens(text);
  };

  for (const m of messages) {
    // 每条消息有固定的角色/分隔开销，量小但条数多时不能忽略。
    tokens += 4;

    if (typeof m.content === 'string') addText(m.content);
    addText(m.name);
    addText(m.tool_call_id);
    addText(m.reasoning_content);
    if (m.tool_calls) addText(JSON.stringify(m.tool_calls));

    for (const block of m.thinking ?? []) addText(block.thinking);

    // 附件按 base64 长度折算：多模态模型对图像的计费与像素面积相关，
    // 但不解码就拿不到尺寸，而 base64 长度与原始字节成正比（×4/3），
    // 是**不需要解码**的前提下能拿到的最好代理量。
    for (const img of m.images ?? []) tokens += dataUrlTokens(img.dataUrl);
    for (const doc of m.documents ?? []) tokens += dataUrlTokens(doc.dataUrl);
  }

  return Math.max(1, tokens);
}

/** 文本 → token 数。CJK / 全角标点按一字一 token，其余按 4 字符一 token。 */
function textToTokens(text: string): number {
  // 粗略圈定 CJK 与常见全角标点：这些字符在 BPE 词表里基本都是独立或近独立的 token，
  // 用「4 字符一 token」会把中文段落低估到实际值的四分之一。
  const cjk = countCjk(text);
  const rest = text.length - cjk;
  return cjk + Math.ceil(rest / 4);
}

function countCjk(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (
      (c >= 0x3040 && c <= 0x30ff) || // 日文假名
      (c >= 0x3400 && c <= 0x4dbf) || // 扩展 A
      (c >= 0x4e00 && c <= 0x9fff) || // 基本区
      (c >= 0xf900 && c <= 0xfaff) || // 兼容表意
      (c >= 0xff00 && c <= 0xff60) || // 全角
      (c >= 0x3000 && c <= 0x303f) // CJK 标点
    ) {
      n++;
    }
  }
  return n;
}

/**
 * `data:image/png;base64,xxxx` → 近似 token 数。
 *
 * base64 每 4 字符编码 3 字节，所以字节数 = 字符数 × 3/4。图像 token 与字节数
 * 大致同阶（不同厂商系数不同），这里取 1 token / 750 字节，是一个**偏保守**
 * （即偏大）的折中值 —— 方向与整个函数一致。
 *
 * 非 data URL（裸 base64 或外部链接）按同一规则处理，取不到前缀就整串当 base64。
 */
function dataUrlTokens(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  const payload = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const bytes = Math.ceil((payload.length * 3) / 4);
  return Math.ceil(bytes / 750) + 85; // +85：单张图固定的分块开销量级
}

/**
 * 统一思考字段名。
 *
 * vLLM 的 DeepSeek-V4.1 分支在响应里用的是 `reasoning`，而 DeepSeek 官方 API 与
 * 多数网关沿用 `reasoning_content`。流式路径两处都做了兜底，非流式这边原先只读
 * 后者，导致 probe / 代码补全 / 一次性问答完全拿不到思考内容（复读检测在思考链
 * 上等于失效）。这里把两者归一，后续逻辑只认 `reasoning_content`。
 */
export function normalizeReasoningField(message: ChatMessage): ChatMessage {
  if (message.reasoning_content) return message;
  const alt = (message as ChatMessage & { reasoning?: string | null }).reasoning;
  if (typeof alt !== 'string' || !alt) return message;
  return { ...message, reasoning_content: alt };
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
  readonly maxTokens: number;
  readonly frequencyPenalty: number;
  readonly presencePenalty: number;
  readonly repetitionGuard: boolean;
  readonly reasoningEffort?: ReasoningEffort;
  readonly reasoningEffortFine?: number;
  readonly thinkingTokenBudget: number;
  readonly serverRepetitionDetection: boolean;
  /** 可重试失败的重试次数上限（不含首次请求）。 */
  readonly maxRetries: number;
  /** 在途请求并发闸门；同进程内多个 client 可共享同一个实例。 */
  readonly requestGate: Semaphore;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LlmClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_LLM_BASE_URL);
    this.apiKey = options.apiKey ?? '';
    this.model = options.model ?? DEFAULT_LLM_MODEL;
    this.temperature = options.temperature ?? 0.2;
    this.firstTokenTimeoutMs = options.firstTokenTimeoutMs ?? 60_000;
    this.streamStallTimeoutMs = options.streamStallTimeoutMs ?? 90_000;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.frequencyPenalty = options.frequencyPenalty ?? DEFAULT_FREQUENCY_PENALTY;
    this.presencePenalty = options.presencePenalty ?? DEFAULT_PRESENCE_PENALTY;
    this.repetitionGuard = options.repetitionGuard ?? true;
    this.reasoningEffort = options.reasoningEffort;
    this.reasoningEffortFine = options.reasoningEffortFine;
    this.thinkingTokenBudget = options.thinkingTokenBudget ?? 0;
    this.serverRepetitionDetection = options.serverRepetitionDetection ?? false;
    this.maxRetries = options.maxRetries ?? 1;
    this.requestGate = options.maxConcurrency
      ? new Semaphore(options.maxConcurrency)
      : defaultRequestGate;
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
      maxTokens: partial.maxTokens ?? this.maxTokens,
      frequencyPenalty: partial.frequencyPenalty ?? this.frequencyPenalty,
      presencePenalty: partial.presencePenalty ?? this.presencePenalty,
      repetitionGuard: partial.repetitionGuard ?? this.repetitionGuard,
      reasoningEffort: partial.reasoningEffort ?? this.reasoningEffort,
      reasoningEffortFine: partial.reasoningEffortFine ?? this.reasoningEffortFine,
      thinkingTokenBudget: partial.thinkingTokenBudget ?? this.thinkingTokenBudget,
      serverRepetitionDetection:
        partial.serverRepetitionDetection ?? this.serverRepetitionDetection,
      maxRetries: partial.maxRetries ?? this.maxRetries,
      maxConcurrency: partial.maxConcurrency,
      fetchImpl: partial.fetchImpl ?? this.fetchImpl,
    });
  }

  /**
   * 组装请求体。
   * max_tokens / 惩罚项是复读退化的第一道防线：即使检测层漏网，生成也总有确定终点。
   * 自定义网关可能只认其中一部分字段，因此各项可单独关闭（设为 0 / undefined）。
   */
  private buildBody(
    params: ChatParams,
    stream: boolean,
    includeSamplingGuards = true,
    includeReasoning = true,
  ): ChatCompletionRequest {
    const body: ChatCompletionRequest & Record<string, unknown> = {
      model: params.model ?? this.model,
      messages: formatOpenAIMessages(params.messages),
      temperature: params.temperature ?? this.temperature,
      stream,
      tools: params.tools,
      tool_choice: params.tools?.length ? 'auto' : undefined,
    };

    // 流式请求默认不带 usage（OpenAI 协议的默认行为），于是上下文用量只能靠估算。
    // 打开这个开关后，最后一个 chunk 里会带真实 token 数 —— 上下文压缩的触发阈值
    // 就能建立在真实值上，而不是一个偏保守的估算。
    // 挂在 `includeSamplingGuards` 这一层，是因为它同样是「网关不一定认识的增强字段」：
    // 400 降级时与 max_tokens 一起摘掉，避免某个老网关卡在这一个字段上整个用不了。
    if (stream && includeSamplingGuards) body.stream_options = { include_usage: true };

    if (includeReasoning) this.applyReasoningControls(body, params);
    if (includeSamplingGuards) this.applySamplingGuards(body, params);
    return body as ChatCompletionRequest;
  }

  /**
   * 思考深度控制。
   *
   * 三个字段的分工（内网 DeepSeek-V4.1 = vLLM 定制版，实测结论）：
   * - `reasoning_effort`（顶层）只认 none/low/high/xhigh/max；传 minimal 或 medium 会被 400。
   * - `chat_template_kwargs.reasoning_effort`（整数 1–100）是同一个旋钮的细粒度版本，
   *   因此它存在时不再发顶层字段，避免两个值互相打架。
   * - `thinking_token_budget` 是硬截断而非缩放，且是唯一能与上面两者共存的（实测预算优先生效）。
   *
   * 返回是否真的写入了字段，供 400 降级时决定要不要摘掉这一层。
   */
  private applyReasoningControls(body: ChatCompletionRequest, params: ChatParams): boolean {
    const fine = params.reasoningEffortFine ?? this.reasoningEffortFine;
    const effort = params.reasoningEffort ?? this.reasoningEffort;
    const budget = params.thinkingTokenBudget ?? this.thinkingTokenBudget;

    let touched = false;
    const kwargs: NonNullable<ChatCompletionRequest['chat_template_kwargs']> = {};

    if (fine != null && fine > 0) {
      kwargs.reasoning_effort = Math.min(100, Math.round(fine));
      touched = true;
      // 细粒度档位优先：关闭思考由顶层 none 表达更明确，此处不再下发整数
    } else if (effort) {
      body.reasoning_effort = effort;
      touched = true;
    }

    if (Object.keys(kwargs).length > 0) {
      body.chat_template_kwargs = kwargs;
    }
    if (budget > 0) {
      body.thinking_token_budget = budget;
      touched = true;
    }
    return touched;
  }

  /** 采样侧的复读防护：上界与两个惩罚项。返回是否写入了字段。 */
  private applySamplingGuards(body: ChatCompletionRequest, params: ChatParams): boolean {
    const maxTokens = params.maxTokens ?? this.maxTokens;
    const frequencyPenalty = params.frequencyPenalty ?? this.frequencyPenalty;
    const presencePenalty = params.presencePenalty ?? this.presencePenalty;

    let touched = false;
    if (maxTokens > 0) {
      body.max_tokens = maxTokens;
      touched = true;
    }
    if (frequencyPenalty > 0) {
      body.frequency_penalty = frequencyPenalty;
      touched = true;
    }
    if (presencePenalty > 0) {
      body.presence_penalty = presencePenalty;
      touched = true;
    }
    if (this.serverRepetitionDetection) {
      body.repetition_detection = { ...SERVER_REPETITION_DETECTION };
      touched = true;
    }
    return touched;
  }

  /**
   * 发送请求；若网关因不认识某个字段而报 400，则按「哪一层被点名就摘掉哪一层」重发。
   *
   * 分两轮降级是有意的：思考深度字段（reasoning_effort / chat_template_kwargs）比采样加固
   * 更容易被其他推理后端拒绝，一次全摘掉会连带放弃复读防护。只在报错确实指向这些字段时
   * 才降级，无关的 400 照常抛出，免得把真正的参数错误掩盖成「字段不兼容」。
   *
   * 重试只包住「拿到响应头」这一步。两条边界：
   * - 400 不重试：那是参数问题，重发同样的 body 只会再得到同样的 400。
   * - 已经在流式读 body 的状态（`res.ok` 且 stream=true）也不重试：此时响应体归调用方所有，
   *   在这里重发会让调用方拿到第二个响应而第一个的 body 悬空。
   * 所以这里只对「非 ok 且状态码可重试」和「网络层异常」两类失败重发。
   *
   * 并发闸门不在这里，而在 `chat` / `chatStream` 的最外层：流式响应的真正耗时在读取 body，
   * 若只圈住「拿到响应头」这一段，闸门几乎等于没有（SSE 响应头是立刻返回的）。
   */
  private async postChat(
    params: ChatParams,
    stream: boolean,
    signal: AbortSignal,
  ): Promise<Response> {
    const send = (guards: boolean, reasoning: boolean) =>
      this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: buildHeaders(this.apiKey),
        body: JSON.stringify(this.buildBody(params, stream, guards, reasoning)),
        signal,
      });

    const outcome = await withRetry(
      () => send(true, true),
      (res, err) => {
        if (err) return isRetryableNetworkError(err);
        if (!res) return false;
        return isRetryableStatus(res.status);
      },
      {
        maxAttempts: this.maxRetries,
        signal,
        // 网关在 429/503 上给 Retry-After 时必须听它的：我们自己的指数退避是猜的，
        // 猜短了会在限流窗口内反复撞墙，把一次限流拖成一段时间的持续 429。
        delayHintMs: (res) => retryAfterMs(res),
        // 丢掉一个不打算读的响应必须 cancel 它的 body，否则连接一直被 undici 占着。
        dispose: (res) => discardResponse(res),
      },
    );

    const res = outcome.ok
      ? outcome.value
      : (() => {
          throw outcome.lastError;
        })();

    if (res.ok || res.status !== 400) return res;

    const text = await res.text();
    const genericUnknownField =
      /unknown|unrecognized|unexpected|not permitted|extra fields?|unsupported/i.test(text) &&
      /parameter|field|argument|keyword/i.test(text);
    const blamesReasoning =
      /reasoning_effort|chat_template_kwargs|thinking_token_budget|reasoning|thinking/i.test(text);
    const blamesSampling =
      /max_tokens|frequency_penalty|presence_penalty|repetition_detection/i.test(text);

    let retry: () => Promise<Response>;
    if (blamesReasoning && !blamesSampling) retry = () => send(true, false);
    else if (blamesSampling && !blamesReasoning) retry = () => send(false, true);
    else if (blamesReasoning || blamesSampling || genericUnknownField)
      retry = () => send(false, false);
    else {
      // body 已被消费，重新包一个等价响应交回调用方去报错
      return new Response(text, { status: res.status, statusText: res.statusText });
    }

    // 降级重发同样值得重试一次网络层抖动
    const degraded = await withRetry(
      retry,
      (r, err) => (err ? isRetryableNetworkError(err) : !!r && isRetryableStatus(r.status)),
      {
        maxAttempts: this.maxRetries,
        signal,
        delayHintMs: (r) => retryAfterMs(r),
        dispose: (r) => discardResponse(r),
      },
    );
    if (degraded.ok) return degraded.value;
    throw degraded.lastError;
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

  /**
   * 非流式请求。并发闸门圈住整个生命周期（包含读 body），
   * 流式版本见 `chatStream`——那里的闸门必须跨过整个生成过程才有意义。
   */
  async chat(params: ChatParams): Promise<ChatMessage> {
    const release = await this.requestGate.acquire();
    try {
      return await this.chatInner(params);
    } finally {
      release();
    }
  }

  private async chatInner(params: ChatParams): Promise<ChatMessage> {
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
      res = await this.postChat(params, false, abortController.signal);
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
    return this.trimRepeatsFromMessage(normalizeReasoningField(message));
  }

  /**
   * 非流式响应的复读清理。
   *
   * 一次性拿到的完整消息不存在「卡住不结束」的问题（请求已经返回了），所以这里只裁掉
   * 尾部重复的副本，不抛错 —— 抛错会连累 probe / 代码补全这类调用方，而它们要的只是
   * 一份干净的结果。真正需要中断流的地方在 `chatStream`。
   */
  private trimRepeatsFromMessage(message: ChatMessage): ChatMessage {
    if (!this.repetitionGuard) return message;

    const content = message.content;
    const contentHit =
      typeof content === 'string' && content
        ? detectTrailingRepeat(content, CONTENT_GUARD_OPTIONS)
        : null;

    const reasoning = message.reasoning_content;
    const reasoningHit = reasoning
      ? detectTrailingRepeat(reasoning, REASONING_GUARD_OPTIONS)
      : null;

    if (!contentHit && !reasoningHit) return message;
    return {
      ...message,
      content:
        contentHit && typeof content === 'string'
          ? trimTrailingRepeats(content, contentHit)
          : content,
      reasoning_content:
        reasoningHit && reasoning
          ? trimTrailingRepeats(reasoning, reasoningHit)
          : message.reasoning_content,
    };
  }

  /**
   * 流式请求。并发闸门包住整个生成过程——SSE 的响应头是立刻返回的，只圈住
   * 「拿到响应头」等于没有闸门，真正占着推理节点的是后面读取 body 的几十秒。
   *
   * 用包装生成器而不是在 chatStream 内部 acquire：`for await` 提前 break 时 JS 会对
   * 生成器调用 `return()`，`finally` 因而会执行，名额不会泄漏。
   */
  async *chatStream(params: ChatParams): AsyncGenerator<StreamChunk, ChatStreamResult, void> {
    const release = await this.requestGate.acquire();
    try {
      return yield* this.chatStreamInner(params);
    } finally {
      release();
    }
  }

  private async *chatStreamInner(
    params: ChatParams,
  ): AsyncGenerator<StreamChunk, ChatStreamResult, void> {
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
      res = await this.postChat(params, true, abortController.signal);
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
    let finishReason: string | undefined;
    let receivedFirstChunk = false;

    // ── 防复读保护 ──────────────────────────────────────────────────────────────
    // 流式 delta 只有几个字符，逐个比对 delta 相等（旧实现）无法命中「重复一整句话」的退化。
    // 这里改为在累积文本上做后缀周期检测，reasoning 与 content 两条通道分别监控。
    //
    // tool_calls 的 arguments 不做这项检测，虽然它同样会退化。理由：写文件类工具的
    // 参数**合法地**就经常是高度重复的内容（重复的 fixture、日志样本、表格行、mock 数据），
    // 实测中这类载荷与真退化的 (周期, 重复次数) 分布完全重叠，无法用阈值分开。
    // 误熔断会让一次合法的文件写入被静默截断，比「让退化参数跑到 max_tokens、
    // JSON 解析失败后重试一次」严重得多。参数膨胀本身有 max_tokens 兜底。
    const guardEnabled = this.repetitionGuard;
    const reasoningGuard = new RepetitionGuard(REASONING_GUARD_OPTIONS);
    const contentGuard = new RepetitionGuard(CONTENT_GUARD_OPTIONS);
    // reasoning 通道的兜底硬上限（约 4 万 token），周期检测漏网时的最后一道闸
    const reasoningCharLimit = 160_000;
    // 命中后熔断：记录原因并中止请求，while 循环随后退出。
    // 存成对象并经函数读取，避免 TS 把闭包内被赋值的变量收窄成 never。
    const fusion: { info: RepetitionFuseInfo | null } = { info: null };
    const fuseInfo = (): RepetitionFuseInfo | null => fusion.info;
    const fuse = (
      channel: RepetitionFuseInfo['channel'],
      hit: RepetitionHit | null,
      source: RepetitionFuseInfo['source'] = 'client',
    ) => {
      if (fusion.info) return;
      // 服务端来源时没有周期信息，用 0 占位
      fusion.info = hit
        ? { channel, period: hit.period, repeats: hit.repeats, source }
        : { channel, period: 0, repeats: 0, source };
      abortController.abort();
    };
    // ─────────────────────────────────────────────────────────────────────────

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
          // 流结束时 buffer 里可能还留着最后一行（没有以换行符收尾的数据）。
          // 不处理它就会**静默丢掉**最后一个 chunk —— 而 `stream_options.include_usage`
          // 恰好让服务端把 usage 单独放在末尾一个只有几行的 chunk 里，
          // 于是「最后那条」正好是最不该丢的一条。MCP 的 LineJsonRpcDecoder 早在
          // flush() 里做了这件事，这里对齐。
          buffer += decoder.decode();
          for (const rawLine of buffer.split(/\r?\n/)) {
            const chunk = parseSseDataLine(rawLine);
            if (!chunk) continue;
            const streamErr = extractStreamError(chunk);
            if (streamErr) throw new Error(streamErr);
            const parsedUsage = usageFromApi(chunk.usage);
            if (parsedUsage) usage = parsedUsage;
            const chunkFinish = chunk.choices?.[0]?.finish_reason;
            if (chunkFinish) finishReason = chunkFinish;
          }
          buffer = '';
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
          // 流内错误事件：网关可能不断开连接，只发一条 error chunk 然后正常 EOF。
          // 认它，才不会把一次失败当成「模型什么都没说」。
          const streamErr = extractStreamError(chunk);
          if (streamErr) throw new Error(streamErr);

          const parsedUsage = usageFromApi(chunk.usage);
          if (parsedUsage) usage = parsedUsage;

          // 服务端给出的停止原因。`repetition` 表示推理引擎自己判定复读并掐断了生成
          // （`repetition_detection`），此时周期未知，交给下面的收尾分支回裁尾部。
          const chunkFinish = chunk.choices?.[0]?.finish_reason;
          if (chunkFinish) finishReason = chunkFinish;

          const delta = chunk.choices?.[0]?.delta;
          // 熔断时不再把退化 token 转发给 UI，避免渲染层继续堆积复读内容
          if (!fuseInfo()) yield chunk;

          // 服务端的复读判定优先级最高：它比本地检测更早知道，也不需要再看后续 delta。
          if (finishReason === 'repetition' && !fuseInfo()) {
            fuse('content', null, 'server');
            break;
          }

          if (!delta) continue;
          if (delta.role) role = delta.role;

          if (typeof delta.content === 'string' && delta.content) {
            content += delta.content;
            if (guardEnabled && contentGuard.feed(delta.content)) {
              fuse('content', contentGuard.hit);
            }
          }

          const reasoningDelta = delta.reasoning_content ?? (delta as any).reasoning;
          if (typeof reasoningDelta === 'string' && reasoningDelta) {
            reasoningContent += reasoningDelta;
            if (reasoningContent.length > reasoningCharLimit) {
              timedOutError = new LlmTimeoutError(
                `Reasoning 内容超出最大限制（${reasoningCharLimit} 字符），已强制中止以防止无限循环`,
                'STREAM_STALL_TIMEOUT',
                streamStallTimeout,
              );
              abortController.abort();
              break;
            }
            if (guardEnabled && reasoningGuard.feed(reasoningDelta)) {
              fuse('reasoning', reasoningGuard.hit);
            }
          }
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

    const fuseHit = fuseInfo();
    if (fuseHit) {
      // 复读退化：只保留第一份重复片段，把已产出的内容作为 partialMessage 交给上层优雅收尾。
      // 抛 REPETITION_LOOP（而非超时码）是为了让上层区分「可以重试」与「必须直接收尾」——
      // 退化文本若被回灌上下文会立刻二次诱发复读。
      // 故意不带 tool_calls：生成是被中途掐断的，参数 JSON 极可能只序列化了一半，
      // 交出去只会换来一次必然失败的调用。
      const serverSide = fuseHit.source === 'server';
      // 服务端判定时没有流式命中信息，得在整段已收文本上补一次检测才能回裁；
      // 它触发时尾部往往已经堆了几万字符，所以用放宽到极致的 SERVER_TRIM_OPTIONS。
      // 客户端命中时只认各自的流式命中结果，不要拿放宽参数重扫 ——
      // 那会把「复读之外的巧合重复」也一并裁掉。
      const contentHit = serverSide
        ? (contentGuard.hit ?? detectTrailingRepeat(content, SERVER_TRIM_OPTIONS))
        : contentGuard.hit;
      const reasoningHit = serverSide
        ? (reasoningGuard.hit ?? detectTrailingRepeat(reasoningContent, SERVER_TRIM_OPTIONS))
        : reasoningGuard.hit;
      const trimmedContent = contentHit ? trimTrailingRepeats(content, contentHit) : content;
      const trimmedReasoning = reasoningHit
        ? trimTrailingRepeats(reasoningContent, reasoningHit)
        : reasoningContent;
      const partialMessage: ChatMessage = {
        role,
        content: trimmedContent || null,
        reasoning_content: trimmedReasoning || undefined,
      };
      const message = serverSide
        ? `服务端判定模型输出复读（finish_reason: repetition），已熔断以终止无限复读`
        : `检测到${repetitionChannelLabel(fuseHit.channel)}周期性重复（${fuseHit.period} 字符的片段连续重复 ${fuseHit.repeats} 次），已熔断以终止无限复读`;
      throw new LlmTimeoutError(message, 'REPETITION_LOOP', 0, {
        message: partialMessage,
        usage,
      });
    }

    const message: ChatMessage = {
      role,
      content: content || null,
      reasoning_content: reasoningContent || undefined,
      tool_calls: toolCalls.length ? toolCalls : undefined,
    };
    return { message, usage, finishReason };
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

/** 复读防护的客户端级配置，来自用户设置。 */
export interface LlmGuardSettings {
  maxTokens?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  repetitionGuard?: boolean;
  /** 是否请求服务端原生重复检测（vLLM `repetition_detection`）。 */
  serverRepetitionDetection?: boolean;
}

/**
 * 从应用设置里取出复读防护配置。
 * 三处构造 client 的地方（agent 主循环、ipc 快捷调用、探测）都走这里，
 * 避免默认值在多个调用点各写一份而彼此漂移。
 */
export function guardSettingsFromAppSettings(settings: {
  maxOutputTokens?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  repetitionGuard?: boolean;
  serverRepetitionDetection?: boolean;
}): LlmGuardSettings {
  return {
    maxTokens: settings.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    frequencyPenalty: settings.frequencyPenalty ?? DEFAULT_FREQUENCY_PENALTY,
    presencePenalty: settings.presencePenalty ?? DEFAULT_PRESENCE_PENALTY,
    repetitionGuard: settings.repetitionGuard !== false,
    serverRepetitionDetection: settings.serverRepetitionDetection !== false,
  };
}

/**
 * Unified LLM adapter that works with different providers
 */
export class UnifiedLlmClient {
  private openaiClient?: LlmClient;
  private anthropicClient?: AnthropicClient;
  readonly provider: AiProvider;
  readonly config: ProviderConfig;

  constructor(config: ProviderConfig, guard: LlmGuardSettings = {}) {
    this.provider = config.provider;
    this.config = config;

    if (config.provider === 'anthropic') {
      this.anthropicClient = new AnthropicClient({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        enableThinking: config.enableThinking,
        thinkingTokens: config.thinkingTokens,
        // Anthropic 的 max_tokens 是必填且必须为正，0（表示「不发送」）在此退化为「用默认值」
        maxTokens: guard.maxTokens || undefined,
      });
    } else {
      // OpenAI, Deepseek, Custom all use OpenAI-compatible API
      this.openaiClient = new LlmClient({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        maxTokens: guard.maxTokens,
        frequencyPenalty: guard.frequencyPenalty,
        presencePenalty: guard.presencePenalty,
        repetitionGuard: guard.repetitionGuard,
        serverRepetitionDetection: guard.serverRepetitionDetection,
        // 思考深度是「按模型」的：网关上的 glm / qwen 与 DeepSeek-V4.1 未必认同一组档位，
        // 所以跟随模型配置而不是全局设置。
        reasoningEffort: config.reasoningEffort,
        reasoningEffortFine: config.reasoningEffortFine,
        thinkingTokenBudget: config.thinkingTokenBudget,
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

export {
  RepetitionGuard,
  detectTrailingRepeat,
  repetitionChannelLabel,
  trimTrailingRepeats,
  REASONING_GUARD_OPTIONS,
  CONTENT_GUARD_OPTIONS,
  SERVER_TRIM_OPTIONS,
  type RepetitionGuardOptions,
  type RepetitionHit,
  type RepetitionFuseInfo,
} from './repetitionGuard';

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

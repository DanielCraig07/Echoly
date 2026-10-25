/**
 * 周期性重复检测（reasoning / content 防死循环）。
 *
 * 推理模型在低温采样 + 长上下文下容易陷入「复读机」退化：反复输出同一句话或同几句话，
 * 既不结束也不产出新信息。流式 SSE 的 delta 通常只有几个字符，逐个比对 delta 是否相同
 * 无法命中这种退化（一句话会被切成几十个互不相同的 delta），因此这里改为在**累积文本**
 * 上做后缀周期检测：若末尾内容恰好是某个长度 p 的片段连续重复 N 次，即判定为死循环。
 *
 * 判定在长度不变的白空归一化文本上进行（`\s` → 空格，逐字符替换，索引与原文一致），
 * 这样「同一句话 + 换行抖动」也能命中，且命中后可以直接按字符数回裁原文。
 */

export interface RepetitionGuardOptions {
  /** 累积多少字符后才开始检测，避免短回答误判 */
  minChars?: number;
  /** 每次检测回看的尾部字符数 */
  tailChars?: number;
  /** 后缀需要连续重复多少次才判定为死循环 */
  minRepeats?: number;
  /** 候选周期的最小长度（字符） */
  minPeriod?: number;
  /** 候选周期的最大长度（字符） */
  maxPeriod?: number;
  /** 每新增多少字符执行一次检测（避免每个 delta 都做全量扫描） */
  checkEveryChars?: number;
}

export interface RepetitionHit {
  /** 被重复片段的长度 */
  period: number;
  /** 命中时该片段已连续重复的次数 */
  repeats: number;
  /** 被重复的片段（白空已归一化） */
  snippet: string;
}

/** 熔断命中信息：哪条通道、被重复片段多长、已重复几次。 */
export interface RepetitionFuseInfo {
  /** 触发熔断的内容通道。 */
  channel: 'reasoning' | 'content';
  /** 被重复片段的长度。服务端来源时未知，为 0。 */
  period: number;
  /** 已连续重复的次数。服务端来源时未知，为 0。 */
  repeats: number;
  /**
   * 触发来源。
   * `client` = 本地后缀周期检测命中；`server` = 推理引擎自己的 repetition_detection
   * 把 `finish_reason` 置为 `repetition`（周期未知）。
   */
  source: 'client' | 'server';
}

/** 通道的中文名，用于拼提示语。 */
export function repetitionChannelLabel(channel: RepetitionFuseInfo['channel']): string {
  return channel === 'reasoning' ? '思考过程' : '回答正文';
}

const DEFAULT_OPTIONS: Required<RepetitionGuardOptions> = {
  minChars: 200,
  tailChars: 8000,
  minRepeats: 5,
  minPeriod: 8,
  maxPeriod: 1200,
  checkEveryChars: 80,
};

/**
 * reasoning / thinking 通道的参数。
 * 退化几乎总是先出现在思考链里，且思考内容不面向用户，误判代价低，因此阈值偏敏感。
 */
export const REASONING_GUARD_OPTIONS: RepetitionGuardOptions = {
  minChars: 120,
  tailChars: 7000,
  minRepeats: 5,
  minPeriod: 8,
  maxPeriod: 1200,
  checkEveryChars: 80,
};

/**
 * 正文通道的参数。
 * 误判会截断正常回答（合法输出里也可能出现重复的表格行、样板代码块），所以更保守：
 * 需要更长的片段重复更多次才熔断。
 *
 * `minChars` 压到 200 是必要的：实测中「384 字符的回答里同一句话重复 21 遍」会
 * 作为一次成功回答交付给用户，旧阈值 1200 让它完全落在检测范围之外。
 * 误判风险由 `minRepeats=6` 与「片段至少含 4 个实义字符」两道条件兜住。
 */
export const CONTENT_GUARD_OPTIONS: RepetitionGuardOptions = {
  minChars: 200,
  tailChars: 8000,
  minRepeats: 6,
  minPeriod: 12,
  maxPeriod: 1200,
  checkEveryChars: 120,
};

/**
 * 服务端报 `finish_reason: repetition` 时用于回裁尾部副本的参数。
 *
 * 引擎只告诉我们「它复读了」，不告诉周期，而且触发时尾部已经堆了相当长的重复文本，
 * 所以这里把上限和回看窗口都放到最大：只做一次，宁可多裁一点，也不要把几万字符的
 * 复读原样交给用户。与流式检测不同，这次调用不在热路径上，性能无所谓。
 */
export const SERVER_TRIM_OPTIONS: RepetitionGuardOptions = {
  minChars: 0,
  tailChars: 200_000,
  minRepeats: 3,
  minPeriod: 4,
  maxPeriod: 20_000,
  checkEveryChars: 0,
};

/** 带内容的字符数（字母 / 数字 / CJK 等），用于排除纯符号片段的重复。 */
function meaningfulCharCount(text: string): number {
  let count = 0;
  for (const ch of text) {
    if (/[\p{L}\p{N}]/u.test(ch)) count++;
  }
  return count;
}

/**
 * 检测 `text` 末尾是否存在周期为 p、重复次数 >= minRepeats 的片段。
 * 返回周期最小（即重复次数最多）的那个命中，未命中返回 null。
 */
export function detectTrailingRepeat(
  text: string,
  options: RepetitionGuardOptions = {},
): RepetitionHit | null {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const normalized = text.replace(/\s/g, ' ');
  const len = normalized.length;
  const maxPeriod = Math.min(opts.maxPeriod, Math.floor(len / opts.minRepeats));
  const lastChar = normalized[len - 1];

  for (let period = opts.minPeriod; period <= maxPeriod; period++) {
    // 廉价预筛：真周期必然满足「末字符和它的上一个周期处相同」。
    // 这一步挡掉绝大多数候选周期，避免为每个 period 都做一次切片。
    if (normalized[len - 1 - period] !== lastChar) continue;

    const block = normalized.slice(len - period);
    // 纯符号 / 空白片段的重复（分隔线、缩进等）不算死循环
    if (meaningfulCharCount(block) < 4) continue;

    // 必须数满整段后缀，不能停在 minRepeats ——
    // 回裁量按 repeats 计算，少算一次就会在输出里留下一份多余的重复副本。
    let repeats = 1;
    while ((repeats + 1) * period <= len) {
      const end = len - period * repeats;
      if (normalized.slice(end - period, end) !== block) break;
      repeats++;
    }
    if (repeats >= opts.minRepeats) {
      return { period, repeats, snippet: block };
    }
  }
  return null;
}

/**
 * 按命中结果回裁原文末尾的重复副本，只保留第一份。
 *
 * 归一化是逐字符替换、长度不变，因此 `(repeats - 1) * period` 个字符的回裁量对原文同样成立，
 * 只要传入的 text 其尾部就是检测时使用的窗口即可。
 */
export function trimTrailingRepeats(text: string, hit: RepetitionHit): string {
  const cut = text.length - (hit.repeats - 1) * hit.period;
  return cut > 0 ? text.slice(0, cut) : text;
}

/**
 * 滑动送入增量文本并检测周期性重复。
 * 同一实例只会在首次命中时报告一次，之后 `feed` 一律返回 false。
 */
export class RepetitionGuard {
  private readonly opts: Required<RepetitionGuardOptions>;
  private tail = '';
  private totalChars = 0;
  private sinceCheck = 0;
  private detected: RepetitionHit | null = null;

  constructor(options: RepetitionGuardOptions = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...options };
  }

  /** 命中信息；未命中为 null。 */
  get hit(): RepetitionHit | null {
    return this.detected;
  }

  /** 已送入的总字符数。 */
  get chars(): number {
    return this.totalChars;
  }

  /** 送入一段新增文本，返回 true 表示本次检测到周期性重复。 */
  feed(delta: string): boolean {
    if (!delta) return false;

    this.totalChars += delta.length;
    this.tail =
      this.tail.length + delta.length > this.opts.tailChars
        ? (this.tail + delta).slice(-this.opts.tailChars)
        : this.tail + delta;

    if (this.detected) return false;
    if (this.totalChars < this.opts.minChars) return false;

    this.sinceCheck += delta.length;
    if (this.sinceCheck < this.opts.checkEveryChars) return false;
    this.sinceCheck = 0;

    this.detected = detectTrailingRepeat(this.tail, this.opts);
    return this.detected !== null;
  }
}

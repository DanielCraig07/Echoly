import type { ChatMessage } from '@deepseek-ide/shared';
import { estimateTokensFromMessages } from '@deepseek-ide/llm';

/**
 * 上下文压缩：把「早期步骤」换成一份由模型写的摘要。
 *
 * 为什么不是纯截断。旧的实现是三段纯截断：先把早期 tool 结果砍到 200 字符，
 * 再把早期 assistant 正文砍到 150 字符，最后直接把中间整段滑掉。问题在于
 * 被砍掉的恰好是「改过哪些文件、为什么这么改、哪条路试过不通」这类决定性信息 ——
 * 于是模型在第 40 步时对自己前 30 步做了什么一无所知，表现为重新读一遍同样的文件、
 * 重复一次已经失败过的方案，或者反过来问用户「你的原始需求是什么」。
 *
 * 摘要则由仍在上下文里的模型自己写：它知道要做的是什么、刚才在改哪几个文件。
 * 摘要请求本身**不新增工具、不带历史**，只喂「待压缩的片段」并要求输出结构化的进展记录，
 * 所以它是一次便宜的前缀式调用，而不是又一次 Agent 循环。
 *
 * 三层策略，逐层更贵，因此都是「能不做就不做」：
 * 1. 纯截断（免费，同步）—— 大多数情况下这一层就够了；
 * 2. 摘要在第 1 层之后仍然超预算时才触发，且整轮对话只做一次（调用方的 `summarizedOnce`），
 *    否则每一步都要多一次 LLM 调用，成本会盖过收益；
 * 3. 摘要失败（网络、超时、模型返回空）时退回纯截断 —— 压缩是防御性的辅助手段，
 *    它自己失败绝不能让 Agent 主循环跟着失败。
 */

/** 摘要请求的输入上限：只摘要「被压缩掉的那一段」，不是整轮对话。 */
const MAX_SUMMARY_INPUT_CHARS = 24_000;
/** 摘要请求的输出上限，够写一份结构化进展记录，又不至于反过来吃掉预算。 */
const SUMMARY_MAX_TOKENS = 1_200;
const SUMMARY_TIMEOUT_MS = 45_000;

export interface CompactionSplit {
  /** 保持不变的前缀（system + 当前任务的 user 消息）。 */
  keepHead: ChatMessage[];
  /** 需要被压缩掉的中间片段。 */
  middle: ChatMessage[];
  /** 原样保留的最近若干条。 */
  keepTail: ChatMessage[];
}

/**
 * 按条数切分消息数组。
 *
 * 边界必须落在「不切断 tool 调用配对」的位置上：assistant 消息带 `tool_calls`，
 * 紧随其后的是对应的 `role: 'tool'` 结果。若把发起方留在 tail 而把它的 tool 结果
 * 划进 middle（或反之，tail 以孤立的 tool 结果开头），模型会看到一次没有结果的调用，
 * 多数网关直接 400。调用方负责把 tail 开头的孤立 tool 结果摘掉。
 */
export function splitForCompaction(
  messages: ChatMessage[],
  headCount: number,
  tailCount: number,
): CompactionSplit {
  const keepHead = messages.slice(0, headCount);
  const tailStart = Math.max(headCount, messages.length - tailCount);
  return {
    keepHead,
    middle: messages.slice(headCount, tailStart),
    keepTail: messages.slice(tailStart),
  };
}

/**
 * 给片段里每条消息起个可读名字。
 *
 * tool 消息的 `name` 是工具名（`tool_call_id` 只是指向发起方的 id，不是名字）；
 * assistant 消息则优先用 `tool_calls` 里的函数名 —— 那才是「它刚才干了什么」。
 */
function describeMessage(m: ChatMessage): string {
  if (m.role === 'tool') {
    const name = m.name && m.name !== 'tool' ? m.name : undefined;
    return `工具结果${name ? `(${name})` : ''}`;
  }
  if (m.role === 'assistant') {
    const called = m.tool_calls?.map((t) => t.function?.name).filter(Boolean) ?? [];
    return called.length ? `助手（调用了 ${called.join(', ')}）` : '助手';
  }
  if (m.role === 'system') return '系统';
  return '用户';
}

/** 把待压缩片段摊平成一段纯文本，供摘要请求使用。 */
export function renderForSummary(
  middle: ChatMessage[],
  originalPrompt: string,
  droppedFromTruncation = 0,
  /** 上一轮压缩留下的进展记录。压缩可能发生不止一次，不含它会「归档了又被归档丢掉」。 */
  priorSummary?: string | null,
): string {
  const lines: string[] = [`【用户最初的任务】\n${originalPrompt.trim()}`];
  if (priorSummary?.trim()) {
    lines.push(
      [
        `\n【上一轮已归档的进展记录（其中的结论仍然有效，本次摘要必须把它合并进来而不是覆盖）】`,
        priorSummary.trim(),
      ].join('\n'),
    );
  }
  lines.push(`\n【本次需要归档的执行片段（共 ${middle.length} 条消息）】`);

  // 上一轮的记录要占掉预算：不扣的话「记录 + 新片段」可能超出后端上下文，
  // 而摘要请求本身被截断只会安静地少归档一段内容。
  let budget = Math.max(2_000, MAX_SUMMARY_INPUT_CHARS - (priorSummary?.length ?? 0));
  for (const m of middle) {
    if (budget <= 0) break;
    const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
    const clipped = body.length > 3_000 ? `${body.slice(0, 3_000)}\n...[已截断]` : body;
    // 工具参数是回放「它当初为什么这么改」的关键，正文里看不见，必须单独带上
    const args = m.tool_calls?.length
      ? `\n参数: ${m.tool_calls
          .map((t) => `${t.function?.name}(${(t.function?.arguments || '').slice(0, 300)})`)
          .join('; ')}`
      : '';
    const block = `\n--- ${describeMessage(m)} ---\n${clipped}${args}`;
    lines.push(block);
    budget -= block.length;
  }
  if (budget <= 0) lines.push(`\n...[片段过长，剩余内容未包含在摘要输入中]`);
  if (droppedFromTruncation > 0) {
    lines.push(`\n（另有 ${droppedFromTruncation} 条消息因边界对齐被一并折叠）`);
  }
  return lines.join('\n');
}

const SUMMARY_INSTRUCTION = `你正在为一个长时间运行的编码 Agent 归档它自己的执行历史。
下面的片段即将从上下文中删除，请把它压缩成一份**后续步骤必须知道**的进展记录。

只输出下列结构，不要寒暄、不要复述原文、不要给出新的建议：

## 任务目标
（一句话）

## 已完成
（改过/创建/删除了哪些文件，各自改了什么。给出相对路径。）

## 关键结论与约束
（读代码得到的、后续必须遵守的事实：接口签名、配置项、命名约定、数据结构；以及验证过的事实，例如某命令通过/失败。）

## 已排除的方案
（试过但没有成功或被否决的做法，以及原因。避免后续重复尝试。）

## 未完成
（还差什么，下一步该做什么。）

要求：信息密度优先。凡是「后续步骤不看就会做错」的内容必须留下；凡是能靠重新读文件得到的细节可以省略。`;

/**
 * 调一次模型写摘要。失败返回 null，由调用方退回纯截断。
 *
 * 刻意不复用 Agent 的工具配置：摘要不需要工具，也不需要长时间思考，
 * 当成普通补全来发，成本和延迟都可控。
 */
export async function summarizeCompaction(
  client: {
    chat: (params: {
      messages: ChatMessage[];
      maxTokens?: number;
      temperature?: number;
      signal?: AbortSignal;
    }) => Promise<ChatMessage>;
  },
  params: {
    middle: ChatMessage[];
    originalPrompt: string;
    droppedFromTruncation?: number;
    /** 上一轮压缩留下的进展记录；有它才能「增量归档」而不是覆盖。 */
    priorSummary?: string | null;
    signal?: AbortSignal;
  },
): Promise<string | null> {
  if (params.middle.length === 0) return null;
  const input = renderForSummary(
    params.middle,
    params.originalPrompt,
    params.droppedFromTruncation ?? 0,
    params.priorSummary,
  );
  if (!input.trim()) return null;

  // 摘要自身也要能被打断：用户按了停止却还在等一次 45 秒的摘要，是明显的体感问题
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  params.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);

  try {
    const msg = await client.chat({
      messages: [
        { role: 'system', content: SUMMARY_INSTRUCTION },
        { role: 'user', content: input },
      ],
      maxTokens: SUMMARY_MAX_TOKENS,
      temperature: 0.2,
      signal: controller.signal,
    });
    const text = typeof msg.content === 'string' ? msg.content.trim() : '';
    return text || null;
  } catch {
    // 压缩失败不能影响主流程：退回纯截断即可
    return null;
  } finally {
    clearTimeout(timer);
    params.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * 压缩说明的识别标记。
 *
 * 需要它是因为**压缩会重复发生**：第二次压缩时，消息数组里已经躺着上一次的压缩说明，
 * 若把它当作普通历史喂进摘要输入，模型会去摘要「上次的摘要」——既浪费预算，
 * 又会让真正的进展记录被稀释。用一个固定前缀识别，比在调用方比对整句话可靠：
 * 那句提示词随时可能被改写，而改写之后按整句匹配会**静默失效**（过滤不掉，但不报错）。
 */
export const COMPACTION_NOTICE_MARKER = '[系统说明：';

/** 判断一条消息是不是压缩说明（而非真实历史）。 */
export function isCompactionNotice(message: ChatMessage): boolean {
  return (
    message.role === 'system' &&
    typeof message.content === 'string' &&
    message.content.startsWith(COMPACTION_NOTICE_MARKER)
  );
}

/** 摘要被放进上下文时的包装，明确告诉模型这是压缩产物而不是新的用户输入。 */
export function formatCompactionNotice(summary: string, originalPrompt: string): string {
  return [
    `${COMPACTION_NOTICE_MARKER}本次任务已执行较多步骤，早期中间过程已由你自己归档为下面的进展记录。]`,
    '原始诉求已并入摘要，**不要**因此再次向用户确认需求。',
    '--- 进展记录（自动生成） ---',
    summary,
    '--- 进展记录结束 ---',
    '请基于这份记录、当前工作区的最新状态、以及最近的工具调用结果，继续完成任务。',
    '若改动已完整且验证通过，直接总结成果并回复用户，不要再重复已完成的步骤。',
    `（原始诉求备份，仅用于核对，无需复述：${originalPrompt.trim().slice(0, 400)}）`,
  ].join('\n');
}

/** 压缩后再次超预算时的兜底：把摘要本身也裁短，保证请求能发出去。 */
export function clampSummary(summary: string, maxChars = 6_000): string {
  if (summary.length <= maxChars) return summary;
  return `${summary.slice(0, maxChars)}\n...[进展记录过长已截断]`;
}

export { estimateTokensFromMessages };

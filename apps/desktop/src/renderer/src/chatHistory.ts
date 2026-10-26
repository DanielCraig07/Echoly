import type { ChatMessage, ChatSessionMessage } from '@deepseek-ide/shared';

const MAX_HISTORY_MESSAGES = 20;
const MAX_TOOL_RESULT_CHARS = 2000;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function mapSessionToChat(m: ChatSessionMessage): ChatMessage | null {
  if (m.role === 'user') {
    const images: Array<{ dataUrl: string; mediaType: string }> = [];
    const documents: Array<{ dataUrl: string; mediaType: string; name?: string }> = [];

    if (m.attachments && m.attachments.length > 0) {
      for (const att of m.attachments) {
        if (!att.dataUrl) continue;
        const isImage =
          att.type === 'image' ||
          att.mimeType?.startsWith('image/') ||
          /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(att.name);
        const isPdf = att.mimeType === 'application/pdf' || /\.pdf$/i.test(att.name);
        const match = att.dataUrl.match(/^data:([^;]+);base64,/);

        if (isImage) {
          const mediaType = match ? match[1] : att.mimeType || 'image/png';
          images.push({ dataUrl: att.dataUrl, mediaType });
        } else if (isPdf) {
          const mediaType = match ? match[1] : 'application/pdf';
          documents.push({ dataUrl: att.dataUrl, mediaType, name: att.name });
        } else {
          documents.push({
            dataUrl: att.dataUrl,
            mediaType: match ? match[1] : att.mimeType || 'application/octet-stream',
            name: att.name,
          });
        }
      }
    }

    return {
      role: 'user',
      content: m.content,
      images: images.length > 0 ? images : undefined,
      documents: documents.length > 0 ? documents : undefined,
    };
  }
  if (m.role === 'assistant') {
    // 跳过中间推理消息，只保留最终回复
    if (m.isIntermediate) return null;
    // 思考陷入死循环且未产出有效内容的熔断错误，不回灌到历史上下文，避免诱发后续模型再次死循环。
    // 认的是显式标志位而不是 content 里的句子：那句话一旦改措辞或翻译，这里就静默失效，
    // 而症状（下一轮又开始复读）离原因很远，很难查到是这里。
    if (m.circuitBroken) return null;
    return { role: 'assistant', content: m.content };
  }
  if (m.role === 'tool') {
    const name = m.toolName ?? 'tool';
    const body =
      m.content.length > MAX_TOOL_RESULT_CHARS
        ? `${m.content.slice(0, MAX_TOOL_RESULT_CHARS)}…`
        : m.content;
    return {
      role: 'user',
      content: `<tool_result name="${name}">\n${body}\n</tool_result>`,
    };
  }
  return null;
}

/** Build LLM history from session messages, excluding the just-appended user turn. */
export function buildAgentHistory(
  sessionMessages: ChatSessionMessage[],
  contextWindowTokens: number,
): ChatMessage[] {
  const prior = sessionMessages.slice(0, -1);
  const mapped: ChatMessage[] = [];
  for (const m of prior) {
    // 追加消息在开跑之后才提交，历史上的每一轮都不该再看到它 ——
    // 它属于「正在跑的那一轮」的上下文，由主进程的队列负责投递。
    // 不排除的话，同一句话会被下一轮的 history 再送一遍，模型看到的是重复提问。
    if (m.delivery === 'queued') continue;
    // 未送达的追加消息：界面已经明确告诉用户「请重新发送」，若这里又把它当历史送进去，
    // 用户照做就会得到两份内容相同的提问。要么让提示可信，要么别提示 —— 这里选前者。
    if (m.delivery === 'undelivered') continue;
    const cm = mapSessionToChat(m);
    if (cm) mapped.push(cm);
  }

  let trimmed = mapped.slice(-MAX_HISTORY_MESSAGES);
  const budget = Math.floor(contextWindowTokens * 0.5);
  while (trimmed.length > 0) {
    const used = trimmed.reduce((sum, m) => sum + estimateTokens(m.content ?? ''), 0);
    if (used <= budget) break;
    trimmed = trimmed.slice(1);
  }
  return trimmed;
}

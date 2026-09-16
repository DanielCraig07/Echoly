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

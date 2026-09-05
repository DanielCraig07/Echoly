import type { ChatMessage, ChatSessionMessage } from '@deepseek-ide/shared';

const MAX_HISTORY_MESSAGES = 20;
const MAX_TOOL_RESULT_CHARS = 2000;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function mapSessionToChat(m: ChatSessionMessage): ChatMessage | null {
  if (m.role === 'user') {
    return { role: 'user', content: m.content };
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

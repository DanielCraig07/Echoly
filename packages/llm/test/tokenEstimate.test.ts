import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@deepseek-ide/shared';
import { estimateTokensFromMessages } from '../src/index';

/**
 * 估算值的唯一用途是决定要不要压缩上下文，所以这里断言的重点不是「准」，
 * 而是「不会把大块内容整个漏掉」—— 漏掉的后果是压缩不触发、请求超窗、后端 400。
 */
describe('estimateTokensFromMessages', () => {
  it('数得到普通文本', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'hello world' }];
    const n = estimateTokensFromMessages(messages);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(20);
  });

  it('中文按接近一字一 token 计，而不是 4 字符一 token', () => {
    // 长度要够大：每条消息有固定的几十 token 开销，短样本会把比例摊平。
    const zh = '这是一段用来测试中文估算的文本，'.repeat(20);
    const en = 'a'.repeat(zh.length);
    const zhTokens = estimateTokensFromMessages([{ role: 'user', content: zh }]);
    const enTokens = estimateTokensFromMessages([{ role: 'user', content: en }]);
    // 中文远比同长度的 ASCII 贵；只做相对断言，避免把系数钉死在测试里。
    expect(zhTokens).toBeGreaterThan(enTokens * 3);
  });

  it('图片附件必须计入 —— 否则带图会话永远等不到压缩', () => {
    const base: ChatMessage = { role: 'user', content: '看这张图' };
    const bytes = 500 * 1024;
    const image: ChatMessage = {
      ...base,
      images: [
        {
          dataUrl: `data:image/png;base64,${'A'.repeat(Math.ceil((bytes * 4) / 3))}`,
          mediaType: 'image/png',
        },
      ],
    };
    const withoutImage = estimateTokensFromMessages([base]);
    const withImage = estimateTokensFromMessages([image]);
    // 500KB 的图，量级上应该是几百 token 以上；断言一个宽松下界即可。
    expect(withImage - withoutImage).toBeGreaterThan(500);
  });

  it('文档附件同样计入', () => {
    const doc: ChatMessage = {
      role: 'user',
      content: 'summarize',
      documents: [
        {
          dataUrl: `data:application/pdf;base64,${'A'.repeat(400_000)}`,
          mediaType: 'application/pdf',
        },
      ],
    };
    expect(estimateTokensFromMessages([doc])).toBeGreaterThan(300);
  });

  it('思考链计入上下文档位', () => {
    const plain: ChatMessage = { role: 'assistant', content: 'ok' };
    const withReasoning: ChatMessage = {
      role: 'assistant',
      content: 'ok',
      reasoning_content: 'x'.repeat(4000),
    };
    expect(estimateTokensFromMessages([withReasoning])).toBeGreaterThan(
      estimateTokensFromMessages([plain]) + 900,
    );
  });

  it('Claude 风格的 thinking 块计入', () => {
    const msg: ChatMessage = {
      role: 'assistant',
      content: 'ok',
      thinking: [{ type: 'thinking', thinking: 'y'.repeat(2000) }],
    };
    expect(estimateTokensFromMessages([msg])).toBeGreaterThan(400);
  });

  it('tool_calls 的参数计入', () => {
    const msg: ChatMessage = {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: '1',
          type: 'function',
          function: { name: 'read_file', arguments: `{"path":"${'a'.repeat(800)}"}` },
        },
      ],
    };
    expect(estimateTokensFromMessages([msg])).toBeGreaterThan(150);
  });

  it('空消息列表仍然给一个正数（下游拿它做分母）', () => {
    expect(estimateTokensFromMessages([])).toBe(1);
  });
});

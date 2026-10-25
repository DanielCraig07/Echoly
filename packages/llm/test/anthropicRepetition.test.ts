import { describe, expect, it } from 'vitest';
import { AnthropicClient } from '../src/anthropic';
import { LlmTimeoutError, isRepetitionLoopError } from '../src/index';
import type { ChatMessage } from '@deepseek-ide/shared';

const LEAD =
  '先说明背景与约束：本次改动只涉及流式读取这一层，' +
  '需要保证正常回答完全不受影响，只在真正退化时才介入。\n';

/** 构造 Anthropic SSE 事件流。 */
function anthropicSSE(events: Array<Record<string, unknown>>): string[] {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
}

function thinkingDeltas(text: string, size = 6): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    },
  ];
  for (let i = 0; i < text.length; i += size) {
    out.push({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: text.slice(i, i + size) },
    });
  }
  out.push({ type: 'content_block_stop', index: 0 });
  return out;
}

function textDeltas(text: string, size = 8): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  ];
  for (let i = 0; i < text.length; i += size) {
    out.push({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: text.slice(i, i + size) },
    });
  }
  out.push({ type: 'content_block_stop', index: 0 });
  return out;
}

function sseFetch(lines: string[], captured?: { body?: any }) {
  return (async (_url: string, init: any) => {
    if (captured) captured.body = JSON.parse(init.body);
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const line of lines) controller.enqueue(encoder.encode(line));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as any;
}

const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];

describe('AnthropicClient max_tokens', () => {
  it('开启 thinking 时 max_tokens 必须大于 budget_tokens', async () => {
    const captured: { body?: any } = {};
    const client = new AnthropicClient({
      apiKey: 'k',
      enableThinking: true,
      thinkingTokens: 20000,
      fetchImpl: sseFetch(anthropicSSE(textDeltas('好的。')), captured),
    });
    const gen = client.chatStream({ messages });
    while (!(await gen.next()).done) {
      // drain
    }
    expect(captured.body.max_tokens).toBeGreaterThan(20000);
    expect(captured.body.thinking.budget_tokens).toBe(20000);
  });

  it('未开启 thinking 时使用配置的上限', async () => {
    const captured: { body?: any } = {};
    const client = new AnthropicClient({
      apiKey: 'k',
      enableThinking: false,
      maxTokens: 4096,
      fetchImpl: sseFetch(anthropicSSE(textDeltas('好的。')), captured),
    });
    const gen = client.chatStream({ messages });
    while (!(await gen.next()).done) {
      // drain
    }
    expect(captured.body.max_tokens).toBe(4096);
  });
});

describe('AnthropicClient 复读熔断', () => {
  it('thinking 陷入重复时熔断，并裁掉重复副本', async () => {
    const sentence = '让我再确认一下这个函数的参数是否完整。';
    const text = `${LEAD}${sentence.repeat(60)}`;
    const client = new AnthropicClient({
      apiKey: 'k',
      enableThinking: true,
      fetchImpl: sseFetch(anthropicSSE(thinkingDeltas(text))),
    });

    let err: unknown;
    try {
      await client.chatStreamCollect({ messages });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LlmTimeoutError);
    expect(isRepetitionLoopError(err)).toBe(true);
    const partial = (err as LlmTimeoutError).partialMessage!;
    const thinkingText = partial.thinking!.map((b) => b.thinking).join('');
    expect(thinkingText.split(sentence).length - 1).toBe(1);
  });

  it('正文陷入重复时熔断', async () => {
    const sentence = '这段结论需要再重复强调一次以确保理解无误。';
    const text = `${LEAD}${sentence.repeat(120)}`;
    const client = new AnthropicClient({
      apiKey: 'k',
      enableThinking: false,
      fetchImpl: sseFetch(anthropicSSE(textDeltas(text, 6))),
    });

    let err: unknown;
    try {
      await client.chatStreamCollect({ messages });
    } catch (e) {
      err = e;
    }
    expect(isRepetitionLoopError(err)).toBe(true);
    const partial = (err as LlmTimeoutError).partialMessage!;
    expect(partial.content!.split(sentence).length - 1).toBe(1);
  });

  it('正常回答与工具调用不受影响', async () => {
    const answer = '# 说明\n\n本次改动覆盖三处：请求上限、周期检测、优雅收尾。\n';
    const client = new AnthropicClient({
      apiKey: 'k',
      enableThinking: false,
      fetchImpl: sseFetch(anthropicSSE(textDeltas(answer))),
    });

    const result = await client.chatStreamCollect({ messages });
    expect(result.message.content).toBe(answer);
  });

  it('熔断后停止转发退化 token', async () => {
    const sentence = '让我再确认一下这个函数的参数是否完整。';
    const text = `${LEAD}${sentence.repeat(300)}`;
    const client = new AnthropicClient({
      apiKey: 'k',
      enableThinking: true,
      fetchImpl: sseFetch(anthropicSSE(thinkingDeltas(text, 6))),
    });

    let forwarded = '';
    try {
      await client.chatStreamCollect({ messages }, undefined, (t) => (forwarded += t));
    } catch {
      // expected
    }
    expect(forwarded.length).toBeLessThan(1200);
    expect(forwarded.length).toBeLessThan(text.length / 4);
  });
});

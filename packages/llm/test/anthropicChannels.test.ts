import { describe, expect, it } from 'vitest';
import { AnthropicClient } from '../src/anthropic';
import type { ChatMessage } from '@deepseek-ide/shared';

/** 把若干 SSE 事件串成一条 ReadableStream 响应。 */
function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function collect(client: AnthropicClient, messages: ChatMessage[]) {
  const gen = client.chatStream({ messages });
  let last: any;
  while (true) {
    const step = await gen.next();
    if (step.done) {
      last = step.value;
      break;
    }
  }
  return last;
}

describe('Anthropic 通道的 system 消息处理', () => {
  it('数组中间的 system 消息也会被送进顶层 system', async () => {
    // 上下文压缩产生的摘要、防复读提示词都是**中间**位置的 system 消息。
    // 早先这里只取第一条，于是它们对模型完全不存在 —— 表现是
    // 「换通道之后长会话的压缩摘要像没生效一样」，而日志里一切正常。
    let captured: any = null;
    const client = new AnthropicClient({
      apiKey: 'k',
      fetchImpl: (async (_url: string, init: any) => {
        captured = JSON.parse(init.body);
        return sseResponse([
          'data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1}}}\n\n',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
          'data: {"type":"message_stop"}\n\n',
        ]);
      }) as any,
    });

    await collect(client, [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '第一轮' },
      { role: 'assistant', content: '回复' },
      { role: 'system', content: '【上下文摘要】早先做了 X' },
      { role: 'user', content: '第二轮' },
    ]);

    expect(captured.system).toContain('你是助手');
    expect(captured.system).toContain('早先做了 X');
    // 顺序：先来的在前，后来的修正在后
    expect(captured.system.indexOf('你是助手')).toBeLessThan(captured.system.indexOf('早先做了 X'));
  });

  it('system 消息不出现在 messages 数组里', async () => {
    let captured: any = null;
    const client = new AnthropicClient({
      apiKey: 'k',
      fetchImpl: (async (_url: string, init: any) => {
        captured = JSON.parse(init.body);
        return sseResponse(['data: {"type":"message_stop"}\n\n']);
      }) as any,
    });
    await collect(client, [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]);
    expect(captured.messages.every((m: any) => m.role !== 'system')).toBe(true);
  });
});

describe('Anthropic 通道的 thinking 签名', () => {
  it('捕获 signature_delta 并按 content block index 归位', async () => {
    const client = new AnthropicClient({
      apiKey: 'k',
      fetchImpl: (async () =>
        sseResponse([
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"推理A"}}\n\n',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-A"}}\n\n',
          'data: {"type":"content_block_start","index":1,"content_block":{"type":"thinking","thinking":""}}\n\n',
          'data: {"type":"content_block_delta","index":1,"delta":{"type":"thinking_delta","thinking":"推理B"}}\n\n',
          'data: {"type":"content_block_delta","index":1,"delta":{"type":"signature_delta","signature":"sig-B"}}\n\n',
          'data: {"type":"message_stop"}\n\n',
        ])) as any,
    });

    const res = await collect(client, [{ role: 'user', content: 'hi' }]);
    const thinking = res.message.thinking;
    expect(thinking).toHaveLength(2);
    expect(thinking[0].thinking).toBe('推理A');
    expect(thinking[0].signature).toBe('sig-A');
    // 交错思考时按 index 归位；只认「最后一个」会把两个签名写成同一个
    expect(thinking[1].thinking).toBe('推理B');
    expect(thinking[1].signature).toBe('sig-B');
  });

  it('回传时带签名的思考块原样送回，没签名的丢掉而不是让请求 400', async () => {
    let captured: any = null;
    const client = new AnthropicClient({
      apiKey: 'k',
      fetchImpl: (async (_url: string, init: any) => {
        captured = JSON.parse(init.body);
        return sseResponse(['data: {"type":"message_stop"}\n\n']);
      }) as any,
    });

    await collect(client, [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'ok',
        thinking: [
          { type: 'thinking', thinking: '有签名的', signature: 'sig-1' },
          { type: 'thinking', thinking: '没签名的' },
        ],
      },
      { role: 'user', content: '继续' },
    ]);

    const assistant = captured.messages.find((m: any) => m.role === 'assistant');
    const blocks = assistant.content.filter((b: any) => b.type === 'thinking');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].signature).toBe('sig-1');
  });
});

describe('Anthropic 通道的流内错误', () => {
  it('error 事件被当成失败抛出，而不是「模型没说话」', async () => {
    const client = new AnthropicClient({
      apiKey: 'k',
      fetchImpl: (async () =>
        sseResponse([
          'data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
          'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
        ])) as any,
    });

    await expect(collect(client, [{ role: 'user', content: 'hi' }])).rejects.toThrow(/Overloaded/);
  });
});

describe('Anthropic 通道的流尾 flush', () => {
  it('最后一条没有换行符收尾的 message_delta 也被读到', async () => {
    // 真实服务端的最后一个事件往往不带结尾换行。不 flush 就丢掉 stop_reason 与 usage，
    // 上层于是分不清「正常结束」与「被截断」。
    const client = new AnthropicClient({
      apiKey: 'k',
      fetchImpl: (async () =>
        sseResponse([
          'data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1}}}\n\n',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
          // 故意不带结尾的 \n\n
          'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":42}}',
        ])) as any,
    });

    const res = await collect(client, [{ role: 'user', content: 'hi' }]);
    expect(res.finishReason).toBe('max_tokens');
    expect(res.usage?.completionTokens).toBe(42);
  });
});

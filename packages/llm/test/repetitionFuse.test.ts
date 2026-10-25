import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FREQUENCY_PENALTY,
  DEFAULT_MAX_TOKENS,
  DEFAULT_PRESENCE_PENALTY,
  LlmClient,
  LlmTimeoutError,
  isLlmTimeoutError,
  isRepetitionLoopError,
} from '../src/index';
import type { ChatMessage } from '@deepseek-ide/shared';

/** 构造一个按 SSE 逐行吐出的 mock fetch，同时把请求体记录下来供断言。 */
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

function deltaChunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ id: 'c', choices: [{ index: 0, delta: payload, finish_reason: null }] })}\n\n`;
}

/** 把一段长文本切成小 delta 的 SSE 行序列。 */
function streamedText(text: string, field: 'content' | 'reasoning_content', size = 6): string[] {
  const lines: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    lines.push(deltaChunk({ [field]: text.slice(i, i + size) }));
  }
  lines.push('data: [DONE]\n\n');
  return lines;
}

const LEAD =
  '先说明背景与约束：本次改动只涉及流式读取这一层，' +
  '需要保证正常回答完全不受影响，只在真正退化时才介入。\n';

async function collect(client: LlmClient, messages: ChatMessage[]) {
  try {
    return { ok: true as const, result: await client.chatStreamCollect({ messages }) };
  } catch (err) {
    return { ok: false as const, err };
  }
}

describe('LlmClient 请求侧加固', () => {
  const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];

  it('默认带上 max_tokens 与惩罚项（复读退化第一道防线）', async () => {
    const captured: { body?: any } = {};
    const client = new LlmClient({
      baseUrl: 'http://example.test',
      fetchImpl: sseFetch(streamedText('好的。', 'content'), captured),
    });
    await client.chatStreamCollect({ messages });

    expect(captured.body.max_tokens).toBe(DEFAULT_MAX_TOKENS);
    expect(captured.body.frequency_penalty).toBe(DEFAULT_FREQUENCY_PENALTY);
    expect(captured.body.presence_penalty).toBe(DEFAULT_PRESENCE_PENALTY);
  });

  it('把构造参数透传给每次请求', async () => {
    const captured: { body?: any } = {};
    const client = new LlmClient({
      baseUrl: 'http://example.test',
      maxTokens: 2048,
      frequencyPenalty: 0.6,
      presencePenalty: 0.1,
      fetchImpl: sseFetch(streamedText('好的。', 'content'), captured),
    });
    await client.chatStreamCollect({ messages });

    expect(captured.body.max_tokens).toBe(2048);
    expect(captured.body.frequency_penalty).toBe(0.6);
    expect(captured.body.presence_penalty).toBe(0.1);
  });

  it('设为 0 时不发送该字段（兼容不认识的网关）', async () => {
    const captured: { body?: any } = {};
    const client = new LlmClient({
      baseUrl: 'http://example.test',
      maxTokens: 0,
      frequencyPenalty: 0,
      presencePenalty: 0,
      fetchImpl: sseFetch(streamedText('好的。', 'content'), captured),
    });
    await client.chatStreamCollect({ messages });

    expect('max_tokens' in captured.body).toBe(false);
    expect('frequency_penalty' in captured.body).toBe(false);
    expect('presence_penalty' in captured.body).toBe(false);
  });

  it('网关对加固字段报 400 时，去掉这些字段自动重发', async () => {
    const bodies: any[] = [];
    const fetchImpl = (async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if ('max_tokens' in body) {
        return new Response('{"error":{"message":"unknown field max_tokens"}}', { status: 400 });
      }
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          for (const line of streamedText('兜底成功。', 'content')) {
            controller.enqueue(encoder.encode(line));
          }
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as any;

    const client = new LlmClient({ baseUrl: 'http://example.test', fetchImpl });
    const result = await client.chatStreamCollect({ messages });

    expect(result.message.content).toBe('兜底成功。');
    expect(bodies.length).toBe(2);
    expect('max_tokens' in bodies[0]).toBe(true);
    expect('max_tokens' in bodies[1]).toBe(false);
  });

  it('无关的 400 不会被吞掉', async () => {
    const fetchImpl = (async () =>
      new Response('{"error":{"message":"model not found"}}', { status: 400 })) as any;
    const client = new LlmClient({ baseUrl: 'http://example.test', fetchImpl });
    await expect(client.chatStreamCollect({ messages })).rejects.toThrow(/model not found/i);
  });
});

describe('LlmClient 复读熔断', () => {
  const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];

  it('思考链陷入「重复同一句话」时熔断，并保留首份内容', async () => {
    const sentence = '让我再确认一下这个函数的参数是否完整。';
    const text = `${LEAD}${sentence.repeat(40)}`;
    const client = new LlmClient({
      baseUrl: 'http://example.test',
      fetchImpl: sseFetch(streamedText(text, 'reasoning_content')),
    });

    const outcome = await collect(client, messages);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;

    expect(isLlmTimeoutError(outcome.err)).toBe(true);
    expect(isRepetitionLoopError(outcome.err)).toBe(true);
    const timeoutErr = outcome.err as LlmTimeoutError;
    expect(timeoutErr.code).toBe('REPETITION_LOOP');
    // 上层靠 partialMessage 直接收尾，不再重试
    expect(timeoutErr.partialMessage?.reasoning_content).toBeDefined();
    const kept = timeoutErr.partialMessage!.reasoning_content!;
    // 复读之前的正常铺垫必须完整保留 —— 那部分内容是模型真正说过的
    expect(kept.startsWith(LEAD)).toBe(true);
    // 重复副本已被裁掉：只剩一份完整句子，外加最多一个周期内的残句。
    // 不能断言 endsWith(sentence) —— 检测是从尾部按周期回看的，周期块往往是句子
    // 的一个旋转，落点取决于流式切分位置，会留下不足一个周期的尾巴。
    expect(kept.split(sentence).length - 1).toBeLessThanOrEqual(1);
    expect(kept.length).toBeLessThan(text.length / 3);
  });

  it('正文陷入重复时同样熔断', async () => {
    const sentence = '这段结论需要再重复强调一次以确保理解无误。';
    const text = `${LEAD}${sentence.repeat(120)}`;
    const client = new LlmClient({
      baseUrl: 'http://example.test',
      fetchImpl: sseFetch(streamedText(text, 'content')),
    });

    const outcome = await collect(client, messages);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(isRepetitionLoopError(outcome.err)).toBe(true);
    const partial = (outcome.err as LlmTimeoutError).partialMessage!;
    expect(partial.content!.split(sentence).length - 1).toBe(1);
  });

  it('正常长回答不被熔断', async () => {
    const answer =
      '# 实现说明\n\n本次改动分为三层：请求侧补上 max_tokens 与惩罚项；' +
      '检测侧在累积文本上做后缀周期检测；收尾侧熔断后保留首份内容并提示用户。\n\n' +
      '## 注意事项\n\n正文通道阈值更保守，避免误伤合法的重复排版。\n';
    const client = new LlmClient({
      baseUrl: 'http://example.test',
      fetchImpl: sseFetch(streamedText(answer, 'content')),
    });

    const outcome = await collect(client, messages);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.message.content).toBe(answer);
  });

  it('短回答里的整句复读也会熔断，不会当成一次成功回答交付', async () => {
    // 回归：正文通道 minChars 曾经是 1200，这类 300 多字符的复读完全落在检测范围外，
    // 用户看到的是一次「正常结束」的回答，里面同一句话重复了几十遍。
    const sentence = '让我重新检查一下这段逻辑是否正确。';
    const text = sentence.repeat(20);
    expect(text.length).toBeLessThan(400);

    const client = new LlmClient({
      baseUrl: 'http://example.test',
      fetchImpl: sseFetch(streamedText(text, 'content', 4)),
    });

    const outcome = await collect(client, messages);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(isRepetitionLoopError(outcome.err)).toBe(true);
  });

  it('整段重播（周期 > 240 字符）也会熔断', async () => {
    // 回归：maxPeriod 曾经是 240，超长块的重复是彻底盲区，只能等 max_tokens 兜底。
    // 这里用内部无周期的块，确保命中不是靠块内的小周期。
    const pool = '丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥甲乙';
    let block = '',
      s = 31 >>> 0;
    while (block.length < 600) {
      s = (s * 1664525 + 1013904223) >>> 0;
      block += pool[(s >>> 8) % pool.length];
    }
    block = block.slice(0, 600);

    const client = new LlmClient({
      baseUrl: 'http://example.test',
      fetchImpl: sseFetch(streamedText(block.repeat(10), 'reasoning_content', 12)),
    });

    const outcome = await collect(client, messages);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(isRepetitionLoopError(outcome.err)).toBe(true);
  });

  it('服务端报 finish_reason: repetition 时走同一条熔断收尾路径', async () => {
    // 服务端那层防护在部分网关（含 New API）会被吞掉，但直连 vLLM 时是真生效的；
    // 旧实现把 finish_reason 整个丢掉，导致这层即使生效也无从感知。
    const lines = [
      deltaChunk({ content: '开始输出。' }),
      `data: ${JSON.stringify({ id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'repetition' }] })}\n\n`,
      'data: [DONE]\n\n',
    ];
    const client = new LlmClient({
      baseUrl: 'http://example.test',
      fetchImpl: sseFetch(lines),
    });

    const outcome = await collect(client, messages);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(isRepetitionLoopError(outcome.err)).toBe(true);
    expect((outcome.err as LlmTimeoutError).message).toMatch(/服务端判定/);
    // 已产出的内容仍要交给上层收尾
    expect((outcome.err as LlmTimeoutError).partialMessage?.content).toBe('开始输出。');
  });

  it('finish_reason 会透传到结果里，供上层区分 stop / length', async () => {
    const lines = [
      deltaChunk({ content: '好的。' }),
      `data: ${JSON.stringify({ id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'length' }] })}\n\n`,
      'data: [DONE]\n\n',
    ];
    const client = new LlmClient({
      baseUrl: 'http://example.test',
      fetchImpl: sseFetch(lines),
    });

    const outcome = await collect(client, messages);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.finishReason).toBe('length');
  });

  it('重复的工具参数不会被熔断（写文件类参数合法地就常是重复内容）', async () => {
    // 有意为之：tool_calls.arguments 不接入复读检测。若接进去，下面这种
    // 「往文件里写一段重复内容」的合法调用会被静默截断成半截 JSON。
    // 参数膨胀交给 max_tokens + JSON 解析失败兜底。
    const content = 'aaaaaaaaaaaaaaaaaaaa\\n'.repeat(20);
    const args = JSON.stringify({ path: 'fixture.txt', content });
    const lines: string[] = [];
    for (let i = 0; i < args.length; i += 40) {
      lines.push(
        `data: ${JSON.stringify({ id: 'c', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'write_file', arguments: args.slice(i, i + 40) } }] }, finish_reason: null }] })}\n\n`,
      );
    }
    lines.push(
      `data: ${JSON.stringify({ id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
    );
    lines.push('data: [DONE]\n\n');

    const client = new LlmClient({ baseUrl: 'http://example.test', fetchImpl: sseFetch(lines) });
    const outcome = await collect(client, messages);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 参数被完整拼出来，没有被半途掐断
    expect(outcome.result.message.tool_calls?.[0].function.arguments).toBe(args);
  });

  it('熔断后不再把退化 token 转发给上层', async () => {
    const sentence = '让我再确认一下这个函数的参数是否完整。';
    // 退化会一直持续下去；熔断后转发必须停止，而不是把整段复读灌进 UI
    const text = `${LEAD}${sentence.repeat(300)}`;
    const client = new LlmClient({
      baseUrl: 'http://example.test',
      fetchImpl: sseFetch(streamedText(text, 'reasoning_content', 6)),
    });

    let forwarded = '';
    try {
      await client.chatStreamCollect({ messages }, undefined, (t) => (forwarded += t));
    } catch {
      // expected
    }
    // 转发量被限制在「检测起始阈值 + 一个检测间隔」量级，而不是随退化无限增长
    expect(forwarded.length).toBeLessThan(1200);
    expect(forwarded.length).toBeLessThan(text.length / 4);
  });
});

import { describe, expect, it } from 'vitest';
import { LlmClient, SERVER_REPETITION_DETECTION, normalizeReasoningField } from '../src/index';
import type { ChatMessage } from '@deepseek-ide/shared';

/** 把请求体记录下来并回一个极短的正常响应。 */
function captureFetch(
  captured: { body?: any },
  bodies?: any[],
  failOn?: (body: any) => string | null,
) {
  return (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    captured.body = body;
    bodies?.push(body);
    const blame = failOn?.(body);
    if (blame)
      return new Response(`{"error":{"message":${JSON.stringify(blame)}}}`, { status: 400 });
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ id: 'c', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] })}\n\n`,
          ),
        );
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as any;
}

const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];

describe('LlmClient 思考深度控制', () => {
  it('默认不发送任何思考深度字段，沿用服务端档位', async () => {
    const captured: { body?: any } = {};
    const client = new LlmClient({
      baseUrl: 'http://example.test',
      fetchImpl: captureFetch(captured),
    });
    await client.chatStreamCollect({ messages });

    expect('reasoning_effort' in captured.body).toBe(false);
    expect('chat_template_kwargs' in captured.body).toBe(false);
    expect('thinking_token_budget' in captured.body).toBe(false);
  });

  it('档位走顶层 reasoning_effort', async () => {
    const captured: { body?: any } = {};
    const client = new LlmClient({
      baseUrl: 'http://example.test',
      reasoningEffort: 'xhigh',
      fetchImpl: captureFetch(captured),
    });
    await client.chatStreamCollect({ messages });

    expect(captured.body.reasoning_effort).toBe('xhigh');
    // 整数档位与字符串档位是同一个旋钮，不能同时下发
    expect(captured.body.chat_template_kwargs).toBeUndefined();
  });

  it('细粒度整数档位走 chat_template_kwargs 并压过顶层字段', async () => {
    const captured: { body?: any } = {};
    const client = new LlmClient({
      baseUrl: 'http://example.test',
      reasoningEffort: 'max',
      reasoningEffortFine: 37,
      fetchImpl: captureFetch(captured),
    });
    await client.chatStreamCollect({ messages });

    expect(captured.body.chat_template_kwargs).toEqual({ reasoning_effort: 37 });
    expect('reasoning_effort' in captured.body).toBe(false);
  });

  it('细粒度档位被夹到 1–100 的合法区间', async () => {
    const captured: { body?: any } = {};
    const client = new LlmClient({
      baseUrl: 'http://example.test',
      reasoningEffortFine: 500,
      fetchImpl: captureFetch(captured),
    });
    await client.chatStreamCollect({ messages });

    expect(captured.body.chat_template_kwargs.reasoning_effort).toBe(100);
  });

  it('请求级参数覆盖客户端级构造参数', async () => {
    const captured: { body?: any } = {};
    const client = new LlmClient({
      baseUrl: 'http://example.test',
      reasoningEffort: 'low',
      fetchImpl: captureFetch(captured),
    });
    await client.chatStreamCollect({ messages, reasoningEffort: 'none' });

    expect(captured.body.reasoning_effort).toBe('none');
  });

  it('思考 token 硬上限可与档位共存', async () => {
    const captured: { body?: any } = {};
    const client = new LlmClient({
      baseUrl: 'http://example.test',
      reasoningEffort: 'high',
      thinkingTokenBudget: 512,
      fetchImpl: captureFetch(captured),
    });
    await client.chatStreamCollect({ messages });

    expect(captured.body.reasoning_effort).toBe('high');
    expect(captured.body.thinking_token_budget).toBe(512);
  });

  it('硬上限为 0 时不发送该字段', async () => {
    const captured: { body?: any } = {};
    const client = new LlmClient({
      baseUrl: 'http://example.test',
      thinkingTokenBudget: 0,
      fetchImpl: captureFetch(captured),
    });
    await client.chatStreamCollect({ messages });

    expect('thinking_token_budget' in captured.body).toBe(false);
  });
});

describe('LlmClient 服务端原生重复检测', () => {
  it('开启时下发 repetition_detection', async () => {
    const captured: { body?: any } = {};
    const client = new LlmClient({
      baseUrl: 'http://example.test',
      serverRepetitionDetection: true,
      fetchImpl: captureFetch(captured),
    });
    await client.chatStreamCollect({ messages });

    expect(captured.body.repetition_detection).toEqual({ ...SERVER_REPETITION_DETECTION });
  });

  it('默认关闭，避免给不认识的网关平白多一个字段', async () => {
    const captured: { body?: any } = {};
    const client = new LlmClient({
      baseUrl: 'http://example.test',
      fetchImpl: captureFetch(captured),
    });
    await client.chatStreamCollect({ messages });

    expect('repetition_detection' in captured.body).toBe(false);
  });

  it('网关只拒绝思考深度字段时，保留采样加固而不是一起摘掉', async () => {
    const bodies: any[] = [];
    const captured: { body?: any } = {};
    const client = new LlmClient({
      baseUrl: 'http://example.test',
      reasoningEffort: 'high',
      fetchImpl: captureFetch(captured, bodies, (body) =>
        'reasoning_effort' in body ? 'unknown field reasoning_effort' : null,
      ),
    });
    const result = await client.chatStreamCollect({ messages });

    expect(result.message.content).toBe('ok');
    expect(bodies.length).toBe(2);
    expect('reasoning_effort' in bodies[0]).toBe(true);
    expect('reasoning_effort' in bodies[1]).toBe(false);
    // 采样加固必须还在 —— 否则为了兼容思考档位把复读防护也丢了
    expect(bodies[1].max_tokens).toBeDefined();
    expect(bodies[1].frequency_penalty).toBeDefined();
  });

  it('网关只拒绝采样字段时，保留思考档位', async () => {
    const bodies: any[] = [];
    const captured: { body?: any } = {};
    const client = new LlmClient({
      baseUrl: 'http://example.test',
      reasoningEffort: 'high',
      fetchImpl: captureFetch(captured, bodies, (body) =>
        'max_tokens' in body ? 'unknown field max_tokens' : null,
      ),
    });
    await client.chatStreamCollect({ messages });

    expect(bodies.length).toBe(2);
    expect('max_tokens' in bodies[1]).toBe(false);
    expect(bodies[1].reasoning_effort).toBe('high');
  });

  it('笼统的「未知字段」报错则两层一起摘掉', async () => {
    const bodies: any[] = [];
    const captured: { body?: any } = {};
    const client = new LlmClient({
      baseUrl: 'http://example.test',
      reasoningEffort: 'high',
      serverRepetitionDetection: true,
      fetchImpl: captureFetch(captured, bodies, (body) =>
        'reasoning_effort' in body ? 'unknown parameter in request' : null,
      ),
    });
    await client.chatStreamCollect({ messages });

    expect(bodies.length).toBe(2);
    expect('reasoning_effort' in bodies[1]).toBe(false);
    expect('max_tokens' in bodies[1]).toBe(false);
    expect('repetition_detection' in bodies[1]).toBe(false);
  });
});

describe('思考字段名归一', () => {
  it('vLLM 的 reasoning 归一到 reasoning_content', () => {
    const normalized = normalizeReasoningField({
      role: 'assistant',
      content: '答案',
      reasoning: '先算一下……',
    } as ChatMessage);
    expect(normalized.reasoning_content).toBe('先算一下……');
  });

  it('已是 reasoning_content 时保持不变，不覆盖', () => {
    const normalized = normalizeReasoningField({
      role: 'assistant',
      content: '答案',
      reasoning_content: '原值',
      reasoning: '另一个值',
    } as ChatMessage);
    expect(normalized.reasoning_content).toBe('原值');
  });

  it('两者都没有时不凭空造字段', () => {
    const normalized = normalizeReasoningField({ role: 'assistant', content: '答案' });
    expect(normalized.reasoning_content).toBeUndefined();
    expect('reasoning_content' in normalized).toBe(false);
  });
});

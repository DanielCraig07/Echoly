import { describe, expect, it } from 'vitest';
import os from 'node:os';
import type { ChatMessage } from '@deepseek-ide/shared';
import { LocalFsBackend } from '@deepseek-ide/tools';
import { runAgent } from '../src/index';

/**
 * 压缩（Stage 1/2）必须只改**本次请求用的副本**，不能改调用方交进来的历史对象。
 *
 * 背景：`messages` 是用 `...history` 拼出来的，数组里的历史条目与会话记录
 * 共享同一个对象引用。旧实现直接 `m.content = m.content.slice(0,150)`，
 * 于是「为了这一轮省 token」变成了「永久改写用户的历史消息」——
 * 切回那个会话时当初的完整回答只剩下 150 个字符，而且不报任何错。
 */

/** 构造一段足够长、一定会被 Stage 1/2 盯上的历史。 */
function longHistory(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: 'assistant' as const,
    content: `第 ${i} 条的完整回答 ${'A'.repeat(800)}`,
  }));
}

function collectingClient() {
  const seen: ChatMessage[][] = [];
  return {
    seen,
    async chatStreamCollect(params: { messages: ChatMessage[] }) {
      seen.push(params.messages);
      return { message: { role: 'assistant' as const, content: 'done' } };
    },
  };
}

const tinyWindow = { contextWindowTokens: 120, maxAgentSteps: 4 } as never;

describe('上下文压缩不改写调用方的历史对象', () => {
  it('Stage 1/2 压缩后，传入的 history 对象保持原样', async () => {
    const history = longHistory(8);
    const snapshot = history.map((m) => m.content ?? '');
    const client = collectingClient();

    await runAgent({
      prompt: '做点事',
      workspaceRoot: os.tmpdir(),
      backend: new LocalFsBackend(os.tmpdir()),
      settings: tinyWindow,
      mode: 'agent',
      client: client as never,
      applyImmediately: true,
      // 测试里没有权限交互：一律放行，免得每轮都卡在确认上
      requestConfirm: async () => true,
      onEvent: () => {},
      history,
    });

    expect(history.map((m) => m.content)).toEqual(snapshot);
    // ChatMessage.content 的类型是 `string | null`（少部分角色可以没有正文），
    // 这里断言的是「长度没被改短」，所以要显式取字符串而不是直接点下去。
    const texts = history.map((m) => m.content ?? '');
    expect(texts.every((c) => c.length === snapshot[0].length)).toBe(true);
    expect(texts.some((c) => c.includes('早期步骤输出已压缩'))).toBe(false);
    expect(texts.some((c) => c.includes('前序思考已简述'))).toBe(false);
  });

  it('但发给模型的那一份确实是压缩过的', async () => {
    const history = longHistory(8);
    const client = collectingClient();

    await runAgent({
      prompt: '做点事',
      workspaceRoot: os.tmpdir(),
      backend: new LocalFsBackend(os.tmpdir()),
      settings: tinyWindow,
      mode: 'agent',
      client: client as never,
      applyImmediately: true,
      // 测试里没有权限交互：一律放行，免得每轮都卡在确认上
      requestConfirm: async () => true,
      onEvent: () => {},
      history,
    });

    expect(client.seen.length).toBeGreaterThan(0);
    // 压缩若只落在副本上、又忘了在 Stage 3 之前把副本接回 messages，
    // 这里就会看到仍是原样的长文本 —— 那等于这一步白做。
    const sent = client.seen[0];
    expect(
      sent.some((m) => typeof m.content === 'string' && m.content.includes('前序思考已简述')),
    ).toBe(true);
    // 尾部（最近几条）按设计保留原文：压缩不能把「刚发生的事」也砍掉
    expect(
      sent.some((m) => typeof m.content === 'string' && m.content.includes('A'.repeat(100))),
    ).toBe(true);
  });

  it('压缩后 assistant 的 thinking 也被清掉，且不影响原对象', async () => {
    const history: ChatMessage[] = Array.from({ length: 8 }, (_, i) => ({
      role: 'assistant' as const,
      content: `${'B'.repeat(500)}`,
      thinking: [{ type: 'thinking' as const, thinking: `思考 ${i} ${'C'.repeat(400)}` }],
    }));
    const client = collectingClient();

    await runAgent({
      prompt: 'p',
      workspaceRoot: os.tmpdir(),
      backend: new LocalFsBackend(os.tmpdir()),
      settings: tinyWindow,
      mode: 'agent',
      client: client as never,
      applyImmediately: true,
      // 测试里没有权限交互：一律放行，免得每轮都卡在确认上
      requestConfirm: async () => true,
      onEvent: () => {},
      history,
    });

    expect(history.every((m) => m.thinking?.length === 1)).toBe(true);
  });
});

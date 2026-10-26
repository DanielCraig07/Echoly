import { describe, expect, it } from 'vitest';
import os from 'node:os';
import type { ChatMessage, QueuedUserMessage } from '@deepseek-ide/shared';
import { LocalFsBackend } from '@deepseek-ide/tools';
import { formatQueuedMessageBlock, runAgent } from '../src/index';

/**
 * 一个「第 N 次被调用时改口」的假客户端：用来观察队列消息到底在第几次调用前进入了上下文。
 */
function recordingClient(
  script: Array<(messages: ChatMessage[]) => Partial<ChatMessage>>,
) {
  const seen: ChatMessage[][] = [];
  let i = 0;
  return {
    seen,
    async chatStreamCollect(params: { messages: ChatMessage[] }) {
      seen.push(params.messages.map((m) => ({ ...m })));
      const step = script[Math.min(i, script.length - 1)];
      i++;
      return { message: { role: 'assistant', content: '', ...step(params.messages) } };
    },
  };
}

const baseSettings = { contextWindowTokens: 200_000, maxAgentSteps: 20 } as never;

function makeQueue(initial: QueuedUserMessage[], delayDrains = 0) {
  let pending = initial;
  let remainingDelays = delayDrains;
  const consumed: string[] = [];
  return {
    drain: () => {
      // 模拟「用户在 Agent 已经跑起来之后才提交」：前 N 次取队列时它还是空的
      if (remainingDelays > 0) {
        remainingDelays--;
        return [];
      }
      const out = pending;
      pending = [];
      return out;
    },
    onConsumed: (ids: string[]) => consumed.push(...ids),
    consumed,
  };
}

describe('runAgent queued messages', () => {
  it('injects a queued message into the context before the next model call', async () => {
    const client = recordingClient([
      () => ({
        content: 'working',
        tool_calls: [
          { id: 't1', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } },
        ],
      }),
      () => ({ content: 'done' }),
    ]);
    const queue = makeQueue([{ id: 'q1', content: '顺便也看一下 README' }], 1);

    await runAgent({
      prompt: '做点事',
      workspaceRoot: os.tmpdir(),
      backend: new LocalFsBackend(os.tmpdir()),
      settings: baseSettings,
      mode: 'agent',
      client: client as never,
      applyImmediately: true,
      onEvent: () => {},
      drainQueuedMessages: queue.drain,
      onQueuedMessagesConsumed: queue.onConsumed,
    });

    // 第一次调用发生在步骤边界之前（队列尚未被取），第二次必须带上它
    expect(client.seen).toHaveLength(2);
    const second = client.seen[1];
    const injected = second.find((m) => (m.content ?? '').includes('顺便也看一下 README'));
    expect(injected).toBeDefined();
    expect(injected?.role).toBe('user');
    // 必须明确标注这是追加消息，否则模型会把它当成一次新提问而丢掉手上的活
    expect(injected?.content).toContain('用户在本次任务执行过程中追加的消息');
    expect(queue.consumed).toEqual(['q1']);
  });

  it('takes the queue only once, so a message is never delivered twice', async () => {
    const client = recordingClient([
      () => ({
        content: '',
        tool_calls: [
          { id: 't1', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } },
        ],
      }),
      () => ({ content: 'done' }),
    ]);
    const queue = makeQueue([{ id: 'q1', content: '唯一的补充' }], 1);

    await runAgent({
      prompt: 'p',
      workspaceRoot: os.tmpdir(),
      backend: new LocalFsBackend(os.tmpdir()),
      settings: baseSettings,
      mode: 'agent',
      client: client as never,
      applyImmediately: true,
      onEvent: () => {},
      drainQueuedMessages: queue.drain,
    });

    const hits = client.seen
      .flat()
      .filter((m) => (m.content ?? '').includes('唯一的补充'));
    expect(hits).toHaveLength(1);
  });

  it('does not drain the queue mid-tool-call', async () => {
    // 三个步骤：队列在第一个步骤边界被取走。工具执行发生在步骤内部，
    // 因此「补充满 3 次调用」这个数量本身就说明它没有被在工具之间插入。
    const client = recordingClient([
      () => ({
        content: '',
        tool_calls: [
          { id: 't1', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } },
          { id: 't2', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } },
        ],
      }),
      () => ({ content: 'done' }),
    ]);
    const queue = makeQueue([{ id: 'q1', content: '中途补充' }], 1);

    await runAgent({
      prompt: 'p',
      workspaceRoot: os.tmpdir(),
      backend: new LocalFsBackend(os.tmpdir()),
      settings: baseSettings,
      mode: 'agent',
      client: client as never,
      applyImmediately: true,
      onEvent: () => {},
      drainQueuedMessages: queue.drain,
    });

    // 追加消息必须排在两条 tool 结果之后：模型要先看到自己上一次调用的结果，
    // 否则它会放弃核对，直接跳到新要求上。
    const second = client.seen[1];
    const queuedIdx = second.findIndex((m) => (m.content ?? '').includes('中途补充'));
    const lastToolIdx = second.map((m) => m.role).lastIndexOf('tool');
    expect(queuedIdx).toBeGreaterThan(lastToolIdx);
  });

  it('reports the ids it consumed so the UI can drop the pending badge', async () => {
    const client = recordingClient([() => ({ content: 'done' })]);
    const queue = makeQueue([
      { id: 'a', content: 'x' },
      { id: 'b', content: 'y' },
    ]);

    await runAgent({
      prompt: 'p',
      workspaceRoot: os.tmpdir(),
      backend: new LocalFsBackend(os.tmpdir()),
      settings: baseSettings,
      mode: 'agent',
      client: client as never,
      applyImmediately: true,
      onEvent: () => {},
      drainQueuedMessages: queue.drain,
      onQueuedMessagesConsumed: queue.onConsumed,
    });

    // 队列在第一个步骤边界就被取空，之后没有再取过
    expect(queue.consumed).toEqual(['a', 'b']);
  });
});

describe('formatQueuedMessageBlock', () => {
  it('tells the model not to restart or re-ask', () => {
    const text = formatQueuedMessageBlock('顺便加个测试', '');
    expect(text).toContain('补充要求');
    expect(text).toContain('不要从头重做已经完成的步骤');
    expect(text).toContain('顺便加个测试');
  });

  it('carries attachment blocks through', () => {
    const text = formatQueuedMessageBlock('看这个报错', '\n\n--- 附件图片: err.png ---');
    expect(text).toContain('err.png');
  });
});

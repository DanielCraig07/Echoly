import { describe, expect, it } from 'vitest';
import { runAgent } from '../src/index';
import { LocalFsBackend } from '@deepseek-ide/tools';
import os from 'os';

describe('Agent Context Compaction & Empty FinalText Fallback', () => {
  it('falls back to helpful summary message when model returns empty content after tools', async () => {
    let callCount = 0;
    const mockClient = {
      chatStreamCollect: async (_params: any) => {
        callCount++;
        if (callCount === 1) {
          // First turn: call a tool
          return {
            message: {
              role: 'assistant',
              content: 'Let me list files',
              tool_calls: [
                {
                  id: 'tc_1',
                  type: 'function',
                  function: { name: 'list_dir', arguments: '{"path":"."}' },
                },
              ],
            },
          };
        }
        // Second turn: finish, but model returns empty string
        return {
          message: {
            role: 'assistant',
            content: '',
          },
        };
      },
    };

    const events: any[] = [];
    const result = await runAgent({
      prompt: 'Execute task',
      workspaceRoot: os.tmpdir(),
      backend: new LocalFsBackend(os.tmpdir()),
      settings: {
        contextWindowTokens: 4000,
      } as any,
      mode: 'agent',
      client: mockClient as any,
      applyImmediately: true,
      // 测试里没有权限交互：一律放行，免得每轮都卡在确认上
      requestConfirm: async () => true,
      onEvent: (e) => events.push(e),
    });

    expect(result.finalText).toBeDefined();
    expect(result.finalText).toContain('已完成计划中的修改与执行');
    expect(result.finalText).toContain('共执行了 1 步工具操作');

    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent).toBeDefined();
    expect(doneEvent.finalText).toContain('已完成计划中的修改与执行');
  });

  it('compacts older tool results when token estimate exceeds budget', async () => {
    let callCount = 0;
    let lastSentMessages: any[] = [];

    const mockClient = {
      chatStreamCollect: async (params: any) => {
        callCount++;
        lastSentMessages = params.messages;
        if (callCount <= 12) {
          return {
            message: {
              role: 'assistant',
              content: `Step ${callCount}`,
              tool_calls: [
                {
                  id: `tc_${callCount}`,
                  type: 'function',
                  function: { name: 'list_dir', arguments: '{"path":"."}' },
                },
              ],
            },
          };
        }
        return {
          message: {
            role: 'assistant',
            content: 'All done now.',
          },
        };
      },
    };

    await runAgent({
      prompt: 'Repeatedly run tools to trigger compaction',
      workspaceRoot: os.tmpdir(),
      backend: new LocalFsBackend(os.tmpdir()),
      settings: {
        contextWindowTokens: 500, // Small budget to trigger compaction quickly
      } as any,
      mode: 'agent',
      client: mockClient as any,
      applyImmediately: true,
      // 测试里没有权限交互：一律放行，免得每轮都卡在确认上
      requestConfirm: async () => true,
      onEvent: () => {},
    });

    expect(callCount).toBe(13);
    // Verify that compaction occurred in earlier messages
    const compactedTool = lastSentMessages.find(
      (m: any) => m.role === 'tool' && m.content.includes('[早期步骤输出已压缩]'),
    );
    const hasSlidingWindowNotice = lastSentMessages.some(
      (m: any) => m.role === 'system' && m.content?.includes('当前执行步数较多'),
    );
    expect(Boolean(compactedTool || hasSlidingWindowNotice)).toBe(true);
  });

  it('correctly identifies local/private LAN inference nodes', async () => {
    const { isLocalOrPrivateNetworkUrl } = await import('../src/index');
    expect(isLocalOrPrivateNetworkUrl('http://192.168.10.241:1333')).toBe(true);
    expect(isLocalOrPrivateNetworkUrl('http://localhost:11434')).toBe(true);
    expect(isLocalOrPrivateNetworkUrl('http://127.0.0.1:8000')).toBe(true);
    expect(isLocalOrPrivateNetworkUrl('http://10.0.1.20:8080/v1')).toBe(true);
    expect(isLocalOrPrivateNetworkUrl('http://172.20.0.5:11434')).toBe(true);
    expect(isLocalOrPrivateNetworkUrl('https://api.deepseek.com')).toBe(false);
    expect(isLocalOrPrivateNetworkUrl('https://api.openai.com/v1')).toBe(false);
    expect(isLocalOrPrivateNetworkUrl('https://api.anthropic.com')).toBe(false);
  });

  it('triggers emergency deep compaction and auto-healing retry when LLM encounters timeout', async () => {
    const { LlmTimeoutError } = await import('@deepseek-ide/llm');
    let callCount = 0;
    let retriedWithCompactedContext = false;

    const mockClient = {
      chatStreamCollect: async (params: any) => {
        callCount++;
        if (callCount === 1) {
          // Simulate first turn: tool call
          return {
            message: {
              role: 'assistant',
              content: 'Running initial step',
              tool_calls: [
                {
                  id: 'tc_1',
                  type: 'function',
                  function: { name: 'list_dir', arguments: '{"path":"."}' },
                },
              ],
            },
          };
        }
        if (callCount === 2) {
          // Simulate GPU VRAM stall / first token timeout on local node
          throw new LlmTimeoutError(
            '首个 Token 响应超时（已等待 60 秒），推理节点响应挂起或显存过载',
            'FIRST_TOKEN_TIMEOUT',
            60000,
          );
        }
        if (callCount === 3) {
          // Verify that auto-healing retry occurred and messages were pruned
          const hasHealNotice = params.messages.some(
            (m: any) => m.role === 'system' && m.content?.includes('系统自愈提示'),
          );
          if (hasHealNotice) {
            retriedWithCompactedContext = true;
          }
          return {
            message: {
              role: 'assistant',
              content: 'Recovered from timeout and completed task.',
            },
          };
        }
        return {
          message: {
            role: 'assistant',
            content: 'Done',
          },
        };
      },
    };

    const events: any[] = [];
    const result = await runAgent({
      prompt: 'Test timeout resilience',
      workspaceRoot: os.tmpdir(),
      backend: new LocalFsBackend(os.tmpdir()),
      settings: {
        baseUrl: 'http://192.168.10.241:1333',
        contextWindowTokens: 128000,
      } as any,
      mode: 'agent',
      client: mockClient as any,
      applyImmediately: true,
      // 测试里没有权限交互：一律放行，免得每轮都卡在确认上
      requestConfirm: async () => true,
      onEvent: (e) => events.push(e),
    });

    expect(callCount).toBe(3);
    expect(retriedWithCompactedContext).toBe(true);
    expect(result.finalText).toContain('Recovered from timeout and completed task.');
  });

  it('preserves current prompt and anchors original intent when compaction occurs with multi-turn history', async () => {
    let callCount = 0;
    let lastSentMessages: any[] = [];

    const mockClient = {
      chatStreamCollect: async (params: any) => {
        callCount++;
        lastSentMessages = params.messages;
        if (callCount <= 12) {
          return {
            message: {
              role: 'assistant',
              content: `Step ${callCount}`,
              tool_calls: [
                {
                  id: `tc_${callCount}`,
                  type: 'function',
                  function: { name: 'list_dir', arguments: '{"path":"."}' },
                },
              ],
            },
          };
        }
        return {
          message: {
            role: 'assistant',
            content: 'Task completed successfully based on user prompt.',
          },
        };
      },
    };

    const currentPrompt = 'Fix critical bug: editor context menu clipped by bottom panel';

    await runAgent({
      prompt: currentPrompt,
      history: [
        { role: 'user', content: 'Ancient message 1: Hello from 10 turns ago' },
        { role: 'assistant', content: 'Ancient reply 1' },
      ],
      workspaceRoot: os.tmpdir(),
      backend: new LocalFsBackend(os.tmpdir()),
      settings: {
        contextWindowTokens: 500, // Trigger compaction quickly
      } as any,
      mode: 'agent',
      client: mockClient as any,
      applyImmediately: true,
      // 测试里没有权限交互：一律放行，免得每轮都卡在确认上
      requestConfirm: async () => true,
      onEvent: () => {},
    });

    expect(callCount).toBe(13);
    // Verify that current user prompt is strictly preserved and anchored, NOT the ancient history
    const userMsg = lastSentMessages.find((m: any) => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(userMsg.content).toContain(currentPrompt);
    expect(userMsg.content).not.toContain('Ancient message 1');

    // Verify structured goal anchor in system notice
    const systemNotice = lastSentMessages.find(
      (m: any) => m.role === 'system' && m.content?.includes('【当前任务的原始诉求】'),
    );
    expect(systemNotice).toBeDefined();
    expect(systemNotice.content).toContain(currentPrompt);
    expect(systemNotice.content).toContain('切勿因中间历史被压缩而向用户询问重复确认原始诉求');
  });

  it('收尾而非重试：遇到复读熔断时直接把已有内容作为最终答复', async () => {
    const { LlmTimeoutError } = await import('@deepseek-ide/llm');
    let callCount = 0;

    const mockClient = {
      chatStreamCollect: async () => {
        callCount++;
        // 熔断时流式层会把已产出的（裁掉重复副本的）内容挂在 partialMessage 上
        throw new LlmTimeoutError(
          '检测到思考过程周期性重复（19 字符的片段连续重复 40 次），已熔断以终止无限复读',
          'REPETITION_LOOP',
          0,
          { message: { role: 'assistant', content: '这是熔断前已产出的阶段性结论。' } },
        );
      },
    };

    const events: any[] = [];
    const result = await runAgent({
      prompt: 'Test repetition fuse',
      workspaceRoot: os.tmpdir(),
      backend: new LocalFsBackend(os.tmpdir()),
      settings: { contextWindowTokens: 128000 } as any,
      mode: 'agent',
      client: mockClient as any,
      applyImmediately: true,
      // 测试里没有权限交互：一律放行，免得每轮都卡在确认上
      requestConfirm: async () => true,
      onEvent: (e) => events.push(e),
    });

    // 关键：只调用一次。重试会把退化文本回灌上下文，立刻二次复读。
    expect(callCount).toBe(1);
    expect(result.finalText).toContain('这是熔断前已产出的阶段性结论。');
    expect(result.finalText).toContain('周期性重复');
    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('思考阶段熔断且正文为空时，给出可操作的提示而不是空答复', async () => {
    const { LlmTimeoutError } = await import('@deepseek-ide/llm');
    const mockClient = {
      chatStreamCollect: async () => {
        throw new LlmTimeoutError(
          '检测到思考过程周期性重复（19 字符的片段连续重复 40 次），已熔断以终止无限复读',
          'REPETITION_LOOP',
          0,
          { message: { role: 'assistant', content: null } },
        );
      },
    };

    const events: any[] = [];
    const result = await runAgent({
      prompt: 'Test repetition fuse with empty content',
      workspaceRoot: os.tmpdir(),
      backend: new LocalFsBackend(os.tmpdir()),
      settings: { contextWindowTokens: 128000 } as any,
      mode: 'agent',
      client: mockClient as any,
      applyImmediately: true,
      // 测试里没有权限交互：一律放行，免得每轮都卡在确认上
      requestConfirm: async () => true,
      onEvent: (e) => events.push(e),
    });

    expect(result.finalText).toContain('陷入重复循环');
    expect(result.finalText).toContain('周期性重复');
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('思考阶段陷入死循环时，自动优化提示词并破环重试成功', async () => {
    const { LlmTimeoutError } = await import('@deepseek-ide/llm');
    let callCount = 0;
    let lastParams: any = null;

    const mockClient = {
      chatStreamCollect: async (params: any) => {
        callCount++;
        lastParams = params;
        if (callCount === 1) {
          // 第一次调用在思考阶段陷入复读死循环，抛出 REPETITION_LOOP 且 content 为空
          throw new LlmTimeoutError(
            '检测到思考过程周期性重复（25 字符的片段连续重复 30 次），已熔断以终止无限复读',
            'REPETITION_LOOP',
            0,
            { message: { role: 'assistant', content: null, reasoning_content: '思考死循环' } },
          );
        }
        // 第二次调用带入破环自愈提示词与采样扰动，成功产出结论
        return {
          message: {
            role: 'assistant',
            content: '已成功破环自愈并完成最终任务。',
          },
        };
      },
    };

    const events: any[] = [];
    const result = await runAgent({
      prompt: '优化算法避免重复死锁',
      workspaceRoot: os.tmpdir(),
      backend: new LocalFsBackend(os.tmpdir()),
      settings: { contextWindowTokens: 128000 } as any,
      mode: 'agent',
      client: mockClient as any,
      applyImmediately: true,
      // 测试里没有权限交互：一律放行，免得每轮都卡在确认上
      requestConfirm: async () => true,
      onEvent: (e) => events.push(e),
    });

    // 验证触发了自动重试自愈
    expect(callCount).toBe(2);
    expect(result.finalText).toContain('已成功破环自愈并完成最终任务。');
    expect(events.some((e) => e.type === 'done')).toBe(true);

    // 验证第二次调用传入了防循环指令以及采样惩罚
    expect(lastParams.frequencyPenalty).toBe(0.5);
    expect(lastParams.presencePenalty).toBe(0.5);
    const antiLoopNotice = lastParams.messages.find(
      (m: any) => m.role === 'system' && m.content?.includes('【强制破环执行规则】'),
    );
    expect(antiLoopNotice).toBeDefined();
    expect(antiLoopNotice.content).toContain('优化算法避免重复死锁');
  });
});

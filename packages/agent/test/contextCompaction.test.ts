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
      onEvent: (e) => events.push(e),
    });

    expect(callCount).toBe(3);
    expect(retriedWithCompactedContext).toBe(true);
    expect(result.finalText).toContain('Recovered from timeout and completed task.');
  });
});


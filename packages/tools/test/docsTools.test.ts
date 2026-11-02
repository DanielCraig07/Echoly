import { describe, expect, it, vi } from 'vitest';
import { executeTool, toolsForMode, type ToolContext } from '../src/index';

/**
 * `search_docs` / `read_doc` 在**执行层**的行为。
 *
 * 与 `docs.test.ts`（纯解析与打分）分开：这里只管两件容易写漏的事 ——
 * 没配来源时要明确说「没配」，而不是返回一个空结果让模型反复重试；
 * 以及这两个工具是不是按只读工具走的（读文档不该弹写操作确认）。
 */

const noop = async () => undefined;

function makeCtx(docs?: ToolContext['docs']): ToolContext {
  return {
    workspaceRoot: '/tmp/ws',
    backend: { kind: 'local', root: '/tmp/ws' } as never,
    permissionMode: 'ask',
    requestConfirm: noop as never,
    docs,
  } as unknown as ToolContext;
}

describe('search_docs / read_doc 的工具定义', () => {
  it('两个工具都注册为只读（读文档不该弹写操作确认）', () => {
    const names = toolsForMode('ask').map((t) => t.function.name);
    expect(names).toContain('search_docs');
    expect(names).toContain('read_doc');
  });
});

describe('未配置文档源时', () => {
  it('search_docs 明确回报「尚未配置」，而不是返回空结果', async () => {
    // 返回空结果只会让 Agent 换个说法再试一次；说清「没配」它才会改方案或告知用户
    const result = await executeTool(
      'search_docs',
      JSON.stringify({ query: '认证' }),
      makeCtx(undefined),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('尚未配置');
    expect(result.content).toContain('设置');
  });

  it('read_doc 同样明确回报', async () => {
    const result = await executeTool(
      'read_doc',
      JSON.stringify({ url: 'https://x.dev/a' }),
      makeCtx(undefined),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('尚未配置');
  });
});

describe('已配置文档源时', () => {
  const search = vi.fn(async (query: string) => [
    {
      source: 'Acme',
      title: '认证',
      url: 'https://x.dev/auth',
      description: '令牌与签名',
      section: 'API',
    },
    { source: 'Acme', title: '分页', url: 'https://x.dev/paging' },
  ]);

  it('结果里带上来源、标题、地址与说明', async () => {
    const result = await executeTool(
      'search_docs',
      JSON.stringify({ query: '认证' }),
      makeCtx({ search, read: noop as never } as never),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('https://x.dev/auth');
    expect(result.content).toContain('令牌与签名');
    expect(result.content).toContain('API');
  });

  it('没有命中时给出下一步（换说法或改用 web_search），而不是一个空的成功', async () => {
    const result = await executeTool(
      'search_docs',
      JSON.stringify({ query: 'x' }),
      makeCtx({ search: async () => [], read: noop as never } as never),
    );
    expect(result.content).toContain('没有匹配');
    expect(result.content).toContain('web_search');
  });

  it('read_doc 把标题/截断提示与正文一起返回', async () => {
    const result = await executeTool(
      'read_doc',
      JSON.stringify({ url: 'https://x.dev/auth' }),
      makeCtx({
        search: async () => [],
        read: async (url: string) => ({
          ok: true,
          url,
          title: '认证',
          content: '# 认证',
          truncated: true,
        }),
      } as never),
    );
    expect(result.content).toContain('标题: 认证');
    expect(result.content).toContain('已截断');
    expect(result.content).toContain('# 认证');
  });

  it('read_doc 失败时把原因透出来（例如不在已配置的文档源内）', async () => {
    const result = await executeTool(
      'read_doc',
      JSON.stringify({ url: 'https://evil.dev/a' }),
      makeCtx({
        search: async () => [],
        read: async (url: string) => ({ ok: false, url, error: '该地址不在已配置的文档源内' }),
      } as never),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('不在已配置的文档源内');
  });

  it('缺少 query / url 时报参数错误，不会去调宿主', async () => {
    const host = { search, read: vi.fn() } as never;
    const noQuery = await executeTool('search_docs', '{}', makeCtx(host));
    expect(noQuery.isError).toBe(true);
    expect(noQuery.content).toContain('query');
    const noUrl = await executeTool('read_doc', '{}', makeCtx(host));
    expect(noUrl.isError).toBe(true);
    expect(noUrl.content).toContain('url');
  });
});

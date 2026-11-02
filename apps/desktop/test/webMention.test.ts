import { describe, it, expect, vi } from 'vitest';

// `specialMentions.ts` 顶层 import 了 monaco（要读 markers 做 @Problems），
// 而 monaco 是打包器解析的 ESM 包，node 测试环境里 import 不进来。
// 这里只用到它不依赖 monaco 的那部分，所以给一个空壳即可。
vi.mock('monaco-editor', () => ({
  editor: { getModelMarkers: () => [] },
  MarkerSeverity: { Error: 8, Warning: 4 },
}));

import { buildWebMentionContent, extractWebQuery } from '../src/renderer/src/services/webMention';
import { resolveSpecialMentions } from '../src/renderer/src/services/specialMentions';

/**
 * `@Web` 提及。
 *
 * 这里的实现**不预抓搜索结果**：`web_search` 已经是一颗带 SSRF 防护、
 * 逐跳校验重定向、边读边卡字节上限的成熟工具，在渲染层另开一条取数路径
 * 等于把那套防护再做一遍，漏掉任何一条都很难发现。所以 `@Web` 只负责
 * 把意图讲清楚，并在联网关闭时明确告知。
 */

describe('extractWebQuery', () => {
  it('摘掉 @Web 本身，留下真正的检索词', () => {
    expect(extractWebQuery('@Web zod 递归 schema 怎么写')).toBe('zod 递归 schema 怎么写');
  });

  it('大小写与位置都不敏感', () => {
    expect(extractWebQuery('帮我查 @web vite 的构建缓存')).toBe('帮我查 vite 的构建缓存');
  });

  it('其它特殊提及也一并摘掉（它们各自会展开成附件）', () => {
    expect(extractWebQuery('@Web @Git 这个改动怎么回滚')).toBe('这个改动怎么回滚');
  });

  it('不误伤其它含 @ 的文本', () => {
    // @types/node 是用户检索词的一部分；邮箱、装饰器同理
    expect(extractWebQuery('@Web @types/node 装不上')).toBe('@types/node 装不上');
    expect(extractWebQuery('@Web 发到 a@b.com 会失败吗')).toBe('发到 a@b.com 会失败吗');
  });

  it('多余空白被压平，超长截断', () => {
    expect(extractWebQuery('@Web   a\n\n  b ')).toBe('a b');
    expect(extractWebQuery(`@Web ${'q'.repeat(500)}`)).toHaveLength(200);
  });

  it('只剩提及本身时返回空串', () => {
    expect(extractWebQuery('@Web')).toBe('');
  });
});

describe('buildWebMentionContent', () => {
  it('联网可用时指示模型用 web_search 并给出来源', () => {
    const text = buildWebMentionContent('zod 递归', true);
    expect(text).toContain('web_search');
    expect(text).toContain('zod 递归');
    expect(text).toContain('链接');
  });

  it('联网关闭时明确说明不可用，并要求不要调用工具', () => {
    // 不说明的话模型会去调一个不可用的工具，用户看到的是一句含糊的失败
    const text = buildWebMentionContent('zod 递归', false);
    expect(text).toContain('联网已关闭');
    expect(text).toContain('不要调用');
    expect(text).not.toContain('请用 web_search');
  });

  it('没写检索词时给出可执行的兜底说明，而不是留一个空查询串', () => {
    expect(buildWebMentionContent('', true)).toContain('没有写明检索词');
  });
});

describe('resolveSpecialMentions 与 @Web', () => {
  const deps = (webEnabled: boolean) => ({
    getWorkspaceRoot: () => '/tmp/ws',
    getWebEnabled: async () => webEnabled,
  });

  it('没有 @Web 时不产生附件', async () => {
    const out = await resolveSpecialMentions('普通提问', deps(true));
    expect(out).toEqual([]);
  });

  it('有 @Web 时产出一条 @Web 附件', async () => {
    const out = await resolveSpecialMentions('@Web 查点什么', deps(true));
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('@Web');
    expect(out[0].content).toContain('web_search');
  });

  it('联网关闭时附件里写明原因', async () => {
    const out = await resolveSpecialMentions('@Web 查点什么', deps(false));
    expect(out[0].content).toContain('联网已关闭');
  });

  it('读取联网状态失败时按「不可用」处理', async () => {
    // 编一个「已联网」的状态会让模型去调不可用的工具，比少联网更糟
    const out = await resolveSpecialMentions('@Web x', {
      getWorkspaceRoot: () => '/tmp/ws',
      getWebEnabled: async () => {
        throw new Error('读设置失败');
      },
    });
    expect(out[0].content).toContain('联网已关闭');
  });

  it('@Web 与 @Terminal 可以同时存在，各出一条', async () => {
    const out = await resolveSpecialMentions('@Web @Terminal 看看', deps(true));
    expect(out.map((a) => a.name).sort()).toEqual(['@Terminal', '@Web']);
  });
});

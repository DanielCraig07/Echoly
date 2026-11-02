import { describe, it, expect } from 'vitest';
import {
  formatDocSourcesText,
  normalizeSourceUrl,
  parseDocSourcesText,
} from '../src/renderer/src/services/docSources';
import { buildDocsMentionContent } from '../src/renderer/src/services/webMention';

/**
 * 文档源的文本形态。
 *
 * 解析要宽容（全角竖线、漏名称、地址末尾多斜杠都很常见），
 * 但**宽容的边界必须明确**：地址解析不出来就得丢弃 —— 配了个错地址
 * 只会在检索时表现为「搜不到」，那是很难归因的故障。
 */

describe('parseDocSourcesText', () => {
  it('解析「名称|地址」', () => {
    expect(parseDocSourcesText('React|https://react.dev')).toEqual([
      { name: 'React', url: 'https://react.dev' },
    ]);
  });

  it('多行、空行与注释行', () => {
    const text = ['React|https://react.dev', '', '# 这是注释', 'Vite|https://vite.dev'].join('\n');
    expect(parseDocSourcesText(text).map((s) => s.name)).toEqual(['React', 'Vite']);
  });

  it('全角竖线也当分隔符（中文输入法下很容易打出来）', () => {
    expect(parseDocSourcesText('React｜https://react.dev')[0].name).toBe('React');
  });

  it('只写地址时用主机名当名称', () => {
    expect(parseDocSourcesText('https://react.dev')).toEqual([
      { name: 'react.dev', url: 'https://react.dev' },
    ]);
  });

  it('缺协议时补 https（用户写 react.dev 的直觉很自然）', () => {
    expect(parseDocSourcesText('React|react.dev')[0].url).toBe('https://react.dev');
  });

  it('末尾多余斜杠被去掉', () => {
    expect(parseDocSourcesText('React|https://react.dev///')[0].url).toBe('https://react.dev');
  });

  it('解析不出地址的行被丢弃，而不是留着一条坏配置', () => {
    expect(parseDocSourcesText('随便写点什么\nhttps://ok.dev')).toEqual([
      { name: 'ok.dev', url: 'https://ok.dev' },
    ]);
  });

  it('同一地址只保留一次', () => {
    expect(parseDocSourcesText('A|https://x.dev\nB|https://x.dev/')).toHaveLength(1);
  });

  it('多余的竖线让整行判为无效而被丢弃，而不是留下半截地址', () => {
    // 半截地址（比如只剩 "B"）会在检索时静默失效，比丢掉这一行难查得多。
    // 丢弃是安全的：用户点「检查」时会发现这一条没被收进去。
    expect(parseDocSourcesText('A|B|https://x.dev')).toEqual([]);
  });

  it('空文本得到空数组', () => {
    expect(parseDocSourcesText('')).toEqual([]);
    expect(parseDocSourcesText('   \n  ')).toEqual([]);
  });
});

describe('normalizeSourceUrl', () => {
  it('无点号的主机名判为无效（不是真实域名）', () => {
    expect(normalizeSourceUrl('localhost')).toBeNull();
  });

  it('合法地址规范化后不带尾斜杠', () => {
    expect(normalizeSourceUrl('https://x.dev/')).toBe('https://x.dev');
  });
});

describe('formatDocSourcesText', () => {
  it('与解析互为逆运算', () => {
    const sources = [
      { name: 'React', url: 'https://react.dev' },
      { name: 'Vite', url: 'https://vite.dev' },
    ];
    expect(parseDocSourcesText(formatDocSourcesText(sources))).toEqual(sources);
  });

  it('undefined 时返回空串', () => {
    expect(formatDocSourcesText(undefined)).toBe('');
  });
});

describe('buildDocsMentionContent', () => {
  it('列出已配置的来源，并指明用 search_docs / read_doc', () => {
    const text = buildDocsMentionContent([{ name: 'React', url: 'https://react.dev' }]);
    expect(text).toContain('search_docs');
    expect(text).toContain('read_doc');
    expect(text).toContain('React');
  });

  it('没配置来源时如实说明并指向设置页', () => {
    // 直接说「没配」比让模型去调一个没有来源的检索有用得多
    const text = buildDocsMentionContent([]);
    expect(text).toContain('尚未配置');
    expect(text).toContain('设置');
  });
});

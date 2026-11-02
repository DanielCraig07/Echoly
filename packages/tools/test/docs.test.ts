import { describe, expect, it } from 'vitest';
import {
  MAX_DOC_ENTRIES,
  parseLlmsTxt,
  scoreDocEntry,
  searchDocEntries,
  tokenizeDocQuery,
  type DocEntry,
} from '../src/docs.js';

/**
 * llms.txt 解析与文档打分。
 *
 * 这一层最容易出的错都**不会报错**：相对链接没解析（点进去 404）、
 * 中文没切词（怎么搜都是 0 条）、排序不稳定（同一个查询两次结果不同）。
 * 所以用例密度主要压在这三件事上。
 */

const SAMPLE = `# Acme Docs

> Acme 平台的官方文档，覆盖 API、CLI 与部署。

补充说明。

## 快速开始

- [Getting Started](https://docs.acme.dev/start): 五分钟跑通第一个请求
- [安装](https://docs.acme.dev/install)

## API 参考

- [认证](https://docs.acme.dev/auth): 令牌与签名规则
- [分页](/paging.md): 大结果集怎么翻页
`;

describe('parseLlmsTxt', () => {
  it('取出标题、简介与全部条目', () => {
    const index = parseLlmsTxt(SAMPLE, 'https://docs.acme.dev/llms.txt');
    expect(index.title).toBe('Acme Docs');
    expect(index.summary).toContain('Acme 平台的官方文档');
    expect(index.entries).toHaveLength(4);
  });

  it('条目带上所属小节', () => {
    const index = parseLlmsTxt(SAMPLE, 'https://docs.acme.dev/llms.txt');
    expect(index.entries[0]).toMatchObject({
      title: 'Getting Started',
      section: '快速开始',
      description: '五分钟跑通第一个请求',
    });
    expect(index.entries[3].section).toBe('API 参考');
  });

  it('相对链接按来源站解析成绝对地址', () => {
    // 不解析的话点进去就是 404，而且不会报错
    const index = parseLlmsTxt(SAMPLE, 'https://docs.acme.dev/llms.txt');
    expect(index.entries[3].url).toBe('https://docs.acme.dev/paging.md');
  });

  it('没有描述的条目不带 description 字段', () => {
    const index = parseLlmsTxt(SAMPLE, 'https://docs.acme.dev/llms.txt');
    expect(index.entries[1].description).toBeUndefined();
  });

  it('只认列表项，正文里的普通链接不会被当成条目', () => {
    const text = `# T\n\n正文里有 [一个链接](https://x.dev/a) 但不是列表项。\n\n- [真的是条目](https://x.dev/b)\n`;
    const index = parseLlmsTxt(text, 'https://x.dev/llms.txt');
    expect(index.entries.map((e) => e.title)).toEqual(['真的是条目']);
  });

  it('支持 * 作为列表符号', () => {
    const index = parseLlmsTxt('* [A](https://x.dev/a)\n', 'https://x.dev/llms.txt');
    expect(index.entries).toHaveLength(1);
  });

  it('条目数超过上限时截断（防止巨型清单撑爆内存与提示词）', () => {
    const lines = Array.from(
      { length: MAX_DOC_ENTRIES + 50 },
      (_, i) => `- [T${i}](https://x.dev/${i})`,
    );
    const index = parseLlmsTxt(`# T\n\n${lines.join('\n')}\n`, 'https://x.dev/llms.txt');
    expect(index.entries).toHaveLength(MAX_DOC_ENTRIES);
  });

  it('空文本与只有标题时不报错', () => {
    expect(parseLlmsTxt('', 'https://x.dev/llms.txt').entries).toEqual([]);
    const only = parseLlmsTxt('# T\n', 'https://x.dev/llms.txt');
    expect(only.entries).toEqual([]);
    expect(only.title).toBe('T');
  });

  it('基址不合法时保留原始链接，而不是抛错', () => {
    const index = parseLlmsTxt('- [A](/rel)\n', 'not-a-url');
    expect(index.entries[0].url).toBe('/rel');
  });
});

describe('tokenizeDocQuery', () => {
  it('英文按非字母数字切分', () => {
    expect(tokenizeDocQuery('getting started, v2')).toEqual(['getting', 'started', 'v2']);
  });

  it('中文按 2 字滑窗切分（不切就整句一个 token，永远匹配不上）', () => {
    expect(tokenizeDocQuery('认证方式')).toEqual(['认证', '证方', '方式']);
  });

  it('两字的中文词保持完整', () => {
    expect(tokenizeDocQuery('认证')).toEqual(['认证']);
  });

  it('忽略单字符英文与空白', () => {
    expect(tokenizeDocQuery('a  b')).toEqual([]);
  });
});

describe('searchDocEntries', () => {
  const entries: DocEntry[] = [
    {
      title: 'Getting Started',
      url: 'https://x.dev/start',
      description: '第一个请求',
      section: '快速开始',
    },
    { title: '认证', url: 'https://x.dev/auth', description: '令牌与签名', section: 'API 参考' },
    { title: '分页', url: 'https://x.dev/paging', description: '大结果集', section: 'API 参考' },
  ];

  it('标题命中排在前面', () => {
    const hits = searchDocEntries(entries, '认证');
    expect(hits[0].entry.title).toBe('认证');
  });

  it('中文查询能命中中文标题（滑窗切词的实际效果）', () => {
    expect(searchDocEntries(entries, '令牌').map((h) => h.entry.title)).toEqual(['认证']);
  });

  it('只返回有命中的条目，而不是凑一堆不相关的', () => {
    // 返回「都不太相关」的结果会让 Agent 以为真的没有匹配，放弃本来可行的检索
    expect(searchDocEntries(entries, '认证')).toHaveLength(1);
    expect(searchDocEntries(entries, 'zzzz')).toEqual([]);
  });

  it('标题整体命中压过只命中单个词', () => {
    const two: DocEntry[] = [
      { title: 'Getting Started', url: 'https://x.dev/a' },
      { title: 'Getting', url: 'https://x.dev/b' },
    ];
    expect(searchDocEntries(two, 'getting started')[0].entry.title).toBe('Getting Started');
  });

  it('结果稳定：同分时按标题排序，且两次调用一致', () => {
    const same: DocEntry[] = [
      { title: 'B', url: 'https://x.dev/b', description: '认证' },
      { title: 'A', url: 'https://x.dev/a', description: '认证' },
    ];
    const first = searchDocEntries(same, '认证').map((h) => h.entry.title);
    const second = searchDocEntries(same, '认证').map((h) => h.entry.title);
    expect(first).toEqual(second);
    expect(first).toEqual(['A', 'B']);
  });

  it('limit 生效，且空查询返回空', () => {
    expect(searchDocEntries(entries, '认证', 1)).toHaveLength(1);
    expect(searchDocEntries(entries, '   ')).toEqual([]);
  });
});

describe('scoreDocEntry', () => {
  it('无命中时为 0', () => {
    expect(scoreDocEntry({ title: 'A', url: 'https://x.dev/a' }, 'zzz', ['zzz'])).toBe(0);
  });

  it('URL 命中给的分比标题命中低', () => {
    const byTitle = scoreDocEntry({ title: 'auth', url: 'https://x.dev/z' }, 'auth', ['auth']);
    const byUrl = scoreDocEntry({ title: 'zzz', url: 'https://x.dev/auth' }, 'auth', ['auth']);
    expect(byTitle).toBeGreaterThan(byUrl);
  });
});

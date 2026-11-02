import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPEN_VSX_REGISTRY,
  MAX_MARKETPLACE_PAGE_SIZE,
  buildDownloadUrl,
  buildSearchUrl,
  isSafeExtensionId,
  normalizeRegistryBase,
  parseOpenVsxSearch,
} from '../src/openVsx';

/**
 * Open VSX 搜索结果解析。
 *
 * 两条最要紧的断言：
 * 1. **扩展 id 会变成文件路径的一部分**（`<id>.vsix`、解压到 `<id>/`），
 *    含 `../` 的 id 能把写入目标指到扩展目录之外，而 `unzip -o` 会照做。
 *    不合格的条目必须整条丢弃。
 * 2. 下载地址要取对字段 —— 取错不会报错，只会在解压时才发现拿到的是一个网页。
 */

const entry = (over: Record<string, unknown> = {}) => ({
  namespace: 'vscodevim',
  name: 'vim',
  version: '1.27.2',
  displayName: 'Vim',
  description: 'Vim emulation',
  files: {
    download: 'https://open-vsx.org/api/vscodevim/vim/1.27.2/file/vscodevim.vim-1.27.2.vsix',
  },
  downloadCount: 1200,
  averageRating: 4.5,
  ...over,
});

describe('normalizeRegistryBase', () => {
  it('空值退回默认注册表', () => {
    expect(normalizeRegistryBase()).toBe(DEFAULT_OPEN_VSX_REGISTRY);
    expect(normalizeRegistryBase('   ')).toBe(DEFAULT_OPEN_VSX_REGISTRY);
  });

  it('去掉尾斜杠，避免拼出 //api', () => {
    expect(normalizeRegistryBase('https://open-vsx.org/')).toBe('https://open-vsx.org');
    expect(normalizeRegistryBase('https://internal.example.com/vsx//')).toBe(
      'https://internal.example.com/vsx',
    );
  });
});

describe('buildSearchUrl', () => {
  it('带上查询串与分页参数', () => {
    const url = buildSearchUrl('https://open-vsx.org', 'python', 10);
    expect(url.startsWith('https://open-vsx.org/api/-/search?')).toBe(true);
    expect(url).toContain('query=python');
    expect(url).toContain('size=10');
  });

  it('关掉「包含全部历史版本」——否则十条里九条是同一个扩展的旧版本', () => {
    expect(buildSearchUrl('https://open-vsx.org', 'python')).toContain('includeAllVersions=false');
  });

  it('查询串被正确转义', () => {
    expect(buildSearchUrl('https://open-vsx.org', 'c++ & rust')).toContain('c%2B%2B');
  });

  it('页码上限防御性收敛', () => {
    expect(buildSearchUrl('https://open-vsx.org', 'x', 999)).toContain(
      `size=${MAX_MARKETPLACE_PAGE_SIZE}`,
    );
  });
});

describe('isSafeExtensionId', () => {
  it('接受正常的 namespace.name', () => {
    expect(isSafeExtensionId('vscodevim.vim')).toBe(true);
    expect(isSafeExtensionId('ms-python.python')).toBe(true);
  });

  it('拒绝任何含路径分隔符或上跳的 id', () => {
    // 这是本文件最重要的一条：不合格的 id 不能被拼进文件路径
    for (const bad of [
      '../../evil.x',
      'a/b.c',
      'a\\b.c',
      '..',
      './x',
      'a.b/c',
      'a.b/../c',
      '/abs.x',
      'C:\\x.y',
    ]) {
      expect(isSafeExtensionId(bad), bad).toBe(false);
    }
  });

  it('拒绝形状不对的 id', () => {
    for (const bad of ['', '.', 'abc', 'a.', '.b', 'a..b', 'a b.c', 'a.b c', '-a.b']) {
      expect(isSafeExtensionId(bad), bad).toBe(false);
    }
  });
});

describe('buildDownloadUrl', () => {
  it('优先用响应里给的下载地址', () => {
    expect(
      buildDownloadUrl('https://open-vsx.org', 'a', 'b', '1.0.0', 'https://cdn.example.com/x.vsix'),
    ).toBe('https://cdn.example.com/x.vsix');
  });

  it('缺失时按官方路径拼一个', () => {
    expect(buildDownloadUrl('https://open-vsx.org', 'a', 'b', '1.0.0')).toBe(
      'https://open-vsx.org/api/a/b/1.0.0/file/a.b-1.0.0.vsix',
    );
  });

  it('响应里给的不是 http(s) 地址时退回拼接', () => {
    expect(buildDownloadUrl('https://open-vsx.org', 'a', 'b', '1', 'javascript:alert(1)')).toBe(
      'https://open-vsx.org/api/a/b/1/file/a.b-1.vsix',
    );
  });
});

describe('parseOpenVsxSearch', () => {
  it('解析出规范化后的条目', () => {
    const [ext] = parseOpenVsxSearch({ extensions: [entry()] }, 'https://open-vsx.org');
    expect(ext).toMatchObject({
      id: 'vscodevim.vim',
      namespace: 'vscodevim',
      name: 'vim',
      displayName: 'Vim',
      version: '1.27.2',
      downloads: 1200,
      rating: 4.5,
    });
    expect(ext.downloadUrl).toContain('.vsix');
  });

  it('缺少 displayName 时退回 name', () => {
    const [ext] = parseOpenVsxSearch(
      { extensions: [entry({ displayName: undefined })] },
      'https://open-vsx.org',
    );
    expect(ext.displayName).toBe('vim');
  });

  it('**丢弃** id 不安全的条目，而不是清理后使用', () => {
    const payload = {
      extensions: [
        entry({ namespace: '../../..', name: 'evil' }),
        entry({ namespace: 'good', name: 'one' }),
      ],
    };
    const out = parseOpenVsxSearch(payload, 'https://open-vsx.org');
    expect(out.map((e) => e.id)).toEqual(['good.one']);
  });

  it('跳过字段缺失的条目，而不是整批失败', () => {
    // 注册表上确实存在字段不全的扩展，一条坏数据不该让整个搜索结果打不开
    const payload = {
      extensions: [entry({ version: '' }), entry({ namespace: '' }), entry({ name: 'ok' })],
    };
    const out = parseOpenVsxSearch(payload, 'https://open-vsx.org');
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('vscodevim.ok');
  });

  it('畸形输入返回空数组而不抛错', () => {
    for (const bad of [null, undefined, 42, 'x', {}, { extensions: 'nope' }, { extensions: [1] }]) {
      expect(() => parseOpenVsxSearch(bad, 'https://open-vsx.org')).not.toThrow();
      expect(parseOpenVsxSearch(bad, 'https://open-vsx.org')).toEqual([]);
    }
  });

  it('没有下载地址时也能拼出来（不因为缺字段丢掉整条）', () => {
    const [ext] = parseOpenVsxSearch(
      { extensions: [entry({ files: {} })] },
      'https://open-vsx.org',
    );
    expect(ext.downloadUrl).toBe(
      'https://open-vsx.org/api/vscodevim/vim/1.27.2/file/vscodevim.vim-1.27.2.vsix',
    );
  });
});

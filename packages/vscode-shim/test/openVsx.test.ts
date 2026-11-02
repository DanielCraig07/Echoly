import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPEN_VSX_REGISTRY,
  DEFAULT_RECOMMENDED_SIZE,
  MAX_MARKETPLACE_PAGE_SIZE,
  buildDownloadUrl,
  buildRecommendedUrl,
  buildSearchUrl,
  isAllowedIconUrl,
  isPlatformAgnosticDownload,
  isSafeExtensionId,
  normalizeRegistryBase,
  parseOpenVsxSearch,
  parseTargetPlatform,
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

  it('平台专属扩展必须原样用注册表的下载地址，不能按通用规则重拼', () => {
    // 真实数据：ms-python.debugpy 的下载地址里有一段平台路径（darwin-arm64），
    // 而通用规则拼出来的是 `<ns>.<name>-<version>.vsix` —— 少了那段平台路径，
    // 拼出来的地址在注册表上是 404（要到解压时才发现拿到的是错误页）。
    const platformUrl =
      'https://open-vsx.org/api/ms-python/debugpy/darwin-arm64/2026.6.0/file/ms-python.debugpy-2026.6.0@darwin-arm64.vsix';
    const [ext] = parseOpenVsxSearch(
      {
        extensions: [
          entry({
            namespace: 'ms-python',
            name: 'debugpy',
            version: '2026.6.0',
            files: { download: platformUrl },
          }),
        ],
      },
      'https://open-vsx.org',
    );
    expect(ext.downloadUrl).toBe(platformUrl);
  });

  it('files.download 不是绝对 http(s) 地址时退回拼接（相对路径别塞进 fetch）', () => {
    for (const bad of ['/api/x/y/1/file/x.vsix', 'file:///tmp/x.vsix', 42, null]) {
      expect(buildDownloadUrl('https://open-vsx.org', 'ns', 'n', '1.0.0', bad)).toBe(
        'https://open-vsx.org/api/ns/n/1.0.0/file/ns.n-1.0.0.vsix',
      );
    }
  });
});

describe('buildRecommendedUrl', () => {
  it('空 query + 按下载量倒序 —— 「推荐」要的是最热门的几个', () => {
    const url = buildRecommendedUrl('https://open-vsx.org');
    expect(url).toContain('query=&');
    expect(url).toContain('sortBy=downloadCount');
    expect(url).toContain('sortOrder=desc');
    expect(url).toContain(`size=${DEFAULT_RECOMMENDED_SIZE}`);
  });

  it('普通搜索不带排序参数：用户敲了关键词就该按相关度走', () => {
    const url = buildSearchUrl('https://open-vsx.org', 'python');
    expect(url).not.toContain('sortBy=');
  });

  it('自定义注册表同样生效（内网镜像要能对齐）', () => {
    expect(buildRecommendedUrl('https://internal.example.com/vsx')).toContain(
      'https://internal.example.com/vsx/api/-/search?',
    );
  });
});

describe('平台构建识别', () => {
  it('从注册表给的文件名后缀里读出平台', () => {
    expect(
      parseTargetPlatform(
        'https://open-vsx.org/api/ms-python/debugpy/darwin-arm64/2026.6.0/file/ms-python.debugpy-2026.6.0@darwin-arm64.vsix',
      ),
    ).toBe('darwin-arm64');
  });

  it('通用构建没有平台后缀', () => {
    expect(
      parseTargetPlatform(
        'https://open-vsx.org/api/ms-python/python/2026.4.0/file/ms-python.python-2026.4.0.vsix',
      ),
    ).toBeUndefined();
    expect(
      isPlatformAgnosticDownload(
        'https://open-vsx.org/api/ms-python/python/2026.4.0/file/ms-python.python-2026.4.0.vsix',
      ),
    ).toBe(true);
  });

  it('平台构建不算通用构建', () => {
    expect(
      isPlatformAgnosticDownload(
        'https://open-vsx.org/api/Anthropic/claude-code/2.1.316/file/Anthropic.claude-code-2.1.316@alpine-arm64.vsix',
      ),
    ).toBe(false);
  });

  it('查询串不干扰后缀解析', () => {
    expect(
      parseTargetPlatform('https://open-vsx.org/api/x/y/1/file/x.y-1@linux-x64.vsix?token=abc'),
    ).toBe('linux-x64');
  });

  it('解析结果进到 MarketplaceExtension 上，供渲染层标注', () => {
    const [ext] = parseOpenVsxSearch(
      {
        extensions: [
          entry({
            files: {
              download:
                'https://open-vsx.org/api/ms-python/debugpy/darwin-arm64/2026.6.0/file/ms-python.debugpy-2026.6.0@darwin-arm64.vsix',
            },
          }),
        ],
      },
      'https://open-vsx.org',
    );
    expect(ext.targetPlatform).toBe('darwin-arm64');
  });
});

describe('isAllowedIconUrl', () => {
  it('只放行配置的那个注册表上的图标', () => {
    expect(
      isAllowedIconUrl('https://open-vsx.org', 'https://open-vsx.org/api/x/y/1/file/i.png'),
    ).toBe(true);
    expect(isAllowedIconUrl('https://open-vsx.org', 'https://evil.example.com/i.png')).toBe(false);
  });

  it('挡住非 http(s) 协议', () => {
    // file:// 读本地文件、data: 塞超长内容，都不该从「图标地址」这个入口进来
    expect(isAllowedIconUrl('https://open-vsx.org', 'file:///etc/passwd')).toBe(false);
    expect(isAllowedIconUrl('https://open-vsx.org', 'data:image/png;base64,AAAA')).toBe(false);
  });

  it('内网镜像的图标同样放行（origin 相同即可）', () => {
    expect(
      isAllowedIconUrl(
        'https://internal.example.com/vsx/',
        'https://internal.example.com/vsx/i.png',
      ),
    ).toBe(true);
    // 同一个主机但换了端口 = 换了 origin，仍然拒绝
    expect(
      isAllowedIconUrl('https://internal.example.com', 'https://internal.example.com:8443/i.png'),
    ).toBe(false);
  });

  it('空值与非字符串直接拒绝', () => {
    for (const bad of ['', null, undefined, 42, {}]) {
      expect(isAllowedIconUrl('https://open-vsx.org', bad)).toBe(false);
    }
  });
});

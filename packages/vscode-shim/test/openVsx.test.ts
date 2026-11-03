import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPEN_VSX_REGISTRY,
  DEFAULT_RECOMMENDED_SIZE,
  MAX_MARKETPLACE_PAGE_SIZE,
  buildDetailUrl,
  buildDownloadUrl,
  decidePlatformDownload,
  buildReadmeCandidates,
  buildReadmeUrl,
  buildRecommendedUrl,
  buildSearchUrl,
  parseOpenVsxDetail,
  splitExtensionId,
  isAllowedIconUrl,
  isPlatformAgnosticDownload,
  isSafeExtensionId,
  normalizeRegistryBase,
  parseOpenVsxSearch,
  parseTargetPlatform,
  registryTargetPlatform,
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

describe('详情解析（parseOpenVsxDetail / buildReadmeUrl / splitExtensionId）', () => {
  const detailPayload = {
    ...entry({
      files: { download: 'https://open-vsx.org/api/vscodevim/vim/1.27.2/file/vim.vsix' },
    }),
    timestamp: '2025-12-14T23:05:07.638873Z',
    license: 'MIT',
    repository: 'https://github.com/VSCodeVim/Vim.git',
    bugs: 'https://github.com/VSCodeVim/Vim/issues',
    categories: ['Programming Languages', 'Other'],
    reviewCount: 24,
    verified: true,
    engines: { vscode: '^1.70.0' },
    downloadSizes: { universal: 6826731, 'darwin-arm64': 999 },
  };

  it('认得出详情多出来的那些字段', () => {
    const d = parseOpenVsxDetail(detailPayload, 'https://open-vsx.org');
    expect(d).not.toBeNull();
    expect(d!.license).toBe('MIT');
    expect(d!.categories).toEqual(['Programming Languages', 'Other']);
    expect(d!.reviewCount).toBe(24);
    expect(d!.verified).toBe(true);
    expect(d!.engines).toEqual({ vscode: '^1.70.0' });
  });

  it('体积取通用构建，而不是随机取一个平台包', () => {
    const d = parseOpenVsxDetail(detailPayload, 'https://open-vsx.org');
    expect(d!.size).toBe(6826731);
  });

  it('解析不了时返回 null（调用方用列表那一份兜底）', () => {
    expect(parseOpenVsxDetail(null, 'https://open-vsx.org')).toBeNull();
    expect(parseOpenVsxDetail({}, 'https://open-vsx.org')).toBeNull();
    // id 不合法 → 整条丢弃，与搜索解析同一套防线
    expect(
      parseOpenVsxDetail({ ...detailPayload, namespace: '../evil' }, 'https://open-vsx.org'),
    ).toBeNull();
  });

  it('splitExtensionId 挡掉会把路径带出去的 id', () => {
    expect(splitExtensionId('ms-python.python')).toEqual({
      namespace: 'ms-python',
      name: 'python',
    });
    expect(splitExtensionId('../../etc.passwd')).toBeNull();
  });

  it('README 地址由校验过的 id 与版本拼出来', () => {
    expect(buildReadmeUrl('https://open-vsx.org', 'ms-python.python', '2026.4.0')).toBe(
      'https://open-vsx.org/api/ms-python/python/2026.4.0/file/README.md',
    );
  });

  it('详情里的 files.readme 会被收下（平台专属扩展唯一的正确地址）', () => {
    const d = parseOpenVsxDetail(
      entry({
        files: {
          download:
            'https://open-vsx.org/api/Anthropic/claude-code/alpine-arm64/2.1.317/file/a.vsix',
          readme:
            'https://open-vsx.org/api/Anthropic/claude-code/alpine-arm64/2.1.317/file/README.md',
        },
      }),
      'https://open-vsx.org',
    );
    expect(d!.readmeUrl).toBe(
      'https://open-vsx.org/api/Anthropic/claude-code/alpine-arm64/2.1.317/file/README.md',
    );
  });

  it('别处的 files.readme 一律不收（主进程要照着它去 fetch）', () => {
    const d = parseOpenVsxDetail(
      entry({ files: { readme: 'https://evil.example.com/README.md' } }),
      'https://open-vsx.org',
    );
    expect(d!.readmeUrl).toBeUndefined();
  });

  /**
   * 这三条候选是**实跑 open-vsx.org 得出的**（2026-11）：
   * `Anthropic.claude-code` 的 `/2.1.317/file/README.md` 是 404，
   * 平台路径那条与 `/latest/file/README.md` 都是 200。
   * 详情页原来只拼版本号那条，于是「注册表没有提供这个扩展的说明文档」。
   */
  it('候选顺序：注册表给的 → 版本号 → latest', () => {
    expect(
      buildReadmeCandidates(
        'https://open-vsx.org',
        'Anthropic.claude-code',
        '2.1.317',
        'https://open-vsx.org/api/Anthropic/claude-code/alpine-arm64/2.1.317/file/README.md',
      ),
    ).toEqual([
      'https://open-vsx.org/api/Anthropic/claude-code/alpine-arm64/2.1.317/file/README.md',
      'https://open-vsx.org/api/Anthropic/claude-code/2.1.317/file/README.md',
      'https://open-vsx.org/api/Anthropic/claude-code/latest/file/README.md',
    ]);
  });

  it('没有 files.readme 时退到版本号 + latest，且不重复', () => {
    expect(buildReadmeCandidates('https://open-vsx.org', 'ms-python.python', '2026.4.0')).toEqual([
      'https://open-vsx.org/api/ms-python/python/2026.4.0/file/README.md',
      'https://open-vsx.org/api/ms-python/python/latest/file/README.md',
    ]);
    // 本身就在 latest 上时不该再拼一条一模一样的
    expect(buildReadmeCandidates('https://open-vsx.org', 'ms-python.python', 'latest')).toEqual([
      'https://open-vsx.org/api/ms-python/python/latest/file/README.md',
    ]);
  });

  it('候选里不收别处的地址（origin 再核一遍）', () => {
    expect(
      buildReadmeCandidates(
        'https://open-vsx.org',
        'ms-python.python',
        '2026.4.0',
        'https://evil.example.com/README.md',
      ),
    ).toEqual([
      'https://open-vsx.org/api/ms-python/python/2026.4.0/file/README.md',
      'https://open-vsx.org/api/ms-python/python/latest/file/README.md',
    ]);
  });
});

/**
 * 平台专属构建的定位。
 *
 * 现场：搜索接口**不返回** `targetPlatform`（实测是 null），但 `files.download` 的
 * 文件名里带着平台后缀 —— Claude Code 是 `…@alpine-arm64.vsix`。
 * 于是搜索结果那一行的「安装」会下一个给 Alpine（musl）用的包，
 * 而用户可能正在 macOS 上点它。
 * 这两条钉住「怎么认出本机平台」和「怎么问注册表要那一份」。
 */
describe('平台专属构建（registryTargetPlatform / buildDetailUrl）', () => {
  it('认识注册表那套 os-arch 命名', () => {
    expect(registryTargetPlatform('darwin', 'arm64')).toBe('darwin-arm64');
    expect(registryTargetPlatform('win32', 'x64')).toBe('win32-x64');
    expect(registryTargetPlatform('linux', 'arm64')).toBe('linux-arm64');
  });

  it('认不出来就返回 undefined —— 不猜一个平台出来', () => {
    expect(registryTargetPlatform('freebsd', 'x64')).toBeUndefined();
    expect(registryTargetPlatform('darwin', 'ia32')).toBeUndefined();
  });

  it('认出「这份是给别的平台的」，该去问本机那一份', () => {
    // 现场：搜索接口不返回 targetPlatform，Claude Code 的 files.download 是 alpine 那一份
    const alpine =
      'https://open-vsx.org/api/Anthropic/claude-code/alpine-arm64/2.1.317/file/Anthropic.claude-code-2.1.317@alpine-arm64.vsix';
    expect(decidePlatformDownload(alpine, 'darwin', 'arm64')).toEqual({
      kind: 'needs-local-build',
      wantedPlatform: 'darwin-arm64',
      givenPlatform: 'alpine-arm64',
    });
    // 本来就是本机那一份：不动
    const darwin = alpine.replace(/alpine-arm64/g, 'darwin-arm64');
    expect(decidePlatformDownload(darwin, 'darwin', 'arm64')).toEqual({ kind: 'as-is' });
    // 通用构建：不动（绝大多数扩展都是这一类）
    expect(
      decidePlatformDownload(
        'https://open-vsx.org/api/vscodevim/vim/1.27.2/file/vim.vsix',
        'darwin',
        'arm64',
      ),
    ).toEqual({ kind: 'as-is' });
    // 认不出本机平台：也不动 —— 不猜
    expect(decidePlatformDownload(alpine, 'freebsd', 'x64')).toEqual({ kind: 'unknown-platform' });
  });

  it('带平台段时是那一个平台的详情地址', () => {
    expect(buildDetailUrl('https://open-vsx.org', 'Anthropic.claude-code', 'darwin-arm64')).toBe(
      'https://open-vsx.org/api/Anthropic/claude-code/darwin-arm64',
    );
    // 不带平台段就是原来的默认详情地址
    expect(buildDetailUrl('https://open-vsx.org/', 'ms-python.python')).toBe(
      'https://open-vsx.org/api/ms-python/python',
    );
  });
});

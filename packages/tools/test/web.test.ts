import { describe, expect, it } from 'vitest';
import {
  DEFAULT_URL_POLICY,
  decodeEntities,
  htmlToMarkdown,
  isHostAllowedByList,
  isPrivateHostname,
  parseDuckDuckGoHtml,
  truncateUtf8,
  validateFetchUrl,
} from '../src/web.js';

describe('validateFetchUrl', () => {
  it('放行普通的 https 地址', () => {
    const result = validateFetchUrl('https://react.dev/reference/react/use');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url.hostname).toBe('react.dev');
  });

  it.each([
    ['file:///etc/passwd', 'file:'],
    ['javascript:alert(1)', 'javascript:'],
    ['data:text/html,<h1>x</h1>', 'data:'],
    ['ftp://example.com/a', 'ftp:'],
  ])('拒绝非 http/https 协议：%s', (input, protocol) => {
    const result = validateFetchUrl(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(protocol);
  });

  it.each([
    'http://127.0.0.1:8080/admin',
    'http://localhost/secret',
    'http://192.168.10.241:1333/v1/models',
    'http://10.0.0.5/',
    'http://169.254.169.254/latest/meta-data/',
    'http://172.16.1.1/',
    'http://[::1]/',
  ])('默认拦截私有与回环地址：%s', (input) => {
    const result = validateFetchUrl(input);
    expect(result.ok).toBe(false);
  });

  it('显式放开后才允许私有地址（内网文档站场景）', () => {
    const result = validateFetchUrl('http://192.168.10.241:1333/wiki', {
      ...DEFAULT_URL_POLICY,
      allowPrivateHosts: true,
    });
    expect(result.ok).toBe(true);
  });

  it('空串与不可解析的地址给出明确原因', () => {
    expect(validateFetchUrl('').ok).toBe(false);
    const bad = validateFetchUrl('not a url');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain('无法解析');
  });

  it('内网白名单放行命中的私有地址', () => {
    const policy = {
      ...DEFAULT_URL_POLICY,
      allowedPrivateHosts: ['wiki.corp.local', '192.168.10.241'],
    };
    expect(validateFetchUrl('http://wiki.corp.local/docs', policy).ok).toBe(true);
    expect(validateFetchUrl('http://192.168.10.241:1333/wiki', policy).ok).toBe(true);
  });

  it('白名单只覆盖命中的主机，其余私有地址照旧拦截', () => {
    const policy = { ...DEFAULT_URL_POLICY, allowedPrivateHosts: ['wiki.corp.local'] };
    expect(validateFetchUrl('http://other.corp.local/', policy).ok).toBe(false);
    expect(validateFetchUrl('http://192.168.10.9/', policy).ok).toBe(false);
  });

  it('白名单不影响公网地址的判断', () => {
    const policy = { ...DEFAULT_URL_POLICY, allowedPrivateHosts: ['wiki.corp.local'] };
    expect(validateFetchUrl('https://react.dev/', policy).ok).toBe(true);
  });
});

describe('isHostAllowedByList', () => {
  it('空清单不放行任何主机', () => {
    expect(isHostAllowedByList('wiki.corp.local', [])).toBe(false);
    expect(isHostAllowedByList('wiki.corp.local', undefined)).toBe(false);
  });

  it('支持子域匹配，且不误伤形近域名', () => {
    expect(isHostAllowedByList('wiki.corp.local', ['corp.local'])).toBe(true);
    expect(isHostAllowedByList('a.b.corp.local', ['corp.local'])).toBe(true);
    expect(isHostAllowedByList('evilcorp.local', ['corp.local'])).toBe(false);
  });

  it('容忍从地址栏粘进来的整条 URL 与端口', () => {
    expect(isHostAllowedByList('wiki.corp.local', ['https://wiki.corp.local/docs?x=1'])).toBe(true);
    expect(isHostAllowedByList('wiki.corp.local', ['wiki.corp.local:8080'])).toBe(true);
  });

  it('大小写与 IPv6 方括号归一化', () => {
    expect(isHostAllowedByList('WIKI.CORP.LOCAL', ['wiki.corp.local'])).toBe(true);
    expect(isHostAllowedByList('fd00::1', ['[fd00::1]'])).toBe(true);
  });
});

describe('isPrivateHostname', () => {
  it('识别常见私有网段与回环', () => {
    expect(isPrivateHostname('localhost')).toBe(true);
    expect(isPrivateHostname('127.0.0.1')).toBe(true);
    expect(isPrivateHostname('172.31.255.254')).toBe(true);
    expect(isPrivateHostname('172.32.0.1')).toBe(false); // 172.32 已出私有段
    expect(isPrivateHostname('example.com')).toBe(false);
  });
});

describe('htmlToMarkdown', () => {
  it('丢弃 script / style / nav 等噪声', () => {
    const html = `
      <html><head><style>body{color:red}</style></head>
      <body>
        <nav>首页 | 文档</nav>
        <p>正文段落</p>
        <script>console.log('x')</script>
        <footer>版权</footer>
      </body></html>`;
    const md = htmlToMarkdown(html);
    expect(md).toContain('正文段落');
    expect(md).not.toContain('console.log');
    expect(md).not.toContain('color:red');
    expect(md).not.toContain('首页');
    expect(md).not.toContain('版权');
  });

  it('把标题、列表、强调与行内代码映射成 Markdown', () => {
    const md = htmlToMarkdown(
      '<h2>标题</h2><ul><li>甲</li><li>乙</li></ul><p><strong>粗</strong>与<em>斜</em>与<code>a+b</code></p>',
    );
    expect(md).toContain('## 标题');
    expect(md).toContain('- 甲');
    expect(md).toContain('- 乙');
    expect(md).toContain('**粗**');
    expect(md).toContain('*斜*');
    expect(md).toContain('`a+b`');
  });

  it('代码块保留尖括号原文', () => {
    const md = htmlToMarkdown('<pre><code>if (a &lt; b) { return c &gt; d; }</code></pre>');
    expect(md).toContain('```');
    expect(md).toContain('if (a < b) { return c > d; }');
  });

  it('相对链接按 baseUrl 补成绝对地址', () => {
    const md = htmlToMarkdown('<a href="/docs/start">开始</a>', {
      baseUrl: 'https://example.com/guide/',
    });
    expect(md).toBe('[开始](https://example.com/docs/start)');
  });

  it('没有 baseUrl 时保留原始 href', () => {
    const md = htmlToMarkdown('<a href="./a.html">甲</a>');
    expect(md).toBe('[甲](./a.html)');
  });

  it('压缩连续空行', () => {
    const md = htmlToMarkdown('<p>甲</p><p></p><p></p><p>乙</p>');
    expect(md).not.toMatch(/\n{3,}/);
    expect(md).toContain('甲');
    expect(md).toContain('乙');
  });
});

describe('decodeEntities', () => {
  it('解码命名实体与数字实体', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &#65; &#x42;')).toBe('a & b <c> A B');
  });

  it('保留无法识别的实体原文', () => {
    expect(decodeEntities('&unknownentity;')).toBe('&unknownentity;');
  });
});

describe('truncateUtf8', () => {
  it('未超限时原样返回', () => {
    expect(truncateUtf8('你好', 100)).toBe('你好');
  });

  it('按字节截断且不切出半个汉字', () => {
    const long = '中'.repeat(10); // 每个汉字 3 字节
    const out = truncateUtf8(long, 7);
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(7);
    expect(out).toBe('中中');
  });

  it('不切在代理对中间（emoji）', () => {
    const out = truncateUtf8('🙂🙂🙂', 5);
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(5);
    expect(out).toBe('🙂');
  });
});

describe('parseDuckDuckGoHtml', () => {
  const fixture = `
    <div class="result">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freact.dev%2Freference%2Freact%2Fuse&rut=abc">React use &amp; 用法</a>
      <a class="result__snippet">在组件里读取 Promise 或 Context 的值。</a>
    </div>
    <div class="result">
      <a rel="nofollow" class="result__a" href="https://developer.mozilla.org/zh-CN/docs/Web/API">MDN Web API</a>
      <a class="result__snippet">Web 平台接口参考。</a>
    </div>`;

  it('还原被包裹的真实目标地址', () => {
    const hits = parseDuckDuckGoHtml(fixture);
    expect(hits[0].url).toBe('https://react.dev/reference/react/use');
    expect(hits[1].url).toBe('https://developer.mozilla.org/zh-CN/docs/Web/API');
  });

  it('清洗标题里的实体与空白', () => {
    const hits = parseDuckDuckGoHtml(fixture);
    expect(hits[0].title).toBe('React use & 用法');
  });

  it('按顺序对齐摘要', () => {
    const hits = parseDuckDuckGoHtml(fixture);
    expect(hits[0].snippet).toContain('Promise');
    expect(hits[1].snippet).toContain('Web 平台接口');
  });

  it('遵守条数上限', () => {
    expect(parseDuckDuckGoHtml(fixture, 1)).toHaveLength(1);
  });

  it('结构不认识时返回空数组而不是抛错', () => {
    expect(parseDuckDuckGoHtml('<html><body>改版了</body></html>')).toEqual([]);
    expect(parseDuckDuckGoHtml('')).toEqual([]);
  });
});

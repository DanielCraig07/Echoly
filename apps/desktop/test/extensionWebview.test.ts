import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import {
  EXTENSION_WEBVIEW_SCHEME,
  buildWebviewOrigin,
  buildWebviewUrl,
  parseWebviewRequest,
  resolveWebviewFilePath,
  toWebviewResourcePath,
} from '../src/main/extensionWebview';

/**
 * 扩展 webview 的地址规则。
 *
 * 这套规则是被一个真实故障逼出来的：Claude Code 的面板在界面里报
 * 「webview/index.js could not be fetched」。两个原因叠在一起 ——
 * 扩展的 bundle 是 `<script type="module">`（Chromium 禁止从 `file://` 加载），
 * 而 URL 里的空格也没有编码。所以这里钉的是三件事：
 *
 * 1. 拼出来的地址必须能原样解析回来（含驼峰 viewId、含空格的相对路径）；
 * 2. 视图 id 走**路径**而不是主机名（主机名会被小写化，`claudeVSCodeSidebar` 会废）；
 * 3. 相对路径不许爬出扩展目录。
 */
describe('扩展 webview 地址', () => {
  const root =
    '/Users/daniel/Library/Application Support/Echoly/extensions/Anthropic.claude-code/extension';

  it('origin 是固定的，与视图 id 无关（CSP 的 self 指的就是它）', () => {
    expect(buildWebviewOrigin()).toBe(`${EXTENSION_WEBVIEW_SCHEME}://ext`);
  });

  it('驼峰 viewId 走了路径，所以没有被 URL 小写化', () => {
    const url = buildWebviewUrl('claudeVSCodeSidebar', 'webview/index.js');
    expect(url).toBe('echoly-webview://ext/claudeVSCodeSidebar/webview/index.js');
    expect(parseWebviewRequest(url)).toEqual({
      viewId: 'claudeVSCodeSidebar',
      relPath: 'webview/index.js',
    });
  });

  it('路径里的空格被编码（macOS 的 Application Support）', () => {
    const rel = toWebviewResourcePath(root, path.join(root, 'webview', 'index.css'));
    // 扩展目录本身含空格，但相对路径不含 —— 相对路径是相对那棵根算的
    expect(rel).toBe('webview/index.css');
    const url = buildWebviewUrl('v', 'a b/c-d.js');
    expect(url).toBe('echoly-webview://ext/v/a%20b/c-d.js');
    expect(parseWebviewRequest(url)).toEqual({ viewId: 'v', relPath: 'a b/c-d.js' });
  });

  it('扩展目录内的文件 → 相对路径；目录外 → -/abs/，且能解析回原路径', () => {
    const inside = toWebviewResourcePath(root, `${root}/webview/index.js`);
    expect(inside).toBe('webview/index.js');

    const outsidePath = '/tmp/some other/logo.svg';
    const outside = toWebviewResourcePath(root, outsidePath);
    expect(outside.startsWith('-/abs/')).toBe(true);
    // -/abs/ 那一支不受目录约束，解析回来必须还是原路径（含空格）
    expect(resolveWebviewFilePath(root, outside)).toBe(outsidePath);
    expect(parseWebviewRequest(buildWebviewUrl('v', outside))).toEqual({
      viewId: 'v',
      relPath: outside,
    });
  });

  it('挡住目录穿越（同一页面的脚本能发任意请求，这不是走过场）', () => {
    expect(resolveWebviewFilePath(root, '../../../../../../etc/passwd')).toBeNull();
    expect(resolveWebviewFilePath(root, 'webview/../../../secret')).toBeNull();
    // 正常路径不受影响
    expect(resolveWebviewFilePath(root, 'webview/index.js')).toBe(`${root}/webview/index.js`);
  });

  it('不是本协议 / 形状不对的请求一律返回 null，由调用方回 4xx', () => {
    expect(parseWebviewRequest('file:///etc/passwd')).toBeNull();
    expect(parseWebviewRequest('https://example.com/a/b')).toBeNull();
    expect(parseWebviewRequest('echoly-webview://other-host/a/b')).toBeNull();
    expect(parseWebviewRequest('echoly-webview://ext/onlyviewid')).toBeNull();
    expect(parseWebviewRequest('::not a url::')).toBeNull();
  });

  it('真实扩展目录里的 bundle 能被解析到（装了 Claude Code 才有断言）', () => {
    const bundle = path.join(root, 'webview', 'index.js');
    if (!existsSync(bundle)) {
      // 没装过这个扩展的环境跳过 —— 这条断言只在它存在时才有意义
      return;
    }
    const rel = toWebviewResourcePath(root, bundle);
    expect(resolveWebviewFilePath(root, rel)).toBe(bundle);
  });
});

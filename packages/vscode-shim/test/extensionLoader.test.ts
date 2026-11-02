import { describe, expect, it } from 'vitest';
import {
  CLAUDE_CODE_MIN_BYTES,
  DOWNLOAD_MIN_BYTES,
  buildCurlArgs,
  validateVsix,
} from '../src/extensionLoader';

/**
 * 下载结果的校验与 curl 参数。
 *
 * 这两件事原先**一条测试都没有**，于是藏着一个相当严重的回归：
 * 通用下载器里留着「Claude Code 至少 50MB」这条判据，结果从扩展市场安装
 * 任何小于 50MB 的扩展都会失败 —— 而绝大多数扩展都远小于 50MB
 * （实测 `vscodevim.vim` 只有 693KB）。搜索能出结果、下载也能完成，
 * 最后一句话「文件太小」把人劝退。
 *
 * 所以这里的重点不是「函数返回值对不对」，而是把这条边界钉死：
 * **通用路径不能带特定扩展的体积假设。**
 */

const ZIP_HEADER = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
const HTML_HEADER = new Uint8Array([0x3c, 0x21, 0x44, 0x4f]); // "<!DO"

describe('validateVsix', () => {
  it('接受一个正常的小扩展（市场里绝大多数都这么大）', () => {
    // 实测 vscodevim.vim 1.27.2 = 709567 字节
    expect(
      validateVsix({ size: 709_567, header: ZIP_HEADER, minBytes: DOWNLOAD_MIN_BYTES }),
    ).toEqual({ ok: true });
  });

  it('接受一个上百 MB 的包（Claude Code 那种）', () => {
    expect(
      validateVsix({
        size: 122 * 1024 * 1024,
        header: ZIP_HEADER,
        minBytes: CLAUDE_CODE_MIN_BYTES,
      }),
    ).toEqual({ ok: true });
  });

  it('把「50MB 下限」限制在 Claude Code 自己的调用上，而不是通用路径', () => {
    // 同一个小扩展：用通用下限应通过，用 Claude Code 的下限应被拒 ——
    // 以前这两种情形共用了一条判据，所以后者把前者也拒了
    const size = 709_567;
    expect(validateVsix({ size, header: ZIP_HEADER, minBytes: DOWNLOAD_MIN_BYTES }).ok).toBe(true);
    const strict = validateVsix({ size, header: ZIP_HEADER, minBytes: CLAUDE_CODE_MIN_BYTES });
    expect(strict.ok).toBe(false);
    if (!strict.ok) expect(strict.reason).toContain('太小');
  });

  it('拒绝空文件与体积不足的文件（错误页常是几百字节）', () => {
    expect(validateVsix({ size: 0, header: ZIP_HEADER, minBytes: DOWNLOAD_MIN_BYTES }).ok).toBe(
      false,
    );
    expect(validateVsix({ size: 512, header: HTML_HEADER, minBytes: DOWNLOAD_MIN_BYTES }).ok).toBe(
      false,
    );
  });

  it('拒绝不是 ZIP 的文件（HTTP 错误页被存成 .vsix）', () => {
    const verdict = validateVsix({
      size: 100_000,
      header: HTML_HEADER,
      minBytes: DOWNLOAD_MIN_BYTES,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('ZIP');
  });

  it('文件头读不满 4 字节时判为不完整', () => {
    expect(
      validateVsix({ size: 100_000, header: new Uint8Array([0x50, 0x4b]), minBytes: 1024 }).ok,
    ).toBe(false);
  });

  it('体积不是有限数时判为失败（statt 拿到 NaN 不该静默通过）', () => {
    expect(validateVsix({ size: Number.NaN, header: ZIP_HEADER, minBytes: 1 }).ok).toBe(false);
  });
});

describe('buildCurlArgs', () => {
  it('带上针对大文件断流的参数', () => {
    const args = buildCurlArgs({ downloadUrl: 'https://example.com/a.vsix', vsixPath: '/tmp/a' });
    // 一百多 MB 走 HTTP/2 被 CDN 中途 CANCEL（curl 退出码 92）是这次的现场原因
    expect(args).toContain('--http1.1');
    // HTTP 错误要失败，而不是把错误页写进 .vsix
    expect(args).toContain('-f');
    expect(args).toContain('-L');
    // 让 curl 自己重试瞬时断流，比外层「删掉重下」便宜得多
    expect(args).toContain('--retry');
    expect(args).toContain('--retry-all-errors');
    expect(args.join(' ')).toContain('https://example.com/a.vsix');
    expect(args[args.length - 2]).toBe('-o');
    expect(args[args.length - 1]).toBe('/tmp/a');
  });

  it('默认不续传，重试时才加 -C -', () => {
    const plain = buildCurlArgs({ downloadUrl: 'u', vsixPath: 'p' });
    expect(plain).not.toContain('-C');
    const resume = buildCurlArgs({ downloadUrl: 'u', vsixPath: 'p', resume: true });
    expect(resume).toContain('-C');
    expect(resume.join(' ')).toContain('-C -');
  });
});

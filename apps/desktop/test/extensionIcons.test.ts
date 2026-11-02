import { describe, expect, it } from 'vitest';
import { MAX_ICON_BYTES, isImageContentType, toIconDataUrl } from '../src/main/extensionIcons';

/**
 * 图标转 data URL 的两条边界：**类型**与**体积**。
 *
 * 这两条都是「不检查也不报错，只是在界面上显示一个破图」的那种问题 ——
 * 注册表返回 HTML 错误页时状态码可能是 200，直接转成 data URL 就是一张碎图。
 */

const png = (n: number) => new Uint8Array(n).fill(7);

describe('isImageContentType', () => {
  it('只认 image/*', () => {
    expect(isImageContentType('image/png')).toBe(true);
    expect(isImageContentType('IMAGE/PNG')).toBe(true);
    expect(isImageContentType('  image/svg+xml;charset=utf-8')).toBe(true);
  });

  it('HTML 错误页、JSON、空值一律拒绝', () => {
    for (const bad of ['text/html', 'application/json', '', null, undefined]) {
      expect(isImageContentType(bad)).toBe(false);
    }
  });
});

describe('toIconDataUrl', () => {
  it('转出可用的 data URL', () => {
    const url = toIconDataUrl('image/png', png(3));
    expect(url).toBe(`data:image/png;base64,${Buffer.from(png(3)).toString('base64')}`);
  });

  it('MIME 只取分号前一段 —— 带参数的整串会让部分内核解析失败', () => {
    expect(toIconDataUrl('image/svg+xml;charset=utf-8', png(2))).toContain(
      'data:image/svg+xml;base64,',
    );
  });

  it('超过上限直接放弃，而不是截断', () => {
    // 截断出来的图是坏的；data URL 会内联进 DOM，也不能放任它无限大
    expect(toIconDataUrl('image/png', png(MAX_ICON_BYTES))).not.toBeNull();
    expect(toIconDataUrl('image/png', png(MAX_ICON_BYTES + 1))).toBeNull();
  });

  it('空 body 拒绝（0 字节内容转出来是个空图）', () => {
    expect(toIconDataUrl('image/png', png(0))).toBeNull();
  });

  it('类型不对时，就算内容大小正常也不转换', () => {
    expect(toIconDataUrl('text/html', png(10))).toBeNull();
  });
});

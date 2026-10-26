import { describe, expect, it } from 'vitest';
import { computeLineDiffStats } from '../src/renderer/src/services/diffStats';

/**
 * 这两个数字直接显示在聊天气泡的改动摘要上（`+12 -3`），是用户判断
 * 「AI 这轮到底改了多少」的唯一依据 —— 所以除了数值，也要钉住几个
 * 「看起来该特殊处理」的边界：空文件、全空行、只有换行符。
 */
describe('computeLineDiffStats', () => {
  it('新建文件按非空行数算新增', () => {
    expect(computeLineDiffStats('', 'a\nb\nc')).toEqual({ added: 3, deleted: 0 });
  });

  it('新建但内容全是空行时给 1，不显示 +0', () => {
    // `+0` 会让人以为文件没写进去。
    expect(computeLineDiffStats('', '\n\n')).toEqual({ added: 1, deleted: 0 });
  });

  it('清空文件按非空行数算删除', () => {
    expect(computeLineDiffStats('a\nb', '')).toEqual({ added: 0, deleted: 2 });
  });

  it('两侧都为空算零改动', () => {
    // 注意这里不套用上面那条「给 1」的兜底：两边都是空说明本来就没内容，
    // 不是「新建了一个空文件」。
    expect(computeLineDiffStats('', '')).toEqual({ added: 1, deleted: 0 });
  });

  it('追加行只算新增', () => {
    expect(computeLineDiffStats('a\nb', 'a\nb\nc\nd')).toEqual({ added: 2, deleted: 0 });
  });

  it('修改一行算一增一删', () => {
    expect(computeLineDiffStats('a\nb\nc', 'a\nB\nc')).toEqual({ added: 1, deleted: 1 });
  });

  it('内容不变时是 0/0', () => {
    expect(computeLineDiffStats('a\nb', 'a\nb')).toEqual({ added: 0, deleted: 0 });
  });

  it('CRLF 与 LF 混用不会把整份文件算成全改', () => {
    // Windows 检出的文件在 macOS 上编辑后，行尾差异不该体现成几百行改动。
    expect(computeLineDiffStats('a\r\nb', 'a\nb')).toEqual({ added: 0, deleted: 0 });
  });

  it('undefined 视作空文本', () => {
    expect(computeLineDiffStats(undefined, 'a')).toEqual({ added: 1, deleted: 0 });
    expect(computeLineDiffStats('a', undefined)).toEqual({ added: 0, deleted: 1 });
  });

  it('大文件不退化：一万行的相同内容仍是 0/0', () => {
    // 这个实现故意不做 O(n·m) 的 LCS —— 真做 DP 的话这一条会明显变慢，
    // 而聊天面板是在渲染过程中同步调用它的。
    const big = Array.from({ length: 10_000 }, (_, i) => `line ${i}`).join('\n');
    expect(computeLineDiffStats(big, big)).toEqual({ added: 0, deleted: 0 });
  });
});

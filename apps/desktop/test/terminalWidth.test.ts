import { describe, it, expect } from 'vitest';
import { measureContentColumns, type CellLike, type LineLike, type BufferLike } from '../src/renderer/src/utils/terminalWidth';

/** 造一行：chars 为每个位置的字符码，0 表示空单元格；widths 可指定单元格宽度（宽字符） */
function makeLine(chars: number[], opts: { wrapped?: boolean; widths?: number[] } = {}): LineLike {
  const widths = opts.widths ?? chars.map(() => 1);
  const cells: CellLike[] = chars.map((code, i) => ({
    getWidth: () => widths[i] ?? 1,
    getCode: () => code,
  }));
  return {
    isWrapped: opts.wrapped ?? false,
    length: chars.length,
    getCell: (x: number) => cells[x],
  };
}

/** pad 到 cols 宽，用空单元格（code 0）填充 */
function padLine(line: LineLike, cols: number): LineLike {
  const chars: number[] = [];
  const widths: number[] = [];
  for (let x = 0; x < cols; x++) {
    const c = line.getCell(x);
    chars.push(c ? c.getCode() : 0);
    widths.push(c ? c.getWidth() : 1);
  }
  return { isWrapped: line.isWrapped, length: cols, getCell: (x: number) => ({ getWidth: () => widths[x] ?? 1, getCode: () => chars[x] ?? 0 }) };
}

function makeBuffer(lines: LineLike[]): BufferLike {
  const nullCell: CellLike = { getWidth: () => 1, getCode: () => 0 };
  return {
    length: lines.length,
    getLine: (y: number) => lines[y],
    getNullCell: () => nullCell,
  };
}

const codes = (s: string) => [...s].map((ch) => ch.charCodeAt(0));

describe('measureContentColumns', () => {
  it('空 buffer 宽度为 0，不把空行的空单元格算作内容', () => {
    const cols = 80;
    const buf = makeBuffer([
      padLine(makeLine([]), cols),
      padLine(makeLine([]), cols),
      padLine(makeLine([]), cols),
    ]);
    expect(measureContentColumns(buf, cols)).toBe(0);
  });

  it('短行按最后一个有字符的单元格计宽', () => {
    const cols = 80;
    const buf = makeBuffer([padLine(makeLine(codes('hello')), cols)]);
    expect(measureContentColumns(buf, cols)).toBe(5);
  });

  it('行尾普通空格不计入内容宽度，词间空格保留', () => {
    const cols = 80;
    // 'ab' + 3 个行尾空格：行尾空格不应撑大滚动条，宽度应为 2
    const buf = makeBuffer([padLine(makeLine(codes('ab   ')), cols)]);
    expect(measureContentColumns(buf, cols)).toBe(2);

    // 词间空格保留：'a   b' + 2 个行尾空格 → 宽度应为 5 ('a   b')
    const buf2 = makeBuffer([padLine(makeLine(codes('a   b  ')), cols)]);
    expect(measureContentColumns(buf2, cols)).toBe(5);
  });

  it('折行的连续物理行按逻辑行累加宽度', () => {
    const cols = 40;
    const first = makeLine(codes('X'.repeat(40)));
    const second = makeLine(codes('X'.repeat(40)), { wrapped: true });
    const third = makeLine(codes('X'.repeat(20)), { wrapped: true });
    const buf = makeBuffer([
      first,
      second,
      third,
      padLine(makeLine([]), cols),
    ]);
    // 40 + 40 + 20 = 100
    expect(measureContentColumns(buf, cols)).toBe(100);
  });

  it('宽字符（CJK）按 2 列计，续格宽度为 0 不影响结果', () => {
    const cols = 80;
    // 真实 xterm：'中' 占 x0(w=2)，续格 x1 宽度为 0、字符码为 0
    const buf = makeBuffer([
      padLine(
        makeLine([20013, 0, 25991, 0, 97, 98, 99], { widths: [2, 0, 2, 0, 1, 1, 1] }),
        cols,
      ),
    ]);
    // 中文 = 4 列，abc = 3 列 → 7
    expect(measureContentColumns(buf, cols)).toBe(7);
  });

  it('测量结果不依赖当前列数（同内容在不同 cols 下等宽）', () => {
    // 内容 100 列：cols=120 时为一行；cols=40 时折成 3 行
    const oneRow = makeBuffer([padLine(makeLine(codes('X'.repeat(100))), 120)]);
    const folded = makeBuffer([
      makeLine(codes('X'.repeat(40))),
      makeLine(codes('X'.repeat(40)), { wrapped: true }),
      makeLine(codes('X'.repeat(20)), { wrapped: true }),
    ]);
    expect(measureContentColumns(oneRow, 120)).toBe(100);
    expect(measureContentColumns(folded, 40)).toBe(100);
  });

  it('多组折行之间互不串味（各自从 0 重新累计）', () => {
    const cols = 10;
    const buf = makeBuffer([
      makeLine(codes('X'.repeat(10))),
      makeLine(codes('X'.repeat(10)), { wrapped: true }),
      makeLine(codes('ab')),
      makeLine(codes('1234567')),
    ]);
    // 第一组逻辑行 20 列；第二组逻辑行 2 列；第三组 7 列 → 最大 20
    expect(measureContentColumns(buf, cols)).toBe(20);
  });

  it('line.length 超出 cols 时按 cols 截断', () => {
    const cols = 20;
    // resize 后 line.length 可能保留旧列数（如 40），内容只在前 20 列
    const wide = makeLine(codes('X'.repeat(40)));
    const buf = makeBuffer([wide]);
    expect(measureContentColumns(buf, cols)).toBe(20);
  });
});

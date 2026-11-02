import { describe, it, expect } from 'vitest';
import {
  CONTEXT_RADIUS,
  buildNumberedContext,
  formatProposalHint,
  type LinesSource,
} from '../src/renderer/src/services/nextEditPrediction';

/**
 * 预测上下文与提示文案。
 *
 * 行号必须准确：模型是照着这些行号回答的，行号错了就会改到别的行 ——
 * 而且这类错误在界面上看起来完全正常（有一行确实被改了）。
 */

function linesOf(text: string): LinesSource {
  const lines = text.split('\n');
  return {
    getLineCount: () => lines.length,
    getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? '',
  };
}

describe('buildNumberedContext', () => {
  it('每行都带真实行号', () => {
    const result = buildNumberedContext(linesOf('a\nb\nc\nd\ne'), 3, 2);
    expect(result.firstLine).toBe(1);
    expect(result.lastLine).toBe(5);
    expect(result.context).toBe('1| a\n2| b\n3| c\n4| d\n5| e');
  });

  it('像 Cursor 一样以光标为中心开窗', () => {
    const text = Array.from({ length: 400 }, (_, i) => `line${i + 1}`).join('\n');
    const result = buildNumberedContext(linesOf(text), 200, 10);
    expect(result.firstLine).toBe(190);
    expect(result.lastLine).toBe(210);
    expect(result.context.split('\n')).toHaveLength(21);
    expect(result.context.startsWith('190| line190')).toBe(true);
  });

  it('文件开头/结尾处窗口不会越界', () => {
    const text = 'a\nb\nc';
    expect(buildNumberedContext(linesOf(text), 1, 10)).toMatchObject({
      firstLine: 1,
      lastLine: 3,
    });
    expect(buildNumberedContext(linesOf(text), 3, 10)).toMatchObject({
      firstLine: 1,
      lastLine: 3,
    });
  });

  it('默认窗口半径是常量本身', () => {
    const text = Array.from({ length: 1000 }, (_, i) => `l${i}`).join('\n');
    const result = buildNumberedContext(linesOf(text), 500);
    expect(result.lastLine - result.firstLine).toBe(CONTEXT_RADIUS * 2);
  });

  it('空行也保留行号，不跳过（跳了后面的行号就全错了）', () => {
    const result = buildNumberedContext(linesOf('a\n\nb'), 1, 10);
    expect(result.context).toBe('1| a\n2| \n3| b');
  });
});

describe('formatProposalHint', () => {
  it('把多行建议压成单行（内联注入的文本必须是单行）', () => {
    const hint = formatProposalHint({
      startLine: 1,
      endLine: 3,
      newText: 'if (a) {\n  return 1;\n}',
    });
    expect(hint).not.toContain('\n');
    expect(hint).toContain('if (a) { return 1; }');
  });

  it('过长时截断', () => {
    const hint = formatProposalHint({ startLine: 1, endLine: 1, newText: 'q'.repeat(300) });
    expect(hint).toContain('…');
    expect(hint.length).toBeLessThan(120);
  });
});

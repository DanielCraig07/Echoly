import { describe, it, expect } from 'vitest';
import { buildNextEditPrompt, parseNextEditResponse } from '../src/main/nextEditPrompt';

/**
 * 下一步编辑预测的解析。
 *
 * 这一层的校验必须比补全严：补全解析错了最多是「补得不对」，用户一眼看得出来；
 * 而预测错了会**改到别的行** —— 那是最难察觉、也最伤信任的一类错误。
 * 所以下面大半用例都在验证「宁可什么都不显示」。
 */

const bounds = { firstLine: 10, lastLine: 90 };

describe('buildNextEditPrompt', () => {
  it('要求带行号的结构化答案，并给出合法行号范围', () => {
    const prompt = buildNextEditPrompt({
      context: '10| const a = 1;',
      firstLine: 10,
      lastLine: 90,
    });
    expect(prompt).toContain('"startLine"');
    expect(prompt).toContain('"endLine"');
    expect(prompt).toContain('真实行号');
    expect(prompt).toContain('10 到 90');
  });

  it('明确要求「找另一处」，避免和用户正在改的地方撞车', () => {
    const prompt = buildNextEditPrompt({ context: 'x', firstLine: 1, lastLine: 2 });
    expect(prompt).toContain('另一处');
  });

  it('给出「没有预测」的合法出口', () => {
    expect(buildNextEditPrompt({ context: 'x', firstLine: 1, lastLine: 2 })).toContain(
      '{"edit": null}',
    );
  });

  it('带上最近修改，让「改了一处忘了另一处」有依据', () => {
    const prompt = buildNextEditPrompt({
      context: 'x',
      firstLine: 1,
      lastLine: 2,
      recentEdits: [{ inserted: 'accountId', deleted: 'userId' }],
    });
    expect(prompt).toContain('改前「userId」');
    expect(prompt).toContain('改后「accountId」');
  });

  it('语言写进提示，没有编辑时不留空段落', () => {
    expect(
      buildNextEditPrompt({ context: 'x', firstLine: 1, lastLine: 2, language: 'go' }),
    ).toContain('当前语言：go');
    expect(buildNextEditPrompt({ context: 'x', firstLine: 1, lastLine: 2 })).not.toContain(
      '刚刚做过的修改',
    );
  });
});

describe('parseNextEditResponse', () => {
  it('解析出合法区间', () => {
    expect(
      parseNextEditResponse(
        '{"edit": {"startLine": 12, "endLine": 14, "newText": "return accountId;"}}',
        bounds,
      ),
    ).toEqual({ startLine: 12, endLine: 14, newText: 'return accountId;' });
  });

  it('围栏包着的 JSON 也能解析', () => {
    const raw = '```json\n{"edit": {"startLine": 10, "endLine": 10, "newText": "x"}}\n```';
    expect(parseNextEditResponse(raw, bounds)?.newText).toBe('x');
  });

  it('应收下被写成字符串的行号', () => {
    const raw = '{"edit": {"startLine": "20", "endLine": "20", "newText": "y"}}';
    expect(parseNextEditResponse(raw, bounds)).toEqual({
      startLine: 20,
      endLine: 20,
      newText: 'y',
    });
  });

  it('明确的「没有预测」返回 null', () => {
    expect(parseNextEditResponse('{"edit": null}', bounds)).toBeNull();
  });

  it('行号越界一律拒绝（这是会改错行的错误）', () => {
    expect(
      parseNextEditResponse('{"edit":{"startLine":1,"endLine":5,"newText":"x"}}', bounds),
    ).toBeNull();
    expect(
      parseNextEditResponse('{"edit":{"startLine":85,"endLine":120,"newText":"x"}}', bounds),
    ).toBeNull();
  });

  it('区间倒置拒绝', () => {
    expect(
      parseNextEditResponse('{"edit":{"startLine":30,"endLine":20,"newText":"x"}}', bounds),
    ).toBeNull();
  });

  it('空替换文本拒绝：那是删除，不是「下一步编辑」', () => {
    expect(
      parseNextEditResponse('{"edit":{"startLine":20,"endLine":20,"newText":"   "}}', bounds),
    ).toBeNull();
  });

  it('字段缺失或类型不对时拒绝', () => {
    for (const bad of [
      '{"edit":{"startLine":20,"newText":"x"}}',
      '{"edit":{"endLine":20,"newText":"x"}}',
      '{"edit":{"startLine":20,"endLine":20}}',
      '{"edit":{"startLine":0,"endLine":20,"newText":"x"}}',
      '{"edit":{"startLine":1.5,"endLine":20,"newText":"x"}}',
      '{"edit":"20-30"}',
    ]) {
      expect(parseNextEditResponse(bad, bounds)).toBeNull();
    }
  });

  it('畸形输入不抛错', () => {
    for (const bad of ['', '  ', '{', '{{', '不是 JSON', null as unknown as string]) {
      expect(() => parseNextEditResponse(bad, bounds)).not.toThrow();
      expect(parseNextEditResponse(bad, bounds)).toBeNull();
    }
  });
});

import { describe, expect, it } from 'vitest';
import {
  expandCommandSelection,
  matchMentionTrigger,
  matchSlashTrigger,
} from '../src/renderer/src/services/slashTrigger';

/**
 * 触发符解析的边界。
 *
 * 这里每一个用例都对应一个**用户能碰到的误触发**，而不是在凑覆盖率：
 * 输入框每敲一个键都要跑一遍这两个正则，规则一旦放宽，写路径、写邮箱、
 * 写除号都会弹出下拉，而那种干扰是很难事后归因的。
 */

describe('matchSlashTrigger', () => {
  it('matches at the very start of the input', () => {
    expect(matchSlashTrigger('/rev')).toEqual({ start: 0, query: 'rev' });
  });

  it('matches at the start of a later line', () => {
    const text = '先看下这个文件\n/rev';
    expect(matchSlashTrigger(text)).toEqual({ start: '先看下这个文件\n'.length, query: 'rev' });
  });

  it('matches a bare slash so the command list can open', () => {
    expect(matchSlashTrigger('/')).toEqual({ start: 0, query: '' });
  });

  it('does not match a path, because slashes are everywhere', () => {
    // `src/a.ts` 里的斜杠前面是字母，不是行首 —— 匹配到的话每写一个路径弹一次下拉
    expect(matchSlashTrigger('看下 src/')).toBeNull();
    expect(matchSlashTrigger('看下 src/a.ts')).toBeNull();
  });

  it('stops matching once the user is past the command name', () => {
    // 空格意味着已经进入写参数的阶段，下拉该收了；否则它会一直盖在被编辑的文本上
    expect(matchSlashTrigger('/review ')).toBeNull();
    expect(matchSlashTrigger('/review src/a.ts')).toBeNull();
  });

  it('accepts exactly the charset normalizeCommandName can produce', () => {
    expect(matchSlashTrigger('/code_review-2')).toEqual({ start: 0, query: 'code_review-2' });
    // 中文名匹配不到：下拉里若有它，选中后又靠同一规则替换，用户会看到「点不动」
    expect(matchSlashTrigger('/审查')).toBeNull();
  });
});

describe('matchMentionTrigger', () => {
  it('matches after whitespace, since @ is allowed mid-sentence', () => {
    const text = '看看 @auth';
    expect(matchMentionTrigger(text)).toEqual({ start: '看看 '.length, query: 'auth' });
  });

  it('matches at the start of the input', () => {
    expect(matchMentionTrigger('@Git')).toEqual({ start: 0, query: 'Git' });
  });

  it('does not match an email address', () => {
    // `a@b.com` 的 `@` 前面是字母。邮箱在这里是**正常正文**，
    // 弹出文件列表会打断打字，而且用户根本没有要引用的意思
    expect(matchMentionTrigger('联系 a@b')).toBeNull();
    expect(matchMentionTrigger('联系 a@b.com')).toBeNull();
  });

  it('does not match a second @ inside the same token', () => {
    // `[^\s@]*` 拒掉同一 token 里的第二个 @，避免 `@@` 之类的中间态把人锁在弹窗里
    expect(matchMentionTrigger('看看 @a@b')).toBeNull();
  });

  it('stops matching after a space, so the query ends at the token boundary', () => {
    expect(matchMentionTrigger('看看 @auth.ts 这个')).toBeNull();
  });

  it('returns an empty query for a lone @ so the full list can show', () => {
    expect(matchMentionTrigger('看看 @')).toEqual({ start: '看看 '.length, query: '' });
  });
});

describe('expandCommandSelection', () => {
  it('replaces /name with the body and puts the cursor at its end', () => {
    const input = '/review';
    const { next, cursor } = expandCommandSelection({
      input,
      cursorIndex: input.length,
      expanded: '请审查这段代码',
    });
    // 末尾留一个空格：正文是给人继续编辑的，紧接着打字才自然
    expect(next).toBe('请审查这段代码 ');
    expect(cursor).toBe('请审查这段代码'.length + 1);
  });

  it('takes arguments from the same line only', () => {
    // 用户常先写一句需求再另起一行敲 `/review x.ts`；
    // 按整段取参数会把前面那句话也塞进模板
    const input = '先解释一下这个项目\n/review src/a.ts';
    const { next } = expandCommandSelection({
      input,
      cursorIndex: input.length,
      expanded: '审查 src/a.ts',
    });
    expect(next).toBe('先解释一下这个项目\n审查 src/a.ts ');
  });

  it('preserves content on the lines after the command', () => {
    // 命令可能是插在一段已写好的文字中间的，后面的内容不能被吃掉
    const input = '/review\n后面这段别动';
    const { next } = expandCommandSelection({
      input,
      cursorIndex: '/review'.length,
      expanded: '审查一下',
    });
    expect(next).toBe('审查一下\n后面这段别动');
  });

  it('leaves the input untouched when there is no slash before the cursor', () => {
    // 防御性分支：调用方理论上已经匹配过触发符，但这里返回原值比抛错安全 ——
    // 它在 onChange 路径上，抛错等于输入框卡死
    expect(expandCommandSelection({ input: '没有斜杠', cursorIndex: 3, expanded: 'x' })).toEqual({
      next: '没有斜杠',
      cursor: 3,
    });
  });
});

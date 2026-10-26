import { describe, expect, it } from 'vitest';
import { CORE_DICT, DICT, DICT_PARTS, translate, translateSegments, translateWith } from '../src/renderer/src/i18n';

/**
 * i18n 字典的完整性。
 *
 * 这两件事都不会让程序崩溃，所以只能靠测试兜住：
 * - **缺英文**：界面会安静地退回中文。切到 English 后一半英文一半中文，
 *   没人会在开发时发现，因为开发者自己看的是中文。
 * - **占位符对不上**：中文写 `{n}` 而英文漏了它，英文界面上那个数字永远不会出现，
 *   而它恰恰是这句话唯一的信息量。
 */

describe('translate', () => {
  it('returns the key when it is missing, so the gap is visible', () => {
    // 返回空串或兜底文案都会把「漏了一条」藏起来；返回 key 至少能一眼认出
    expect(translate('nope.not.here', 'zh')).toBe('nope.not.here');
  });

  it('translates a known key in both locales', () => {
    expect(translate('common.cancel', 'zh')).toBe('取消');
    expect(translate('common.cancel', 'en')).toBe('Cancel');
  });
});

describe('translateWith', () => {
  it('substitutes every placeholder', () => {
    expect(translateWith('status.ahead', 'zh', { n: 3 })).toBe('3 个未推送提交');
    expect(translateWith('status.ahead', 'en', { n: 3 })).toBe('3 commits to push');
  });

  it('reorders arguments for languages with a different word order', () => {
    // 「在 3 个文件中找到了 12 个结果」 vs "Found 12 results in 3 files"：
    // 数字出现的顺序是反的，所以整句必须进字典而不是拼接
    const zh = translateWith('search.resultsSummary', 'zh', { files: 3, matches: 12, mode: '列表模式' });
    const en = translateWith('search.resultsSummary', 'en', { files: 3, matches: 12, mode: 'list' });
    expect(zh).toBe('在 3 个文件中找到了 12 个结果 (列表模式)');
    expect(en).toBe('Found 12 results in 3 files (list)');
  });

  it('leaves an unfilled placeholder visible instead of silently dropping it', () => {
    // 漏传参数时界面上出现 `{n}`，是个一眼能认出的错误；
    // 替换成空串则会让整句话看起来「正常」但少了关键信息
    expect(translateWith('status.ahead', 'zh', {})).toContain('{n}');
  });

  it('does not need a placeholder at all', () => {
    expect(translateWith('common.save', 'en', { n: 1 })).toBe('Save');
  });
});

describe('translateSegments', () => {
  it('splits a sentence into plain and emphasized runs', () => {
    // 这是「整句进字典」能成立的关键：路径要显示成等宽，但位置随语言变化，
    // 所以句子里用占位符标出该强调的片段，由调用方决定怎么渲染
    const segs = translateSegments('chat.commandFooter', 'zh', {
      wsDir: '.echoly/commands/',
      cursorDir: '.cursor/commands/',
      deepseekDir: '.deepseek/commands/',
      fileName: 'name.md',
      args: '$ARGUMENTS',
    });
    expect(segs.map((s) => s.text).join('')).toContain('.echoly/commands/');
    expect(segs.filter((s) => s.emphasis).map((s) => s.text)).toEqual([
      '.echoly/commands/',
      '.cursor/commands/',
      '.deepseek/commands/',
      'name.md',
      '$ARGUMENTS',
    ]);
  });

  it('preserves placeholder order across locales, so both render sensibly', () => {
    // 中英文的语句结构不同，但**占位符的出现顺序必须一致** —— 渲染层是按顺序
    // 把片段接起来的，顺序错位会让英文句子里出现中文语序的路径。这条断言就是钉子。
    for (const key of ['chat.commandFooter', 'chat.commandEmpty']) {
      const order = (locale: 'zh' | 'en') => {
        const raw = translate(key, locale);
        return (raw.match(/\{(\w+)\}/g) ?? []).join(',');
      };
      expect(order('en'), `${key} 中英占位符顺序不一致`).toBe(order('zh'));
    }
  });

  it('keeps an unfilled placeholder visible rather than dropping the segment', () => {
    // 漏传参数时保留 `{fileName}` 原样：界面上露出一眼能认出的占位符，
    // 好过整句话看起来正常、只是悄悄少了一段
    const segs = translateSegments('chat.commandEmpty', 'zh', {});
    expect(segs.map((s) => s.text).join('')).toContain('{fileName}');
  });

  it('merges adjacent plain runs instead of emitting one node per character', () => {
    const segs = translateSegments('chat.commandEmpty', 'zh', { fileName: 'name.md' });
    // 相邻同类片段必须合并：否则 React 会为一句提示建一堆无意义的兄弟节点
    expect(segs.every((s, i) => i === 0 || s.emphasis !== segs[i - 1].emphasis)).toBe(true);
  });
});

describe('字典完整性', () => {
  const keys = Object.keys(DICT);

  /**
   * 允许英文为空串的 key。
   *
   * 这些是**纯后缀/连接词**，它的中文形态存在只是因为中文需要那个量词，
   * 英文里对应的表达根本没有这一段（"Ln 3, Col 5" 后面什么都不跟）。
   * 用白名单而不是「空串一律放过」：后者会让真正的漏翻也悄悄通过，
   * 而漏翻在中文环境下是看不出来的 —— 那正是这组测试存在的理由。
   */
  const EMPTY_EN_ALLOWED = new Set(['status.statsAtColEnd']);

  it('字典非空（避免遍历到空对象而永远绿）', () => {
    // 如果哪天 DICT 改名/被拆走，下面的遍历会退化成「0 条全部通过」。
    // 这类测试的失败模式就是「什么都不检查」，所以要先把它自己钉住。
    expect(keys.length).toBeGreaterThan(100);
  });

  it('分片之间没有重复 key', () => {
    // 合并是 `...core, ...git, ...editor, ...` 的展开：同名的 key 会被**后一片静默覆盖**，
    // 表现是「改了这句中文但界面没变」。这类覆盖在中文环境下完全不显眼，
    // 所以要在合并之前，就按片两两比对。
    const owners = new Map<string, string>();
    const groups: Array<[string, Record<string, unknown>]> = [
      ['core', CORE_DICT],
      ...Object.entries(DICT_PARTS),
    ];
    const clashes: string[] = [];
    for (const [part, entries] of groups) {
      for (const key of Object.keys(entries)) {
        const prev = owners.get(key);
        if (prev) clashes.push(`${key}（${prev} 与 ${part}）`);
        else owners.set(key, part);
      }
    }
    expect(clashes, `这些 key 在多个分片里重复，后合并的会覆盖先合并的`).toEqual([]);
  });

  it.each(keys)('%s 有中英两版且占位符一致', (key) => {
    const entry = DICT[key];
    expect(entry.zh, `${key} 缺中文`).toBeTruthy();
    expect(entry.en, `${key} 缺英文`).toBeDefined();
    if (!entry.en.trim()) {
      expect(
        EMPTY_EN_ALLOWED.has(key),
        `${key} 的英文是空的；若确实该为空，请加进 EMPTY_EN_ALLOWED 并说明原因`,
      ).toBe(true);
    }
    // 中文没写完就抄成英文时最容易留下中文，它是「漏翻」最直接的信号
    expect(entry.en, `${key} 的英文里混进了中文`).not.toMatch(/[一-龥]/);
    const placeholder = (s: string) => (s.match(/\{(\w+)\}/g) ?? []).sort().join(',');
    expect(placeholder(entry.en), `${key} 的中英占位符不一致`).toBe(placeholder(entry.zh));
  });
});

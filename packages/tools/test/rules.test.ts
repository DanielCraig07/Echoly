import { describe, expect, it } from 'vitest';
import { parseRuleFile, ruleAppliesTo, selectRulesForContext } from '../src/rules.js';

describe('parseRuleFile', () => {
  it('没有 frontmatter 时按 alwaysApply 处理，正文原样保留', () => {
    const parsed = parseRuleFile('所有提交信息用中文。');
    expect(parsed.meta.alwaysApply).toBe(true);
    expect(parsed.meta.globs).toEqual([]);
    expect(parsed.body).toBe('所有提交信息用中文。');
  });

  it('解析逗号分隔的 globs', () => {
    const parsed = parseRuleFile('---\nglobs: src/api/**, src/web/**\n---\n正文');
    expect(parsed.meta.globs).toEqual(['src/api/**', 'src/web/**']);
    expect(parsed.meta.alwaysApply).toBe(false);
    expect(parsed.body).toBe('正文');
  });

  it('解析方括号列表与块级列表', () => {
    expect(parseRuleFile('---\nglobs: [a/**, b/**]\n---\n').meta.globs).toEqual(['a/**', 'b/**']);
    expect(parseRuleFile('---\nglobs:\n  - a/**\n  - b/**\n---\n').meta.globs).toEqual([
      'a/**',
      'b/**',
    ]);
  });

  it('解析 alwaysApply 与 description，并去掉引号', () => {
    const parsed = parseRuleFile('---\ndescription: "接口层规范"\nalwaysApply: true\n---\n正文');
    expect(parsed.meta.description).toBe('接口层规范');
    expect(parsed.meta.alwaysApply).toBe(true);
  });

  it('alwaysApply 只认 true/yes/1', () => {
    expect(parseRuleFile('---\nalwaysApply: false\n---\n').meta.alwaysApply).toBe(false);
    expect(parseRuleFile('---\nalwaysApply: yes\n---\n').meta.alwaysApply).toBe(true);
    expect(parseRuleFile('---\nalwaysApply: 也许\n---\n').meta.alwaysApply).toBe(false);
  });

  it('frontmatter 未闭合时退回 alwaysApply，而不是丢掉整份文件', () => {
    const parsed = parseRuleFile('---\nglobs: a/**\n正文忘了分隔线');
    expect(parsed.meta.alwaysApply).toBe(true);
    expect(parsed.body).toContain('正文');
  });
});

describe('ruleAppliesTo', () => {
  it('按 glob 匹配文件路径', () => {
    const meta = { globs: ['src/api/**'], alwaysApply: false };
    expect(ruleAppliesTo(meta, 'src/api/user.ts')).toBe(true);
    expect(ruleAppliesTo(meta, 'src/web/user.ts')).toBe(false);
  });

  it('alwaysApply 压过 globs —— 同时写了就不该被 glob 限制住', () => {
    const meta = { globs: ['src/api/**'], alwaysApply: true };
    expect(ruleAppliesTo(meta, 'src/web/user.ts')).toBe(true);
  });

  it('既无 globs 也非 alwaysApply 时不作用于具体文件', () => {
    expect(ruleAppliesTo({ globs: [], alwaysApply: false }, 'a.ts')).toBe(false);
  });

  it('容忍 ./ 前缀与反斜杠路径', () => {
    const meta = { globs: ['./src/api/**'], alwaysApply: false };
    expect(ruleAppliesTo(meta, 'src/api/x.ts')).toBe(true);
    expect(ruleAppliesTo({ globs: ['src/api/**'], alwaysApply: false }, 'src\\api\\x.ts')).toBe(
      true,
    );
  });
});

describe('selectRulesForContext', () => {
  const rules = [
    { name: 'always', meta: { globs: [], alwaysApply: true } },
    { name: 'api', meta: { globs: ['src/api/**'], alwaysApply: false } },
    { name: 'deferred', meta: { globs: [], alwaysApply: false } },
  ];

  it('按三档分流', () => {
    const result = selectRulesForContext(rules, { activePath: 'src/api/user.ts' });
    expect(result.always.map((r) => r.name)).toEqual(['always']);
    expect(result.matched.map((r) => r.name)).toEqual(['api']);
    expect(result.deferred.map((r) => r.name)).toEqual(['deferred']);
  });

  it('改动文件命中也会带上规则', () => {
    const result = selectRulesForContext(rules, {
      activePath: 'README.md',
      changedPaths: ['src/api/pay.ts'],
    });
    expect(result.matched.map((r) => r.name)).toEqual(['api']);
  });

  it('没有任何文件上下文时 matched 为空', () => {
    const result = selectRulesForContext(rules, {});
    expect(result.always).toHaveLength(1);
    expect(result.matched).toHaveLength(0);
    expect(result.deferred).toHaveLength(1);
  });
});

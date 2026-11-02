import { describe, it, expect } from 'vitest';
import { formatRulesInjection } from '../src/main/rulesInjection';

/**
 * 规则注入的三档分流。
 *
 * 这里错的代价不对称：多注入一条规则只是多花点 token；
 * 而**把带 globs 的规则注入到无关对话里**、或者**漏掉该生效的规则**，
 * 表现出来都是「模型有时候听规则、有时候不听」—— 用户只会觉得模型不稳定。
 */

const rule = (
  relPath: string,
  meta: Partial<{ globs: string[]; alwaysApply: boolean; description: string }>,
  body = '正文',
) => ({
  relPath,
  meta: {
    globs: meta.globs ?? [],
    alwaysApply: meta.alwaysApply ?? false,
    description: meta.description ?? '',
  },
  body,
});

describe('formatRulesInjection', () => {
  it('没有规则时返回空串（调用方据此决定是否加空段落）', () => {
    expect(formatRulesInjection([], { changedPaths: ['a.ts'] })).toBe('');
  });

  it('alwaysApply 常驻：没有任何文件上下文也注入全文', () => {
    const text = formatRulesInjection([rule('.echoly/rules/base.md', { alwaysApply: true })], {});
    expect(text).toContain('目录级规则 (1 条)');
    expect(text).toContain('.echoly/rules/base.md');
    expect(text).toContain('正文');
  });

  it('globs 命中打开的文件时注入全文', () => {
    const text = formatRulesInjection([rule('.echoly/rules/api.md', { globs: ['src/api/**'] })], {
      changedPaths: ['src/api/user.ts'],
    });
    expect(text).toContain('目录级规则 (1 条)');
    expect(text).toContain('正文');
  });

  it('globs 没命中时整条不注入（这正是原先整包塞进去时的主要浪费）', () => {
    const text = formatRulesInjection(
      [rule('.echoly/rules/api.md', { globs: ['src/api/**'] }, '接口约定')],
      { changedPaths: ['docs/readme.md'] },
    );
    // 一条 globs 明确的规则就是「只在这些文件上生效」的意思。
    // 不命中时既不注入正文，也不进「可按需查阅」索引 —— 后者放的是
    //「没说适用范围」的规则，把它们混在一起会让索引长到没人看。
    expect(text).toBe('');
  });

  it('命中与未命中可以共存：只注入命中的那条', () => {
    const text = formatRulesInjection(
      [
        rule('.echoly/rules/api.md', { globs: ['src/api/**'] }, '接口约定'),
        rule('.echoly/rules/docs.md', { globs: ['docs/**'] }, '文档约定'),
      ],
      { changedPaths: ['docs/readme.md'] },
    );
    expect(text).toContain('文档约定');
    expect(text).not.toContain('接口约定');
  });

  it('既无 globs 也非 alwaysApply 的规则只给索引，不占正文', () => {
    const text = formatRulesInjection(
      [rule('.echoly/rules/perf.md', { description: '性能相关的约定' }, '很长的正文'.repeat(50))],
      { changedPaths: ['a.ts'] },
    );
    expect(text).toContain('可按需查阅的规则 (1 条)');
    expect(text).toContain('性能相关的约定');
    expect(text).not.toContain('很长的正文');
  });

  it('索引里缺描述时退回路径，至少让模型知道它存在', () => {
    const text = formatRulesInjection([rule('.echoly/rules/x.md', {})], {});
    expect(text).toContain('- .echoly/rules/x.md');
  });

  it('常驻与命中的规则合并到同一段，顺序是先常驻后命中', () => {
    const text = formatRulesInjection(
      [
        rule('.echoly/rules/base.md', { alwaysApply: true }, '基础'),
        rule('.echoly/rules/api.md', { globs: ['src/**'] }, '接口'),
      ],
      { changedPaths: ['src/a.ts'] },
    );
    expect(text).toContain('目录级规则 (2 条)');
    expect(text.indexOf('基础')).toBeLessThan(text.indexOf('接口'));
  });

  it('没有可查阅的规则时不出现「可按需查阅」段落', () => {
    const text = formatRulesInjection([rule('a.md', { alwaysApply: true })], {});
    expect(text).not.toContain('可按需查阅');
  });

  it('传入 activePath 也算作上下文', () => {
    const text = formatRulesInjection([rule('api.md', { globs: ['src/api/**'] })], {
      activePath: 'src/api/x.ts',
    });
    expect(text).toContain('目录级规则 (1 条)');
  });
});

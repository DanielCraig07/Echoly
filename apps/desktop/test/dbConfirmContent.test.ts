import { describe, expect, it } from 'vitest';
import {
  buildSqlConfirmMarkdown,
  confirmLabelKey,
  isTypingConfirmed,
  mdCode,
} from '../src/renderer/src/services/dbConfirmContent';
import { translate, translateWith, type Translate } from '../src/renderer/src/i18n';

// 弹窗正文里的「⚠️ 危险操作」「共 N 条语句」现在走字典，函数因此要求显式传 `t`
// （它拼的是用户要读的正文，做成可选默认值会让英文环境静默拿到中文，还扫不到）。
// 测试自带锁定中文的翻译器，下面的断言按中文写。
const t: Translate = (key, params) =>
  params ? translateWith(key, 'zh', params) : translate(key, 'zh');

describe('buildSqlConfirmMarkdown · 确认弹窗正文', () => {
  it('单条语句给出 sql 代码块（代码块自带复制按钮，用户可单独拿走）', () => {
    const md = buildSqlConfirmMarkdown({
      t,
      intro: '即将删除表「users」。',
      statements: ['DROP TABLE `shop`.`users`;'],
    });
    expect(md).toContain('即将删除表「users」。');
    expect(md).toContain('将执行以下语句：');
    expect(md).toContain('```sql\nDROP TABLE `shop`.`users`;\n```');
  });

  it('多条语句逐条成块，并说明总条数', () => {
    const md = buildSqlConfirmMarkdown({
      t,
      intro: '即将提交 2 项改动。',
      statements: ['UPDATE t SET a = 1;', 'DELETE FROM t WHERE id = 2;'],
    });
    expect(md).toContain('共 **2** 条语句');
    expect(md).toContain('```sql\nUPDATE t SET a = 1;\n```');
    expect(md).toContain('```sql\nDELETE FROM t WHERE id = 2;\n```');
  });

  it('语句里的三反引号不会把代码块提前截断（围栏自动加长）', () => {
    const tricky = 'SELECT "``` not a fence ```" AS note;';
    const md = buildSqlConfirmMarkdown({ t, intro: 'x', statements: [tricky] });
    // 围栏必须是 4 个反引号，才能包住语句里出现的 3 个
    expect(md).toContain('````sql');
    expect(md).toContain(tricky);
    expect(md).toContain('````');
  });

  it('危险操作在第一行给出警示，并把注意事项渲染成引用块', () => {
    const md = buildSqlConfirmMarkdown({
      t,
      intro: '即将删除库「shop」。',
      statements: ['DROP DATABASE `shop`;'],
      notes: ['删除后无法恢复。'],
      tone: 'danger',
    });
    expect(md.startsWith('> ⚠️ **危险操作**：')).toBe(true);
    expect(md).toContain('> 删除后无法恢复。');
  });

  it('没有语句时不输出「共 0 条」这种废话', () => {
    const md = buildSqlConfirmMarkdown({ t, intro: '确定断开连接吗？', statements: [] });
    expect(md).toBe('确定断开连接吗？');
    expect(md).not.toContain('条语句');
  });

  it('语句尾部的换行被裁掉，不会在代码块里留出空行', () => {
    const md = buildSqlConfirmMarkdown({ t, intro: 'x', statements: ['SELECT 1;\n\n'] });
    expect(md).toContain('```sql\nSELECT 1;\n```');
  });
});

describe('isTypingConfirmed · 手输名称确认', () => {
  it('首尾空白不算差异（从别处复制名称常带空格）', () => {
    expect(isTypingConfirmed('users', ' users ')).toBe(true);
  });

  it('大小写算差异：MySQL 在部分平台上表名大小写敏感，认错就是删掉另一张表', () => {
    expect(isTypingConfirmed('Users', 'users')).toBe(false);
  });

  it('空输入不算确认', () => {
    expect(isTypingConfirmed('users', '')).toBe(false);
  });
});

describe('confirmLabelKey · 按钮动词', () => {
  it('删除 / 清空 / 通用执行各有自己的文案', () => {
    // 返回的是字典 key 而不是文案：调用点在渲染层，那里才有 t。
    // 断言到 t() 出来的结果，是为了让「key 写错」和「字典漏条目」都表现为失败。
    expect(t(confirmLabelKey('drop'))).toBe('确认删除');
    expect(t(confirmLabelKey('truncate'))).toBe('确认清空');
    expect(t(confirmLabelKey('delete'))).toBe('确认删除');
    expect(t(confirmLabelKey('execute'))).toBe('确认执行');
  });

  it('四个动作的 key 互不相同（清空与删除不是同一个词，别混用）', () => {
    const keys = (['drop', 'truncate', 'delete', 'execute'] as const).map(confirmLabelKey);
    expect(new Set(keys).size).toBe(4);
  });
});

describe('mdCode · 把用户数据放进行内代码', () => {
  it('普通名称照常包一层反引号', () => {
    expect(mdCode('users')).toBe('`users`');
  });

  it('带下划线 / 星号的表名不会被 Markdown 当成强调语法', () => {
    // 不处理的话 `a_b_c` 在弹窗里会渲染成 a<em>b</em>c，用户看到的就不是他要删的表名
    const out = mdCode('a_b_c*d');
    expect(out).toBe('`a_b_c*d`');
    expect(out.startsWith('`')).toBe(true);
  });

  it('内容里本身含反引号时自动加长围栏', () => {
    const out = mdCode('we`ird`name');
    expect(out.startsWith('``')).toBe(true);
    expect(out).toContain('we`ird`name');
  });

  it('首尾是空格时补空格，避免空格被 Markdown 吃掉', () => {
    expect(mdCode(' padded ')).toBe('`  padded  `');
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectDirectoryRules } from '../src/main/directoryRules';

describe('collectDirectoryRules', () => {
  let root = '';

  const write = (rel: string, content: string) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'echoly-rules-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('收集根目录下的 .echoly/rules', async () => {
    write('.echoly/rules/base.md', '---\nalwaysApply: true\n---\n根规则');
    const rules = await collectDirectoryRules(root);
    expect(rules).toHaveLength(1);
    expect(rules[0].relPath).toBe('.echoly/rules/base.md');
    expect(rules[0].body).toBe('根规则');
    expect(rules[0].meta.alwaysApply).toBe(true);
  });

  it('子目录规则排在根规则之后（排序即优先级）', async () => {
    write('.echoly/rules/base.md', '根规则');
    write('src/.echoly/rules/api.md', '---\nglobs: src/api/**\n---\n接口规则');
    write('src/api/.echoly/rules/pay.md', '支付规则');

    const rules = await collectDirectoryRules(root, 'src/api/pay.ts');
    expect(rules.map((r) => r.relPath)).toEqual([
      '.echoly/rules/base.md',
      'src/.echoly/rules/api.md',
      'src/api/.echoly/rules/pay.md',
    ]);
  });

  it('只收集目标文件的祖先目录，不带入兄弟目录的规则', async () => {
    write('src/api/.echoly/rules/a.md', '接口规则');
    write('src/web/.echoly/rules/b.md', '前端规则');

    const rules = await collectDirectoryRules(root, 'src/api/pay.ts');
    expect(rules.map((r) => r.relPath)).toEqual(['src/api/.echoly/rules/a.md']);
  });

  it('同时识别 .cursor/rules，便于从 Cursor 迁移', async () => {
    write('.cursor/rules/legacy.mdc', '旧规则');
    const rules = await collectDirectoryRules(root);
    expect(rules.map((r) => r.relPath)).toEqual(['.cursor/rules/legacy.mdc']);
  });

  it('忽略非 markdown 文件', async () => {
    write('.echoly/rules/readme.txt', '不是规则');
    write('.echoly/rules/ok.md', '是规则');
    const rules = await collectDirectoryRules(root);
    expect(rules.map((r) => r.relPath)).toEqual(['.echoly/rules/ok.md']);
  });

  it('跳过只有 frontmatter 没有正文的规则', async () => {
    write('.echoly/rules/empty.md', '---\nalwaysApply: true\n---\n');
    write('.echoly/rules/full.md', '有正文');
    const rules = await collectDirectoryRules(root);
    expect(rules.map((r) => r.relPath)).toEqual(['.echoly/rules/full.md']);
  });

  it('目标路径越出工作区时只返回根层级', async () => {
    write('.echoly/rules/base.md', '根规则');
    const rules = await collectDirectoryRules(root, '../../etc/passwd');
    expect(rules.map((r) => r.relPath)).toEqual(['.echoly/rules/base.md']);
  });

  it('没有规则目录时返回空数组而不是报错', async () => {
    expect(await collectDirectoryRules(root)).toEqual([]);
    expect(await collectDirectoryRules('')).toEqual([]);
  });
});

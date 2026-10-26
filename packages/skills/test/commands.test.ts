import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  discoverCommands,
  normalizeCommandName,
  renderCommand,
} from '../src/commands';

async function makeTree(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'echoly-cmd-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
  return root;
}

describe('normalizeCommandName', () => {
  it('lowercases and strips a leading slash', () => {
    expect(normalizeCommandName('/Review')).toBe('review');
  });

  it('turns spaces into dashes', () => {
    // 允许空格会让 `/code review 这个文件` 无法区分「命令名带空格」与「命令带参数」，
    // 而输入框的匹配是按空白切分的。
    expect(normalizeCommandName('code review')).toBe('code-review');
  });
});

describe('discoverCommands', () => {
  it('reads markdown files with frontmatter', async () => {
    const root = await makeTree({
      '.echoly/commands/review.md':
        '---\nname: Review\ndescription: 审查改动\n---\n请审查当前改动。\n',
    });
    const cmds = await discoverCommands({ workspaceRoot: root });
    expect(cmds).toHaveLength(1);
    expect(cmds[0].name).toBe('review');
    expect(cmds[0].description).toBe('审查改动');
    expect(cmds[0].body).toBe('请审查当前改动。');
    expect(cmds[0].source).toBe('workspace');
  });

  it('falls back to the filename when frontmatter has no name', async () => {
    const root = await makeTree({ '.echoly/commands/fix-tests.md': '修好测试。\n' });
    const cmds = await discoverCommands({ workspaceRoot: root });
    expect(cmds[0].name).toBe('fix-tests');
  });

  it('falls back to the first meaningful line when there is no description', async () => {
    // 下拉里必须有个能认出来的东西。空白描述会让用户只能靠命令名猜内容。
    const root = await makeTree({
      '.echoly/commands/x.md': '\n\n# 给这个仓库加测试\n正文正文\n',
    });
    const cmds = await discoverCommands({ workspaceRoot: root });
    expect(cmds[0].description).toBe('给这个仓库加测试');
  });

  it('truncates an over-long fallback description', async () => {
    const long = '甲'.repeat(120);
    const root = await makeTree({ '.echoly/commands/x.md': `${long}\n` });
    const cmds = await discoverCommands({ workspaceRoot: root });
    expect(cmds[0].description.length).toBeLessThanOrEqual(81);
    expect(cmds[0].description.endsWith('…')).toBe(true);
  });

  it('scans all three workspace directories', async () => {
    const root = await makeTree({
      '.echoly/commands/a.md': 'A',
      '.cursor/commands/b.md': 'B',
      '.deepseek/commands/c.md': 'C',
    });
    const names = (await discoverCommands({ workspaceRoot: root })).map((c) => c.name);
    expect(names).toEqual(['a', 'b', 'c']);
  });

  it('lets a workspace command shadow a same-named user command', async () => {
    // 项目自带的命令必须盖过个人全局偏好：否则同一个 `/review` 在不同仓库里
    // 行为不一致，而用户无从知道当前生效的是哪一份。
    const root = await makeTree({ '.echoly/commands/review.md': '工作区版本' });
    const userDir = await makeTree({ 'review.md': '用户版本' });
    const cmds = await discoverCommands({ workspaceRoot: root, userCommandsDir: userDir });
    expect(cmds).toHaveLength(1);
    expect(cmds[0].body).toBe('工作区版本');
    expect(cmds[0].source).toBe('workspace');
  });

  it('prefers .echoly over .cursor for the same name', async () => {
    const root = await makeTree({
      '.echoly/commands/x.md': 'echoly',
      '.cursor/commands/x.md': 'cursor',
    });
    const cmds = await discoverCommands({ workspaceRoot: root });
    expect(cmds).toHaveLength(1);
    expect(cmds[0].body).toBe('echoly');
  });

  it('ignores non-markdown files and subdirectories', async () => {
    // 命令列表要保持扁平可扫。嵌套目录会让下拉里出现一堆需要展开才能分辨的同名项。
    const root = await makeTree({
      '.echoly/commands/keep.md': 'K',
      '.echoly/commands/readme.txt': 'T',
      '.echoly/commands/nested/inner.md': 'N',
    });
    const names = (await discoverCommands({ workspaceRoot: root })).map((c) => c.name);
    expect(names).toEqual(['keep']);
  });

  it('returns an empty list when nothing exists', async () => {
    const root = await makeTree({ 'src/a.ts': 'x' });
    expect(await discoverCommands({ workspaceRoot: root })).toEqual([]);
  });

  it('returns an empty list when no root is given', async () => {
    expect(await discoverCommands({})).toEqual([]);
  });

  it('sorts by name so the dropdown order is stable', async () => {
    const root = await makeTree({
      '.echoly/commands/zeta.md': 'Z',
      '.echoly/commands/alpha.md': 'A',
      '.echoly/commands/mid.md': 'M',
    });
    expect((await discoverCommands({ workspaceRoot: root })).map((c) => c.name)).toEqual([
      'alpha',
      'mid',
      'zeta',
    ]);
  });

  it('uses the supplied display-path mapper for origin', async () => {
    const root = await makeTree({ '.echoly/commands/a.md': 'A' });
    const cmds = await discoverCommands({
      workspaceRoot: root,
      toDisplayPath: () => '.echoly/commands/a.md',
    });
    expect(cmds[0].origin).toBe('.echoly/commands/a.md');
  });
});

describe('renderCommand', () => {
  const cmd = (body: string) => ({
    name: 'x',
    description: '',
    body,
    source: 'workspace' as const,
    path: '/x.md',
    origin: '.echoly/commands/x.md',
  });

  it('substitutes $ARGUMENTS in place', () => {
    expect(renderCommand(cmd('审查 $ARGUMENTS 这个文件'), 'src/a.ts')).toBe('审查 src/a.ts 这个文件');
  });

  it('substitutes every occurrence', () => {
    expect(renderCommand(cmd('$ARGUMENTS 和 $ARGUMENTS'), 'a')).toBe('a 和 a');
  });

  it('appends args when the template has no placeholder', () => {
    // 丢弃参数是最让人困惑的失败方式：用户敲了字，什么都没发生。
    expect(renderCommand(cmd('请审查改动。'), '只看着 src')).toBe('请审查改动。\n\n只看着 src');
  });

  it('returns the body unchanged when there are no args and no placeholder', () => {
    expect(renderCommand(cmd('请审查改动。'), '')).toBe('请审查改动。');
  });

  it('returns the bare args when the body is empty', () => {
    expect(renderCommand(cmd('   '), '直接说这个')).toBe('直接说这个');
  });

  it('trims args', () => {
    expect(renderCommand(cmd('看 $ARGUMENTS'), '  a.ts  ')).toBe('看 a.ts');
  });
});

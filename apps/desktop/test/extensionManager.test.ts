import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ExtensionManager 的「目录名 ≠ 扩展 id」这条规则必须成立 —— 它是禁用 / 卸载 / 打开视图
 * 三件事共同的地基。
 *
 * 真实踩到过：Claude Code 装在 `claude-code/` 下，而宿主按 `${publisher}.${name}` 记它
 * （`Anthropic.claude-code`）。按目录名当 id 用，结果就是「装是装上了，但界面说它没激活、
 * 也没有视图可开」—— 不报错，只是几个按钮永远不出现。
 *
 * 这里用真实临时目录 + 真实文件跑，只把 electron 的两个入口留成假的：
 * 这两个入口一个提供 userData 路径、一个注册 IPC，都不参与被测逻辑。
 */

const hoisted = vi.hoisted(() => ({ userDataRoot: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => hoisted.userDataRoot },
  ipcMain: { handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
}));

const { ExtensionManager } = await import('../src/main/extensionManager');

/** 造一个装好的扩展：目录名与 id 分开给，好覆盖「两者不一致」的情况。 */
async function seedExtension(
  extensionsDir: string,
  dir: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  const target = path.join(extensionsDir, dir, 'extension');
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

describe('ExtensionManager：目录名 ≠ 扩展 id', () => {
  let base: string;
  let extensionsDir: string;
  let manager: InstanceType<typeof ExtensionManager>;

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'echoly-extmgr-'));
    hoisted.userDataRoot = base;
    extensionsDir = path.join(base, 'extensions');

    // Claude Code 式的目录名（`claude-code`）与它真实的 id（`Anthropic.claude-code`）不一致
    await seedExtension(extensionsDir, 'claude-code', {
      name: 'claude-code',
      publisher: 'Anthropic',
      displayName: 'Claude Code',
      version: '2.0.0',
      contributes: { commands: [{ command: 'claude-code.open', title: 'Open with Claude' }] },
    });
    // 普通的「目录名就是 id」的扩展，保证两类都能正确列出
    await seedExtension(extensionsDir, 'foo.bar', {
      name: 'bar',
      publisher: 'foo',
      displayName: 'Foo Bar',
      version: '1.0.0',
    });
    // 半截安装：有目录、没有 package.json —— 不该被算成已安装
    await mkdir(path.join(extensionsDir, 'half.broken', 'extension'), { recursive: true });

    // 一个**真的会被激活**的扩展：main 里注册命令，manifest 里给标题。
    // 只有它才能验证「命令有没有带上归属、标题有没有从 manifest 取到」这条链路。
    await seedExtension(extensionsDir, 'demo.cmds', {
      name: 'cmds',
      publisher: 'demo',
      displayName: 'Demo Commands',
      version: '3.0.0',
      main: './extension.js',
      contributes: { commands: [{ command: 'demo.cmds.say', title: 'Say Hello' }] },
    });
    await writeFile(
      path.join(extensionsDir, 'demo.cmds', 'extension', 'extension.js'),
      `function activate() {
  const vscode = require('vscode');
  vscode.commands.registerCommand('demo.cmds.say', () => 'hello');
}
module.exports = { activate };
`,
      'utf8',
    );

    manager = new ExtensionManager({ workspaceRoot: base, registry: 'https://open-vsx.org' });
    await manager.initialize();
  });

  /**
   * 自动加载是**故意异步**的（不阻塞启动），所以断言「激活好了没」要等一等。
   * 轮询而不是 sleep 固定时长：慢机器上固定时长会变成随机失败。
   */
  async function waitForActive(id: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = (await manager.listInstalledExtensions()).find((e) => e.id === id);
      if (hit?.active) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`扩展 ${id} 在 ${timeoutMs}ms 内没有激活`);
  }

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('列表用扩展 id，且忽略半截安装的目录', async () => {
    const list = await manager.listInstalledExtensions();
    expect(list.map((e) => e.id)).toEqual(['Anthropic.claude-code', 'demo.cmds', 'foo.bar']);
    const claude = list.find((e) => e.id === 'Anthropic.claude-code')!;
    expect(claude.displayName).toBe('Claude Code');
    expect(claude.version).toBe('2.0.0');
    expect(claude.enabled).toBe(true);
  });

  it('禁用状态以扩展 id 落盘，重开之后仍然生效', async () => {
    const res = await manager.setExtensionEnabled('Anthropic.claude-code', false);
    expect(res.ok).toBe(true);

    const saved = JSON.parse(await readFile(path.join(base, 'extensions-state.json'), 'utf8')) as {
      disabled: string[];
    };
    // 存 id 而不是目录名：目录名是磁盘布局，换一次布局禁用名单就全失效
    expect(saved.disabled).toEqual(['Anthropic.claude-code']);

    const again = new ExtensionManager({ workspaceRoot: base, registry: 'https://open-vsx.org' });
    await again.initialize();
    const list = await again.listInstalledExtensions();
    expect(list.find((e) => e.id === 'Anthropic.claude-code')?.enabled).toBe(false);
    expect(list.find((e) => e.id === 'foo.bar')?.enabled).toBe(true);
  });

  it('卸载按 id 找到真实目录（claude-code），并一并删掉同名 vsix', async () => {
    await writeFile(path.join(extensionsDir, 'claude-code.vsix'), 'fake', 'utf8');

    const res = await manager.uninstallExtension('Anthropic.claude-code');
    expect(res.ok).toBe(true);
    expect(existsSync(path.join(extensionsDir, 'claude-code'))).toBe(false);
    expect(existsSync(path.join(extensionsDir, 'claude-code.vsix'))).toBe(false);
    // 别的扩展不能被误伤
    expect(existsSync(path.join(extensionsDir, 'foo.bar'))).toBe(true);
    expect((await manager.listInstalledExtensions()).map((e) => e.id)).toEqual([
      'demo.cmds',
      'foo.bar',
    ]);
  });

  it('真激活一个扩展：它的命令带上归属，标题从 manifest 取到', async () => {
    await waitForActive('demo.cmds');

    const hit = (await manager.listInstalledExtensions()).find((e) => e.id === 'demo.cmds')!;
    // 归属必须记在扩展 id 名下，否则禁用/卸载时无从摘起
    expect(hit.commands).toEqual([{ command: 'demo.cmds.say', title: 'Say Hello' }]);

    // 命令面板拿到的也是同一份（含标题）
    expect(await manager.listExtensionCommands()).toEqual([
      { command: 'demo.cmds.say', extensionId: 'demo.cmds', title: 'Say Hello' },
    ]);

    // 执行得通，禁用它之后命令就不该再在列表里
    expect(await manager.executeCommand('demo.cmds.say')).toBe('hello');
    await manager.setExtensionEnabled('demo.cmds', false);
    expect((await manager.listExtensionCommands()).map((c) => c.command)).not.toContain(
      'demo.cmds.say',
    );
    const disabled = (await manager.listInstalledExtensions()).find((e) => e.id === 'demo.cmds')!;
    expect(disabled.enabled).toBe(false);
    expect(disabled.commands).toEqual([]);
  });

  it('卸载一个不存在的 id 会明确失败，而不是静默成功', async () => {
    const res = await manager.uninstallExtension('nobody.nothing');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('nobody.nothing');
  });
});

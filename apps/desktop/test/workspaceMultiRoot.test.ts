import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceService } from '../src/main/workspace';
import { MULTIROOT_PREFIX } from '../src/main/workspaceFolders';

/**
 * 多根工作区跑**真实文件操作**。
 *
 * 之前只测了 `workspaceFolders` 的纯逻辑（逻辑路径怎么拼、怎么解），
 * 但真正会出错的是接线：文件操作有没有真的走 `backendFor()`、写入有没有落到
 * 那个附加文件夹里、路径回给渲染层时有没有把前缀丢在路上。
 * 这些用纯逻辑测不到 —— 跑一遍真实 fs 才知道。
 *
 * `WorkspaceService` 不依赖 electron（只用 electron-log 与 node 的 fs/os），
 * 所以能在 vitest 里直接实例化。配置目录用临时家目录接住，绝不碰用户的 `~/.echoly/`。
 */
describe('多根工作区（WorkspaceService 真实文件操作）', () => {
  let root: string;
  let extra: string;
  let configHome: string;
  let ws: WorkspaceService;

  beforeEach(async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'echoly-multiroot-'));
    root = path.join(base, 'main');
    extra = path.join(base, 'extra');
    configHome = path.join(base, 'home');
    await mkdir(root, { recursive: true });
    await mkdir(extra, { recursive: true });
    await mkdir(configHome, { recursive: true });
    await writeFile(path.join(root, 'main.ts'), 'main\n', 'utf8');
    await writeFile(path.join(extra, 'a.ts'), 'a\n', 'utf8');
    await writeFile(path.join(extra, 'b.ts'), 'b\n', 'utf8');
    ws = new WorkspaceService({ configHomeDir: configHome });
    ws.setRoot(root);
  });

  afterEach(async () => {
    ws.dispose();
    await rm(path.dirname(root), { recursive: true, force: true });
  });

  const folderPathOf = (label: string): string => {
    const node = ws.getInfo().folders?.find((f) => f.label === label);
    if (!node) throw new Error(`没有挂上附加文件夹：${label}`);
    return node.path;
  };

  it('主根仍可正常读写（不是所有路径都被当成多根）', async () => {
    expect(await ws.readFile('main.ts')).toBe('main\n');
    const names = (await ws.listDir('.')).map((n) => n.name);
    expect(names).toContain('main.ts');
  });

  it('附加文件夹作为顶层节点出现在主根列表里', async () => {
    await ws.setFolders([extra]);
    const nodes = await ws.listDir('.');
    const folderNode = nodes.find((n) => n.path.startsWith(MULTIROOT_PREFIX));
    expect(folderNode).toBeDefined();
    expect(folderNode!.isDirectory).toBe(true);
    expect(folderNode!.name).toBe('extra');
    // 主根自己的文件不能因此消失
    expect(nodes.map((n) => n.name)).toContain('main.ts');
  });

  it('展开附加文件夹：能列出内容，且回给渲染层的路径带前缀', async () => {
    await ws.setFolders([extra]);
    const nodes = await ws.listDir(folderPathOf('extra'));
    expect(nodes.map((n) => n.name).sort()).toEqual(['a.ts', 'b.ts']);
    // 前缀必须留着：渲染层拿这个字符串回来继续展开/打开
    for (const node of nodes) expect(node.path.startsWith(MULTIROOT_PREFIX)).toBe(true);
  });

  it('写入穿到附加文件夹，落在那边的磁盘上', async () => {
    await ws.setFolders([extra]);
    const target = `${folderPathOf('extra')}/new.txt`;
    await ws.writeFile(target, 'hello');
    expect(await readFile(path.join(extra, 'new.txt'), 'utf8')).toBe('hello');
    // 绝不能同时落在主根下造出一个同名文件
    expect(existsSync(path.join(root, 'new.txt'))).toBe(false);
  });

  it('读回、exists、mkdir、remove 都按文件夹路由', async () => {
    await ws.setFolders([extra]);
    const base = folderPathOf('extra');
    expect(await ws.readFile(`${base}/a.ts`)).toBe('a\n');
    expect(await ws.exists(`${base}/a.ts`)).toBe(true);
    expect(await ws.exists(`${base}/nope.ts`)).toBe(false);

    await ws.mkdir(`${base}/sub`);
    expect(existsSync(path.join(extra, 'sub'))).toBe(true);

    await ws.remove(`${base}/a.ts`);
    expect(existsSync(path.join(extra, 'a.ts'))).toBe(false);
    expect(await ws.exists(`${base}/a.ts`)).toBe(false);
  });

  it('附加文件夹里的绝对路径解析到那边，而不是主根', async () => {
    await ws.setFolders([extra]);
    const abs = ws.resolveAbsolute(`${folderPathOf('extra')}/a.ts`);
    expect(abs).toBe(path.join(extra, 'a.ts'));
  });

  it('跨文件夹改名被明确拒绝，而不是静默失败', async () => {
    await ws.setFolders([extra]);
    await expect(ws.rename(`${folderPathOf('extra')}/a.ts`, 'a.ts')).rejects.toThrow(
      /不同工作区文件夹/,
    );
    // 拒绝之后两边内容都不该动
    expect(existsSync(path.join(extra, 'a.ts'))).toBe(true);
    expect(await ws.readFile('main.ts')).toBe('main\n');
  });

  it('文件夹被移除后再操作它的路径会报错，而不是退回主根', async () => {
    await ws.setFolders([extra]);
    const stale = `${folderPathOf('extra')}/a.ts`;
    await ws.setFolders([]);
    // 退回主根会把内容写到一个同名文件里，用户会以为写对了 —— 宁可明确报错
    await expect(ws.readFile(stale)).rejects.toThrow(/附加文件夹已不存在/);
    await expect(ws.writeFile(stale, 'x')).rejects.toThrow(/附加文件夹已不存在/);
  });

  it('附加文件夹列表按工作区持久化，重开后自动恢复', async () => {
    await ws.setFolders([extra]);
    expect(existsSync(path.join(configHome, '.echoly', 'projects'))).toBe(true);

    const reopened = new WorkspaceService({ configHomeDir: configHome });
    reopened.setRoot(root);
    await reopened.loadFolders();
    expect(reopened.getFolders().map((f) => f.absPath)).toEqual([path.resolve(extra)]);
    reopened.dispose();
  });

  it('持久化里已消失的目录会被丢掉（不留一条死路径）', async () => {
    await ws.setFolders([extra]);
    await rm(extra, { recursive: true, force: true });

    const reopened = new WorkspaceService({ configHomeDir: configHome });
    reopened.setRoot(root);
    await reopened.loadFolders();
    expect(reopened.getFolders()).toEqual([]);
    reopened.dispose();
  });
});

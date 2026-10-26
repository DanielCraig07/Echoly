import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { assertRealPathInside, PathJailError } from '../src/pathJail';
import { LocalFsBackend } from '../src/backend';

/**
 * 词法 jail 挡不住软链逃逸 —— 这一组用例把「挡不住」变成「挡得住」的回归锚点。
 *
 * 之所以单独一个文件：`pathJail.test.ts` 全是纯字符串断言（不碰磁盘），
 * 混在一起会让「哪些用例依赖真实文件系统」这件事变得不明显。
 */
describe('pathJail symlink 逃逸', () => {
  let tmpDir: string;
  let outsideDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'echoly-jail-'));
    outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'echoly-outside-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  it('工作区内的软链指向外部目录时 assertRealPathInside 抛错', async () => {
    const secret = path.join(outsideDir, 'hosts');
    await fs.writeFile(secret, 'top-secret');
    await fs.symlink(outsideDir, path.join(tmpDir, 'escape'));

    await expect(
      assertRealPathInside(tmpDir, path.join(tmpDir, 'escape', 'hosts')),
    ).rejects.toThrow(PathJailError);
  });

  it('软链路径下**尚未存在**的文件同样被挡（写入前就要拦）', async () => {
    await fs.symlink(outsideDir, path.join(tmpDir, 'escape'));

    await expect(
      assertRealPathInside(tmpDir, path.join(tmpDir, 'escape', 'newdir', 'new.txt')),
    ).rejects.toThrow(PathJailError);
  });

  it('工作区内的普通路径不受影响', async () => {
    await fs.mkdir(path.join(tmpDir, 'src'));
    await fs.writeFile(path.join(tmpDir, 'src', 'a.ts'), 'x');
    await expect(
      assertRealPathInside(tmpDir, path.join(tmpDir, 'src', 'a.ts')),
    ).resolves.toBeUndefined();
  });

  it('指向工作区**内部**的软链是允许的', async () => {
    await fs.mkdir(path.join(tmpDir, 'real'));
    await fs.writeFile(path.join(tmpDir, 'real', 'a.ts'), 'x');
    await fs.symlink(path.join(tmpDir, 'real'), path.join(tmpDir, 'alias'));

    await expect(
      assertRealPathInside(tmpDir, path.join(tmpDir, 'alias', 'a.ts')),
    ).resolves.toBeUndefined();
  });

  it('LocalFsBackend.readFile 拒绝走软链读出工作区外的文件', async () => {
    await fs.writeFile(path.join(outsideDir, 'hosts'), 'top-secret');
    await fs.symlink(outsideDir, path.join(tmpDir, 'escape'));
    const backend = new LocalFsBackend(tmpDir);

    await expect(backend.readFile('escape/hosts')).rejects.toThrow(PathJailError);
  });

  it('LocalFsBackend.writeFile 拒绝通过软链写到工作区外', async () => {
    await fs.symlink(outsideDir, path.join(tmpDir, 'escape'));
    const backend = new LocalFsBackend(tmpDir);

    await expect(backend.writeFile('escape/pwned.txt', 'x')).rejects.toThrow(PathJailError);
    expect(await fs.readdir(outsideDir)).toEqual([]);
  });

  it('LocalFsBackend.exists 不再对绝对路径放行', async () => {
    const backend = new LocalFsBackend(tmpDir);
    // 早先这里有一条 `path.isAbsolute` 分支直接 fs.access，等于任意路径探针。
    expect(await backend.exists('/etc/hosts')).toBe(false);
    expect(await backend.exists('../outside')).toBe(false);
  });

  it('工作区根不是软链时，根自身可被写入', async () => {
    const backend = new LocalFsBackend(tmpDir);
    await backend.writeFile('hello.txt', 'hi');
    expect(await fs.readFile(path.join(tmpDir, 'hello.txt'), 'utf8')).toBe('hi');
  });
});

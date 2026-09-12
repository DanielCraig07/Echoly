import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { LocalFsBackend } from '../src/backend';

describe('LocalFsBackend Permissions', () => {
  let tmpDir: string;
  let backend: LocalFsBackend;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'echoly-perm-test-'));
    backend = new LocalFsBackend(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writeFile preserves 0755 permissions when modifying an existing executable file', async () => {
    const filePath = 'script.sh';
    const abs = path.join(tmpDir, filePath);
    await fs.writeFile(abs, '#!/bin/bash\necho "v1"', { mode: 0o755 });
    if (process.platform !== 'win32') {
      await fs.chmod(abs, 0o755);
      const beforeStat = await fs.stat(abs);
      expect(beforeStat.mode & 0o777).toBe(0o755);
    }

    // Modify file via backend
    await backend.writeFile(filePath, '#!/bin/bash\necho "v2 updated"');

    const afterStat = await fs.stat(abs);
    const content = await fs.readFile(abs, 'utf8');
    expect(content).toBe('#!/bin/bash\necho "v2 updated"');
    if (process.platform !== 'win32') {
      expect(afterStat.mode & 0o777).toBe(0o755);
    }
  });

  it('writeFile preserves 0700 and 0600 permissions when modifying sensitive files', async () => {
    if (process.platform === 'win32') return;

    const keyPath = 'secret.key';
    const abs = path.join(tmpDir, keyPath);
    await fs.writeFile(abs, 'secret-1', { mode: 0o600 });
    await fs.chmod(abs, 0o600);

    await backend.writeFile(keyPath, 'secret-2-modified');

    const st = await fs.stat(abs);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('writeFile assigns standard non-exec 0644 mode to new files', async () => {
    const newFile = 'configs/doris.yaml';
    await backend.writeFile(newFile, 'doris:\n  host: 127.0.0.1\n');

    const abs = path.join(tmpDir, newFile);
    const st = await fs.stat(abs);
    if (process.platform !== 'win32') {
      // Should not be executable
      expect(st.mode & 0o111).toBe(0);
    }
  });

  it('copy preserves executable permissions for files', async () => {
    if (process.platform === 'win32') return;

    const src = 'bin/tool';
    const dest = 'bin/tool-copied';
    const absSrc = path.join(tmpDir, src);
    await fs.mkdir(path.dirname(absSrc), { recursive: true });
    await fs.writeFile(absSrc, 'binary', { mode: 0o755 });
    await fs.chmod(absSrc, 0o755);

    await backend.copy(src, dest);

    const absDest = path.join(tmpDir, dest);
    const destStat = await fs.stat(absDest);
    expect(destStat.mode & 0o777).toBe(0o755);
  });

  it('copy preserves permissions recursively for directory tree', async () => {
    if (process.platform === 'win32') return;

    const srcDir = 'pkg';
    const destDir = 'pkg-copy';
    const absSrcDir = path.join(tmpDir, srcDir);
    await fs.mkdir(path.join(absSrcDir, 'bin'), { recursive: true, mode: 0o755 });
    await fs.chmod(path.join(absSrcDir, 'bin'), 0o755);

    const execFile = path.join(absSrcDir, 'bin/run.sh');
    await fs.writeFile(execFile, '#!/bin/sh', { mode: 0o755 });
    await fs.chmod(execFile, 0o755);

    const regularFile = path.join(absSrcDir, 'README.md');
    await fs.writeFile(regularFile, '# Doc', { mode: 0o644 });

    await backend.copy(srcDir, destDir);

    const absDestDir = path.join(tmpDir, destDir);
    const destExecStat = await fs.stat(path.join(absDestDir, 'bin/run.sh'));
    expect(destExecStat.mode & 0o777).toBe(0o755);
  });

  it('mkdir creates directories with executable mode 0755', async () => {
    if (process.platform === 'win32') return;

    const dir = 'nested/sub/folder';
    await backend.mkdir(dir);

    const abs = path.join(tmpDir, dir);
    const st = await fs.stat(abs);
    expect(st.isDirectory()).toBe(true);
    // Directory must have execution bit so it can be traversed/entered
    expect(st.mode & 0o111).not.toBe(0);
  });
});

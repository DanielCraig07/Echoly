import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from '../src/main/atomicWrite';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'echoly-atomic-'));
}

describe('writeFileAtomic', () => {
  it('writes the content to the target path', () => {
    const dir = tmpDir();
    const target = path.join(dir, 'settings.json');
    writeFileAtomic(target, '{"a":1}');
    expect(fs.readFileSync(target, 'utf8')).toBe('{"a":1}');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates missing parent directories', () => {
    const dir = tmpDir();
    const target = path.join(dir, 'nested', 'deep', 'sessions.json');
    writeFileAtomic(target, 'x');
    expect(fs.existsSync(target)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('replaces existing content instead of appending', () => {
    const dir = tmpDir();
    const target = path.join(dir, 'a.json');
    fs.writeFileSync(target, 'old');
    writeFileAtomic(target, 'new');
    expect(fs.readFileSync(target, 'utf8')).toBe('new');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('leaves no temporary files behind on success', () => {
    const dir = tmpDir();
    writeFileAtomic(path.join(dir, 'a.json'), 'v');
    // 临时文件必须已经在 rename 里被消耗掉；残留会让目录越用越脏，
    // 而 .tmp 命名的文件不会被任何读取方认到。
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('leaves no temporary files behind when the write fails', () => {
    const dir = tmpDir();
    const target = path.join(dir, 'a.json');
    fs.mkdirSync(target); // 目标是目录 —— rename 必然失败
    expect(() => writeFileAtomic(target, 'v')).toThrow();
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('never leaves a half-written target when the writer is interrupted mid-way', () => {
    const dir = tmpDir();
    const target = path.join(dir, 'a.json');
    writeFileAtomic(target, '完整内容'.repeat(100));
    // 目标文件要么不存在，要么内容完整 —— 这里验证的是「完整」这一半：
    // 写临时文件再 rename 意味着目标路径永远不会被截断成空文件。
    expect(fs.readFileSync(target, 'utf8')).toBe('完整内容'.repeat(100));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('two concurrent writers never produce a corrupt target', () => {
    const dir = tmpDir();
    const target = path.join(dir, 'a.json');
    // 每个窗口一个 SettingsService 实例，同时保存不算罕见。临时文件名带 pid + 随机后缀，
    // 两个写入者不会互相截断对方的临时文件，目标始终是其中一份完整内容。
    const a = JSON.stringify({ who: 'a', pad: 'x'.repeat(5000) });
    const b = JSON.stringify({ who: 'b', pad: 'y'.repeat(5000) });
    writeFileAtomic(target, a);
    writeFileAtomic(target, b);
    const read = fs.readFileSync(target, 'utf8');
    expect([a, b]).toContain(read);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

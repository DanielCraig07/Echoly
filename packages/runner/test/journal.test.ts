import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobJournal } from '../src/journal';

/**
 * 任务日志。
 *
 * 这里最值得盯的两点，都是「本地跑不出来、到远端才现形」的类型：
 * 1. **append 的串行性**：不 await 连发多条时，seq 与落盘顺序必须一致。
 *    本地磁盘上几乎总能侥幸正确，远端高延迟通道上会错位 —— 而错位不报错。
 * 2. **收尾不能抹掉身份**：meta 是整份重写的，缺字段会让 IDE 认不出这条任务。
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'echoly-journal-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function paths() {
  return {
    meta: path.join(dir, 'job.meta.json'),
    events: path.join(dir, 'job.jsonl'),
    cancel: path.join(dir, 'job.cancel'),
  };
}

function readLines(file: string): unknown[] {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

describe('JobJournal', () => {
  const base = {
    jobId: 'a1b2c3d4-1111-2222-3333-444455556666',
    workspace: '/srv/app',
    runnerVersion: '1',
    nodeVersion: 'v20.11.0',
    pid: 4242,
  };

  it('start 立刻写出 running 的 meta（IDE 需要马上看到「在跑」）', async () => {
    const journal = new JobJournal(paths(), () => 1000);
    await journal.start(base);
    const meta = JSON.parse(readFileSync(paths().meta, 'utf8'));
    expect(meta).toMatchObject({
      jobId: base.jobId,
      pid: 4242,
      status: 'running',
      workspace: '/srv/app',
      startedAt: 1000,
      sequence: 0,
      runnerVersion: '1',
    });
  });

  it('seq 从 1 开始逐条递增，且第 N 行就是第 N 条', async () => {
    const journal = new JobJournal(paths(), () => 5);
    await journal.start(base);
    await journal.append({ type: 'status', status: 'thinking' });
    await journal.append({ type: 'token', text: 'a' });
    await journal.append({ type: 'token', text: 'b' });

    const lines = readLines(paths().events) as { seq: number; event: { text?: string } }[];
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3]);
    expect(lines.map((l) => l.event.text)).toEqual([undefined, 'a', 'b']);
    expect(journal.sequence).toBe(3);
  });

  it('不 await 连发时，seq 与落盘顺序仍然一致（串行化）', async () => {
    const journal = new JobJournal(paths(), () => 7);
    await journal.start(base);
    // 50 条一起发，故意不逐条 await
    const all = Array.from({ length: 50 }, (_, i) =>
      journal.append({ type: 'token', text: `t${i}` }),
    );
    await Promise.all(all);

    const lines = readLines(paths().events) as { seq: number; event: { text: string } }[];
    expect(lines).toHaveLength(50);
    expect(lines.map((l) => l.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    // 顺序也必须对得上：seq=K 的那条内容就是 t(K-1)
    for (const line of lines) expect(line.event.text).toBe(`t${line.seq - 1}`);
  });

  it('收尾写入终态、摘要与最终 seq，并保留 jobId / workspace', async () => {
    const journal = new JobJournal(paths(), () => 2000);
    await journal.start(base);
    await journal.append({ type: 'token', text: 'x' });
    await journal.finish(base, 'done', { summary: '改完了' });

    const meta = JSON.parse(readFileSync(paths().meta, 'utf8'));
    expect(meta).toMatchObject({
      jobId: base.jobId,
      workspace: '/srv/app',
      status: 'done',
      sequence: 1,
      finishedAt: 2000,
      summary: '改完了',
      runnerVersion: '1',
    });
    expect(meta.error).toBeUndefined();
  });

  it('收尾会记录错误', async () => {
    const journal = new JobJournal(paths(), () => 3000);
    await journal.start(base);
    await journal.finish(base, 'error', { error: '模型不可用' });
    const meta = JSON.parse(readFileSync(paths().meta, 'utf8'));
    expect(meta.status).toBe('error');
    expect(meta.error).toBe('模型不可用');
  });

  it('收尾前会把排队中的追加全部落盘（不能丢最后几条事件）', async () => {
    const journal = new JobJournal(paths(), () => 1);
    await journal.start(base);
    for (let i = 0; i < 10; i += 1) void journal.append({ type: 'token', text: `t${i}` });
    await journal.finish(base, 'done');
    const meta = JSON.parse(readFileSync(paths().meta, 'utf8'));
    expect(readLines(paths().events)).toHaveLength(10);
    expect(meta.sequence).toBe(10);
  });

  it('meta 写入是原子的：不会留下半截内容', async () => {
    const journal = new JobJournal(paths(), () => 1);
    await journal.start(base);
    await journal.finish(base, 'done');
    // 临时文件必须被 rename 掉，不能残留
    expect(() => readFileSync(`${paths().meta}.tmp`, 'utf8')).toThrow();
    // 而且任何时刻读到的都是完整 JSON
    expect(() => JSON.parse(readFileSync(paths().meta, 'utf8'))).not.toThrow();
  });

  it('取消标记：文件存在即为已取消', async () => {
    const journal = new JobJournal(paths(), () => 1);
    await journal.start(base);
    expect(journal.isCancelled()).toBe(false);
    writeFileSync(paths().cancel, '', 'utf8');
    expect(journal.isCancelled()).toBe(true);
  });

  it('start 会清空上一轮的事件（否则 seq 从 1 重来但文件里还是旧行）', async () => {
    const first = new JobJournal(paths(), () => 1);
    await first.start(base);
    await first.append({ type: 'token', text: '上一轮' });
    await first.finish(base, 'done');
    expect(readLines(paths().events)).toHaveLength(1);

    // 同一个 jobId 再跑一次：事件必须从第 1 行重新开始，不能叠加
    const second = new JobJournal(paths(), () => 2);
    await second.start(base);
    await second.append({ type: 'token', text: '这一轮' });
    const lines = readLines(paths().events) as { seq: number; event: { text: string } }[];
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ seq: 1, event: { text: '这一轮' } });
  });

  it('start 不动 cancel 标记（投递与启动之间来的取消不能被吞掉）', async () => {
    writeFileSync(paths().cancel, '', 'utf8');
    const journal = new JobJournal(paths(), () => 1);
    await journal.start(base);
    expect(journal.isCancelled()).toBe(true);
  });

  it('start 会建出父目录（任务目录可能还不存在）', async () => {
    const nested = {
      meta: path.join(dir, 'deep', 'nested', 'job.meta.json'),
      events: path.join(dir, 'deep', 'nested', 'job.jsonl'),
      cancel: path.join(dir, 'deep', 'nested', 'job.cancel'),
    };
    const journal = new JobJournal(nested, () => 1);
    await journal.start(base);
    await journal.append({ type: 'token', text: 'a' });
    expect(readLines(nested.events)).toHaveLength(1);
  });
});

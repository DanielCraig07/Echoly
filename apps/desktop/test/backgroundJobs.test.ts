import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BackgroundJob, BackgroundJobEntry } from '@deepseek-ide/shared';
import {
  BackgroundJobStore,
  MAX_TRANSCRIPT,
  appendEntry,
  finalizeJob,
  isFinished,
  normalizeJobs,
  pruneJobs,
  summarizePrompt,
  summarizeText,
} from '../src/main/backgroundJobs';

function makeJob(over: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    id: 'run-1',
    title: '做点什么',
    status: 'running',
    startedAt: 1_000,
    transcript: [],
    ...over,
  };
}

describe('backgroundJobs 纯逻辑', () => {
  it('summarizePrompt 取第一行、压掉空白，空提示词有兜底', () => {
    expect(summarizePrompt('\n\n  修一下登录  令牌刷新\n第二行不要')).toBe('修一下登录 令牌刷新');
    expect(summarizePrompt('   ')).toBe('(未命名任务)');
    expect(summarizePrompt('x'.repeat(100)).length).toBe(80);
  });

  it('summarizeText 压平换行并截断', () => {
    expect(summarizeText('a\n\nb   c')).toBe('a b c');
    expect(summarizeText('y'.repeat(500)).endsWith('…')).toBe(true);
  });

  it('appendEntry 从头部裁剪，尾部（结论）保留', () => {
    let t: BackgroundJobEntry[] = [];
    for (let i = 0; i < MAX_TRANSCRIPT + 5; i++) {
      t = appendEntry(t, { at: i, kind: 'status', text: `第 ${i} 条` });
    }
    expect(t).toHaveLength(MAX_TRANSCRIPT);
    expect(t[t.length - 1].text).toBe(`第 ${MAX_TRANSCRIPT + 4} 条`);
    expect(t[0].text).toBe('第 5 条');
  });

  it('finalizeJob 只能把 running 收敛到终态，后到的终态不覆盖已有结论', () => {
    const running = makeJob();
    const done = finalizeJob(running, 'done', { summary: '全部改完' }, 2_000);
    expect(done.status).toBe('done');
    expect(done.endedAt).toBe(2_000);
    expect(done.summary).toBe('全部改完');

    // 异常路径上 error 可能晚于 done 到达，不能把 done 改掉
    const again = finalizeJob(done, 'error', { error: '迟到的错误' }, 3_000);
    expect(again).toBe(done);
  });

  it('isFinished 只把 running 之外都算结束', () => {
    expect(isFinished('running')).toBe(false);
    for (const s of ['done', 'error', 'cancelled'] as const) expect(isFinished(s)).toBe(true);
  });

  it('pruneJobs 保留运行中的任务，丢弃过期的已结束任务，并按数量截断', () => {
    const now = 10 * 24 * 60 * 60 * 1000;
    const old = finalizeJob(makeJob({ id: 'old', startedAt: 0 }), 'done', {}, 1_000);
    const fresh = finalizeJob(makeJob({ id: 'fresh', startedAt: now - 1_000 }), 'done', {}, now);
    const running = makeJob({ id: 'running', startedAt: 0 });
    const kept = pruneJobs([old, fresh, running], now);
    expect(kept.map((j) => j.id).sort()).toEqual(['fresh', 'running']);

    const many = Array.from({ length: 40 }, (_, i) => makeJob({ id: `j${i}`, startedAt: i }));
    expect(pruneJobs(many, now, { max: 5 })).toHaveLength(5);
  });

  it('pruneJobs 把运行中的任务排在最前', () => {
    const running = makeJob({ id: 'a', startedAt: 1 });
    const done = finalizeJob(makeJob({ id: 'b', startedAt: 999 }), 'done', {}, 1_000);
    expect(pruneJobs([done, running], 1_100).map((j) => j.id)).toEqual(['a', 'b']);
  });

  it('normalizeJobs 丢弃坏条目、补默认值', () => {
    const jobs = normalizeJobs([
      null,
      { id: '' },
      'nope',
      { id: 'ok' },
      { id: 'x', status: '乱写', transcript: [{ text: 'hi' }, { nope: 1 }] },
    ]);
    expect(jobs.map((j) => j.id)).toEqual(['ok', 'x']);
    expect(jobs[0].status).toBe('running');
    expect(jobs[0].title).toBe('(未命名任务)');
    expect(jobs[1].status).toBe('running');
    expect(jobs[1].transcript).toEqual([{ text: 'hi' }]);
  });
});

describe('BackgroundJobStore 持久化', () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('upsert 落盘后能被新实例读回来', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'echoly-bgjobs-'));
    const file = path.join(dir, 'background-jobs.json');
    const store = new BackgroundJobStore(file);
    await store.load();
    await store.upsert(makeJob({ id: 'a', title: '任务 A' }));

    const reopened = new BackgroundJobStore(file);
    await reopened.load();
    expect(reopened.get('a')?.title).toBe('任务 A');
  });

  it('重启时把残留的 running 收成 cancelled（上次进程被杀）', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'echoly-bgjobs-'));
    const file = path.join(dir, 'background-jobs.json');
    await writeFile(file, JSON.stringify([makeJob({ id: 'stale' })]), 'utf8');

    const store = new BackgroundJobStore(file);
    await store.load();
    const job = store.get('stale');
    expect(job?.status).toBe('cancelled');
    expect(job?.summary).toBe('应用已退出，任务未完成');
  });

  it('文件损坏时退化为空列表而不是抛错', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'echoly-bgjobs-'));
    const file = path.join(dir, 'background-jobs.json');
    await writeFile(file, '{ not json', 'utf8');
    const store = new BackgroundJobStore(file);
    await store.load();
    expect(store.list()).toEqual([]);
  });

  it('clearFinished 只清已结束的，运行中的留下', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'echoly-bgjobs-'));
    const file = path.join(dir, 'background-jobs.json');
    const store = new BackgroundJobStore(file);
    await store.load();
    await store.upsert(makeJob({ id: 'running' }));
    await store.upsert(finalizeJob(makeJob({ id: 'done' }), 'done', {}, 2_000));
    const left = await store.clearFinished();
    expect(left.map((j) => j.id)).toEqual(['running']);
  });
});

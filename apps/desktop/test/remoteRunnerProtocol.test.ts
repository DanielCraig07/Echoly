import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MIN_REMOTE_NODE_MAJOR,
  START_GRACE_MS,
  buildCancelCommand,
  buildLaunchCommand,
  buildLaunchScript,
  buildPidAliveCommand,
  buildPrepareCommand,
  buildProbeCommand,
  buildRemoveJobCommand,
  buildTailEventsCommand,
  deriveRemoteStatus,
  isRemoteTerminal,
  isSafeJobId,
  parseEventOutput,
  parseMeta,
  parsePidAliveOutput,
  parseProbeOutput,
  quoted,
  remotePaths,
  shellQuote,
  summaryFromEvents,
} from '../src/main/remoteRunner/protocol';

/**
 * 远端 runner 的协议层。
 *
 * 这一层的两种错都不会在本地报错，只会在用户的服务器上出问题，所以测试重点也在这两处：
 * 1. **命令注入**：拿恶意串去撞 `shellQuote`，并且**真的丢给 `sh` 跑一遍**看能否原样还原 ——
 *    只对字符串做断言的话，「看起来转义了」和「实际转义了」是两回事。
 * 2. **增量读回的边界**：`tail -n +K` 的行号算法，以及「末行可能是半行」的处理。
 */

const JOB = 'a1b2c3d4-1111-2222-3333-444455556666';

/** 本机能否用 POSIX sh 做真机验证（Windows 上跳过）。 */
const canRunSh = process.platform !== 'win32';

describe('jobId 是安全边界', () => {
  it('接受我们生成的形状（uuid）', () => {
    expect(isSafeJobId(JOB)).toBe(true);
    expect(isSafeJobId('probe-0000')).toBe(true);
  });

  it('拒绝一切可能拼出路径穿越或注入的形状', () => {
    for (const bad of [
      '',
      'short',
      '../../etc/passwd',
      'a/b',
      'a\\b',
      'a b',
      "a'; rm -rf ~ #",
      'a"b',
      'A1B2C3D4-1111',
      '.hidden-x',
      'x'.repeat(65),
    ]) {
      expect(isSafeJobId(bad), bad).toBe(false);
      expect(() => remotePaths(bad), bad).toThrow();
    }
  });
});

describe('shellQuote：真的丢给 sh 跑一遍', () => {
  const nasty = [
    "a'b",
    "'; rm -rf ~ #",
    '$(whoami)',
    '`whoami`',
    'a\nb',
    'a\\b',
    '中文 with spaces',
    '',
    '$HOME',
    '*',
    'a"b',
    "it's a 'test' \"quoted\"",
  ];

  it('转义后作为单个参数原样还原', () => {
    if (!canRunSh) return;
    for (const value of nasty) {
      // printf %s <quoted>：能原样打印出来就说明引号闭合正确、没被拆成多个参数
      const out = execFileSync('sh', ['-c', `printf %s ${shellQuote(value)}`], {
        encoding: 'utf8',
      });
      expect(out, JSON.stringify(value)).toBe(value);
    }
  });

  it('输出一定是成对的单引号，内部单引号被断开重接', () => {
    expect(shellQuote('plain')).toBe("'plain'");
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
    for (const value of nasty) {
      const q = shellQuote(value);
      expect(q.startsWith("'")).toBe(true);
      expect(q.endsWith("'")).toBe(true);
    }
  });
});

describe('远端路径与命令构造', () => {
  it('路径基于 $HOME，且不含引号（否则 quoted 会抛）', () => {
    const p = remotePaths(JOB);
    expect(p.meta).toBe(`$HOME/.echoly/runner/jobs/${JOB}.meta.json`);
    expect(p.events.endsWith(`${JOB}.jsonl`)).toBe(true);
    for (const value of Object.values(p)) expect(() => quoted(value)).not.toThrow();
  });

  it('体检命令同时问 Node 与 runner 校验和', () => {
    const cmd = buildProbeCommand();
    expect(cmd).toContain('ECHOLY_NODE_MISSING');
    expect(cmd).toContain('NODE_VERSION=');
    expect(cmd).toContain('RUNNER_SHA=');
    // sha256sum 与 shasum 都得试：GNU 与 BSD 各有一个
    expect(cmd).toContain('sha256sum');
    expect(cmd).toContain('shasum -a 256');
  });

  it('准备工作会清掉同名任务的残留（否则会读到上一轮的事件）', () => {
    const cmd = buildPrepareCommand(JOB);
    expect(cmd).toContain('mkdir -p');
    expect(cmd).toContain(`${JOB}.meta.json`);
    expect(cmd).toContain(`${JOB}.jsonl`);
    expect(cmd).toContain(`${JOB}.cancel`);
    expect(cmd).toContain('rm -f');
  });

  it('进度读取用 tail -n +(seq+1)，起始为 1', () => {
    expect(buildTailEventsCommand(JOB, 0)).toContain('tail -n +1');
    expect(buildTailEventsCommand(JOB, 5)).toContain('tail -n +6');
    // 负数/小数不该造出 tail -n +0 这种会被当成「最后 0 行」的写法
    expect(buildTailEventsCommand(JOB, -3)).toContain('tail -n +1');
    expect(buildTailEventsCommand(JOB, 2.7)).toContain('tail -n +3');
  });

  it('pid 校验：只接受正整数', () => {
    expect(buildPidAliveCommand(1234)).toContain('kill -0 1234');
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => buildPidAliveCommand(bad as number)).toThrow();
    }
  });

  it('取消：先落标记再发信号', () => {
    const withPid = buildCancelCommand(JOB, 4321);
    expect(withPid.indexOf('touch')).toBeLessThan(withPid.indexOf('kill -TERM 4321'));
    const noPid = buildCancelCommand(JOB);
    expect(noPid).toContain('touch');
    expect(noPid).not.toContain('kill');
  });

  it('清理命令覆盖任务的全部文件', () => {
    const cmd = buildRemoveJobCommand(JOB);
    for (const suffix of ['meta.json', 'jsonl', 'config.json', 'cancel', 'log', 'launch.sh']) {
      expect(cmd).toContain(`${JOB}.${suffix}`);
    }
  });

  it('quoted 拒绝含双引号的表达式', () => {
    expect(() => quoted('a"b')).toThrow();
  });
});

describe('启动脚本', () => {
  it('解绑（nohup + 重定向 + 后台）并检查前置文件', () => {
    const script = buildLaunchScript(JOB, '/srv/app');
    expect(script).toContain("cd '/srv/app'");
    expect(script).toContain('nohup node');
    expect(script).toContain('</dev/null');
    expect(script).toContain('>>"$LOG" 2>&1 &');
    expect(script).toContain('ECHOLY_LAUNCH_RUNNER_MISSING');
    expect(script).toContain('ECHOLY_LAUNCH_CONFIG_MISSING');
    expect(script).toContain('exit 0');
    // 脚本内引用 runner/config 时用双引号，$HOME 才能展开
    expect(script).toContain('RUNNER="$HOME/.echoly/runner/echoly-runner.mjs"');
  });

  it('工作目录里的特殊字符被单引号包住', () => {
    const script = buildLaunchScript(JOB, "/srv/my app's dir");
    expect(script).toContain("cd '/srv/my app'\\''s dir'");
  });

  it('生成的脚本是合法 POSIX sh（拿 sh -n 真机校验）', () => {
    if (!canRunSh) return;
    const dir = mkdtempSync(path.join(tmpdir(), 'echoly-launch-'));
    try {
      for (const workspace of ['/srv/app', "/srv/my app's dir", '/srv/a"b', '/带 空格/中文']) {
        const file = path.join(dir, 'launch.sh');
        writeFileSync(file, buildLaunchScript(JOB, workspace), 'utf8');
        // sh -n 只做语法检查、不执行 —— 这里要的正是「远端能不能解析这个脚本」
        expect(() =>
          execFileSync('sh', ['-n', file], { stdio: 'pipe', encoding: 'utf8' }),
        ).not.toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('启动命令只是 sh 那个脚本', () => {
    expect(buildLaunchCommand(JOB)).toBe(`sh "$HOME/.echoly/runner/jobs/${JOB}.launch.sh"`);
  });
});

describe('解析远端输出', () => {
  it('体检：Node 缺失', () => {
    expect(parseProbeOutput('ECHOLY_NODE_MISSING')).toEqual({ nodeMissing: true });
  });

  it('体检：正常输出（含 sha 与版本）', () => {
    const out = parseProbeOutput('NODE_VERSION=v20.11.0\nRUNNER_SHA=deadbeef\n');
    expect(out.nodeMissing).toBe(false);
    expect(out.nodeVersion).toBe('v20.11.0');
    expect(out.nodeMajor).toBe(MIN_REMOTE_NODE_MAJOR);
    expect(out.runnerSha).toBe('deadbeef');
  });

  it('体检：runner 还不存在时 sha 为空（而不是崩掉）', () => {
    const out = parseProbeOutput('NODE_VERSION=v22.1.0\nRUNNER_SHA=\n');
    expect(out.runnerSha).toBeUndefined();
    expect(out.nodeMajor).toBe(22);
  });

  it('pid 存活解析', () => {
    expect(parsePidAliveOutput('ECHOLY_ALIVE')).toBe(true);
    expect(parsePidAliveOutput('ECHOLY_DEAD')).toBe(false);
    expect(parsePidAliveOutput('莫名其妙')).toBeNull();
  });

  it('meta：正常 / 缺失 / 半截 JSON 都不抛错', () => {
    const meta = parseMeta(
      JSON.stringify({
        jobId: JOB,
        pid: 123,
        status: 'running',
        workspace: '/srv/app',
        startedAt: 1,
        sequence: 7,
        runnerVersion: '1',
      }),
    );
    expect(meta?.pid).toBe(123);
    expect(meta?.sequence).toBe(7);

    expect(parseMeta('ECHOLY_NO_META')).toBeNull();
    expect(parseMeta('')).toBeNull();
    expect(parseMeta(null)).toBeNull();
    // runner 正写到一半就被读走
    expect(parseMeta('{"jobId":"a1b2c3d4-1111-2222-3333-4444')).toBeNull();
    // 字段不够
    expect(parseMeta('{"status":"running"}')).toBeNull();
  });
});

describe('事件流解析与续读边界', () => {
  const event = (seq: number): string =>
    JSON.stringify({ seq, at: seq * 10, event: { type: 'token', text: `t${seq}` } });

  it('丢掉不完整的末行（runner 正在写）', () => {
    const stdout = `${event(1)}\n${event(2)}\n{"seq":3,"at":30,"event":{"ty`;
    expect(parseEventOutput(stdout).map((e) => e.seq)).toEqual([1, 2]);
  });

  it('以换行结尾时全部保留', () => {
    expect(parseEventOutput(`${event(1)}\n${event(2)}\n`).map((e) => e.seq)).toEqual([1, 2]);
  });

  it('跳过坏行而不是整批失败', () => {
    const stdout = `${event(1)}\n不是 JSON\n\n${event(2)}\n`;
    expect(parseEventOutput(stdout).map((e) => e.seq)).toEqual([1, 2]);
  });

  it('空输入返回空数组', () => {
    expect(parseEventOutput('')).toEqual([]);
    expect(parseEventOutput('\n')).toEqual([]);
  });

  it('seq 一致：第 N 行就是第 seq 条（tail 正递增读的依据）', () => {
    const all = [1, 2, 3, 4, 5].map(event).join('\n').concat('\n');
    const fromSeq = 3;
    const lines = all.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const slice = lines.slice(fromSeq).join('\n').concat('\n');
    expect(parseEventOutput(slice).map((e) => e.seq)).toEqual([4, 5]);
  });
});

describe('状态推断', () => {
  const base = { launchedAt: 1_000, now: 5_000 };
  const running = {
    jobId: JOB,
    pid: 1,
    status: 'running' as const,
    workspace: '/srv/app',
    startedAt: 1_000,
    sequence: 0,
    runnerVersion: '1',
  };

  it('还没写出 meta：宽限期内是 starting', () => {
    expect(deriveRemoteStatus({ meta: null, pidAlive: null, ...base })).toBe('starting');
  });

  it('超过宽限期仍没有 meta：说明压根没起来 → lost', () => {
    expect(
      deriveRemoteStatus({ meta: null, pidAlive: null, launchedAt: 0, now: START_GRACE_MS + 1 }),
    ).toBe('lost');
  });

  it('meta 说在跑且进程在：running', () => {
    expect(deriveRemoteStatus({ meta: running, pidAlive: true, ...base })).toBe('running');
  });

  it('meta 说在跑但进程没了：lost（不能显示成「运行中」，否则用户白等）', () => {
    expect(deriveRemoteStatus({ meta: running, pidAlive: false, ...base })).toBe('lost');
  });

  it('查不到进程状态时不误判为 lost', () => {
    expect(deriveRemoteStatus({ meta: running, pidAlive: null, ...base })).toBe('running');
  });

  it('终态以 meta 为准', () => {
    for (const status of ['done', 'error', 'cancelled'] as const) {
      const meta = { ...running, status };
      expect(deriveRemoteStatus({ meta, pidAlive: false, ...base })).toBe(status);
    }
  });

  it('isRemoteTerminal 把 starting/running 当非终态', () => {
    expect(isRemoteTerminal('starting')).toBe(false);
    expect(isRemoteTerminal('running')).toBe(false);
    for (const s of ['done', 'error', 'cancelled', 'lost'] as const) {
      expect(isRemoteTerminal(s)).toBe(true);
    }
  });
});

describe('收尾摘要', () => {
  const ev = (seq: number, event: unknown) => ({ seq, at: seq, event: event as never });

  it('取最后一条 assistant_message', () => {
    const events = [
      ev(1, { type: 'assistant_message', content: '先看看' }),
      ev(2, { type: 'tool_result', id: 't', name: 'read_file', result: 'x' }),
      ev(3, { type: 'assistant_message', content: '改好了\n共 3 处' }),
    ];
    expect(summaryFromEvents(events)).toBe('改好了 共 3 处');
  });

  it('没有 assistant_message 时用最后一条 error', () => {
    const events = [ev(1, { type: 'error', message: '模型不可用' })];
    expect(summaryFromEvents(events)).toBe('模型不可用');
  });

  it('过长时截断', () => {
    const events = [ev(1, { type: 'assistant_message', content: 'x'.repeat(500) })];
    const summary = summaryFromEvents(events);
    expect(summary?.endsWith('…')).toBe(true);
    expect(summary!.length).toBeLessThanOrEqual(200);
  });

  it('空事件返回 undefined', () => {
    expect(summaryFromEvents([])).toBeUndefined();
  });
});

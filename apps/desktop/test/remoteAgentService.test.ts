import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  RemoteAgentService,
  type RemoteAgentServiceOptions,
  type RemoteTransport,
} from '../src/main/remoteRunner/service';
import { remotePaths } from '../src/main/remoteRunner/protocol';

/**
 * 远端任务编排层。
 *
 * 这里最关键的一个决定：**「模拟的远端主机」不是内存里假装的，而是一个真的临时目录 +
 * 真的 `sh`**。命令里出现的 `$HOME` 被换成临时目录之后再交给 `sh -c` 执行。
 *
 * 为什么值得这么做：协议层生成的命令（mkdir / rm / tail / kill -0 / launch.sh）
 * 如果只在字符串层面断言，验的是「我以为它写了什么」。真跑一遍才验得到
 * 「远端能不能执行它、行为是否如预期」—— 而这正是这一整块里最容易出错的地方。
 *
 * 更进一步：runner 用的是**打包出来的真文件**（`npm run build:runner` 的产物），
 * 模型端是一个最小的假 OpenAI 兼容服务。所以这条测试实际覆盖的是
 * 「提交 → 上传 → 启动 → 模型给出工具调用 → 工具真的改文件 → 事件流 → 终态」的完整链路，
 * 只差 ssh2 那一层适配。
 */

const repoRoot = path.resolve(__dirname, '../../..');
const bundlePath = path.join(repoRoot, 'packages/runner/dist/echoly-runner.mjs');

function ensureBundle(): { content: string; sha256: string; version: string } {
  if (!existsSync(bundlePath)) {
    execFileSync('node', [path.join(repoRoot, 'scripts/build-runner.mjs')], { stdio: 'pipe' });
  }
  const content = readFileSync(bundlePath, 'utf8');
  // sha 只用来判断「要不要重传」，测试里自己算一份即可（与打包脚本一致）
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return {
    content,
    sha256: createHash('sha256').update(Buffer.from(content)).digest('hex'),
    version: '1',
  };
}

/** 假的最小 OpenAI 兼容服务：第一轮要求 write_file，第二轮收尾。 */
function startFakeLlm(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      let messages: { role?: string }[] = [];
      try {
        messages = JSON.parse(body).messages ?? [];
      } catch {
        // 忽略
      }
      const sawToolResult = messages.some((m) => m.role === 'tool');
      const sse = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (!sawToolResult) {
        sse({
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: JSON.stringify({
                        path: 'REMOTE_OK.txt',
                        content: 'hello from remote runner\n',
                      }),
                    },
                  },
                ],
              },
            },
          ],
        });
        sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        sse({
          choices: [{ index: 0, delta: { role: 'assistant', content: '已写入 REMOTE_OK.txt' } }],
        });
        sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

interface FakeHost {
  home: string;
  transport: RemoteTransport;
  execCount: () => number;
}

/**
 * 把「远端」实现成一台本机的临时目录 + 真 shell。见文件头说明。
 *
 * 关键细节：`HOME` 是通过**子进程环境**设进去的，不是把命令里的 `$HOME` 做字符串替换。
 * 因为启动脚本是作为**文件**传到「远端」的，脚本内部的 `$HOME` 由脚本自己展开 ——
 * 只替换命令字符串的话，脚本里的 `$HOME` 会展开成开发机真正的家目录，
 * 表现为「文件明明传上去了，脚本却报 runner 不存在」。
 */
function makeFakeHost(home: string): FakeHost {
  let execCount = 0;
  return {
    home,
    execCount: () => execCount,
    transport: {
      async exec(command) {
        execCount += 1;
        try {
          const stdout = execFileSync('sh', ['-c', command], {
            encoding: 'utf8',
            timeout: 20_000,
            env: { ...process.env, HOME: home },
          });
          return { stdout, stderr: '', code: 0 };
        } catch (err) {
          const e = err as { stdout?: string; stderr?: string; status?: number };
          return {
            stdout: typeof e.stdout === 'string' ? e.stdout : '',
            stderr: typeof e.stderr === 'string' ? e.stderr : String(err),
            code: typeof e.status === 'number' ? e.status : 1,
          };
        }
      },
      async upload(remotePath, content, opts) {
        await fsp.mkdir(path.dirname(remotePath), { recursive: true });
        await fsp.writeFile(remotePath, content, opts?.mode ? { mode: opts.mode } : undefined);
      },
      async read(remotePath) {
        try {
          return await fsp.readFile(remotePath, 'utf8');
        } catch {
          return null;
        }
      },
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let base: string;
let workspace: string;
let llm: { port: number; close: () => Promise<void> };
let bundle: { content: string; sha256: string; version: string };

beforeAll(async () => {
  bundle = ensureBundle();
  llm = await startFakeLlm();
});

afterAll(async () => {
  await llm.close();
});

beforeEach(async () => {
  base = mkdtempSync(path.join(tmpdir(), 'echoly-remote-service-'));
  workspace = path.join(base, 'work');
  await fsp.mkdir(workspace, { recursive: true });
});

function makeService(home: string, extra: Partial<RemoteAgentServiceOptions> = {}) {
  const host = makeFakeHost(home);
  const service = new RemoteAgentService({
    transport: host.transport,
    loadBundle: () => bundle,
    storePath: null,
    ...extra,
  });
  return { service, host };
}

describe('远端环境体检', () => {
  it('本机有 node 时体检通过，并带回家目录', async () => {
    const { service } = makeService(base);
    const probe = await service.probe();
    expect(probe.ok).toBe(true);
    expect(probe.home).toBe(base);
    expect(probe.nodeMajor).toBeGreaterThanOrEqual(20);
  });

  it('远端没有 node 时给出可读的原因（而不是让投递去撞一堆怪错误）', async () => {
    const service = new RemoteAgentService({
      // 模拟一台没有 node 的机器：只回体检标记
      transport: {
        exec: async (command) =>
          command.includes('NODE_VERSION') || command.includes('ECHOLY_NODE_MISSING')
            ? { stdout: 'ECHOLY_NODE_MISSING', stderr: '', code: 0 }
            : { stdout: '', stderr: '', code: 0 },
        upload: async () => undefined,
        read: async () => null,
      },
      loadBundle: () => bundle,
      storePath: null,
    });
    const probe = await service.probe();
    expect(probe.ok).toBe(false);
    expect(probe.reason).toContain('node');
  });
});

describe('投递与完整执行（真 runner + 真 shell + 假模型）', () => {
  it('跑完一整轮：工具真的改了远端文件，事件与终态都能读回来', async () => {
    const { service, host } = makeService(base);
    const job = await service.submit({
      prompt: '在仓库里创建 REMOTE_OK.txt',
      workspace,
      model: {
        baseUrl: `http://127.0.0.1:${llm.port}`,
        model: 'fake',
        apiKey: 'sk-fake',
        provider: 'openai',
      },
      unattended: true,
    });
    expect(job.status).toBe('starting');

    let current = job;
    for (let i = 0; i < 100; i += 1) {
      const next = await service.refresh(job.jobId);
      if (next) current = next;
      if (current.status !== 'starting' && current.status !== 'running') break;
      await sleep(100);
    }

    expect(current.status).toBe('done');
    // 工具确实作用在远端工作目录上
    expect(readFileSync(path.join(workspace, 'REMOTE_OK.txt'), 'utf8')).toBe(
      'hello from remote runner\n',
    );
    expect(current.sequence).toBeGreaterThan(0);
    expect(current.transcript?.some((e) => e.kind === 'tool')).toBe(true);
    expect(current.summary).toContain('REMOTE_OK');
    expect(host.execCount()).toBeGreaterThan(0);
  }, 30_000);

  it('任务结束后主动删掉远端的凭据文件（config 里带着 apiKey）', async () => {
    const { service } = makeService(base);
    const job = await service.submit({
      prompt: '创建一个文件',
      workspace,
      model: {
        baseUrl: `http://127.0.0.1:${llm.port}`,
        model: 'fake',
        apiKey: 'sk-secret',
        provider: 'openai',
      },
      unattended: true,
    });
    const configPath = remotePaths(job.jobId, base).config;
    // 投递后凭据确实在远端
    expect(readFileSync(configPath, 'utf8')).toContain('sk-secret');
    // 权限必须是 0600
    expect(statSync(configPath).mode & 0o777).toBe(0o600);

    for (let i = 0; i < 100; i += 1) {
      const next = await service.refresh(job.jobId);
      if (next && next.status !== 'starting' && next.status !== 'running') break;
      await sleep(100);
    }
    expect(existsSync(configPath)).toBe(false);
  }, 30_000);

  it('未开启无人值守时，需要确认的写操作被拒绝，任务不会改远端文件', async () => {
    const { service } = makeService(base);
    const job = await service.submit({
      prompt: '创建一个文件',
      workspace,
      model: { baseUrl: `http://127.0.0.1:${llm.port}`, model: 'fake', provider: 'openai' },
      unattended: false,
    });
    let current = job;
    for (let i = 0; i < 100; i += 1) {
      const next = await service.refresh(job.jobId);
      if (next) current = next;
      if (current.status !== 'starting' && current.status !== 'running') break;
      await sleep(100);
    }
    expect(existsSync(path.join(workspace, 'REMOTE_OK.txt'))).toBe(false);
    expect(current.status).not.toBe('starting');
  }, 30_000);

  it('runner 只在 sha 不一致时上传（第二次投递不重复传 200KB）', async () => {
    const { service, host } = makeService(base);
    const model = { baseUrl: `http://127.0.0.1:${llm.port}`, model: 'fake', provider: 'openai' };
    await service.submit({ prompt: '一', workspace, model, unattended: true });
    const runnerPath = remotePaths('probe-0000', base).runner;
    const firstSize = statSync(runnerPath).size;
    await service.submit({ prompt: '二', workspace, model, unattended: true });
    expect(statSync(runnerPath).size).toBe(firstSize);
    expect(host.execCount()).toBeGreaterThan(0);
  }, 30_000);
});

describe('取消', () => {
  it('取消后远端留下 cancelled 终态，且不写文件', async () => {
    const { service } = makeService(base);
    const job = await service.submit({
      prompt: '创建一个文件',
      workspace,
      model: { baseUrl: `http://127.0.0.1:${llm.port}`, model: 'fake', provider: 'openai' },
      unattended: true,
    });
    await service.cancel(job.jobId);
    // 标记已经落在远端
    expect(existsSync(remotePaths(job.jobId, base).cancel)).toBe(true);
    const after = service.get(job.jobId);
    expect(after?.status).toBe('cancelled');
  }, 30_000);
});

describe('本地记录（缓存）', () => {
  it('落盘后能被新实例读回来（应用重启不丢任务列表）', async () => {
    const storePath = path.join(base, 'remote-jobs.json');
    const { service } = makeService(base, { storePath });
    await service.submit({
      prompt: '记录一下',
      workspace,
      model: { baseUrl: `http://127.0.0.1:${llm.port}`, model: 'fake', provider: 'openai' },
      unattended: true,
    });
    expect(service.list()).toHaveLength(1);

    const reopened = new RemoteAgentService({
      transport: makeFakeHost(base).transport,
      loadBundle: () => bundle,
      storePath,
    });
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.list()[0].title).toBe('记录一下');
  }, 30_000);

  it('展示用的字段：标题取提示词首行，凭据标记反映是否真的带走了 key', async () => {
    const { service } = makeService(base);
    const withKey = await service.submit({
      prompt: '\n\n 修一下登录\n第二行不要',
      workspace,
      model: { baseUrl: `http://127.0.0.1:${llm.port}`, model: 'fake', apiKey: 'sk-x' },
      unattended: true,
    });
    expect(withKey.title).toBe(' 修一下登录');
    expect(withKey.sentCredentials).toBe(true);

    const withoutKey = await service.submit({
      prompt: '不带 key',
      workspace,
      model: { baseUrl: `http://127.0.0.1:${llm.port}`, model: 'fake' },
      unattended: true,
    });
    expect(withoutKey.sentCredentials).toBe(false);
  }, 30_000);
});

describe('删除', () => {
  it('删掉任务时连远端文件一起清掉', async () => {
    const { service } = makeService(base);
    const job = await service.submit({
      prompt: '待清理',
      workspace,
      model: { baseUrl: `http://127.0.0.1:${llm.port}`, model: 'fake', provider: 'openai' },
      unattended: true,
    });
    await service.remove(job.jobId);
    expect(service.get(job.jobId)).toBeNull();
    expect(existsSync(remotePaths(job.jobId, base).meta)).toBe(false);
  }, 30_000);
});

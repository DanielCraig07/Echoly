#!/usr/bin/env node
/**
 * Echoly 远端 Agent runner。
 *
 * 这个文件**由 IDE 拷到远端主机上执行**，不需要远端有任何本项目代码，也不需要 npm install
 * ——它和它的全部依赖被 esbuild 打成了一个 .mjs。它做的事只有一件：
 * 在这个工作目录里跑一轮 Agent，把事件写进任务目录，让 IDE 事后能读回来。
 *
 * 三条与本地运行不同的硬约束，都是「远端没人看着」带来的：
 *
 * 1. **没有人能回答确认**。需要确认的操作一律**拒绝**（fail closed），除非任务提交时
 *    明确选了无人值守。默认放行会变成绕过权限模型的旁路，而远端恰恰是最容易被忽略的地方。
 * 2. **可能被杀**。用户可能在 IDE 里取消、可能 SSH 断了机器重启、可能 OOM。
 *    所以 meta 先写「在跑」再干活，任何退出路径都要走 `finish` 留下终态；
 *    实在被 -9 杀掉时 IDE 靠 `lost` 兜底（见 IDE 侧 deriveRemoteStatus）。
 * 3. **本地那几个工具宿主不存在**（LSP 诊断 / 代码库索引 / MCP / 文档源）。
 *    这里不注入它们，Agent 会得到明确的「不可用」，而不是一个空的「一切正常」。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runAgent } from '@deepseek-ide/agent';
import { LocalFsBackend } from '@deepseek-ide/tools';
import type { AgentEvent, ConfirmRequest, RemoteRunnerConfig } from '@deepseek-ide/shared';
import { JobJournal, type JournalStartInfo } from './journal.js';
import { buildRemoteSettings } from './settings.js';

/** 与 IDE 侧 protocol.ts 的 REMOTE_RUNNER_VERSION 必须一致（不一致会被重新上传覆盖）。 */
export const RUNNER_VERSION = '1';

/** 取消标记的轮询间隔。取 1s：取消要让人觉得「立刻」，又不值得为它开文件监听。 */
const CANCEL_POLL_MS = 1000;

/** 摘要长度上限，与 IDE 侧的展示一致。 */
const SUMMARY_MAX = 200;

function parseArgs(argv: readonly string[]): { configPath: string } {
  const index = argv.indexOf('--config');
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value) throw new Error('缺少 --config <path>');
  return { configPath: path.resolve(value) };
}

/** 由 config 文件路径反推任务 id —— 配置读坏时也能写出「读不出配置」这条终态。 */
function jobIdFromConfigPath(configPath: string): string {
  return path.basename(configPath).replace(/\.config\.json$/, '');
}

function summarize(text: string): string | undefined {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX - 1)}…` : flat;
}

/** 从事件流里补一个摘要，用于 finalText 为空（例如只调了工具）的情形。 */
function summaryFromEvent(event: AgentEvent): string | undefined {
  if (event.type === 'assistant_message' && event.content?.trim()) return summarize(event.content);
  if (event.type === 'error') return summarize(event.message);
  return undefined;
}

export function journalPathsFor(jobDir: string, jobId: string) {
  return {
    meta: path.join(jobDir, `${jobId}.meta.json`),
    events: path.join(jobDir, `${jobId}.jsonl`),
    cancel: path.join(jobDir, `${jobId}.cancel`),
  };
}

async function main(): Promise<number> {
  const { configPath } = parseArgs(process.argv.slice(2));
  const jobDir = path.dirname(configPath);
  const jobId = jobIdFromConfigPath(configPath);

  let config: RemoteRunnerConfig;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as RemoteRunnerConfig;
  } catch (err) {
    // 连配置都读不出来：仍然尽量留下一条终态，否则 IDE 只能看到一个「lost」
    const journal = new JobJournal(journalPathsFor(jobDir, jobId));
    const info: JournalStartInfo = {
      jobId,
      workspace: '',
      runnerVersion: RUNNER_VERSION,
      nodeVersion: process.version,
    };
    await journal.start(info);
    await journal.finish(info, 'error', {
      error: `无法读取任务配置：${err instanceof Error ? err.message : String(err)}`,
    });
    return 1;
  }

  const startInfo: JournalStartInfo = {
    jobId: config.jobId || jobId,
    workspace: config.workspace,
    runnerVersion: RUNNER_VERSION,
    nodeVersion: process.version,
  };
  const journal = new JobJournal(journalPathsFor(jobDir, startInfo.jobId));
  await journal.start(startInfo);

  // 工作目录不存在是**配置错误**，不是运行期错误：明确写出来，比让 Agent 去撞一堆 ENOENT 强
  if (!config.workspace || !fs.existsSync(config.workspace)) {
    await journal.finish(startInfo, 'error', {
      error: `远端工作目录不存在：${config.workspace || '(空)'}`,
    });
    return 1;
  }

  const controller = new AbortController();
  let stopRequested = false;
  const requestStop = (): void => {
    if (stopRequested) return;
    stopRequested = true;
    controller.abort();
  };
  /**
   * 取消标记的检查在这里出现三次，缺一不可（都来自实测踩到的坑）：
   *
   * 1. **启动前查一次**。用户可能在投递与启动之间就按了取消；只靠轮询的话，
   *    任务会一路跑完 —— 实测一个 30ms 就跑完的任务，1s 的轮询根本来不及看到标记。
   * 2. **每条事件查一次**。事件流是任务真正在推进的证据，也是比定时器更敏感的位置。
   * 3. **定时器兜底**。卡在一次长模型请求里时没有任何事件，只有定时器能发现取消。
   *
   * 三条都是「文件存在即取消」，开销是一次 stat，可以放心放在热路径上。
   */
  if (journal.isCancelled()) {
    await journal.finish(startInfo, 'cancelled', { summary: '已按请求取消' });
    return 0;
  }
  const cancelTimer = setInterval(() => {
    if (journal.isCancelled()) requestStop();
  }, CANCEL_POLL_MS);
  process.on('SIGTERM', requestStop);
  process.on('SIGINT', requestStop);

  let finalText = '';
  let failure: string | undefined;
  let lastSummary: string | undefined;

  try {
    const result = await runAgent({
      prompt: config.prompt,
      workspaceRoot: config.workspace,
      settings: buildRemoteSettings(config),
      mode: 'agent',
      backend: new LocalFsBackend(config.workspace),
      runId: config.jobId,
      rulesText: config.rulesText,
      skillsText: config.skillsText,
      signal: controller.signal,
      onEvent: (event) => {
        const summary = summaryFromEvent(event);
        if (summary) lastSummary = summary;
        // 见上面第 2 条：比定时器更早发现取消
        if (!stopRequested && journal.isCancelled()) requestStop();
        // 不 await：事件的落盘顺序由 journal 内部串行化，这里 await 只会拖慢 Agent
        void journal.append(event);
      },
      /**
       * 远端没有人能回答确认。
       *
       * 无人值守时放行；否则**拒绝**，并把这次询问如实记进事件流 ——
       * 用户事后看到的是「当时要求确认 X、被按默认拒绝」，而不是任务莫名其妙停住。
       */
      requestConfirm: async (req) => {
        if (config.unattended) return true;
        const request: ConfirmRequest = { id: randomUUID(), ...req };
        await journal.append({ type: 'confirm_request', request });
        // reason 用 'cancelled'：AgentEvent 里没有独立的「被拒绝」取值，
        // 语义上就是「这次询问没有得到批准」，与 cancelled 同义
        await journal.append({
          type: 'confirm_resolved',
          requestId: request.id,
          reason: 'cancelled',
        });
        return false;
      },
    });
    finalText = result.finalText ?? '';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 被主动停下时的 AbortError 不算失败 —— 终态由 cancelled 决定
    if (!stopRequested) failure = message;
  } finally {
    clearInterval(cancelTimer);
  }

  const status = stopRequested ? 'cancelled' : failure ? 'error' : 'done';
  await journal.finish(startInfo, status, {
    error: failure,
    summary: stopRequested ? '已按请求取消' : summarize(finalText) || lastSummary,
  });
  return failure ? 1 : 0;
}

// 直接执行 main。这个入口只会被 esbuild 打进远端 runner，或由 `node` 直接运行；
// 需要复用的纯逻辑（journal / settings）都在各自的模块里，测试不 import 本文件。
main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[echoly-runner] 未捕获的错误:', err);
    process.exit(1);
  });

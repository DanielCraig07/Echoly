/**
 * 远端任务的两个落地件：ssh2 适配，以及「本地那份 runner 在哪」。
 *
 * ssh2 那部分刻意做得极薄 —— 编排逻辑已经全部在 `service.ts` 里被测试覆盖了
 * （测试用的是「临时目录 + 真 sh」的模拟远端），这里只负责把 SSH 会话
 * 接到那三个方法上。薄，是为了让「没被测到的那部分」尽可能小。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import electronLog from 'electron-log';
import type { SshSessionManager } from '../ssh/SshSessionManager';
import type { RemoteTransport, RunnerBundle } from './service';

/** 把 SSH 会话接成 `RemoteTransport`。 */
export function createSshTransport(ssh: SshSessionManager): RemoteTransport {
  return {
    exec: (command, timeoutMs) => ssh.execRemoteRaw(command, timeoutMs),
    upload: (remotePath, content, opts) =>
      ssh.uploadRemoteFile(remotePath, content, opts?.mode ?? 0o600),
    read: (remotePath) => ssh.readRemoteFile(remotePath),
  };
}

/**
 * 找出本地那份打包好的 runner。
 *
 * 四个候选路径不是「多写几行保险」，而是三种运行形态确实各不一样：
 * 打包后（resources 下）、`electron-vite dev`（cwd 是 apps/desktop）、
 * 以及从仓库根直接跑脚本。**找不到就明确抛错**，而不是退化成一个空 bundle ——
 * 后者会把一个 219KB 的空文件传上远端，然后 runner 在那里以「语法错误」结束，
 * 从头到尾没有人会想到问题出在「本地没打包」。
 */
export function resolveRunnerBundle(): RunnerBundle {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'echoly-runner.mjs') : '',
    // `process.cwd()` 会跟着用户打开的工作区走（见 ExtensionManager.setWorkspaceRoot），
    // 所以那两个候选只在前两种跑法里有意义；`__dirname` 那条才是长期可靠的那个。
    path.join(process.cwd(), 'packages/runner/dist/echoly-runner.mjs'),
    path.join(process.cwd(), '../../packages/runner/dist/echoly-runner.mjs'),
    path.join(__dirname, '../../../../packages/runner/dist/echoly-runner.mjs'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const content = fs.readFileSync(candidate, 'utf8');
      if (!content.trim()) continue;
      // sha 就地算：用它判断远端那份是不是同一版本，必须与「传上去的那份」字节一致，
      // 所以从内容算比读构建时写下的清单更不容易对不上
      const sha256 = createHash('sha256').update(Buffer.from(content)).digest('hex');
      return { content, sha256, version: '1' };
    } catch (err) {
      electronLog.warn('[remoteRunner] 读取 runner 失败:', candidate, err);
    }
  }
  throw new Error(
    '本地没有打包好的远端 runner，请先执行 npm run build:runner（打包应用时由 build 自动完成）',
  );
}

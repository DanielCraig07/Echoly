/**
 * 修复 node-pty 原生辅助程序的可执行权限。
 *
 * node-pty 依赖 prebuilds/<platform>-<arch>/spawn-helper 作为 PTY 启动辅助进程。
 * 某些环境下 npm 复制 prebuild 时会丢失可执行位（表现为 -rw-r--r--），导致
 * spawn 报 "posix_spawnp failed"，终端无法打开。此脚本在打包前将当前平台
 * 的 spawn-helper 置为可执行（非 Windows 才需要）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function chmodSpawnHelpers() {
  // 脚本可从任意 cwd 调用：向上找到仓库根下的 node_modules/node-pty
  const prebuildsRoot = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');
  if (!fs.existsSync(prebuildsRoot)) return;

  const platformArch = `${process.platform}-${process.arch}`;
  const targetDir = path.join(prebuildsRoot, platformArch);
  const helper = path.join(targetDir, 'spawn-helper');

  if (fs.existsSync(helper)) {
    fs.chmodSync(helper, 0o755);
    console.log(`[fix-pty] chmod +x ${helper}`);
  }

  // 一并处理其它平台，便于 CI 跨平台产物可复用（失败不影响）
  try {
    for (const dir of fs.readdirSync(prebuildsRoot)) {
      const p = path.join(prebuildsRoot, dir, 'spawn-helper');
      if (fs.existsSync(p)) {
        fs.chmodSync(p, 0o755);
      }
    }
  } catch {
    /* ignore */
  }
}

chmodSpawnHelpers();

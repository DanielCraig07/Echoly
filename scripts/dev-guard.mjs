/**
 * 启动 electron-vite 之前，清掉那些会让 Electron 退化成「纯 Node 模式」的继承环境变量。
 *
 * 背景：某些 IDE 的扩展宿主进程会往终端注入 `ELECTRON_RUN_AS_NODE=1`（实测 Antigravity
 * IDE 就是如此，且它不在 ~/.zshrc / launchctl / IDE 主进程里，只存在于扩展宿主及其子进程中，
 * 从 shell 侧完全看不出来）。带着这个变量启动时，Electron 二进制不会初始化 Electron 运行时，
 * `require('electron')` 返回的是**可执行文件路径字符串**而不是 API 对象，主进程随即崩在
 * `app.setName("Echoly")` 上：
 *
 *     TypeError: Cannot read properties of undefined (reading 'setName')
 *
 * 报错指向 setName，真正的原因却在环境变量里 —— 不把进程环境翻一遍根本定位不到。
 *
 * 为什么是「包装进程」而不是在 `&&` 链上加一步：
 * `... && node guard.js && electron-vite dev` 里的 guard 是**独立进程**，它删掉的环境变量
 * 影响不到后面的兄弟命令。只有在同一个进程里 spawn 子进程，清理后的 env 才能传给
 * electron-vite，再由它传给最终拉起的 Electron。
 *
 * 用法：node scripts/dev-guard.mjs [electron-vite 的子命令，默认 dev]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ENV_KEY = 'ELECTRON_RUN_AS_NODE';
const subcommand = process.argv[2] ?? 'dev';

// electron-vite 的 exports 没有开放 bin 路径，只能读 package.json 自己拼。
// 用 process.execPath + 显式路径启动，避开对 PATH / shell 的依赖（Windows 上同样成立）。
const require = createRequire(import.meta.url);
const pkgPath = require.resolve('electron-vite/package.json');
const binRelative = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).bin['electron-vite'];
const binPath = path.join(path.dirname(pkgPath), binRelative);

const env = { ...process.env };
if (env[ENV_KEY]) {
  console.warn(
    `[dev-guard] 检测到 ${ENV_KEY}=${env[ENV_KEY]}，已为本次启动移除。\n` +
      '[dev-guard] 该变量会让 Electron 以纯 Node 模式启动，主进程会崩在 app.setName 上。',
  );
  delete env[ENV_KEY];
}

const child = spawn(process.execPath, [binPath, subcommand], { stdio: 'inherit', env });

child.on('error', (err) => {
  console.error('[dev-guard] 启动 electron-vite 失败:', err.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  // 被信号打断时（Ctrl+C、外部 kill）原样把信号传回自己，
  // 否则 shell 只会看到一个「正常退出 0」，掩盖掉中断。
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

let isInitialized = false;
/** 登录 Shell 环境探测是否已经跑完（成功或失败都算）。 */
let probeSettled = false;
let probePromise: Promise<void> | null = null;

/**
 * 确保主进程及子进程（Terminal、Git、Maven、Agent）具备完整的 macOS/Linux 系统与用户环境。
 * 解决 macOS GUI 应用从 Finder/Dock 启动时 launchd 只分配最小 PATH (/usr/bin:/bin:/usr/sbin:/sbin)
 * 导致 brew、git、mvn、node、cargo 等常用开发工具找不到的问题。
 *
 * 这个同步版本**只做静态目录兜底**（几次 `fs.existsSync`，微秒级）。
 * 真正昂贵的那一步——起一个登录 Shell 去读 `env`——由 `primeSystemEnv()`
 * 在窗口起来之后异步跑，原因见那个函数。
 */
export function ensureSystemEnv(): void {
  if (isInitialized) return;
  isInitialized = true;

  if (process.platform === 'win32') return;

  for (const p of standardPaths()) {
    try {
      if (fs.existsSync(p)) {
        addPathPrefix(p);
      }
    } catch {
      /* ignore */
    }
  }
}

function standardPaths(): string[] {
  const home = process.env.HOME || os.homedir();
  return [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    path.join(home, '.cargo', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
  ];
}

/**
 * 异步预热：跑一次登录 Shell 把真实环境变量并进来。
 *
 * 为什么不能留在同步的 `ensureSystemEnv()` 里。旧实现在主进程启动路径上
 * `execFileSync(userShell, ['-l', '-c', 'env'])` 并给了 2500ms 超时 ——
 * 这是**在主进程里同步等待最多 2.5 秒**：窗口不出现、Dock 图标弹跳、菜单没反应。
 * 而那台机器上装没装 oh-my-zsh / nvm / conda，直接决定这段时间是 30ms 还是 2500ms。
 * 用户感知是"这软件启动好慢"，而慢的原因和界面渲染毫无关系。
 *
 * 并到环境里的时机也无所谓：它只是让子进程（git、终端、mvn）能多找到几个可执行文件，
 * 而窗口起来之前不会有任何子进程。所以完全可以等。
 */
export function primeSystemEnv(): Promise<void> {
  if (probePromise) return probePromise;
  if (process.platform === 'win32') {
    probeSettled = true;
    probePromise = Promise.resolve();
    return probePromise;
  }
  probePromise = runShellEnvProbe().finally(() => {
    probeSettled = true;
  });
  return probePromise;
}

/** 探测是否已经落定（供测试与诊断使用；业务代码不需要等它）。 */
export function isSystemEnvProbed(): boolean {
  return probeSettled;
}

function runShellEnvProbe(): Promise<void> {
  return new Promise<void>((resolve) => {
    const userShell = process.env.SHELL || '/bin/zsh';
    if (!fs.existsSync(userShell)) return resolve();

    const markerStart = '__ECHOLY_ENV_START__';
    const markerEnd = '__ECHOLY_ENV_END__';
    const cmd = `echo "${markerStart}"; env; echo "${markerEnd}"`;

    let output = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        applyShellEnv(output, markerStart, markerEnd);
      } catch {
        // 解析失败无所谓：静态兜底已经生效
      }
      resolve();
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(userShell, ['-l', '-c', cmd], {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: {
          ...process.env,
          // 避免某些交互式插件等待用户输入
          TERM: 'dumb',
          SHLVL: '1',
        },
      });
    } catch {
      return resolve();
    }

    // 超时保护保留：一个卡住的 zshrc（等输入、连不上的网络盘）不能让这里挂着不走。
    // 区别在于它**不再阻塞主进程**，超时的代价只是少几个环境变量。
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish();
    }, 2500);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      output += chunk;
    });
    child.on('error', finish);
    child.on('close', finish);
  });
}

function applyShellEnv(output: string, markerStart: string, markerEnd: string): void {
  const startIdx = output.indexOf(markerStart);
  const endIdx = output.indexOf(markerEnd);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return;
  const envBlock = output.substring(startIdx + markerStart.length, endIdx);
  for (const line of envBlock.split(/\r?\n/)) {
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = line.substring(0, eqIdx);
    const val = line.substring(eqIdx + 1);
    // 合并关键开发环境变量（若主进程未设置或主进程 PATH 较短时覆盖）
    if (
      key === 'PATH' ||
      key.startsWith('HOMEBREW_') ||
      key.startsWith('JAVA_') ||
      key.startsWith('NVM_') ||
      key === 'NODE_PATH' ||
      key === 'GOROOT' ||
      key === 'GOPATH' ||
      key === 'CARGO_HOME' ||
      key === 'RUSTUP_HOME'
    ) {
      if (key === 'PATH') {
        // 将 shell 中的 PATH 与现有 PATH 融合
        mergePathEnv(val);
      } else if (!process.env[key] || process.env[key] !== val) {
        process.env[key] = val;
      }
    }
  }
}

/**
 * 将 shell 探测到的 PATH 与主进程 PATH 智能合并
 */
function mergePathEnv(shellPath: string): void {
  const current = process.env.PATH || '';
  const currentParts = current.split(path.delimiter).filter(Boolean);
  const shellParts = shellPath.split(path.delimiter).filter(Boolean);

  const merged = new Set<string>();
  // 优先保留 shellParts（包含 brew shellenv、nvm、cargo）
  for (const p of shellParts) {
    merged.add(p);
  }
  // 补充当前环境中独有的目录
  for (const p of currentParts) {
    merged.add(p);
  }

  process.env.PATH = Array.from(merged).join(path.delimiter);
}

/**
 * 将指定路径安全添加到 PATH 最前端（若尚不存在）
 */
function addPathPrefix(dirPath: string): void {
  const current = process.env.PATH || '';
  const parts = current.split(path.delimiter).filter(Boolean);
  if (!parts.includes(dirPath)) {
    process.env.PATH = [dirPath, ...parts].join(path.delimiter);
  }
}

/**
 * 获取用于创建本地终端的完整环境变量字典
 *
 * 注意它读的是**当下**的 `process.env`，而登录 Shell 探测（`primeSystemEnv`）
 * 是异步的 —— 用户可能在探测完成前就打开了终端。这里不做等待是有意的：
 * 终端自己就是用 `-l` 启动登录 Shell 的，它会重新读一遍 profile，
 * 拿到的 PATH 比我们探到的更完整；而"等 2.5 秒再开终端"是明显的倒退。
 */
export function getLocalTerminalEnv(cwd: string): Record<string, string> {
  ensureSystemEnv();

  const home = process.env.HOME || os.homedir();
  const currentPath = process.env.PATH || '';

  return {
    ...process.env,
    PWD: cwd,
    HOME: home,
    PATH: currentPath,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    LANG: process.env.LANG || 'en_US.UTF-8',
    SHLVL: '1',
    // 彩色 ls 输出
    CLICOLOR: '1',
    CLICOLOR_FORCE: '1',
    LSCOLORS: 'Gxfxcxdxbxegedabagacad',
    LS_COLORS:
      'di=1;36:ln=1;35:so=1;32:pi=33:ex=0;31:bd=1;33:cd=1;33:su=41;30:sg=43;30:tw=1;34:ow=1;34:*.zip=1;31:*.tar=1;31:*.gz=1;31:*.png=35:*.jpg=35:*.gif=35:*.mp4=35:*.mov=35:*.pdf=31:*.md=0;31:*.json=0;31:*.html=0;31:*.js=0;31:*.ts=0;31',
  } as Record<string, string>;
}

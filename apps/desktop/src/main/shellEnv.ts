import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

let isInitialized = false;

/**
 * 确保主进程及子进程（Terminal、Git、Maven、Agent）具备完整的 macOS/Linux 系统与用户环境。
 * 解决 macOS GUI 应用从 Finder/Dock 启动时 launchd 只分配最小 PATH (/usr/bin:/bin:/usr/sbin:/sbin)
 * 导致 brew、git、mvn、node、cargo 等常用开发工具找不到的问题。
 */
export function ensureSystemEnv(): void {
  if (isInitialized) return;
  isInitialized = true;

  if (process.platform === 'win32') return;

  const home = process.env.HOME || os.homedir();

  // 1. 标准高频开发工具目录候选
  const standardPaths = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    path.join(home, '.cargo', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
  ];

  // 2. 尝试从用户默认登录 Shell 提取真实完整环境（包含 ~/.zprofile, ~/.zshrc, /etc/paths 等定义的全部变量）
  try {
    const userShell = process.env.SHELL || '/bin/zsh';
    if (fs.existsSync(userShell)) {
      const markerStart = '__ECHOLY_ENV_START__';
      const markerEnd = '__ECHOLY_ENV_END__';
      const cmd = `echo "${markerStart}"; env; echo "${markerEnd}"`;

      const output = execFileSync(userShell, ['-l', '-c', cmd], {
        encoding: 'utf8',
        timeout: 2500,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: {
          ...process.env,
          // 避免某些交互式插件等待用户输入
          TERM: 'dumb',
          SHLVL: '1',
        },
      });

      const startIdx = output.indexOf(markerStart);
      const endIdx = output.indexOf(markerEnd);
      if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
        const envBlock = output.substring(startIdx + markerStart.length, endIdx);
        for (const line of envBlock.split(/\r?\n/)) {
          const eqIdx = line.indexOf('=');
          if (eqIdx > 0) {
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
      }
    }
  } catch {
    // 提取超时或受限时容灾：使用静态扩展目录保底
  }

  // 3. 兜底保障：检查标准路径，若存在且不在 PATH 中，强制前置加入 PATH
  for (const p of standardPaths) {
    try {
      if (fs.existsSync(p)) {
        addPathPrefix(p);
      }
    } catch {
      /* ignore */
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

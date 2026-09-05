import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserWindow } from 'electron';
import type { TerminalCreateOptions } from '@deepseek-ide/shared';
import type { SshSessionManager } from './ssh/SshSessionManager';

interface LocalHandle {
  kind: 'local';
  stdin: NodeJS.WritableStream;
  kill: () => void;
}
type SshHandle = {
  kind: 'ssh';
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  close: () => void;
};

type TermHandle = LocalHandle | SshHandle;

/**
 * Terminal service – uses a plain pipe-based shell (no PTY) for local shells.
 * Runs zsh in non-interactive/non-login mode to avoid TTY read errors.
 * Shell prompt and echo are handled on the renderer side.
 */
export class TerminalService {
  private terminals = new Map<string, TermHandle>();
  private termOwners = new Map<string, number>();
  private ssh: SshSessionManager | null = null;
  private resolveCwd: ((rel?: string) => string) | null = null;

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly getCwd: () => string,
  ) { }

  setSshManager(ssh: SshSessionManager): void {
    this.ssh = ssh;
  }

  /** Optional resolver: relative workspace path -> absolute/local or remote path. */
  setCwdResolver(resolve: (rel?: string) => string): void {
    this.resolveCwd = resolve;
  }

  private sendToWindow(channel: string, data: Record<string, unknown>): void {
    const termId = typeof data.id === 'string' ? data.id : undefined;
    const ownerId = termId != null ? this.termOwners.get(termId) : undefined;
    let win: BrowserWindow | null = null;
    if (ownerId != null) {
      win =
        BrowserWindow.getAllWindows().find(
          (w) => !w.isDestroyed() && w.webContents.id === ownerId,
        ) ?? null;
    }
    if (!win) win = this.getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  }

  create(options?: TerminalCreateOptions, ownerWebContentsId?: number): { id: string } {
    const kind = options?.kind ?? 'local';
    const result =
      kind === 'ssh'
        ? this.createSsh(options?.cwd)
        : this.createLocal(options?.cwd, options?.cols, options?.rows);
    if (ownerWebContentsId != null) {
      this.termOwners.set(result.id, ownerWebContentsId);
    }
    return result;
  }

  /** Walk up from startDir to find the nearest .git directory (project root). */
  private findProjectRoot(startDir: string): string {
    let dir = startDir;
    for (let i = 0; i < 8; i++) {
      if (fs.existsSync(path.join(dir, '.git'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break; // reached filesystem root
      dir = parent;
    }
    return startDir; // fallback to original
  }

  /** Called when the workspace root changes — cd all existing local terminals. */
  onWorkspaceChange(newRoot: string): void {
    const projectRoot = this.findProjectRoot(newRoot);
    const safeCwd = projectRoot.replace(/'/g, "'\\''");
    for (const [, t] of this.terminals) {
      if (t.kind === 'local' && !(t.stdin as any).destroyed) {
        try {
          t.stdin.write(`cd '${safeCwd}'\n`);
        } catch { /* ignore */ }
      }
    }
  }

  private resolveLocalCwd(cwdRel?: string): string {
    if (!cwdRel || cwdRel === '.' || cwdRel === '') {
      // No workspace open → default to home directory
      const base = this.getCwd();
      if (!base || base === os.homedir()) return os.homedir();
      // Walk up to git root so terminal starts at project root, not a deep sub-dir
      return this.findProjectRoot(base);
    }
    if (this.resolveCwd) {
      try {
        const resolved = this.resolveCwd(cwdRel);
        if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) return resolved;
        const parent = path.dirname(resolved);
        if (fs.existsSync(parent)) return parent;
      } catch {
        /* fall through */
      }
    }
    const joined = path.join(this.getCwd(), cwdRel);
    if (fs.existsSync(joined) && fs.statSync(joined).isDirectory()) return joined;
    return this.getCwd();
  }

  private createLocal(cwdRel?: string, cols?: number, rows?: number): { id: string } {
    const id = randomUUID();
    const isWin = process.platform === 'win32';
    const shell = isWin ? (process.env.COMSPEC || 'cmd.exe') : (process.env.SHELL || '/bin/zsh');
    const cwd = this.resolveLocalCwd(cwdRel);
    const isZsh = !isWin && (shell.endsWith('/zsh') || shell === 'zsh');
    const initialCols = Math.max(100, cols || 100);
    const initialRows = Math.max(24, rows || 24);

    let spawnArgs: string[] = [];
    let extraEnv: Record<string, string> = {};
    let zdotDir: string | null = null;

    if (!isWin && isZsh) {
      // zsh with -i tries to initialize ZLE (line editor) which requires a real
      // PTY. Since we use pipes, we disable ZLE via a temp ZDOTDIR/.zshrc.
      // This gives us an interactive shell (prompts, aliases, builtins) without
      // the "error on TTY read: Input/output error" crash.
      try {
        zdotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ide-zsh-'));
        const safeCwd = cwd.replace(/'/g, "'\\''");
        const zshrc = [
          '# IDE injected rc \u2014 disables ZLE so zsh works over pipes',
          'unsetopt ZLE 2>/dev/null || true',
          'setopt NO_ZLE 2>/dev/null || true',
          '# Source user rc for aliases, PATH, functions etc.',
          '[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc" 2>/dev/null || true',
          '# Re-disable ZLE in case user rc re-enabled it',
          'unsetopt ZLE 2>/dev/null || true',
          "alias ll='ls -la 2>/dev/null || ls -la' 2>/dev/null || true",
          "PS1='%F{green}%n@%m%f %F{yellow}%1~%f %# '",
          `cd '${safeCwd}'`,
        ].join('\n');
        fs.writeFileSync(path.join(zdotDir, '.zshrc'), zshrc, 'utf8');
        extraEnv = { ZDOTDIR: zdotDir };
        spawnArgs = ['-i'];
      } catch {
        // fallback: just no args if we can't create temp dir
        spawnArgs = [];
      }
    } else if (!isWin) {
      // bash / sh: -i is generally safe with pipes
      spawnArgs = ['-i'];
      extraEnv = { PS1: '\\u@\\h \\w\\$ ' };
    }

    const child = spawn(shell, spawnArgs, {
      cwd,
      env: {
        ...process.env,
        PWD: cwd,
        HOME: process.env.HOME || os.homedir(),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        COLUMNS: String(initialCols),
        LINES: String(initialRows),
        LANG: process.env.LANG || 'en_US.UTF-8',
        SHLVL: '1',
        // Enable colored ls output on macOS (CLICOLOR) and Linux (LS_COLORS)
        CLICOLOR: '1',
        CLICOLOR_FORCE: '1',
        LSCOLORS: 'Gxfxcxdxbxegedabagacad',
        LS_COLORS: 'di=1;36:ln=1;35:so=1;32:pi=33:ex=0;31:bd=1;33:cd=1;33:su=41;30:sg=43;30:tw=1;34:ow=1;34:*.zip=1;31:*.tar=1;31:*.gz=1;31:*.png=35:*.jpg=35:*.gif=35:*.mp4=35:*.mov=35:*.pdf=31:*.md=0;31:*.json=0;31:*.html=0;31:*.js=0;31:*.ts=0;31',
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    child.stdin.setDefaultEncoding('utf8');
    const decoder = new TextDecoder('utf-8');

    child.stdout.on('data', (d: Buffer) => {
      this.sendToWindow('terminal:data', { id, data: decoder.decode(d) });
    });
    child.stderr.on('data', (d: Buffer) => {
      this.sendToWindow('terminal:data', { id, data: decoder.decode(d) });
    });
    child.on('close', (code) => {
      // Clean up temp ZDOTDIR
      if (zdotDir) {
        try { fs.rmSync(zdotDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      this.sendToWindow('terminal:exit', { id, exitCode: code ?? 0 });
      this.terminals.delete(id);
    });
    child.on('error', (err) => {
      this.sendToWindow('terminal:data', {
        id,
        data: `\r\n[shell error] ${err.message}\r\n`,
      });
    });

    const handle: LocalHandle = {
      kind: 'local',
      stdin: child.stdin,
      kill: () => { try { child.kill(); } catch { /* ignore */ } },
    };
    this.terminals.set(id, handle);

    return { id };
  }


  private createSsh(cwdRel?: string): { id: string } {
    const id = randomUUID();
    if (!this.ssh?.isConnected()) {
      this.sendToWindow('terminal:data', {
        id,
        data: '[ssh] 未连接远程服务器，请先通过「打开工作区」登录 SSH\r\n',
      });
      this.sendToWindow('terminal:exit', { id, exitCode: 1 });
      return { id };
    }
    const handle = this.ssh.openShell(
      (data) => this.sendToWindow('terminal:data', { id, data }),
      (exitCode) => {
        this.sendToWindow('terminal:exit', { id, exitCode });
        this.terminals.delete(id);
      },
    );
    if (!handle) {
      this.sendToWindow('terminal:data', {
        id,
        data: '[ssh] 无法打开远程 shell\r\n',
      });
      this.sendToWindow('terminal:exit', { id, exitCode: 1 });
      return { id };
    }
    this.terminals.set(id, { kind: 'ssh', ...handle });
    this.sendToWindow('terminal:data', {
      id,
      data: '[ssh] 已接入远程服务器终端\r\n',
    });
    if (cwdRel && cwdRel !== '.' && this.resolveCwd) {
      try {
        const target = this.resolveCwd(cwdRel);
        const quoted = `'${target.replace(/'/g, `'\\''`)}'`;
        setTimeout(() => {
          handle.write(`cd ${quoted} 2>/dev/null || cd "$(dirname ${quoted})"\n`);
        }, 200);
      } catch {
        /* ignore */
      }
    }
    return { id };
  }

  write(id: string, data: string): void {
    const t = this.terminals.get(id);
    if (!t) return;
    if (t.kind === 'local') {
      // Translate \r -> \n for pipe-based shell (no PTY)
      const payload = data.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      if (!(t.stdin as any).destroyed) {
        t.stdin.write(payload);
      }
    } else {
      t.write(data);
    }
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols < 40 || rows < 5) return;
    const t = this.terminals.get(id);
    if (t?.kind === 'ssh') t.resize(cols, rows);
  }

  dispose(id: string): void {
    const t = this.terminals.get(id);
    if (!t) return;
    if (t.kind === 'local') t.kill();
    else t.close();
    this.terminals.delete(id);
    this.termOwners.delete(id);
  }
}

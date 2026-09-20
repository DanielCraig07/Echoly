import { spawn } from 'node:child_process';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import type {
  GitBranchInfo,
  GitCloneRequest,
  GitCloneResult,
  GitCommitDetailResult,
  GitCommitEntry,
  GitCommitFileChange,
  GitCommitStats,
  GitDiffResult,
  GitHistoryResult,
  GitBlameLineResult,
  GitOpResult,
  GitOutputResult,
  GitRemoteInfo,
  GitRemotesResult,
  GitStashAction,
  GitStashEntry,
  GitStashResult,
  GitStatusEntry,
  GitStatusResult,
  GitTagsResult,
} from '@deepseek-ide/shared';
import type { SshSessionManager } from './ssh/SshSessionManager';
import type { WorkspaceService } from './workspace';

interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
  error?: string;
}
function formatCommitDate(timestampSec: number | string): {
  relativeDate: string;
  fullDate: string;
} {
  const ts = typeof timestampSec === 'number' ? timestampSec * 1000 : Number(timestampSec) * 1000;
  if (!ts || isNaN(ts)) {
    return { relativeDate: '', fullDate: '' };
  }
  const date = new Date(ts);
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  let relativeDate = '';
  if (diffSec < 60) relativeDate = '刚刚';
  else if (diffSec < 3600) relativeDate = `${Math.floor(diffSec / 60)} 分钟前`;
  else if (diffSec < 86400) relativeDate = `${Math.floor(diffSec / 3600)} 小时前`;
  else if (diffSec < 2592000) relativeDate = `${Math.floor(diffSec / 86400)} 天前`;
  else if (diffSec < 31536000) relativeDate = `${Math.floor(diffSec / 2592000)} 个月前`;
  else relativeDate = `${Math.floor(diffSec / 31536000)} 年前`;

  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const fullDate = `${y}年${m}月${d}日 ${hh}:${mm}`;

  return { relativeDate, fullDate };
}

export class GitService {
  constructor(
    private readonly resolveWorkspace: () => WorkspaceService,
    private readonly getWindow: () => BrowserWindow | null,
    private readonly ssh?: SshSessionManager,
  ) {}

  private get workspace(): WorkspaceService {
    return this.resolveWorkspace();
  }

  private log(line: string): void {
    const win = this.getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('git:cloneLog', line);
    }
  }

  private localRootOrError(): { root: string } | GitOpResult {
    const root = this.workspace.getRoot();
    if (!root) return { ok: false, detail: '未打开工作区' };
    return { root };
  }

  private async runGit(
    args: string[],
    cwd: string,
    workspace: WorkspaceService = this.resolveWorkspace(),
  ): Promise<GitRunResult> {
    if (workspace.getKind() === 'ssh' && this.ssh) {
      const quotedArgs = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
      let res = await this.ssh.runCommand(`git ${quotedArgs}`);
      // 远程命令偶发抖动重试保护
      if (
        res.code !== 0 &&
        (res.stderr.includes('timed out') ||
          res.stderr.includes('SSH 未连接') ||
          res.stderr.includes('Channel open failure'))
      ) {
        await new Promise((r) => setTimeout(r, 600));
        res = await this.ssh.runCommand(`git ${quotedArgs}`);
      }
      const isConnectionIssue =
        res.code !== 0 &&
        (res.stderr.includes('SSH 未连接') ||
          res.stderr.includes('timed out') ||
          res.stderr.includes('Channel open failure') ||
          res.stderr.includes('Connection reset'));
      return {
        code: res.code,
        stdout: res.stdout,
        stderr: res.stderr,
        error: isConnectionIssue ? res.stderr || 'SSH 远程连接异常' : undefined,
      };
    }

    return new Promise((resolve) => {
      const child = spawn('git', args, {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      // 30 秒超时保护
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 1000);
      }, 30000);

      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString('utf8');
        // 输出过大保护（防止 git log 等命令输出巨量数据）
        if (stdout.length > 10_000_000) {
          timedOut = true;
          child.kill('SIGTERM');
        }
      });
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString('utf8');
      });
      child.on('error', (err) => {
        clearTimeout(timeout);
        const detail =
          (err as NodeJS.ErrnoException).code === 'ENOENT'
            ? '未找到 git，请先安装 Git 并确保在 PATH 中'
            : err.message;
        resolve({ code: -1, stdout, stderr, error: detail });
      });
      child.on('close', (code) => {
        clearTimeout(timeout);
        if (timedOut) {
          resolve({
            code: 124,
            stdout,
            stderr: stderr || 'Git 操作超时（30秒）',
          });
        } else {
          resolve({ code: code ?? 1, stdout, stderr });
        }
      });
    });
  }

  async clone(req: GitCloneRequest): Promise<GitCloneResult> {
    const url = req.url.trim();
    if (!url) return { ok: false, detail: '请填写仓库 URL' };
    const parentDir = req.parentDir.trim();
    if (!parentDir) return { ok: false, detail: '请选择目标目录' };

    // Capture owning window/workspace before spawn callbacks (no ALS there).
    const workspace = this.resolveWorkspace();
    const logWin = this.getWindow();
    const log = (line: string) => {
      if (logWin && !logWin.isDestroyed()) {
        logWin.webContents.send('git:cloneLog', line);
      }
    };

    const args = ['clone', '--progress'];
    if (req.branch?.trim()) {
      args.push('-b', req.branch.trim());
    }
    args.push(url);

    log(`$ git ${args.join(' ')}`);

    return await new Promise((resolve) => {
      const child = spawn('git', args, {
        cwd: parentDir,
        env: process.env,
        windowsHide: true,
      });
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => log(d.toString('utf8')));
      child.stderr.on('data', (d: Buffer) => {
        const s = d.toString('utf8');
        stderr += s;
        log(s);
      });
      child.on('error', (err) => {
        const detail =
          (err as NodeJS.ErrnoException).code === 'ENOENT'
            ? '未找到 git，请先安装 Git 并确保在 PATH 中'
            : err.message;
        resolve({ ok: false, detail });
      });
      child.on('close', (code) => {
        if (code !== 0) {
          resolve({
            ok: false,
            detail: stderr.trim() || `git clone 失败 (exit ${code})`,
          });
          return;
        }
        const name =
          url
            .replace(/\/$/, '')
            .split('/')
            .pop()
            ?.replace(/\.git$/, '') || 'repo';
        const cloned = path.join(parentDir, name);
        workspace.setRoot(cloned);
        resolve({ ok: true, path: cloned, detail: `已克隆到 ${cloned}` });
      });
    });
  }

  async init(): Promise<GitOpResult> {
    const gate = this.localRootOrError();
    if ('ok' in gate && gate.ok === false) return gate;
    const { root } = gate as { root: string };
    const res = await this.runGit(['init'], root);
    if (res.code !== 0) {
      return { ok: false, detail: res.stderr.trim() || 'git init 初始化失败' };
    }
    return { ok: true, detail: 'Git 仓库已成功初始化' };
  }

  async status(): Promise<GitStatusResult> {
    const gate = this.localRootOrError();
    if ('ok' in gate && gate.ok === false) {
      return {
        ok: false,
        detail: gate.detail,
        isRepo: false,
        branch: null,
        ahead: 0,
        behind: 0,
        entries: [],
      };
    }
    const { root } = gate as { root: string };

    let check = await this.runGit(['rev-parse', '--is-inside-work-tree'], root);
    if (check.error) {
      return {
        ok: false,
        detail: check.error,
        isRepo: false,
        branch: null,
        ahead: 0,
        behind: 0,
        entries: [],
      };
    }

    let stderr = (check.stderr || '').trim();
    let stderrLower = stderr.toLowerCase();

    // 针对 Git 2.35.2+ 的 safe.directory 所有权安全检查（常见于外盘拷贝或多用户创建的项目）
    if (stderrLower.includes('detected dubious ownership')) {
      await this.runGit(['config', '--global', '--add', 'safe.directory', root], root);
      check = await this.runGit(['rev-parse', '--is-inside-work-tree'], root);
      stderr = (check.stderr || '').trim();
      stderrLower = stderr.toLowerCase();
    }

    const isExplicitlyNotRepo = stderrLower.includes('not a git repository');

    if (isExplicitlyNotRepo) {
      return {
        ok: true,
        detail: '当前目录不是 git 仓库',
        isRepo: false,
        branch: null,
        ahead: 0,
        behind: 0,
        entries: [],
      };
    }

    if (check.code !== 0 || !check.stdout.trim().includes('true')) {
      return {
        ok: false,
        detail: stderr || '获取 Git 状态失败（命令执行未成功）',
        isRepo: false,
        branch: null,
        ahead: 0,
        behind: 0,
        entries: [],
      };
    }

    const branchRes = await this.runGit(['branch', '--show-current'], root);
    const branch = branchRes.stdout.trim() || null;

    let ahead = 0;
    let behind = 0;
    const sb = await this.runGit(['status', '-sb', '--porcelain=v1'], root);
    const firstLine = sb.stdout.split(/\r?\n/)[0] ?? '';
    const ab = firstLine.match(/\[ahead\s+(\d+)(?:,\s*behind\s+(\d+))?\]|\[behind\s+(\d+)\]/);
    if (ab) {
      if (ab[1]) ahead = Number(ab[1]);
      if (ab[2]) behind = Number(ab[2]);
      if (ab[3]) behind = Number(ab[3]);
    }

    await this.runGit(['update-index', '-q', '--really-refresh'], root);
    const porcelain = await this.runGit(
      ['status', '--porcelain=v1', '-uall', '--ignored=matching'],
      root,
    );
    const entries: GitStatusEntry[] = [];
    const ignoredPaths: string[] = [];
    for (const line of porcelain.stdout.split(/\r?\n/)) {
      if (!line || line.length < 3) continue;
      const index = line[0] ?? ' ';
      const workTree = line[1] ?? ' ';
      let filePath = line.slice(3);
      // rename: "R  old -> new"
      if (filePath.includes(' -> ')) {
        filePath = filePath.split(' -> ').pop() || filePath;
      }
      filePath = filePath.replace(/\\/g, '/').replace(/^"|"$/g, '');
      const isIgnored = index === '!' && workTree === '!';
      if (isIgnored) {
        ignoredPaths.push(filePath);
        continue;
      }
      const untracked = index === '?' && workTree === '?';
      const staged = !untracked && index !== ' ' && index !== '?';
      entries.push({
        path: filePath,
        index,
        workTree,
        staged,
        untracked,
      });
    }

    // 与编辑器 gutter 的内容级比较保持一致：过滤「仅换行符（CRLF/LF）不同」和「仅权限位（mode）变化」
    // 的伪修改。gutter 的 computeLineDiffs 只比较内容（并剥离 \r），对这两类文件显示为无改动；
    // 若此处仍按字节级报 M，就会出现「编辑区干净但文件树/Tab 常驻 M」的割裂状态。
    // 以 HEAD 为基准（与 diff() 的 gutter 基准一致）：--ignore-cr-at-eol 忽略行尾 CR 差异，
    // --numstat 输出 增删行数，0/0 表示无内容变化（mode-only），不在名单里表示无差异。
    const workTreeModified = entries.filter(
      (e) => !e.untracked && e.workTree && e.workTree !== ' ',
    );
    if (workTreeModified.length > 0) {
      const realDiff = await this.runGit(
        ['diff', 'HEAD', '--ignore-cr-at-eol', '--numstat', '--'],
        root,
      );
      if (realDiff.code === 0) {
        // path -> 是否有真实内容增删（--ignore-cr-at-eol 已忽略行尾 CR；二进制 "-" 视为真实改动）
        const realDiffPaths = new Set<string>();
        for (const line of realDiff.stdout.split(/\r?\n/)) {
          if (!line.trim()) continue;
          const parts = line.split('\t');
          if (parts.length < 3) continue;
          const [added, deleted, ...rest] = parts;
          const path = rest.join('\t').replace(/^"|"$/g, '').replace(/\\/g, '/').trim();
          if (!path) continue;
          // "0 0" = mode-only 变化（无内容增删），不视为真实改动
          if (!(added === '0' && deleted === '0')) {
            realDiffPaths.add(path);
          }
        }
        for (const e of workTreeModified) {
          if (!realDiffPaths.has(e.path)) {
            e.workTree = ' ';
          }
        }
        // workTree 清空后既非暂存也非未跟踪的条目，整体移除
        const filtered = entries.filter(
          (e) => e.untracked || e.staged || (e.workTree && e.workTree !== ' '),
        );
        entries.length = 0;
        entries.push(...filtered);
      }
    }

    return {
      ok: true,
      isRepo: true,
      branch,
      ahead,
      behind,
      entries,
      ignoredPaths,
    };
  }

  async stage(paths: string[]): Promise<GitOpResult> {
    const gate = this.localRootOrError();
    if ('ok' in gate && gate.ok === false) return gate;
    const { root } = gate as { root: string };
    if (!paths.length) return { ok: false, detail: '未指定文件' };
    const res = await this.runGit(['add', '--', ...paths], root);
    if (res.error) return { ok: false, detail: res.error };
    if (res.code !== 0) return { ok: false, detail: res.stderr.trim() || 'git add 失败' };
    return { ok: true, detail: `已暂存 ${paths.length} 个路径` };
  }

  async unstage(paths: string[]): Promise<GitOpResult> {
    const gate = this.localRootOrError();
    if ('ok' in gate && gate.ok === false) return gate;
    const { root } = gate as { root: string };
    if (!paths.length) return { ok: false, detail: '未指定文件' };
    const res = await this.runGit(['restore', '--staged', '--', ...paths], root);
    if (res.error) return { ok: false, detail: res.error };
    if (res.code !== 0) {
      // older git fallback
      const fallback = await this.runGit(['reset', 'HEAD', '--', ...paths], root);
      if (fallback.error) return { ok: false, detail: fallback.error };
      if (fallback.code !== 0) {
        return { ok: false, detail: res.stderr.trim() || fallback.stderr.trim() || '取消暂存失败' };
      }
    }
    return { ok: true, detail: `已取消暂存 ${paths.length} 个路径` };
  }

  async commit(message: string, amend = false): Promise<GitOpResult> {
    const gate = this.localRootOrError();
    if ('ok' in gate && gate.ok === false) return gate;
    const { root } = gate as { root: string };
    const msg = message.trim();
    if (!msg && !amend) return { ok: false, detail: '请填写提交说明' };
    const args = ['commit'];
    if (amend) {
      args.push('--amend');
      if (msg) {
        args.push('-m', msg);
      } else {
        args.push('--no-edit');
      }
    } else {
      args.push('-m', msg);
    }
    const res = await this.runGit(args, root);
    if (res.error) return { ok: false, detail: res.error };
    if (res.code !== 0) {
      return { ok: false, detail: res.stderr.trim() || res.stdout.trim() || '提交失败' };
    }
    return { ok: true, detail: res.stdout.trim() || '提交成功' };
  }

  async discard(paths: string[]): Promise<GitOpResult> {
    const gate = this.localRootOrError();
    if ('ok' in gate && gate.ok === false) return gate;
    const { root } = gate as { root: string };
    if (!paths.length) return { ok: false, detail: '未指定文件' };

    const normRoot = root.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\/+/, '');
    const cleanInputPaths = paths.map((p) => {
      let posix = p.replace(/\\/g, '/').replace(/^\/+/, '');
      if (normRoot && posix.startsWith(normRoot)) {
        posix = posix.slice(normRoot.length).replace(/^\/+/, '');
      }
      return posix;
    });

    const isAll = cleanInputPaths.some((p) => !p || p === '.' || p === 'ALL' || p === 'all');
    if (isAll) {
      await this.runGit(['reset', 'HEAD', '.'], root);
      await this.runGit(['checkout', '-f', 'HEAD', '--', '.'], root);
      await this.runGit(['checkout', '-f', '--', '.'], root);
      await this.runGit(['clean', '-fd'], root);
      await this.runGit(['update-index', '-q', '--really-refresh'], root);
      await this.runGit(['update-index', '-q', '--refresh'], root);
      return { ok: true, detail: '已还原所有改动' };
    }

    const status = await this.status();
    const targetEntries = new Set<GitStatusEntry>();

    for (const cp of cleanInputPaths) {
      for (const entry of status.entries) {
        const ep = entry.path.replace(/\\/g, '/').replace(/^\/+/, '');
        if (
          ep === cp ||
          ep.startsWith(cp + '/') ||
          cp.endsWith('/' + ep) ||
          ep.endsWith('/' + cp)
        ) {
          targetEntries.add(entry);
        }
      }
    }

    const tracked: string[] = [];
    const untracked: string[] = [];
    for (const e of targetEntries) {
      if (e.untracked) untracked.push(e.path);
      else tracked.push(e.path);
    }
    // Include input paths not explicitly detected in status
    for (const cp of cleanInputPaths) {
      if (!tracked.includes(cp) && !untracked.includes(cp)) {
        tracked.push(cp);
      }
    }

    const failures: string[] = [];

    // 1. 处理已跟踪文件的还原
    for (const filePath of tracked) {
      // 记录还原前工作区文件的实际权限位（如果在磁盘上存在）
      let preMode: number | undefined;
      if (this.workspace.getKind() === 'ssh' && this.ssh) {
        try {
          const absPath = this.workspace.resolveAbsolute(filePath);
          const statRes = await this.ssh.runCommand(
            `stat -c '%a' '${absPath.replace(/'/g, "'\\''")}' 2>/dev/null || stat -f '%Lp' '${absPath.replace(/'/g, "'\\''")}' 2>/dev/null`,
          );
          if (statRes.code === 0 && statRes.stdout.trim()) {
            preMode = parseInt(statRes.stdout.trim(), 8);
          }
        } catch {}
      } else if (process.platform !== 'win32') {
        try {
          const fsModule = await import('fs/promises');
          const pathModule = await import('path');
          const absPath = pathModule.resolve(root, filePath);
          const st = await fsModule.stat(absPath);
          preMode = st.mode & 0o7777;
        } catch {}
      }

      // a. 从暂存区重置
      await this.runGit(['reset', 'HEAD', '--', filePath], root);
      // b. 强制检出 HEAD 内容覆盖工作区
      const coHead = await this.runGit(['checkout', '-f', 'HEAD', '--', filePath], root);
      if (coHead.code !== 0) {
        await this.runGit(['checkout', '-f', '--', filePath], root);
        await this.runGit(['restore', '--staged', '--worktree', '--', filePath], root);
      }

      // c. 权限位 (File Mode) 纠偏与保留：
      // 绝对不要对目录操作，且绝不能抹杀原有可执行权限
      try {
        const lsTree = await this.runGit(['ls-tree', 'HEAD', '--', filePath], root);
        if (lsTree.code === 0 && lsTree.stdout.trim()) {
          // 只对普通文件（100644 / 100755 blob）纠偏/恢复权限位。
          // 目录在 ls-tree 里是「040000 tree」、符号链接是「120000 blob」——一律跳过。
          const modeMatch = lsTree.stdout.trim().match(/^(\d{6})\s+(\w+)\s/);
          const expectedMode = modeMatch?.[1] ?? '';
          const expectedType = modeMatch?.[2] ?? '';
          const isPlainFile =
            expectedType === 'blob' && (expectedMode === '100644' || expectedMode === '100755');
          if (isPlainFile) {
            const isGitExecutable = expectedMode === '100755';
            const wasDiskExecutable = preMode !== undefined && (preMode & 0o111) !== 0;

            if (isGitExecutable) {
              // Git HEAD 规定该文件为可执行文件 (100755)
              if (this.workspace.getKind() === 'ssh' && this.ssh) {
                await this.ssh.runCommand(`chmod 755 '${filePath.replace(/'/g, "'\\''")}'`);
              } else if (process.platform !== 'win32') {
                try {
                  const fsModule = await import('fs/promises');
                  const pathModule = await import('path');
                  const absPath = pathModule.resolve(root, filePath);
                  await fsModule.chmod(absPath, 0o755);
                } catch {}
              }
              await this.runGit(['update-index', '--chmod=+x', filePath], root);
            } else if (wasDiskExecutable && preMode !== undefined) {
              // 磁盘原本带可执行权限位（如自定义脚本或配置），保留原有权限位，绝不强行降级为 644
              const chmodOctal = (preMode & 0o7777).toString(8);
              if (this.workspace.getKind() === 'ssh' && this.ssh) {
                await this.ssh.runCommand(`chmod ${chmodOctal} '${filePath.replace(/'/g, "'\\''")}'`);
              } else if (process.platform !== 'win32') {
                try {
                  const fsModule = await import('fs/promises');
                  const pathModule = await import('path');
                  const absPath = pathModule.resolve(root, filePath);
                  await fsModule.chmod(absPath, preMode & 0o7777);
                } catch {}
              }
            } else if (preMode !== undefined) {
              // 普通非可执行文件，恢复 preMode 原有权限位
              const chmodOctal = (preMode & 0o7777).toString(8);
              if (this.workspace.getKind() === 'ssh' && this.ssh) {
                await this.ssh.runCommand(`chmod ${chmodOctal} '${filePath.replace(/'/g, "'\\''")}'`);
              } else if (process.platform !== 'win32') {
                try {
                  const fsModule = await import('fs/promises');
                  const pathModule = await import('path');
                  const absPath = pathModule.resolve(root, filePath);
                  await fsModule.chmod(absPath, preMode & 0o7777);
                } catch {}
              }
              await this.runGit(['update-index', '--chmod=-x', filePath], root);
            }
          }
        }
      } catch {
        // ignore mode query failure
      }

      // d. 刷新索引
      await this.runGit(['update-index', '-q', '--refresh', '--', filePath], root);
      await this.runGit(['update-index', '-q', '--really-refresh', '--', filePath], root);
    }

    // 2. 处理未跟踪文件的清理
    if (untracked.length) {
      const cleanRes = await this.runGit(['clean', '-fd', '--', ...untracked], root);
      if (cleanRes.code !== 0) {
        // 尝试通过 workspace 接口直接删除
        for (const u of untracked) {
          try {
            await this.workspace.remove(u);
          } catch {
            failures.push(`clean: ${cleanRes.stderr.trim() || '删除未跟踪文件失败'}`);
          }
        }
      }
    }

    // 3. 全局刷新索引
    await this.runGit(['update-index', '-q', '--really-refresh'], root);
    await this.runGit(['update-index', '-q', '--refresh'], root);

    // 4. 最终复查：放弃后若 Git 仍报告目标文件有改动，返回失败详情供前端提示
    const finalVerify = await this.status();
    if (finalVerify.ok && finalVerify.isRepo) {
      const remainingDirty = finalVerify.entries.filter((e) => {
        const ep = e.path.replace(/\\/g, '/').replace(/^\/+/, '');
        return cleanInputPaths.some(
          (cp) =>
            ep === cp || ep.startsWith(cp + '/') || cp.endsWith('/' + ep) || ep.endsWith('/' + cp),
        );
      });
      if (remainingDirty.length > 0) {
        return {
          ok: false,
          detail: `放弃后文件仍有改动: ${remainingDirty.map((d) => d.path).join(', ')}`,
        };
      }
    }

    if (failures.length > 0) {
      return { ok: false, detail: failures.join('; ') };
    }

    return { ok: true, detail: '已还原改动' };
  }

  async diff(relPath: string, staged = false): Promise<GitDiffResult> {
    const gate = this.localRootOrError();
    if ('ok' in gate && gate.ok === false) {
      return {
        ok: false,
        detail: gate.detail,
        path: relPath,
        original: '',
        modified: '',
        staged,
        isTracked: false,
      };
    }
    const { root } = gate as { root: string };
    const check = await this.runGit(['rev-parse', '--is-inside-work-tree'], root);
    if (check.code !== 0 || !check.stdout.trim().includes('true')) {
      return {
        ok: false,
        detail: 'Not a git repository',
        path: relPath,
        original: '',
        modified: '',
        staged,
        isTracked: false,
      };
    }

    let posix = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (root) {
      const normRoot = root.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\/+/, '');
      if (posix.startsWith(normRoot)) {
        posix = posix.slice(normRoot.length).replace(/^\/+/, '');
      }
    }

    if (staged) {
      let original = '';
      const head = await this.runGit(['show', `HEAD:${posix}`], root);
      if (head.code === 0) original = head.stdout;
      const cached = await this.runGit(['show', `:0:${posix}`], root);
      const modified = cached.code === 0 ? cached.stdout : '';
      return { ok: true, path: posix, original, modified, staged: true, isTracked: true };
    }

    // unstaged: 优先以 HEAD 为基准版本，使得自最新 commit 以来的修改在编辑器左侧 gutter 均能准确呈现变动色条
    let original = '';
    let isTracked = false;
    const headShow = await this.runGit(['show', `HEAD:${posix}`], root);
    if (headShow.code === 0) {
      original = headShow.stdout;
      isTracked = true;
    } else {
      const indexShow = await this.runGit(['show', `:0:${posix}`], root);
      if (indexShow.code === 0) {
        original = indexShow.stdout;
        isTracked = true;
      }
    }

    // If not found directly, check git status entries for untracked or renamed path
    if (!isTracked) {
      try {
        const status = await this.status();
        const entry = status.entries.find((e) => {
          const ep = e.path.replace(/\\/g, '/').replace(/^\/+/, '');
          return ep === posix || posix.endsWith('/' + ep) || ep.endsWith('/' + posix);
        });
        if (entry && !entry.untracked) {
          const headShow = await this.runGit(['show', `HEAD:${entry.path}`], root);
          if (headShow.code === 0) {
            original = headShow.stdout;
            isTracked = true;
          } else {
            const indexShow = await this.runGit(['show', `:0:${entry.path}`], root);
            if (indexShow.code === 0) {
              original = indexShow.stdout;
              isTracked = true;
            }
          }
        }
      } catch {
        // status fallback failed, treat as untracked/new
      }
    }

    let modified = '';
    try {
      modified = await this.workspace.readFile(posix);
    } catch {
      modified = '';
    }

    return { ok: true, path: posix, original, modified, staged: false, isTracked };
  }

  async branches(): Promise<{
    ok: boolean;
    detail?: string;
    branches: GitBranchInfo[];
    tags?: string[];
  }> {
    const gate = this.localRootOrError();
    if ('ok' in gate && gate.ok === false) {
      return { ok: false, detail: gate.detail, branches: [] };
    }
    const { root } = gate as { root: string };

    // 1. 获取当前分支名
    let currentBranchName = '';
    try {
      const curRes = await this.runGit(['rev-parse', '--abbrev-ref', 'HEAD'], root);
      if (curRes.code === 0) {
        currentBranchName = curRes.stdout.trim();
      }
    } catch {
      /* ignore */
    }

    // 2. 极速获取分支及其最新提交记录 (hash, message, relativeDate, author)
    const refFormat =
      '%(refname)|%(objectname:short)|%(subject)|%(committerdate:relative)|%(authorname)';
    const res = await this.runGit(
      ['for-each-ref', `--format=${refFormat}`, 'refs/heads', 'refs/remotes'],
      root,
    );

    const branches: GitBranchInfo[] = [];

    if (res.code === 0 && res.stdout.trim()) {
      for (const raw of res.stdout.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        const [refname, hash, subject, relativeDate, author] = line.split('|');
        if (!refname) continue;

        let name = '';
        let remote = false;

        if (refname.startsWith('refs/heads/')) {
          name = refname.slice('refs/heads/'.length);
          remote = false;
        } else if (refname.startsWith('refs/remotes/')) {
          name = refname.slice('refs/remotes/'.length);
          remote = true;
          // 跳过 remotes/origin/HEAD 符号引用
          if (name.endsWith('/HEAD') || name === 'HEAD') continue;
        } else {
          continue;
        }

        const current = !remote && (name === currentBranchName || currentBranchName === 'HEAD');

        branches.push({
          name,
          current,
          remote,
          lastCommit: hash
            ? {
                hash,
                message: subject || '',
                relativeDate: relativeDate || '',
                author: author || '',
              }
            : undefined,
        });
      }
    } else {
      // 回退方案：兼容异常或空仓库
      const fallbackRes = await this.runGit(['branch', '-a', '--no-color'], root);
      if (fallbackRes.code === 0) {
        for (const raw of fallbackRes.stdout.split(/\r?\n/)) {
          const line = raw.trim();
          if (!line) continue;
          const current = line.startsWith('*');
          let name = line.replace(/^\*\s+/, '').trim();
          if (name.includes('->')) continue;
          const remote = name.startsWith('remotes/');
          if (remote) name = name.replace(/^remotes\//, '');
          branches.push({ name, current, remote });
        }
      }
    }

    const tagsRes = await this.runGit(['tag', '-l'], root);
    const tags: string[] =
      tagsRes.code === 0
        ? tagsRes.stdout
            .split(/\r?\n/)
            .map((t) => t.trim())
            .filter(Boolean)
        : [];

    return { ok: true, branches, tags };
  }

  private async restoreBranchStash(branchName: string, root: string): Promise<boolean> {
    if (!branchName) return false;
    const cleanBranch = branchName.replace(/^refs\/heads\//, '').trim();
    const listRes = await this.runGit(['stash', 'list', '--pretty=format:%gd%x09%gs'], root);
    if (listRes.code !== 0 || !listRes.stdout.trim()) return false;
    const targetTag = `echoly-branch-state:${cleanBranch}`;
    for (const line of listRes.stdout.split('\n')) {
      const parts = line.trim().split('\t');
      if (parts.length >= 2) {
        const ref = parts[0].trim();
        const msg = parts[1].trim();
        if (msg.includes(targetTag)) {
          const popRes = await this.runGit(['stash', 'pop', '--index', ref], root);
          if (popRes.code !== 0) {
            // 若带有 --index 冲突，回退到普通 pop
            const altPop = await this.runGit(['stash', 'pop', ref], root);
            if (altPop.code !== 0) {
              await this.runGit(['stash', 'apply', ref], root);
            }
          }
          return true;
        }
      }
    }
    return false;
  }

  async checkout(branch: string): Promise<GitOpResult> {
    const gate = this.localRootOrError();
    if ('ok' in gate && gate.ok === false) return gate;
    const { root } = gate as { root: string };
    const name = branch.trim();
    if (!name) return { ok: false, detail: '请指定分支' };

    // 1. 获取当前分支名
    const curBranchRes = await this.runGit(['branch', '--show-current'], root);
    const currentBranch = curBranchRes.stdout.trim();

    // 2. 如果是从当前分支切到同一分支，直接返回成功
    const targetLocal = name.includes('/') ? name.split('/').slice(1).join('/') : name;
    if (currentBranch && (currentBranch === name || currentBranch === targetLocal)) {
      return { ok: true, detail: `已在分支 ${name}` };
    }

    // 3. 检查当前分支是否有修改文件（工作区或暂存区）
    let stashedForCurrent = false;
    if (currentBranch) {
      const statusRes = await this.status();
      if (statusRes.ok && statusRes.isRepo && statusRes.entries.length > 0) {
        const stashMsg = `echoly-branch-state:${currentBranch}`;
        const stashRes = await this.runGit(
          ['stash', 'push', '--include-untracked', '-m', stashMsg],
          root,
        );
        if (stashRes.code === 0) {
          stashedForCurrent = true;
        }
      }
    }

    // 4. 执行分支切换
    let args = ['checkout', name];
    if (name.includes('/') && !name.startsWith('.')) {
      const exists = await this.runGit(
        ['show-ref', '--verify', `--quiet`, `refs/heads/${targetLocal}`],
        root,
      );
      if (exists.code !== 0) {
        args = ['checkout', '-b', targetLocal, '--track', name];
      } else {
        args = ['checkout', targetLocal];
      }
    }
    const res = await this.runGit(args, root);
    if (res.error || res.code !== 0) {
      // 切换失败时，若之前暂存了当前分支的修改，恢复它
      if (stashedForCurrent && currentBranch) {
        await this.restoreBranchStash(currentBranch, root);
      }
      return {
        ok: false,
        detail: res.error || res.stderr.trim() || res.stdout.trim() || '切换分支失败',
      };
    }

    // 5. 切换目标分支成功后，检查目标分支是否有之前保存的修改状态，有则自动恢复
    await this.restoreBranchStash(targetLocal, root);

    // 6. 刷新索引
    await this.runGit(['update-index', '-q', '--really-refresh'], root);

    // 7. 向渲染进程广播分支切换成功事件
    const win = this.getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('git:branchSwitched', { branch: targetLocal });
    }

    return { ok: true, detail: `已切换到 ${name}` };
  }

  async createBranch(name: string, doCheckout = true): Promise<GitOpResult> {
    const gate = this.localRootOrError();
    if ('ok' in gate && gate.ok === false) return gate;
    const { root } = gate as { root: string };
    const branch = name.trim();
    if (!branch) return { ok: false, detail: '请填写分支名' };
    const args = doCheckout ? ['checkout', '-b', branch] : ['branch', branch];
    const res = await this.runGit(args, root);
    if (res.error) return { ok: false, detail: res.error };
    if (res.code !== 0) return { ok: false, detail: res.stderr.trim() || '创建分支失败' };

    if (doCheckout) {
      const win = this.getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('git:branchSwitched', { branch });
      }
    }

    return { ok: true, detail: doCheckout ? `已创建并切换到 ${branch}` : `已创建 ${branch}` };
  }

  async pull(): Promise<GitOpResult> {
    const gate = this.localRootOrError();
    if ('ok' in gate && gate.ok === false) return gate;
    const { root } = gate as { root: string };
    const res = await this.runGit(['pull', '--ff-only'], root);
    if (res.error) return { ok: false, detail: res.error };
    if (res.code !== 0) {
      // retry without ff-only for broader compatibility
      const alt = await this.runGit(['pull'], root);
      if (alt.code !== 0) {
        return {
          ok: false,
          detail: (res.stderr || alt.stderr || alt.stdout || 'pull 失败').trim(),
        };
      }
      return { ok: true, detail: alt.stdout.trim() || 'pull 完成' };
    }
    return { ok: true, detail: res.stdout.trim() || 'pull 完成' };
  }

  async push(): Promise<GitOpResult> {
    const gate = this.localRootOrError();
    if ('ok' in gate && gate.ok === false) return gate;
    const { root } = gate as { root: string };
    const res = await this.runGit(['push', '-u', 'origin', 'HEAD'], root);
    if (res.error) return { ok: false, detail: res.error };
    if (res.code !== 0) {
      const alt = await this.runGit(['push'], root);
      if (alt.code !== 0) {
        return {
          ok: false,
          detail: (res.stderr || alt.stderr || alt.stdout || 'push 失败').trim(),
        };
      }
      return { ok: true, detail: alt.stdout.trim() || alt.stderr.trim() || 'push 完成' };
    }
    return { ok: true, detail: res.stdout.trim() || res.stderr.trim() || 'push 完成' };
  }

  async history(maxCount?: number): Promise<GitHistoryResult> {
    const gate = this.localRootOrError();
    if ('ok' in gate && gate.ok === false) {
      return { ok: false, detail: gate.detail, commits: [] };
    }
    const { root } = gate as { root: string };
    const logArgs = [
      'log',
      '--topo-order',
      '--pretty=format:%H%x09%h%x09%an%x09%ae%x09%at%x09%P%x09%s',
    ];
    if (typeof maxCount === 'number' && maxCount > 0) {
      logArgs.splice(1, 0, `-n${maxCount}`);
    }
    let res = await this.runGit(logArgs, root);

    // 如果当前分支尚无提交，或处于特殊检出状态，尝试获取全部分支的提交历史 (--all)
    if (res.code !== 0) {
      const allArgs = [
        'log',
        '--all',
        '--topo-order',
        '--pretty=format:%H%x09%h%x09%an%x09%ae%x09%at%x09%P%x09%s',
      ];
      if (typeof maxCount === 'number' && maxCount > 0) {
        allArgs.splice(1, 0, `-n${maxCount}`);
      }
      const allRes = await this.runGit(allArgs, root);
      if (allRes.code === 0 && allRes.stdout.trim()) {
        res = allRes;
      }
    }

    if (res.code !== 0) {
      const stderr = res.stderr.trim();
      if (
        stderr.includes('does not have any commits yet') ||
        stderr.includes('your current branch') ||
        stderr.includes('bad default revision') ||
        stderr.includes('ambiguous argument')
      ) {
        return {
          ok: true,
          detail: '当前仓库暂无提交历史（尚未初次提交）',
          commits: [],
          emptyRepo: true,
        };
      }
      return { ok: false, detail: stderr || '无法获取 Git 提交历史', commits: [] };
    }

    const shallowRes = await this.runGit(['rev-parse', '--is-shallow-repository'], root);
    const isShallow = shallowRes.stdout.trim() === 'true';

    const commits: GitCommitEntry[] = [];
    const lines = res.stdout.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split('\t');
      if (parts.length >= 6) {
        const hash = parts[0];
        const shortHash = parts[1];
        const author = parts[2];
        const authorEmail = parts[3];
        const timestampSec = Number(parts[4]) || 0;
        const parents = parts[5]?.trim() ? parts[5].trim().split(/\s+/) : [];
        const message = parts.slice(6).join('\t') || '';
        const { relativeDate, fullDate } = formatCommitDate(timestampSec);
        commits.push({
          hash,
          shortHash,
          author,
          authorEmail,
          timestamp: timestampSec ? timestampSec * 1000 : undefined,
          date: fullDate || relativeDate,
          relativeDate,
          fullDate,
          message,
          parents,
        });
      }
    }
    return { ok: true, commits, isShallow };
  }

  async fileHistory(filePath: string, maxCount?: number): Promise<GitHistoryResult> {
    const gate = this.localRootOrError();
    if ('ok' in gate && gate.ok === false) {
      return { ok: false, detail: gate.detail, commits: [] };
    }
    const { root } = gate as { root: string };
    const logArgs = [
      'log',
      '--pretty=format:%H%x09%h%x09%an%x09%ae%x09%at%x09%P%x09%s',
      '--',
      filePath,
    ];
    if (typeof maxCount === 'number' && maxCount > 0) {
      logArgs.splice(1, 0, `-n${maxCount}`);
    }
    const res = await this.runGit(logArgs, root);
    if (res.code !== 0) {
      const stderr = res.stderr.trim();
      if (
        stderr.includes('does not have any commits yet') ||
        stderr.includes('your current branch')
      ) {
        return { ok: true, detail: '当前文件暂无提交历史', commits: [] };
      }
      return { ok: false, detail: stderr || '无法获取该文件的 Git 历史', commits: [] };
    }
    const commits: GitCommitEntry[] = [];
    const lines = res.stdout.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split('\t');
      if (parts.length >= 6) {
        const hash = parts[0];
        const shortHash = parts[1];
        const author = parts[2];
        const authorEmail = parts[3];
        const timestampSec = Number(parts[4]) || 0;
        const parents = parts[5]?.trim() ? parts[5].trim().split(/\s+/) : [];
        const message = parts.slice(6).join('\t') || '';
        const { relativeDate, fullDate } = formatCommitDate(timestampSec);
        commits.push({
          hash,
          shortHash,
          author,
          authorEmail,
          timestamp: timestampSec ? timestampSec * 1000 : undefined,
          date: fullDate || relativeDate,
          relativeDate,
          fullDate,
          message,
          parents,
        });
      }
    }
    return { ok: true, commits };
  }

  async blameLine(filePath: string, line: number): Promise<GitBlameLineResult> {
    const gate = this.localRootOrError();
    if ('ok' in gate && gate.ok === false) {
      return { ok: false, detail: gate.detail };
    }
    const { root } = gate as { root: string };
    let posix = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (root) {
      const normRoot = root.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\/+/, '');
      if (posix.startsWith(normRoot)) {
        posix = posix.slice(normRoot.length).replace(/^\/+/, '');
      }
    }
    const res = await this.runGit(['blame', `-L${line},${line}`, '--porcelain', posix], root);
    if (res.code !== 0 || !res.stdout.trim()) {
      return {
        ok: true,
        line,
        commit: {
          hash: '0000000',
          shortHash: '0000000',
          author: 'You',
          date: '',
          relativeDate: '未提交的更改',
          message: '未保存或未提交的修改',
        },
      };
    }
    const lines = res.stdout.split('\n');
    const firstLine = lines[0] || '';
    const hash = firstLine.split(' ')[0] || '';
    if (!hash || /^0+$/.test(hash)) {
      return {
        ok: true,
        line,
        commit: {
          hash: '0000000',
          shortHash: '0000000',
          author: 'You',
          date: '',
          relativeDate: '未提交的更改',
          message: '未保存或未提交的修改',
        },
      };
    }
    let author = 'You';
    let summary = '';
    let authorTime = 0;
    for (const l of lines) {
      if (l.startsWith('author ')) author = l.slice(7).trim();
      else if (l.startsWith('author-time ')) authorTime = Number(l.slice(12).trim()) * 1000;
      else if (l.startsWith('summary ')) summary = l.slice(8).trim();
    }
    let relDate = '';
    if (authorTime) {
      const diffSec = Math.floor((Date.now() - authorTime) / 1000);
      if (diffSec < 60) relDate = '刚刚';
      else if (diffSec < 3600) relDate = `${Math.floor(diffSec / 60)} 分钟前`;
      else if (diffSec < 86400) relDate = `${Math.floor(diffSec / 3600)} 小时前`;
      else if (diffSec < 2592000) relDate = `${Math.floor(diffSec / 86400)} 天前`;
      else relDate = `${Math.floor(diffSec / 2592000)} 个月前`;
    }
    return {
      ok: true,
      line,
      commit: {
        hash,
        shortHash: hash.slice(0, 7),
        author,
        date: authorTime ? new Date(authorTime).toLocaleDateString() : '',
        relativeDate: relDate,
        message: summary.replace(/[\r\n]+/g, ' ').trim() || '无提交说明',
      },
    };
  }

  async commitDetails(hash: string): Promise<GitCommitDetailResult> {
    const gate = this.localRootOrError();
    if ('ok' in gate && gate.ok === false) {
      return { ok: false, detail: gate.detail, files: [] };
    }
    const { root } = gate as { root: string };
    let res = await this.runGit(
      [
        'show',
        '-m',
        '--first-parent',
        '--format=COMMIT_INFO%x00%H%x00%h%x00%an%x00%ae%x00%at%x00%B%x00%P',
        '--raw',
        '--shortstat',
        hash,
      ],
      root,
    );
    if (res.code !== 0) {
      const fallback = await this.runGit(
        [
          'show',
          '--format=COMMIT_INFO%x00%H%x00%h%x00%an%x00%ae%x00%at%x00%B%x00%P',
          '--raw',
          '--shortstat',
          hash,
        ],
        root,
      );
      if (fallback.code !== 0) {
        return {
          ok: false,
          detail: fallback.stderr.trim() || res.stderr.trim() || '无法获取 Commit 详情',
          files: [],
        };
      }
      res = fallback;
    }

    const files: GitCommitFileChange[] = [];
    let stats: GitCommitStats = { filesChanged: 0, insertions: 0, deletions: 0 };
    let commit: GitCommitEntry | undefined;

    const out = res.stdout;
    const infoPrefix = 'COMMIT_INFO\0';
    if (out.startsWith(infoPrefix)) {
      const rest = out.slice(infoPrefix.length);
      const parts = rest.split('\0');
      if (parts.length >= 6) {
        const fullHash = parts[0];
        const shortHash = parts[1];
        const author = parts[2];
        const authorEmail = parts[3];
        const timestampSec = Number(parts[4]) || 0;
        const body = parts[5];
        const nextContent = parts.slice(6).join('\0');
        const firstLineEnd = nextContent.indexOf('\n');
        const parentsStr =
          firstLineEnd !== -1 ? nextContent.slice(0, firstLineEnd).trim() : nextContent.trim();
        const parents = parentsStr ? parentsStr.split(/\s+/) : [];
        const { relativeDate, fullDate } = formatCommitDate(timestampSec);

        const remaining = firstLineEnd !== -1 ? nextContent.slice(firstLineEnd + 1) : '';
        const lines = remaining.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (line.startsWith(':')) {
            const rawParts = line.split('\t');
            if (rawParts.length >= 2) {
              const meta = rawParts[0].trim().split(/\s+/);
              const statusChar = (meta[meta.length - 1][0] ?? 'M') as 'M' | 'A' | 'D' | 'R';
              const filePath = rawParts[1].trim();
              files.push({ path: filePath, status: statusChar });
            }
          } else if (
            trimmed.includes('changed') ||
            trimmed.includes('insertion') ||
            trimmed.includes('deletion')
          ) {
            const mFiles = trimmed.match(/(\d+)\s+files?\s+changed/);
            const mIns = trimmed.match(/(\d+)\s+insertions?\(\+\)/);
            const mDel = trimmed.match(/(\d+)\s+deletions?\(-\)/);
            if (mFiles || mIns || mDel) {
              stats = {
                filesChanged: mFiles ? parseInt(mFiles[1], 10) : 0,
                insertions: mIns ? parseInt(mIns[1], 10) : 0,
                deletions: mDel ? parseInt(mDel[1], 10) : 0,
              };
            }
          }
        }

        if (stats.filesChanged === 0 && files.length > 0) {
          stats.filesChanged = files.length;
        }

        commit = {
          hash: fullHash,
          shortHash,
          author,
          authorEmail,
          timestamp: timestampSec ? timestampSec * 1000 : undefined,
          date: fullDate || relativeDate,
          relativeDate,
          fullDate,
          message: body.split('\n')[0] || '',
          body: body.trim(),
          parents,
          stats,
        };
      }
    }

    return { ok: true, commit, files, stats };
  }

  async showCommitDiff(hash: string, filePath: string): Promise<GitDiffResult> {
    const gate = this.localRootOrError();
    if ('ok' in gate && gate.ok === false) {
      return {
        ok: false,
        detail: gate.detail,
        path: filePath,
        original: '',
        modified: '',
        staged: false,
      };
    }
    const { root } = gate as { root: string };
    const [origRes, modRes] = await Promise.all([
      this.runGit(['show', `${hash}^:${filePath}`], root),
      this.runGit(['show', `${hash}:${filePath}`], root),
    ]);
    return {
      ok: true,
      path: filePath,
      original: origRes.code === 0 ? origRes.stdout : '',
      modified: modRes.code === 0 ? modRes.stdout : '',
      staged: false,
    };
  }

  // ── 新增：抓取 (fetch) ──
  async fetch(): Promise<GitOpResult> {
    const gate = this.localRootOrError();
    if ('ok' in gate && gate.ok === false) return gate;
    const { root } = gate as { root: string };
    const res = await this.runGit(['fetch', '--prune', '--all'], root);
    if (res.error) return { ok: false, detail: res.error };
    if (res.code !== 0) {
      // 没有配置远程时 git fetch 会报错，回到更友好的提示
      return {
        ok: false,
        detail: (res.stderr || res.stdout || 'fetch 失败').trim(),
      };
    }
    return { ok: true, detail: res.stderr.trim() || res.stdout.trim() || 'fetch 完成' };
  }

  // ── 新增：列出远程 (git remote -v) ──
  async remotes(): Promise<GitRemotesResult> {
    const gate = this.localRootOrError();
    if ('ok' in gate && gate.ok === false) {
      return { ok: false, detail: gate.detail, remotes: [] };
    }
    const { root } = gate as { root: string };
    const res = await this.runGit(['remote', '-v'], root);
    if (res.code !== 0) {
      return { ok: false, detail: res.stderr.trim() || '无法获取远程仓库', remotes: [] };
    }
    const remotes: GitRemoteInfo[] = [];
    const seen = new Set<string>();
    for (const line of res.stdout.split('\n')) {
      const m = line.match(/^(\S+)\s+(\S+)/);
      if (!m) continue;
      const name = m[1];
      const url = m[2];
      if (!seen.has(name)) {
        seen.add(name);
        remotes.push({ name, url });
      }
    }
    return { ok: true, remotes };
  }

  // ── 新增：存储 (stash) ──
  async stash(action: GitStashAction, message?: string): Promise<GitStashResult> {
    const gate = this.localRootOrError();
    if ('ok' in gate && gate.ok === false) {
      return { ok: false, detail: gate.detail, stashes: [] };
    }
    const { root } = gate as { root: string };

    const listNow = (): Promise<GitStashEntry[]> => {
      const list = this.runGit(['stash', 'list', '--pretty=format:%gd%x09%gs'], root);
      return list.then((r) => {
        if (r.code !== 0) return [];
        const stashes: GitStashEntry[] = [];
        for (const line of r.stdout.split('\n')) {
          const t = line.trim();
          if (!t) continue;
          const idx = t.indexOf('\t');
          const tag = idx >= 0 ? t.slice(0, idx) : t;
          const msg = idx >= 0 ? t.slice(idx + 1) : '';
          const m = tag.match(/stash@\{(\d+)\}/);
          const index = m ? parseInt(m[1], 10) : stashes.length;
          stashes.push({ index, message: msg });
        }
        return stashes;
      });
    };

    if (action === 'list') {
      const stashes = await listNow();
      return { ok: true, stashes };
    }

    if (action === 'push') {
      const args = ['stash', 'push'];
      if (message?.trim()) args.push('-m', message.trim());
      args.push('--include-untracked');
      const res = await this.runGit(args, root);
      if (res.error) return { ok: false, detail: res.error, stashes: [] };
      if (res.code !== 0) {
        return { ok: false, detail: res.stderr.trim() || 'stash push 失败', stashes: [] };
      }
      const stashes = await listNow();
      return { ok: true, detail: res.stdout.trim() || '已暂存修改', stashes };
    }

    if (action === 'pop' || action === 'apply') {
      const args = ['stash', action];
      const res = await this.runGit(args, root);
      if (res.error) return { ok: false, detail: res.error, stashes: [] };
      if (res.code !== 0) {
        return { ok: false, detail: res.stderr.trim() || `stash ${action} 失败`, stashes: [] };
      }
      const stashes = await listNow();
      return {
        ok: true,
        detail: res.stdout.trim() || `stash ${action} 完成`,
        stashes,
      };
    }

    // drop
    const args = message?.trim() ? ['stash', 'drop', message.trim()] : ['stash', 'drop'];
    const res = await this.runGit(args, root);
    if (res.error) return { ok: false, detail: res.error, stashes: [] };
    if (res.code !== 0) {
      return { ok: false, detail: res.stderr.trim() || 'stash drop 失败', stashes: [] };
    }
    const stashes = await listNow();
    return { ok: true, detail: res.stdout.trim() || '已删除一个 stash', stashes };
  }

  // ── 新增：列出标签 (git tag) ──
  async tags(): Promise<GitTagsResult> {
    const gate = this.localRootOrError();
    if ('ok' in gate && gate.ok === false) {
      return { ok: false, detail: gate.detail, tags: [] };
    }
    const { root } = gate as { root: string };
    const res = await this.runGit(['tag', '--list'], root);
    if (res.code !== 0) {
      return { ok: false, detail: res.stderr.trim() || '无法获取标签', tags: [] };
    }
    const tags = res.stdout
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean);
    return { ok: true, tags };
  }

  // ── 新增：创建标签 (git tag -a -m) ──
  async createTag(name: string, message?: string): Promise<GitOpResult> {
    const gate = this.localRootOrError();
    if ('ok' in gate && gate.ok === false) return gate;
    const { root } = gate as { root: string };
    if (!name.trim()) return { ok: false, detail: '标签名不能为空' };
    const args = ['tag'];
    if (message?.trim()) {
      args.push('-a', name.trim(), '-m', message.trim());
    } else {
      args.push(name.trim());
    }
    const res = await this.runGit(args, root);
    if (res.error) return { ok: false, detail: res.error };
    if (res.code !== 0) {
      return { ok: false, detail: res.stderr.trim() || '创建标签失败' };
    }
    return { ok: true, detail: `已创建标签 ${name.trim()}` };
  }

  // ── 新增：git 输出日志 (最近 N 条 reflog) ──
  async output(maxCount = 50): Promise<GitOutputResult> {
    const gate = this.localRootOrError();
    if ('ok' in gate && gate.ok === false) {
      return { ok: false, detail: gate.detail, lines: [] };
    }
    const { root } = gate as { root: string };
    const res = await this.runGit(
      ['reflog', '-n', String(Math.max(1, maxCount)), '--date=relative'],
      root,
    );
    if (res.code !== 0) {
      return { ok: false, detail: res.stderr.trim() || '无法获取 Git 输出', lines: [] };
    }
    const lines = res.stdout.split('\n').filter((l) => l.trim().length > 0);
    return { ok: true, lines };
  }
}

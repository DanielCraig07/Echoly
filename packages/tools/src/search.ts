import { spawn } from 'node:child_process';
import { resolveInWorkspace } from './pathJail.js';
import type { WorkspaceBackend } from './backend.js';

export interface CodeSearchHit {
  path: string;
  line: number;
  preview: string;
}

export interface FileSearchHit {
  path: string;
  score: number;
}

export interface SearchOpts {
  glob?: string;
  path?: string;
  caseInsensitive?: boolean;
  maxResults?: number;
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'release', '.next', 'build',
  '__pycache__', '.venv', 'venv', 'target', '.idea', 'coverage', '.cache', 'vendor',
]);

const BINARY_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'pdf', 'zip', 'tar', 'gz', '7z',
  'exe', 'dll', 'so', 'dylib', 'bin', 'woff', 'woff2', 'ttf', 'eot', 'mp4', 'mp3',
  'dmg', 'iso', 'class', 'pyc', 'lock',
]);

function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLE_STAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DOUBLE_STAR::/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function parseRgLine(line: string): CodeSearchHit | null {
  // path:line:preview — path may contain drive letters on Windows rarely in rg cwd-relative
  const m = line.match(/^(.*?):(\d+):(.*)$/);
  if (!m) return null;
  const rawPath = m[1].replace(/^\.\//, '').replace(/\\/g, '/');
  return { path: rawPath, line: Number(m[2]), preview: m[3].slice(0, 300) };
}

function parseCommandSearchOutput(stdout: string, maxResults: number): CodeSearchHit[] {
  const hits: CodeSearchHit[] = [];
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const hit = parseRgLine(line);
    if (hit) {
      hits.push(hit);
      if (hits.length >= maxResults) break;
    }
  }
  return hits;
}

export async function searchWithRg(
  workspaceRoot: string,
  pattern: string,
  opts: SearchOpts = {},
): Promise<CodeSearchHit[]> {
  const cwd = opts.path ? resolveInWorkspace(workspaceRoot, opts.path) : workspaceRoot;
  const maxResults = opts.maxResults ?? 50;
  
  const args = [
    '--line-number',
    '--color', 'never',
    '--max-columns', '300',
    '--max-count', '50',        // 每个文件最多 50 次（减少）
    '--max-filesize', '2M',     // 跳过超过 2MB 的文件
    '--max-depth', '10',        // 最大搜索深度 10 层
    // 性能优化：使用 mmap（更快的文件读取）
    '--mmap',
  ];
  
  if (opts.caseInsensitive) args.push('-i');
  if (opts.glob) args.push('--glob', opts.glob);
  
  // 自动排除常见大型目录
  const excludes = [
    'node_modules', '.git', 'dist', 'build', 'out', 'release',
    '.next', '__pycache__', '.venv', 'venv', 'target', '.idea',
    'coverage', '.cache', 'vendor', 'tmp', 'temp',
  ];
  for (const ex of excludes) {
    args.push('--glob', `!${ex}`);
  }
  
  args.push('--', pattern, '.');

  return await new Promise((resolve, reject) => {
    const child = spawn('rg', args, { cwd, shell: false });
    const hits: CodeSearchHit[] = [];
    let buffer = '';
    let stderr = '';
    let killed = false;

    // 5 秒超时（更快）
    const timeout = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 500);
    }, 5000);

    child.stdout.on('data', (d) => {
      buffer += String(d);
      
      // 流式解析：边收边处理
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // 保留不完整的行
      
      for (const line of lines) {
        if (!line.trim()) continue;
        const hit = parseRgLine(line);
        if (hit) {
          hits.push(hit);
          // 达到目标数量立即停止
          if (hits.length >= maxResults) {
            killed = true;
            child.kill('SIGTERM');
            break;
          }
        }
      }
    });
    
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    
    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    
    child.on('close', (code) => {
      clearTimeout(timeout);
      
      // 处理残留的最后一行
      if (buffer.trim()) {
        const hit = parseRgLine(buffer);
        if (hit && hits.length < maxResults) hits.push(hit);
      }
      
      if (killed || code === 0 || code === 1) {
        resolve(hits);
      } else {
        // rg 未找到或错误，返回空结果而非失败
        if (code === 2 || stderr.includes('No such file')) {
          resolve([]);
        } else {
          reject(new Error(stderr || `rg exited ${code}`));
        }
      }
    });
  });
}

/**
 * 在远程 SSH 服务器上直接运行搜索命令（rg / git grep / grep），无需将整个工程逐文件通过 SFTP 下载到本地
 */
export async function searchCodeRemote(
  backend: WorkspaceBackend,
  pattern: string,
  opts: SearchOpts = {},
): Promise<CodeSearchHit[]> {
  const maxResults = opts.maxResults ?? 50;
  const escPattern = shellEscape(pattern);
  const searchPath = opts.path ? shellEscape(opts.path) : '.';

  const excludes = [
    '.git', 'node_modules', 'dist', 'build', 'out', 'release',
    '.next', '__pycache__', '.venv', 'venv', 'target', '.idea',
    'coverage', '.cache', 'vendor', 'tmp', 'temp',
  ];

  // 1. 优先尝试远端 rg（极速 Rust 并发检索，自动尊重 .gitignore）
  try {
    const rgArgs = [
      'rg',
      '--line-number',
      '--color', 'never',
      '--max-columns', '300',
      '--max-count', '50',
      '--max-filesize', '2M',
      '--max-depth', '12',
    ];
    if (opts.caseInsensitive) rgArgs.push('-i');
    if (opts.glob) rgArgs.push('--glob', shellEscape(opts.glob));
    for (const ex of excludes) {
      rgArgs.push('--glob', shellEscape(`!${ex}`));
    }
    rgArgs.push('-e', escPattern, searchPath);
    const res = await backend.runCommand(rgArgs.join(' '), 8000);
    const notFound = res.stderr.toLowerCase().includes('not found');
    if (!notFound && (res.code === 0 || res.code === 1)) {
      return parseCommandSearchOutput(res.stdout, maxResults);
    }
  } catch {
    // fall through
  }

  // 2. 次选 git grep（在 git 仓库中毫秒级检索，自动遵循 .gitignore，-E 扩展正则，--untracked 覆盖未追踪文件）
  try {
    const gitArgs = ['git', 'grep', '-n', '-I', '-E', '--untracked'];
    if (opts.caseInsensitive) gitArgs.push('-i');
    gitArgs.push('-e', escPattern);
    gitArgs.push('--', searchPath);
    const gitRes = await backend.runCommand(gitArgs.join(' '), 8000);
    const gitErr = gitRes.stderr.toLowerCase();
    const isGitRepo = !gitErr.includes('not a git repository') && !gitErr.includes('not found');
    if (isGitRepo && (gitRes.code === 0 || gitRes.code === 1)) {
      return parseCommandSearchOutput(gitRes.stdout, maxResults);
    }
  } catch {
    // fall through
  }

  // 3. 通用 find + grep（POSIX 兼容，遍历时直接 prune 剪枝跳过 node_modules/.git 等重型目录，避免无效 IO）
  try {
    const pruneParts = excludes.map((d) => `-name ${shellEscape(d)}`).join(' -o ');
    const globPart = opts.glob ? ` -name ${shellEscape(opts.glob)}` : '';
    const caseFlag = opts.caseInsensitive ? '-i' : '';
    const findCmd = `find ${searchPath} -maxdepth 12 \\( ${pruneParts} \\) -prune -o -type f${globPart} -size -2M -exec grep -n -I -E ${caseFlag} -m 20 -e ${escPattern} {} + 2>/dev/null`;
    const findRes = await backend.runCommand(findCmd, 10000);
    const findErr = findRes.stderr.toLowerCase();
    if (!findErr.includes('not found') && (findRes.code === 0 || findRes.code === 1 || findRes.stdout.trim().length > 0)) {
      return parseCommandSearchOutput(findRes.stdout, maxResults);
    }
  } catch {
    // fall through
  }

  // 4. 标准 grep 回退（显式展开各个 --exclude-dir 参数，避免 sh/dash 下花括号未展开导致扫描 node_modules）
  try {
    const grepArgs = ['grep', '-rnIE'];
    for (const ex of excludes) {
      grepArgs.push(`--exclude-dir=${shellEscape(ex)}`);
    }
    if (opts.caseInsensitive) grepArgs.push('-i');
    if (opts.glob) grepArgs.push(`--include=${shellEscape(opts.glob)}`);
    grepArgs.push('-m', '20', '-e', escPattern, searchPath);
    const grepRes = await backend.runCommand(grepArgs.join(' ') + ' 2>/dev/null', 10000);
    if (grepRes.code === 0 || grepRes.code === 1 || grepRes.stdout.trim().length > 0) {
      return parseCommandSearchOutput(grepRes.stdout, maxResults);
    }
  } catch {
    // fall through
  }

  // 远端所有原生命令均未检索到结果时直接返回空列表，绝对不可回退到逐文件 SFTP 读取
  return [];
}

export async function searchViaBackend(
  backend: WorkspaceBackend,
  pattern: string,
  opts: SearchOpts = {},
): Promise<CodeSearchHit[]> {
  // SSH 远程工作区严禁使用逐文件 SFTP 下载遍历，必须走服务端原生命令检索
  if (backend.kind === 'ssh') {
    return await searchCodeRemote(backend, pattern, opts);
  }

  let re: RegExp;
  try {
    re = new RegExp(pattern, opts.caseInsensitive ? 'i' : '');
  } catch {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(escaped, opts.caseInsensitive ? 'i' : '');
  }
  const max = opts.maxResults ?? 50;
  const matches: CodeSearchHit[] = [];
  const startRel = opts.path ?? '.';
  const globRe = opts.glob ? globToRegExp(opts.glob) : null;
  let fileCount = 0;
  const MAX_WALK_FILES = 2000;

  async function walk(rel: string): Promise<void> {
    if (matches.length >= max || fileCount >= MAX_WALK_FILES) return;
    let entries;
    try {
      entries = await backend.listDir(rel);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (matches.length >= max || fileCount >= MAX_WALK_FILES) return;
      if (SKIP_DIRS.has(entry.name)) continue;
      const childRel = rel === '.' ? entry.name : `${rel.replace(/\/$/, '')}/${entry.name}`;
      if (entry.isDirectory) {
        await walk(childRel);
        continue;
      }
      if (globRe && !globRe.test(childRel) && !globRe.test(entry.name)) continue;

      // 跳过常见二进制拓展名，防止大文件网络传输
      const ext = entry.name.split('.').pop()?.toLowerCase();
      if (ext && BINARY_EXTS.has(ext)) continue;

      fileCount++;
      try {
        const text = await backend.readFile(childRel);
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            matches.push({
              path: childRel.replace(/\\/g, '/'),
              line: i + 1,
              preview: lines[i].slice(0, 300),
            });
            if (matches.length >= max) break;
          }
        }
      } catch {
        // skip binary/unreadable
      }
    }
  }

  await walk(startRel);
  return matches;
}

export function formatCodeHits(hits: CodeSearchHit[]): string {
  if (!hits.length) return '(no matches)';
  return hits.map((h) => `${h.path}:${h.line}:${h.preview}`).join('\n');
}

/**
 * 远程快速文件收集：使用远端命令（git ls-files / rg / find），单次网络请求毫秒级返回
 */
export async function collectFilePathsRemote(
  backend: WorkspaceBackend,
  maxFiles = 5000,
): Promise<string[]> {
  // 1. 尝试 git ls-files（毫秒级、自动排除 .gitignore）
  try {
    const gitRes = await backend.runCommand(
      'git ls-files --cached --others --exclude-standard',
      6000,
    );
    if (gitRes.code === 0 && gitRes.stdout.trim()) {
      const lines = gitRes.stdout
        .split(/\r?\n/)
        .map((s) => s.trim().replace(/^\.\//, '').replace(/\\/g, '/'))
        .filter((s) => s && s !== '.');
      if (lines.length > 0) {
        return lines.slice(0, maxFiles);
      }
    }
  } catch {
    // fall through
  }

  // 2. 尝试 rg --files
  try {
    const rgCmd = "rg --files --hidden -g '!.git' -g '!node_modules' -g '!dist' -g '!out' -g '!build' -g '!.next' -g '!__pycache__' -g '!vendor' -g '!target' -g '!.venv' -g '!venv' --max-filesize 2M";
    const rgRes = await backend.runCommand(rgCmd, 6000);
    if (rgRes.code === 0 && rgRes.stdout.trim()) {
      const lines = rgRes.stdout
        .split(/\r?\n/)
        .map((s) => s.trim().replace(/^\.\//, '').replace(/\\/g, '/'))
        .filter((s) => s && s !== '.');
      if (lines.length > 0) {
        return lines.slice(0, maxFiles);
      }
    }
  } catch {
    // fall through
  }

  // 3. 尝试 POSIX find
  try {
    const findCmd = "find . -maxdepth 10 \\( -name .git -o -name node_modules -o -name dist -o -name out -o -name build -o -name .next -o -name __pycache__ -o -name vendor -o -name target -o -name .venv -o -name venv \\) -prune -o -type f -print";
    const findRes = await backend.runCommand(findCmd, 8000);
    if (findRes.code === 0 && findRes.stdout.trim()) {
      const lines = findRes.stdout
        .split(/\r?\n/)
        .map((s) => s.trim().replace(/^\.\//, '').replace(/\\/g, '/'))
        .filter((s) => s && s !== '.');
      if (lines.length > 0) {
        return lines.slice(0, maxFiles);
      }
    }
  } catch {
    // fall through
  }

  return [];
}

async function walkCollectFilePaths(
  backend: WorkspaceBackend,
  maxFiles = 5000,
): Promise<string[]> {
  const files: string[] = [];

  async function walk(rel: string): Promise<void> {
    if (files.length >= maxFiles) return;
    let entries;
    try {
      entries = await backend.listDir(rel);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (SKIP_DIRS.has(entry.name)) continue;
      const childRel = rel === '.' ? entry.name : `${rel.replace(/\/$/, '')}/${entry.name}`;
      if (entry.isDirectory) {
        await walk(childRel);
      } else {
        files.push(childRel.replace(/\\/g, '/'));
      }
    }
  }

  await walk('.');
  return files;
}

export async function collectFilePaths(
  backend: WorkspaceBackend,
  maxFiles = 5000,
): Promise<string[]> {
  if (backend.kind === 'ssh' && typeof backend.runCommand === 'function') {
    try {
      const remoteFiles = await collectFilePathsRemote(backend, maxFiles);
      if (remoteFiles && remoteFiles.length > 0) {
        return remoteFiles;
      }
    } catch {
      // fall through to walk
    }
  }

  return await walkCollectFilePaths(backend, maxFiles);
}

export function fuzzyScore(path: string, query: string): number {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const full = path.toLowerCase();
  const base = full.split('/').pop() || full;
  if (base === q) return 1000;
  if (base.startsWith(q)) return 800 - (base.length - q.length);
  if (base.includes(q)) return 600 - base.indexOf(q);
  if (full.includes(q)) return 400 - full.indexOf(q);

  // subsequence match on basename
  let qi = 0;
  let score = 200;
  for (let i = 0; i < base.length && qi < q.length; i++) {
    if (base[i] === q[qi]) {
      score += 2;
      qi++;
    }
  }
  if (qi === q.length) return score - (base.length - q.length);
  return -1;
}

export function filterAndScoreFiles(
  files: string[],
  query: string,
  maxResults = 50,
): FileSearchHit[] {
  const q = query.trim();
  if (!q) return [];
  const hits: FileSearchHit[] = [];
  for (const path of files) {
    const score = fuzzyScore(path, q);
    if (score >= 0) hits.push({ path, score });
  }
  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return hits.slice(0, maxResults);
}

export async function searchFilesByQuery(
  backend: WorkspaceBackend,
  query: string,
  maxResults = 50,
): Promise<FileSearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  const files = await collectFilePaths(backend);
  return filterAndScoreFiles(files, q, maxResults);
}

export async function globFilesByPattern(
  backend: WorkspaceBackend,
  pattern: string,
  maxResults = 200,
): Promise<string[]> {
  const re = globToRegExp(pattern.startsWith('**/') || pattern.includes('/') ? pattern : `**/${pattern}`);
  const files = await collectFilePaths(backend, Math.max(maxResults * 20, 2000));
  const matches: string[] = [];
  for (const path of files) {
    const name = path.split('/').pop() || path;
    if (re.test(path) || re.test(name)) {
      matches.push(path);
      if (matches.length >= maxResults) break;
    }
  }
  return matches;
}

import type { PendingDiff, PermissionMode } from '@deepseek-ide/shared';
import type { WorkspaceBackend } from './backend.js';
import { LocalFsBackend } from './backend.js';
import { AGENT_TOOL_DEFINITIONS } from './definitions.js';
import {
  formatCodeHits,
  globFilesByPattern,
  searchCodeRemote,
  searchSymbols,
  searchViaBackend,
  searchWithRg,
} from './search.js';

export { AGENT_TOOL_DEFINITIONS, toolsForMode, READONLY_TOOL_NAMES, WRITE_TOOL_NAMES } from './definitions.js';
export { revertMutations } from './checkpoint.js';
export type { RevertResult } from './checkpoint.js';
export { resolveInWorkspace, PathJailError, toPosixRel } from './pathJail.js';
export type { WorkspaceBackend, DirEntry, CommandResult, FileStat } from './backend.js';
export { LocalFsBackend } from './backend.js';
export {
  globToRegExp,
  searchWithRg,
  searchViaBackend,
  searchCodeRemote,
  searchFilesByQuery,
  globFilesByPattern,
  collectFilePaths,
  collectFilePathsLocal,
  collectFilePathsRemote,
  filterAndScoreFiles,
  fuzzyScore,
  formatCodeHits,
  searchSymbols,
  runLocalCommand,
  getAugmentedEnv,
} from './search.js';
export type { CodeSearchHit, FileSearchHit, SearchOpts, CodeSymbolHit, SymbolKind } from './search.js';

export interface ToolContext {
  workspaceRoot: string;
  backend: WorkspaceBackend;
  permissionMode: PermissionMode;
  /** 运行中实时读取权限（切换「允许所有」后立即生效） */
  getPermissionMode?: () => PermissionMode;
  /** @deprecated Derived from permissionMode. */
  autoApproveReadonlyTerminal: boolean;
  /** @deprecated Derived from permissionMode. */
  requireConfirmForWrites: boolean;
  requestConfirm: (req: {
    title: string;
    detail: string;
    kind: 'terminal' | 'write' | 'delete' | 'other';
    options?: string[];
    allowInput?: boolean;
  }) => Promise<boolean | string>;
  enqueueDiff: (diff: Omit<PendingDiff, 'id'> & { id?: string }) => PendingDiff;
  applyImmediately?: boolean;
  getApplyImmediately?: () => boolean;
  onTerminalOutput?: (chunk: string) => void;
  /**
   * 文件系统副作用的**写前记录**，宿主用它做「撤销本轮 AI 改动」。
   *
   * 为什么不复用 `enqueueDiff`：diff 只覆盖 write/patch，且会被逐条 accept/reject 清空，
   * 而一次撤销需要覆盖整轮里所有写、删、移动，并且要在用户已经 accept 之后仍然有效。
   * 所以这里记录的是「改之前是什么」，由宿主按 runId 攒起来，逆序回放。
   */
  onFileMutation?: (mutation: FileMutation) => void;
  /**
   * 读取当前工作区的编译/静态检查诊断（LSP 或 Monaco markers）。
   * 由宿主（主进程 / 渲染层）注入；未注入时 get_diagnostics 工具会明确报错，
   * 而不是编造一份「无问题」的假结果。
   */
  getDiagnostics?: (relPath?: string) => Promise<DiagnosticEntry[]>;
  /**
   * 代码库语义检索（倒排索引 + 自然语言打分）。宿主未建索引时返回空数组。
   */
  codebaseSearch?: (query: string, limit?: number) => Promise<CodebaseChunk[]>;
  /**
   * 宿主接入的 MCP 工具集合。
   *
   * 分成两半是必须的：`call` 只管把参数送过去，**权限判断留在这里**（执行入口会
   * 检查 `readonlyNames`，非只读的先走确认流程）。若把权限判断交给宿主，
   * 那么「改了 MCP 配置之后权限语义跟着变」这件事就散落在两个包里，
   * 迟早会出现一条绕过确认的路径。
   */
  mcp?: {
    /** 全部由 MCP 提供的暴露名。命中即走 MCP 分支，不再落入内置工具的 switch。 */
    toolNames: ReadonlySet<string>;
    readonlyNames: ReadonlySet<string>;
    call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  };
}

/**
 * 一次文件系统副作用的写前记录。
 *
 * `write` 的 `original` 为 `null` 表示「改之前该路径不存在」——撤销时应删除它，
 * 而不是写入空文件。这一点必须区分，否则 AI 新建的文件被撤销后会变成 0 字节残留。
 *
 * `written` 是本次写进去的内容，只用来做**冲突检测**：撤销时若磁盘上的内容既不是
 * `written`、也不是 `original`，说明用户在本轮之后又手工改过它，撤销会吞掉那笔改动，
 * 此时宁可跳过并如实报告。拿不到（超预算 / 宿主未开记录）时为 `null`，表示不做这项检查。
 */
export type FileMutation =
  | { kind: 'write'; path: string; original: string | null; written: string | null }
  | { kind: 'delete'; path: string; snapshot: PathSnapshot | null }
  | { kind: 'move'; from: string; to: string }
  /**
   * 无法忠实记录的操作（二进制文件、超预算的大目录……）。
   * 宿主据此把整轮标记为「不可撤销」——宁可让按钮点不动，
   * 也不能给出一次「看起来成功、实则只还原了一半」的撤销。
   */
  | { kind: 'unrecordable'; path: string; reason: string };

/** 被删除路径的内容快照，用于撤销时原样重建。 */
export interface PathSnapshot {
  /** 需要先建出来的目录（相对路径，按层级升序）。 */
  dirs: string[];
  files: Array<{ path: string; content: string }>;
}

/** 一条诊断，从 LSP Diagnostic 或 Monaco Marker 归一化而来。 */
export interface DiagnosticEntry {
  path: string;
  line: number;
  column?: number;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  source?: string;
}

/** codebase_search 返回的代码块。 */
export interface CodebaseChunk {
  path: string;
  name: string;
  kind: string;
  line: number;
  endLine?: number;
  content: string;
}

export function currentPermissionMode(ctx: ToolContext): PermissionMode {
  return ctx.getPermissionMode?.() ?? ctx.permissionMode;
}

function shouldApplyImmediately(ctx: ToolContext): boolean {
  if (ctx.getApplyImmediately) return ctx.getApplyImmediately();
  if (ctx.applyImmediately !== undefined) return ctx.applyImmediately;
  return true;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  pendingDiff?: PendingDiff;
}

function truncate(text: string, max = 80_000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n...[truncated ${text.length - max} chars]`;
}

/**
 * 快照预算。撤销一次的代价是被删内容重写回磁盘，所以「先记下来」必须是有界的：
 * 一个 200MB 的构建产物目录不该被拖进内存，也不该让撤销按钮变成一次几秒的写盘。
 * 超预算时返回 null，由调用方标记整轮不可撤销。
 */
const SNAPSHOT_MAX_FILES = 2_000;
const SNAPSHOT_MAX_CHARS = 8_000_000;
const SNAPSHOT_MAX_DEPTH = 24;

/** NUL 字节是二进制文件最可靠的信号：文本文件里不该出现它。 */
function looksBinary(text: string): boolean {
  return text.includes('\0');
}

/**
 * 把 `relPath` 当前内容整份读进内存，供撤销时原样重建。
 *
 * 后端接口没有 `stat`，所以「是文件还是目录」用 listDir 是否成功来判断 ——
 * 与 deletePathTool 里同一套约定。
 */
export async function snapshotPath(
  backend: WorkspaceBackend,
  relPath: string,
): Promise<PathSnapshot | null> {
  const snapshot: PathSnapshot = { dirs: [], files: [] };
  let totalChars = 0;
  let overflow = false;

  const walk = async (current: string, depth: number): Promise<void> => {
    if (overflow) return;
    if (depth > SNAPSHOT_MAX_DEPTH) {
      overflow = true;
      return;
    }
    let entries: Awaited<ReturnType<WorkspaceBackend['listDir']>> | null = null;
    try {
      entries = await backend.listDir(current);
    } catch {
      entries = null;
    }

    if (entries === null) {
      // 叶子：按文件读
      if (snapshot.files.length >= SNAPSHOT_MAX_FILES) {
        overflow = true;
        return;
      }
      let content: string;
      try {
        content = await backend.readFile(current);
      } catch {
        overflow = true;
        return;
      }
      if (looksBinary(content)) {
        overflow = true;
        return;
      }
      totalChars += content.length;
      if (totalChars > SNAPSHOT_MAX_CHARS) {
        overflow = true;
        return;
      }
      snapshot.files.push({ path: current, content });
      return;
    }

    if (current !== relPath) snapshot.dirs.push(current);
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      const child = current === '.' ? entry.name : `${current.replace(/\/$/, '')}/${entry.name}`;
      await walk(child.replace(/\\/g, '/'), depth + 1);
      if (overflow) return;
    }
  };

  const rootLooksLikeDir = await (async () => {
    try {
      await backend.listDir(relPath);
      return true;
    } catch {
      return false;
    }
  })();

  if (rootLooksLikeDir) {
    snapshot.dirs.push(relPath.replace(/\\/g, '/'));
    try {
      const entries = await backend.listDir(relPath);
      for (const entry of entries) {
        if (entry.name === '.' || entry.name === '..') continue;
        const child = `${relPath.replace(/\/$/, '')}/${entry.name}`.replace(/\\/g, '/');
        await walk(child, 1);
        if (overflow) return null;
      }
    } catch {
      return null;
    }
  } else {
    await walk(relPath.replace(/\\/g, '/'), 1);
  }

  if (overflow || (snapshot.dirs.length === 0 && snapshot.files.length === 0)) return null;
  return snapshot;
}

/** 记录一次写前状态。宿主未注入 `onFileMutation` 时静默跳过（不影响工具本身可用）。 */
function recordMutation(ctx: ToolContext, mutation: FileMutation): void {
  ctx.onFileMutation?.(mutation);
}

/**
 * 读文件的写前内容。
 *
 * 必须区分「不存在」与「存在但是空文件」：前者撤销时该删掉这个文件，
 * 后者撤销时该把它写回成 0 字节。`readFile` 失败一律被当成空串，
 * 所以这里额外问一次 `exists`。
 */
async function readOriginal(
  backend: WorkspaceBackend,
  relPath: string,
): Promise<string | null> {
  try {
    if (!(await backend.exists(relPath))) return null;
  } catch {
    return null;
  }
  try {
    return await backend.readFile(relPath);
  } catch {
    return null;
  }
}

function parseArgs<T extends Record<string, unknown>>(raw: unknown): T {
  if (!raw) return {} as T;
  if (typeof raw === 'object' && raw !== null) return raw as T;
  if (typeof raw !== 'string') return {} as T;
  try {
    const trimmed = raw.trim();
    if (!trimmed) return {} as T;
    return JSON.parse(trimmed) as T;
  } catch {
    return {} as T;
  }
}

const READONLY_TERMINAL_RE =
  /^(rg|dir|ls|cat|type|git\s+(status|diff|log|show|branch|rev-parse)|pwd|echo|where|which|node\s+-v|npm\s+-v|python\s+--version)/i;

const DANGEROUS_TERMINAL_RE =
  /\b(rm\s+-rf|del\s+\/s|format\s+|shutdown|reg\s+delete|Remove-Item\s+-Recurse|curl\s+.+\|\s*sh)\b/i;

export function isReadonlyTerminalCommand(command: string): boolean {
  if (!command || typeof command !== 'string') return false;
  return READONLY_TERMINAL_RE.test(command.trim());
}

export function isDangerousTerminalCommand(command: string): boolean {
  if (!command || typeof command !== 'string') return false;
  return DANGEROUS_TERMINAL_RE.test(command);
}

function backendOf(ctx: ToolContext): WorkspaceBackend {
  return ctx.backend ?? new LocalFsBackend(ctx.workspaceRoot);
}

function needsWriteConfirm(ctx: ToolContext): boolean {
  return currentPermissionMode(ctx) === 'ask';
}

function needsTerminalConfirm(ctx: ToolContext, command: string): boolean {
  const mode = currentPermissionMode(ctx);
  if (mode === 'allow_all' || mode === 'allow_all_extreme') {
    return false;
  }
  if (mode === 'deny_all') return true;
  if (isDangerousTerminalCommand(command)) return true;
  return !isReadonlyTerminalCommand(command);
}

async function listDir(ctx: ToolContext, relPath = '.'): Promise<ToolResult> {
  const entries = await backendOf(ctx).listDir(relPath);
  const lines = entries
    .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))
    .map((e) => `${e.isDirectory ? 'dir' : 'file'}\t${e.name}`);
  return { content: lines.join('\n') || '(empty)' };
}

async function readFileTool(
  ctx: ToolContext,
  relPath: string,
  offset?: number,
  limit?: number,
): Promise<ToolResult> {
  const text = await backendOf(ctx).readFile(relPath);
  if (offset == null && limit == null) {
    return { content: truncate(text) };
  }
  const lines = text.split(/\r?\n/);
  const start = Math.max((offset ?? 1) - 1, 0);
  const end = limit != null ? start + limit : lines.length;
  const slice = lines.slice(start, end);
  const numbered = slice.map((line, i) => `${start + i + 1}|${line}`).join('\n');
  return { content: truncate(numbered) };
}

async function writeFileTool(
  ctx: ToolContext,
  relPath: string,
  content: string,
): Promise<ToolResult> {
  const backend = backendOf(ctx);
  const originalContent = await readOriginal(backend, relPath);
  const original = originalContent ?? '';

  if (needsWriteConfirm(ctx)) {
    const approved = await ctx.requestConfirm({
      title: `Write file ${relPath}`,
      detail: `Overwrite/create ${relPath} (${content.length} chars)`,
      kind: 'write',
    });
    if (!approved) {
      return { content: 'User rejected write_file', isError: true };
    }
  }

  const pending = ctx.enqueueDiff({
    path: relPath.replace(/\\/g, '/'),
    original,
    modified: content,
    description: 'write_file',
  });

  if (shouldApplyImmediately(ctx)) {
    // 只有真的落盘才记账：未落盘时撤销无事可做，记了反而会让撤销把用户手改的内容回退掉。
    recordMutation(ctx, {
      kind: 'write',
      path: relPath.replace(/\\/g, '/'),
      original: originalContent,
      written: content,
    });
    await backend.writeFile(relPath, content);
    return {
      content: `Wrote ${relPath} (diff id=${pending.id}, applied immediately).`,
      pendingDiff: pending,
    };
  }

  return {
    content: `Prepared write for ${relPath} (diff id=${pending.id}). Waiting for user accept unless auto-applied.`,
    pendingDiff: pending,
  };
}

/** 单次 apply_patch 中的一条替换。 */
export interface PatchEdit {
  old_text: string;
  new_text: string;
  replace_all?: boolean;
}

/** 转义正则元字符，用于把字面量当作全局正则来数出现次数。 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  const matches = haystack.match(new RegExp(escapeRegExp(needle), 'g'));
  return matches ? matches.length : 0;
}

/**
 * 逐条应用替换。
 *
 * 唯一性是硬约束：`String.replace` 默认只换第一处，模型给一个在文件里出现多次的短片段
 * （比如 `return null;`）时会静默改错地方，而且后续模型看到的 diff 看起来「成功」了。
 * 这里宁可拒绝并把它当作可修正的错误返回给模型，让它补上下文或显式声明 replace_all。
 *
 * 替换按顺序作用在**上一次的结果**上，所以同一数组内的编辑不应互相覆盖同一区域。
 */
function applyEdits(
  original: string,
  edits: PatchEdit[],
):
  | { ok: true; modified: string }
  | { ok: false; error: string; index: number } {
  let modified = original;
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    const oldText = edit.old_text;
    const newText = edit.new_text;
    if (typeof oldText !== 'string' || typeof newText !== 'string') {
      return { ok: false, error: `edits[${i}]: old_text and new_text must both be strings`, index: i };
    }
    if (oldText === newText) {
      return { ok: false, error: `edits[${i}]: old_text and new_text are identical`, index: i };
    }
    if (oldText === '') {
      return {
        ok: false,
        error: `edits[${i}]: old_text is empty. Use write_file to create or replace a whole file.`,
        index: i,
      };
    }
    const count = countOccurrences(modified, oldText);
    if (count === 0) {
      return {
        ok: false,
        error:
          `edits[${i}]: old_text not found in the file. Re-read the file and copy the exact text ` +
          `(including indentation and line endings).`,
        index: i,
      };
    }
    if (count > 1 && !edit.replace_all) {
      return {
        ok: false,
        error:
          `edits[${i}]: old_text occurs ${count} times — not unique. Either widen old_text with more ` +
          `surrounding context until it matches once, or set replace_all: true to replace all ${count}.`,
        index: i,
      };
    }
    modified = edit.replace_all
      ? modified.split(oldText).join(newText)
      : modified.replace(oldText, newText);
  }
  return { ok: true, modified };
}

async function applyPatchTool(
  ctx: ToolContext,
  relPath: string,
  edits: PatchEdit[],
): Promise<ToolResult> {
  const backend = backendOf(ctx);
  const original = await backend.readFile(relPath);

  const outcome = applyEdits(original, edits);
  if (!outcome.ok) {
    return { content: `Patch rejected for ${relPath} — ${outcome.error}`, isError: true };
  }
  const modified = outcome.modified;
  if (modified === original) {
    return { content: `No change applied to ${relPath} (patch was a no-op).`, isError: true };
  }

  if (needsWriteConfirm(ctx)) {
    const approved = await ctx.requestConfirm({
      title: `Patch file ${relPath}`,
      detail: `${edits.length} edit(s), ${original.length} → ${modified.length} chars`,
      kind: 'write',
    });
    if (!approved) {
      return { content: 'User rejected apply_patch', isError: true };
    }
  }

  const pending = ctx.enqueueDiff({
    path: relPath.replace(/\\/g, '/'),
    original,
    modified,
    description: 'apply_patch',
  });

  if (shouldApplyImmediately(ctx)) {
    recordMutation(ctx, {
      kind: 'write',
      path: relPath.replace(/\\/g, '/'),
      original,
      written: modified,
    });
    await backend.writeFile(relPath, modified);
    return {
      content: `Patched ${relPath} (${edits.length} edit(s), diff id=${pending.id}, applied immediately).`,
      pendingDiff: pending,
    };
  }

  return {
    content: `Prepared patch for ${relPath} (${edits.length} edit(s), diff id=${pending.id})`,
    pendingDiff: pending,
  };
}

async function globFiles(ctx: ToolContext, pattern: string, maxResults = 200): Promise<ToolResult> {
  const matches = await globFilesByPattern(backendOf(ctx), pattern, maxResults);
  return { content: matches.join('\n') || '(no files)' };
}

function formatSymbolHits(hits: Array<{ name: string; kind: string; path: string; line: number }>): string {
  return hits.map((h) => `${h.kind}\t${h.name}\t${h.path}:${h.line}`).join('\n');
}

async function searchSymbolsTool(
  ctx: ToolContext,
  query?: string,
  opts?: { path?: string; maxResults?: number },
): Promise<ToolResult> {
  const hits = await searchSymbols(backendOf(ctx), query, {
    path: opts?.path,
    maxResults: opts?.maxResults ?? 50,
  });
  return { content: truncate(formatSymbolHits(hits)) || '(no symbols)' };
}

async function codebaseSearchTool(
  ctx: ToolContext,
  query: string,
  limit = 20,
): Promise<ToolResult> {
  if (!ctx.codebaseSearch) {
    return {
      content:
        'codebase_search is unavailable in this workspace (no index provider wired up). ' +
        'Use search_code or search_symbols instead.',
      isError: true,
    };
  }
  const hits = await ctx.codebaseSearch(query, limit);
  if (hits.length === 0) {
    return {
      content:
        'No indexed chunks matched. The index may be empty (run a codebase index first) — ' +
        'fall back to search_code / search_symbols.',
    };
  }
  return { content: truncate(formatCodebaseChunks(hits)) };
}

export function formatCodebaseChunks(hits: CodebaseChunk[]): string {
  return hits
    .map((h) => {
      const docs = h.content.length > 800 ? `${h.content.slice(0, 800)}\n...[truncated]` : h.content;
      return `### ${h.name} (${h.kind}) — ${h.path}:${h.line}\n${docs}`;
    })
    .join('\n\n');
}

const DIAGNOSTIC_SEVERITY_LABEL: Record<DiagnosticEntry['severity'], string> = {
  error: 'ERROR',
  warning: 'WARNING',
  info: 'INFO',
  hint: 'HINT',
};

export function formatDiagnostics(entries: DiagnosticEntry[]): string {
  return entries
    .map(
      (d) =>
        `${DIAGNOSTIC_SEVERITY_LABEL[d.severity]}\t${d.path}:${d.line}${d.column ? `:${d.column}` : ''}\t${d.message}${d.source ? ` [${d.source}]` : ''}`,
    )
    .join('\n');
}

async function getDiagnosticsTool(
  ctx: ToolContext,
  relPath?: string,
  maxResults = 100,
): Promise<ToolResult> {
  if (!ctx.getDiagnostics) {
    return {
      content:
        'get_diagnostics is unavailable in this workspace (no diagnostics provider wired up). ' +
        'Verify your change with a build/test command via run_terminal instead.',
      isError: true,
    };
  }
  const entries = await ctx.getDiagnostics(relPath);
  const errors = entries.filter((d) => d.severity === 'error');
  const shown = entries.slice(0, Math.max(1, maxResults));
  const header =
    entries.length === 0
      ? 'No diagnostics reported — the workspace is clean.'
      : `${entries.length} diagnostic(s), ${errors.length} error(s):`;
  const body = shown.length ? `\n${formatDiagnostics(shown)}` : '';
  const more = entries.length > shown.length ? `\n...[${entries.length - shown.length} more]` : '';
  return { content: truncate(`${header}${body}${more}`) };
}

/** 删除是唯一不可撤销的文件操作，确认信息里必须写清楚到底命中了几项。 */
async function deletePathTool(
  ctx: ToolContext,
  relPath: string,
  recursive = false,
): Promise<ToolResult> {
  const backend = backendOf(ctx);
  if (!(await backend.exists(relPath))) {
    return { content: `Cannot delete ${relPath}: path not found.`, isError: true };
  }

  // 后端接口没有 stat：能 listDir 出内容即视为目录。
  let isDirectory = false;
  let entryCount = 0;
  try {
    const entries = await backend.listDir(relPath);
    isDirectory = true;
    entryCount = entries.length;
  } catch {
    isDirectory = false;
  }

  if (isDirectory && entryCount > 0 && !recursive) {
    return {
      content:
        `Refusing to delete directory ${relPath}: it is not empty (${entryCount} entries). ` +
        `Pass recursive: true to delete it with its contents.`,
      isError: true,
    };
  }

  if (needsWriteConfirm(ctx)) {
    const approved = await ctx.requestConfirm({
      title: `Delete ${isDirectory ? 'directory' : 'file'} ${relPath}`,
      detail: isDirectory
        ? `Permanently delete directory ${relPath} and everything inside it.`
        : `Permanently delete file ${relPath}.`,
      kind: 'delete',
    });
    if (!approved) {
      return { content: 'User rejected delete_path', isError: true };
    }
  }

  // 删除前先留底：删掉的字节是唯一无法从磁盘再拿回来的东西，
  // 没有这份快照时 delete_path 就是不可撤销的操作。
  const snapshot = await snapshotPath(backend, relPath);

  await backend.remove(relPath);
  if (snapshot) {
    recordMutation(ctx, {
      kind: 'delete',
      path: relPath.replace(/\\/g, '/'),
      snapshot,
    });
  } else {
    ctx.onFileMutation?.({
      kind: 'unrecordable',
      path: relPath.replace(/\\/g, '/'),
      reason: '内容过大或包含二进制文件，未能完整留底',
    });
  }
  return { content: `Deleted ${isDirectory ? 'directory' : 'file'} ${relPath}.` };
}

async function movePathTool(ctx: ToolContext, from: string, to: string): Promise<ToolResult> {
  const backend = backendOf(ctx);
  if (from === to) {
    return { content: `move_path: "from" and "to" are identical (${from}).`, isError: true };
  }
  // 先确认源存在：rename 在目标父目录不存在时会静默新建，在源不存在时才报错，
  // 提前检查能把「参数写错」与「文件系统真的失败」区分开。
  if (!(await backend.exists(from))) {
    return { content: `move_path: source ${from} does not exist.`, isError: true };
  }

  if (needsWriteConfirm(ctx)) {
    const approved = await ctx.requestConfirm({
      title: `Move ${from} → ${to}`,
      detail: `Rename or move ${from} to ${to}. Existing files at the destination may be overwritten.`,
      kind: 'delete',
    });
    if (!approved) {
      return { content: 'User rejected move_path', isError: true };
    }
  }

  await backend.rename(from, to);
  recordMutation(ctx, {
    kind: 'move',
    from: from.replace(/\\/g, '/'),
    to: to.replace(/\\/g, '/'),
  });
  return { content: `Moved ${from} → ${to}.` };
}

async function runTerminal(
  ctx: ToolContext,
  command: string,
  timeoutMs = 300_000,
): Promise<ToolResult> {
  // 防卡死保护：强制单条终端命令安全超时上限为 5 分钟（300,000ms），允许运行大型构建与全量测试套件
  const safeTimeoutMs = Math.min(Math.max(timeoutMs || 300_000, 5_000), 300_000);

  if (needsTerminalConfirm(ctx, command)) {
    const approved = await ctx.requestConfirm({
      title: isDangerousTerminalCommand(command) ? 'Dangerous command' : 'Run terminal command',
      detail: command,
      kind: 'terminal',
    });
    if (!approved) {
      return {
        content: isDangerousTerminalCommand(command)
          ? 'User rejected dangerous command'
          : 'User rejected terminal command',
        isError: true,
      };
    }
  }

  const result = await backendOf(ctx).runCommand(command, safeTimeoutMs, (chunk) => {
    ctx.onTerminalOutput?.(chunk);
  });
  return {
    content: truncate(
      `exit=${result.code}\n${result.stdout}${result.stderr ? `\nSTDERR:\n${result.stderr}` : ''}`,
    ),
    isError: result.code !== 0,
  };
}

/**
 * 内置工具的名字集合，用于挡住「MCP 服务器覆盖内置工具」。
 *
 * 从 AGENT_TOOL_DEFINITIONS 推导而不是另抄一份：手抄的清单迟早会漏掉新加的工具，
 * 而漏掉的那个恰好就是唯一能被顶替的。
 */
const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set(
  AGENT_TOOL_DEFINITIONS.map((t) => t.function.name),
);

/**
 * 执行一个 MCP 工具。
 *
 * 权限模型刻意与内置工具对齐：只读的直接调用，其余走 `requestConfirm`，
 * 且 `allow_all` / `allow_all_extreme` 下自动放行 —— 用户在权限设置里表达的是
 * 「让 Agent 干活时少打扰我」，而不是「只对本地文件少打扰我」。
 * 若 MCP 工具绕过这套，就会出现「同一个界面里，改文件的确认逻辑和不改文件的确认逻辑不一致」，
 * 用户无从预期。
 */
async function runMcpTool(ctx: ToolContext, name: string, rawArgs: string): Promise<ToolResult> {
  const mcp = ctx.mcp;
  if (!mcp) return { content: `MCP 未接入，无法调用 ${name}`, isError: true };
  const args = parseArgs<Record<string, unknown>>(rawArgs);
  const readonly = mcp.readonlyNames.has(name);

  if (!readonly) {
    const approved = await ctx.requestConfirm({
      title: `调用外部工具 ${name}`,
      // 参数逐字给出来：MCP 工具的作用范围完全取决于它连的是什么系统，
      // 用户只能靠看清参数来判断这次调用安不安全。
      detail: `${formatMcpArgsPreview(args)}`,
      kind: 'delete',
    });
    if (!approved) {
      return { content: `User rejected MCP tool ${name}`, isError: true };
    }
  }

  try {
    return await mcp.call(name, args);
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true };
  }
}

/** 把参数渲染成一行预览，超长截断 —— 确认弹窗里不该出现一屏 JSON。 */
function formatMcpArgsPreview(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return '(无参数)';
  const text = entries
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(', ');
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

export async function executeTool(
  name: string,
  rawArgs: string,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (currentPermissionMode(ctx) === 'deny_all') {
    return {
      content: `Permission mode is deny_all: tool "${name}" was blocked.`,
      isError: true,
    };
  }

  try {
    // MCP 工具在 switch 之前处理：它们的名字由远端服务器决定，与内置工具同名时
    // 内置的必须优先 —— 否则一个 MCP 服务器就能顶替掉 read_file 这类核心工具，
    // 而那正是「装上某个服务器之后 Agent 行为莫名其妙变了」的成因。
    if (ctx.mcp && ctx.mcp.toolNames.has(name) && !BUILTIN_TOOL_NAMES.has(name)) {
      return await runMcpTool(ctx, name, rawArgs);
    }

    switch (name) {
      case 'list_dir': {
        const args = parseArgs<{ path?: string }>(rawArgs);
        return await listDir(ctx, args.path || '.');
      }
      case 'read_file': {
        const args = parseArgs<{ path: string; offset?: number; limit?: number }>(rawArgs);
        if (!args.path || typeof args.path !== 'string') {
          return { content: 'Error: missing required "path" argument for read_file', isError: true };
        }
        return await readFileTool(ctx, args.path, args.offset, args.limit);
      }
      case 'read_file_lines': {
        const args = parseArgs<{ path: string; offset?: number; limit?: number }>(rawArgs);
        if (!args.path || typeof args.path !== 'string') {
          return { content: 'Error: missing required "path" argument for read_file_lines', isError: true };
        }
        const backend = backendOf(ctx);
        const { lines, total, offset, truncated } = await backend.readFileLines(
          args.path,
          args.offset,
          args.limit ?? 200,
        );
        const numbered = lines.map((line, i) => `${offset + i}|${line}`).join('\n');
        return {
          content: truncate(
            `${numbered}${truncated ? `\n...[truncated, ${total} lines total]` : ''}`,
          ),
        };
      }
      case 'write_file': {
        const args = parseArgs<{ path: string; content: string }>(rawArgs);
        if (!args.path || typeof args.path !== 'string') {
          return { content: 'Error: missing required "path" argument for write_file', isError: true };
        }
        if (typeof args.content !== 'string') {
          return { content: 'Error: missing required "content" argument for write_file', isError: true };
        }
        return await writeFileTool(ctx, args.path, args.content);
      }
      case 'apply_patch': {
        const args = parseArgs<{
          path: string;
          old_text?: string;
          new_text?: string;
          edits?: PatchEdit[];
        }>(rawArgs);
        if (!args.path || typeof args.path !== 'string') {
          return { content: 'Error: missing required "path" argument for apply_patch', isError: true };
        }
        // 两种写法都要支持：`edits` 数组是新格式，`old_text`/`new_text` 是历史格式，
        // 模型在长会话里仍可能沿用旧格式（尤其是从调用历史里学到的），直接收紧会打断它。
        const edits: PatchEdit[] = Array.isArray(args.edits)
          ? args.edits
          : typeof args.old_text === 'string' && typeof args.new_text === 'string'
            ? [{ old_text: args.old_text, new_text: args.new_text }]
            : [];
        if (edits.length === 0) {
          return {
            content:
              'Error: apply_patch needs either an "edits" array or an "old_text"/"new_text" pair.',
            isError: true,
          };
        }
        return await applyPatchTool(ctx, args.path, edits);
      }
      case 'search_code': {
        const args = parseArgs<{
          pattern: string;
          glob?: string;
          path?: string;
          case_insensitive?: boolean;
          max_results?: number;
        }>(rawArgs);
        if (!args.pattern || typeof args.pattern !== 'string') {
          return { content: 'Error: missing required "pattern" argument for search_code', isError: true };
        }
        const backend = backendOf(ctx);
        const opts = {
          glob: args.glob,
          path: args.path,
          caseInsensitive: args.case_insensitive,
          maxResults: args.max_results,
        };
        if (backend.kind === 'local') {
          try {
            const hits = await searchWithRg(ctx.workspaceRoot, args.pattern, opts);
            return { content: truncate(formatCodeHits(hits)) };
          } catch {
            // fall through to local backend walk
          }
        } else if (backend.kind === 'ssh') {
          // 远程 SSH 工作区：直接在远端服务器执行原生搜索指令，严禁走逐文件 SFTP 下载
          try {
            const hits = await searchCodeRemote(backend, args.pattern, opts);
            return { content: truncate(formatCodeHits(hits)) };
          } catch (err) {
            return {
              content: `Remote code search error: ${err instanceof Error ? err.message : String(err)}`,
              isError: true,
            };
          }
        }
        const hits = await searchViaBackend(backend, args.pattern, opts);
        return { content: truncate(formatCodeHits(hits)) };
      }
      case 'glob_files': {
        const args = parseArgs<{ pattern: string; max_results?: number }>(rawArgs);
        if (!args.pattern || typeof args.pattern !== 'string') {
          return { content: 'Error: missing required "pattern" argument for glob_files', isError: true };
        }
        return await globFiles(ctx, args.pattern, args.max_results);
      }
      case 'search_symbols': {
        const args = parseArgs<{ query?: string; path?: string; max_results?: number }>(rawArgs);
        return await searchSymbolsTool(ctx, args.query, {
          path: args.path,
          maxResults: args.max_results,
        });
      }
      case 'codebase_search': {
        const args = parseArgs<{ query: string; limit?: number }>(rawArgs);
        if (!args.query || typeof args.query !== 'string') {
          return {
            content: 'Error: missing required "query" argument for codebase_search',
            isError: true,
          };
        }
        return await codebaseSearchTool(ctx, args.query, args.limit ?? 20);
      }
      case 'get_diagnostics': {
        const args = parseArgs<{ path?: string; max_results?: number }>(rawArgs);
        return await getDiagnosticsTool(ctx, args.path, args.max_results ?? 100);
      }
      case 'delete_path': {
        const args = parseArgs<{ path: string; recursive?: boolean }>(rawArgs);
        if (!args.path || typeof args.path !== 'string') {
          return { content: 'Error: missing required "path" argument for delete_path', isError: true };
        }
        return await deletePathTool(ctx, args.path, args.recursive === true);
      }
      case 'move_path': {
        const args = parseArgs<{ from: string; to: string }>(rawArgs);
        if (!args.from || typeof args.from !== 'string' || !args.to || typeof args.to !== 'string') {
          return {
            content: 'Error: move_path requires both "from" and "to" string arguments',
            isError: true,
          };
        }
        return await movePathTool(ctx, args.from, args.to);
      }
      case 'run_terminal': {
        const args = parseArgs<{ command: string; timeout_ms?: number }>(rawArgs);
        if (!args.command || typeof args.command !== 'string') {
          return { content: 'Error: missing required "command" argument for run_terminal', isError: true };
        }
        return await runTerminal(ctx, args.command, args.timeout_ms);
      }
      case 'ask_user': {
        const args = parseArgs<{
          title: string;
          detail: string;
          kind?: 'terminal' | 'write' | 'delete' | 'other';
          options?: string[];
          allow_input?: boolean;
        }>(rawArgs);
        if (currentPermissionMode(ctx) === 'allow_all_extreme') {
          return { content: 'User approved / answered yes. (auto-approved by allow_all_extreme)' };
        }
        const kind = args.kind ?? 'other';
        const options = Array.isArray(args.options)
          ? args.options
              .map((o) => String(o).trim())
              .filter(Boolean)
              .slice(0, 8)
          : undefined;
        const result = await ctx.requestConfirm({
          title: args.title,
          detail: args.detail,
          kind,
          options,
          allowInput: args.allow_input ?? kind === 'other',
        });
        if (result === false) {
          return { content: 'User rejected / answered no.', isError: true };
        }
        if (typeof result === 'string' && result.trim()) {
          return { content: `User answered: ${result.trim()}` };
        }
        return { content: 'User approved / answered yes.' };
      }
      default:
        return { content: `Unknown tool: ${name}`, isError: true };
    }
  } catch (err) {
    return {
      content: err instanceof Error ? err.message : String(err),
      isError: true,
    };
  }
}

/** Soft note kept for future optional PTY support. */
export function hasNodePty(): boolean {
  return false;
}

import type { PendingDiff, PermissionMode } from '@deepseek-ide/shared';
import type { WorkspaceBackend } from './backend.js';
import { LocalFsBackend } from './backend.js';
import {
  formatCodeHits,
  globFilesByPattern,
  searchCodeRemote,
  searchViaBackend,
  searchWithRg,
} from './search.js';

export { AGENT_TOOL_DEFINITIONS, toolsForMode, READONLY_TOOL_NAMES } from './definitions.js';
export { resolveInWorkspace, PathJailError, toPosixRel } from './pathJail.js';
export type { WorkspaceBackend, DirEntry, CommandResult } from './backend.js';
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
  runLocalCommand,
  getAugmentedEnv,
} from './search.js';
export type { CodeSearchHit, FileSearchHit, SearchOpts } from './search.js';

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
  let original = '';
  try {
    original = await backend.readFile(relPath);
  } catch {
    original = '';
  }

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

async function applyPatchTool(
  ctx: ToolContext,
  relPath: string,
  oldText: string,
  newText: string,
): Promise<ToolResult> {
  const backend = backendOf(ctx);
  const original = await backend.readFile(relPath);
  if (!original.includes(oldText)) {
    return { content: `old_text not found in ${relPath}`, isError: true };
  }
  const modified = original.replace(oldText, newText);

  if (needsWriteConfirm(ctx)) {
    const approved = await ctx.requestConfirm({
      title: `Patch file ${relPath}`,
      detail: `Replace ${oldText.length} chars with ${newText.length} chars`,
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
    await backend.writeFile(relPath, modified);
    return {
      content: `Patched ${relPath} (diff id=${pending.id}, applied immediately).`,
      pendingDiff: pending,
    };
  }

  return {
    content: `Prepared patch for ${relPath} (diff id=${pending.id})`,
    pendingDiff: pending,
  };
}

async function globFiles(ctx: ToolContext, pattern: string, maxResults = 200): Promise<ToolResult> {
  const matches = await globFilesByPattern(backendOf(ctx), pattern, maxResults);
  return { content: matches.join('\n') || '(no files)' };
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
        const args = parseArgs<{ path: string; old_text: string; new_text: string }>(rawArgs);
        if (!args.path || typeof args.path !== 'string') {
          return { content: 'Error: missing required "path" argument for apply_patch', isError: true };
        }
        if (typeof args.old_text !== 'string' || typeof args.new_text !== 'string') {
          return {
            content: 'Error: missing "old_text" or "new_text" argument for apply_patch',
            isError: true,
          };
        }
        return await applyPatchTool(ctx, args.path, args.old_text, args.new_text);
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

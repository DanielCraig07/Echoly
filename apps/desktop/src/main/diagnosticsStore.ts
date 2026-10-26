import type { LspDiagnostic, WorkspaceDiagnostic } from '@deepseek-ide/shared';

/**
 * 工作区诊断缓存。
 *
 * 诊断有两个来源，缺一不可：
 * - **渲染层**：Monaco 自带 TS/JS 语言服务，只有渲染进程里才有这些 marker；
 * - **主进程 LSP**：clangd / pyright / gopls 通过 `lsp:diagnostics` 推送，只到得了主进程。
 *
 * 而 `get_diagnostics` 工具跑在主进程的 Agent 循环里。所以渲染层把 marker 主动上报一次
 * （`reportDiagnostics`），主进程 LSP 的推送就地缓存，两边合起来才是完整视图。
 *
 * 两个来源各存一份、按文件整体替换，**不合并存储**：一次上报就是该文件 marker 的权威快照，
 * 追加会让已经修好的错误永远留在列表里；分开存则某个来源整体变空时能干净地清掉自己那一份，
 * 不影响另一来源。真正合并只发生在 `list()`。
 */
export type DiagnosticsEntry = WorkspaceDiagnostic;

const SEVERITY_BY_LSP_CODE: Record<number, DiagnosticsEntry['severity']> = {
  1: 'error',
  2: 'warning',
  3: 'info',
  4: 'hint',
};

const SEVERITY_RANK: Record<DiagnosticsEntry['severity'], number> = {
  error: 0,
  warning: 1,
  info: 2,
  hint: 3,
};

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '');
}

/** 允许用相对路径、绝对路径或仅文件名匹配到缓存条目。 */
function pathMatches(cachedPath: string, want: string): boolean {
  if (cachedPath === want) return true;
  if (cachedPath.endsWith(`/${want}`)) return true;
  if (want.endsWith(`/${cachedPath}`)) return true;
  return false;
}

function groupByPath(entries: DiagnosticsEntry[]): Map<string, DiagnosticsEntry[]> {
  const grouped = new Map<string, DiagnosticsEntry[]>();
  for (const entry of entries) {
    if (!entry?.path) continue;
    const path = normalizePath(entry.path);
    const list = grouped.get(path) ?? [];
    list.push({ ...entry, path });
    grouped.set(path, list);
  }
  return grouped;
}

export class DiagnosticsStore {
  /** 渲染层 Monaco markers（TS/JS 内建语言服务 + LSP 回填的波浪线） */
  private renderer = new Map<string, DiagnosticsEntry[]>();
  /** 主进程 LSP（clangd / pyright / gopls）推送 */
  private lsp = new Map<string, DiagnosticsEntry[]>();

  /** 渲染层上报：整体替换 renderer 这一层，未出现的文件视为已修好。 */
  replaceFromRenderer(entries: DiagnosticsEntry[]): void {
    this.renderer = groupByPath(entries);
  }

  /** 主进程 LSP 推送：某个文件的最新快照；空数组表示该文件已无诊断。 */
  replaceFromLsp(path: string, diagnostics: LspDiagnostic[]): void {
    const normalized = normalizePath(path);
    const mapped: DiagnosticsEntry[] = (diagnostics ?? []).map((d) => ({
      path: normalized,
      line: (d.range?.start?.line ?? 0) + 1,
      column: (d.range?.start?.character ?? 0) + 1,
      severity: SEVERITY_BY_LSP_CODE[d.severity ?? 1] ?? 'error',
      message: d.message,
      source: d.source || 'lsp',
    }));
    if (mapped.length === 0) this.lsp.delete(normalized);
    else this.lsp.set(normalized, mapped);
  }

  /** 工作区切换后调用，避免旧项目的报错串到新项目里。 */
  clear(): void {
    this.renderer.clear();
    this.lsp.clear();
  }

  list(relPath?: string, maxResults = 200): DiagnosticsEntry[] {
    const want = relPath ? normalizePath(relPath) : null;
    const out: DiagnosticsEntry[] = [];
    for (const source of [this.renderer, this.lsp]) {
      for (const [path, entries] of source) {
        if (want && !pathMatches(path, want)) continue;
        out.push(...entries);
      }
    }
    // 错误优先，其次文件路径，最后行号 —— 模型最该先看到的就是 error
    out.sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        a.path.localeCompare(b.path) ||
        a.line - b.line,
    );
    return maxResults > 0 ? out.slice(0, maxResults) : out;
  }
}

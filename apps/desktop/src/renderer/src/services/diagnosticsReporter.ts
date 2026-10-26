import * as monaco from 'monaco-editor';
import { normalizePath } from './symbolNavigation';

/**
 * 把 Monaco 的 markers 上报给主进程，供 Agent 的 `get_diagnostics` 工具读取。
 *
 * 为什么需要这一层：TS/JS 的语言服务内建在渲染进程的 Monaco 里，marker 只存在于这边；
 * 主进程的 LSP（clangd / pyright / gopls）只覆盖另一部分语言。Agent 工具在主进程运行，
 * 缺了这份上报，「编辑后自检」在 TS/JS 项目里就会永远看到「没有问题」。
 *
 * 上报策略：
 * - 全量快照，不是增量 —— 主进程按文件整体替换，已修好的错误才能消失。
 * - 去抖 500ms：`onDidChangeMarkers` 在批量编辑/索引时会成串触发，逐次 IPC 没有意义。
 * - 只上报 Error / Warning：Info/Hint 的噪声会把模型的注意力从真正的问题上引开，
 *   而「自检」要的恰恰是错误。
 */
const SEVERITY_MAP: Record<number, 'error' | 'warning' | 'info' | 'hint'> = {
  [monaco.MarkerSeverity.Error]: 'error',
  [monaco.MarkerSeverity.Warning]: 'warning',
  [monaco.MarkerSeverity.Info]: 'info',
  [monaco.MarkerSeverity.Hint]: 'hint',
};

const DEBOUNCE_MS = 500;

export function setupDiagnosticsReporting(opts: {
  getWorkspaceRoot: () => string | null | undefined;
}): { dispose: () => void } {
  if (!window.ide?.reportDiagnostics) {
    return { dispose: () => {} };
  }
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    const root = opts.getWorkspaceRoot() ?? null;
    // 没有工作区时也上报一次空快照，清掉上一个项目的残留
    const all = monaco.editor.getModelMarkers({});
    const entries = all
      .filter(
        (m) =>
          m.severity === monaco.MarkerSeverity.Error ||
          m.severity === monaco.MarkerSeverity.Warning,
      )
      .map((m) => {
        const raw = m.resource.fsPath || m.resource.path || '';
        return {
          path: normalizePath(raw, root),
          line: m.startLineNumber,
          column: m.startColumn,
          severity: SEVERITY_MAP[m.severity] ?? 'error',
          message: m.message,
          source: m.source,
        };
      });
    void window.ide.reportDiagnostics?.(entries);
  };

  // 首次挂载立刻跑一次：工作区可能是在本期之前就已经打开的
  flush();

  const sub = monaco.editor.onDidChangeMarkers(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, DEBOUNCE_MS);
  });

  return {
    dispose() {
      if (timer) clearTimeout(timer);
      sub.dispose();
    },
  };
}

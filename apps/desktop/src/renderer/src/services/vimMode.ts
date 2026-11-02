/**
 * Vim 键位（`monaco-vim`）。
 *
 * 为什么用 `monaco-vim` 而不是自己写：vim 的键位是一套有状态的小语言
 * （操作符 + 动作 + 计数 + 寄存器 + `:` 命令行），自己实现「常用操作」的边界
 * 会一路漂移 —— 用户按下 `daw` 没反应时，他并不知道这是「没实现」还是「坏了」。
 * 现成实现虽然老，但行为是确定的。
 *
 * 两处必须自己处理：
 * 1. **状态栏节点**。没有它，用户看不出当前在 normal 还是 insert，
 *    而这正是 vim 里最容易出错的地方（以为在 insert 结果在 normal）。
 * 2. **失败要能退回**。第三方实现遇到不兼容的 Monaco 版本会抛错，
 *    此时必须回到普通键位，而不是让编辑器完全没反应。
 */

import type * as Monaco from 'monaco-editor';
import { initVimMode } from 'monaco-vim';

export interface VimModeHandle {
  dispose(): void;
}

/**
 * 把 vim 键位挂到编辑器上。
 *
 * 返回 `null` 表示没挂上（初始化失败）—— 调用方据此维持普通键位，
 * 而不是当成「已启用 vim」继续往下走。
 */
export function attachVimMode(
  editor: Monaco.editor.IStandaloneCodeEditor,
  host: HTMLElement,
): VimModeHandle | null {
  const statusNode = document.createElement('div');
  // 内联样式而不是外部类：这块 DOM 由 monaco-vim 内部替换内容，
  // 走类名的话一旦样式表没加载到（打包裁剪、主题切换），状态栏就变成一条看不见的空白。
  statusNode.style.cssText = [
    'position:absolute',
    'right:10px',
    'bottom:6px',
    'z-index:6',
    'padding:1px 8px',
    'border-radius:4px',
    'background:var(--bg-elevated, #1e1e1e)',
    'border:1px solid var(--border, rgba(255,255,255,0.1))',
    'color:var(--text, #ccc)',
    'font-family:var(--font-mono)',
    'font-size:11px',
    'letter-spacing:0.06em',
    'pointer-events:none',
    'opacity:0.9',
  ].join(';');
  host.appendChild(statusNode);

  try {
    const instance = initVimMode(editor, statusNode);
    return {
      dispose: () => {
        try {
          instance.dispose();
        } catch {
          // 卸载失败不该影响编辑器本身继续工作
        }
        statusNode.remove();
      },
    };
  } catch (err) {
    // 版本不兼容时退回普通键位：让编辑器完全没反应，比没有 vim 糟得多
    console.warn('[VimMode] 初始化失败，已退回普通键位：', err);
    statusNode.remove();
    return null;
  }
}

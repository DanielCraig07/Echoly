/**
 * 「这个文件该不该交给扩展的自定义编辑器」—— 渲染层的那一问。
 *
 * 单独抽出来是因为有**两个**入口要问同一件事，而它们的答案必须一致：
 * - 用户点文件树 / 聊天里的链接打开一个文件（`App.openFile`）；
 * - 应用重开时恢复上次打开的文件（`App.restoreOpenFilesForRoot`）。
 *
 * 第二个以前漏了，表现很隐蔽：你把一个 `.md` 开着、重启应用，它是被「恢复」出来的
 * 而不是被「打开」的，于是走的还是内置编辑器 —— 用户看到的就是「Office Viewer 没生效」。
 */

import { customEditorTabPath } from '../components/ExtensionEditorView';

export interface CustomEditorClaim {
  /** 虚拟标签路径（`ext://editor/<编码后的绝对路径>`）。 */
  tabPath: string;
  /** 标签标题：扩展给的编辑器名字，没有就用文件名。 */
  title: string;
}

/** 工作区内的相对路径 → 绝对路径。已经是绝对路径的原样返回。 */
export function absolutePathOf(path: string, workspace: string | null | undefined): string {
  if (path.startsWith('/')) return path;
  return workspace ? `${workspace.replace(/\/+$/, '')}/${path}` : path;
}

/**
 * 问主进程「这个文件归谁」。
 *
 * 拿不到答案一律返回 null（交回内置编辑器），不抛：这条路是「打开文件」的前置检查，
 * 它失败不该让文件打不开。方法不存在时也返回 null —— 老版本 preload 上没有它。
 */
export async function resolveCustomEditorClaim(
  absolutePath: string,
  fallbackTitle: string,
): Promise<CustomEditorClaim | null> {
  if (!window.ide.customEditorMatch) return null;
  try {
    const claim = await window.ide.customEditorMatch(absolutePath);
    const matched = claim?.match;
    if (!matched) return null;
    return {
      tabPath: customEditorTabPath(absolutePath),
      title: matched.displayName || fallbackTitle,
    };
  } catch (err) {
    console.error('[customEditorRoute] 询问自定义编辑器失败：', err);
    return null;
  }
}

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
import { showGlobalToast } from './toast';

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
 * 重试节奏（毫秒）。
 *
 * 为什么要重试而不是直接放弃：这个函数在**应用刚起来**的时候就会被调用（会话恢复），
 * 而主进程那边「有没有这个 IPC 处理器」取决于扩展管理器建好没有。踩过一次：
 * 主进程把扩展管理器延迟 2 秒初始化，会话恢复正好落在那 2 秒里，invoke 直接以
 * `No handler registered` 被拒 —— 于是 `.md` 被当成普通文本恢复，之后点它只是切前台，
 * 用户看到的是「装了 Office Viewer 却一直不生效」。
 *
 * 主进程那边已经把处理器提前到构造时注册（那是根治）。这里留一层兜底：
 * 只要 invoke **抛错**（不是「查到了、没人认领」），就再问几次。
 */
const CLAIM_RETRY_DELAYS_MS = [0, 400, 1200, 2500];

/**
 * 已经提示过「这个扩展被禁用了」的扩展 id。
 *
 * 每打开一个 .md 都弹一次同一条提示会很烦；但完全不说又会让用户以为插件坏了 ——
 * 所以整个会话里每个扩展只提醒一次。
 */
const warnedDisabledExtensions = new Set<string>();

function warnDisabledClaimant(extensionId: string | undefined): void {
  if (!extensionId || warnedDisabledExtensions.has(extensionId)) return;
  warnedDisabledExtensions.add(extensionId);
  showGlobalToast(
    `扩展 ${extensionId} 已禁用，这个文件用内置编辑器打开`,
    'warn',
    '想用它的编辑器：在扩展面板里启用它',
  );
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

  for (const delay of CLAIM_RETRY_DELAYS_MS) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      const claim = await window.ide.customEditorMatch(absolutePath);
      const matched = claim?.match;
      // 主进程答出来了（哪怕是「没人认领」）—— 这就是答案，重试没有意义
      if (!matched) {
        warnDisabledClaimant(claim?.disabledClaimant);
        return null;
      }
      return {
        tabPath: customEditorTabPath(absolutePath),
        title: matched.displayName || fallbackTitle,
      };
    } catch (err) {
      console.warn('[customEditorRoute] 询问自定义编辑器失败，稍后重试：', err);
    }
  }
  return null;
}

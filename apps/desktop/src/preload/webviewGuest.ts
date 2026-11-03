/**
 * 扩展 webview 的访客 preload —— 消息桥的「页面那一半」。
 *
 * 为什么必须是一个单独的 preload：扩展界面里的 JS 要跟扩展本体通信，而
 * `<webview>` 里 `nodeIntegration` 是关的、`window.parent` 就是它自己，
 * 页面拿不到任何通往宿主的通道。preload 是唯一能在页面脚本之前跑、又能碰到
 * `ipcRenderer` 的地方，所以桥从这里搭。
 *
 * 两个方向：
 * - 页面 → 扩展：注入的 `acquireVsCodeApi().postMessage` 调这里暴露的 `post`
 *   → `sendToHost` → 渲染进程的 `ipc-message` → 主进程 → 扩展的 onDidReceiveMessage；
 * - 扩展 → 页面：主进程广播 → 渲染进程 `webview.send` → 这里的 `ipcRenderer.on`
 *   → 回调给页面里注入的脚本，由它派发成 message 事件。
 *
 * `contextIsolation` 在宿主里被显式关掉了（webpreferences），但不同 Electron 版本
 * 对 webview 的 webpreferences 处理不一致 —— 两种情形都覆盖，否则桥会「静默失效」：
 * 页面侧拿不到 __echolyWebviewBridge，acquireVsCodeApi 只能打一条 warn。
 */

import { contextBridge, ipcRenderer } from 'electron';

/** 宿主 → 页面的消息通道名。与 extensionManager 里注入的运行时脚本必须一致。 */
const HOST_MESSAGE_CHANNEL = 'echoly-ext-host-message';
/** 页面 → 宿主。 */
const GUEST_MESSAGE_CHANNEL = 'echoly-ext-message';
/**
 * 宿主 → 页面：主题变量。
 *
 * 单独一条通道，**不**混进 HOST_MESSAGE_CHANNEL：那条上的载荷是要转发给扩展页面的
 * `{type:'from-extension',…}`，把主题也塞进去，扩展那边会收到一条它不认识的消息。
 */
const THEME_MESSAGE_CHANNEL = 'echoly-ext-theme';
/** 主题样式元素的 id，注入的那份 HTML 里也是它（用于热更新时原地改）。 */
const THEME_STYLE_ID = 'echoly-ext-theme-runtime';

const bridge = {
  post(message: unknown): void {
    ipcRenderer.sendToHost(GUEST_MESSAGE_CHANNEL, message);
  },
  onMessage(callback: (data: unknown) => void): void {
    ipcRenderer.on(HOST_MESSAGE_CHANNEL, (_event, data) => callback(data));
  },
};

/**
 * 主题热更新：把宿主推来的变量写进一个样式元素。
 *
 * 页面初次加载时用的那张表是主进程在 HTML 里 `<link>` 进来的（见 WEBVIEW_THEME_PATH），
 * 这里只管「已经打开的界面在用户切主题后立刻跟着变」。
 * 只更新同一个元素的 textContent，不重复插新元素 —— 插进去的每个 `<style>` 都要过一遍
 * 扩展自己的 CSP，而且越插越多。
 */
function applyTheme(vars: Record<string, string>): void {
  if (!vars || typeof vars !== 'object') return;
  const body = Object.entries(vars)
    .filter(([name, value]) => name && typeof value === 'string' && value.length > 0)
    .map(([name, value]) => `${name.startsWith('--') ? name : `--vscode-${name}`}:${value};`)
    .join('');
  if (!body) return;

  let style = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = THEME_STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = `:root{${body}}`;
}

ipcRenderer.on(THEME_MESSAGE_CHANNEL, (_event, vars) => applyTheme(vars));

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('__echolyWebviewBridge', bridge);
} else {
  (window as unknown as { __echolyWebviewBridge?: typeof bridge }).__echolyWebviewBridge = bridge;
}

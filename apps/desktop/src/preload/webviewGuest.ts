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

const bridge = {
  post(message: unknown): void {
    ipcRenderer.sendToHost(GUEST_MESSAGE_CHANNEL, message);
  },
  onMessage(callback: (data: unknown) => void): void {
    ipcRenderer.on(HOST_MESSAGE_CHANNEL, (_event, data) => callback(data));
  },
};

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('__echolyWebviewBridge', bridge);
} else {
  (window as unknown as { __echolyWebviewBridge?: typeof bridge }).__echolyWebviewBridge = bridge;
}

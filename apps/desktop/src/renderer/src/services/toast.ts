/**
 * 全局轻提示（toast）的派发入口。
 *
 * 为什么要走事件而不是直接调用：`showToast` 是 `App.tsx` 里的 `useState`，
 * 而需要提示的地方（文件树的重命名失败、聊天面板的撤销结果摘要）在组件树的
 * 很深的位置，中间隔着好几层与提示无关的组件。为了一个错误提示把回调
 * 逐层往下穿，会让每一层都多一个只为转发而存在的 prop。
 *
 * 真正的渲染者仍然是 App.tsx 顶部的 toast 层（它监听 `echoly:toast`），
 * 所以在需要 `showToast` 的地方直接用它、在深层组件里用本模块，两者外观一致。
 */
export type ToastType = 'success' | 'error' | 'info' | 'warn';

export function showGlobalToast(message: string, type: ToastType = 'info', detail?: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent('echoly:toast', {
      detail: { message, type, detail },
    }),
  );
}

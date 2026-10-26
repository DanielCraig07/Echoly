import './styles.css';
import './styles/conflict.css';
import './styles/largeFile.css';
import './styles/fileTreeDnd.css';
import './styles/terminalExt.css';
import './runtimeConfig.css';
import './monaco';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { I18nProvider } from './i18n';
import { ErrorBoundary } from './components/ErrorBoundary';

/**
 * Electron 禁用 `alert` / `prompt` / `confirm`，所以这里仍要提供实现 —— 但**不再假装成功**。
 *
 * 原来的写法是：
 *   prompt(...)  → `defaultValue || ''`
 *   alert(...)   → `console.log`
 *   confirm(...) → `true`
 *
 * 这三行的共同问题是**静默**：`prompt` 把用户没输入的默认值当成他确认过的值返回，
 * `confirm` 把「删不删」一律答成「删」。于是调用方看到的是「一切正常」，
 * 真实的用户意图从来没被采集过 —— 收藏的 SQL 名字悄悄变成默认名、暂存说明凭空生成、
 * 破坏性操作不经同意直接执行，全都不会报错、不会打日志、界面上也看不出异常。
 *
 * 现在渲染层里已经没有调用点了（都换成了应用内弹窗与 toast，见 `services/toast.ts`
 * 与 `hooks/useDbConfirm.tsx`），这几个兜底只剩「万一还有漏网的第三方代码在调」这一种用途。
 * 因此取值改为**最保守的那一种**（prompt 取消、confirm 拒绝），并且**大声报错**：
 * 与其让一次误删悄无声息地发生，不如让它在控制台里留下一条明确的记录。
 */
if (typeof window.prompt === 'undefined' || window.prompt.toString().includes('not supported')) {
  (window as any).prompt = function (message?: string, _defaultValue?: string): string | null {
    console.error(
      '[Renderer] window.prompt 不可用，已按「用户取消」处理。请改用 hooks/useDbConfirm 的应用内弹窗：',
      message,
    );
    return null;
  };
}

if (typeof window.alert === 'undefined') {
  (window as any).alert = function (message?: string): void {
    // 转发到应用内 toast，避免用户完全看不到这条信息（App 尚未挂载时事件无人接收，
    // 所以同时留一条 console 记录）
    console.warn('[Renderer] window.alert 已被应用内提示取代：', message);
    try {
      window.dispatchEvent(
        new CustomEvent('echoly:toast', {
          detail: { message: String(message ?? ''), type: 'info' },
        }),
      );
    } catch {
      /* 忽略：早期启动阶段环境可能还不完整 */
    }
  };
}

if (typeof window.confirm === 'undefined') {
  (window as any).confirm = function (message?: string): boolean {
    console.error(
      '[Renderer] window.confirm 不可用，已按「取消」处理（不会执行破坏性操作）。请改用 useDbConfirm：',
      message,
    );
    return false;
  };
}

createRoot(document.getElementById('root')!).render(
  // Provider 在外、边界在内：错误页的文案要走字典（「应用遇到渲染错误」在英文环境下
  // 必须是英文）。反过来放的话，边界处在 Provider 之外，只能退化成本地 state 兜底，
  // 切了语言也不会跟着变。
  <I18nProvider>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </I18nProvider>,
);

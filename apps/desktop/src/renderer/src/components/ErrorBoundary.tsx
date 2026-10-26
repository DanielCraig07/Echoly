import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useI18n, type Translate } from '../i18n';

interface Props {
  children: ReactNode;
  /**
   * 出错时显示的标题。面板级边界应当给出**面板名**（「文件树」「Git」），
   * 这样用户知道是哪一块坏掉了、其余部分还能用；根边界不传，走通用文案。
   */
  title?: string;
  /** 修复动作的按钮文案；不传则不渲染按钮 */
  actionLabel?: string;
  /** 修复动作；默认重载整个页面 */
  onAction?: () => void;
}

interface State {
  error: Error | null;
}

/** 内部实现，`t` 由包装层注入 —— 类组件用不了 hook。 */
class ErrorBoundaryInner extends Component<Props & { t: Translate }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unhandled UI Error:', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;

    const { t, title, actionLabel, onAction } = this.props;
    const err = this.state.error;
    return (
      <div
        className="empty-state"
        style={{ padding: 24, height: '100%', width: '100%', justifyContent: 'center', gap: 12 }}
      >
        <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>
          {title ?? t('errorBoundary.title')}
        </h2>
        <p style={{ fontSize: 12, opacity: 0.7, margin: 0, maxWidth: 520, textAlign: 'center' }}>
          {t('errorBoundary.hint')}
        </p>
        <pre
          style={{
            background: 'rgba(255,255,255,0.05)',
            padding: 12,
            borderRadius: 8,
            fontSize: 11,
            textAlign: 'left',
            overflow: 'auto',
            maxWidth: 600,
            maxHeight: 220,
            margin: 0,
            whiteSpace: 'pre-wrap',
          }}
        >
          {err?.stack || String(err)}
        </pre>
        <button
          type="button"
          className="panel-action-btn"
          onClick={() => (onAction ? onAction() : window.location.reload())}
        >
          {actionLabel ?? t('errorBoundary.reload')}
        </button>
      </div>
    );
  }
}

/**
 * 错误边界。
 *
 * 为什么要拆成两层：类组件读不到 hook，而错误文案必须跟着语言走 —— 前一版把
 * 「应用遇到渲染错误」「刷新页面」两句话写死在 JSX 里，切到 English 也还是中文。
 * 包装层只负责取 t 再往下传，判定与兜底逻辑仍留在类里。
 *
 * 为什么要有**面板级**用法：根边界一旦触发，整个界面都会被替换成错误页。而渲染错误
 * 通常只发生在一个面板里（某个 diff、某个终端），把整块界面换掉等于用一个小故障
 * 惩罚全部功能。面板各自包一层，坏掉的那块显示错误、其余照常使用。
 */
export function ErrorBoundary(props: Props) {
  const { t } = useI18n();
  return <ErrorBoundaryInner {...props} t={t} />;
}

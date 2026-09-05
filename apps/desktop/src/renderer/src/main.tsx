import './styles.css';
import './monaco';
import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

// Polyfill for Electron renderer process
// Electron 默认禁用 prompt/alert/confirm，提供兼容实现
if (typeof window.prompt === 'undefined' || window.prompt.toString().includes('not supported')) {
  (window as any).prompt = function (message?: string, defaultValue?: string): string | null {
    console.warn('[Renderer] window.prompt() called:', message);
    return defaultValue || '';
  };
}

if (typeof window.alert === 'undefined') {
  (window as any).alert = function (message?: string): void {
    console.log('[Renderer] Alert:', message);
  };
}

if (typeof window.confirm === 'undefined') {
  (window as any).confirm = function (message?: string): boolean {
    console.log('[Renderer] Confirm:', message);
    return true;
  };
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown) {
    console.error('Unhandled UI Error:', error, info);
  }

  render() {
    if (this.state.error) {
      const err = this.state.error as Error;
      return (
        <div
          className="empty-state"
          style={{ padding: 40, height: '100vh', justifyContent: 'center' }}
        >
          <h2>应用遇到渲染错误</h2>
          <pre
            style={{
              background: 'rgba(255,255,255,0.05)',
              padding: 16,
              borderRadius: 8,
              fontSize: 12,
              textAlign: 'left',
              overflow: 'auto',
              maxWidth: 600,
              margin: '16px 0',
            }}
          >
            {err?.stack || String(err)}
          </pre>
          <button className="primary" onClick={() => window.location.reload()}>
            刷新页面
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);

/**
 * 「显式资源管理」（TC39 提案）的兜底实现：
 * `Symbol.dispose` / `Symbol.asyncDispose` / `DisposableStack` / `AsyncDisposableStack`。
 *
 * 为什么需要它：Codex 扩展的**界面**（webview 里的 bundle）每次调 transport 都写
 * `new DisposableStack` —— 而 Electron 35 带的 Chromium 还没有这个全局，报错就是
 * `DisposableStack is not defined`。用户那边看到的是「提交消息时出错」，
 * 并且**凡是走那条 transport 的动作全都点了没反应**（新会话、切换会话、改设置），
 * 因为报错发生在包装层里，界面拿不到任何回执。
 *
 * 扩展宿主这一侧同理：Electron 35 带的是 Node 22，也还没有这几个全局 —— 所以这份
 * 兜底在「主进程」和「webview 运行时」两处都要装（见 extensionManager 里那行
 * `(${installDisposablePolyfills.toString()})()`：同一个函数序列化过去，只有一份实现）。
 *
 * 平台**已经有**的时候直接返回，不覆盖：真实现语义更全，性能也更好。
 *
 * 只依赖 `globalThis` 和 `Symbol` —— 它会被 `.toString()` 之后丢进 webview 里跑，
 * 所以**不能引用模块外的任何东西**（不能 import、不能用编译出来的 helper）。
 */
export function installDisposablePolyfills(): void {
  const g = globalThis as any;

  if (typeof Symbol !== 'undefined') {
    if (typeof Symbol.dispose !== 'symbol') {
      Object.defineProperty(Symbol, 'dispose', {
        value: Symbol('Symbol.dispose'),
        configurable: true,
        writable: true,
      });
    }
    if (typeof Symbol.asyncDispose !== 'symbol') {
      Object.defineProperty(Symbol, 'asyncDispose', {
        value: Symbol('Symbol.asyncDispose'),
        configurable: true,
        writable: true,
      });
    }
  }
  const disposeSym = Symbol.dispose;
  const asyncDisposeSym = Symbol.asyncDispose;

  /** 一次 dispose 出多个错时，官方把它们套成 SuppressedError 链。 */
  if (typeof g.SuppressedError !== 'function') {
    g.SuppressedError = class SuppressedError extends Error {
      constructor(error: any, suppressed: any, message?: string) {
        super(message ?? 'An error was suppressed during disposal.');
        this.name = 'SuppressedError';
        (this as any).error = error;
        (this as any).suppressed = suppressed;
      }
    };
  }

  if (typeof g.DisposableStack !== 'function') {
    g.DisposableStack = class DisposableStack {
      private _stack: (() => void)[] = [];
      private _disposed = false;

      get disposed(): boolean {
        return this._disposed;
      }

      use<T>(value: T): T {
        if (value != null) {
          const dispose = (value as any)[disposeSym];
          if (typeof dispose !== 'function') {
            throw new TypeError('Object is not disposable.');
          }
          this._stack.push(() => dispose.call(value));
        }
        return value;
      }

      adopt<T>(value: T, onDispose: (value: T) => void): T {
        this._stack.push(() => onDispose(value));
        return value;
      }

      defer(onDispose: () => void): void {
        this._stack.push(onDispose);
      }

      move(): any {
        if (this._disposed) throw new ReferenceError('Cannot move a disposed stack.');
        const next: any = new g.DisposableStack();
        next._stack = this._stack;
        this._stack = [];
        return next;
      }

      dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        const errors: any[] = [];
        // 后进先出：和 `using` 的作用域退出顺序一致
        for (let i = this._stack.length - 1; i >= 0; i--) {
          try {
            this._stack[i]();
          } catch (err) {
            errors.push(err);
          }
        }
        this._stack.length = 0;
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) {
          let error: any = errors[0];
          for (let i = 1; i < errors.length; i++) {
            error = new g.SuppressedError(error, errors[i]);
          }
          throw error;
        }
      }

      [disposeSym](): void {
        this.dispose();
      }
    };
  }

  if (typeof g.AsyncDisposableStack !== 'function') {
    g.AsyncDisposableStack = class AsyncDisposableStack {
      private _stack: (() => void | PromiseLike<void>)[] = [];
      private _disposed = false;

      get disposed(): boolean {
        return this._disposed;
      }

      use<T>(value: T): T {
        if (value != null) {
          const dispose = (value as any)[asyncDisposeSym] ?? (value as any)[disposeSym];
          if (typeof dispose !== 'function') {
            throw new TypeError('Object is not async disposable.');
          }
          this._stack.push(() => dispose.call(value));
        }
        return value;
      }

      adopt<T>(value: T, onDispose: (value: T) => void | PromiseLike<void>): T {
        this._stack.push(() => onDispose(value));
        return value;
      }

      defer(onDispose: () => void | PromiseLike<void>): void {
        this._stack.push(onDispose);
      }

      move(): any {
        if (this._disposed) throw new ReferenceError('Cannot move a disposed stack.');
        const next: any = new g.AsyncDisposableStack();
        next._stack = this._stack;
        this._stack = [];
        return next;
      }

      async disposeAsync(): Promise<void> {
        if (this._disposed) return;
        this._disposed = true;
        const errors: any[] = [];
        for (let i = this._stack.length - 1; i >= 0; i--) {
          try {
            await this._stack[i]();
          } catch (err) {
            errors.push(err);
          }
        }
        this._stack.length = 0;
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) {
          let error: any = errors[0];
          for (let i = 1; i < errors.length; i++) {
            error = new g.SuppressedError(error, errors[i]);
          }
          throw error;
        }
      }

      [asyncDisposeSym](): Promise<void> {
        return this.disposeAsync();
      }
    };
  }
}

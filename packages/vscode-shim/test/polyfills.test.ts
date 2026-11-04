import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { installDisposablePolyfills } from '../src/polyfills';

/**
 * 显式资源管理的兜底实现。
 *
 * 两条都要钉住：
 * 1. 语义对不对（defer 后进先出、use 走 Symbol.dispose、dispose 幂等）；
 * 2. **序列化过去还跑不跑** —— webview 里那份是靠
 *    `(${installDisposablePolyfills.toString()})()` 送过去的，这个函数一旦引用了
 *    模块外面的东西（import、编译 helper），webview 那边就是一个 ReferenceError，
 *    而那种错误只在扩展界面上才看得见。
 */
describe('installDisposablePolyfills', () => {
  /** 一个啥都没有的干净上下文：模拟 Electron 35 里既没有 DisposableStack 的运行时。 */
  const freshContext = () => vm.createContext({}) as Record<string, any>;

  it('在什么都没有的上下文里也能装上（序列化后自洽）', () => {
    const context = freshContext();
    const source = `(${installDisposablePolyfills.toString()})();`;
    vm.runInContext(source, context);
    // 一律在上下文**内部**读：从外面读 `context.X` 拿不到 vm 里新定义的全局
    expect(
      vm.runInContext(
        `[typeof DisposableStack, typeof AsyncDisposableStack, typeof Symbol.dispose, typeof Symbol.asyncDispose].join(',')`,
        context,
      ),
    ).toBe('function,function,symbol,symbol');
  });

  it('defer 后进先出，dispose 幂等', () => {
    const context = freshContext();
    vm.runInContext(`(${installDisposablePolyfills.toString()})();`, context);
    const order = vm.runInContext(
      `
      const stack = new DisposableStack();
      const order = [];
      stack.defer(() => order.push('first'));
      stack.defer(() => order.push('second'));
      stack.dispose();
      stack.dispose();
      order.join(',');
      `,
      context,
    );
    expect(order).toBe('second,first');
  });

  it('use 走对象的 Symbol.dispose，且返回原对象', () => {
    const context = freshContext();
    vm.runInContext(`(${installDisposablePolyfills.toString()})();`, context);
    const result = vm.runInContext(
      `
      const stack = new DisposableStack();
      const calls = [];
      const resource = { [Symbol.dispose]() { calls.push('disposed'); } };
      const returned = stack.use(resource);
      stack.dispose();
      (returned === resource) + ':' + calls.join(',');
      `,
      context,
    );
    expect(result).toBe('true:disposed');
  });

  it('不是 disposable 的对象要报 TypeError，而不是静默漏掉', () => {
    const context = freshContext();
    vm.runInContext(`(${installDisposablePolyfills.toString()})();`, context);
    const thrown = vm.runInContext(
      `
      try { new DisposableStack().use({}); 'no-throw'; }
      catch (err) { err.constructor.name; }
      `,
      context,
    );
    expect(thrown).toBe('TypeError');
  });

  it('平台已经有真实现时不动它（不能把好的覆盖成兜底）', () => {
    const context = freshContext();
    // 假装的「平台真实现」：名字认得出来就够
    vm.runInContext('globalThis.DisposableStack = function RealDisposableStack() {};', context);
    vm.runInContext(`(${installDisposablePolyfills.toString()})();`, context);
    expect(vm.runInContext('DisposableStack.name', context)).toBe('RealDisposableStack');
  });

  it('在当前进程里装也是安全的（幂等）', () => {
    expect(() => {
      installDisposablePolyfills();
      installDisposablePolyfills();
    }).not.toThrow();
  });

  it('asyncDispose 的是 AsyncDisposableStack（await using 走这条）', async () => {
    const context = freshContext();
    vm.runInContext(`(${installDisposablePolyfills.toString()})();`, context);
    context.__order = [];
    await vm.runInContext(
      `
      (async () => {
        const stack = new AsyncDisposableStack();
        stack.defer(async () => { globalThis.__order.push('a'); });
        stack.defer(async () => { globalThis.__order.push('b'); });
        await stack.disposeAsync();
      })();
      `,
      context,
    );
    expect(context.__order.join(',')).toBe('b,a');
  });
});

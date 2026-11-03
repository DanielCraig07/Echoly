/**
 * 「这台机器上真的装了哪些扩展」的登记簿。
 *
 * `vscode.extensions.getExtension(id)` 以前对**任何** id 都返回一个假对象
 * （`exports: {}`、路径是工作区根目录）。代价不是「返回了个假货」而是实打实的崩溃：
 * Office Viewer 加载主模块时会问 `getExtension('vscode.git')`，拿到假对象后
 * `t.exports.getAPI(1)` 就是一个 TypeError —— 它由 `activate()` 之外的一条
 * async 链抛出来，没人 await，于是每次加载扩展都留一条 unhandledRejection。
 *
 * 官方的语义很干脆：没装就是 `undefined`，装了的才给对象。扩展那边普遍写成
 * `const git = extensions.getExtension('vscode.git'); if (!git) return …`，
 * 所以**返回 undefined 恰恰是它们期望的分支**，而返回假对象才会把人家带沟里。
 *
 * 登记时机在 `loadExtension` / `loadExtensionFromVsix` 读完 package.json 之后 ——
 * 必须早于主模块的加载（模块顶层就会调用 getExtension），所以不能放在 activate 里。
 */

export interface RegisteredExtension {
  /** 扩展目录（`…/extensions/<dir>/extension`），`extensionUri.extensionPath` 用它。 */
  extensionPath: string;
  /** activate 之后填上，作为 `getExtension(id).exports` 还给扩展。 */
  exports?: unknown;
}

const registry = new Map<string, RegisteredExtension>();

/** 扩展 id 大小写不敏感（官方也是这个规则）。 */
function normalize(id: string): string {
  return id.trim().toLowerCase();
}

export function registerExtension(id: string, extensionPath: string): void {
  if (!id || !id.includes('.')) return;
  registry.set(normalize(id), { extensionPath });
}

export function setExtensionExports(id: string, exports: unknown): void {
  const entry = registry.get(normalize(id));
  if (entry) entry.exports = exports;
}

export function unregisterExtension(id: string): void {
  registry.delete(normalize(id));
}

export function getRegisteredExtension(id: string): RegisteredExtension | undefined {
  return registry.get(normalize(id));
}

export function listRegisteredExtensionIds(): string[] {
  return Array.from(registry.keys());
}

/** 测试用：清空登记簿，避免用例之间互相串。 */
export function resetExtensionRegistry(): void {
  registry.clear();
}

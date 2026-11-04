/**
 * 「改动前的内容」快照 —— 「拒绝」按钮靠它。
 *
 * 为什么需要它：Claude / Codex 这类代理是**自己写盘**的（跑自己的进程，不走我们的
 * 编辑器缓冲区），改动落到磁盘上我们才看得见 —— 那一刻文件已经是新内容了，
 * 「改之前是什么」只能靠**我们最后一次看到它时记下的那一份**。
 *
 * 什么时候记：
 * - 渲染层读一个文件（打开标签，或外部改动之后重新载入）；
 * - 渲染层写一个文件（用户保存）。
 *
 * 于是「用户看过 / 存过的文件」都有快照，而且会**自愈**：一次外部改动之后界面会把
 * 开着的标签重新读一遍，那份新内容就成了下一次改动的「改动前」。
 *
 * 一次改动只认一次（`claim` 取走即删）：宁可诚实地说「这个文件还原不了」，
 * 也不要拿一份更早的内容去覆盖 —— 那会把用户的中间改动一起丢掉。
 */
export class FileChangeSnapshots {
  /** 超过这个长度的内容不记：快照是给「还原」用的，不是备份整个仓库。 */
  private static readonly MAX_CONTENT_BYTES = 2 * 1024 * 1024;

  private readonly cache = new Map<string, string>();

  /** 记下「这个文件现在是什么内容」。 */
  remember(absPath: string, content: string): void {
    if (!absPath) return;
    if (typeof content !== 'string') return;
    if (content.length > FileChangeSnapshots.MAX_CONTENT_BYTES) {
      // 太大：留着只会占内存，而且这种文件本来也不该被代理整份改写
      this.cache.delete(absPath);
      return;
    }
    this.cache.set(absPath, content);
  }

  /**
   * 取走「改动前的内容」。取完就删 —— 同一次改动只认一次。
   *
   * 返回 undefined 表示我们没见过这个文件改动前的样子，也就**还原不了**。
   */
  claim(absPath: string): string | undefined {
    const before = this.cache.get(absPath);
    this.cache.delete(absPath);
    return before;
  }

  forget(absPath: string): void {
    this.cache.delete(absPath);
  }

  clear(): void {
    this.cache.clear();
  }

  /** 只给测试与日志用。 */
  get size(): number {
    return this.cache.size;
  }
}

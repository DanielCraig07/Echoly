/**
 * 「磁盘上的文件被**别人**改了」这件事的纯逻辑部分。
 *
 * 单独放出来是因为这里有两条一旦写反就会静默出事的规则，值得单独钉住：
 *
 * 1. **自己写盘的回声要忽略。** 用户按保存、git 还原，磁盘都会变，磁盘监听分不清
 *    是谁写的 —— 拿「磁盘内容 == 上次保存时的基准」当判据，就能认出「这次变化是我自己
 *    造成的」，否则每保存一次都会弹一条「文件已被改变」。
 * 2. **有未保存的编辑时绝不覆盖。** 拿磁盘内容盖掉用户正在敲的字是不可逆的数据丢失。
 *    这时只能提示，让用户自己决定。
 */

export type DiskChangeDecision =
  /** 什么都不用做：磁盘内容与我们上次保存的基准一致（自己写盘的回声）。 */
  | 'ignore'
  /** 没有未保存的编辑 → 直接换成磁盘上的新内容。 */
  | 'reload'
  /** 有未保存的编辑 → 保留编辑器里的内容，只提示。 */
  | 'conflict'
  /** 读不到了（多半已被删除）→ 只提示。 */
  | 'deleted';

export function decideDiskChange(input: {
  /** 这个标签有没有未保存的编辑。 */
  dirty: boolean;
  /** 上次保存/加载时的基准内容。 */
  savedContent: string | undefined;
  /** 磁盘上的当前内容；`null` 表示读不到。 */
  freshContent: string | null;
}): DiskChangeDecision {
  if (input.freshContent === null) return 'deleted';
  if (input.freshContent === input.savedContent) return 'ignore';
  return input.dirty ? 'conflict' : 'reload';
}

/** 路径的最后一段（渲染层没有 `node:path`）。提示里说「哪几个文件」用得着它。 */
export function baseNameOf(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || filePath;
}

/** 文件名列表缩成一行：最多列三个，多的用「等 N 个」带过（toast 放不下整条路径）。 */
export function summariseFileNames(names: string[]): string {
  const head = names.slice(0, 3).join('、');
  return names.length > 3 ? `${head} 等 ${names.length} 个` : head;
}

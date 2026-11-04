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

/**
 * 一条待处理的「别人改了磁盘」—— 界面上就是一个带「接受 / 拒绝」的卡片。
 *
 * 之所以要**接受 / 拒绝**而不是一条只读提示：代理改盘之后，编辑器里那一份和磁盘上
 * 那一份分叉了，得让用户自己决定跟哪一份。只提示的话用户除了自己再手动还原一遍，
 * 没有任何出路。
 */
export interface PendingExternalChange {
  /** 逻辑路径（可能带多根前缀）：写回、重新读都走它。 */
  path: string;
  /** 归一化的绝对路径：跟编辑器标签比对用。 */
  abs: string;
  /** 卡片上显示的文件名。 */
  name: string;
  /** 改动前的内容；`undefined` 表示我们没记到，**还原不了**。 */
  before?: string;
  /** 磁盘上现在的内容；`null` 表示读不到（多半是被删了）。 */
  fresh: string | null;
  /** 发现这次改动时，标签里有没有未保存的编辑。 */
  dirty: boolean;
  /** 发现这次改动时，文件在编辑器里开着没有。 */
  open: boolean;
}

/** 按下「接受」要做什么。 */
export type AcceptAction =
  /** 把磁盘上的新内容收进编辑器（重新载入）。 */
  | 'reload'
  /** 收下「文件被删了」这件事（关掉标签）。 */
  | 'close'
  /** 只是收起提示：文件没开着，没有可同步的编辑器内容。 */
  | 'dismiss';

export interface ExternalChangeActions {
  accept: AcceptAction;
  /** 「拒绝」能不能点 —— 能点就得有「改动前」的内容去还原。 */
  canReject: boolean;
  /** 接受会丢掉用户未保存的编辑：界面上必须把这点说出来，不能默默丢。 */
  acceptLosesEdits: boolean;
}

export function planExternalChangeActions(change: PendingExternalChange): ExternalChangeActions {
  // 没记到「改动前」就还原不了 —— 与其拿一份更早的内容去覆盖（会连带丢掉中间改动），
  // 不如诚实地说「这个还原不了」。
  const canReject = change.before !== undefined;
  const accept: AcceptAction = !change.open
    ? 'dismiss'
    : change.fresh === null
      ? 'close'
      : 'reload';
  return { accept, canReject, acceptLosesEdits: change.dirty && change.open };
}

/**
 * 同一条路径又变了一次：把新的磁盘内容并进去，但**改动前的内容保持最早那一份**。
 *
 * 保持最早是有意的：用户点「拒绝」想要的是「回到代理动手之前」，不是「回到上一次
 * 磁盘变动之前」。反过来，只要中途被接受过一次（`before` 随之清掉），这里就会以新
 * 的一份为准 —— 那种时候「代理动手之前」已经在被接受时前移了。
 */
export function mergePendingChange(
  existing: PendingExternalChange,
  incoming: PendingExternalChange,
): PendingExternalChange {
  return {
    ...incoming,
    before: existing.before ?? incoming.before,
    open: existing.open || incoming.open,
    dirty: incoming.dirty,
  };
}

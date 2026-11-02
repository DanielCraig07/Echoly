/**
 * 最近的编辑记录，喂给补全当上下文。
 *
 * 只有光标前后各一段代码时，模型看到的是一个**静态切片**：它知道我正在哪一行，
 * 但不知道我刚刚在改什么。典型的坏case是「我刚把 `userId` 改名成 `accountId`，
 * 现在补全下一行」—— 只看切片，模型很可能又写回 `userId`。
 * 把最近三次编辑带上，这类「跟着我改」的意图才有依据。
 *
 * 两个实现上的约束：
 * 1. **删除的文本得自己保存。** Monaco 的内容变更事件只给「变更范围 + 新文本」，
 *    被删掉的原文本不在事件里，而它恰恰是 diff 里信息量的一半。所以对每个模型留一份
 *    文本快照，用变更范围的偏移量从快照里取回被删内容。
 * 2. **快照有体积上限。** 快照等于把文件内容再存一份，几百 KB 的生成物文件不值得为
 *    上下文付这份内存；超过上限的文件直接不记录（补全照样工作，只是少一层上下文）。
 */

export interface RecentEdit {
  /** 用户删掉的内容（纯输入时为 ''） */
  deleted: string;
  /** 用户插入的内容（纯删除时为 ''） */
  inserted: string;
}

/** 保留最近几次编辑。3 次是「够看出在做什么」与「不淹没当前代码」之间的折中。 */
export const MAX_RECENT_EDITS = 3;

/** 单侧文本的记录上限，防止一次粘贴把上下文撑爆。 */
const MAX_SIDE_CHARS = 400;

/** 超过这个体积的文件不做快照，也就不记录编辑。 */
const MAX_SNAPSHOT_CHARS = 100_000;

/** 只依赖用到的四个能力，好让这一层脱离 Monaco 被测试覆盖。 */
export interface EditableModel {
  uri: { toString(): string };
  getValue(): string;
  onDidChangeContent(
    listener: (event: {
      changes: readonly { rangeOffset: number; rangeLength: number; text: string }[];
    }) => void,
  ): { dispose(): void };
}

interface ModelState {
  edits: RecentEdit[];
  /** 上一次变更后的全文，用于取回被删除的文本；超上限时为 null（不记录） */
  snapshot: string | null;
}

const states = new Map<string, ModelState>();

function stateOf(uri: string): ModelState {
  let state = states.get(uri);
  if (!state) {
    state = { edits: [], snapshot: null };
    states.set(uri, state);
  }
  return state;
}

function clampSide(text: string): string {
  return text.length > MAX_SIDE_CHARS ? text.slice(0, MAX_SIDE_CHARS) : text;
}

/** 按模型 uri 记录一次编辑（供测试与手动记录使用）。 */
export function recordEdit(uri: string, edit: RecentEdit): void {
  if (!edit.inserted && !edit.deleted) return;
  const state = stateOf(uri);
  state.edits.push({ inserted: clampSide(edit.inserted), deleted: clampSide(edit.deleted) });
  if (state.edits.length > MAX_RECENT_EDITS) {
    state.edits.splice(0, state.edits.length - MAX_RECENT_EDITS);
  }
}

/** 最近的编辑，从旧到新。文件切换后各自独立，互不串味。 */
export function getRecentEdits(uri: string): RecentEdit[] {
  return states.get(uri)?.edits.slice() ?? [];
}

export function clearRecentEdits(uri?: string): void {
  if (uri === undefined) {
    states.clear();
    return;
  }
  states.delete(uri);
}

/**
 * 把记录挂到一个模型上。
 *
 * 首次调用时给当前内容建快照；之后每次变更先用偏移量从快照里取回被删文本，
 * 再用新内容刷新快照。偏移量来自事件本身，且是相对**变更前**的文档计算的，
 * 正好与快照对齐 —— 所以一次事件里多个 change 也能逐个正确取回。
 */
export function attachRecentEditRecorder(model: EditableModel): { dispose(): void } {
  const uri = model.uri.toString();
  const state = stateOf(uri);

  const initial = model.getValue();
  state.snapshot = initial.length <= MAX_SNAPSHOT_CHARS ? initial : null;

  const subscription = model.onDidChangeContent((event) => {
    const previous = state.snapshot;
    for (const change of event.changes) {
      // 没有快照（文件太大）时只能记到插入的那一半，删除的那半无从取回。
      // 这是有意的取舍：宁可少一半上下文，也不为一个大文件常年留一份内存副本。
      const deleted =
        previous === null ? '' : previous.substr(change.rangeOffset, change.rangeLength);
      recordEdit(uri, { inserted: change.text, deleted });
    }
    if (previous !== null) {
      const next = model.getValue();
      state.snapshot = next.length <= MAX_SNAPSHOT_CHARS ? next : null;
    }
  });

  return {
    dispose: () => {
      subscription.dispose();
    },
  };
}

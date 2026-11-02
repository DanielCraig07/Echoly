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

/** 带来源文件的编辑记录。`path` 只有在**来源不是当前文件**时才有值。 */
export interface ContextualEdit extends RecentEdit {
  path?: string;
}

/** 保留最近几次编辑。3 次是「够看出在做什么」与「不淹没当前代码」之间的折中。 */
export const MAX_RECENT_EDITS = 3;

/** 全局日志的保留条数。它只用来支撑「跨文件」这一层上下文，不需要留很长。 */
export const MAX_GLOBAL_ENTRIES = 12;

/**
 * 跨文件上下文里最多带几个**别的**文件。
 *
 * 取 2：一次重构通常也就是「改了定义、现在改用法」这种一两跳的跨度。带得越多，
 * 提示词里越可能塞进一堆与当前这行无关的改动，反而稀释掉真正有用的那条。
 */
export const MAX_CROSS_FILE = 2;

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

/**
 * 全局按时间排列的编辑日志。
 *
 * 为什么单靠 `states` 不够：`states` 是**按文件分桶**的，桶与桶之间没有先后关系，
 * 于是「跨文件」这层上下文无从拼出来 —— 而它恰恰对应一个很常见的动作：
 * 在 A 文件里把接口改了名，回到 B 文件继续改用法。只看 B 文件自己的编辑记录，
 * 模型并不知道 A 文件刚发生了什么。
 */
const globalLog: { uri: string; edit: RecentEdit }[] = [];

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
  const clamped = { inserted: clampSide(edit.inserted), deleted: clampSide(edit.deleted) };
  const state = stateOf(uri);
  state.edits.push(clamped);
  if (state.edits.length > MAX_RECENT_EDITS) {
    state.edits.splice(0, state.edits.length - MAX_RECENT_EDITS);
  }
  globalLog.push({ uri, edit: clamped });
  if (globalLog.length > MAX_GLOBAL_ENTRIES) {
    globalLog.splice(0, globalLog.length - MAX_GLOBAL_ENTRIES);
  }
}

/** 最近的编辑，从旧到新。文件切换后各自独立，互不串味。 */
export function getRecentEdits(uri: string): RecentEdit[] {
  return states.get(uri)?.edits.slice() ?? [];
}

export function clearRecentEdits(uri?: string): void {
  if (uri === undefined) {
    states.clear();
    globalLog.length = 0;
    return;
  }
  states.delete(uri);
  for (let i = globalLog.length - 1; i >= 0; i -= 1) {
    if (globalLog[i].uri === uri) globalLog.splice(i, 1);
  }
}

/** 从 uri 里取一个给人看的短名（`file:///a/b/foo.ts` → `foo.ts`）。 */
export function fileLabel(uri: string): string {
  const withoutQuery = uri.split('?')[0].split('#')[0];
  const tail = withoutQuery.split(/[\\/]/).filter(Boolean).pop();
  return tail ? decodeURIComponent(tail) : withoutQuery;
}

/**
 * 组装喂给模型的最近编辑：当前文件的编辑 + 最近改过的**别的**文件的编辑。
 *
 * 两条规矩：
 * 1. **按时间输出（旧→新）。** 拼接顺序必须忠于真实发生的顺序，否则模型会把
 *    「先改的定义、后改的用法」读反。
 * 2. **只带来源文件，不带来源行号。** 行号在跨文件之后毫无意义（另一个文件的行号
 *    对当前这行没有任何指导作用），带上反而会诱导模型去引用一个不存在的位置。
 */
export function collectRecentEditsForContext(
  uri: string,
  opts: { maxCrossFiles?: number } = {},
): ContextualEdit[] {
  const maxCrossFiles = opts.maxCrossFiles ?? MAX_CROSS_FILE;
  // 从新往旧走，先圈定「哪些别的文件算最近」
  const crossUris: string[] = [];
  for (let i = globalLog.length - 1; i >= 0; i -= 1) {
    const { uri: source } = globalLog[i];
    if (source === uri || crossUris.includes(source)) continue;
    if (crossUris.length >= maxCrossFiles) break;
    crossUris.push(source);
  }

  const kept = globalLog.filter((entry) => entry.uri === uri || crossUris.includes(entry.uri));
  // 当前文件仍受 MAX_RECENT_EDITS 限制：全局日志比它长，不截断会把当前文件的窗口撑大
  const forOwnFile = kept.filter((entry) => entry.uri === uri).slice(-MAX_RECENT_EDITS);
  const cross = kept.filter((entry) => entry.uri !== uri);

  return [...forOwnFile, ...cross]
    .sort((a, b) => globalLog.indexOf(a) - globalLog.indexOf(b))
    .map((entry) =>
      entry.uri === uri ? { ...entry.edit } : { ...entry.edit, path: fileLabel(entry.uri) },
    );
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

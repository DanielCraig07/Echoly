/**
 * 「下一步编辑预测」的界面侧。
 *
 * 与行内补全的关键差别：补全的建议在**光标处**，用户自然会看见；
 * 而这里的建议在**别处**，如果只是默默算出来，没人会知道它存在。
 * 所以这一层的一半工作是「把它显示清楚、并且只显示该显示的时候」。
 *
 * 三条自我约束：
 * 1. **不抢补全的位置。** 幽灵补全可见时不发起预测 —— 两个 AI 界面同时抢注意力，
 *    结果一定是用户两个都不看。
 * 2. **改动一律可撤销。** 接受时走 `pushEditOperations`，进撤销栈；
 *    用户按 Cmd+Z 能一步退回去，不需要理解这行改动是哪来的。
 * 3. **只在空闲之后问一次。** 连续敲键期间不做预测请求，否则每次击键都会触发一轮。
 */

import type * as Monaco from 'monaco-editor';
import { isNextEditPredictionEnabled, subscribeAiCompletionEnabled } from './completionEnabled';
import { collectRecentEditsForContext } from './recentEdits';

/** 停手多久才认为「改完了」，可以预测下一步。比补全的 350ms 长得多：预测的是段落级意图。 */
const IDLE_MS = 1200;

/** 上下文取光标上下各多少行。太多会把提示词撑长，太少则看不到相关代码。 */
export const CONTEXT_RADIUS = 80;

/** 接受一次预测后的静默期：避免「接受 → 立刻又弹出下一处」这种追着人跑的手感。 */
const ACCEPT_COOLDOWN_MS = 3000;

const HINT_MAX_CHARS = 60;

export interface PredictedCodeEdit {
  /** 文件内起始行号（1 起） */
  startLine: number;
  /** 文件内结束行号（1 起，含） */
  endLine: number;
  newText: string;
}

export interface NumberedContext {
  /** 每行形如 `12| const a = 1;` */
  context: string;
  firstLine: number;
  lastLine: number;
}

/** 只依赖用到的两个方法，好让上下文构造脱离 Monaco 被测试。 */
export interface LinesSource {
  getLineCount(): number;
  getLineContent(lineNumber: number): string;
}

/**
 * 构造带行号的上下文。
 *
 * 行号必须写进去：答案要用行号定位，而让模型自己数行号是不现实的。
 */
export function buildNumberedContext(
  source: LinesSource,
  aroundLine: number,
  radius: number = CONTEXT_RADIUS,
): NumberedContext {
  const total = source.getLineCount();
  const firstLine = Math.max(1, aroundLine - radius);
  const lastLine = Math.min(total, aroundLine + radius);
  const lines: string[] = [];
  for (let line = firstLine; line <= lastLine; line += 1) {
    lines.push(`${line}| ${source.getLineContent(line)}`);
  }
  return { context: lines.join('\n'), firstLine, lastLine };
}

/**
 * 建议的提示文案：单行、短，因为它会被内联注入到代码行尾。
 *
 * 文案里点明「Tab」：这个建议显示在别处、光标不在这儿，如果不说出该按什么键，
 * 用户看到的就是一行莫名其妙的高亮 —— 那这个功能等于不存在。
 */
export function formatProposalHint(edit: PredictedCodeEdit): string {
  const headline = edit.newText.replace(/\s+/g, ' ').trim();
  const shown =
    headline.length > HINT_MAX_CHARS ? `${headline.slice(0, HINT_MAX_CHARS)}…` : headline;
  return `  ⏎ Tab 跳转 · 下一步编辑：${shown}`;
}

export interface NextEditPredictionDeps {
  editor: Monaco.editor.IStandaloneCodeEditor;
  monaco: typeof Monaco;
  /**
   * 额外的上下文键名（例如 `echolyVimMode`）。给了就把 Esc 的生效条件收窄成
   * 「建议可见且不在 vim 模式」—— 在 vim 里 Esc 是回 normal 模式，
   * 被我们抢掉的话用户会以为 vim 坏了。
   */
  vimContextKey?: string;
  request: (payload: {
    context: string;
    firstLine: number;
    lastLine: number;
    language?: string;
    recentEdits: { inserted: string; deleted: string }[];
  }) => Promise<{ edit: PredictedCodeEdit | null }>;
}

/** 每个编辑器只注册一次；重复注册会叠出多份监听与多套键位。 */
const registeredEditors = new WeakSet<object>();

export function registerNextEditPrediction(deps: NextEditPredictionDeps): { dispose(): void } {
  const { editor, monaco, request } = deps;
  if (registeredEditors.has(editor)) return { dispose: () => undefined };
  registeredEditors.add(editor);

  const visibleKey = editor.createContextKey<boolean>('echolyNextEditVisible', false);
  const decorations = editor.createDecorationsCollection([]);
  let proposal: PredictedCodeEdit | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let suppressedUntil = 0;
  /** 预测请求的自增序号，用来丢弃过期响应 */
  let requestSeq = 0;

  const clearProposal = (): void => {
    proposal = null;
    visibleKey.set(false);
    decorations.clear();
  };

  const showProposal = (edit: PredictedCodeEdit, model: Monaco.editor.ITextModel): void => {
    const lineCount = model.getLineCount();
    if (edit.startLine < 1 || edit.endLine > lineCount || edit.startLine > edit.endLine) return;

    proposal = edit;
    const options: Monaco.editor.IModelDeltaDecoration[] = [];
    for (let line = edit.startLine; line <= edit.endLine; line += 1) {
      options.push({
        range: new monaco.Range(line, 1, line, 1),
        options: { isWholeLine: true, className: 'next-edit-proposal-line' },
      });
    }
    const hintColumn = model.getLineMaxColumn(edit.startLine);
    options.push({
      range: new monaco.Range(edit.startLine, hintColumn, edit.startLine, hintColumn),
      options: {
        after: {
          content: formatProposalHint(edit),
          inlineClassName: 'next-edit-hint',
          cursorStops: monaco.editor.InjectedTextCursorStops.None,
        },
      },
    });
    decorations.set(options);
    visibleKey.set(true);
  };

  const probe = async (): Promise<void> => {
    timer = null;
    if (disposed || !isNextEditPredictionEnabled()) return;
    if (Date.now() < suppressedUntil) return;
    const model = editor.getModel();
    if (!model || model.isDisposed()) return;
    if (!editor.hasTextFocus()) return;
    // 幽灵补全正在显示时把位置让给它：两个 AI 界面同时出现只会互相干扰
    if (document.body.classList.contains('has-active-ghost-text')) return;

    const cursor = editor.getPosition();
    const aroundLine = cursor?.lineNumber ?? 1;
    const numbered = buildNumberedContext(model, aroundLine);
    const seq = (requestSeq += 1);

    let edit: PredictedCodeEdit | null = null;
    try {
      const res = await request({
        context: numbered.context,
        firstLine: numbered.firstLine,
        lastLine: numbered.lastLine,
        language: model.getLanguageId(),
        recentEdits: collectRecentEditsForContext(model.uri.toString()),
      });
      edit = res?.edit ?? null;
    } catch {
      // 预测失败就什么都不显示 —— 它不是用户主动要求的东西，不该弹错误
      return;
    }

    // 期间又发生了编辑，或用户已经把功能关掉：这次结果作废
    if (disposed || seq !== requestSeq) return;
    if (!isNextEditPredictionEnabled()) return;
    if (editor.getModel() !== model) return;
    if (document.body.classList.contains('has-active-ghost-text')) return;
    if (!edit) return;
    showProposal(edit, model);
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void probe(), IDLE_MS);
  };

  const accept = (): void => {
    const edit = proposal;
    const model = editor.getModel();
    if (!edit || !model) return;
    const range = new monaco.Range(
      edit.startLine,
      1,
      edit.endLine,
      model.getLineMaxColumn(edit.endLine),
    );
    clearProposal();
    // 接受后先静默一会儿，避免立刻又弹出下一处建议追着用户跑
    suppressedUntil = Date.now() + ACCEPT_COOLDOWN_MS;
    // 走 pushEditOperations 而不是 setValue：这样它进撤销栈，Cmd+Z 一步可退
    model.pushEditOperations([], [{ range, text: edit.newText }], () => null);
  };

  /**
   * Tab 的统一语义（只在这一条建议存在时接管）。
   *
   * 建议显示在**别处**，光标还停在原地 —— 这时按 Tab 的意图是「带我去看那一处」，
   * 而不是「在现在这个光标位置插入点什么」。等光标真的落进建议区间，Tab 才变成接受。
   *
   * 之所以值得抢 Tab：这个功能此前的入口是 `Alt+]`，一个没人会去猜的组合键 ——
   * 建议明明已经算出来并高亮在那儿了，用户却不知道该按什么。Tab 是本能动作。
   *
   * 代价是可控的：命令带 `echolyNextEditVisible && !inlineSuggestionVisible` 前提，
   * 没有这条建议时 Tab 完全是它原本的含义（缩进 / 接受幽灵补全）。
   */
  const tabAction = (): void => {
    const edit = proposal;
    const model = editor.getModel();
    if (!edit || !model) return;
    const position = editor.getPosition();
    if (position && position.lineNumber >= edit.startLine && position.lineNumber <= edit.endLine) {
      accept();
      return;
    }
    // 只移动光标，不改文件：跳到哪儿看一眼再决定，比「Tab 直接把别处改了」安全得多。
    editor.setPosition(new monaco.Position(edit.startLine, 1));
    editor.revealLineInCenterIfOutsideViewport(edit.startLine);
  };

  const changeSubscription = editor.onDidChangeModelContent(() => {
    // 任何内容变动都会让旧建议的行号失去意义，先撤掉再重新计时
    clearProposal();
    schedule();
  });
  const modelSubscription = editor.onDidChangeModel(() => {
    clearProposal();
    schedule();
  });
  const blurSubscription = editor.onDidBlurEditorText(() => clearProposal());
  const enabledSubscription = subscribeAiCompletionEnabled(() => {
    if (!isNextEditPredictionEnabled()) clearProposal();
  });

  // 三个键都带 `echolyNextEditVisible` 前提：没有建议时它们完全不生效，
  // 不会挤掉 Escape / Alt+] 在编辑器里的原有含义。
  editor.addCommand(
    monaco.KeyMod.Alt | monaco.KeyCode.BracketRight,
    accept,
    'echolyNextEditVisible',
  );
  // vim 模式下 normal 模式的 Tab 归 vim（缩进/跳转），不能被这条抢走
  const tabWhen = deps.vimContextKey
    ? `echolyNextEditVisible && !inlineSuggestionVisible && !${deps.vimContextKey}`
    : 'echolyNextEditVisible && !inlineSuggestionVisible';
  editor.addCommand(monaco.KeyCode.Tab, tabAction, tabWhen);
  editor.addCommand(
    monaco.KeyMod.Alt | monaco.KeyCode.BracketLeft,
    () => clearProposal(),
    'echolyNextEditVisible',
  );
  // Esc 的条件在 vim 模式下要再加一个否定项：那边 Esc 是「回 normal 模式」，
  // 被这条规则抢掉会让用户以为 vim 坏了。两个条件都由 Monaco 的上下文键求值，
  // 所以拼接表达式是安全的（不是字符串拼接用户输入）。
  const escapeWhen = deps.vimContextKey
    ? `echolyNextEditVisible && !${deps.vimContextKey}`
    : 'echolyNextEditVisible';
  editor.addCommand(monaco.KeyCode.Escape, () => clearProposal(), escapeWhen);

  schedule();

  return {
    dispose: () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      clearProposal();
      changeSubscription.dispose();
      modelSubscription.dispose();
      blurSubscription.dispose();
      enabledSubscription();
      decorations.clear();
    },
  };
}

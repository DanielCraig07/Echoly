import * as monaco from 'monaco-editor';
import { isAiCompletionEnabled } from './completionEnabled';
import {
  recordCompletionAccepted,
  recordCompletionOutcome,
  recordCompletionRequest,
} from './completionMetrics';

let isRegistered = false;
let completionTimeout: ReturnType<typeof setTimeout> | null = null;
let isGhostActive = false;

/**
 * 最近一次给出的建议，用来反推「用户接受了没有」。
 *
 * Monaco 不会告诉我们用户按了 Tab —— 补全提供者只负责「给出建议」，
 * 接受与否发生在编辑器的按键处理里，对我们是黑盒。唯一可靠的信号是
 * **光标处真的插入了我们建议过的文本**，所以这里挂一个模型内容监听，
 * 命中「同一位置 + 插入内容是建议的前缀」就记一次接受。
 */
let pendingAcceptance: { dispose: () => void } | null = null;

function dropPendingAcceptance(): void {
  const pending = pendingAcceptance;
  pendingAcceptance = null;
  pending?.dispose();
}

/**
 * 监听「这条建议被接受」。
 *
 * 判定条件三条都要满足：插入发生在**同一行列**（排除在别处敲字）、
 * 插入内容非空白、且是建议文本的**前缀**。
 * 用前缀而不是全等：用户边看边敲下开头几个字符也是接受，
 * 而整段补全被一次性应用是其中一个特例。
 */
function watchAcceptance(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  suggestedText: string,
): void {
  dropPendingAcceptance();
  const subscription = model.onDidChangeContent((event) => {
    // 先摘掉自己再判断：在事件回调里 dispose 正在触发的订阅容易踩到重入问题
    dropPendingAcceptance();
    const accepted = event.changes.some(
      (change) =>
        change.text.length > 0 &&
        change.text.trim().length > 0 &&
        change.range.startLineNumber === position.lineNumber &&
        change.range.startColumn === position.column &&
        suggestedText.startsWith(change.text),
    );
    if (accepted) {
      recordCompletionAccepted();
      notifyGhostState(false);
    }
  });
  pendingAcceptance = { dispose: () => subscription.dispose() };
}

function notifyGhostState(active: boolean) {
  if (isGhostActive === active) return;
  isGhostActive = active;
  window.dispatchEvent(
    new CustomEvent('echoly:ghostTextState', {
      detail: { active },
    }),
  );
  if (active) {
    document.body.classList.add('has-active-ghost-text');
  } else {
    document.body.classList.remove('has-active-ghost-text');
  }
}

/**
 * 注册行内代码补全提供者 (Cursor Tab / Ghost Text)
 * 监听光标输入并向后台 LLM 发送上下文生成建议补全
 */
export function registerAiInlineCompletions(): monaco.IDisposable | null {
  if (isRegistered) return null;
  isRegistered = true;

  try {
    return monaco.languages.registerInlineCompletionsProvider('*', {
      provideInlineCompletions: async (model, position, _context, token) => {
        // 总开关在**每次响应前**读一次：关掉之后连 IPC 都不发，
        // 而不是「请求照发、只是不显示」。见 completionEnabled.ts 的说明。
        if (!isAiCompletionEnabled()) {
          notifyGhostState(false);
          return { items: [] };
        }

        if (token.isCancellationRequested) {
          notifyGhostState(false);
          return { items: [] };
        }

        // 防抖 350ms，避免快速连续击键时频繁请求 LLM
        await new Promise<void>((resolve) => {
          if (completionTimeout) clearTimeout(completionTimeout);
          completionTimeout = setTimeout(resolve, 350);
        });

        if (token.isCancellationRequested) {
          notifyGhostState(false);
          return { items: [] };
        }

        const offset = model.getOffsetAt(position);
        const fullText = model.getValue();
        // 取光标前最多 2000 个字符和光标后最多 1000 个字符构建 FIM (Fill-in-the-middle) 上下文
        const prefix = fullText.slice(Math.max(0, offset - 2000), offset);
        const suffix = fullText.slice(offset, Math.min(fullText.length, offset + 1000));

        // 如果前后文皆为空，或仅在空白首行输入时，不主动触发
        if (!prefix.trim() && !suffix.trim()) {
          notifyGhostState(false);
          return { items: [] };
        }

        const language = model.getLanguageId();
        const startedAt = Date.now();
        recordCompletionRequest();
        try {
          const res = await window.ide?.completeCode?.({ prefix, suffix, language });
          const latency = Date.now() - startedAt;

          if (token.isCancellationRequested) {
            // 不加进延迟样本：这一段的耗时反映的是「用户多快又敲了一下」，
            // 混进平均值会让延迟指标失去意义。
            recordCompletionOutcome('cancelled');
            notifyGhostState(false);
            return { items: [] };
          }

          if (!res?.completion) {
            recordCompletionOutcome('empty', latency);
            notifyGhostState(false);
            return { items: [] };
          }

          // 围栏与结构化解析都在主进程做过了，这里不再二次裁剪：
          // 在 markdown 里补全一个代码块时，「```」本身就是要插入的内容，
          // 渲染层再剥一次会把它吃掉。
          const completionText = res.completion;
          if (!completionText.trim()) {
            recordCompletionOutcome('empty', latency);
            notifyGhostState(false);
            return { items: [] };
          }

          recordCompletionOutcome('succeeded', latency);
          notifyGhostState(true);
          watchAcceptance(model, position, completionText);
          return {
            items: [
              {
                insertText: completionText,
                range: new monaco.Range(
                  position.lineNumber,
                  position.column,
                  position.lineNumber,
                  position.column,
                ),
              },
            ],
          };
        } catch {
          recordCompletionOutcome('failed', Date.now() - startedAt);
          notifyGhostState(false);
          return { items: [] };
        }
      },
      freeInlineCompletions: () => {
        notifyGhostState(false);
      },
    });
  } catch (err) {
    console.warn('[InlineCompletion] Failed to register inline completion provider:', err);
    return null;
  }
}

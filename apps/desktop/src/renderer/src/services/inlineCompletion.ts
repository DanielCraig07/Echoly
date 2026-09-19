import * as monaco from 'monaco-editor';

let isRegistered = false;
let completionTimeout: ReturnType<typeof setTimeout> | null = null;
let isGhostActive = false;

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
        try {
          const res = await window.ide?.completeCode?.({ prefix, suffix, language });
          if (!res?.completion || token.isCancellationRequested) {
            notifyGhostState(false);
            return { items: [] };
          }

          let completionText = res.completion;
          // 若包含 markdown 标记则剔除
          if (completionText.startsWith('```')) {
            completionText = completionText.replace(/^```[a-zA-Z0-9_-]*\n?/, '').replace(/\n?```$/, '');
          }

          if (!completionText.trim()) {
            notifyGhostState(false);
            return { items: [] };
          }

          notifyGhostState(true);
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

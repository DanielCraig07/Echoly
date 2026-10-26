import * as monaco from 'monaco-editor';
import type { ChatAttachment } from '@deepseek-ide/shared';
import { normalizePath } from './symbolNavigation';

/**
 * `@Git` / `@Terminal` / `@Problems` 展开出的附件正文。
 *
 * **这里的中文刻意不进字典**：产出物是送给模型的 prompt 载荷，不是给用户读的界面文案。
 * 标成 `ERROR` / `WARNING` 的机器可读行、`--- 当前终端最近输出 ---` 这类分隔标题，
 * 都是模型用来理解结构的信号；翻一遍等于换一套提示词，产出会跟着变 ——
 * 那是另一个行为，不是另一个语言。用户在气泡里看到的是附件**卡片**（文件名 + 类型），
 * 那部分是翻的。
 */
/**
 * 终端日志的跨组件注册表。
 *
 * 终端缓冲区活在 `TerminalPanel` 内部的 xterm 实例里，而 `@Terminal` 引用是在聊天输入框
 * 提交时解析的 —— 两个组件之间没有父子关系。这里用一个模块级注册表把「当前聚焦终端」
 * 的读取函数暴露出来，避免为了拿几十行文本把整棵组件树打通。
 *
 * 面板组件卸载或终端关闭时会注销自己那一项；没有注册项时读取返回空串，
 * 调用方据此给出「终端暂无输出」的提示，而不是编造内容。
 */
type LogReader = (lines?: number) => string;

const readers = new Map<string, LogReader>();
let focusedId: string | null = null;

export function registerTerminalLogReader(clientId: string, read: LogReader): () => void {
  readers.set(clientId, read);
  if (!focusedId || !readers.has(focusedId)) focusedId = clientId;
  return () => {
    readers.delete(clientId);
    if (focusedId === clientId) {
      focusedId = readers.keys().next().value ?? null;
    }
  };
}

export function setFocusedTerminalId(clientId: string | null): void {
  focusedId = clientId;
}

/** 读取当前聚焦终端最近 `lines` 行；没有终端时返回空串。 */
export function readActiveTerminalLog(lines = 80): string {
  const id = focusedId ?? readers.keys().next().value ?? null;
  if (!id) return '';
  const reader = readers.get(id);
  if (!reader) return '';
  try {
    return stripAnsi(reader(lines));
  } catch {
    return '';
  }
}

/** xterm 缓冲区里带着颜色/光标转义序列，直接塞给模型是纯噪声。 */
export function stripAnsi(text: string): string {
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

/**
 * 把 `@Git` / `@Terminal` / `@Problems` 这三个特殊提及展开成真实上下文附件。
 *
 * 展开发生在提交时而不是插入时：这三个引用描述的都是「此刻的状态」，
 * 在输入框里停留几分钟后状态早就变了，插入时快照反而会骗到模型。
 * 展开成附件（而不是拼进 prompt 文本）还有一个好处：历史消息里能看到当时引用了什么，
 * 且原样进入 buildAgentHistory，多轮对话里上下文不会丢。
 */
export async function resolveSpecialMentions(
  prompt: string,
  deps: {
    getWorkspaceRoot: () => string | null;
  },
): Promise<ChatAttachment[]> {
  const out: ChatAttachment[] = [];
  const mentionsGit = /@Git\b/i.test(prompt);
  const mentionsTerminal = /@Terminal\b/i.test(prompt);
  const mentionsProblems = /@Problems\b/i.test(prompt);
  if (!mentionsGit && !mentionsTerminal && !mentionsProblems) return out;

  if (mentionsGit) {
    const content = await buildGitContext();
    out.push({
      id: `special-git-${Date.now()}`,
      name: '@Git',
      type: 'file',
      mimeType: 'text/plain',
      content,
    });
  }

  if (mentionsTerminal) {
    const log = readActiveTerminalLog(120);
    out.push({
      id: `special-terminal-${Date.now()}`,
      name: '@Terminal',
      type: 'file',
      mimeType: 'text/plain',
      content: log
        ? `--- 当前终端最近输出 ---\n\`\`\`log\n${log}\n\`\`\``
        : '--- 当前终端最近输出 ---\n(终端暂无输出，或尚未打开终端面板)',
    });
  }

  if (mentionsProblems) {
    const items = collectMonacoProblems(deps.getWorkspaceRoot());
    const errors = items.filter((i) => i.severity === 'error');
    const body =
      items.length === 0
        ? '(当前工作区没有检测到错误或警告)'
        : items
            .slice(0, 60)
            .map(
              (i) =>
                `${i.severity === 'error' ? 'ERROR' : 'WARNING'}\t${i.path}:${i.line}${i.column ? `:${i.column}` : ''}\t${i.message}`,
            )
            .join('\n');
    out.push({
      id: `special-problems-${Date.now()}`,
      name: '@Problems',
      type: 'file',
      mimeType: 'text/plain',
      content: `--- 当前工作区诊断 (共 ${items.length} 项，其中 ${errors.length} 个错误) ---\n${body}`,
    });
  }

  return out;
}

/**
 * 直接读 Monaco markers。
 *
 * 不复用 ProblemsPanel 的 state：那个组件的挂载取决于底部面板是否展开过，
 * 用户在没打开过「问题」面板时引用 @Problems 就会拿到空列表。
 * markers 是 Monaco 的全局状态，这里同步读一次即可，也顺便只取 Error/Warning。
 */
function collectMonacoProblems(root: string | null): Array<{
  path: string;
  line: number;
  column?: number;
  severity: 'error' | 'warning';
  message: string;
  source?: string;
}> {
  try {
    return monaco.editor
      .getModelMarkers({})
      .filter(
        (m) =>
          m.severity === monaco.MarkerSeverity.Error ||
          m.severity === monaco.MarkerSeverity.Warning,
      )
      .map((m) => ({
        path: normalizePath(m.resource.fsPath || m.resource.path || '', root),
        line: m.startLineNumber,
        column: m.startColumn,
        severity:
          m.severity === monaco.MarkerSeverity.Error ? ('error' as const) : ('warning' as const),
        message: m.message,
        source: m.source,
      }));
  } catch {
    return [];
  }
}

async function buildGitContext(): Promise<string> {
  try {
    const status = await window.ide.gitStatus();
    if (!status.isRepo) {
      return '--- Git 状态 ---\n(当前工作区不是 Git 仓库)';
    }
    const head = [
      `分支: ${status.branch ?? '(detached)'}`,
      status.ahead || status.behind ? `领先 ${status.ahead} / 落后 ${status.behind}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const entries = (status.entries || []).slice(0, 40);
    const lines = entries
      .map((e) => {
        const untracked = e.untracked ? 'untracked' : e.staged ? 'staged' : 'modified';
        return `${untracked}\t${e.path}`;
      })
      .join('\n');

    // 未提交改动的实际 diff 才是模型真正需要的，光看文件名列表没法评审
    const diffParts: string[] = [];
    for (const e of entries.filter((x) => !x.untracked).slice(0, 8)) {
      try {
        const diff = await window.ide.gitDiff(e.path, e.staged);
        if (diff.ok) {
          const text = buildUnifiedDiff(diff.original, diff.modified, e.path);
          if (text) diffParts.push(text);
        }
      } catch {
        // 单个文件取 diff 失败不应该毁掉整个引用
      }
    }

    const more =
      status.entries.length > entries.length
        ? `\n...[还有 ${status.entries.length - entries.length} 个变更文件未列出]`
        : '';

    return [
      '--- Git 状态 ---',
      head,
      status.entries.length
        ? `变更文件 (${status.entries.length}):\n${lines}${more}`
        : '工作区干净，无变更。',
      diffParts.length ? `\n--- 未提交改动 diff (最多 8 个文件) ---\n${diffParts.join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  } catch (err) {
    return `--- Git 状态 ---\n(读取失败: ${err instanceof Error ? err.message : String(err)})`;
  }
}

/**
 * 这里刻意自己拼一份极简 unified diff，而不是引入 diff 库：
 * 目的只是给模型看「改了哪些行」，精确的 hunk 算法在这里没有收益，多一个依赖反而要维护。
 */
function buildUnifiedDiff(original: string, modified: string, path: string): string {
  const a = original.split(/\r?\n/);
  const b = modified.split(/\r?\n/);
  const out: string[] = [`diff --git a/${path} b/${path}`];
  const max = Math.max(a.length, b.length);
  let contextLeft = 0;
  let emitted = 0;
  for (let i = 0; i < max && emitted < 200; i++) {
    const av = a[i];
    const bv = b[i];
    if (av === bv) {
      if (contextLeft > 0) {
        out.push(` ${av ?? ''}`);
        contextLeft--;
        emitted++;
      }
      continue;
    }
    if (contextLeft === 0) {
      out.push('@@ ... @@');
      contextLeft = 3;
    }
    if (av !== undefined) {
      out.push(`-${av}`);
      emitted++;
    }
    if (bv !== undefined) {
      out.push(`+${bv}`);
      emitted++;
    }
    contextLeft = 3;
  }
  return out.length > 1 ? out.join('\n') : '';
}

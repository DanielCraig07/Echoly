import React, { useState, useEffect, useRef } from 'react';
import type { UiTheme } from '@deepseek-ide/shared';

interface TerminalAiKBarProps {
  open: boolean;
  onClose: () => void;
  activeClientId: string | null;
  cwd?: string;
  uiTheme?: UiTheme;
  onExecute: (command: string) => void;
  onInsert: (command: string) => void;
}

export const TerminalAiKBar: React.FC<TerminalAiKBarProps> = ({
  open,
  onClose,
  activeClientId,
  cwd,
  uiTheme = 'dark',
  onExecute,
  onInsert,
}) => {
  const [prompt, setPrompt] = useState('');
  const [generatedCmd, setGeneratedCmd] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setPrompt('');
      setGeneratedCmd(null);
      setErrorMsg(null);
      setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
    }
  }, [open]);

  if (!open) return null;

  const handleGenerate = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const query = prompt.trim();
    if (!query || loading) return;

    setLoading(true);
    setErrorMsg(null);

    const isMac = navigator.platform.toUpperCase().includes('MAC');
    const shellEnv = isMac ? 'macOS (zsh / bash)' : 'Windows / Linux (bash / powershell)';
    const contextPrompt = `你是一个终端命令生成专家。当前终端操作系统: ${shellEnv}，当前工作路径: ${cwd || '项目根目录'}。
请根据用户的需求生成一条最精准、可以直接在终端执行的 shell 命令。
严格要求：
1. 仅返回命令文本，严禁包含 markdown 代码块反引号（如不要 \`\`\`bash 包裹），不要包含任何中文解释或多余字符。
2. 多步操作使用 && 拼接成单行。
3. 保证命令安全且符合系统环境规范。`;

    try {
      const response = await window.ide.quickPrompt({
        userPrompt: query,
        systemPrompt: contextPrompt,
        temperature: 0.1,
      });
      let cleanCmd = response.text.trim();
      // 去除可能意外包裹的 markdown 标记
      if (cleanCmd.startsWith('```')) {
        cleanCmd = cleanCmd.replace(/^```[a-zA-Z0-9_-]*\n?/, '').replace(/\n?```$/, '').trim();
      }
      setGeneratedCmd(cleanCmd);
    } catch (err: any) {
      setErrorMsg(err?.message || '生成终端命令失败，请重试');
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }

    if (e.key === 'Enter') {
      if (e.metaKey || e.ctrlKey) {
        // Cmd+Enter 直接执行生成的命令
        if (generatedCmd) {
          e.preventDefault();
          onExecute(generatedCmd);
          onClose();
        }
      } else if (!generatedCmd && prompt.trim()) {
        e.preventDefault();
        void handleGenerate();
      }
    }
  };

  const handleRunCommand = () => {
    if (generatedCmd) {
      onExecute(generatedCmd);
      onClose();
    }
  };

  const handleInsertCommand = () => {
    if (generatedCmd) {
      onInsert(generatedCmd);
      onClose();
    }
  };

  return (
    <div
      className="terminal-ai-k-bar-overlay"
      style={{
        position: 'absolute',
        top: 12,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 999,
        width: 'min(640px, 92%)',
        borderRadius: 10,
        background: 'var(--bg-secondary, #252526)',
        border: '1px solid var(--accent, #4c8dff)',
        boxShadow: '0 12px 36px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(76, 141, 255, 0.25)',
        backdropFilter: 'blur(12px)',
        overflow: 'hidden',
      }}
      onKeyDown={handleKeyDown}
    >
      {/* 顶部输入框 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '8px 12px',
          gap: 8,
          borderBottom: generatedCmd || errorMsg ? '1px solid var(--border, #333)' : 'none',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--accent, #4c8dff)',
            fontSize: 14,
            flexShrink: 0,
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
          </svg>
        </div>

        <input
          ref={inputRef}
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="向 AI 描述命令需求，例如: 查找占用 8080 端口的进程并杀死、拉取最新代码并合并..."
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            fontSize: 13,
            color: 'var(--text, #fff)',
            padding: '4px 0',
          }}
          disabled={loading}
        />

        {loading ? (
          <span style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 4 }}>
            <span className="spinner-icon" style={{ display: 'inline-block' }}>⟳</span>
            生成中...
          </span>
        ) : (
          <button
            type="button"
            className="panel-standard-btn primary"
            style={{ padding: '3px 10px', fontSize: 12, height: 26, borderRadius: 5 }}
            onClick={() => void handleGenerate()}
            disabled={!prompt.trim()}
          >
            {generatedCmd ? '重新生成' : '生成 (↵)'}
          </button>
        )}

        <button
          type="button"
          className="panel-action-btn"
          title="关闭 (Esc)"
          onClick={onClose}
          style={{ marginLeft: 2 }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* 报错信息 */}
      {errorMsg && (
        <div style={{ padding: '8px 12px', fontSize: 12, color: '#f87171', background: 'rgba(239, 68, 68, 0.1)' }}>
          {errorMsg}
        </div>
      )}

      {/* 生成的命令展示与操作 */}
      {generatedCmd && (
        <div
          style={{
            padding: '10px 12px',
            background: 'rgba(0, 0, 0, 0.25)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              background: 'var(--bg-editor, #1e1e1e)',
              padding: '6px 10px',
              borderRadius: 6,
              border: '1px solid var(--border, #333)',
            }}
          >
            <span
              style={{
                fontFamily: 'Consolas, "Cascadia Code", monospace',
                fontSize: 12.5,
                color: '#34d399',
                wordBreak: 'break-all',
                userSelect: 'text',
                flex: 1,
              }}
            >
              <span style={{ color: 'var(--text-secondary, #888)', marginRight: 6 }}>$</span>
              {generatedCmd}
            </span>

            <button
              type="button"
              className="panel-action-btn"
              title="复制命令"
              onClick={() => {
                void navigator.clipboard.writeText(generatedCmd);
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 }}>
            <span style={{ fontSize: 11, color: 'var(--text-secondary, #888)' }}>
              按 <kbd style={{ padding: '1px 4px', borderRadius: 3, border: '1px solid var(--border)' }}>↵</kbd> 执行，
              <kbd style={{ padding: '1px 4px', borderRadius: 3, border: '1px solid var(--border)' }}>Esc</kbd> 退出
            </span>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button
                type="button"
                className="panel-standard-btn"
                style={{ padding: '3px 10px', fontSize: 12, height: 26, borderRadius: 5 }}
                onClick={handleInsertCommand}
                title="粘贴到终端中（不自动回车）"
              >
                仅插入 (⇧↵)
              </button>
              <button
                type="button"
                className="panel-standard-btn primary"
                style={{ padding: '3px 12px', fontSize: 12, height: 26, borderRadius: 5 }}
                onClick={handleRunCommand}
                title="立即在终端中执行命令"
              >
                立即执行 (↵)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

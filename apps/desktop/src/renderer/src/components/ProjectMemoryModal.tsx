import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  useModalResize,
  ModalResizeHandle,
  createSafeOverlayHandlers,
} from '../hooks/useModalResize';
import { showGlobalToast } from '../services/toast';
import { useI18n } from '../i18n';

interface ProjectMemoryModalProps {
  open: boolean;
  onClose: () => void;
}

export function ProjectMemoryModal({ open, onClose }: ProjectMemoryModalProps) {
  const { t } = useI18n();
  const { modalSize, handleResizeStart } = useModalResize({
    storageKey: 'echoly_project_memory_modal_size',
    defaultWidth: 780,
    defaultHeight: 560,
    minWidth: 540,
    minHeight: 380,
  });

  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [dirty, setDirty] = useState<boolean>(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setDirty(false);
    window.ide
      .projectGetMemory()
      .then((res) => {
        if (res && res.ok && res.memory != null) {
          setContent(res.memory);
        } else {
          setContent('');
        }
      })
      .catch((err) => {
        console.error('加载项目记忆失败:', err);
        setContent('');
      })
      .finally(() => {
        setLoading(false);
        setTimeout(() => textareaRef.current?.focus(), 80);
      });
  }, [open]);

  if (!open) return null;

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await window.ide.projectSaveMemory(content);
      if (res && res.ok) {
        setDirty(false);
        showGlobalToast('项目长期记忆已保存', 'success', '.echoly/memory.json 更新成功');
      } else {
        showGlobalToast('保存失败', 'error', '写入 .echoly/memory.json 发生错误');
      }
    } catch (err: any) {
      showGlobalToast('保存失败', 'error', err?.message || String(err));
    } finally {
      setSaving(false);
    }
  };

  const insertTemplate = (snippet: string) => {
    setContent((prev) => {
      const trimmed = prev.trim();
      const next = trimmed ? `${trimmed}\n\n${snippet}` : snippet;
      return next;
    });
    setDirty(true);
  };

  return createPortal(
    <div className="modal-overlay" {...createSafeOverlayHandlers(onClose)}>
      <div
        className="modal-box"
        style={{
          width: modalSize.width,
          height: modalSize.height,
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
          padding: 0,
          background: 'var(--bg-panel, #1e1e1e)',
          borderRadius: 8,
          border: '1px solid var(--border, rgba(255, 255, 255, 0.12))',
          boxShadow: '0 16px 36px rgba(0, 0, 0, 0.45)',
          overflow: 'hidden',
          fontSize: 'var(--ui-font-size, 12px)',
        }}
      >
        {/* 顶部标题栏 (容器高度严格 30px，符合规范) */}
        <div
          style={{
            height: 30,
            padding: '0 10px',
            boxSizing: 'border-box',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid var(--border, rgba(255, 255, 255, 0.08))',
            flexShrink: 0,
            background: 'var(--bg-sidebar, #181818)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ color: 'var(--accent, #3b82f6)' }}
            >
              <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8z" />
              <path d="M12 6v6l4 2" />
            </svg>
            <span
              style={{
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: '0.05em',
                color: 'var(--text, #e2e8f0)',
              }}
            >
              项目长期记忆与架构约定
            </span>
            <span
              style={{
                fontSize: 10,
                color: 'var(--muted, #888)',
                padding: '1px 5px',
                background: 'rgba(255, 255, 255, 0.06)',
                borderRadius: 3,
              }}
            >
              .echoly/memory.json
            </span>
            {dirty && (
              <span
                style={{
                  fontSize: 10,
                  color: '#e2c08d',
                  padding: '1px 5px',
                  background: 'rgba(226, 192, 141, 0.15)',
                  borderRadius: 3,
                }}
              >
                未保存
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button type="button" className="panel-action-btn" title="关闭弹窗" onClick={onClose}>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* 快捷模板提示与工具条 */}
        <div
          style={{
            padding: '8px 14px',
            background: 'var(--bg-sidebar, #181818)',
            borderBottom: '1px solid var(--border, rgba(255, 255, 255, 0.06))',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 8,
            flexShrink: 0,
          }}
        >
          <div style={{ fontSize: 11, color: 'var(--muted, #888)', lineHeight: 1.4 }}>
            在此记录项目架构规范、设计约定及历史 Bug 避坑清单。AI 智能体与快捷对话将自动注入此记忆。
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              type="button"
              className="panel-action-btn"
              style={{ padding: '2px 8px', fontSize: 11, borderRadius: 4 }}
              title="插入技术栈与架构约定模板"
              onClick={() =>
                insertTemplate(
                  `## 架构约定\n- 状态管理：统一使用 React Hooks / Context，避免滥用全局状态\n- 组件拆分：每个文件行数不超过 500 行，业务逻辑与 UI 视图分离\n- 接口规范：后端 API 交互统一放置于 src/services/`,
                )
              }
            >
              + 架构规范
            </button>
            <button
              type="button"
              className="panel-action-btn"
              style={{ padding: '2px 8px', fontSize: 11, borderRadius: 4 }}
              title="插入代码风格规范模板"
              onClick={() =>
                insertTemplate(
                  `## 代码风格\n- 语言标准：TypeScript 严格模式，禁止使用 any 类型\n- 样式方案：使用 CSS Variables，避免硬编码十六进制颜色值\n- 命名规范：组件文件名采用 PascalCase，工具函数采用 camelCase`,
                )
              }
            >
              + 代码风格
            </button>
            <button
              type="button"
              className="panel-action-btn"
              style={{ padding: '2px 8px', fontSize: 11, borderRadius: 4 }}
              title="插入历史 Bug 避坑清单模板"
              onClick={() =>
                insertTemplate(
                  `## 避坑备忘清单\n- 路径匹配：跨平台路径统一做斜杠归一化 replace(/\\\\/g, '/')\n- 滚动条管理：Monaco 粘性滚动需保证 tabular-nums 与 content-box`,
                )
              }
            >
              + 避坑清单
            </button>
          </div>
        </div>

        {/* 编辑区 */}
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden', display: 'flex' }}>
          {loading ? (
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--muted, #888)',
                fontSize: 12,
              }}
            >
              正在读取项目记忆...
            </div>
          ) : (
            <textarea
              ref={textareaRef}
              value={content}
              onChange={(e) => {
                setContent(e.target.value);
                setDirty(true);
              }}
              placeholder={`# 项目长期记忆与技术架构规范 (.echoly/memory.json)\n\n在此输入针对该项目的长期架构约定、编码习惯与踩坑记录，例如：\n- 采用 Vite + Electron + React 技术栈\n- 工具栏高度严格 30px，按钮统一样式类 panel-action-btn\n- 终端 Shell 必须传入 -l 参数`}
              style={{
                width: '100%',
                height: '100%',
                padding: '12px 14px',
                boxSizing: 'border-box',
                background: 'var(--bg-editor, #1e1e1e)',
                color: 'var(--text, #e2e8f0)',
                border: 'none',
                outline: 'none',
                resize: 'none',
                fontFamily: 'Menlo, Monaco, "Cascadia Code", Consolas, "PingFang SC", monospace',
                fontSize: 12,
                lineHeight: 1.6,
                tabSize: 2,
              }}
              spellCheck={false}
            />
          )}
        </div>

        {/* 底部操作栏 */}
        <div
          style={{
            height: 38,
            padding: '0 14px',
            borderTop: '1px solid var(--border, rgba(255, 255, 255, 0.08))',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'var(--bg-sidebar, #181818)',
            flexShrink: 0,
          }}
        >
          <div style={{ fontSize: 11, color: 'var(--muted, #888)' }}>
            快捷键：
            <kbd
              style={{ padding: '1px 4px', background: 'rgba(255,255,255,0.08)', borderRadius: 3 }}
            >
              Cmd / Ctrl + S
            </kbd>{' '}
            保存
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              className="panel-action-btn"
              style={{ padding: '3px 12px', fontSize: 11, borderRadius: 4 }}
              onClick={onClose}
              title="取消并关闭"
            >
              取消
            </button>
            <button
              type="button"
              className="panel-action-btn"
              style={{
                padding: '3px 14px',
                fontSize: 11,
                borderRadius: 4,
                background: 'var(--accent, #3b82f6)',
                color: '#fff',
                borderColor: 'transparent',
                fontWeight: 600,
              }}
              onClick={handleSave}
              disabled={saving}
              title="保存项目记忆文件"
            >
              {saving ? '正在保存...' : '保存记忆'}
            </button>
          </div>
        </div>

        {/* 调整尺寸把手 */}
        <ModalResizeHandle onMouseDown={handleResizeStart} />
      </div>
    </div>,
    document.body,
  );
}

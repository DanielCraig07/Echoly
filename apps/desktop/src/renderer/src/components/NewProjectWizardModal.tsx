import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { PROJECT_TEMPLATE_LIST, type ProjectTemplate } from '../utils/projectTemplates';
import { useModalResize, ModalResizeHandle, createSafeOverlayHandlers } from '../hooks/useModalResize';
import { useI18n, translateSegments } from '../i18n';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  defaultWorkspace?: string | null;
  onOpenWorkspace: (targetPath: string, openInNewWindow: boolean, entryFile?: string) => void;
  onShowToast?: (title: string, detail?: string, type?: 'success' | 'error' | 'info' | 'warn') => void;
}

const DEFAULT_PROJECT_NAMES: Record<string, string> = {
  'nextjs-ai': 'nextjs-ai-demo',
  'fastapi-ai': 'fastapi-agent-demo',
  'java-maven': 'java-demo',
  'python': 'python-demo',
  'go': 'go-demo',
  'node-ts': 'ts-node-demo',
  'cpp-cmake': 'cpp-demo',
};

export function NewProjectWizardModal({
  isOpen,
  onClose,
  defaultWorkspace,
  onOpenWorkspace,
  onShowToast,
}: Props) {
  const { t, locale } = useI18n();
  const { modalSize, handleResizeStart } = useModalResize({
    storageKey: 'echoly_new_project_wizard_size',
    defaultWidth: 780,
    defaultHeight: 560,
    minWidth: 620,
    minHeight: 440,
  });
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('java-maven');
  const [projectName, setProjectName] = useState<string>('java-demo');
  const [parentDir, setParentDir] = useState<string>('');
  const [isCreating, setIsCreating] = useState(false);

  // 初始化父级目录：若当前已打开工作区，则优先取当前工作区的上级目录
  useEffect(() => {
    if (isOpen) {
      if (defaultWorkspace) {
        // 提取父目录
        const trimmed = defaultWorkspace.replace(/[/\\]+$/, '');
        const lastSlash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
        if (lastSlash > 0) {
          setParentDir(trimmed.slice(0, lastSlash));
        } else {
          setParentDir(trimmed);
        }
      } else {
        setParentDir('');
      }
      // 默认选中第一项或 cpp
      setSelectedTemplateId('java-maven');
      setProjectName('java-demo');
      setIsCreating(false);
    }
  }, [isOpen, defaultWorkspace]);

  // 监听 ESC 键关闭向导
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // 当切换技术栈时，若用户未手改项目名或项目名为默认值，智能调整项目名称
  const handleSelectTemplate = useCallback((tplId: string) => {
    setSelectedTemplateId(tplId);
    setProjectName((prev) => {
      const isDefault = Object.values(DEFAULT_PROJECT_NAMES).includes(prev.trim());
      if (isDefault || !prev.trim()) {
        return DEFAULT_PROJECT_NAMES[tplId] || `${tplId}-project`;
      }
      return prev;
    });
  }, []);

  const activeTemplate: ProjectTemplate = useMemo(() => {
    return (
      PROJECT_TEMPLATE_LIST.find((t) => t.id === selectedTemplateId) ||
      PROJECT_TEMPLATE_LIST[0]
    );
  }, [selectedTemplateId]);

  // 浏览选择父级目录
  const handlePickParentDir = async () => {
    try {
      const picked = await window.ide.pickDirectory();
      if (picked) {
        setParentDir(picked);
      }
    } catch (err: any) {
      onShowToast?.(t('workspace.pickDirFailed'), err?.message || String(err), 'error');
    }
  };

  // 计算完整目标路径
  const fullTargetPath = useMemo(() => {
    if (!parentDir.trim()) {
      return projectName.trim()
        ? `${t('workspace.noParentDir')}/${projectName.trim()}`
        : '';
    }
    const cleanParent = parentDir.trim().replace(/[/\\]+$/, '');
    const cleanName = projectName.trim();
    return cleanName ? `${cleanParent}/${cleanName}` : cleanParent;
  }, [parentDir, projectName, t]);

  // 执行创建并打开
  const handleCreateAndOpen = async (openInNewWindow: boolean) => {
    if (!parentDir.trim()) {
      onShowToast?.(t('workspace.needParentDir'), t('workspace.needParentDirDetail'), 'warn');
      return;
    }
    const cleanName = projectName.trim();
    if (!cleanName) {
      onShowToast?.(t('workspace.needProjectName'), t('workspace.needProjectNameDetail'), 'warn');
      return;
    }
    if (/[/\\:*?"<>|]/.test(cleanName)) {
      onShowToast?.(
        t('workspace.invalidProjectName'),
        t('workspace.invalidProjectNameDetail'),
        'error',
      );
      return;
    }

    setIsCreating(true);
    try {
      const res = await window.ide.createProjectFromTemplate({
        templateId: selectedTemplateId,
        parentDir: parentDir.trim(),
        projectName: cleanName,
      });

      if (!res.ok || !res.targetPath) {
        throw new Error(res.error || t('workspace.createFailed'));
      }

      onShowToast?.(
        t('workspace.createOk', { name: activeTemplate.name }),
        t('workspace.createOkDetail', { path: res.targetPath }),
        'success',
      );
      onClose();
      onOpenWorkspace(res.targetPath, openInNewWindow, res.entryFile);
    } catch (err: any) {
      onShowToast?.(t('workspace.createFailed'), err?.message || String(err), 'error');
    } finally {
      setIsCreating(false);
    }
  };

  if (!isOpen || typeof document === 'undefined') return null;

  const safeOverlay = createSafeOverlayHandlers(onClose);

  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 99999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.72)',
        backdropFilter: 'blur(6px)',
        padding: 16,
      }}
      {...safeOverlay}
    >
      <div
        style={{
          width: modalSize.width,
          height: modalSize.height,
          maxWidth: '96vw',
          maxHeight: '94vh',
          position: 'relative',
          background: 'var(--bg-modal, #141414)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          boxShadow: '0 24px 60px rgba(0, 0, 0, 0.8)',
          color: 'var(--text)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: '14px 20px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: '#141414',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 18 }}>🚀</span>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-bright, #fff)' }}>
                {t('workspace.wizardTitle')}
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                {t('workspace.wizardDesc')}
              </div>
            </div>
          </div>
          <button
            type="button"
            className="panel-action-btn"
            onClick={onClose}
            title={t('common.closeEsc')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 20, display: 'flex', gap: 18, flex: 1, minHeight: 0, overflow: 'hidden' }}>
          {/* 左侧技术栈列表 (使用 PROJECT_TEMPLATE_LIST 保证无任何重复项) */}
          <div style={{ width: 230, display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0, overflowY: 'auto', paddingRight: 4 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 2, flexShrink: 0 }}>
              {t('workspace.techSection')}
            </div>
            {PROJECT_TEMPLATE_LIST.map((tpl) => {
              const isSelected = tpl.id === selectedTemplateId;
              return (
                <button
                  key={tpl.id}
                  type="button"
                  onClick={() => handleSelectTemplate(tpl.id)}
                  className={`wizard-tech-card${isSelected ? ' is-selected' : ''}`}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <span style={{ fontSize: 15 }}>
                      {tpl.id.includes('java') ? '☕' : tpl.id.includes('python') ? '🐍' : tpl.id.includes('cpp') ? '⚡' : tpl.id.includes('go') ? '🐹' : '🟢'}
                    </span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {tpl.name}
                    </span>
                  </div>
                  <span
                    style={{
                      fontSize: 10,
                      padding: '2px 6px',
                      borderRadius: 4,
                      background: tpl.badgeBg,
                      color: tpl.badgeColor,
                      fontWeight: 700,
                      flexShrink: 0,
                      letterSpacing: '0.02em',
                    }}
                  >
                    {tpl.badge}
                  </span>
                </button>
              );
            })}
          </div>

          {/* 右侧表单配置与预览 */}
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
              minWidth: 0,
            }}
          >
            {/* 模板头部简述 */}
            <div
              style={{
                padding: '12px 16px',
                borderRadius: 10,
                background: 'var(--bg-panel)',
                border: '1px solid var(--border)',
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
              }}
            >
              <span style={{ fontSize: 24, lineHeight: 1 }}>
                {activeTemplate.id.includes('java') ? '☕' : activeTemplate.id.includes('python') ? '🐍' : activeTemplate.id.includes('cpp') ? '⚡' : activeTemplate.id.includes('go') ? '🐹' : '🟢'}
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      fontSize: 10.5,
                      padding: '2px 7px',
                      borderRadius: 4,
                      background: activeTemplate.badgeBg,
                      color: activeTemplate.badgeColor,
                      fontWeight: 700,
                    }}
                  >
                    {activeTemplate.badge}
                  </span>
                  <span style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--text-bright)' }}>
                    {activeTemplate.name}
                  </span>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.45 }}>
                  {activeTemplate.description}
                </div>
              </div>
            </div>

            {/* 项目名称输入 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)' }}>
                  {t('workspace.projectNameLabel')}
                </label>
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                  {t('workspace.projectNameHint')}
                </span>
              </div>
              <input
                type="text"
                className="wizard-form-input"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder={t('workspace.projectNamePh')}
                style={{
                  width: '100%',
                }}
              />
            </div>

            {/* 上级存储位置选择 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)' }}>
                  {t('workspace.parentDirLabel')}
                </label>
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                  {t('workspace.parentDirHint')}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="text"
                  className="wizard-form-input"
                  value={parentDir}
                  onChange={(e) => setParentDir(e.target.value)}
                  placeholder={t('workspace.parentDirPh')}
                  style={{
                    flex: 1,
                  }}
                />
                <button
                  type="button"
                  className="panel-standard-btn"
                  onClick={handlePickParentDir}
                  style={{ fontSize: 12, padding: '6px 14px', whiteSpace: 'nowrap' }}
                >
                  {t('workspace.browse')}
                </button>
              </div>
            </div>

            {/* 完整路径实时预览 */}
            <div
              style={{
                padding: '8px 12px',
                borderRadius: 8,
                background: 'rgba(255, 255, 255, 0.04)',
                border: '1px solid rgba(255, 255, 255, 0.12)',
                fontSize: 11.5,
                color: 'var(--text-bright)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                overflow: 'hidden',
              }}
            >
              <span style={{ flexShrink: 0 }}>📍</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={fullTargetPath}>
                {translateSegments('workspace.willGenerateAt', locale, {
                  path: fullTargetPath || t('workspace.pickParentAndName'),
                }).map((seg, i) =>
                  seg.emphasis ? (
                    <strong
                      key={i}
                      style={{ color: 'var(--accent-light, #3794ff)', fontFamily: 'var(--font-mono)' }}
                    >
                      {seg.text}
                    </strong>
                  ) : (
                    <span key={i}>{seg.text}</span>
                  ),
                )}
              </span>
            </div>

            {/* 文件结构预览 (Tree Preview) */}
            <div
              style={{
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--bg-panel)',
                padding: '10px 14px',
                flex: 1,
                minHeight: 120,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                fontSize: 11,
                fontFamily: 'var(--font-mono, monospace)',
                color: 'var(--text)',
                lineHeight: 1.6,
              }}
            >
              <div
                style={{
                  color: 'var(--muted)',
                  fontWeight: 600,
                  marginBottom: 6,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexShrink: 0,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span>📦</span>
                  <span>{t('workspace.scaffoldPreview')}</span>
                </div>
                <span
                  style={{
                    fontSize: 10,
                    padding: '1px 6px',
                    borderRadius: 4,
                    background: 'rgba(255, 255, 255, 0.06)',
                    color: 'var(--muted)',
                  }}
                >
                  {t('workspace.fileCount', { n: activeTemplate.files.length })}
                </span>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2, paddingRight: 4 }}>
                {activeTemplate.files.map((f) => (
                  <div
                    key={f.path}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '3px 6px',
                      borderRadius: 4,
                      background: 'rgba(255, 255, 255, 0.02)',
                    }}
                  >
                    <span style={{ opacity: 0.6, fontSize: 12 }}>{f.path.includes('/') ? '📁' : '📄'}</span>
                    <span
                      style={{
                        color:
                          f.path.includes('CMakeLists') || f.path.includes('pom.xml') || f.path.includes('package.json')
                            ? '#38bdf8'
                            : 'inherit',
                      }}
                    >
                      {f.path}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Footer 操作按钮栏：包含「在当前窗口打开」与「在新窗口打开」 */}
        <div
          style={{
            padding: '12px 20px',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: '#141414',
          }}
        >
          <button
            type="button"
            className="panel-standard-btn"
            onClick={onClose}
            style={{ fontSize: 12, padding: '6px 14px' }}
          >
            {t('workspace.cancel')}
          </button>

          <div style={{ display: 'flex', gap: 10 }}>
            <button
              type="button"
              className="panel-standard-btn"
              onClick={() => handleCreateAndOpen(false)}
              disabled={isCreating || !parentDir.trim() || !projectName.trim()}
              style={{ fontSize: 12, padding: '6px 14px' }}
              title={t('workspace.openHereTitle')}
            >
              {isCreating ? t('workspace.creating') : t('workspace.openHere')}
            </button>
            <button
              type="button"
              className="panel-standard-btn primary"
              onClick={() => handleCreateAndOpen(true)}
              disabled={isCreating || !parentDir.trim() || !projectName.trim()}
              style={{
                fontSize: 12,
                padding: '6px 18px',
                background: 'linear-gradient(135deg, #0284c7 0%, #2563eb 100%)',
                borderColor: '#0284c7',
                color: '#fff',
                fontWeight: 600,
                boxShadow: '0 4px 14px rgba(2, 132, 199, 0.35)',
              }}
              title={t('workspace.openNewTitle')}
            >
              {isCreating ? t('workspace.creating') : t('workspace.openNew')}
            </button>
          </div>
        </div>
        {/* 右下角全向拖拽手柄 */}
        <ModalResizeHandle onMouseDown={handleResizeStart} />
      </div>
    </div>,
    document.body,
  );
}

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import type { ChatSession, WorkspaceInfo } from '@deepseek-ide/shared';
import { folderNameFromPath } from '../../../utils';
import { isSessionMatchingWorkspace } from '../../SessionModal';
import { useDbConfirm, type DbConfirmHandle } from '../../../hooks/useDbConfirm';
import { buildSqlConfirmMarkdown } from '../../../services/dbConfirmContent';
import { useI18n } from '../../../i18n';

export interface UseProjectSessionsOptions {
  workspaceInfo?: WorkspaceInfo;
  confirm?: DbConfirmHandle;
  onSessionDeleted?: (id: string) => void;
}

export function useProjectSessions({
  workspaceInfo,
  confirm: externalConfirm,
  onSessionDeleted,
}: UseProjectSessionsOptions) {
  const { t } = useI18n();
  const internalConfirm = useDbConfirm();
  const confirm = externalConfirm ?? internalConfirm;
  const [projectSessions, setProjectSessions] = useState<ChatSession[]>([]);
  const [hasLoadedSessions, setHasLoadedSessions] = useState(false);
  const [showHistoryModal, setShowHistoryModal] = useState(false);

  const workspaceInfoRef = useRef(workspaceInfo);
  workspaceInfoRef.current = workspaceInfo;

  const currentProjectName = useMemo(() => {
    if (workspaceInfo?.root) return folderNameFromPath(workspaceInfo.root);
    return workspaceInfo?.label || '';
  }, [workspaceInfo?.root, workspaceInfo?.label]);

  const loadProjectSessions = useCallback(async (targetWs?: WorkspaceInfo) => {
    try {
      const list = await window.ide.listSessions();
      if (!Array.isArray(list)) {
        setProjectSessions([]);
        setHasLoadedSessions(true);
        return;
      }
      const currentWs = targetWs ?? workspaceInfoRef.current;
      // 只有在明确打开了工作区时才筛选项目会话；若当前无工作区则不显示项目历史
      if (!currentWs?.root) {
        setProjectSessions([]);
        setHasLoadedSessions(true);
        return;
      }
      const matching = list.filter((s) => {
        if (!isSessionMatchingWorkspace(s, currentWs)) return false;
        const validMsgs = s.messages?.filter((m) => m.role === 'user' || m.role === 'assistant');
        return Boolean(validMsgs && validMsgs.length > 0);
      });
      matching.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      setProjectSessions(matching);
    } catch (err) {
      console.warn('Failed to load project sessions', err);
    } finally {
      setHasLoadedSessions(true);
    }
  }, []);

  useEffect(() => {
    void loadProjectSessions(workspaceInfo);
  }, [workspaceInfo?.root, workspaceInfo?.label, loadProjectSessions]);

  useEffect(() => {
    if (!showHistoryModal) {
      void loadProjectSessions();
    }
  }, [showHistoryModal, loadProjectSessions]);

  const handleDeleteProjectSession = useCallback(
    async (id: string, title?: string) => {
      const target = projectSessions.find((s) => s.id === id);
      const sessionTitle = title?.trim() || target?.title?.trim() || t('session.untitled');
      const ok = await confirm.confirm({
        title: t('session.deleteTitle'),
        content: buildSqlConfirmMarkdown({
          t,
          intro: t('chat.deleteSessionConfirm', { title: sessionTitle }),
          statements: [],
        }),
        details: [
          { label: t('session.labelTitle'), value: sessionTitle },
          {
            label: t('session.labelTurns'),
            value: t('session.turnsCount', {
              n: target?.messageCount ?? target?.messages?.length ?? 0,
            }),
          },
        ],
        tone: 'danger',
        confirmLabel: t('session.confirmDelete'),
      });
      if (ok === null) return;
      try {
        setProjectSessions((prev) => prev.filter((s) => s.id !== id));
        await window.ide.deleteSession(id);
        onSessionDeleted?.(id);
        void loadProjectSessions();
      } catch (err) {
        console.error('Failed to delete session', err);
      }
    },
    [confirm, t, projectSessions, onSessionDeleted, loadProjectSessions],
  );

  return {
    projectSessions,
    hasLoadedSessions,
    currentProjectName,
    loadProjectSessions,
    handleDeleteProjectSession,
    showHistoryModal,
    setShowHistoryModal,
    confirmModal: internalConfirm.modal,
  };
}

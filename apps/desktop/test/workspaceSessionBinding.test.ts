import { describe, it, expect } from 'vitest';
import type { ChatSession, WorkspaceInfo } from '@deepseek-ide/shared';
import {
  isSessionMatchingWorkspace,
  isSessionMatchingProject,
  collectAvailableProjects,
} from '../src/renderer/src/components/SessionModal';
import {
  AUTO_SESSION_TITLE_FALLBACK,
  DEFAULT_SESSION_TITLE,
  isCustomSessionTitle,
} from '../src/renderer/src/utils';
import { DICT, translate, translateWith, type Translate } from '../src/renderer/src/i18n';

// collectAvailableProjects 的 t 是必填的（两个兜底项目名会直接显示在下拉里），
// 测试自己带一份 zh 的 t，不依赖语言环境
const t: Translate = (key, params) =>
  params ? translateWith(key, 'zh', params) : translate(key, 'zh');

describe('AI Chat Session Workspace Binding (isSessionMatchingWorkspace)', () => {
  const currentLocalWs: WorkspaceInfo = {
    root: '/Users/danielcraig/Documents/Claude-demo/Echoly',
    kind: 'local',
    label: '/Users/danielcraig/Documents/Claude-demo/Echoly',
  };

  const currentSshWs: WorkspaceInfo = {
    root: '/var/www/my-project',
    kind: 'ssh',
    label: 'ssh root@192.168.1.100:/var/www/my-project',
  };

  it('matches session with exact local workspacePath', () => {
    const session: ChatSession = {
      id: 'session-1',
      title: 'Fix issue',
      messages: [],
      updatedAt: Date.now(),
      workspacePath: '/Users/danielcraig/Documents/Claude-demo/Echoly',
      projectName: 'Echoly',
      workspaceKind: 'local',
    };

    expect(isSessionMatchingWorkspace(session, currentLocalWs)).toBe(true);
  });

  it('normalizes slashes, trailing slashes, and case when matching local workspace', () => {
    const session: ChatSession = {
      id: 'session-2',
      title: 'Refactor code',
      messages: [],
      updatedAt: Date.now(),
      workspacePath: '/Users/danielcraig/Documents/Claude-demo/Echoly/',
      projectName: 'Echoly',
      workspaceKind: 'local',
    };

    expect(isSessionMatchingWorkspace(session, currentLocalWs)).toBe(true);
  });

  it('rejects session belonging to a completely different project', () => {
    const otherSession: ChatSession = {
      id: 'session-other',
      title: 'Other project chat',
      messages: [],
      updatedAt: Date.now(),
      workspacePath: '/Users/danielcraig/Documents/OtherProject',
      projectName: 'OtherProject',
      workspaceKind: 'local',
    };

    expect(isSessionMatchingWorkspace(otherSession, currentLocalWs)).toBe(false);
  });

  it('matches SSH session by label or remote root', () => {
    const sshSession1: ChatSession = {
      id: 'session-ssh-1',
      title: 'SSH remote task',
      messages: [],
      updatedAt: Date.now(),
      workspacePath: 'ssh root@192.168.1.100:/var/www/my-project',
      projectName: 'my-project',
      workspaceKind: 'ssh',
    };

    const sshSession2: ChatSession = {
      id: 'session-ssh-2',
      title: 'SSH remote task root only',
      messages: [],
      updatedAt: Date.now(),
      workspacePath: '/var/www/my-project',
      projectName: 'my-project',
      workspaceKind: 'ssh',
    };

    expect(isSessionMatchingWorkspace(sshSession1, currentSshWs)).toBe(true);
    expect(isSessionMatchingWorkspace(sshSession2, currentSshWs)).toBe(true);
    expect(isSessionMatchingWorkspace(sshSession1, currentLocalWs)).toBe(false);
  });

  it('matches session by projectName if workspacePath is relative or missing', () => {
    const legacySession: ChatSession = {
      id: 'session-legacy',
      title: 'Legacy conversation',
      messages: [],
      updatedAt: Date.now(),
      projectName: 'Echoly',
    };

    expect(isSessionMatchingWorkspace(legacySession, currentLocalWs)).toBe(true);
    expect(isSessionMatchingWorkspace(legacySession, currentSshWs)).toBe(false);
  });

  it('returns true when no workspace is open (allowing users to view all)', () => {
    const anySession: ChatSession = {
      id: 'session-any',
      title: 'Any session',
      messages: [],
      updatedAt: Date.now(),
      workspacePath: '/any/path',
    };

    expect(isSessionMatchingWorkspace(anySession, null)).toBe(true);
    expect(isSessionMatchingWorkspace(anySession, undefined)).toBe(true);
  });

  it('collectAvailableProjects includes projects with 0 sessions and ranks current project first', () => {
    const mockSessions: ChatSession[] = [
      {
        id: 's1',
        title: 'Session in Echoly',
        messages: [],
        updatedAt: Date.now(),
        workspacePath: '/Users/danielcraig/Documents/Claude-demo/Echoly',
        projectName: 'Echoly',
      },
    ];

    const mockRecents = [
      { path: '/Users/danielcraig/Documents/Claude-demo/Echoly', name: 'Echoly', lastOpenedAt: 1 },
      {
        path: '/Users/danielcraig/Documents/Claude-demo/ZeroSessionProject',
        name: 'ZeroSessionProject',
        lastOpenedAt: 2,
      },
      {
        path: '/Users/danielcraig/Documents/Claude-demo/AnotherEmptyProject',
        name: 'AnotherEmptyProject',
        lastOpenedAt: 3,
      },
    ];

    const projects = collectAvailableProjects(currentLocalWs, mockRecents, mockSessions, t);

    // Current project is top
    expect(projects[0].name).toBe('Echoly');
    expect(projects[0].isCurrent).toBe(true);
    expect(projects[0].count).toBe(1);

    // Zero-session projects must be included
    const zeroProj = projects.find((p: any) => p.name === 'ZeroSessionProject');
    expect(zeroProj).toBeDefined();
    expect(zeroProj!.count).toBe(0);

    const emptyProj = projects.find((p: any) => p.name === 'AnotherEmptyProject');
    expect(emptyProj).toBeDefined();
    expect(emptyProj!.count).toBe(0);

    // Matching project works correctly
    expect(isSessionMatchingProject(mockSessions[0], { name: 'Echoly' })).toBe(true);
    expect(isSessionMatchingProject(mockSessions[0], { name: 'ZeroSessionProject' })).toBe(false);
  });

  it('deduplicates project items with different path representations or same project name', () => {
    const mockRemoteWs: WorkspaceInfo = {
      root: '/root/vision-search-system',
      label: '192.168.10.208: /root/vision-search-system',
      // 远程性由 kind 表达；这个 fixture 只用到 root / label，kind 取 ssh 更贴近真实
      kind: 'ssh',
    };

    const mockRecents = [
      // 包含 ssh: 前缀与不带前缀的同名工作区
      {
        path: 'ssh://192.168.10.208/root/vision-search-system',
        name: 'vision-search-system',
        lastOpenedAt: 1,
      },
      {
        path: 'ssh://192.168.10.208/root/security-vision-system',
        name: 'security-vision-system',
        lastOpenedAt: 2,
      },
      {
        path: '/Users/daniel/tsingtec_data_platform',
        name: 'tsingtec_data_platform',
        lastOpenedAt: 3,
      },
      { path: '/Users/daniel/tsingtec', name: 'tsingtec', lastOpenedAt: 4 },
    ];

    const mockSessions: ChatSession[] = [
      // vision-search-system 相关的 2 个会话（路径不同或缺少路径）
      {
        id: 's1',
        title: 'VSS会话1',
        messages: [],
        updatedAt: Date.now(),
        workspacePath: '/root/vision-search-system',
        projectName: 'vision-search-system',
      },
      // security-vision-system 相关的 3 个会话（有的带路径，有的只有名字）
      {
        id: 's2',
        title: 'SVS会话1',
        messages: [],
        updatedAt: Date.now(),
        workspacePath: '/root/security-vision-system',
        projectName: 'security-vision-system',
      },
      {
        id: 's3',
        title: 'SVS会话2',
        messages: [],
        updatedAt: Date.now(),
        workspacePath: 'ssh://192.168.10.208/root/security-vision-system',
        projectName: 'security-vision-system',
      },
      {
        id: 's4',
        title: 'SVS会话3',
        messages: [],
        updatedAt: Date.now(),
        projectName: 'security-vision-system',
      },
      {
        id: 's5',
        title: '标注平台会话',
        messages: [],
        updatedAt: Date.now(),
        workspacePath: '/Users/daniel/tsingtec_data_platform',
        projectName: 'tsingtec_data_platform',
      },
    ];

    const projects = collectAvailableProjects(mockRemoteWs, mockRecents, mockSessions, t);

    // 检查项目名称列表，确保没有任何重复名称
    const names = projects.map((p) => p.name);
    const uniqueNames = Array.from(new Set(names.map((n) => n.toLowerCase())));
    expect(names.length).toBe(uniqueNames.length);

    // 验证当前项目置顶且唯一
    expect(projects[0].name).toBe('vision-search-system');
    expect(projects[0].isCurrent).toBe(true);
    expect(projects[0].count).toBe(1);

    // 验证 security-vision-system 唯一且正确聚合了 3 条会话
    const svsProjects = projects.filter((p) => p.name.toLowerCase() === 'security-vision-system');
    expect(svsProjects.length).toBe(1);
    expect(svsProjects[0].count).toBe(3);

    // 验证 tsingtec_data_platform 唯一且会话为 1 条
    const dataPlatform = projects.filter((p) => p.name.toLowerCase() === 'tsingtec_data_platform');
    expect(dataPlatform.length).toBe(1);
    expect(dataPlatform[0].count).toBe(1);

    // 验证 0 会话的 tsingtec 也正常保留且唯一
    const tsingtec = projects.filter((p) => p.name.toLowerCase() === 'tsingtec');
    expect(tsingtec.length).toBe(1);
    expect(tsingtec[0].count).toBe(0);
  });

  describe('Session Custom Title Preservation & Reopen Safety', () => {
    it('infers isCustom = true when title differs from first user message snippet', () => {
      const firstUserSnippet = 'Can you help me diagnose App.tsx';
      const customTitle = '修复 App.tsx 错误';

      // 走真实实现（原先这里把判定逻辑抄了一遍，改实现时测试不会跟着变）
      expect(isCustomSessionTitle(customTitle, firstUserSnippet)).toBe(true);
    });

    it('infers isCustom = false when title is exactly first user message snippet', () => {
      const firstUserSnippet = 'Can you help me diagnose App.tsx';
      const autoTitle = 'Can you help me diagnose App.tsx';

      expect(isCustomSessionTitle(autoTitle, firstUserSnippet)).toBe(false);
    });

    it('preserves custom title and does not overwrite with prompt on subsequent user questions', () => {
      const activeTab = {
        title: '我的重构计划',
        customTitle: true,
        messages: [{ role: 'user', content: '原始问题' }],
      };

      const subsequentPrompt = '接下来请开始执行第二步';

      const firstUser = activeTab.messages.find((m) => m.role === 'user');
      const firstUserSnippet = firstUser ? firstUser.content.slice(0, 40) : '';
      const isCustom = isCustomSessionTitle(
        activeTab.title,
        firstUserSnippet,
        activeTab.customTitle,
      );

      const newTitle = isCustom
        ? activeTab.title
        : activeTab.messages.length === 0
          ? subsequentPrompt.slice(0, 40)
          : activeTab.title;

      expect(isCustom).toBe(true);
      expect(newTitle).toBe('我的重构计划');
    });

    it('历史默认标题被认成「自动标题」——它们是落盘哨兵，不是文案', () => {
      // 这三个值会随会话落盘，跨版本跨语言都还在。它们一旦被当成文案翻掉，
      // 存量会话的 isCustom 判定会全部翻成「用户改过的」，表现是标题不再自动更新。
      for (const auto of ['New Chat', '当前对话', '对话']) {
        expect(isCustomSessionTitle(auto, '随便一句用户消息')).toBe(false);
      }
      // 反过来：用户真写了别的标题就得认出来，别把判定做成恒假
      expect(isCustomSessionTitle('我自己的标题', '随便一句用户消息')).toBe(true);
    });

    it('哨兵值与字典里的展示文案保持一致', () => {
      // 这条是**耦合声明**：字典里的 chat.titleCurrent / chat.titleDefault 是同一批
      // 中文的展示形态，哨兵是它们的落盘形态。刻意让它们相等，是为了让「顺手把
      // 中文改成英文」这个改动在测试里立刻炸掉，而不是安静地推翻存量数据。
      expect(DEFAULT_SESSION_TITLE).toBe(DICT['chat.titleCurrent'].zh);
      expect(AUTO_SESSION_TITLE_FALLBACK).toBe(DICT['chat.titleDefault'].zh);
    });
  });
});

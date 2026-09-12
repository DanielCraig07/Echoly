import React, { useState, useEffect, useCallback, useMemo } from 'react';
import type { WorkspaceInfo, MavenEnvironmentInfo } from '@deepseek-ide/shared';
import { loadEnvConfig, saveEnvConfig, type EnvConfig } from './EnvironmentSettingsSection';
import { EnvironmentConfigModal } from './EnvironmentConfigModal';

export interface MavenPanelProps {
  workspaceInfo?: WorkspaceInfo | null;
  onOpenFile?: (filePath: string) => void;
  onRunCommand: (command: string, cwd?: string, terminalType?: string, terminalTitle?: string) => void;
  onShowToast?: (message: string, type?: 'info' | 'error' | 'success') => void;
  onOpenSettings?: (tab?: 'environment' | string) => void;
}

export interface MavenDependency {
  groupId: string;
  artifactId: string;
  version?: string;
  scope?: string;
}

export interface MavenPlugin {
  groupId?: string;
  artifactId: string;
  version?: string;
  goals?: string[];
}

export interface MavenModule {
  name: string;
  artifactId: string;
  groupId?: string;
  version?: string;
  packaging?: string;
  pomPath: string;
  dirPath: string;
  isRoot: boolean;
  isSpringBoot: boolean;
  profiles: string[];
  subModules: string[];
  dependencies: MavenDependency[];
  plugins: MavenPlugin[];
}

export interface MavenLifecycleGoal {
  name: string;
  description: string;
  goal: string;
}

const MAVEN_LIFECYCLE_GOALS: MavenLifecycleGoal[] = [
  { name: 'clean', goal: 'clean', description: '清理上一次构建生成的文件 (target 目录)' },
  { name: 'validate', goal: 'validate', description: '验证项目是否正确且所有必要信息可用' },
  { name: 'compile', goal: 'compile', description: '编译项目的源代码' },
  { name: 'test', goal: 'test', description: '运行单元测试框架编译与测试' },
  { name: 'package', goal: 'package', description: '将编译好的代码打包成可分发的格式 (jar/war)' },
  { name: 'verify', goal: 'verify', description: '运行检查以验证包是否有效且符合质量标准' },
  { name: 'install', goal: 'install', description: '将包安装到本地 Maven 仓库，供其他项目依赖' },
  { name: 'site', goal: 'site', description: '生成项目的站点说明文档' },
  { name: 'deploy', goal: 'deploy', description: '将最终的包复制到远程仓库以共享' },
];



function parsePomXml(content: string, pomPath: string): MavenModule {
  const dirPath = pomPath.includes('/') ? pomPath.substring(0, pomPath.lastIndexOf('/')) : '.';
  const isRoot = pomPath === 'pom.xml';

  const artifactIdMatch = content.match(/<artifactId>([^<]+)<\/artifactId>/);
  const artifactId = artifactIdMatch ? artifactIdMatch[1].trim() : pomPath.replace(/\/pom\.xml$/, '');
  const groupIdMatch = content.match(/<groupId>([^<]+)<\/groupId>/);
  const groupId = groupIdMatch ? groupIdMatch[1].trim() : undefined;
  const versionMatch = content.match(/<version>([^<]+)<\/version>/);
  const version = versionMatch ? versionMatch[1].trim() : undefined;
  const packagingMatch = content.match(/<packaging>([^<]+)<\/packaging>/);
  const packaging = packagingMatch ? packagingMatch[1].trim() : 'jar';
  const nameMatch = content.match(/<name>([^<]+)<\/name>/);
  const name = nameMatch ? nameMatch[1].trim() : artifactId;

  const isSpringBoot =
    /spring-boot-maven-plugin/i.test(content) ||
    /spring-boot-starter/i.test(content) ||
    /org\.springframework\.boot/i.test(content);

  const profiles: string[] = [];
  const profileBlockRegex = /<profile>([\s\S]*?)<\/profile>/g;
  let pMatch: RegExpExecArray | null;
  while ((pMatch = profileBlockRegex.exec(content)) !== null) {
    const idMatch = pMatch[1].match(/<id>([^<]+)<\/id>/);
    if (idMatch && idMatch[1].trim()) profiles.push(idMatch[1].trim());
  }

  const subModules: string[] = [];
  const modulesBlockMatch = content.match(/<modules>([\s\S]*?)<\/modules>/);
  if (modulesBlockMatch) {
    const moduleRegex = /<module>([^<]+)<\/module>/g;
    let mMatch: RegExpExecArray | null;
    while ((mMatch = moduleRegex.exec(modulesBlockMatch[1])) !== null) {
      if (mMatch[1].trim()) subModules.push(mMatch[1].trim());
    }
  }

  const dependencies: MavenDependency[] = [];
  const depBlockMatch = content.match(/<dependencies>([\s\S]*?)<\/dependencies>/);
  if (depBlockMatch) {
    const depRegex = /<dependency>([\s\S]*?)<\/dependency>/g;
    let dMatch: RegExpExecArray | null;
    while ((dMatch = depRegex.exec(depBlockMatch[1])) !== null) {
      const g = dMatch[1].match(/<groupId>([^<]+)<\/groupId>/)?.[1]?.trim();
      const a = dMatch[1].match(/<artifactId>([^<]+)<\/artifactId>/)?.[1]?.trim();
      const v = dMatch[1].match(/<version>([^<]+)<\/version>/)?.[1]?.trim();
      const s = dMatch[1].match(/<scope>([^<]+)<\/scope>/)?.[1]?.trim();
      if (a && g) dependencies.push({ groupId: g, artifactId: a, version: v, scope: s });
    }
  }

  const plugins: MavenPlugin[] = [];
  const pluginsBlockMatch = content.match(/<plugins>([\s\S]*?)<\/plugins>/);
  if (pluginsBlockMatch) {
    const plugRegex = /<plugin>([\s\S]*?)<\/plugin>/g;
    let plMatch: RegExpExecArray | null;
    while ((plMatch = plugRegex.exec(pluginsBlockMatch[1])) !== null) {
      const g = plMatch[1].match(/<groupId>([^<]+)<\/groupId>/)?.[1]?.trim();
      const a = plMatch[1].match(/<artifactId>([^<]+)<\/artifactId>/)?.[1]?.trim();
      const v = plMatch[1].match(/<version>([^<]+)<\/version>/)?.[1]?.trim();
      if (a) plugins.push({ groupId: g, artifactId: a, version: v });
    }
  }

  if (plugins.length === 0) {
    plugins.push(
      { artifactId: 'clean', goals: ['clean'] },
      { artifactId: 'compiler', goals: ['compile', 'testCompile'] },
      { artifactId: 'surefire', goals: ['test'] },
      { artifactId: 'jar', goals: ['jar'] },
      { artifactId: 'resources', goals: ['resources', 'testResources'] },
      { artifactId: 'install', goals: ['install'] },
      { artifactId: 'deploy', goals: ['deploy'] },
    );
    if (isSpringBoot) {
      plugins.unshift({ groupId: 'org.springframework.boot', artifactId: 'spring-boot', goals: ['run', 'repackage'] });
    }
  }

  return { name, artifactId, groupId, version, packaging, pomPath, dirPath, isRoot, isSpringBoot, profiles, subModules, dependencies, plugins };
}

// ── Sleek Monochrome Vector Icons (Matching Git Header Standard) ──────

const IconReload = ({ spinning }: { spinning?: boolean }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ animation: spinning ? 'spin 0.9s linear infinite' : undefined, flexShrink: 0 }}
  >
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <polyline points="21 3 21 9 15 9" />
  </svg>
);

const IconPlay = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="currentColor"
    style={{ flexShrink: 0 }}
  >
    <path d="M6 4.5v15a1 1 0 0 0 1.52.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 6 4.5z" />
  </svg>
);

const IconTerminal = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ flexShrink: 0 }}
  >
    <rect x="2" y="3" width="20" height="18" rx="3.5" />
    <polyline points="6 9 10 12 6 15" />
    <line x1="12" y1="15" x2="17" y2="15" />
  </svg>
);

const IconSkipTest = ({ active }: { active?: boolean }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ flexShrink: 0 }}
  >
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill={active ? 'currentColor' : 'none'} />
    <line x1="2" y1="22" x2="22" y2="2" strokeWidth="2.2" />
  </svg>
);

const IconSettings = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ flexShrink: 0 }}
  >
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

const IconExpandAll = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ flexShrink: 0 }}
  >
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const IconCollapseAll = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ flexShrink: 0 }}
  >
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const ProjectIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" stroke="#f43f5e" strokeWidth="1.8" />
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" fill="#881337" stroke="#f43f5e" strokeWidth="1.6" />
    <path d="M10 2v7l2.5-1.5L15 9V2" fill="#fbbf24" />
  </svg>
);

const FolderGearIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
    <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z" fill="#0891b2" fillOpacity="0.25" stroke="#06b6d4" strokeWidth="1.4" />
    <circle cx="16" cy="15" r="3.5" fill="#0e7490" stroke="#67e8f9" strokeWidth="1" />
    <circle cx="16" cy="15" r="1.3" fill="#0f172a" />
  </svg>
);

const FolderPackageIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
    <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z" fill="#0284c7" fillOpacity="0.22" stroke="#38bdf8" strokeWidth="1.4" />
    <rect x="13" y="12" width="5.5" height="5.5" rx="1" fill="#f59e0b" stroke="#fde68a" strokeWidth="0.8" />
  </svg>
);

// ── TreeNode Component ────────────────────────────────────────────────────────

interface TreeNodeProps {
  label: string;
  icon: React.ReactNode;
  badge?: string;
  badgeColor?: string;
  collapsed: boolean;
  onToggle: () => void;
  depth: number;
  children?: React.ReactNode;
}

function TreeNode({ label, icon, badge, badgeColor = 'var(--muted)', collapsed, onToggle, depth, children }: TreeNodeProps) {
  return (
    <div>
      <div
        onClick={onToggle}
        className="tree-item-hover"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: `4px 6px 4px ${depth === 0 ? 6 : 20}px`,
          cursor: 'pointer',
          borderRadius: 4,
          margin: '1px 4px',
        }}
      >
        <span style={{ width: 12, fontSize: 10, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          {collapsed ? '▸' : '▾'}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>{icon}</span>
        <span style={{
          fontSize: depth === 0 ? 13 : 12.5,
          fontWeight: depth === 0 ? 600 : 500,
          color: 'var(--text-bright, #ffffff)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {label}
        </span>
        {badge && (
          <span style={{ fontSize: 10.5, color: badgeColor, fontWeight: 500, flexShrink: 0 }}>
            {badge}
          </span>
        )}
      </div>
      {!collapsed && <div>{children}</div>}
    </div>
  );
}

const PluginGearIcon = () => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ color: 'var(--muted)', flexShrink: 0, opacity: 0.85 }}
  >
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

const DependencyPackageIcon = () => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ color: '#38bdf8', flexShrink: 0, opacity: 0.85 }}
  >
    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
    <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
    <line x1="12" y1="22.08" x2="12" y2="12" />
  </svg>
);

// ── PluginItem Component ──────────────────────────────────────────────────────

function PluginItem({ name, version, onClick, color }: { name: string; version?: string; onClick: () => void; color?: string }) {
  return (
    <div
      onClick={onClick}
      className="search-result-item"
      title={`运行插件: ${name}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '3px 6px 3px 32px',
        borderRadius: 4,
        cursor: 'pointer',
        margin: '1px 4px',
        fontSize: 12.5,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, overflow: 'hidden' }}>
        <PluginGearIcon />
        <span style={{ color: color || 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
      </div>
      {version && <span style={{ fontSize: 10.5, color: 'var(--muted)', flexShrink: 0 }}>{version}</span>}
    </div>
  );
}

// ── Main MavenPanel Component ─────────────────────────────────────────────────

export function MavenPanel({ workspaceInfo, onOpenFile, onRunCommand, onShowToast, onOpenSettings }: MavenPanelProps) {
  const workspace = workspaceInfo?.root;
  const [loading, setLoading] = useState(false);
  const [modules, setModules] = useState<MavenModule[]>([]);
  const [hasMvnw, setHasMvnw] = useState(false);
  const [hasProjectSettingsXml, setHasProjectSettingsXml] = useState(false);
  const [skipTests, setSkipTests] = useState(false);
  const [activeProfiles, setActiveProfiles] = useState<Set<string>>(new Set());
  const [selectedModulePath, setSelectedModulePath] = useState<string>('pom.xml');
  const [selectedGoal, setSelectedGoal] = useState<string>('clean');
  const [customGoalInputOpen, setCustomGoalInputOpen] = useState(false);
  const [customGoalText, setCustomGoalText] = useState('');
  const [generatingWrapper, setGeneratingWrapper] = useState(false);
  const [mavenEnv, setMavenEnv] = useState<MavenEnvironmentInfo | null>(null);
  const [envModalOpen, setEnvModalOpen] = useState(false);
  const [envConfig, setEnvConfig] = useState<EnvConfig>(() => loadEnvConfig(workspace || undefined));

  useEffect(() => {
    setEnvConfig(loadEnvConfig(workspace || undefined));
  }, [workspace]);

  const [collapsedNodes, setCollapsedNodes] = useState<Record<string, boolean>>({
    project: false, lifecycle: false, plugins: true, dependencies: true,
  });

  const toggleNode = (nodeId: string) => setCollapsedNodes((prev) => ({ ...prev, [nodeId]: !prev[nodeId] }));
  const expandAll = () => setCollapsedNodes({ project: false, lifecycle: false, plugins: false, dependencies: false });
  const collapseAll = () => setCollapsedNodes({ project: false, lifecycle: true, plugins: true, dependencies: true });

  const checkMavenEnv = useCallback(async () => {
    try {
      if (window.ide.mavenCheckEnv) {
        const env = await window.ide.mavenCheckEnv();
        setMavenEnv(env);
        if (env.type === 'wrapper') setHasMvnw(true);
      }
    } catch (e) {
      console.error('Failed to check Maven environment:', e);
    }
  }, []);

  const scanMavenProjects = useCallback(async () => {
    if (!workspaceInfo?.root) { setModules([]); return; }
    setLoading(true);
    try {
      await checkMavenEnv();
      const hasRootPom = await window.ide.pathExists('pom.xml');
      if (!hasRootPom) { setModules([]); setLoading(false); return; }

      const isWin = navigator.userAgent.includes('Windows');
      const [existsWrapper, existsSettings] = await Promise.all([
        window.ide.pathExists(isWin ? 'mvnw.cmd' : 'mvnw'),
        window.ide.pathExists('.mvn/settings.xml'),
      ]);
      setHasMvnw(existsWrapper);
      setHasProjectSettingsXml(existsSettings);

      const rootPomContent = await window.ide.readFile('pom.xml');
      if (!rootPomContent) { setModules([]); setLoading(false); return; }

      const rootModule = parsePomXml(rootPomContent, 'pom.xml');
      const loadedModules: MavenModule[] = [rootModule];

      for (const sub of rootModule.subModules) {
        const subPomPath = `${sub}/pom.xml`;
        try {
          if (await window.ide.pathExists(subPomPath)) {
            const subContent = await window.ide.readFile(subPomPath);
            if (subContent) loadedModules.push(parsePomXml(subContent, subPomPath));
          }
        } catch { /* ignore */ }
      }

      setModules(loadedModules);
      if (loadedModules.length > 0 && !loadedModules.some((m) => m.pomPath === selectedModulePath)) {
        setSelectedModulePath(loadedModules[0].pomPath);
      }
    } catch (e) {
      console.error('Failed to scan Maven projects:', e);
      onShowToast?.('扫描 Maven 项目失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [workspaceInfo, onShowToast, selectedModulePath, checkMavenEnv]);

  useEffect(() => { void scanMavenProjects(); }, [scanMavenProjects]);

  const handleInitWrapper = async () => {
    setGeneratingWrapper(true);
    try {
      if (window.ide.mavenInitWrapper) {
        const res = await window.ide.mavenInitWrapper();
        if (res.success) {
          onShowToast?.(res.message || '已成功生成 Maven Wrapper (mvnw)', 'success');
          setHasMvnw(true);
          await scanMavenProjects();
        } else {
          onShowToast?.(res.message || '生成 Maven Wrapper 失败', 'error');
        }
      } else {
        onShowToast?.('当前环境不支持自动生成 Wrapper', 'error');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      onShowToast?.(`生成失败: ${msg}`, 'error');
    } finally {
      setGeneratingWrapper(false);
    }
  };

  const currentModule = useMemo(
    () => modules.find((m) => m.pomPath === selectedModulePath) || modules[0] || null,
    [modules, selectedModulePath],
  );

  const effectiveMvnExe = useMemo(() => {
    if (envConfig.customMvnPath) return envConfig.customMvnPath;
    const isWin = navigator.userAgent.includes('Windows');
    if (hasMvnw || mavenEnv?.type === 'wrapper') return isWin ? '.\\mvnw.cmd' : './mvnw';
    if (mavenEnv?.executablePath) return mavenEnv.executablePath;
    return 'mvn';
  }, [envConfig, hasMvnw, mavenEnv]);

  const buildCommand = useCallback(
    (goal: string, targetModule?: MavenModule): { command: string; cwd?: string } => {
      const module = targetModule || currentModule || modules[0];
      const isWin = navigator.userAgent.includes('Windows');
      const parts: string[] = [];

      // 关键：若选定了 Java 版本，前置导出 JAVA_HOME 确保构建在该版本下执行
      if (envConfig.selectedJavaHome) {
        if (!isWin) {
          parts.push(`export JAVA_HOME="${envConfig.selectedJavaHome}" &&`);
        }
      }

      parts.push(effectiveMvnExe);
      if (activeProfiles.size > 0) parts.push(`-P${Array.from(activeProfiles).join(',')}`);
      if (skipTests && (goal.includes('package') || goal.includes('install') || goal.includes('verify') || goal.includes('compile') || goal === 'clean')) {
        parts.push('-DskipTests');
      }
      // 如果指定了自定义 settings.xml 或项目包含 .mvn/settings.xml，传入 -s 参数
      if (envConfig.customSettingsPath) {
        parts.push(`-s "${envConfig.customSettingsPath}"`);
      } else if (hasProjectSettingsXml) {
        parts.push('-s .mvn/settings.xml');
      }
      parts.push(goal);

      let cmd = parts.join(' ');
      if (module && !module.isRoot) {
        cmd = `${cmd} -pl ${module.dirPath} -am`;
      }

      if (envConfig.selectedJavaHome && isWin) {
        cmd = `set "JAVA_HOME=${envConfig.selectedJavaHome}" && ${cmd}`;
      }

      return { command: cmd };
    },
    [currentModule, modules, effectiveMvnExe, envConfig, activeProfiles, skipTests],
  );

  const executeGoal = (goal: string, targetModule?: MavenModule) => {
    setSelectedGoal(goal);
    const { command, cwd } = buildCommand(goal, targetModule);
    onRunCommand(command, cwd, 'mvn', 'Maven');
    onShowToast?.(`已启动: ${command}`, 'info');
  };

  const executeSelectedGoal = () => executeGoal(selectedGoal || 'clean compile', currentModule || undefined);

  const toggleProfile = (profileId: string) => {
    setActiveProfiles((prev) => {
      const next = new Set(prev);
      if (next.has(profileId)) next.delete(profileId); else next.add(profileId);
      return next;
    });
  };

  const allProfiles = useMemo(() => {
    const set = new Set<string>();
    modules.forEach((m) => m.profiles.forEach((p) => set.add(p)));
    return Array.from(set);
  }, [modules]);

  const projectRootName = useMemo(() => {
    if (modules.length > 0) {
      const root = modules.find((m) => m.isRoot) || modules[0];
      return root.name || root.artifactId;
    }
    if (workspaceInfo?.label) return workspaceInfo.label;
    if (workspaceInfo?.root) {
      const parts = workspaceInfo.root.split(/[/\\]/);
      return parts[parts.length - 1] || 'Maven Project';
    }
    return 'Maven Project';
  }, [modules, workspaceInfo]);

  const envStatus = useMemo(() => {
    if (envConfig.customMvnPath) return { label: '自定义 mvn', color: '#60a5fa' };
    if (hasMvnw || mavenEnv?.type === 'wrapper') return { label: 'mvnw', color: '#34d399' };
    if (mavenEnv?.available) return { label: '系统 mvn', color: '#a3e635' };
    return { label: '未配置', color: '#f87171' };
  }, [envConfig, hasMvnw, mavenEnv]);

  return (
    <div className="maven-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%', background: 'var(--bg-panel)', color: 'var(--text)', fontSize: 13, userSelect: 'none', overflow: 'hidden', position: 'relative' }}>

      {/* ── Header: Height 30px, Typography & Actions Unified with Explorer/Search/Git ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 30, padding: '0 10px', boxSizing: 'border-box', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: 'var(--text)',
            letterSpacing: '0.05em',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <span className="chevron" style={{ fontSize: 12, color: 'var(--muted)' }}>
            ▾
          </span>{' '}
          Maven
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button type="button" className="panel-action-btn" title="重新扫描 Maven 项目" onClick={() => void scanMavenProjects()}>
            <IconReload spinning={loading} />
          </button>
          <button type="button" className="panel-action-btn" title={`运行目标: ${selectedGoal || 'clean'}`} onClick={executeSelectedGoal}>
            <IconPlay />
          </button>
          <button type="button" className={`panel-action-btn${customGoalInputOpen ? ' active' : ''}`} title="执行自定义 Maven 目标" onClick={() => setCustomGoalInputOpen((v) => !v)}>
            <IconTerminal />
          </button>
          <button type="button" className={`panel-action-btn${skipTests ? ' active' : ''}`} title={skipTests ? '已开启跳过测试 (-DskipTests)' : '跳过测试 (-DskipTests)'} onClick={() => { const n = !skipTests; setSkipTests(n); onShowToast?.(n ? '已开启跳过测试' : '已关闭跳过测试', 'info'); }}>
            <IconSkipTest active={skipTests} />
          </button>
          <button type="button" className="panel-action-btn" title="全部展开" onClick={expandAll}>
            <IconExpandAll />
          </button>
          <button type="button" className="panel-action-btn" title="全部折叠" onClick={collapseAll}>
            <IconCollapseAll />
          </button>

          {/* Global Environment Configuration Trigger Button */}
          <button
            type="button"
            className="panel-action-btn"
            title={`环境配置 (${envStatus.label}${envConfig.selectedJavaLabel ? ` · ${envConfig.selectedJavaLabel}` : ''})`}
            onClick={() => {
              if (onOpenSettings) onOpenSettings('environment');
              else setEnvModalOpen(true);
            }}
          >
            <IconSettings />
          </button>
        </div>
      </div>

      {/* ── Custom goal input ── */}
      {customGoalInputOpen && (
        <div style={{ padding: '6px 8px', background: 'var(--bg-input, #1f1f1f)', borderBottom: '1px solid var(--border)', display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
          <input
            type="text"
            placeholder="输入 Maven 目标，如: clean package -DskipTests"
            value={customGoalText}
            onChange={(e) => setCustomGoalText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && customGoalText.trim()) { executeGoal(customGoalText.trim()); setCustomGoalInputOpen(false); setCustomGoalText(''); }
              else if (e.key === 'Escape') setCustomGoalInputOpen(false);
            }}
            autoFocus
            style={{ flex: 1, background: 'rgba(0,0,0,0.3)', color: 'var(--text-bright,#fff)', border: '1px solid var(--border)', borderRadius: 4, padding: '4px 8px', fontSize: 12, outline: 'none' }}
          />
          <button type="button" className="panel-standard-btn primary" onClick={() => { if (customGoalText.trim()) { executeGoal(customGoalText.trim()); setCustomGoalInputOpen(false); setCustomGoalText(''); } }} style={{ padding: '3px 10px', fontSize: 12 }}>执行</button>
          <button type="button" className="panel-action-btn" onClick={() => setCustomGoalInputOpen(false)} title="关闭" style={{ fontSize: 12 }}>✕</button>
        </div>
      )}

      {/* ── No Maven warning ── */}
      {mavenEnv && !mavenEnv.available && !hasMvnw && !envConfig.customMvnPath && (
        <div style={{ margin: '8px 10px 0', padding: '10px 12px', background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.25)', borderRadius: 8, fontSize: 12, lineHeight: 1.5, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#fbbf24', fontWeight: 600, marginBottom: 5 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
            未检测到系统 Maven (mvn)
          </div>
          <div style={{ color: 'var(--text)', fontSize: 11.5, marginBottom: 8 }}>
            推荐在全局环境配置大弹窗中选择 Java 版本并一键生成项目 mvnw，即可直接免装 Maven 运行。
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              type="button"
              className="panel-standard-btn"
              onClick={() => {
                if (onOpenSettings) onOpenSettings('environment');
                else setEnvModalOpen(true);
              }}
              style={{ fontSize: 11.5, padding: '3px 10px' }}
            >
              ⚙ 打开环境配置
            </button>
            <button type="button" className="panel-standard-btn primary" onClick={() => void handleInitWrapper()} disabled={generatingWrapper || !mavenEnv.hasJava} style={{ fontSize: 11.5, padding: '3px 10px' }}>{generatingWrapper ? '生成中...' : '⚡ 生成 mvnw'}</button>
          </div>
        </div>
      )}

      {/* ── Project Tree ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '6px 4px' }}>
        {modules.length === 0 ? (
          <div style={{ padding: '36px 16px', textAlign: 'center', color: 'var(--muted)', lineHeight: 1.6 }}>
            <div style={{ opacity: 0.35, marginBottom: 12 }}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2">
                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                <polyline points="3.27 6.96 12 12.01 20.73 6.96" /><line x1="12" y1="22.08" x2="12" y2="12" />
              </svg>
            </div>
            <div style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 13 }}>未检测到 Maven 项目</div>
            <div style={{ fontSize: 12, marginTop: 4 }}>工作区根目录暂无 pom.xml 文件</div>
            <button type="button" className="panel-standard-btn" onClick={() => void scanMavenProjects()} style={{ marginTop: 14, fontSize: 12 }}>重新扫描</button>
          </div>
        ) : (
          <div>
            {modules.length > 1 && (
              <div style={{ padding: '2px 8px 8px 8px', borderBottom: '1px solid var(--border)', marginBottom: 4 }}>
                <div style={{ fontSize: 10.5, color: 'var(--muted)', marginBottom: 3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>模块</div>
                <select value={selectedModulePath} onChange={(e) => setSelectedModulePath(e.target.value)} style={{ width: '100%', background: 'var(--bg-input,#222)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: '4px 6px', fontSize: 12, outline: 'none' }}>
                  {modules.map((m) => <option key={m.pomPath} value={m.pomPath}>{m.isRoot ? `[Root] ${m.artifactId}` : m.artifactId}</option>)}
                </select>
              </div>
            )}

            <TreeNode label={projectRootName} icon={<ProjectIcon />} badge={hasMvnw ? 'mvnw' : undefined} badgeColor="#34d399" collapsed={collapsedNodes['project']} onToggle={() => toggleNode('project')} depth={0}>
              <TreeNode label="Lifecycle" icon={<FolderGearIcon />} collapsed={collapsedNodes['lifecycle']} onToggle={() => toggleNode('lifecycle')} depth={1}>
                {MAVEN_LIFECYCLE_GOALS.map((item) => {
                  const isSelected = selectedGoal === item.goal;
                  const isMutedTest = skipTests && item.goal === 'test';
                  return (
                    <div
                      key={item.goal}
                      onClick={() => setSelectedGoal(item.goal)}
                      onDoubleClick={() => executeGoal(item.goal, currentModule || undefined)}
                      title={`${item.description}\n单击选中，双击执行`}
                      className={`maven-goal-item ${isSelected ? 'selected' : ''}`}
                    >
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        style={{
                          color: isSelected ? 'var(--accent)' : 'var(--muted)',
                          opacity: isSelected ? 1 : 0.7,
                          flexShrink: 0,
                        }}
                      >
                        <polyline points="4 17 10 11 4 5" />
                        <line x1="12" y1="19" x2="20" y2="19" />
                      </svg>
                      <span
                        style={{
                          fontSize: 12.5,
                          fontWeight: isSelected ? 500 : 400,
                          color: isSelected ? 'var(--text-bright)' : isMutedTest ? '#71717a' : 'var(--text)',
                          textDecoration: isMutedTest ? 'line-through' : 'none',
                        }}
                      >
                        {item.name}
                      </span>
                      {isMutedTest && <span style={{ fontSize: 10, color: 'var(--muted)', opacity: 0.8 }}>(已跳过)</span>}
                    </div>
                  );
                })}
              </TreeNode>

              <TreeNode label="Plugins" icon={<FolderGearIcon />} badge={currentModule?.plugins?.length ? `${currentModule.plugins.length}` : undefined} collapsed={collapsedNodes['plugins']} onToggle={() => toggleNode('plugins')} depth={1}>
                {currentModule?.isSpringBoot && <PluginItem name="spring-boot:run" onClick={() => executeGoal('spring-boot:run', currentModule)} color="#34d399" />}
                {currentModule?.plugins?.map((plug) => (
                  <PluginItem key={plug.artifactId} name={plug.artifactId} version={plug.version} onClick={() => plug.goals && plug.goals.length > 0 ? executeGoal(`${plug.artifactId}:${plug.goals[0]}`) : executeGoal(`${plug.artifactId}:help`)} />
                ))}
              </TreeNode>

              <TreeNode label="Dependencies" icon={<FolderPackageIcon />} badge={currentModule?.dependencies?.length ? `${currentModule.dependencies.length}` : undefined} collapsed={collapsedNodes['dependencies']} onToggle={() => toggleNode('dependencies')} depth={1}>
                {currentModule?.dependencies && currentModule.dependencies.length > 0 ? (
                  currentModule.dependencies.map((dep, idx) => (
                    <div
                      key={`${dep.groupId}:${dep.artifactId}-${idx}`}
                      onDoubleClick={() => currentModule && onOpenFile?.(currentModule.pomPath)}
                      className="search-result-item"
                      title={`${dep.groupId}:${dep.artifactId}${dep.version ? `:${dep.version}` : ''}\n双击定位 pom.xml`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '3px 6px 3px 32px',
                        borderRadius: 4,
                        cursor: 'default',
                        margin: '1px 4px',
                        fontSize: 12.5,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, overflow: 'hidden' }}>
                        <DependencyPackageIcon />
                        <span style={{ fontSize: 12.5, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {dep.artifactId}
                        </span>
                      </div>
                      <div style={{ display: 'flex', gap: 4, flexShrink: 0, alignItems: 'center' }}>
                        {dep.version && <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>{dep.version}</span>}
                        {dep.scope && dep.scope !== 'compile' && (
                          <span style={{ fontSize: 10, padding: '1px 4px', borderRadius: 2, background: 'rgba(255,255,255,0.06)', color: 'var(--muted)' }}>
                            {dep.scope}
                          </span>
                        )}
                      </div>
                    </div>
                  ))
                ) : (
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', padding: '4px 6px 4px 32px' }}>无直接依赖</div>
                )}
              </TreeNode>

              {allProfiles.length > 0 && (
                <TreeNode label="Profiles" icon={<FolderGearIcon />} collapsed={collapsedNodes['profiles']} onToggle={() => toggleNode('profiles')} depth={1}>
                  {allProfiles.map((p) => {
                    const isChecked = activeProfiles.has(p);
                    return (
                      <label key={p} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12, color: isChecked ? 'var(--text-bright)' : 'var(--text)', padding: '3px 6px 3px 32px', margin: '1px 4px' }}>
                        <input type="checkbox" checked={isChecked} onChange={() => toggleProfile(p)} style={{ cursor: 'pointer', accentColor: 'var(--accent,#4c8dff)' }} />
                        <span>{p}</span>
                        {isChecked && <span style={{ fontSize: 10, color: 'var(--accent)' }}>(-P{p})</span>}
                      </label>
                    );
                  })}
                </TreeNode>
              )}
            </TreeNode>
          </div>
        )}
      </div>

      {/* ── Global Environment Configuration Modal ── */}
      <EnvironmentConfigModal
        isOpen={envModalOpen}
        onClose={() => setEnvModalOpen(false)}
        mavenEnv={mavenEnv}
        hasMvnw={hasMvnw}
        onRefreshMavenEnv={checkMavenEnv}
        onInitWrapper={handleInitWrapper}
        generatingWrapper={generatingWrapper}
        currentConfig={envConfig}
        onSaveConfig={(cfg) => {
          setEnvConfig(cfg);
          saveEnvConfig(cfg, workspace || undefined);
        }}
        onShowToast={onShowToast}
      />
    </div>
  );
}

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import type { WorkspaceInfo, MavenEnvironmentInfo } from '@deepseek-ide/shared';
import { loadEnvConfig, saveEnvConfig, type EnvConfig } from './EnvironmentSettingsSection';
import { EnvironmentConfigModal } from './EnvironmentConfigModal';
import { PanelChevron } from './PanelChevron';
import { useI18n, type Translate } from '../i18n';

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

const getMavenLifecycleGoals = (t: Translate): MavenLifecycleGoal[] => [
  { name: 'clean', goal: 'clean', description: t('maven.goalClean') },
  { name: 'validate', goal: 'validate', description: t('maven.goalValidate') },
  { name: 'compile', goal: 'compile', description: t('maven.goalCompile') },
  { name: 'test', goal: 'test', description: t('maven.goalTest') },
  { name: 'package', goal: 'package', description: t('maven.goalPackage') },
  { name: 'verify', goal: 'verify', description: t('maven.goalVerify') },
  { name: 'install', goal: 'install', description: t('maven.goalInstall') },
  { name: 'site', goal: 'site', description: t('maven.goalSite') },
  { name: 'deploy', goal: 'deploy', description: t('maven.goalDeploy') },
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
    width="16"
    height="16"
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
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="currentColor"
    style={{ flexShrink: 0 }}
  >
    <path d="M6 4.5v15a1 1 0 0 0 1.52.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 6 4.5z" />
  </svg>
);

const IconTerminal = () => (
  <svg
    width="16"
    height="16"
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
    width="16"
    height="16"
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
    width="16"
    height="16"
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
    width="16"
    height="16"
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
    width="16"
    height="16"
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
        className="maven-tree-leaf"
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
        <PanelChevron expanded={!collapsed} size={11} color="var(--muted)" />
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
          <span style={{ fontSize: 10.5, color: badgeColor, fontWeight: 500, flexShrink: 0, marginLeft: 'auto' }}>
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

function PluginItem({ name, version, onClick, color, t }: { name: string; version?: string; onClick: () => void; color?: string; t: Translate }) {
  return (
    <div
      onClick={onClick}
      className="search-result-item"
      title={t('maven.runPlugin', { name })}
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
  const { t } = useI18n();
  const mavenLifecycleGoals = useMemo(() => getMavenLifecycleGoals(t), [t]);
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
      onShowToast?.(t('maven.scanFailed'), 'error');
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
          onShowToast?.(res.message || t('maven.wrapperOk'), 'success');
          setHasMvnw(true);
          await scanMavenProjects();
        } else {
          onShowToast?.(res.message || t('maven.wrapperFailed'), 'error');
        }
      } else {
        onShowToast?.(t('maven.wrapperUnsupported'), 'error');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      onShowToast?.(t('maven.genFailed', { msg }), 'error');
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
    onShowToast?.(t('maven.started', { command }), 'info');
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
    if (envConfig.customMvnPath) return { label: t('maven.envCustomMvn'), color: '#60a5fa' };
    if (hasMvnw || mavenEnv?.type === 'wrapper') return { label: t('maven.envWrapper'), color: '#34d399' };
    if (mavenEnv?.available) return { label: t('maven.envSystemMvn'), color: '#a3e635' };
    return { label: t('maven.envNotConfigured'), color: '#f87171' };
  }, [envConfig, hasMvnw, mavenEnv, t]);

  return (
    <div className="maven-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%', background: 'var(--bg-panel)', color: 'var(--text)', fontSize: 13, userSelect: 'none', overflow: 'hidden', position: 'relative' }}>

      {/* ── Header: Height 30px, Typography & Actions Unified with Explorer/Search/Git ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 30, padding: '0 10px', boxSizing: 'border-box', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div
          className="panel-header-title"
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: 'var(--text)',
            letterSpacing: '0.05em',
            display: 'flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          <PanelChevron expanded={true} size={12} />
          <span>Maven</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button type="button" className="panel-action-btn" title={t('maven.rescan')} onClick={() => void scanMavenProjects()}>
            <IconReload spinning={loading} />
          </button>
          <button type="button" className="panel-action-btn" title={t('maven.runGoal', { goal: selectedGoal || 'clean' })} onClick={executeSelectedGoal}>
            <IconPlay />
          </button>
          <button type="button" className={`panel-action-btn${customGoalInputOpen ? ' active' : ''}`} title={t('maven.customGoal')} onClick={() => setCustomGoalInputOpen((v) => !v)}>
            <IconTerminal />
          </button>
          <button type="button" className={`panel-action-btn${skipTests ? ' active' : ''}`} title={skipTests ? t('maven.skipTestsOnTitle') : t('maven.skipTestsOffTitle')} onClick={() => { const n = !skipTests; setSkipTests(n); onShowToast?.(n ? t('maven.skipTestsOn') : t('maven.skipTestsOff'), 'info'); }}>
            <IconSkipTest active={skipTests} />
          </button>
          <button type="button" className="panel-action-btn" title={t('maven.expandAll')} onClick={expandAll}>
            <IconExpandAll />
          </button>
          <button type="button" className="panel-action-btn" title={t('maven.collapseAll')} onClick={collapseAll}>
            <IconCollapseAll />
          </button>

          {/* Global Environment Configuration Trigger Button */}
          <button
            type="button"
            className="panel-action-btn"
            title={t('maven.envConfigTitle', { label: envStatus.label + (envConfig.selectedJavaLabel ? ` · ${envConfig.selectedJavaLabel}` : '') })}
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
            placeholder={t('maven.customGoalPlaceholder')}
            value={customGoalText}
            onChange={(e) => setCustomGoalText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && customGoalText.trim()) { executeGoal(customGoalText.trim()); setCustomGoalInputOpen(false); setCustomGoalText(''); }
              else if (e.key === 'Escape') setCustomGoalInputOpen(false);
            }}
            autoFocus
            style={{ flex: 1, background: 'rgba(0,0,0,0.3)', color: 'var(--text-bright,#fff)', border: '1px solid var(--border)', borderRadius: 4, padding: '4px 8px', fontSize: 12, outline: 'none' }}
          />
          <button
            type="button"
            className="panel-action-btn"
            onClick={() => setCustomGoalInputOpen(false)}
            title={t('common.close')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}

      {/* ── No Maven warning ── */}
      {mavenEnv && !mavenEnv.available && !hasMvnw && !envConfig.customMvnPath && (
        <div style={{ margin: '8px 10px 0', padding: '10px 12px', background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.25)', borderRadius: 8, fontSize: 12, lineHeight: 1.5, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#fbbf24', fontWeight: 600, marginBottom: 5 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
            {t('maven.noMavenTitle')}
          </div>
          <div style={{ color: 'var(--text)', fontSize: 11.5, marginBottom: 8 }}>
            {t('maven.noMavenHint')}
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
              {t('maven.openEnvConfig')}
            </button>
            <button type="button" className="panel-standard-btn primary" onClick={() => void handleInitWrapper()} disabled={generatingWrapper || !mavenEnv.hasJava} style={{ fontSize: 11.5, padding: '3px 10px' }}>{generatingWrapper ? t('maven.generating') : t('maven.genMvnw')}</button>
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
            <div style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 13 }}>{t('maven.noProjectTitle')}</div>
            <div style={{ fontSize: 12, marginTop: 4 }}>{t('maven.noProjectDesc')}</div>
            <button type="button" className="panel-standard-btn" onClick={() => void scanMavenProjects()} style={{ marginTop: 14, fontSize: 12 }}>{t('maven.rescanShort')}</button>
          </div>
        ) : (
          <div>
            {modules.length > 1 && (
              <div style={{ padding: '2px 8px 8px 8px', borderBottom: '1px solid var(--border)', marginBottom: 4 }}>
                <div style={{ fontSize: 10.5, color: 'var(--muted)', marginBottom: 3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('maven.module')}</div>
                <select value={selectedModulePath} onChange={(e) => setSelectedModulePath(e.target.value)} style={{ width: '100%', background: 'var(--bg-input,#222)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: '4px 6px', fontSize: 12, outline: 'none' }}>
                  {modules.map((m) => <option key={m.pomPath} value={m.pomPath}>{m.isRoot ? `[Root] ${m.artifactId}` : m.artifactId}</option>)}
                </select>
              </div>
            )}

            <TreeNode label={projectRootName} icon={<ProjectIcon />} badge={hasMvnw ? 'mvnw' : undefined} badgeColor="#34d399" collapsed={collapsedNodes['project']} onToggle={() => toggleNode('project')} depth={0}>
              <TreeNode label={t('maven.treeLifecycle')} icon={<FolderGearIcon />} collapsed={collapsedNodes['lifecycle']} onToggle={() => toggleNode('lifecycle')} depth={1}>
                {mavenLifecycleGoals.map((item) => {
                  const isSelected = selectedGoal === item.goal;
                  const isMutedTest = skipTests && item.goal === 'test';
                  return (
                    <div
                      key={item.goal}
                      onClick={() => setSelectedGoal(item.goal)}
                      onDoubleClick={() => executeGoal(item.goal, currentModule || undefined)}
                      title={t('maven.goalTitle', { desc: item.description })}
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
                      {isMutedTest && <span style={{ fontSize: 10, color: 'var(--muted)', opacity: 0.8 }}>{t('maven.skipped')}</span>}
                    </div>
                  );
                })}
              </TreeNode>

              <TreeNode label={t('maven.treePlugins')} icon={<FolderGearIcon />} badge={currentModule?.plugins?.length ? `${currentModule.plugins.length}` : undefined} collapsed={collapsedNodes['plugins']} onToggle={() => toggleNode('plugins')} depth={1}>
                {currentModule?.isSpringBoot && <PluginItem t={t} name="spring-boot:run" onClick={() => executeGoal('spring-boot:run', currentModule)} color="#34d399" />}
                {currentModule?.plugins?.map((plug) => (
                  <PluginItem t={t} key={plug.artifactId} name={plug.artifactId} version={plug.version} onClick={() => plug.goals && plug.goals.length > 0 ? executeGoal(`${plug.artifactId}:${plug.goals[0]}`) : executeGoal(`${plug.artifactId}:help`)} />
                ))}
              </TreeNode>

              <TreeNode label={t('maven.treeDependencies')} icon={<FolderPackageIcon />} badge={currentModule?.dependencies?.length ? `${currentModule.dependencies.length}` : undefined} collapsed={collapsedNodes['dependencies']} onToggle={() => toggleNode('dependencies')} depth={1}>
                {currentModule?.dependencies && currentModule.dependencies.length > 0 ? (
                  currentModule.dependencies.map((dep, idx) => (
                    <div
                      key={`${dep.groupId}:${dep.artifactId}-${idx}`}
                      onDoubleClick={() => currentModule && onOpenFile?.(currentModule.pomPath)}
                      className="search-result-item"
                      title={t('maven.depTitle', { dep: `${dep.groupId}:${dep.artifactId}${dep.version ? `:${dep.version}` : ''}` })}
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
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', padding: '4px 6px 4px 32px' }}>{t('maven.noDependencies')}</div>
                )}
              </TreeNode>

              {allProfiles.length > 0 && (
                <TreeNode label={t('maven.treeProfiles')} icon={<FolderGearIcon />} collapsed={collapsedNodes['profiles']} onToggle={() => toggleNode('profiles')} depth={1}>
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

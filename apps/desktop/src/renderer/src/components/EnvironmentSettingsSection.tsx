import React, { useState, useEffect, useCallback, useMemo } from 'react';
import type {
  MavenEnvironmentInfo,
  InstalledJdkInfo,
  OnlineJdkInfo,
  JdkInstallProgress,
  CppToolchainStatus,
  MultiLangToolchainStatus,
} from '@deepseek-ide/shared';
import {
  loadProjectRuntimeConfig,
  saveProjectRuntimeConfig,
  type ProjectRuntimeConfig,
} from './ProjectRuntimeConfigModal';
import { useI18n } from '../i18n';

export interface EnvConfig {
  customMvnPath: string;
  selectedJavaHome: string;
  selectedJavaLabel?: string;
  customSettingsPath?: string;
}

export const LS_MAVEN_CONFIG = 'echoly.maven.envConfig';

export function loadEnvConfig(workspace?: string | null): EnvConfig {
  try {
    const key = workspace ? `echoly.maven.envConfig.${workspace}` : LS_MAVEN_CONFIG;
    const raw =
      localStorage.getItem(key) || (workspace ? localStorage.getItem(LS_MAVEN_CONFIG) : null);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        customMvnPath: parsed.customMvnPath || '',
        selectedJavaHome: parsed.selectedJavaHome || parsed.customJavaHome || '',
        selectedJavaLabel: parsed.selectedJavaLabel || '',
        customSettingsPath: parsed.customSettingsPath || '',
      };
    }
  } catch {}
  return { customMvnPath: '', selectedJavaHome: '', selectedJavaLabel: '', customSettingsPath: '' };
}

export function saveEnvConfig(cfg: EnvConfig, workspace?: string | null) {
  try {
    if (workspace) {
      localStorage.setItem(`echoly.maven.envConfig.${workspace}`, JSON.stringify(cfg));
    }
    // 同步更新全局默认
    localStorage.setItem(LS_MAVEN_CONFIG, JSON.stringify(cfg));
  } catch {}
}

export type DetectedEnvLang = 'java' | 'cpp' | 'python' | 'go' | 'node' | 'generic';

export function inferEnvWorkspaceLang(workspace?: string): DetectedEnvLang {
  if (!workspace) return 'generic';
  const wsLower = workspace.toLowerCase();
  if (
    wsLower.includes('test-c') ||
    wsLower.includes('cpp') ||
    wsLower.includes('c-') ||
    wsLower.includes('cmake')
  ) {
    return 'cpp';
  }
  if (wsLower.includes('python') || wsLower.includes('py-') || wsLower.includes('fastapi'))
    return 'python';
  if (wsLower.includes('go') || wsLower.includes('golang')) return 'go';
  if (
    wsLower.includes('node') ||
    wsLower.includes('vue') ||
    wsLower.includes('react') ||
    wsLower.includes('next')
  )
    return 'node';
  if (wsLower.includes('java') || wsLower.includes('maven') || wsLower.includes('spring'))
    return 'java';
  return 'generic';
}

interface EnvironmentSettingsSectionProps {
  workspace?: string;
  onShowToast?: (
    title: string,
    detail?: string,
    type?: 'success' | 'error' | 'info' | 'warn',
  ) => void;
}

export function EnvironmentSettingsSection({
  workspace,
  onShowToast,
}: EnvironmentSettingsSectionProps) {
  const { t } = useI18n();
  const initialLang = useMemo(() => inferEnvWorkspaceLang(workspace), [workspace]);
  const [detectedLang, setDetectedLang] = useState<DetectedEnvLang>(initialLang);
  const [viewAllEnvironments, setViewAllEnvironments] = useState(false);

  const [subTab, setSubTab] = useState<
    'java' | 'maven' | 'cpp' | 'python' | 'go' | 'node' | 'runtime'
  >(() => {
    if (initialLang === 'cpp') return 'cpp';
    if (initialLang === 'python') return 'python';
    if (initialLang === 'go') return 'go';
    if (initialLang === 'node') return 'node';
    return 'java';
  });

  // 嗅探当前工作区根目录特征文件以实现极致精准的语言识别
  useEffect(() => {
    let canceled = false;
    const initial = inferEnvWorkspaceLang(workspace);
    setDetectedLang(initial);
    if (initial !== 'generic') {
      setSubTab(initial === 'java' ? 'java' : initial);
    }

    const sniffWorkspaceRoot = async () => {
      if (!workspace || !window.ide?.listDir) return;
      try {
        const files = await window.ide.listDir('.');
        if (canceled || !Array.isArray(files)) return;
        const names = files.map((f) => f.name.toLowerCase());
        if (
          names.includes('cmakelists.txt') ||
          names.includes('makefile') ||
          names.some((n) => /\.(cpp|cc|cxx)$/.test(n))
        ) {
          setDetectedLang('cpp');
          setSubTab('cpp');
        } else if (
          names.includes('pom.xml') ||
          names.includes('mvnw') ||
          names.includes('build.gradle')
        ) {
          setDetectedLang('java');
          setSubTab('java');
        } else if (
          names.includes('requirements.txt') ||
          names.includes('pyproject.toml') ||
          names.includes('pipfile') ||
          names.some((n) => /\.py$/.test(n))
        ) {
          setDetectedLang('python');
          setSubTab('python');
        } else if (names.includes('go.mod') || names.some((n) => /\.go$/.test(n))) {
          setDetectedLang('go');
          setSubTab('go');
        } else if (names.includes('package.json') || names.includes('tsconfig.json')) {
          setDetectedLang('node');
          setSubTab('node');
        }
      } catch {}
    };

    void sniffWorkspaceRoot();
    return () => {
      canceled = true;
    };
  }, [workspace]);

  // 根据检测到的工程语言与用户偏好计算允许展示的 SubTab（默认按需精简，可一键展开全部）
  const allowedTabs = useMemo(() => {
    if (viewAllEnvironments || detectedLang === 'generic') {
      return ['java', 'maven', 'cpp', 'python', 'go', 'node', 'runtime'] as const;
    }
    switch (detectedLang) {
      case 'cpp':
        return ['cpp', 'runtime'] as const;
      case 'java':
        return ['java', 'maven', 'runtime'] as const;
      case 'python':
        return ['python', 'runtime'] as const;
      case 'go':
        return ['go', 'runtime'] as const;
      case 'node':
        return ['node', 'runtime'] as const;
      default:
        return ['java', 'maven', 'cpp', 'python', 'go', 'node', 'runtime'] as const;
    }
  }, [viewAllEnvironments, detectedLang]);

  // 当 allowedTabs 发生变动且当前选中的 subTab 不在允许列表中时，自动回退到首个合法项
  useEffect(() => {
    if (!allowedTabs.includes(subTab as any)) {
      setSubTab(allowedTabs[0]);
    }
  }, [allowedTabs, subTab]);

  // Config state
  const [config, setConfig] = useState<EnvConfig>(() => loadEnvConfig(workspace));
  const [runtimeConfig, setRuntimeConfig] = useState<ProjectRuntimeConfig>(() =>
    loadProjectRuntimeConfig(workspace),
  );

  // C/C++ & Multi-Language Toolchain State
  const [cppToolchain, setCppToolchain] = useState<CppToolchainStatus | null>(null);
  const [multiToolchain, setMultiToolchain] = useState<MultiLangToolchainStatus | null>(null);
  const [detectingMulti, setDetectingMulti] = useState(false);

  const detectAllToolchains = useCallback(async () => {
    setDetectingMulti(true);
    try {
      if (window.ide?.multiLangCheckToolchain) {
        const res = await window.ide.multiLangCheckToolchain();
        setMultiToolchain(res);
        if (res.cpp) setCppToolchain(res.cpp);
      } else if (window.ide?.cppCheckToolchain) {
        const res = await window.ide.cppCheckToolchain();
        setCppToolchain(res);
      }
    } catch (e) {
      console.error('Failed to check multi-lang toolchain:', e);
    } finally {
      setDetectingMulti(false);
    }
  }, []);

  useEffect(() => {
    if (subTab === 'cpp' || subTab === 'python' || subTab === 'go' || subTab === 'node') {
      void detectAllToolchains();
    }
  }, [subTab, detectAllToolchains]);

  useEffect(() => {
    setConfig(loadEnvConfig(workspace));
    setRuntimeConfig(loadProjectRuntimeConfig(workspace));
  }, [workspace]);

  // Java state
  const [installedJdks, setInstalledJdks] = useState<InstalledJdkInfo[]>([]);
  const [onlineJdks, setOnlineJdks] = useState<OnlineJdkInfo[]>([]);
  const [loadingJdks, setLoadingJdks] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [installProgress, setInstallProgress] = useState<Record<string, JdkInstallProgress>>({});

  const [showMoreJdkMenu, setShowMoreJdkMenu] = useState(false);
  const [showAllJdks, setShowAllJdks] = useState(false);

  // Maven state
  const [mavenEnv, setMavenEnv] = useState<MavenEnvironmentInfo | null>(null);
  const [hasMvnw, setHasMvnw] = useState(false);
  const [hasProjectSettingsXml, setHasProjectSettingsXml] = useState(false);
  const [detectingMaven, setDetectingMaven] = useState(false);
  const [generatingWrapper, setGeneratingWrapper] = useState(false);
  const [generatingSettings, setGeneratingSettings] = useState(false);

  const updateConfig = (updater: (prev: EnvConfig) => EnvConfig) => {
    setConfig((prev) => {
      const next = updater(prev);
      saveEnvConfig(next, workspace);
      return next;
    });
  };

  // Load installed and online JDKs
  const loadJdks = useCallback(async () => {
    setLoadingJdks(true);
    try {
      if (window.ide.javaGetInstalledJdks) {
        const list = await window.ide.javaGetInstalledJdks();
        setInstalledJdks(list);
      }
      if (window.ide.javaGetOnlineJdks) {
        const online = await window.ide.javaGetOnlineJdks();
        setOnlineJdks(online);
      }
    } catch (e) {
      console.error('Failed to fetch JDK info:', e);
    } finally {
      setLoadingJdks(false);
    }
  }, []);

  // Detect Maven Environment
  const detectMaven = useCallback(async () => {
    setDetectingMaven(true);
    try {
      if (window.ide.mavenCheckEnv) {
        const env = await window.ide.mavenCheckEnv();
        setMavenEnv(env);
      }
      if (window.ide.pathExists) {
        const isWin = navigator.userAgent.includes('Windows');
        const [mvnwEx, settingsEx] = await Promise.all([
          window.ide.pathExists(isWin ? 'mvnw.cmd' : 'mvnw'),
          window.ide.pathExists('.mvn/settings.xml'),
        ]);
        setHasMvnw(mvnwEx);
        setHasProjectSettingsXml(settingsEx);
      }
    } catch (e) {
      console.error('Failed to detect Maven environment:', e);
    } finally {
      setDetectingMaven(false);
    }
  }, []);

  useEffect(() => {
    void loadJdks();
    void detectMaven();
  }, [loadJdks, detectMaven]);

  // Listen for Java install progress
  useEffect(() => {
    if (!window.ide.onJavaInstallProgress) return;
    const unsub = window.ide.onJavaInstallProgress((prog) => {
      setInstallProgress((prev) => ({ ...prev, [prog.id]: prog }));
      if (prog.status === 'done' || prog.status === 'error') {
        setInstallingId(null);
        void loadJdks();
      }
    });
    return unsub;
  }, [loadJdks]);

  // Handle Online JDK Install
  const handleInstallJdk = async (jdk: OnlineJdkInfo) => {
    if (installingId) return;
    setInstallingId(jdk.id);
    onShowToast?.(t('envs.startDownload', { name: jdk.name }), undefined, 'info');
    try {
      const res = await window.ide.javaInstallOnlineJdk(jdk.id);
      if (res.success && res.javaHome) {
        onShowToast?.(t('envs.installSuccess', { name: jdk.name }), res.javaHome, 'success');
        updateConfig((prev) => ({
          ...prev,
          selectedJavaHome: res.javaHome!,
          selectedJavaLabel: `${jdk.name} (${res.javaHome})`,
        }));
        await loadJdks();
      } else {
        onShowToast?.(t('envs.installJdkFailed'), res.message || t('envs.checkNetwork'), 'error');
      }
    } catch (err: any) {
      onShowToast?.(t('envs.installException'), err?.message || String(err), 'error');
    } finally {
      setInstallingId(null);
    }
  };

  // Browse Directory for JAVA_HOME
  const handlePickJavaHome = async () => {
    try {
      const picked = await window.ide.pickDirectory?.();
      if (picked) {
        updateConfig((prev) => ({
          ...prev,
          selectedJavaHome: picked,
          selectedJavaLabel: t('envs.customPrefix', { path: picked }),
        }));
        onShowToast?.(t('envs.javaHomeUpdated'), picked, 'success');
      }
    } catch {}
  };

  // Browse File for custom mvn
  const handlePickMvnPath = async () => {
    try {
      const picked = await window.ide.pickFile?.([{ name: 'Maven Executable', extensions: ['*'] }]);
      if (picked) {
        updateConfig((prev) => ({
          ...prev,
          customMvnPath: picked,
        }));
        onShowToast?.(t('envs.mavenPathSet'), picked, 'success');
      }
    } catch {}
  };

  // Browse File for custom settings.xml
  const handlePickSettingsPath = async () => {
    try {
      const picked = await window.ide.pickFile?.([
        { name: 'Maven settings.xml', extensions: ['xml'] },
      ]);
      if (picked) {
        updateConfig((prev) => ({
          ...prev,
          customSettingsPath: picked,
        }));
        onShowToast?.(t('envs.settingsPathSet'), picked, 'success');
      }
    } catch {}
  };

  // Generate / Init Wrapper
  const handleInitWrapper = async () => {
    if (generatingWrapper) return;
    setGeneratingWrapper(true);
    try {
      const res = await window.ide.mavenInitWrapper();
      if (res.success) {
        onShowToast?.(t('envs.wrapperReady'), res.message, 'success');
        await detectMaven();
      } else {
        onShowToast?.(t('envs.wrapperFailed'), res.message, 'error');
      }
    } catch (err: any) {
      onShowToast?.(t('envs.generateFailed'), err?.message || String(err), 'error');
    } finally {
      setGeneratingWrapper(false);
    }
  };

  // Generate / Init settings.xml with Aliyun Mirror
  const handleInitSettingsXml = async () => {
    if (generatingSettings) return;
    setGeneratingSettings(true);
    try {
      if (typeof window.ide?.mavenInitSettings === 'function') {
        const res = await window.ide.mavenInitSettings();
        if (res.success) {
          onShowToast?.(t('envs.settingsInitOk'), res.message, 'success');
          setHasProjectSettingsXml(true);
          if (!config.customSettingsPath) {
            updateConfig((prev) => ({
              ...prev,
              customSettingsPath: res.path || '.mvn/settings.xml',
            }));
          }
          return;
        }
      }

      // Fallback: direct creation via window.ide.mkdir & window.ide.writeFile
      const defaultXml = `<?xml version="1.0" encoding="UTF-8"?>
<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0"
          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
          xsi:schemaLocation="http://maven.apache.org/SETTINGS/1.2.0 https://maven.apache.org/xsd/settings-1.2.0.xsd">
  <mirrors>
    <!-- 阿里云国内公共镜像库 (极大加速国内依赖下载) -->
    <mirror>
      <id>aliyunmaven</id>
      <mirrorOf>central</mirrorOf>
      <name>阿里云公共仓库</name>
      <url>https://maven.aliyun.com/repository/public</url>
    </mirror>
  </mirrors>

  <profiles>
    <profile>
      <id>jdk-default</id>
      <activation>
        <activeByDefault>true</activeByDefault>
      </activation>
      <properties>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
        <project.reporting.outputEncoding>UTF-8</project.reporting.outputEncoding>
      </properties>
    </profile>
  </profiles>
</settings>
`;
      try {
        await window.ide.mkdir('.mvn');
      } catch {
        // directory may already exist
      }
      await window.ide.writeFile('.mvn/settings.xml', defaultXml);
      setHasProjectSettingsXml(true);
      if (!config.customSettingsPath) {
        updateConfig((prev) => ({
          ...prev,
          customSettingsPath: '.mvn/settings.xml',
        }));
      }
      onShowToast?.(t('envs.settingsInitOk'), t('envs.settingsInitOkDetail'), 'success');
    } catch (err: any) {
      onShowToast?.(t('envs.operationException'), err?.message || String(err), 'error');
    } finally {
      setGeneratingSettings(false);
    }
  };

  // Active JDK status label
  const activeJavaDisplay = config.selectedJavaHome
    ? config.selectedJavaLabel || config.selectedJavaHome
    : mavenEnv?.hasJava
      ? t('envs.systemDefaultJava')
      : t('envs.noJavaEnv');

  return (
    <div
      className="settings-panel-section"
      style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
    >
      {/* Title Bar */}
      <div className="panel-title-bar">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h3 className="panel-h3" style={{ margin: 0 }}>
              {t('envs.title')}
            </h3>
            <span
              style={{
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 12,
                background: 'rgba(59, 130, 246, 0.12)',
                color: 'var(--accent, #3b82f6)',
                border: '1px solid rgba(59, 130, 246, 0.25)',
                fontWeight: 600,
              }}
            >
              Environment &amp; SDK
            </span>
          </div>
          <p className="panel-sub" style={{ marginTop: 4, marginBottom: 0 }}>
            {t('envs.subtitle')}
          </p>
        </div>
      </div>

      {/* 项目绑定确认提示 */}
      {workspace ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 12px',
            borderRadius: 6,
            background: 'rgba(56, 189, 248, 0.08)',
            border: '1px solid rgba(56, 189, 248, 0.25)',
            fontSize: 12,
            color: '#38bdf8',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>📁</span>
            <span>
              {t('envs.boundToProject')}
              <strong>{workspace.split('/').pop()}</strong>
              <span style={{ opacity: 0.75, marginLeft: 6 }}>({workspace})</span>
            </span>
          </div>
          <div
            style={{
              fontSize: 11,
              color: '#34d399',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <span>✓</span> {t('envs.projectLevelActive')}
          </div>
        </div>
      ) : (
        <div
          style={{
            padding: '8px 12px',
            borderRadius: 6,
            background: 'rgba(255, 255, 255, 0.04)',
            border: '1px solid var(--border)',
            fontSize: 12,
            color: 'var(--muted)',
          }}
        >
          {t('envs.globalDefaultActive')}
        </div>
      )}

      {/* 智能识别与环境技术栈支持说明横幅 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 8,
          padding: '8px 12px',
          borderRadius: 8,
          background: 'rgba(56, 189, 248, 0.08)',
          border: '1px solid rgba(56, 189, 248, 0.22)',
          fontSize: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14 }}>🎯</span>
          <span style={{ color: 'var(--text-bright, #fff)' }}>
            {t('envs.detectedAs')}{' '}
            <strong style={{ color: '#38bdf8' }}>
              {detectedLang === 'cpp' && 'C / C++ (Clang / CMake)'}
              {detectedLang === 'java' && 'Java (Maven / JDK)'}
              {detectedLang === 'python' && 'Python (3.x)'}
              {detectedLang === 'go' && 'Go (Module)'}
              {detectedLang === 'node' && 'Node.js / TypeScript'}
              {detectedLang === 'generic' && t('envs.langGeneric')}
            </strong>
          </span>
          {!viewAllEnvironments && detectedLang !== 'generic' && (
            <span style={{ color: 'var(--muted)', fontSize: 11 }}>{t('envs.tabsSimplified')}</span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            {t('envs.supportedStackBefore')}
            <strong>{t('envs.supportedStackList')}</strong>
          </span>
          <button
            type="button"
            className="panel-standard-btn"
            onClick={() => setViewAllEnvironments(!viewAllEnvironments)}
            style={{
              padding: '3px 8px',
              fontSize: 11,
              borderRadius: 4,
              background: viewAllEnvironments
                ? 'rgba(56, 189, 248, 0.18)'
                : 'rgba(255, 255, 255, 0.06)',
              color: viewAllEnvironments ? '#38bdf8' : 'var(--text, #e2e8f0)',
              border: '1px solid var(--border)',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
            title={viewAllEnvironments ? t('envs.simplifyTitle') : t('envs.viewAllTitle')}
          >
            {viewAllEnvironments ? t('envs.onlyCurrent') : t('envs.viewAll')}
          </button>
        </div>
      </div>

      {/* 现代化分段胶囊 Tab 导航栏 (防挤压、防竖排折行) */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px',
          background: 'rgba(255, 255, 255, 0.03)',
          borderRadius: 8,
          border: '1px solid var(--border)',
          overflowX: 'auto',
          scrollbarWidth: 'none',
        }}
      >
        {(
          [
            { key: 'java', icon: '☕', label: 'Java (JDK)' },
            { key: 'maven', icon: '🛠️', label: t('envs.tabMaven') },
            { key: 'cpp', icon: '🚀', label: 'C / C++' },
            { key: 'python', icon: '🐍', label: 'Python' },
            { key: 'go', icon: '🐹', label: 'Go' },
            { key: 'node', icon: '🟢', label: 'Node.js / TS' },
            { key: 'runtime', icon: '⚡', label: t('envs.tabRuntime') },
          ] as const
        )
          .filter((tab) => (allowedTabs as readonly string[]).includes(tab.key))
          .map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setSubTab(tab.key)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 13px',
                borderRadius: 6,
                border: '1px solid',
                borderColor: subTab === tab.key ? 'var(--accent, #3b82f6)' : 'transparent',
                background:
                  subTab === tab.key ? 'var(--bg-hover, rgba(59, 130, 246, 0.16))' : 'transparent',
                color: subTab === tab.key ? 'var(--text-bright, #fff)' : 'var(--muted, #a1a1aa)',
                fontSize: 12,
                fontWeight: subTab === tab.key ? 600 : 400,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                flexShrink: 0,
                transition: 'all 0.15s ease',
              }}
            >
              <span>{tab.icon}</span>
              <span>{tab.label}</span>
            </button>
          ))}
      </div>

      {/* ─── TAB 1: JAVA (JDK) CONFIGURATION ─── */}
      {subTab === 'java' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Active JDK Status Card */}
          <div
            style={{
              padding: '12px 16px',
              borderRadius: 8,
              background: 'var(--bg-card, rgba(255, 255, 255, 0.03))',
              border: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background:
                      config.selectedJavaHome || mavenEnv?.hasJava ? '#10b981' : '#f43f5e',
                    boxShadow:
                      config.selectedJavaHome || mavenEnv?.hasJava ? '0 0 8px #10b981' : 'none',
                  }}
                />
                <span
                  style={{
                    fontSize: 11.5,
                    fontWeight: 600,
                    color: 'var(--muted)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                  }}
                >
                  {t('envs.currentJava')}
                </span>
              </div>
              <div
                style={{
                  fontSize: 13.5,
                  fontWeight: 600,
                  color: 'var(--text-bright)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  maxWidth: 500,
                }}
                title={config.selectedJavaHome || t('envs.systemDefault')}
              >
                {activeJavaDisplay}
              </div>
              {config.selectedJavaHome && (
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--muted)',
                    marginTop: 2,
                    fontFamily: 'monospace',
                  }}
                >
                  JAVA_HOME = {config.selectedJavaHome}
                </div>
              )}
            </div>

            {config.selectedJavaHome && (
              <button
                type="button"
                className="panel-standard-btn"
                onClick={() => {
                  updateConfig((prev) => ({
                    ...prev,
                    selectedJavaHome: '',
                    selectedJavaLabel: '',
                  }));
                  onShowToast?.(t('envs.switchedToSystemDefault'), undefined, 'info');
                }}
                style={{ padding: '4px 10px', fontSize: 11.5 }}
              >
                {t('envs.restoreSystemDefault')}
              </button>
            )}
          </div>

          {/* Online JDK Installation Cards */}
          <div>
            {(() => {
              const featuredIds = ['temurin-21', 'temurin-17', 'temurin-11', 'jdk-8'];
              const featuredJdks = onlineJdks.filter((j) => featuredIds.includes(j.id));
              const moreJdks = onlineJdks.filter((j) => !featuredIds.includes(j.id));
              const displayedJdks = showAllJdks
                ? onlineJdks
                : featuredJdks.length > 0
                  ? featuredJdks
                  : onlineJdks;

              return (
                <>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      marginBottom: 8,
                      flexWrap: 'wrap',
                      gap: 8,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span>🌐</span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-bright)' }}>
                        {t('envs.onlineInstallTitle')}
                      </span>
                      <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                        {t('envs.onlineInstallDesc')}
                      </span>
                    </div>

                    {/* 更多主流版本下拉菜单与平铺切换 */}
                    <div
                      style={{
                        position: 'relative',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                      }}
                    >
                      {moreJdks.length > 0 && (
                        <button
                          type="button"
                          className="panel-standard-btn"
                          onClick={() => setShowMoreJdkMenu((prev) => !prev)}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '4px 10px',
                            fontSize: 12,
                            borderRadius: 6,
                            background: showMoreJdkMenu
                              ? 'var(--bg-hover, rgba(255,255,255,0.08))'
                              : undefined,
                            borderColor: showMoreJdkMenu ? 'var(--accent)' : undefined,
                          }}
                          title={t('envs.moreJdkTitle')}
                        >
                          <span>{t('envs.moreVersions', { n: moreJdks.length })}</span>
                          <span style={{ fontSize: 10, opacity: 0.7 }}>
                            {showMoreJdkMenu ? '▲' : '▼'}
                          </span>
                        </button>
                      )}

                      {/* 更多版本下拉弹层 */}
                      {showMoreJdkMenu && (
                        <div
                          style={{
                            position: 'absolute',
                            top: 'calc(100% + 6px)',
                            right: 0,
                            zIndex: 1000,
                            width: 380,
                            maxHeight: 420,
                            overflowY: 'auto',
                            background: 'var(--bg-elevated, #252526)',
                            border: '1px solid var(--border)',
                            borderRadius: 8,
                            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                            padding: 8,
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
                              padding: '4px 6px',
                              borderBottom: '1px solid var(--border)',
                            }}
                          >
                            <span
                              style={{ fontWeight: 600, fontSize: 12, color: 'var(--text-bright)' }}
                            >
                              {t('envs.moreJdkSection')}
                            </span>
                            <button
                              type="button"
                              className="panel-action-btn"
                              onClick={() => setShowMoreJdkMenu(false)}
                              title={t('common.close')}
                            >
                              ×
                            </button>
                          </div>

                          {moreJdks.map((jdk) => {
                            const prog = installProgress[jdk.id];
                            const isInstallingThis = installingId === jdk.id;
                            const isInstalled =
                              Boolean(jdk.isInstalled) ||
                              installedJdks.some(
                                (i) => i.id === jdk.id || i.version.startsWith(jdk.version),
                              );
                            const isSelected =
                              config.selectedJavaHome &&
                              (config.selectedJavaHome === jdk.installedPath ||
                                (jdk.installedPath &&
                                  config.selectedJavaHome.startsWith(jdk.installedPath)));

                            return (
                              <div
                                key={jdk.id}
                                style={{
                                  padding: '8px 10px',
                                  borderRadius: 6,
                                  background: 'var(--bg-card, rgba(255, 255, 255, 0.03))',
                                  border: '1px solid var(--border)',
                                  display: 'flex',
                                  flexDirection: 'column',
                                  gap: 6,
                                }}
                              >
                                <div
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                  }}
                                >
                                  <div>
                                    <div
                                      style={{
                                        fontWeight: 600,
                                        fontSize: 12,
                                        color: 'var(--text-bright)',
                                      }}
                                    >
                                      {jdk.name}
                                    </div>
                                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                                      {jdk.vendor} · ~{jdk.sizeMb}MB
                                    </div>
                                  </div>
                                  <div>
                                    {isInstallingThis ? (
                                      <span style={{ fontSize: 11, color: 'var(--accent)' }}>
                                        {prog?.status === 'extracting'
                                          ? t('envs.extracting')
                                          : `${prog?.percent || 0}%`}
                                      </span>
                                    ) : isSelected ? (
                                      <span
                                        style={{ fontSize: 11, color: '#10b981', fontWeight: 600 }}
                                      >
                                        {t('envs.inUse')}
                                      </span>
                                    ) : isInstalled ? (
                                      <button
                                        type="button"
                                        className="panel-standard-btn"
                                        style={{ padding: '2px 8px', fontSize: 11 }}
                                        onClick={() => {
                                          const match = installedJdks.find(
                                            (i) =>
                                              i.id === jdk.id || i.version.startsWith(jdk.version),
                                          );
                                          const targetPath = jdk.installedPath || match?.path;
                                          if (targetPath) {
                                            updateConfig((prev) => ({
                                              ...prev,
                                              selectedJavaHome: targetPath,
                                              selectedJavaLabel: jdk.name,
                                            }));
                                            onShowToast?.(
                                              t('envs.selectedToUse', { name: jdk.name }),
                                              targetPath,
                                              'success',
                                            );
                                            setShowMoreJdkMenu(false);
                                          }
                                        }}
                                      >
                                        {t('envs.switchAction')}
                                      </button>
                                    ) : (
                                      <button
                                        type="button"
                                        className="panel-standard-btn primary"
                                        style={{ padding: '2px 8px', fontSize: 11 }}
                                        disabled={Boolean(installingId)}
                                        onClick={() => void handleInstallJdk(jdk)}
                                      >
                                        {t('envs.installOneClick')}
                                      </button>
                                    )}
                                  </div>
                                </div>
                                <div
                                  style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.35 }}
                                >
                                  {jdk.description}
                                </div>
                              </div>
                            );
                          })}

                          <div style={{ textAlign: 'center', paddingTop: 4 }}>
                            <button
                              type="button"
                              style={{
                                background: 'none',
                                border: 'none',
                                color: 'var(--accent)',
                                fontSize: 11.5,
                                cursor: 'pointer',
                                textDecoration: 'underline',
                              }}
                              onClick={() => {
                                setShowAllJdks((prev) => !prev);
                                setShowMoreJdkMenu(false);
                              }}
                            >
                              {showAllJdks ? t('envs.restoreCompact') : t('envs.showAllVersions')}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                      gap: 10,
                    }}
                  >
                    {displayedJdks.map((jdk) => {
                      const prog = installProgress[jdk.id];
                      const isInstallingThis = installingId === jdk.id;
                      const isInstalled =
                        Boolean(jdk.isInstalled) ||
                        installedJdks.some(
                          (i) => i.id === jdk.id || i.version.startsWith(jdk.version),
                        );
                      const isSelected =
                        config.selectedJavaHome &&
                        (config.selectedJavaHome === jdk.installedPath ||
                          (jdk.installedPath &&
                            config.selectedJavaHome.startsWith(jdk.installedPath)));

                      return (
                        <div
                          key={jdk.id}
                          style={{
                            padding: 12,
                            borderRadius: 8,
                            background: 'var(--bg-card, rgba(255, 255, 255, 0.02))',
                            border: '1px solid var(--border)',
                            display: 'flex',
                            flexDirection: 'column',
                            justifyContent: 'space-between',
                            gap: 8,
                            transition: 'border-color 0.15s ease',
                          }}
                        >
                          <div>
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                marginBottom: 4,
                              }}
                            >
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <span
                                  style={{
                                    fontWeight: 600,
                                    fontSize: 12.5,
                                    color: 'var(--text-bright)',
                                  }}
                                >
                                  {jdk.name}
                                </span>
                                {jdk.recommended && (
                                  <span
                                    style={{
                                      fontSize: 10,
                                      padding: '1px 5px',
                                      borderRadius: 3,
                                      background: 'rgba(16, 185, 129, 0.15)',
                                      color: '#10b981',
                                      fontWeight: 600,
                                    }}
                                  >
                                    {t('envs.recommended')}
                                  </span>
                                )}
                              </div>
                              {jdk.sizeMb && (
                                <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                                  ~{jdk.sizeMb}MB
                                </span>
                              )}
                            </div>
                            <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.4 }}>
                              {jdk.description}
                            </div>
                          </div>

                          {isInstallingThis && prog && prog.status === 'downloading' && (
                            <div style={{ marginTop: 2 }}>
                              <div
                                style={{
                                  height: 4,
                                  borderRadius: 2,
                                  background: 'var(--border)',
                                  overflow: 'hidden',
                                }}
                              >
                                <div
                                  style={{
                                    height: '100%',
                                    width: `${prog.percent}%`,
                                    background: 'var(--accent)',
                                    transition: 'width 0.2s ease',
                                  }}
                                />
                              </div>
                              <div
                                style={{
                                  display: 'flex',
                                  justifyContent: 'space-between',
                                  fontSize: 10.5,
                                  color: 'var(--muted)',
                                  marginTop: 3,
                                }}
                              >
                                <span>{t('envs.downloadingPct', { pct: prog.percent })}</span>
                                {prog.downloadedBytes && prog.totalBytes && (
                                  <span>
                                    {(prog.downloadedBytes / 1024 / 1024).toFixed(1)} /{' '}
                                    {(prog.totalBytes / 1024 / 1024).toFixed(1)} MB
                                  </span>
                                )}
                              </div>
                            </div>
                          )}

                          {isInstallingThis && prog && prog.status === 'extracting' && (
                            <div style={{ fontSize: 11, color: 'var(--accent)', marginTop: 2 }}>
                              {t('envs.extractingEnv')}
                            </div>
                          )}

                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              marginTop: 4,
                              paddingTop: 8,
                              borderTop: '1px solid rgba(255, 255, 255, 0.04)',
                            }}
                          >
                            <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                              {jdk.vendor}
                            </span>

                            {isInstalled ? (
                              isSelected ? (
                                <span
                                  style={{
                                    fontSize: 11,
                                    fontWeight: 600,
                                    color: '#10b981',
                                    padding: '4px 8px',
                                  }}
                                >
                                  {t('envs.currentVersion')}
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  className="panel-standard-btn"
                                  onClick={() => {
                                    const targetPath =
                                      jdk.installedPath ||
                                      installedJdks.find((i) => i.id === jdk.id)?.path ||
                                      '';
                                    updateConfig((prev) => ({
                                      ...prev,
                                      selectedJavaHome: targetPath,
                                      selectedJavaLabel: `${jdk.name}`,
                                    }));
                                    onShowToast?.(
                                      t('envs.selectedToUse', { name: jdk.name }),
                                      targetPath,
                                      'success',
                                    );
                                  }}
                                  style={{ padding: '3px 10px', fontSize: 11.5 }}
                                >
                                  {t('envs.selectThisVersion')}
                                </button>
                              )
                            ) : (
                              <button
                                type="button"
                                className="panel-standard-btn primary"
                                disabled={Boolean(installingId)}
                                onClick={() => void handleInstallJdk(jdk)}
                                style={{ padding: '4px 12px', fontSize: 11.5 }}
                              >
                                {isInstallingThis ? t('envs.installing') : t('envs.installOnline')}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              );
            })()}
          </div>

          {/* Local Detected JDKs */}
          <div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 8,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span>💻</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-bright)' }}>
                  {t('envs.detectedJdks', { n: installedJdks.length })}
                </span>
              </div>
              <button
                type="button"
                className="panel-text-btn"
                onClick={() => void loadJdks()}
                disabled={loadingJdks}
                style={{ fontSize: 11.5 }}
              >
                {loadingJdks ? t('envs.scanning') : t('envs.rescan')}
              </button>
            </div>

            <div
              style={{
                maxHeight: 160,
                overflowY: 'auto',
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--bg-card, rgba(0, 0, 0, 0.1))',
              }}
            >
              {installedJdks.length === 0 ? (
                <div
                  style={{
                    padding: '16px',
                    textAlign: 'center',
                    color: 'var(--muted)',
                    fontSize: 12,
                  }}
                >
                  {t('envs.noOtherJdks')}
                </div>
              ) : (
                installedJdks.map((jdk) => {
                  const isSelected = config.selectedJavaHome === jdk.path;
                  return (
                    <div
                      key={jdk.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '8px 12px',
                        borderBottom: '1px solid var(--border)',
                        background: isSelected
                          ? 'var(--bg-hover, rgba(59, 130, 246, 0.12))'
                          : 'transparent',
                      }}
                    >
                      <div style={{ minWidth: 0, flex: 1, paddingRight: 10 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span
                            style={{ fontWeight: 600, fontSize: 12.5, color: 'var(--text-bright)' }}
                          >
                            Java {jdk.majorVersion || jdk.version}
                          </span>
                          <span style={{ fontSize: 11, color: 'var(--muted)' }}>{jdk.vendor}</span>
                          {jdk.arch && (
                            <span
                              style={{
                                fontSize: 10,
                                padding: '1px 4px',
                                borderRadius: 3,
                                background: 'var(--border)',
                                color: 'var(--text)',
                              }}
                            >
                              {jdk.arch}
                            </span>
                          )}
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            color: 'var(--muted)',
                            fontFamily: 'monospace',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            marginTop: 2,
                          }}
                          title={jdk.path}
                        >
                          {jdk.path}
                        </div>
                      </div>

                      <button
                        type="button"
                        className={`panel-standard-btn ${isSelected ? 'primary' : ''}`}
                        onClick={() => {
                          updateConfig((prev) => ({
                            ...prev,
                            selectedJavaHome: jdk.path,
                            selectedJavaLabel: `${jdk.vendor} Java ${jdk.majorVersion || jdk.version}`,
                          }));
                          onShowToast?.(
                            t('envs.selectedJavaVersion', {
                              version: jdk.majorVersion || jdk.version,
                            }),
                            jdk.path,
                            'success',
                          );
                        }}
                        style={{ padding: '3px 10px', fontSize: 11.5, flexShrink: 0 }}
                      >
                        {isSelected ? t('envs.selected') : t('envs.useThis')}
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Custom JAVA_HOME Picker */}
          <div>
            <label
              style={{
                display: 'block',
                fontSize: 12,
                fontWeight: 500,
                color: 'var(--text)',
                marginBottom: 6,
              }}
            >
              {t('envs.customJavaHome')}{' '}
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                {t('envs.customJavaHomeHint')}
              </span>
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                value={config.selectedJavaHome}
                onChange={(e) =>
                  updateConfig((prev) => ({
                    ...prev,
                    selectedJavaHome: e.target.value,
                    selectedJavaLabel: e.target.value
                      ? t('envs.customPrefix', { path: e.target.value })
                      : '',
                  }))
                }
                placeholder="/Library/Java/JavaVirtualMachines/jdk-21.jdk/Contents/Home"
                style={{
                  flex: 1,
                  background: 'var(--bg-input, rgba(0,0,0,0.2))',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: '6px 12px',
                  color: 'var(--text-bright)',
                  fontSize: 12,
                  fontFamily: 'monospace',
                  outline: 'none',
                }}
              />
              <button
                type="button"
                className="panel-standard-btn"
                onClick={handlePickJavaHome}
                style={{ padding: '6px 14px', fontSize: 12 }}
              >
                {t('envs.browseDir')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── TAB 2: MAVEN CONFIGURATION & SETTINGS.XML ─── */}
      {subTab === 'maven' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Active Maven Mode Status */}
          <div
            style={{
              padding: '12px 16px',
              borderRadius: 8,
              background: 'var(--bg-card, rgba(255, 255, 255, 0.03))',
              border: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: '#10b981',
                    boxShadow: '0 0 8px #10b981',
                  }}
                />
                <span
                  style={{
                    fontSize: 11.5,
                    fontWeight: 600,
                    color: '#10b981',
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                  }}
                >
                  {t('envs.currentMavenMode')}
                </span>
              </div>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-bright)' }}>
                {config.customMvnPath
                  ? t('envs.modeCustom', { path: config.customMvnPath })
                  : hasMvnw || mavenEnv?.type === 'wrapper'
                    ? t('envs.modeWrapper')
                    : mavenEnv?.available
                      ? t('envs.modeSystem', { path: mavenEnv.executablePath || 'mvn' })
                      : t('envs.modeNotFound')}
              </div>
            </div>

            <button
              type="button"
              className="panel-standard-btn"
              onClick={() => void detectMaven()}
              disabled={detectingMaven}
              style={{ padding: '4px 10px', fontSize: 11.5 }}
            >
              {detectingMaven ? t('envs.detecting') : t('envs.redetect')}
            </button>
          </div>

          {/* Maven Wrapper (mvnw) Feature Card */}
          <div
            style={{
              padding: '14px 16px',
              borderRadius: 8,
              background: 'var(--bg-card, rgba(255, 255, 255, 0.02))',
              border: '1px solid var(--border)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 16 }}>⚡</span>
              <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-bright)' }}>
                {t('envs.wrapperTitle')}
              </span>
              {hasMvnw ? (
                <span
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 10,
                    background: 'rgba(16, 185, 129, 0.2)',
                    color: '#10b981',
                    fontWeight: 600,
                  }}
                >
                  {t('envs.wrapperPresent')}
                </span>
              ) : (
                <span
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 10,
                    background: 'rgba(234, 179, 8, 0.2)',
                    color: '#fbbf24',
                    fontWeight: 600,
                  }}
                >
                  {t('envs.wrapperAbsent')}
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 12 }}>
              {t('envs.wrapperDesc')}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                type="button"
                className="panel-standard-btn primary"
                disabled={generatingWrapper}
                onClick={() => void handleInitWrapper()}
                style={{ padding: '5px 14px', fontSize: 12 }}
              >
                {generatingWrapper
                  ? t('envs.generatingWrapper')
                  : hasMvnw
                    ? t('envs.regenerateWrapper')
                    : t('envs.generateWrapper')}
              </button>
              <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                {t('envs.wrapperLocation')}
              </span>
            </div>
          </div>

          {/* Maven Settings.xml Configuration Card */}
          <div
            style={{
              padding: '14px 16px',
              borderRadius: 8,
              background: 'var(--bg-card, rgba(255, 255, 255, 0.02))',
              border: '1px solid var(--border)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 6,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 16 }}>📄</span>
                <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-bright)' }}>
                  {t('envs.settingsTitle')}
                </span>
                {config.customSettingsPath ? (
                  <span
                    style={{
                      fontSize: 11,
                      padding: '2px 8px',
                      borderRadius: 10,
                      background: 'rgba(59, 130, 246, 0.2)',
                      color: 'var(--accent)',
                      fontWeight: 600,
                    }}
                  >
                    {t('envs.settingsSpecified')}
                  </span>
                ) : hasProjectSettingsXml ? (
                  <span
                    style={{
                      fontSize: 11,
                      padding: '2px 8px',
                      borderRadius: 10,
                      background: 'rgba(16, 185, 129, 0.2)',
                      color: '#10b981',
                      fontWeight: 600,
                    }}
                  >
                    {t('envs.settingsProjectActive')}
                  </span>
                ) : (
                  <span
                    style={{
                      fontSize: 11,
                      padding: '2px 8px',
                      borderRadius: 10,
                      background: 'rgba(255, 255, 255, 0.08)',
                      color: 'var(--muted)',
                      fontWeight: 500,
                    }}
                  >
                    {t('envs.settingsSystemDefault')}
                  </span>
                )}
              </div>
            </div>

            <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 12 }}>
              {t('envs.settingsDescBefore')}
              <code
                style={{
                  background: 'var(--bg-input)',
                  padding: '1px 5px',
                  borderRadius: 4,
                  fontFamily: 'monospace',
                }}
              >
                -s &lt;settings.xml&gt;
              </code>
              {t('envs.settingsDescAfter')}
            </div>

            {/* Path input */}
            <div style={{ marginBottom: 12 }}>
              <label
                style={{
                  display: 'block',
                  fontSize: 12,
                  fontWeight: 500,
                  color: 'var(--text)',
                  marginBottom: 6,
                }}
              >
                {t('envs.customSettingsPath')}{' '}
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                  {t('envs.customSettingsPathHint')}
                </span>
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="text"
                  value={config.customSettingsPath || ''}
                  onChange={(e) =>
                    updateConfig((prev) => ({ ...prev, customSettingsPath: e.target.value }))
                  }
                  placeholder={t('envs.settingsPathPlaceholder')}
                  style={{
                    flex: 1,
                    background: 'var(--bg-input, rgba(0,0,0,0.2))',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    padding: '6px 12px',
                    color: 'var(--text-bright)',
                    fontSize: 12,
                    fontFamily: 'monospace',
                    outline: 'none',
                  }}
                />
                <button
                  type="button"
                  className="panel-standard-btn"
                  onClick={handlePickSettingsPath}
                  style={{ padding: '6px 14px', fontSize: 12 }}
                >
                  {t('envs.browseFile')}
                </button>
                {config.customSettingsPath && (
                  <button
                    type="button"
                    className="panel-standard-btn"
                    onClick={() => {
                      updateConfig((prev) => ({ ...prev, customSettingsPath: '' }));
                      onShowToast?.(t('envs.clearedSettingsPath'), undefined, 'info');
                    }}
                    style={{ padding: '6px 10px', fontSize: 12 }}
                    title={t('envs.clearCustomPath')}
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>

            {/* One-click generate .mvn/settings.xml */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                paddingTop: 6,
                borderTop: '1px solid var(--border)',
              }}
            >
              <button
                type="button"
                className="panel-standard-btn"
                disabled={generatingSettings}
                onClick={() => void handleInitSettingsXml()}
                style={{ padding: '5px 14px', fontSize: 12 }}
              >
                {generatingSettings ? t('envs.generating') : t('envs.generateSettingsXml')}
              </button>
              <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                {t('envs.settingsMirrorDesc')}
              </span>
            </div>
          </div>

          {/* Custom mvn Path */}
          <div>
            <label
              style={{
                display: 'block',
                fontSize: 12,
                fontWeight: 500,
                color: 'var(--text)',
                marginBottom: 6,
              }}
            >
              {t('envs.customMvnPath')}{' '}
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                {t('envs.customMvnPathHint')}
              </span>
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                value={config.customMvnPath}
                onChange={(e) =>
                  updateConfig((prev) => ({ ...prev, customMvnPath: e.target.value }))
                }
                placeholder={t('envs.mvnPathPlaceholder')}
                style={{
                  flex: 1,
                  background: 'var(--bg-input, rgba(0,0,0,0.2))',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: '6px 12px',
                  color: 'var(--text-bright)',
                  fontSize: 12,
                  fontFamily: 'monospace',
                  outline: 'none',
                }}
              />
              <button
                type="button"
                className="panel-standard-btn"
                onClick={handlePickMvnPath}
                style={{ padding: '6px 14px', fontSize: 12 }}
              >
                {t('envs.browseFileDoc')}
              </button>
              {config.customMvnPath && (
                <button
                  type="button"
                  className="panel-standard-btn"
                  onClick={() => {
                    updateConfig((prev) => ({ ...prev, customMvnPath: '' }));
                    onShowToast?.(t('envs.clearedMavenPath'), undefined, 'info');
                  }}
                  style={{ padding: '6px 10px', fontSize: 12 }}
                  title={t('envs.clearCustomPathTitle')}
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          {/* System Auto-detection Diagnostic Details */}
          <div
            style={{
              padding: '10px 14px',
              borderRadius: 8,
              background: 'var(--bg-card, rgba(0, 0, 0, 0.15))',
              border: '1px solid var(--border)',
              fontSize: 12,
              lineHeight: 1.7,
            }}
          >
            <div style={{ fontWeight: 600, color: 'var(--text-bright)', marginBottom: 4 }}>
              {t('envs.detectDiagTitle')}
            </div>
            <div style={{ color: 'var(--muted)' }}>
              {t('envs.executablePath')}
              <span style={{ color: 'var(--accent)', fontFamily: 'monospace' }}>
                {mavenEnv?.executablePath || t('envs.notDetected')}
              </span>
            </div>
            {mavenEnv?.mavenVersion && (
              <div style={{ color: 'var(--muted)' }}>
                {t('envs.mavenVersion')}
                <span style={{ color: 'var(--text-bright)' }}>{mavenEnv.mavenVersion}</span>
              </div>
            )}
            {mavenEnv?.detail && (
              <div style={{ color: 'var(--muted)', fontSize: 11.5, marginTop: 2 }}>
                {t('envs.detailLabel')}
                {mavenEnv.detail}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ─── TAB 3: RUNTIME ARGUMENTS (VM OPTIONS & ENV) ─── */}
      {subTab === 'runtime' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div
            style={{
              padding: '14px 18px',
              borderRadius: 8,
              background: 'var(--bg-card, rgba(255, 255, 255, 0.03))',
              border: '1px solid var(--border)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 16 }}>⚡</span>
              <span style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--text-bright)' }}>
                {t('envs.runtimeTitle')}
              </span>
            </div>
            <p
              style={{
                fontSize: 12,
                color: 'var(--muted)',
                margin: '4px 0 16px 0',
                lineHeight: 1.5,
              }}
            >
              {t('envs.runtimeDesc')}
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* JVM 参数 */}
              <div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 5,
                  }}
                >
                  <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)' }}>
                    {t('envs.vmOptions')}
                  </label>
                  <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                    {t('envs.vmOptionsHint')}
                  </span>
                </div>
                <input
                  type="text"
                  value={runtimeConfig.vmArgs}
                  onChange={(e) => setRuntimeConfig({ ...runtimeConfig, vmArgs: e.target.value })}
                  placeholder={t('envs.vmOptionsPlaceholder')}
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    background: 'var(--bg-input, #18181b)',
                    border: '1px solid var(--border)',
                    borderRadius: 5,
                    color: 'var(--text-bright, #fff)',
                    padding: '8px 10px',
                    fontSize: 12,
                    fontFamily: 'var(--font-mono, monospace)',
                    outline: 'none',
                  }}
                />
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 6,
                    marginTop: 6,
                    alignItems: 'center',
                  }}
                >
                  <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                    {t('envs.commonExamples')}
                  </span>
                  {[
                    '-Denv=local-dev',
                    '-Dfile.encoding=UTF-8',
                    '-Xmx1024m',
                    '-Dspring.profiles.active=dev',
                  ].map((flag) => (
                    <button
                      key={flag}
                      type="button"
                      onClick={() => {
                        const cur = runtimeConfig.vmArgs.trim();
                        const next = cur ? (cur.includes(flag) ? cur : `${cur} ${flag}`) : flag;
                        setRuntimeConfig({ ...runtimeConfig, vmArgs: next });
                      }}
                      style={{
                        fontSize: 10.5,
                        padding: '2px 6px',
                        borderRadius: 3,
                        background: 'rgba(255, 255, 255, 0.05)',
                        border: '1px solid rgba(255, 255, 255, 0.1)',
                        color: 'var(--text)',
                        cursor: 'pointer',
                      }}
                    >
                      + {flag}
                    </button>
                  ))}
                </div>
              </div>

              {/* 程序参数 */}
              <div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 5,
                  }}
                >
                  <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)' }}>
                    {t('envs.programArgs')}
                  </label>
                  <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                    {t('envs.programArgsHint')}
                  </span>
                </div>
                <input
                  type="text"
                  value={runtimeConfig.programArgs}
                  onChange={(e) =>
                    setRuntimeConfig({ ...runtimeConfig, programArgs: e.target.value })
                  }
                  placeholder={t('envs.programArgsPlaceholder')}
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    background: 'var(--bg-input, #18181b)',
                    border: '1px solid var(--border)',
                    borderRadius: 5,
                    color: 'var(--text-bright, #fff)',
                    padding: '8px 10px',
                    fontSize: 12,
                    fontFamily: 'var(--font-mono, monospace)',
                    outline: 'none',
                  }}
                />
              </div>

              {/* 环境变量与 Maven Profile */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label
                    style={{
                      display: 'block',
                      fontSize: 12,
                      fontWeight: 600,
                      color: 'var(--text-bright)',
                      marginBottom: 5,
                    }}
                  >
                    {t('envs.envVars')}
                  </label>
                  <input
                    type="text"
                    value={runtimeConfig.envVars}
                    onChange={(e) =>
                      setRuntimeConfig({ ...runtimeConfig, envVars: e.target.value })
                    }
                    placeholder={t('envs.envVarsPlaceholder')}
                    style={{
                      width: '100%',
                      boxSizing: 'border-box',
                      background: 'var(--bg-input, #18181b)',
                      border: '1px solid var(--border)',
                      borderRadius: 5,
                      color: 'var(--text-bright, #fff)',
                      padding: '8px 10px',
                      fontSize: 12,
                      fontFamily: 'var(--font-mono, monospace)',
                      outline: 'none',
                    }}
                  />
                </div>

                <div>
                  <label
                    style={{
                      display: 'block',
                      fontSize: 12,
                      fontWeight: 600,
                      color: 'var(--text-bright)',
                      marginBottom: 5,
                    }}
                  >
                    {t('envs.activeProfile')}
                  </label>
                  <input
                    type="text"
                    value={runtimeConfig.activeProfiles}
                    onChange={(e) =>
                      setRuntimeConfig({ ...runtimeConfig, activeProfiles: e.target.value })
                    }
                    placeholder={t('envs.activeProfilePlaceholder')}
                    style={{
                      width: '100%',
                      boxSizing: 'border-box',
                      background: 'var(--bg-input, #18181b)',
                      border: '1px solid var(--border)',
                      borderRadius: 5,
                      color: 'var(--text-bright, #fff)',
                      padding: '8px 10px',
                      fontSize: 12,
                      fontFamily: 'var(--font-mono, monospace)',
                      outline: 'none',
                    }}
                  />
                </div>
              </div>

              {/* 高级运行选项 (融入图 3 选项) */}
              <div
                style={{
                  background: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: '12px 14px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-bright)' }}>
                  {t('envs.runOptions')}
                </div>

                {/* 核心选项：Add dependencies with "provided" scope to classpath */}
                <div
                  style={{
                    border: '1px solid rgba(239, 68, 68, 0.35)',
                    background: 'rgba(239, 68, 68, 0.05)',
                    borderRadius: 6,
                    padding: '8px 12px',
                  }}
                >
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 10,
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={runtimeConfig.addProvidedToClasspath}
                      onChange={(e) =>
                        setRuntimeConfig({
                          ...runtimeConfig,
                          addProvidedToClasspath: e.target.checked,
                        })
                      }
                      style={{ marginTop: 2 }}
                    />
                    <div>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          fontSize: 12,
                          fontWeight: 600,
                          color: '#fca5a5',
                        }}
                      >
                        <span>{t('envs.providedScope')}</span>
                        <span
                          style={{
                            fontSize: 10,
                            background: '#ef4444',
                            color: '#fff',
                            padding: '1px 5px',
                            borderRadius: 3,
                          }}
                        >
                          {t('envs.recommendedOn')}
                        </span>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                        {t('envs.providedScopeDesc')}
                      </div>
                    </div>
                  </label>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 11.5,
                      padding: '6px 10px',
                      borderRadius: 5,
                      background: 'rgba(255, 255, 255, 0.04)',
                      border: '1px solid var(--border)',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={runtimeConfig.skipBuildBeforeRun}
                      onChange={(e) =>
                        setRuntimeConfig({ ...runtimeConfig, skipBuildBeforeRun: e.target.checked })
                      }
                    />
                    <div>
                      <div style={{ color: 'var(--text-bright)' }}>{t('envs.skipBuild')}</div>
                      <div style={{ fontSize: 10, color: 'var(--muted)' }}>
                        {t('envs.skipBuildDesc')}
                      </div>
                    </div>
                  </label>

                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 11.5,
                      padding: '6px 10px',
                      borderRadius: 5,
                      background: 'rgba(255, 255, 255, 0.04)',
                      border: '1px solid var(--border)',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={runtimeConfig.allowMultipleInstances}
                      onChange={(e) =>
                        setRuntimeConfig({
                          ...runtimeConfig,
                          allowMultipleInstances: e.target.checked,
                        })
                      }
                    />
                    <div>
                      <div style={{ color: 'var(--text-bright)' }}>{t('envs.allowMulti')}</div>
                      <div style={{ fontSize: 10, color: 'var(--muted)' }}>
                        {t('envs.allowMultiDesc')}
                      </div>
                    </div>
                  </label>

                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 11.5,
                      padding: '6px 10px',
                      borderRadius: 5,
                      background: 'rgba(255, 255, 255, 0.04)',
                      border: '1px solid var(--border)',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={runtimeConfig.saveConsoleToFile}
                      onChange={(e) =>
                        setRuntimeConfig({ ...runtimeConfig, saveConsoleToFile: e.target.checked })
                      }
                    />
                    <div>
                      <div style={{ color: 'var(--text-bright)' }}>{t('envs.saveConsole')}</div>
                      <div style={{ fontSize: 10, color: 'var(--muted)' }}>
                        {t('envs.saveConsoleDesc')}
                      </div>
                    </div>
                  </label>

                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 11.5,
                      padding: '6px 10px',
                      borderRadius: 5,
                      background: 'rgba(255, 255, 255, 0.04)',
                      border: '1px solid var(--border)',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={runtimeConfig.showSettingsBeforeRun}
                      onChange={(e) =>
                        setRuntimeConfig({
                          ...runtimeConfig,
                          showSettingsBeforeRun: e.target.checked,
                        })
                      }
                    />
                    <div>
                      <div style={{ color: 'var(--text-bright)' }}>{t('envs.showBeforeRun')}</div>
                      <div style={{ fontSize: 10, color: 'var(--muted)' }}>
                        {t('envs.showBeforeRunDesc')}
                      </div>
                    </div>
                  </label>
                </div>
              </div>

              {/* 保存按钮 */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
                <button
                  type="button"
                  className="panel-standard-btn primary"
                  onClick={() => {
                    saveProjectRuntimeConfig(runtimeConfig, workspace);
                    onShowToast?.(t('envs.runtimeSaved'), t('envs.runtimeSavedDetail'), 'success');
                  }}
                  style={{
                    fontSize: 12,
                    padding: '6px 18px',
                    background: '#22c55e',
                    borderColor: '#22c55e',
                    color: '#fff',
                  }}
                >
                  {t('envs.saveRuntimeArgs')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─── TAB 4: C/C++ TOOLCHAIN & DEBUGGING ─── */}
      {subTab === 'cpp' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* C/C++ 概览横幅卡片 */}
          <div
            style={{
              padding: '16px 20px',
              borderRadius: 8,
              background:
                'linear-gradient(135deg, rgba(59, 130, 246, 0.08) 0%, rgba(147, 51, 234, 0.05) 100%)',
              border: '1px solid rgba(59, 130, 246, 0.2)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 16 }}>🚀</span>
                <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-bright, #fff)' }}>
                  {t('envs.cppTitle')}
                </span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
                {t('envs.cppDesc')}
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                type="button"
                className="panel-standard-btn"
                onClick={detectAllToolchains}
                disabled={detectingMulti}
                style={{ fontSize: 12, padding: '6px 14px' }}
              >
                {detectingMulti ? t('envs.detecting') : t('envs.rediagnose')}
              </button>
            </div>
          </div>

          {/* 工具链四件套卡片网格 */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 14,
            }}
          >
            {/* 1. 编译器 (Compiler) */}
            <div
              style={{
                padding: '14px 16px',
                borderRadius: 8,
                background: 'var(--bg-card, rgba(255, 255, 255, 0.03))',
                border: '1px solid var(--border)',
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
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontWeight: 600,
                    fontSize: 13,
                    color: '#fff',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span>⚙️</span>
                  <span>{t('envs.cppCompiler')}</span>
                </div>
                <span
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 4,
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                    background: cppToolchain?.compiler.installed
                      ? 'rgba(34, 197, 94, 0.15)'
                      : 'rgba(239, 68, 68, 0.15)',
                    color: cppToolchain?.compiler.installed ? '#4ade80' : '#f87171',
                  }}
                >
                  {cppToolchain?.compiler.installed ? t('envs.ready') : t('envs.notInstalled')}
                </span>
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  color: 'var(--muted)',
                  fontFamily: 'monospace',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {t('envs.cmdLabel')}
                {cppToolchain?.compiler.command || 'clang++ / g++'}
              </div>
              {cppToolchain?.compiler.installed ? (
                <>
                  <div
                    style={{
                      fontSize: 11.5,
                      color: '#d4d4d8',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {t('envs.versionLabel')}
                    {cppToolchain.compiler.version}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--muted)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={cppToolchain.compiler.path}
                  >
                    {t('envs.pathLabel')}
                    {cppToolchain.compiler.path}
                  </div>
                </>
              ) : (
                <div
                  style={{
                    fontSize: 11,
                    color: '#f87171',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t('envs.recommendInstallLabel')}
                  {cppToolchain?.compiler.installGuide || 'xcode-select --install'}
                </div>
              )}
            </div>

            {/* 2. Clangd 语言服务 (LSP) */}
            <div
              style={{
                padding: '14px 16px',
                borderRadius: 8,
                background: 'var(--bg-card, rgba(255, 255, 255, 0.03))',
                border: '1px solid var(--border)',
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
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontWeight: 600,
                    fontSize: 13,
                    color: '#fff',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span>🧠</span>
                  <span>{t('envs.clangd')}</span>
                </div>
                <span
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 4,
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                    background: cppToolchain?.clangd.installed
                      ? 'rgba(34, 197, 94, 0.15)'
                      : 'rgba(239, 68, 68, 0.15)',
                    color: cppToolchain?.clangd.installed ? '#4ade80' : '#f87171',
                  }}
                >
                  {cppToolchain?.clangd.installed ? t('envs.ready') : t('envs.notInstalled')}
                </span>
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  color: 'var(--muted)',
                  fontFamily: 'monospace',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {t('envs.cmdLabel')}
                {cppToolchain?.clangd.command || 'clangd'}
              </div>
              {cppToolchain?.clangd.installed ? (
                <>
                  <div
                    style={{
                      fontSize: 11.5,
                      color: '#d4d4d8',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {t('envs.versionLabel')}
                    {cppToolchain.clangd.version}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--muted)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={cppToolchain.clangd.path}
                  >
                    {t('envs.pathLabel')}
                    {cppToolchain.clangd.path}
                  </div>
                </>
              ) : (
                <div
                  style={{
                    fontSize: 11,
                    color: '#f87171',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t('envs.recommendInstallLabel')}
                  {cppToolchain?.clangd.installGuide || 'brew install llvm'}
                </div>
              )}
            </div>

            {/* 3. 调试器引擎 (Debugger) */}
            <div
              style={{
                padding: '14px 16px',
                borderRadius: 8,
                background: 'var(--bg-card, rgba(255, 255, 255, 0.03))',
                border: '1px solid var(--border)',
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
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontWeight: 600,
                    fontSize: 13,
                    color: '#fff',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span>🪲</span>
                  <span>{t('envs.lldbDap')}</span>
                </div>
                <span
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 4,
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                    background: cppToolchain?.debugger.installed
                      ? 'rgba(34, 197, 94, 0.15)'
                      : 'rgba(239, 68, 68, 0.15)',
                    color: cppToolchain?.debugger.installed ? '#4ade80' : '#f87171',
                  }}
                >
                  {cppToolchain?.debugger.installed ? t('envs.ready') : t('envs.notInstalled')}
                </span>
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  color: 'var(--muted)',
                  fontFamily: 'monospace',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {t('envs.cmdLabel')}
                {cppToolchain?.debugger.command || 'lldb-dap'}
              </div>
              {cppToolchain?.debugger.installed ? (
                <>
                  <div
                    style={{
                      fontSize: 11.5,
                      color: '#d4d4d8',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {t('envs.versionLabel')}
                    {cppToolchain.debugger.version}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--muted)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={cppToolchain.debugger.path}
                  >
                    {t('envs.pathLabel')}
                    {cppToolchain.debugger.path}
                  </div>
                </>
              ) : (
                <div
                  style={{
                    fontSize: 11,
                    color: '#f87171',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t('envs.recommendInstallLabel')}
                  {cppToolchain?.debugger.installGuide || 'xcode-select --install'}
                </div>
              )}
            </div>

            {/* 4. CMake 构建系统 (CMake) */}
            <div
              style={{
                padding: '14px 16px',
                borderRadius: 8,
                background: 'var(--bg-card, rgba(255, 255, 255, 0.03))',
                border: '1px solid var(--border)',
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
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontWeight: 600,
                    fontSize: 13,
                    color: '#fff',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span>🏗️</span>
                  <span>{t('envs.cmake')}</span>
                </div>
                <span
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 4,
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                    background: cppToolchain?.cmake.installed
                      ? 'rgba(34, 197, 94, 0.15)'
                      : 'rgba(239, 68, 68, 0.15)',
                    color: cppToolchain?.cmake.installed ? '#4ade80' : '#f87171',
                  }}
                >
                  {cppToolchain?.cmake.installed ? t('envs.ready') : t('envs.notInstalled')}
                </span>
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  color: 'var(--muted)',
                  fontFamily: 'monospace',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {t('envs.cmdLabel')}
                {cppToolchain?.cmake.command || 'cmake'}
              </div>
              {cppToolchain?.cmake.installed ? (
                <>
                  <div
                    style={{
                      fontSize: 11.5,
                      color: '#d4d4d8',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {t('envs.versionLabel')}
                    {cppToolchain.cmake.version}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--muted)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={cppToolchain.cmake.path}
                  >
                    {t('envs.pathLabel')}
                    {cppToolchain.cmake.path}
                  </div>
                </>
              ) : (
                <div
                  style={{
                    fontSize: 11,
                    color: '#f87171',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t('envs.recommendInstallLabel')}
                  {cppToolchain?.cmake.installGuide || 'brew install cmake'}
                </div>
              )}
            </div>
          </div>

          {/* C++ 核心特性卡片 */}
          <div
            style={{
              padding: '16px',
              borderRadius: 8,
              background: 'var(--bg-card, rgba(255, 255, 255, 0.03))',
              border: '1px solid var(--border)',
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 13, color: '#fff', marginBottom: 10 }}>
              {t('envs.cppGuideTitle')}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
              <div
                style={{
                  padding: '10px 12px',
                  background: 'rgba(255, 255, 255, 0.02)',
                  borderRadius: 6,
                }}
              >
                <div style={{ fontWeight: 600, color: '#93c5fd', marginBottom: 4 }}>
                  {t('envs.cppGuideShortcut')}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                  {t('envs.cppGuideShortcutDesc')}
                </div>
              </div>
              <div
                style={{
                  padding: '10px 12px',
                  background: 'rgba(255, 255, 255, 0.02)',
                  borderRadius: 6,
                }}
              >
                <div style={{ fontWeight: 600, color: '#86efac', marginBottom: 4 }}>
                  {t('envs.cppGuideBreakpoint')}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                  {t('envs.cppGuideBreakpointDesc')}
                </div>
              </div>
              <div
                style={{
                  padding: '10px 12px',
                  background: 'rgba(255, 255, 255, 0.02)',
                  borderRadius: 6,
                }}
              >
                <div style={{ fontWeight: 600, color: '#fde047', marginBottom: 4 }}>
                  {t('envs.cppGuideCmake')}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                  {t('envs.cppGuideCmakeDesc')}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Python 工具链与调试环境 ── */}
      {subTab === 'python' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div
            style={{
              padding: '16px 20px',
              borderRadius: 8,
              background:
                'linear-gradient(135deg, rgba(234, 179, 8, 0.08) 0%, rgba(59, 130, 246, 0.05) 100%)',
              border: '1px solid rgba(234, 179, 8, 0.2)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 16 }}>🐍</span>
                <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-bright, #fff)' }}>
                  {t('envs.pyTitle')}
                </span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
                {t('envs.pyDesc')}
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                type="button"
                className="panel-standard-btn"
                onClick={detectAllToolchains}
                disabled={detectingMulti}
                style={{ fontSize: 12, padding: '6px 14px' }}
              >
                {detectingMulti ? t('envs.detecting') : t('envs.rediagnose')}
              </button>
            </div>
          </div>

          {/* Python 三件套卡片 */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 14,
            }}
          >
            {/* 解释器 */}
            <div
              style={{
                padding: '14px 16px',
                borderRadius: 8,
                background: 'var(--bg-card, rgba(255, 255, 255, 0.03))',
                border: '1px solid var(--border)',
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
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontWeight: 600,
                    fontSize: 13,
                    color: '#fff',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span>⚙️</span>
                  <span>{t('envs.pyInterpreter')}</span>
                </div>
                <span
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 4,
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                    background: multiToolchain?.python.interpreter.installed
                      ? 'rgba(34, 197, 94, 0.15)'
                      : 'rgba(239, 68, 68, 0.15)',
                    color: multiToolchain?.python.interpreter.installed ? '#4ade80' : '#f87171',
                  }}
                >
                  {multiToolchain?.python.interpreter.installed
                    ? t('envs.ready')
                    : t('envs.notInstalled')}
                </span>
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  color: 'var(--muted)',
                  fontFamily: 'monospace',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {t('envs.cmdLabel')}
                {multiToolchain?.python.interpreter.command || 'python3'}
              </div>
              {multiToolchain?.python.interpreter.installed ? (
                <>
                  <div
                    style={{
                      fontSize: 11.5,
                      color: '#d4d4d8',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {t('envs.versionLabel')}
                    {multiToolchain.python.interpreter.version}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--muted)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={multiToolchain.python.interpreter.path}
                  >
                    {t('envs.pathLabel')}
                    {multiToolchain.python.interpreter.path}
                  </div>
                </>
              ) : (
                <div
                  style={{
                    fontSize: 11,
                    color: '#f87171',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t('envs.recommendInstallLabel')}
                  {multiToolchain?.python.interpreter.installGuide || 'brew install python'}
                </div>
              )}
            </div>

            {/* Debugpy */}
            <div
              style={{
                padding: '14px 16px',
                borderRadius: 8,
                background: 'var(--bg-card, rgba(255, 255, 255, 0.03))',
                border: '1px solid var(--border)',
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
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontWeight: 600,
                    fontSize: 13,
                    color: '#fff',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span>🐞</span>
                  <span>{t('envs.pyDebugpy')}</span>
                </div>
                <span
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 4,
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                    background: multiToolchain?.python.debugpy.installed
                      ? 'rgba(34, 197, 94, 0.15)'
                      : 'rgba(239, 68, 68, 0.15)',
                    color: multiToolchain?.python.debugpy.installed ? '#4ade80' : '#f87171',
                  }}
                >
                  {multiToolchain?.python.debugpy.installed
                    ? t('envs.ready')
                    : t('envs.recommendInstall')}
                </span>
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  color: 'var(--muted)',
                  fontFamily: 'monospace',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {t('envs.moduleLabel')}python3 -m debugpy (Port: 5678)
              </div>
              {multiToolchain?.python.debugpy.installed ? (
                <>
                  <div
                    style={{
                      fontSize: 11.5,
                      color: '#d4d4d8',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {t('envs.statusLabel')}
                    {t('envs.statusReadyDap')}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--muted)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={multiToolchain.python.debugpy.path}
                  >
                    {t('envs.pathLabel')}
                    {multiToolchain.python.debugpy.path || t('envs.moduleLevelLoad')}
                  </div>
                </>
              ) : (
                <div
                  style={{
                    fontSize: 11,
                    color: '#f87171',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t('envs.installCmdLabel')}
                  {multiToolchain?.python.debugpy.installGuide || 'python3 -m pip install debugpy'}
                </div>
              )}
            </div>

            {/* Pip */}
            <div
              style={{
                padding: '14px 16px',
                borderRadius: 8,
                background: 'var(--bg-card, rgba(255, 255, 255, 0.03))',
                border: '1px solid var(--border)',
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
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontWeight: 600,
                    fontSize: 13,
                    color: '#fff',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span>📦</span>
                  <span>{t('envs.pip')}</span>
                </div>
                <span
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 4,
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                    background: multiToolchain?.python.pip.installed
                      ? 'rgba(34, 197, 94, 0.15)'
                      : 'rgba(239, 68, 68, 0.15)',
                    color: multiToolchain?.python.pip.installed ? '#4ade80' : '#f87171',
                  }}
                >
                  {multiToolchain?.python.pip.installed ? t('envs.ready') : t('envs.notInstalled')}
                </span>
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  color: 'var(--muted)',
                  fontFamily: 'monospace',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {t('envs.cmdLabel')}
                {multiToolchain?.python.pip.command || 'pip3'}
              </div>
              {multiToolchain?.python.pip.installed ? (
                <>
                  <div
                    style={{
                      fontSize: 11.5,
                      color: '#d4d4d8',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {t('envs.versionLabel')}
                    {multiToolchain.python.pip.version}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--muted)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={multiToolchain.python.pip.path}
                  >
                    {t('envs.pathLabel')}
                    {multiToolchain.python.pip.path}
                  </div>
                </>
              ) : (
                <div
                  style={{
                    fontSize: 11,
                    color: '#f87171',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t('envs.recommendGuideLabel')}
                  {multiToolchain?.python.pip.installGuide}
                </div>
              )}
            </div>
          </div>

          {/* Python 快捷指引 */}
          <div
            style={{
              padding: '16px',
              borderRadius: 8,
              background: 'var(--bg-card, rgba(255, 255, 255, 0.03))',
              border: '1px solid var(--border)',
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 13, color: '#fff', marginBottom: 10 }}>
              {t('envs.pyGuideTitle')}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
              <div
                style={{
                  padding: '10px 12px',
                  background: 'rgba(255, 255, 255, 0.02)',
                  borderRadius: 6,
                }}
              >
                <div style={{ fontWeight: 600, color: '#fde047', marginBottom: 4 }}>
                  {t('envs.pyGuideVenv')}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                  {t('envs.pyGuideVenvDesc')}
                </div>
              </div>
              <div
                style={{
                  padding: '10px 12px',
                  background: 'rgba(255, 255, 255, 0.02)',
                  borderRadius: 6,
                }}
              >
                <div style={{ fontWeight: 600, color: '#86efac', marginBottom: 4 }}>
                  {t('envs.pyGuideBreakpoint')}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                  {t('envs.pyGuideBreakpointDesc')}
                </div>
              </div>
              <div
                style={{
                  padding: '10px 12px',
                  background: 'rgba(255, 255, 255, 0.02)',
                  borderRadius: 6,
                }}
              >
                <div style={{ fontWeight: 600, color: '#93c5fd', marginBottom: 4 }}>
                  {t('envs.pyGuideTests')}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                  {t('envs.pyGuideTestsDesc')}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Go 工具链与调试环境 ── */}
      {subTab === 'go' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div
            style={{
              padding: '16px 20px',
              borderRadius: 8,
              background:
                'linear-gradient(135deg, rgba(6, 182, 212, 0.08) 0%, rgba(59, 130, 246, 0.05) 100%)',
              border: '1px solid rgba(6, 182, 212, 0.2)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 16 }}>🐹</span>
                <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-bright, #fff)' }}>
                  {t('envs.goTitle')}
                </span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
                {t('envs.goDesc')}
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                type="button"
                className="panel-standard-btn"
                onClick={detectAllToolchains}
                disabled={detectingMulti}
                style={{ fontSize: 12, padding: '6px 14px' }}
              >
                {detectingMulti ? t('envs.detecting') : t('envs.rediagnose')}
              </button>
            </div>
          </div>

          {/* Go 三件套卡片 */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 14,
            }}
          >
            {/* Go 编译器 */}
            <div
              style={{
                padding: '14px 16px',
                borderRadius: 8,
                background: 'var(--bg-card, rgba(255, 255, 255, 0.03))',
                border: '1px solid var(--border)',
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
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontWeight: 600,
                    fontSize: 13,
                    color: '#fff',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span>⚙️</span>
                  <span>{t('envs.goCompiler')}</span>
                </div>
                <span
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 4,
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                    background: multiToolchain?.go.go.installed
                      ? 'rgba(34, 197, 94, 0.15)'
                      : 'rgba(239, 68, 68, 0.15)',
                    color: multiToolchain?.go.go.installed ? '#4ade80' : '#f87171',
                  }}
                >
                  {multiToolchain?.go.go.installed ? t('envs.ready') : t('envs.notInstalled')}
                </span>
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  color: 'var(--muted)',
                  fontFamily: 'monospace',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {t('envs.cmdLabel')}
                {multiToolchain?.go.go.command || 'go'}
              </div>
              {multiToolchain?.go.go.installed ? (
                <>
                  <div
                    style={{
                      fontSize: 11.5,
                      color: '#d4d4d8',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {t('envs.versionLabel')}
                    {multiToolchain.go.go.version}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--muted)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={multiToolchain.go.go.path}
                  >
                    {t('envs.pathLabel')}
                    {multiToolchain.go.go.path}
                  </div>
                </>
              ) : (
                <div
                  style={{
                    fontSize: 11,
                    color: '#f87171',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t('envs.recommendInstallLabel')}
                  {multiToolchain?.go.go.installGuide || 'brew install go'}
                </div>
              )}
            </div>

            {/* Delve 调试器 */}
            <div
              style={{
                padding: '14px 16px',
                borderRadius: 8,
                background: 'var(--bg-card, rgba(255, 255, 255, 0.03))',
                border: '1px solid var(--border)',
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
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontWeight: 600,
                    fontSize: 13,
                    color: '#fff',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span>🐞</span>
                  <span>{t('envs.delve')}</span>
                </div>
                <span
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 4,
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                    background: multiToolchain?.go.delve.installed
                      ? 'rgba(34, 197, 94, 0.15)'
                      : 'rgba(239, 68, 68, 0.15)',
                    color: multiToolchain?.go.delve.installed ? '#4ade80' : '#f87171',
                  }}
                >
                  {multiToolchain?.go.delve.installed ? t('envs.ready') : t('envs.notInstalled')}
                </span>
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  color: 'var(--muted)',
                  fontFamily: 'monospace',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {t('envs.cmdLabel')}dlv dap (Port: 2345)
              </div>
              {multiToolchain?.go.delve.installed ? (
                <>
                  <div
                    style={{
                      fontSize: 11.5,
                      color: '#d4d4d8',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {t('envs.versionLabel')}
                    {multiToolchain.go.delve.version}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--muted)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={multiToolchain.go.delve.path}
                  >
                    {t('envs.pathLabel')}
                    {multiToolchain.go.delve.path}
                  </div>
                </>
              ) : (
                <div
                  style={{
                    fontSize: 11,
                    color: '#f87171',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t('envs.installCmdLabel')}
                  {multiToolchain?.go.delve.installGuide}
                </div>
              )}
            </div>

            {/* Gopls 语言服务 */}
            <div
              style={{
                padding: '14px 16px',
                borderRadius: 8,
                background: 'var(--bg-card, rgba(255, 255, 255, 0.03))',
                border: '1px solid var(--border)',
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
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontWeight: 600,
                    fontSize: 13,
                    color: '#fff',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span>🧠</span>
                  <span>{t('envs.gopls')}</span>
                </div>
                <span
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 4,
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                    background: multiToolchain?.go.gopls.installed
                      ? 'rgba(34, 197, 94, 0.15)'
                      : 'rgba(239, 68, 68, 0.15)',
                    color: multiToolchain?.go.gopls.installed ? '#4ade80' : '#f87171',
                  }}
                >
                  {multiToolchain?.go.gopls.installed
                    ? t('envs.ready')
                    : t('envs.recommendInstall')}
                </span>
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  color: 'var(--muted)',
                  fontFamily: 'monospace',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {t('envs.cmdLabel')}
                {multiToolchain?.go.gopls.command || 'gopls'}
              </div>
              {multiToolchain?.go.gopls.installed ? (
                <>
                  <div
                    style={{
                      fontSize: 11.5,
                      color: '#d4d4d8',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {t('envs.versionLabel')}
                    {multiToolchain.go.gopls.version}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--muted)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={multiToolchain.go.gopls.path}
                  >
                    {t('envs.pathLabel')}
                    {multiToolchain.go.gopls.path}
                  </div>
                </>
              ) : (
                <div
                  style={{
                    fontSize: 11,
                    color: '#f87171',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t('envs.installCmdLabel')}
                  {multiToolchain?.go.gopls.installGuide}
                </div>
              )}
            </div>
          </div>

          {/* Go 快捷指引 */}
          <div
            style={{
              padding: '16px',
              borderRadius: 8,
              background: 'var(--bg-card, rgba(255, 255, 255, 0.03))',
              border: '1px solid var(--border)',
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 13, color: '#fff', marginBottom: 10 }}>
              {t('envs.goGuideTitle')}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
              <div
                style={{
                  padding: '10px 12px',
                  background: 'rgba(255, 255, 255, 0.02)',
                  borderRadius: 6,
                }}
              >
                <div style={{ fontWeight: 600, color: '#06b6d4', marginBottom: 4 }}>
                  {t('envs.goGuideModules')}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                  {t('envs.goGuideModulesDesc')}
                </div>
              </div>
              <div
                style={{
                  padding: '10px 12px',
                  background: 'rgba(255, 255, 255, 0.02)',
                  borderRadius: 6,
                }}
              >
                <div style={{ fontWeight: 600, color: '#86efac', marginBottom: 4 }}>
                  {t('envs.goGuideDelve')}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                  {t('envs.goGuideDelveDesc')}
                </div>
              </div>
              <div
                style={{
                  padding: '10px 12px',
                  background: 'rgba(255, 255, 255, 0.02)',
                  borderRadius: 6,
                }}
              >
                <div style={{ fontWeight: 600, color: '#fde047', marginBottom: 4 }}>
                  {t('envs.goGuideRun')}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                  {t('envs.goGuideRunDesc')}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Node.js / TypeScript 工具链 ── */}
      {subTab === 'node' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div
            style={{
              padding: '16px 20px',
              borderRadius: 8,
              background:
                'linear-gradient(135deg, rgba(34, 197, 94, 0.08) 0%, rgba(59, 130, 246, 0.05) 100%)',
              border: '1px solid rgba(34, 197, 94, 0.2)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 16 }}>🟢</span>
                <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-bright, #fff)' }}>
                  {t('envs.nodeTitle')}
                </span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
                {t('envs.nodeDesc')}
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                type="button"
                className="panel-standard-btn"
                onClick={detectAllToolchains}
                disabled={detectingMulti}
                style={{ fontSize: 12, padding: '6px 14px' }}
              >
                {detectingMulti ? t('envs.detecting') : t('envs.rediagnose')}
              </button>
            </div>
          </div>

          {/* Node 三件套卡片 */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 14,
            }}
          >
            {/* Node 运行时 */}
            <div
              style={{
                padding: '14px 16px',
                borderRadius: 8,
                background: 'var(--bg-card, rgba(255, 255, 255, 0.03))',
                border: '1px solid var(--border)',
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
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontWeight: 600,
                    fontSize: 13,
                    color: '#fff',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span>⚙️</span>
                  <span>{t('envs.nodeRuntime')}</span>
                </div>
                <span
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 4,
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                    background: multiToolchain?.node.node.installed
                      ? 'rgba(34, 197, 94, 0.15)'
                      : 'rgba(239, 68, 68, 0.15)',
                    color: multiToolchain?.node.node.installed ? '#4ade80' : '#f87171',
                  }}
                >
                  {multiToolchain?.node.node.installed ? t('envs.ready') : t('envs.notInstalled')}
                </span>
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  color: 'var(--muted)',
                  fontFamily: 'monospace',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {t('envs.cmdLabel')}
                {multiToolchain?.node.node.command || 'node'}
              </div>
              {multiToolchain?.node.node.installed ? (
                <>
                  <div
                    style={{
                      fontSize: 11.5,
                      color: '#d4d4d8',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {t('envs.versionLabel')}
                    {multiToolchain.node.node.version}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--muted)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={multiToolchain.node.node.path}
                  >
                    {t('envs.pathLabel')}
                    {multiToolchain.node.node.path}
                  </div>
                </>
              ) : (
                <div
                  style={{
                    fontSize: 11,
                    color: '#f87171',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t('envs.recommendInstallLabel')}
                  {multiToolchain?.node.node.installGuide || 'brew install node'}
                </div>
              )}
            </div>

            {/* NPM 包管理器 */}
            <div
              style={{
                padding: '14px 16px',
                borderRadius: 8,
                background: 'var(--bg-card, rgba(255, 255, 255, 0.03))',
                border: '1px solid var(--border)',
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
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontWeight: 600,
                    fontSize: 13,
                    color: '#fff',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span>📦</span>
                  <span>{t('envs.npm')}</span>
                </div>
                <span
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 4,
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                    background: multiToolchain?.node.npm.installed
                      ? 'rgba(34, 197, 94, 0.15)'
                      : 'rgba(239, 68, 68, 0.15)',
                    color: multiToolchain?.node.npm.installed ? '#4ade80' : '#f87171',
                  }}
                >
                  {multiToolchain?.node.npm.installed ? t('envs.ready') : t('envs.notInstalled')}
                </span>
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  color: 'var(--muted)',
                  fontFamily: 'monospace',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {t('envs.cmdLabel')}
                {multiToolchain?.node.npm.command || 'npm'}
              </div>
              {multiToolchain?.node.npm.installed ? (
                <>
                  <div
                    style={{
                      fontSize: 11.5,
                      color: '#d4d4d8',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {t('envs.versionLabel')}
                    {multiToolchain.node.npm.version}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--muted)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={multiToolchain.node.npm.path}
                  >
                    {t('envs.pathLabel')}
                    {multiToolchain.node.npm.path}
                  </div>
                </>
              ) : (
                <div
                  style={{
                    fontSize: 11,
                    color: '#f87171',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t('envs.recommendInstallLabel')}
                  {multiToolchain?.node.npm.installGuide}
                </div>
              )}
            </div>

            {/* TypeScript (tsc) */}
            <div
              style={{
                padding: '14px 16px',
                borderRadius: 8,
                background: 'var(--bg-card, rgba(255, 255, 255, 0.03))',
                border: '1px solid var(--border)',
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
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontWeight: 600,
                    fontSize: 13,
                    color: '#fff',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span>🔷</span>
                  <span>{t('envs.tsc')}</span>
                </div>
                <span
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 4,
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                    background: multiToolchain?.node.typescript.installed
                      ? 'rgba(34, 197, 94, 0.15)'
                      : 'rgba(239, 68, 68, 0.15)',
                    color: multiToolchain?.node.typescript.installed ? '#4ade80' : '#f87171',
                  }}
                >
                  {multiToolchain?.node.typescript.installed
                    ? t('envs.ready')
                    : t('envs.recommendGlobalInstall')}
                </span>
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  color: 'var(--muted)',
                  fontFamily: 'monospace',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {t('envs.cmdLabel')}
                {multiToolchain?.node.typescript.command || 'tsc'}
              </div>
              {multiToolchain?.node.typescript.installed ? (
                <>
                  <div
                    style={{
                      fontSize: 11.5,
                      color: '#d4d4d8',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {t('envs.versionLabel')}
                    {multiToolchain.node.typescript.version}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--muted)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={multiToolchain.node.typescript.path}
                  >
                    {t('envs.pathLabel')}
                    {multiToolchain.node.typescript.path}
                  </div>
                </>
              ) : (
                <div
                  style={{
                    fontSize: 11,
                    color: '#f87171',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t('envs.installCmdLabel')}
                  {multiToolchain?.node.typescript.installGuide || 'npm install -g typescript tsx'}
                </div>
              )}
            </div>
          </div>

          {/* Node 快捷指引 */}
          <div
            style={{
              padding: '16px',
              borderRadius: 8,
              background: 'var(--bg-card, rgba(255, 255, 255, 0.03))',
              border: '1px solid var(--border)',
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 13, color: '#fff', marginBottom: 10 }}>
              {t('envs.nodeGuideTitle')}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
              <div
                style={{
                  padding: '10px 12px',
                  background: 'rgba(255, 255, 255, 0.02)',
                  borderRadius: 6,
                }}
              >
                <div style={{ fontWeight: 600, color: '#86efac', marginBottom: 4 }}>
                  {t('envs.nodeGuideTsx')}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                  {t('envs.nodeGuideTsxDesc')}
                </div>
              </div>
              <div
                style={{
                  padding: '10px 12px',
                  background: 'rgba(255, 255, 255, 0.02)',
                  borderRadius: 6,
                }}
              >
                <div style={{ fontWeight: 600, color: '#93c5fd', marginBottom: 4 }}>
                  {t('envs.nodeGuideInspector')}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                  {t('envs.nodeGuideInspectorDesc')}
                </div>
              </div>
              <div
                style={{
                  padding: '10px 12px',
                  background: 'rgba(255, 255, 255, 0.02)',
                  borderRadius: 6,
                }}
              >
                <div style={{ fontWeight: 600, color: '#fde047', marginBottom: 4 }}>
                  {t('envs.nodeGuideScripts')}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                  {t('envs.nodeGuideScriptsDesc')}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

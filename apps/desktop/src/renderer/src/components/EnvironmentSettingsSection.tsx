import React, { useState, useEffect, useCallback } from 'react';
import type {
  MavenEnvironmentInfo,
  InstalledJdkInfo,
  OnlineJdkInfo,
  JdkInstallProgress,
  CppToolchainStatus,
} from '@deepseek-ide/shared';
import {
  loadProjectRuntimeConfig,
  saveProjectRuntimeConfig,
  type ProjectRuntimeConfig,
} from './ProjectRuntimeConfigModal';

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
      localStorage.getItem(key) ||
      (workspace ? localStorage.getItem(LS_MAVEN_CONFIG) : null);
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

interface EnvironmentSettingsSectionProps {
  workspace?: string;
  onShowToast?: (title: string, detail?: string, type?: 'success' | 'error' | 'info' | 'warn') => void;
}

export function EnvironmentSettingsSection({ workspace, onShowToast }: EnvironmentSettingsSectionProps) {
  const [subTab, setSubTab] = useState<'java' | 'maven' | 'cpp' | 'runtime'>('java');

  // Config state
  const [config, setConfig] = useState<EnvConfig>(() => loadEnvConfig(workspace));
  const [runtimeConfig, setRuntimeConfig] = useState<ProjectRuntimeConfig>(() =>
    loadProjectRuntimeConfig(workspace),
  );

  // C/C++ Toolchain State
  const [cppToolchain, setCppToolchain] = useState<CppToolchainStatus | null>(null);
  const [detectingCpp, setDetectingCpp] = useState(false);
  const [creatingCppTemplate, setCreatingCppTemplate] = useState(false);

  const detectCpp = useCallback(async () => {
    setDetectingCpp(true);
    try {
      if (window.ide?.cppCheckToolchain) {
        const res = await window.ide.cppCheckToolchain();
        setCppToolchain(res);
      }
    } catch (e) {
      console.error('Failed to check C++ toolchain:', e);
    } finally {
      setDetectingCpp(false);
    }
  }, []);

  useEffect(() => {
    if (subTab === 'cpp') {
      void detectCpp();
    }
  }, [subTab, detectCpp]);

  const handleCreateCppTemplate = async () => {
    setCreatingCppTemplate(true);
    try {
      if (!window.ide?.writeFile) return;

      await window.ide.writeFile(
        'CMakeLists.txt',
        `cmake_minimum_required(VERSION 3.15)\nproject(CppDemo VERSION 1.0.0 LANGUAGES CXX)\n\nset(CMAKE_CXX_STANDARD 17)\nset(CMAKE_CXX_STANDARD_REQUIRED ON)\nset(CMAKE_EXPORT_COMPILE_COMMANDS ON)\n\ninclude_directories(include)\n\nadd_executable(app src/main.cpp)\n`,
      );

      await window.ide.writeFile(
        'src/main.cpp',
        `#include <iostream>\n#include "demo.h"\n\nint main(int argc, char** argv) {\n    std::cout << "🚀 Hello Echoly C++ with Clangd & LLDB-DAP!" << std::endl;\n    demoGreeting();\n    return 0;\n}\n`,
      );

      await window.ide.writeFile(
        'include/demo.h',
        `#pragma once\n#include <iostream>\n\ninline void demoGreeting() {\n    std::cout << "✨ Header & Source switching working seamlessly!" << std::endl;\n}\n`,
      );

      await window.ide.writeFile(
        '.clang-format',
        `BasedOnStyle: Google\nIndentWidth: 4\nColumnLimit: 100\n`,
      );

      await window.ide.writeFile(
        '.gitignore',
        `build/\n.echoly/\n*.o\n*.out\n*.exe\n`,
      );

      onShowToast?.('C++ 工程模板创建成功', '已生成 CMakeLists.txt, src/main.cpp 等标准模板', 'success');
      // 触发文件树刷新
      window.dispatchEvent(new CustomEvent('echoly:refreshTree'));
    } catch (err: any) {
      onShowToast?.('创建模板失败', err?.message || String(err), 'error');
    } finally {
      setCreatingCppTemplate(false);
    }
  };

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
    onShowToast?.(`开始下载并安装 ${jdk.name}...`, undefined, 'info');
    try {
      const res = await window.ide.javaInstallOnlineJdk(jdk.id);
      if (res.success && res.javaHome) {
        onShowToast?.(`已成功安装 ${jdk.name}`, res.javaHome, 'success');
        updateConfig((prev) => ({
          ...prev,
          selectedJavaHome: res.javaHome!,
          selectedJavaLabel: `${jdk.name} (${res.javaHome})`,
        }));
        await loadJdks();
      } else {
        onShowToast?.('安装 JDK 失败', res.message || '请检查网络连接', 'error');
      }
    } catch (err: any) {
      onShowToast?.('安装异常', err?.message || String(err), 'error');
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
          selectedJavaLabel: `自定义: ${picked}`,
        }));
        onShowToast?.('已更新 JAVA_HOME', picked, 'success');
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
        onShowToast?.('已指定 Maven 执行路径', picked, 'success');
      }
    } catch {}
  };

  // Browse File for custom settings.xml
  const handlePickSettingsPath = async () => {
    try {
      const picked = await window.ide.pickFile?.([{ name: 'Maven settings.xml', extensions: ['xml'] }]);
      if (picked) {
        updateConfig((prev) => ({
          ...prev,
          customSettingsPath: picked,
        }));
        onShowToast?.('已指定 Maven settings.xml 路径', picked, 'success');
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
        onShowToast?.('Maven Wrapper 就绪', res.message, 'success');
        await detectMaven();
      } else {
        onShowToast?.('生成 Wrapper 失败', res.message, 'error');
      }
    } catch (err: any) {
      onShowToast?.('生成失败', err?.message || String(err), 'error');
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
          onShowToast?.('settings.xml 初始化成功', res.message, 'success');
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
      onShowToast?.(
        'settings.xml 初始化成功',
        '已成功在当前工作区生成 .mvn/settings.xml（预配置阿里云镜像源加速）！',
        'success',
      );
    } catch (err: any) {
      onShowToast?.('操作异常', err?.message || String(err), 'error');
    } finally {
      setGeneratingSettings(false);
    }
  };

  // Active JDK status label
  const activeJavaDisplay = config.selectedJavaHome
    ? config.selectedJavaLabel || config.selectedJavaHome
    : mavenEnv?.hasJava
    ? '系统默认 Java (自动探测就绪)'
    : '未配置 Java 环境';

  return (
    <div className="settings-panel-section" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Title Bar */}
      <div className="panel-title-bar">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h3 className="panel-h3" style={{ margin: 0 }}>开发与构建环境配置</h3>
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
            管理项目 Java (JDK) 版本与在线安装，配置 Maven 运行模式、Wrapper 与 settings.xml 配置文件
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
              当前环境与构建配置已绑定至项目: <strong>{workspace.split('/').pop()}</strong>
              <span style={{ opacity: 0.75, marginLeft: 6 }}>({workspace})</span>
            </span>
          </div>
          <div style={{ fontSize: 11, color: '#34d399', display: 'flex', alignItems: 'center', gap: 4 }}>
            <span>✓</span> 独立项目级配置生效中
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
          🌐 当前为全局默认环境配置（未打开特定项目工作区）
        </div>
      )}

      {/* Sub-nav toggle buttons (Theme-adapted) */}
      <div
        style={{
          display: 'flex',
          gap: 8,
          borderBottom: '1px solid var(--border)',
          paddingBottom: 8,
        }}
      >
        <button
          type="button"
          onClick={() => setSubTab('java')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '7px 16px',
            borderRadius: 6,
            border: '1px solid',
            borderColor: subTab === 'java' ? 'var(--accent, #3b82f6)' : 'transparent',
            background: subTab === 'java' ? 'var(--bg-hover, rgba(59, 130, 246, 0.12))' : 'transparent',
            color: subTab === 'java' ? 'var(--text-bright, #fff)' : 'var(--text)',
            fontSize: 12.5,
            fontWeight: subTab === 'java' ? 600 : 400,
            cursor: 'pointer',
            transition: 'all 0.15s ease',
          }}
        >
          <span>☕</span>
          <span>Java (JDK) 环境</span>
        </button>

        <button
          type="button"
          onClick={() => setSubTab('maven')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '7px 16px',
            borderRadius: 6,
            border: '1px solid',
            borderColor: subTab === 'maven' ? 'var(--accent, #3b82f6)' : 'transparent',
            background: subTab === 'maven' ? 'var(--bg-hover, rgba(59, 130, 246, 0.12))' : 'transparent',
            color: subTab === 'maven' ? 'var(--text-bright, #fff)' : 'var(--text)',
            fontSize: 12.5,
            fontWeight: subTab === 'maven' ? 600 : 400,
            cursor: 'pointer',
            transition: 'all 0.15s ease',
          }}
        >
          <span>🛠️</span>
          <span>Maven 构建工具 &amp; settings.xml</span>
        </button>

        <button
          type="button"
          onClick={() => setSubTab('cpp')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '7px 16px',
            borderRadius: 6,
            border: '1px solid',
            borderColor: subTab === 'cpp' ? 'var(--accent, #3b82f6)' : 'transparent',
            background: subTab === 'cpp' ? 'var(--bg-hover, rgba(59, 130, 246, 0.12))' : 'transparent',
            color: subTab === 'cpp' ? 'var(--text-bright, #fff)' : 'var(--text)',
            fontSize: 12.5,
            fontWeight: subTab === 'cpp' ? 600 : 400,
            cursor: 'pointer',
            transition: 'all 0.15s ease',
          }}
        >
          <span>🚀</span>
          <span>C/C++ 工具链 &amp; 调试环境</span>
        </button>

        <button
          type="button"
          onClick={() => setSubTab('runtime')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '7px 16px',
            borderRadius: 6,
            border: '1px solid',
            borderColor: subTab === 'runtime' ? 'var(--accent, #3b82f6)' : 'transparent',
            background: subTab === 'runtime' ? 'var(--bg-hover, rgba(59, 130, 246, 0.12))' : 'transparent',
            color: subTab === 'runtime' ? 'var(--text-bright, #fff)' : 'var(--text)',
            fontSize: 12.5,
            fontWeight: subTab === 'runtime' ? 600 : 400,
            cursor: 'pointer',
            transition: 'all 0.15s ease',
          }}
        >
          <span>⚡</span>
          <span>全局运行时参数 (VM Options)</span>
        </button>
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
                    background: config.selectedJavaHome || mavenEnv?.hasJava ? '#10b981' : '#f43f5e',
                    boxShadow: config.selectedJavaHome || mavenEnv?.hasJava ? '0 0 8px #10b981' : 'none',
                  }}
                />
                <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  当前选定执行的 JAVA (JDK)
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
                title={config.selectedJavaHome || '系统默认'}
              >
                {activeJavaDisplay}
              </div>
              {config.selectedJavaHome && (
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, fontFamily: 'monospace' }}>
                  JAVA_HOME = {config.selectedJavaHome}
                </div>
              )}
            </div>

            {config.selectedJavaHome && (
              <button
                type="button"
                className="panel-standard-btn"
                onClick={() => {
                  updateConfig((prev) => ({ ...prev, selectedJavaHome: '', selectedJavaLabel: '' }));
                  onShowToast?.('已切换回系统默认 Java 环境', undefined, 'info');
                }}
                style={{ padding: '4px 10px', fontSize: 11.5 }}
              >
                恢复为系统默认
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
                        官方主流 Java (JDK) 在线一键安装
                      </span>
                      <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                        (下载官方发行包并解压至用户专属目录 ~/.echoly/jdks)
                      </span>
                    </div>

                    {/* 更多主流版本下拉菜单与平铺切换 */}
                    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8 }}>
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
                          title="选择更多主流 Java 发行版 (Amazon Corretto, Azul Zulu, GraalVM, Java 22 等)"
                        >
                          <span>更多主流版本 ({moreJdks.length})</span>
                          <span style={{ fontSize: 10, opacity: 0.7 }}>{showMoreJdkMenu ? '▲' : '▼'}</span>
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
                            <span style={{ fontWeight: 600, fontSize: 12, color: 'var(--text-bright)' }}>
                              可选的更多官方主流 JDK
                            </span>
                            <button
                              type="button"
                              className="panel-action-btn"
                              onClick={() => setShowMoreJdkMenu(false)}
                              title="关闭"
                              style={{ width: 20, height: 20, fontSize: 12 }}
                            >
                              ×
                            </button>
                          </div>

                          {moreJdks.map((jdk) => {
                            const prog = installProgress[jdk.id];
                            const isInstallingThis = installingId === jdk.id;
                            const isInstalled =
                              Boolean(jdk.isInstalled) ||
                              installedJdks.some((i) => i.id === jdk.id || i.version.startsWith(jdk.version));
                            const isSelected =
                              config.selectedJavaHome &&
                              (config.selectedJavaHome === jdk.installedPath ||
                                (jdk.installedPath && config.selectedJavaHome.startsWith(jdk.installedPath)));

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
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                  <div>
                                    <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--text-bright)' }}>
                                      {jdk.name}
                                    </div>
                                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                                      {jdk.vendor} · ~{jdk.sizeMb}MB
                                    </div>
                                  </div>
                                  <div>
                                    {isInstallingThis ? (
                                      <span style={{ fontSize: 11, color: 'var(--accent)' }}>
                                        {prog?.status === 'extracting' ? '解压中...' : `${prog?.percent || 0}%`}
                                      </span>
                                    ) : isSelected ? (
                                      <span style={{ fontSize: 11, color: '#10b981', fontWeight: 600 }}>使用中</span>
                                    ) : isInstalled ? (
                                      <button
                                        type="button"
                                        className="panel-standard-btn"
                                        style={{ padding: '2px 8px', fontSize: 11 }}
                                        onClick={() => {
                                          const match = installedJdks.find(
                                            (i) => i.id === jdk.id || i.version.startsWith(jdk.version),
                                          );
                                          const targetPath = jdk.installedPath || match?.path;
                                          if (targetPath) {
                                            updateConfig((prev) => ({
                                              ...prev,
                                              selectedJavaHome: targetPath,
                                              selectedJavaLabel: jdk.name,
                                            }));
                                            onShowToast?.(`已选定使用 ${jdk.name}`, targetPath, 'success');
                                            setShowMoreJdkMenu(false);
                                          }
                                        }}
                                      >
                                        切换
                                      </button>
                                    ) : (
                                      <button
                                        type="button"
                                        className="panel-standard-btn primary"
                                        style={{ padding: '2px 8px', fontSize: 11 }}
                                        disabled={Boolean(installingId)}
                                        onClick={() => void handleInstallJdk(jdk)}
                                      >
                                        一键安装
                                      </button>
                                    )}
                                  </div>
                                </div>
                                <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.35 }}>
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
                              {showAllJdks ? '恢复精简展示 (仅核心4款)' : '平铺展示全部版本卡片'}
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
                        installedJdks.some((i) => i.id === jdk.id || i.version.startsWith(jdk.version));
                      const isSelected =
                        config.selectedJavaHome &&
                        (config.selectedJavaHome === jdk.installedPath ||
                          (jdk.installedPath && config.selectedJavaHome.startsWith(jdk.installedPath)));

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
                                <span style={{ fontWeight: 600, fontSize: 12.5, color: 'var(--text-bright)' }}>
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
                                    推荐
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
                                <span>下载中... {prog.percent}%</span>
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
                              📦 正在解压并配置环境变量...
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
                                  ✓ 当前执行版本
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
                                    onShowToast?.(`已选定使用 ${jdk.name}`, targetPath, 'success');
                                  }}
                                  style={{ padding: '3px 10px', fontSize: 11.5 }}
                                >
                                  选择此版本执行
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
                                {isInstallingThis ? '正在安装...' : '⚡ 一键在线安装'}
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
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span>💻</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-bright)' }}>
                  本机已检测到的 JDK ({installedJdks.length})
                </span>
              </div>
              <button
                type="button"
                className="panel-text-btn"
                onClick={() => void loadJdks()}
                disabled={loadingJdks}
                style={{ fontSize: 11.5 }}
              >
                {loadingJdks ? '扫描中...' : '重新扫描'}
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
                <div style={{ padding: '16px', textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
                  暂未扫描到系统其他 JDK。可通过上方一键在线安装，或在下方手动指定目录。
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
                        background: isSelected ? 'var(--bg-hover, rgba(59, 130, 246, 0.12))' : 'transparent',
                      }}
                    >
                      <div style={{ minWidth: 0, flex: 1, paddingRight: 10 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontWeight: 600, fontSize: 12.5, color: 'var(--text-bright)' }}>
                            Java {jdk.majorVersion || jdk.version}
                          </span>
                          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                            {jdk.vendor}
                          </span>
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
                          onShowToast?.(`已选定 Java ${jdk.majorVersion || jdk.version}`, jdk.path, 'success');
                        }}
                        style={{ padding: '3px 10px', fontSize: 11.5, flexShrink: 0 }}
                      >
                        {isSelected ? '● 已选定' : '选择使用'}
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Custom JAVA_HOME Picker */}
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--text)', marginBottom: 6 }}>
              自定义 JAVA_HOME 路径 <span style={{ fontSize: 11, color: 'var(--muted)' }}>(如已有其他 JDK 目录)</span>
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                value={config.selectedJavaHome}
                onChange={(e) =>
                  updateConfig((prev) => ({
                    ...prev,
                    selectedJavaHome: e.target.value,
                    selectedJavaLabel: e.target.value ? `自定义: ${e.target.value}` : '',
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
                📁 浏览目录...
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
                <span style={{ fontSize: 11.5, fontWeight: 600, color: '#10b981', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  当前 Maven 运行方式
                </span>
              </div>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-bright)' }}>
                {config.customMvnPath
                  ? `自定义可执行程序 (${config.customMvnPath})`
                  : hasMvnw || mavenEnv?.type === 'wrapper'
                  ? '项目内置 Maven Wrapper (./mvnw) · 免装全局 Maven'
                  : mavenEnv?.available
                  ? `系统全局 Maven (${mavenEnv.executablePath || 'mvn'})`
                  : '未检测到 Maven (推荐在下方一键生成 mvnw 包装器)'}
              </div>
            </div>

            <button
              type="button"
              className="panel-standard-btn"
              onClick={() => void detectMaven()}
              disabled={detectingMaven}
              style={{ padding: '4px 10px', fontSize: 11.5 }}
            >
              {detectingMaven ? '检测中...' : '🔄 重新检测'}
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
                项目 Maven Wrapper (mvnw) 包装器
              </span>
              {hasMvnw ? (
                <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: 'rgba(16, 185, 129, 0.2)', color: '#10b981', fontWeight: 600 }}>
                  当前项目已具备
                </span>
              ) : (
                <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: 'rgba(234, 179, 8, 0.2)', color: '#fbbf24', fontWeight: 600 }}>
                  未生成
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 12 }}>
              Maven Wrapper 是官方推荐的标准构建配置。生成后团队成员和自动化构建无需预先安装全局 Maven，只需具备 Java 即可运行编译与打包。
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                type="button"
                className="panel-standard-btn primary"
                disabled={generatingWrapper}
                onClick={() => void handleInitWrapper()}
                style={{ padding: '5px 14px', fontSize: 12 }}
              >
                {generatingWrapper ? '正在生成 mvnw 包装器...' : hasMvnw ? '重新生成 / 修复 mvnw' : '⚡ 一键生成 mvnw 包装器'}
              </button>
              <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                生成的 mvnw 与 .mvn 目录放置于项目根目录
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
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 16 }}>📄</span>
                <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-bright)' }}>
                  Maven settings.xml 配置文件
                </span>
                {config.customSettingsPath ? (
                  <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: 'rgba(59, 130, 246, 0.2)', color: 'var(--accent)', fontWeight: 600 }}>
                    已指定配置文件
                  </span>
                ) : hasProjectSettingsXml ? (
                  <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: 'rgba(16, 185, 129, 0.2)', color: '#10b981', fontWeight: 600 }}>
                    项目级 .mvn/settings.xml 已生效
                  </span>
                ) : (
                  <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: 'rgba(255, 255, 255, 0.08)', color: 'var(--muted)', fontWeight: 500 }}>
                    使用系统默认
                  </span>
                )}
              </div>
            </div>

            <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 12 }}>
              在执行打包或编译时，通过传入指定的 <code style={{ background: 'var(--bg-input)', padding: '1px 5px', borderRadius: 4, fontFamily: 'monospace' }}>-s &lt;settings.xml&gt;</code> 解决公司私有仓库鉴权或国内依赖下载超时的问题。
            </div>

            {/* Path input */}
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--text)', marginBottom: 6 }}>
                自定义 settings.xml 路径 <span style={{ fontSize: 11, color: 'var(--muted)' }}>(留空则自动检测项目 .mvn/settings.xml 或系统默认)</span>
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="text"
                  value={config.customSettingsPath || ''}
                  onChange={(e) => updateConfig((prev) => ({ ...prev, customSettingsPath: e.target.value }))}
                  placeholder="~/.m2/settings.xml 或 /path/to/project/.mvn/settings.xml"
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
                  📁 浏览文件...
                </button>
                {config.customSettingsPath && (
                  <button
                    type="button"
                    className="panel-standard-btn"
                    onClick={() => {
                      updateConfig((prev) => ({ ...prev, customSettingsPath: '' }));
                      onShowToast?.('已清除自定义 settings.xml 路径', undefined, 'info');
                    }}
                    style={{ padding: '6px 10px', fontSize: 12 }}
                    title="清除自定义路径"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>

            {/* One-click generate .mvn/settings.xml */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 6, borderTop: '1px solid var(--border)' }}>
              <button
                type="button"
                className="panel-standard-btn"
                disabled={generatingSettings}
                onClick={() => void handleInitSettingsXml()}
                style={{ padding: '5px 14px', fontSize: 12 }}
              >
                {generatingSettings ? '生成中...' : '⚡ 一键在当前工程生成 .mvn/settings.xml (阿里云镜像加速)'}
              </button>
              <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                自动配置 central 镜像指向国内阿里云公共仓库，极大加快依赖下载速度
              </span>
            </div>
          </div>

          {/* Custom mvn Path */}
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--text)', marginBottom: 6 }}>
              自定义 mvn 执行程序路径 <span style={{ fontSize: 11, color: 'var(--muted)' }}>(留空则优先使用 Wrapper 或系统 PATH)</span>
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                value={config.customMvnPath}
                onChange={(e) => updateConfig((prev) => ({ ...prev, customMvnPath: e.target.value }))}
                placeholder="/usr/local/bin/mvn 或 /opt/homebrew/bin/mvn"
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
                📄 浏览文件...
              </button>
              {config.customMvnPath && (
                <button
                  type="button"
                  className="panel-standard-btn"
                  onClick={() => {
                    updateConfig((prev) => ({ ...prev, customMvnPath: '' }));
                    onShowToast?.('已清除自定义 Maven 路径', undefined, 'info');
                  }}
                  style={{ padding: '6px 10px', fontSize: 12 }}
                  title="清除自定义路径"
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
            <div style={{ fontWeight: 600, color: 'var(--text-bright)', marginBottom: 4 }}>系统自动探测诊断</div>
            <div style={{ color: 'var(--muted)' }}>
              可执行路径：<span style={{ color: 'var(--accent)', fontFamily: 'monospace' }}>{mavenEnv?.executablePath || '未检测到'}</span>
            </div>
            {mavenEnv?.mavenVersion && (
              <div style={{ color: 'var(--muted)' }}>
                Maven 版本：<span style={{ color: 'var(--text-bright)' }}>{mavenEnv.mavenVersion}</span>
              </div>
            )}
            {mavenEnv?.detail && (
              <div style={{ color: 'var(--muted)', fontSize: 11.5, marginTop: 2 }}>
                说明：{mavenEnv.detail}
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
                全局运行时参数配置 (VM Options &amp; 启动参数)
              </span>
            </div>
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 16px 0', lineHeight: 1.5 }}>
              配置在运行 Java 类、Maven 目标及脚本时默认附加的 JVM 虚拟机系统属性 (-D)、主类程序参数及系统环境变量。
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* JVM 参数 */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)' }}>
                    ☕ JVM 虚拟机参数 (VM Options)
                  </label>
                  <span style={{ fontSize: 11, color: 'var(--muted)' }}>传递给 System.getProperty()</span>
                </div>
                <input
                  type="text"
                  value={runtimeConfig.vmArgs}
                  onChange={(e) => setRuntimeConfig({ ...runtimeConfig, vmArgs: e.target.value })}
                  placeholder="例如: -Denv=local-dev -Dfile.encoding=UTF-8 -Xms256m -Xmx1024m"
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
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: 'var(--muted)' }}>常用示例:</span>
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
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)' }}>
                    📦 程序启动参数 (Program Arguments)
                  </label>
                  <span style={{ fontSize: 11, color: 'var(--muted)' }}>传递给 main(String[] args) 入口参数</span>
                </div>
                <input
                  type="text"
                  value={runtimeConfig.programArgs}
                  onChange={(e) => setRuntimeConfig({ ...runtimeConfig, programArgs: e.target.value })}
                  placeholder="例如: --server.port=8080 --mode=standalone"
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
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-bright)', marginBottom: 5 }}>
                    🌐 系统环境变量 (Environment Variables)
                  </label>
                  <input
                    type="text"
                    value={runtimeConfig.envVars}
                    onChange={(e) => setRuntimeConfig({ ...runtimeConfig, envVars: e.target.value })}
                    placeholder="KEY=VALUE (逗号分隔)"
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
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-bright)', marginBottom: 5 }}>
                    🏷️ Maven 激活 Profile (-P)
                  </label>
                  <input
                    type="text"
                    value={runtimeConfig.activeProfiles}
                    onChange={(e) => setRuntimeConfig({ ...runtimeConfig, activeProfiles: e.target.value })}
                    placeholder="例如: dev, local"
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
                  ⚙️ 运行与类路径高级选项 (Run Options)
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
                  <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={runtimeConfig.addProvidedToClasspath}
                      onChange={(e) => setRuntimeConfig({ ...runtimeConfig, addProvidedToClasspath: e.target.checked })}
                      style={{ marginTop: 2 }}
                    />
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: '#fca5a5' }}>
                        <span>将 "provided" 作用域依赖添加到类路径 (Add dependencies with "provided" scope to classpath)</span>
                        <span style={{ fontSize: 10, background: '#ef4444', color: '#fff', padding: '1px 5px', borderRadius: 3 }}>推荐开启</span>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                        在运行主类时包含 Flink, Spark, Lombok, Servlet-API 等 provided 范围依赖 (-Dexec.classpathScope=compile)，解决 NoClassDefFoundError。
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
                      onChange={(e) => setRuntimeConfig({ ...runtimeConfig, skipBuildBeforeRun: e.target.checked })}
                    />
                    <div>
                      <div style={{ color: 'var(--text-bright)' }}>运行前不编译 (Do not build)</div>
                      <div style={{ fontSize: 10, color: 'var(--muted)' }}>跳过 compile，直接执行已有 class</div>
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
                      onChange={(e) => setRuntimeConfig({ ...runtimeConfig, allowMultipleInstances: e.target.checked })}
                    />
                    <div>
                      <div style={{ color: 'var(--text-bright)' }}>允许并发运行多实例</div>
                      <div style={{ fontSize: 10, color: 'var(--muted)' }}>不中断前序已启动的会话</div>
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
                      onChange={(e) => setRuntimeConfig({ ...runtimeConfig, saveConsoleToFile: e.target.checked })}
                    />
                    <div>
                      <div style={{ color: 'var(--text-bright)' }}>控制台日志保存到文件</div>
                      <div style={{ fontSize: 10, color: 'var(--muted)' }}>保存至 .echoly/logs/run.log</div>
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
                      onChange={(e) => setRuntimeConfig({ ...runtimeConfig, showSettingsBeforeRun: e.target.checked })}
                    />
                    <div>
                      <div style={{ color: 'var(--text-bright)' }}>每次启动前显示运行配置</div>
                      <div style={{ fontSize: 10, color: 'var(--muted)' }}>运行前弹出配置窗口供确认</div>
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
                    onShowToast?.('运行时参数已保存', '当前项目级配置已生效', 'success');
                  }}
                  style={{ fontSize: 12, padding: '6px 18px', background: '#22c55e', borderColor: '#22c55e', color: '#fff' }}
                >
                  保存运行时参数
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
              background: 'linear-gradient(135deg, rgba(59, 130, 246, 0.08) 0%, rgba(147, 51, 234, 0.05) 100%)',
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
                  C / C++ 现代开发工具链与 LLDB-DAP 调试引擎
                </span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
                Echoly 已原生接入 Clangd LSP 语言服务、LLDB-DAP 调试协议与 CMake 自动化套件，实现开箱即用的 C/C++ 代码补全、跳转定义、Alt+O 头源切换、断点调试与构建运行。
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                type="button"
                className="panel-standard-btn"
                onClick={detectCpp}
                disabled={detectingCpp}
                style={{ fontSize: 12, padding: '6px 14px' }}
              >
                {detectingCpp ? '检测中...' : '重新体检'}
              </button>
              <button
                type="button"
                className="panel-standard-btn primary"
                onClick={handleCreateCppTemplate}
                disabled={creatingCppTemplate}
                style={{ fontSize: 12, padding: '6px 14px', background: '#3b82f6', borderColor: '#3b82f6', color: '#fff' }}
              >
                {creatingCppTemplate ? '生成中...' : '一键创建 CMake C++ 模板'}
              </button>
            </div>
          </div>

          {/* 工具链四件套卡片网格 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 14 }}>
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
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13, color: '#fff' }}>
                  <span>⚙️</span>
                  <span>C/C++ 编译器 (Compiler)</span>
                </div>
                <span
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 4,
                    background: cppToolchain?.compiler.installed ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                    color: cppToolchain?.compiler.installed ? '#4ade80' : '#f87171',
                  }}
                >
                  {cppToolchain?.compiler.installed ? '已就绪' : '未安装'}
                </span>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', fontFamily: 'monospace' }}>
                命令: {cppToolchain?.compiler.command || 'clang++ / g++'}
              </div>
              {cppToolchain?.compiler.installed ? (
                <>
                  <div style={{ fontSize: 11.5, color: '#d4d4d8' }}>版本: {cppToolchain.compiler.version}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', wordBreak: 'break-all' }}>路径: {cppToolchain.compiler.path}</div>
                </>
              ) : (
                <div style={{ fontSize: 11, color: '#f87171' }}>推荐安装: {cppToolchain?.compiler.installGuide || 'xcode-select --install'}</div>
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
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13, color: '#fff' }}>
                  <span>🧠</span>
                  <span>Clangd 语言服务器 (LSP)</span>
                </div>
                <span
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 4,
                    background: cppToolchain?.clangd.installed ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                    color: cppToolchain?.clangd.installed ? '#4ade80' : '#f87171',
                  }}
                >
                  {cppToolchain?.clangd.installed ? '已就绪' : '未安装'}
                </span>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', fontFamily: 'monospace' }}>
                命令: {cppToolchain?.clangd.command || 'clangd'}
              </div>
              {cppToolchain?.clangd.installed ? (
                <>
                  <div style={{ fontSize: 11.5, color: '#d4d4d8' }}>版本: {cppToolchain.clangd.version}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', wordBreak: 'break-all' }}>路径: {cppToolchain.clangd.path}</div>
                </>
              ) : (
                <div style={{ fontSize: 11, color: '#f87171' }}>推荐安装: {cppToolchain?.clangd.installGuide || 'brew install llvm'}</div>
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
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13, color: '#fff' }}>
                  <span>🪲</span>
                  <span>LLDB-DAP 调试引擎 (Debugger)</span>
                </div>
                <span
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 4,
                    background: cppToolchain?.debugger.installed ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                    color: cppToolchain?.debugger.installed ? '#4ade80' : '#f87171',
                  }}
                >
                  {cppToolchain?.debugger.installed ? '已就绪' : '未安装'}
                </span>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', fontFamily: 'monospace' }}>
                命令: {cppToolchain?.debugger.command || 'lldb-dap'}
              </div>
              {cppToolchain?.debugger.installed ? (
                <>
                  <div style={{ fontSize: 11.5, color: '#d4d4d8' }}>版本: {cppToolchain.debugger.version}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', wordBreak: 'break-all' }}>路径: {cppToolchain.debugger.path}</div>
                </>
              ) : (
                <div style={{ fontSize: 11, color: '#f87171' }}>推荐安装: {cppToolchain?.debugger.installGuide || 'xcode-select --install'}</div>
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
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13, color: '#fff' }}>
                  <span>🏗️</span>
                  <span>CMake 构建系统 (Build System)</span>
                </div>
                <span
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 4,
                    background: cppToolchain?.cmake.installed ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                    color: cppToolchain?.cmake.installed ? '#4ade80' : '#f87171',
                  }}
                >
                  {cppToolchain?.cmake.installed ? '已就绪' : '未安装'}
                </span>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', fontFamily: 'monospace' }}>
                命令: {cppToolchain?.cmake.command || 'cmake'}
              </div>
              {cppToolchain?.cmake.installed ? (
                <>
                  <div style={{ fontSize: 11.5, color: '#d4d4d8' }}>版本: {cppToolchain.cmake.version}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', wordBreak: 'break-all' }}>路径: {cppToolchain.cmake.path}</div>
                </>
              ) : (
                <div style={{ fontSize: 11, color: '#f87171' }}>推荐安装: {cppToolchain?.cmake.installGuide || 'brew install cmake'}</div>
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
              💡 Echoly C/C++ 快捷开发指引
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
              <div style={{ padding: '10px 12px', background: 'rgba(255, 255, 255, 0.02)', borderRadius: 6 }}>
                <div style={{ fontWeight: 600, color: '#93c5fd', marginBottom: 4 }}>⌨️ 快捷键 Alt+O</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                  在编辑器中按 Alt+O (Option+O)，可在头文件 (.h / .hpp) 与源文件 (.cpp) 之间秒级跳转互切。
                </div>
              </div>
              <div style={{ padding: '10px 12px', background: 'rgba(255, 255, 255, 0.02)', borderRadius: 6 }}>
                <div style={{ fontWeight: 600, color: '#86efac', marginBottom: 4 }}>🔴 边距断点交互</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                  鼠标直接点击代码行号左侧的字形边距槽，即可自由添加或移除断点红点，与 LLDB 引擎实时同步。
                </div>
              </div>
              <div style={{ padding: '10px 12px', background: 'rgba(255, 255, 255, 0.02)', borderRadius: 6 }}>
                <div style={{ fontWeight: 600, color: '#fde047', marginBottom: 4 }}>⚡ CMake 自动感知</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                  只要根目录存在 CMakeLists.txt，顶部运行部件即自动解析 Targets，支持一键 Build、Run 与 CTest。
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

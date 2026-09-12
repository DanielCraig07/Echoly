import React, { useState, useEffect, useCallback, useMemo } from 'react';
import type {
  MavenEnvironmentInfo,
  InstalledJdkInfo,
  OnlineJdkInfo,
  JdkInstallProgress,
} from '@deepseek-ide/shared';

export interface EnvConfig {
  customMvnPath: string;
  selectedJavaHome: string;
  selectedJavaLabel?: string;
}

export interface EnvironmentConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  mavenEnv: MavenEnvironmentInfo | null;
  hasMvnw: boolean;
  onRefreshMavenEnv: () => Promise<void>;
  onInitWrapper: () => Promise<void>;
  generatingWrapper: boolean;
  currentConfig: EnvConfig;
  onSaveConfig: (config: EnvConfig) => void;
  onShowToast?: (message: string, type?: 'info' | 'error' | 'success') => void;
}

export function EnvironmentConfigModal({
  isOpen,
  onClose,
  mavenEnv,
  hasMvnw,
  onRefreshMavenEnv,
  onInitWrapper,
  generatingWrapper,
  currentConfig,
  onSaveConfig,
  onShowToast,
}: EnvironmentConfigModalProps) {
  const [activeTab, setActiveTab] = useState<'java' | 'maven'>('java');

  // Draft config
  const [draftConfig, setDraftConfig] = useState<EnvConfig>(currentConfig);

  // Java state
  const [installedJdks, setInstalledJdks] = useState<InstalledJdkInfo[]>([]);
  const [onlineJdks, setOnlineJdks] = useState<OnlineJdkInfo[]>([]);
  const [loadingJdks, setLoadingJdks] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [installProgress, setInstallProgress] = useState<Record<string, JdkInstallProgress>>({});

  // Sync draft when opened
  useEffect(() => {
    if (isOpen) {
      setDraftConfig(currentConfig);
    }
  }, [isOpen, currentConfig]);

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

  useEffect(() => {
    if (isOpen) {
      void loadJdks();
    }
  }, [isOpen, loadJdks]);

  // Listen for installation progress
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

  // Handle Online Installation
  const handleInstallJdk = async (jdk: OnlineJdkInfo) => {
    if (installingId) return;
    setInstallingId(jdk.id);
    onShowToast?.(`开始下载并安装 ${jdk.name}...`, 'info');
    try {
      const res = await window.ide.javaInstallOnlineJdk(jdk.id);
      if (res.success && res.javaHome) {
        onShowToast?.(res.message || `成功安装 ${jdk.name}！`, 'success');
        // Automatically select as active
        setDraftConfig((prev) => ({
          ...prev,
          selectedJavaHome: res.javaHome!,
          selectedJavaLabel: `${jdk.name} (${res.javaHome})`,
        }));
        await loadJdks();
      } else {
        onShowToast?.(res.message || '安装失败，请检查网络连接', 'error');
      }
    } catch (err: any) {
      onShowToast?.(`安装错误: ${err?.message || String(err)}`, 'error');
    } finally {
      setInstallingId(null);
    }
  };

  // Browse Directory for JAVA_HOME
  const handlePickJavaHome = async () => {
    try {
      const picked = await window.ide.pickDirectory?.();
      if (picked) {
        setDraftConfig((prev) => ({
          ...prev,
          selectedJavaHome: picked,
          selectedJavaLabel: `自定义: ${picked}`,
        }));
      }
    } catch {}
  };

  // Browse File for Maven executable
  const handlePickMvnPath = async () => {
    try {
      const picked = await window.ide.pickFile?.([{ name: 'Maven Executable', extensions: ['*'] }]);
      if (picked) {
        setDraftConfig((prev) => ({
          ...prev,
          customMvnPath: picked,
        }));
      }
    } catch {}
  };

  const handleSave = () => {
    onSaveConfig(draftConfig);
    onClose();
    onShowToast?.('环境配置已保存并生效', 'success');
  };

  if (!isOpen) return null;

  // Active JDK summary info
  const activeJavaDisplay = draftConfig.selectedJavaHome
    ? draftConfig.selectedJavaLabel || draftConfig.selectedJavaHome
    : mavenEnv?.hasJava
    ? '系统默认 Java (自动探测就绪)'
    : '未配置 Java 环境';

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100000,
        background: 'rgba(0, 0, 0, 0.72)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        animation: 'fadeIn 0.15s ease-out',
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 820,
          height: 620,
          maxHeight: '90vh',
          background: 'linear-gradient(180deg, #1e1e2d 0%, #151520 100%)',
          border: '1px solid rgba(255, 255, 255, 0.12)',
          borderRadius: 14,
          boxShadow: '0 24px 60px rgba(0, 0, 0, 0.8), 0 0 0 1px rgba(255, 255, 255, 0.05)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          color: '#e2e8f0',
          fontSize: 13,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Dialog Header ── */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 22px',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            background: 'rgba(255, 255, 255, 0.02)',
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 18 }}>⚙️</span>
              <span style={{ fontSize: 16, fontWeight: 600, color: '#ffffff', letterSpacing: '0.01em' }}>
                开发与构建环境配置
              </span>
              <span
                style={{
                  fontSize: 11,
                  padding: '2px 8px',
                  borderRadius: 12,
                  background: 'rgba(59, 130, 246, 0.15)',
                  color: '#93c5fd',
                  border: '1px solid rgba(59, 130, 246, 0.3)',
                  fontWeight: 500,
                }}
              >
                Global Environment
              </span>
            </div>
            <div style={{ fontSize: 12, color: 'rgba(255, 255, 255, 0.5)', marginTop: 3 }}>
              管理 Java (JDK) 版本与在线安装，配置 Maven 运行模式及包装器
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            title="关闭窗口 (Esc)"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'rgba(255, 255, 255, 0.5)',
              cursor: 'pointer',
              fontSize: 18,
              lineHeight: 1,
              padding: '6px 10px',
              borderRadius: 6,
              transition: 'all 0.15s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
              e.currentTarget.style.color = '#ffffff';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = 'rgba(255, 255, 255, 0.5)';
            }}
          >
            ✕
          </button>
        </div>

        {/* ── Dialog Tabs & Body ── */}
        <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
          {/* Left Sidebar Nav */}
          <div
            style={{
              width: 190,
              borderRight: '1px solid rgba(255, 255, 255, 0.08)',
              background: 'rgba(0, 0, 0, 0.18)',
              padding: '16px 10px',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              flexShrink: 0,
            }}
          >
            <button
              type="button"
              onClick={() => setActiveTab('java')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 14px',
                borderRadius: 8,
                border: '1px solid',
                borderColor: activeTab === 'java' ? 'rgba(59, 130, 246, 0.4)' : 'transparent',
                background: activeTab === 'java' ? 'rgba(59, 130, 246, 0.16)' : 'transparent',
                color: activeTab === 'java' ? '#ffffff' : 'rgba(255, 255, 255, 0.65)',
                fontSize: 13,
                fontWeight: activeTab === 'java' ? 600 : 400,
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'all 0.15s',
              }}
            >
              <span style={{ fontSize: 16 }}>☕</span>
              <span>Java (JDK) 环境</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('maven')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 14px',
                borderRadius: 8,
                border: '1px solid',
                borderColor: activeTab === 'maven' ? 'rgba(59, 130, 246, 0.4)' : 'transparent',
                background: activeTab === 'maven' ? 'rgba(59, 130, 246, 0.16)' : 'transparent',
                color: activeTab === 'maven' ? '#ffffff' : 'rgba(255, 255, 255, 0.65)',
                fontSize: 13,
                fontWeight: activeTab === 'maven' ? 600 : 400,
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'all 0.15s',
              }}
            >
              <span style={{ fontSize: 16 }}>🛠️</span>
              <span>Maven 构建工具</span>
            </button>
          </div>

          {/* Right Content Panel */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
            {/* ─── TAB 1: JAVA (JDK) ENVIRONMENT & ONLINE INSTALL ─── */}
            {activeTab === 'java' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                {/* Active JDK Banner */}
                <div
                  style={{
                    padding: '14px 18px',
                    borderRadius: 10,
                    background: 'rgba(59, 130, 246, 0.08)',
                    border: '1px solid rgba(59, 130, 246, 0.25)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          background: draftConfig.selectedJavaHome || mavenEnv?.hasJava ? '#10b981' : '#f43f5e',
                          boxShadow: draftConfig.selectedJavaHome || mavenEnv?.hasJava ? '0 0 8px #10b981' : 'none',
                        }}
                      />
                      <span style={{ fontSize: 12, fontWeight: 600, color: '#93c5fd', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        当前选定执行的 Java (JDK)
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 600,
                        color: '#ffffff',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={draftConfig.selectedJavaHome || '系统默认'}
                    >
                      {activeJavaDisplay}
                    </div>
                    {draftConfig.selectedJavaHome && (
                      <div
                        style={{
                          fontSize: 11,
                          color: 'rgba(255, 255, 255, 0.5)',
                          fontFamily: 'monospace',
                          marginTop: 3,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        JAVA_HOME = {draftConfig.selectedJavaHome}
                      </div>
                    )}
                  </div>

                  {draftConfig.selectedJavaHome && (
                    <button
                      type="button"
                      onClick={() => setDraftConfig((prev) => ({ ...prev, selectedJavaHome: '', selectedJavaLabel: '' }))}
                      style={{
                        background: 'rgba(255, 255, 255, 0.06)',
                        border: '1px solid rgba(255, 255, 255, 0.15)',
                        borderRadius: 6,
                        padding: '5px 12px',
                        color: '#e2e8f0',
                        fontSize: 12,
                        cursor: 'pointer',
                        marginLeft: 14,
                        flexShrink: 0,
                      }}
                    >
                      恢复默认
                    </button>
                  )}
                </div>

                {/* Online JDK Installation Section */}
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 600, color: '#ffffff', display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span>🌐</span>
                        <span>官方主流 Java (JDK) 在线一键安装</span>
                      </div>
                      <div style={{ fontSize: 12, color: 'rgba(255, 255, 255, 0.5)', marginTop: 2 }}>
                        自动识别当前平台架构，下载官方发行包并解压至用户专属管理目录 (~/.echoly/jdks)
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
                    {onlineJdks.map((jdk) => {
                      const prog = installProgress[jdk.id];
                      const isInstallingThis = installingId === jdk.id;
                      const isCurrentlySelected =
                        draftConfig.selectedJavaHome &&
                        jdk.installedPath &&
                        draftConfig.selectedJavaHome === jdk.installedPath;

                      return (
                        <div
                          key={jdk.id}
                          style={{
                            padding: '14px 16px',
                            borderRadius: 10,
                            background: isCurrentlySelected
                              ? 'rgba(59, 130, 246, 0.12)'
                              : 'rgba(255, 255, 255, 0.03)',
                            border: `1px solid ${
                              isCurrentlySelected
                                ? 'rgba(59, 130, 246, 0.4)'
                                : 'rgba(255, 255, 255, 0.08)'
                            }`,
                            display: 'flex',
                            flexDirection: 'column',
                            justifyContent: 'space-between',
                            position: 'relative',
                            transition: 'all 0.15s',
                          }}
                        >
                          <div>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <span style={{ fontWeight: 600, fontSize: 13.5, color: '#ffffff' }}>
                                  {jdk.name}
                                </span>
                                {jdk.recommended && (
                                  <span
                                    style={{
                                      fontSize: 10,
                                      padding: '1px 6px',
                                      borderRadius: 4,
                                      background: 'rgba(16, 185, 129, 0.2)',
                                      color: '#34d399',
                                      fontWeight: 600,
                                    }}
                                  >
                                    推荐
                                  </span>
                                )}
                              </div>
                              {jdk.isInstalled ? (
                                <span style={{ fontSize: 11, color: '#10b981', fontWeight: 500 }}>
                                  ✓ 已安装
                                </span>
                              ) : (
                                <span style={{ fontSize: 11, color: 'rgba(255, 255, 255, 0.4)' }}>
                                  ~{jdk.sizeMb}MB
                                </span>
                              )}
                            </div>

                            <div style={{ fontSize: 11.5, color: 'rgba(255, 255, 255, 0.55)', lineHeight: 1.4, marginBottom: 10 }}>
                              {jdk.description}
                            </div>
                          </div>

                          {/* Progress bar if downloading */}
                          {isInstallingThis && prog && (
                            <div style={{ marginBottom: 8 }}>
                              <div
                                style={{
                                  height: 5,
                                  background: 'rgba(255, 255, 255, 0.1)',
                                  borderRadius: 3,
                                  overflow: 'hidden',
                                  marginBottom: 4,
                                }}
                              >
                                <div
                                  style={{
                                    height: '100%',
                                    width: `${prog.percent}%`,
                                    background: '#3b82f6',
                                    transition: 'width 0.2s',
                                  }}
                                />
                              </div>
                              <div style={{ fontSize: 11, color: '#93c5fd' }}>
                                {prog.message || `${prog.status}... ${prog.percent}%`}
                              </div>
                            </div>
                          )}

                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                            {jdk.isInstalled ? (
                              isCurrentlySelected ? (
                                <span
                                  style={{
                                    fontSize: 11.5,
                                    color: '#60a5fa',
                                    fontWeight: 600,
                                    padding: '4px 8px',
                                  }}
                                >
                                  ● 当前使用中
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setDraftConfig((prev) => ({
                                      ...prev,
                                      selectedJavaHome: jdk.installedPath || '',
                                      selectedJavaLabel: jdk.name,
                                    }))
                                  }
                                  style={{
                                    padding: '5px 12px',
                                    borderRadius: 6,
                                    background: 'rgba(59, 130, 246, 0.2)',
                                    color: '#93c5fd',
                                    border: '1px solid rgba(59, 130, 246, 0.35)',
                                    fontSize: 11.5,
                                    fontWeight: 500,
                                    cursor: 'pointer',
                                  }}
                                >
                                  选择此版本执行
                                </button>
                              )
                            ) : (
                              <button
                                type="button"
                                disabled={Boolean(installingId)}
                                onClick={() => void handleInstallJdk(jdk)}
                                style={{
                                  padding: '5px 14px',
                                  borderRadius: 6,
                                  background: isInstallingThis ? 'rgba(59, 130, 246, 0.4)' : '#2563eb',
                                  color: '#ffffff',
                                  border: 'none',
                                  fontSize: 11.5,
                                  fontWeight: 500,
                                  cursor: installingId ? 'not-allowed' : 'pointer',
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 6,
                                }}
                              >
                                {isInstallingThis ? '正在安装...' : '⚡ 一键在线安装'}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Local Detected JDKs */}
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: '#ffffff', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span>💻</span>
                      <span>本机已检测到的 JDK ({installedJdks.length})</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => void loadJdks()}
                      disabled={loadingJdks}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: '#60a5fa',
                        fontSize: 12,
                        cursor: 'pointer',
                        padding: '2px 6px',
                      }}
                    >
                      {loadingJdks ? '扫描中...' : '重新扫描'}
                    </button>
                  </div>

                  <div
                    style={{
                      maxHeight: 150,
                      overflowY: 'auto',
                      borderRadius: 8,
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                      background: 'rgba(0, 0, 0, 0.2)',
                    }}
                  >
                    {installedJdks.length === 0 ? (
                      <div style={{ padding: '16px', textAlign: 'center', color: 'rgba(255, 255, 255, 0.4)', fontSize: 12 }}>
                        暂未扫描到系统其他 JDK。可通过上方一键在线安装，或在下方手动指定路径。
                      </div>
                    ) : (
                      installedJdks.map((jdk) => {
                        const isSelected = draftConfig.selectedJavaHome === jdk.path;
                        return (
                          <div
                            key={jdk.id}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              padding: '8px 14px',
                              borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
                              background: isSelected ? 'rgba(59, 130, 246, 0.12)' : 'transparent',
                            }}
                          >
                            <div style={{ minWidth: 0, flex: 1, paddingRight: 10 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span style={{ fontWeight: 600, fontSize: 12.5, color: '#ffffff' }}>
                                  Java {jdk.majorVersion || jdk.version}
                                </span>
                                <span style={{ fontSize: 11, color: '#a1a1aa' }}>
                                  {jdk.vendor}
                                </span>
                                {jdk.arch && (
                                  <span
                                    style={{
                                      fontSize: 10,
                                      padding: '1px 4px',
                                      borderRadius: 3,
                                      background: 'rgba(255, 255, 255, 0.08)',
                                      color: '#cbd5e1',
                                    }}
                                  >
                                    {jdk.arch}
                                  </span>
                                )}
                              </div>
                              <div
                                style={{
                                  fontSize: 11,
                                  color: 'rgba(255, 255, 255, 0.4)',
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
                              onClick={() =>
                                setDraftConfig((prev) => ({
                                  ...prev,
                                  selectedJavaHome: jdk.path,
                                  selectedJavaLabel: `${jdk.vendor} Java ${jdk.majorVersion || jdk.version}`,
                                }))
                              }
                              style={{
                                padding: '4px 10px',
                                borderRadius: 5,
                                fontSize: 11.5,
                                border: '1px solid',
                                borderColor: isSelected ? '#3b82f6' : 'rgba(255, 255, 255, 0.15)',
                                background: isSelected ? '#3b82f6' : 'rgba(255, 255, 255, 0.05)',
                                color: '#ffffff',
                                cursor: 'pointer',
                                flexShrink: 0,
                              }}
                            >
                              {isSelected ? '● 已选定' : '选择使用'}
                            </button>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>

                {/* Custom JAVA_HOME Directory Picker */}
                <div>
                  <label style={{ display: 'block', fontSize: 12.5, fontWeight: 500, color: '#cbd5e1', marginBottom: 6 }}>
                    自定义 JAVA_HOME 路径 <span style={{ fontSize: 11, color: 'rgba(255, 255, 255, 0.4)' }}>(如已有其他 JDK 目录)</span>
                  </label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      type="text"
                      value={draftConfig.selectedJavaHome}
                      onChange={(e) =>
                        setDraftConfig((prev) => ({
                          ...prev,
                          selectedJavaHome: e.target.value,
                          selectedJavaLabel: e.target.value ? `自定义: ${e.target.value}` : '',
                        }))
                      }
                      placeholder="/Library/Java/JavaVirtualMachines/jdk-21.jdk/Contents/Home"
                      style={{
                        flex: 1,
                        background: 'rgba(0, 0, 0, 0.3)',
                        border: '1px solid rgba(255, 255, 255, 0.12)',
                        borderRadius: 6,
                        padding: '6px 12px',
                        color: '#ffffff',
                        fontSize: 12,
                        fontFamily: 'monospace',
                        outline: 'none',
                      }}
                    />
                    <button
                      type="button"
                      onClick={handlePickJavaHome}
                      style={{
                        padding: '6px 14px',
                        borderRadius: 6,
                        background: 'rgba(255, 255, 255, 0.08)',
                        border: '1px solid rgba(255, 255, 255, 0.15)',
                        color: '#ffffff',
                        fontSize: 12,
                        cursor: 'pointer',
                        flexShrink: 0,
                      }}
                    >
                      📁 浏览目录...
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ─── TAB 2: MAVEN CONFIGURATION & WRAPPER ─── */}
            {activeTab === 'maven' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                {/* Active Maven Mode Status */}
                <div
                  style={{
                    padding: '14px 18px',
                    borderRadius: 10,
                    background: 'rgba(16, 185, 129, 0.08)',
                    border: '1px solid rgba(16, 185, 129, 0.25)',
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
                      <span style={{ fontSize: 12, fontWeight: 600, color: '#34d399', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        当前 Maven 运行方式
                      </span>
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: '#ffffff' }}>
                      {draftConfig.customMvnPath
                        ? `自定义可执行程序 (${draftConfig.customMvnPath})`
                        : hasMvnw || mavenEnv?.type === 'wrapper'
                        ? '项目内置 Maven Wrapper (./mvnw) · 免装全局 Maven'
                        : mavenEnv?.available
                        ? `系统全局 Maven (${mavenEnv.executablePath || 'mvn'})`
                        : '未检测到 Maven'}
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => void onRefreshMavenEnv()}
                    style={{
                      background: 'rgba(255, 255, 255, 0.06)',
                      border: '1px solid rgba(255, 255, 255, 0.15)',
                      borderRadius: 6,
                      padding: '5px 12px',
                      color: '#e2e8f0',
                      fontSize: 12,
                      cursor: 'pointer',
                      flexShrink: 0,
                    }}
                  >
                    🔄 重新检测
                  </button>
                </div>

                {/* Maven Wrapper (mvnw) Feature Card */}
                <div
                  style={{
                    padding: '16px 18px',
                    borderRadius: 10,
                    background: 'rgba(255, 255, 255, 0.03)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 16 }}>⚡</span>
                    <span style={{ fontSize: 14, fontWeight: 600, color: '#ffffff' }}>
                      项目 Maven Wrapper (mvnw) 包装器
                    </span>
                    {hasMvnw ? (
                      <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: 'rgba(16, 185, 129, 0.2)', color: '#34d399', fontWeight: 600 }}>
                        当前项目已具备
                      </span>
                    ) : (
                      <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: 'rgba(234, 179, 8, 0.2)', color: '#fbbf24', fontWeight: 600 }}>
                        未生成
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: 'rgba(255, 255, 255, 0.6)', lineHeight: 1.6, marginBottom: 12 }}>
                    Maven Wrapper 是 Apache 官方推荐的项目构建标准。为项目生成 <code style={{ background: 'rgba(0,0,0,0.3)', padding: '1px 5px', borderRadius: 4, fontFamily: 'monospace' }}>mvnw</code> 后，任何团队成员或未安装 Maven 的机器只需拥有 Java (JDK) 即可直接运行完整构建，彻底消除本地 Maven 版本不一致的困扰。
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <button
                      type="button"
                      disabled={generatingWrapper}
                      onClick={() => void onInitWrapper()}
                      style={{
                        padding: '6px 16px',
                        borderRadius: 6,
                        background: '#10b981',
                        color: '#ffffff',
                        border: 'none',
                        fontSize: 12,
                        fontWeight: 500,
                        cursor: generatingWrapper ? 'not-allowed' : 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                      }}
                    >
                      {generatingWrapper ? '正在生成 mvnw 包装器...' : hasMvnw ? '重新生成 / 修复 mvnw' : '⚡ 一键生成 mvnw 包装器'}
                    </button>
                    <span style={{ fontSize: 11.5, color: 'rgba(255, 255, 255, 0.4)' }}>
                      生成的 mvnw 与 .mvn 目录将放置于项目根目录
                    </span>
                  </div>
                </div>

                {/* Custom mvn Path */}
                <div>
                  <label style={{ display: 'block', fontSize: 12.5, fontWeight: 500, color: '#cbd5e1', marginBottom: 6 }}>
                    自定义 mvn 执行程序路径 <span style={{ fontSize: 11, color: 'rgba(255, 255, 255, 0.4)' }}>(留空则使用 Wrapper 或系统 PATH)</span>
                  </label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      type="text"
                      value={draftConfig.customMvnPath}
                      onChange={(e) => setDraftConfig((prev) => ({ ...prev, customMvnPath: e.target.value }))}
                      placeholder="/usr/local/bin/mvn 或 /opt/homebrew/bin/mvn"
                      style={{
                        flex: 1,
                        background: 'rgba(0, 0, 0, 0.3)',
                        border: '1px solid rgba(255, 255, 255, 0.12)',
                        borderRadius: 6,
                        padding: '6px 12px',
                        color: '#ffffff',
                        fontSize: 12,
                        fontFamily: 'monospace',
                        outline: 'none',
                      }}
                    />
                    <button
                      type="button"
                      onClick={handlePickMvnPath}
                      style={{
                        padding: '6px 14px',
                        borderRadius: 6,
                        background: 'rgba(255, 255, 255, 0.08)',
                        border: '1px solid rgba(255, 255, 255, 0.15)',
                        color: '#ffffff',
                        fontSize: 12,
                        cursor: 'pointer',
                        flexShrink: 0,
                      }}
                    >
                      📄 浏览文件...
                    </button>
                  </div>
                </div>

                {/* System Auto-detection Details */}
                <div
                  style={{
                    padding: '12px 14px',
                    borderRadius: 8,
                    background: 'rgba(0, 0, 0, 0.2)',
                    border: '1px solid rgba(255, 255, 255, 0.06)',
                    fontSize: 12,
                    lineHeight: 1.7,
                  }}
                >
                  <div style={{ fontWeight: 600, color: '#ffffff', marginBottom: 4 }}>自动探测诊断详情</div>
                  <div style={{ color: 'rgba(255, 255, 255, 0.6)' }}>
                    可执行路径：<span style={{ color: '#93c5fd', fontFamily: 'monospace' }}>{mavenEnv?.executablePath || '未检测到'}</span>
                  </div>
                  {mavenEnv?.mavenVersion && (
                    <div style={{ color: 'rgba(255, 255, 255, 0.6)' }}>
                      Maven 版本：<span style={{ color: '#ffffff' }}>{mavenEnv.mavenVersion}</span>
                    </div>
                  )}
                  {mavenEnv?.detail && (
                    <div style={{ color: 'rgba(255, 255, 255, 0.45)', fontSize: 11.5, marginTop: 4 }}>
                      说明：{mavenEnv.detail}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── Dialog Footer ── */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 22px',
            borderTop: '1px solid rgba(255, 255, 255, 0.08)',
            background: 'rgba(255, 255, 255, 0.02)',
          }}
        >
          <div style={{ fontSize: 11.5, color: 'rgba(255, 255, 255, 0.45)' }}>
            选中的 Java 版本与 Maven 设置将在运行任务时立即生效
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: '7px 18px',
                borderRadius: 7,
                background: 'rgba(255, 255, 255, 0.07)',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                color: '#e2e8f0',
                fontSize: 12.5,
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSave}
              style={{
                padding: '7px 22px',
                borderRadius: 7,
                background: '#2563eb',
                border: 'none',
                color: '#ffffff',
                fontSize: 12.5,
                fontWeight: 600,
                cursor: 'pointer',
                boxShadow: '0 4px 12px rgba(37, 99, 235, 0.3)',
              }}
            >
              保存并应用
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

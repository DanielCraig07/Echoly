import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';

export interface ProjectRuntimeConfig {
  vmArgs: string; // JVM 参数，如 -Denv=local-dev -Dfile.encoding=UTF-8
  programArgs: string; // 主类程序参数 (main args)
  activeProfiles: string; // Maven Profile，如 dev
  envVars: string; // 环境变量，如 ENV=local-dev
  // IntelliJ IDEA 运行选项 (图 3 融入选项)
  addProvidedToClasspath: boolean; // 将 "provided" 作用域的依赖添加到类路径 (核心需求 - Spark/Flink/Lombok/Servlet)
  skipBuildBeforeRun: boolean; // 运行前不执行编译 (Do not build before run - 跳过 mvn compile)
  allowMultipleInstances: boolean; // 允许并发运行多个实例 (Allow multiple instances)
  shortenCommandLine: boolean; // 缩短命令行 (Shorten command line)
  saveConsoleToFile: boolean; // 将控制台输出保存到文件 (Save console output to file)
  showSettingsBeforeRun: boolean; // 启动前显示此运行配置 (Show configuration settings before start)
}

export const DEFAULT_RUNTIME_CONFIG: ProjectRuntimeConfig = {
  vmArgs: '',
  programArgs: '',
  activeProfiles: '',
  envVars: '',
  addProvidedToClasspath: true, // 默认开启：把 provided scope 加入 classpath，杜绝 NoClassDefFoundError
  skipBuildBeforeRun: false,
  allowMultipleInstances: false,
  shortenCommandLine: false,
  saveConsoleToFile: false,
  showSettingsBeforeRun: false,
};

export function getRuntimeConfigStorageKey(workspace?: string | null): string {
  if (!workspace) return 'echoly.projectRuntimeConfig.global';
  return `echoly.projectRuntimeConfig.${workspace}`;
}

export function loadProjectRuntimeConfig(workspace?: string | null): ProjectRuntimeConfig {
  try {
    const key = getRuntimeConfigStorageKey(workspace);
    const raw =
      localStorage.getItem(key) ||
      (workspace ? localStorage.getItem('echoly.projectRuntimeConfig.global') : null);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        vmArgs: typeof parsed.vmArgs === 'string' ? parsed.vmArgs : '',
        programArgs: typeof parsed.programArgs === 'string' ? parsed.programArgs : '',
        activeProfiles: typeof parsed.activeProfiles === 'string' ? parsed.activeProfiles : '',
        envVars: typeof parsed.envVars === 'string' ? parsed.envVars : '',
        addProvidedToClasspath: parsed.addProvidedToClasspath !== false, // 默认为 true
        skipBuildBeforeRun: !!parsed.skipBuildBeforeRun,
        allowMultipleInstances: !!parsed.allowMultipleInstances,
        shortenCommandLine: !!parsed.shortenCommandLine,
        saveConsoleToFile: !!parsed.saveConsoleToFile,
        showSettingsBeforeRun: !!parsed.showSettingsBeforeRun,
      };
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_RUNTIME_CONFIG };
}

export function saveProjectRuntimeConfig(cfg: ProjectRuntimeConfig, workspace?: string | null): void {
  try {
    const key = getRuntimeConfigStorageKey(workspace);
    localStorage.setItem(key, JSON.stringify(cfg));
    // 同步更新全局默认
    localStorage.setItem('echoly.projectRuntimeConfig.global', JSON.stringify(cfg));
    window.dispatchEvent(
      new CustomEvent('echoly:runtimeConfigChanged', {
        detail: { workspace, config: cfg },
      }),
    );
  } catch {
    /* ignore */
  }
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  workspace?: string;
  activePath?: string;
  onShowToast?: (title: string, detail?: string, type?: 'success' | 'error' | 'info' | 'warn') => void;
}

interface DetectedEnvPreset {
  name: string;
  envKey: string;
  fullRelPath: string;
}

export function ProjectRuntimeConfigModal({
  isOpen,
  onClose,
  workspace,
  activePath,
  onShowToast,
}: Props) {
  const [config, setConfig] = useState<ProjectRuntimeConfig>(DEFAULT_RUNTIME_CONFIG);
  const [detectedPresets, setDetectedPresets] = useState<DetectedEnvPreset[]>([]);
  const [scanning, setScanning] = useState(false);
  const [showAddOptionsPopup, setShowAddOptionsPopup] = useState(false);
  const addOptionsRef = useRef<HTMLDivElement>(null);

  // 加载配置
  useEffect(() => {
    if (isOpen) {
      setConfig(loadProjectRuntimeConfig(workspace));
      setShowAddOptionsPopup(false);
    }
  }, [isOpen, workspace]);

  // 关闭外部点击监听
  useEffect(() => {
    if (!showAddOptionsPopup) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (addOptionsRef.current && !addOptionsRef.current.contains(e.target as Node)) {
        setShowAddOptionsPopup(false);
      }
    };
    window.addEventListener('mousedown', handleOutsideClick);
    return () => window.removeEventListener('mousedown', handleOutsideClick);
  }, [showAddOptionsPopup]);

  // 扫描项目中可能存在的环境配置文件 (如 conf/*.conf, application-*.yml 等)
  useEffect(() => {
    if (!isOpen || !workspace) return;
    let canceled = false;

    const scan = async () => {
      setScanning(true);
      const presets: DetectedEnvPreset[] = [];

      const candidateDirs = [
        'src/main/resources/conf',
        'src/main/resources',
        'conf',
        'resources',
      ];

      for (const dir of candidateDirs) {
        try {
          const files = await window.ide.listDir(dir);
          if (Array.isArray(files)) {
            for (const f of files) {
              const fileName = f.name;
              let envName = '';
              const matchConf = fileName.match(/^([a-zA-Z0-9_-]+)-application\.conf$/i);
              const matchAppConf = fileName.match(/^application-([a-zA-Z0-9_-]+)\.(ya?ml|properties|conf)$/i);
              const matchSimple = fileName.match(/^([a-zA-Z0-9_-]+)\.conf$/i);

              if (matchConf) {
                envName = matchConf[1];
              } else if (matchAppConf) {
                envName = matchAppConf[1];
              } else if (matchSimple && !['application', 'log4j'].includes(matchSimple[1].toLowerCase())) {
                envName = matchSimple[1];
              }

              if (envName && !presets.some((p) => p.envKey === envName)) {
                presets.push({
                  name: envName,
                  envKey: envName,
                  fullRelPath: `${dir}/${fileName}`,
                });
              }
            }
          }
        } catch {
          // ignore directory read error
        }
      }

      if (!canceled) {
        setDetectedPresets(presets);
        setScanning(false);
      }
    };

    void scan();
    return () => {
      canceled = true;
    };
  }, [isOpen, workspace]);

  const handleSave = useCallback(() => {
    saveProjectRuntimeConfig(config, workspace);
    onShowToast?.('运行时参数已保存', '当前项目级 JVM 参数与高级运行选项已保存并生效', 'success');
    onClose();
  }, [config, workspace, onShowToast, onClose]);

  const handleReset = useCallback(() => {
    setConfig({ ...DEFAULT_RUNTIME_CONFIG });
    saveProjectRuntimeConfig(DEFAULT_RUNTIME_CONFIG, workspace);
    onShowToast?.('已清空运行参数', '已恢复为默认配置状态', 'info');
  }, [workspace, onShowToast]);

  // 可再次点击取消的智能环境预设切换逻辑
  const handleTogglePreset = useCallback((preset: DetectedEnvPreset) => {
    const targetFlag = `-Denv=${preset.envKey}`;
    setConfig((prev) => {
      const current = prev.vmArgs.trim();
      const isAlreadyApplied = current.includes(targetFlag);

      if (isAlreadyApplied) {
        // 取消选中：移除 -Denv=${preset.envKey}
        const regex = new RegExp(`(^|\\s)-Denv=${preset.envKey}(?=\\s|$)`, 'g');
        const updated = current.replace(regex, ' ').replace(/\s+/g, ' ').trim();
        onShowToast?.(`已取消环境参数: ${targetFlag}`, undefined, 'info');
        return { ...prev, vmArgs: updated };
      } else {
        // 切换选中：如果已有其它 -Denv=...，直接替换，避免同时选中冲突的环境
        const anyEnvRegex = /(^|\s)-Denv=[^\s]+(?=\s|$)/g;
        let updated: string;
        if (anyEnvRegex.test(current)) {
          updated = current.replace(anyEnvRegex, ` ${targetFlag}`).replace(/\s+/g, ' ').trim();
        } else {
          updated = current ? `${current} ${targetFlag}` : targetFlag;
        }
        onShowToast?.(`已切换环境参数为: ${targetFlag}`, `对应配置文件: ${preset.fullRelPath}`, 'info');
        return { ...prev, vmArgs: updated };
      }
    });
  }, [onShowToast]);

  // 快捷填入参数也支持再次点击切换取消
  const handleToggleVmArg = useCallback((flag: string) => {
    setConfig((prev) => {
      const current = prev.vmArgs.trim();
      if (current.includes(flag)) {
        const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, 'g');
        const updated = current.replace(regex, ' ').replace(/\s+/g, ' ').trim();
        onShowToast?.(`已取消参数: ${flag}`, undefined, 'info');
        return { ...prev, vmArgs: updated };
      } else {
        const updated = current ? `${current} ${flag}` : flag;
        onShowToast?.(`已添加参数: ${flag}`, undefined, 'info');
        return { ...prev, vmArgs: updated };
      }
    });
  }, [onShowToast]);

  // 已启用的高级运行选项摘要（开关统一在「添加运行选项」弹层里操作）
  const enabledOptions = useMemo<
    Array<{ key: keyof ProjectRuntimeConfig; label: string }>
  >(() => {
    const all: Array<{ key: keyof ProjectRuntimeConfig; label: string }> = [
      { key: 'addProvidedToClasspath', label: 'provided 依赖加入类路径' },
      { key: 'skipBuildBeforeRun', label: '运行前不编译' },
      { key: 'shortenCommandLine', label: '缩短命令行' },
      { key: 'allowMultipleInstances', label: '允许并发多实例' },
      { key: 'saveConsoleToFile', label: '控制台日志存文件' },
      { key: 'showSettingsBeforeRun', label: '启动前显示配置' },
    ];
    return all.filter((o) => config[o.key] === true);
  }, [config]);

  // 计算示例实时命令预览
  const previewCommand = useMemo(() => {
    const activeFileName = activePath ? activePath.split('/').pop() || '' : '';
    const isCpp = /\.(cpp|cc|cxx|hpp|hh)$/i.test(activeFileName);
    const isC = /\.(c|h)$/i.test(activeFileName);

    if (isCpp || isC) {
      const baseName = activeFileName.replace(/\.[^.]+$/, '');
      const compiler = isCpp ? 'clang++' : 'clang';
      const stdFlag = isCpp ? '-std=c++17 ' : '-std=c11 ';
      const progArgs = config.programArgs.trim() ? ` ${config.programArgs.trim()}` : '';
      const logRedirect = config.saveConsoleToFile ? ' | tee -a .echoly/logs/run.log' : '';
      let cmd = `mkdir -p .echoly/bin && ${compiler} ${stdFlag}-g "${activeFileName}" -o ".echoly/bin/${baseName}" && "./echoly/bin/${baseName}"${progArgs}${logRedirect}`;
      if (config.envVars.trim()) {
        return `export ${config.envVars.trim().replace(/,/g, ' ')} && ${cmd}`;
      }
      return cmd;
    }

    const className = activeFileName?.replace(/\.java$/, '') || 'TechnologyTacticsJob';

    const compilePhase = config.skipBuildBeforeRun ? '' : 'compile ';
    const providedScopeArg = config.addProvidedToClasspath ? ' -Dexec.classpathScope=compile' : '';

    let cmd = `./mvnw ${compilePhase}exec:java -Dexec.mainClass="com.tsingtec.${className}"${providedScopeArg}`;
    if (config.activeProfiles.trim()) {
      cmd += ` -P${config.activeProfiles.trim()}`;
    }
    if (config.vmArgs.trim()) {
      cmd += ` ${config.vmArgs.trim()}`;
    }
    if (config.programArgs.trim()) {
      cmd += ` -Dexec.args="${config.programArgs.trim()}"`;
    }
    if (config.saveConsoleToFile) {
      cmd += ' | tee -a .echoly/logs/run.log';
    }

    if (config.envVars.trim()) {
      return `export ${config.envVars.trim().replace(/,/g, ' ')} && ${cmd}`;
    }
    return cmd;
  }, [activePath, config]);

  if (!isOpen) return null;

  const projectName = workspace ? workspace.split('/').pop() : '全局';

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 99999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.65)',
        backdropFilter: 'blur(4px)',
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        className="runtime-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="runtime-modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 16 }}>⚡</span>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-bright, #fff)' }}>
                项目全局运行参数配置 (Run / Debug Configuration)
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>
                配置当前项目的 JVM 属性、环境变量、启动参数及类路径高级运行选项
              </div>
            </div>
          </div>
          <button
            type="button"
            className="panel-action-btn"
            onClick={onClose}
            title="关闭"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="runtime-body">
          {/* 项目绑定确认横幅 */}
          <div className="runtime-bind-banner">
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <span>📁</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                当前配置绑定至项目: <strong>{projectName}</strong>
                {workspace && <span style={{ opacity: 0.75, marginLeft: 6 }}>({workspace})</span>}
              </span>
            </div>
            <div style={{ fontSize: 11, color: '#34d399', display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
              <span>✓</span> 独立项目级配置已绑定
            </div>
          </div>

          {/* 智能检测到的环境配置文件预设（支持再次点击取消） */}
          {detectedPresets.length > 0 && (
            <div className="runtime-section runtime-preset-section">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: '#38bdf8' }}>
                  <span>💡</span> 检测到项目中存在的环境配置 (点击单选/再次点击取消):
                </div>
                <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>自动匹配 -Denv=...</span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {detectedPresets.map((preset) => {
                  const isApplied = config.vmArgs.includes(`-Denv=${preset.envKey}`);
                  return (
                    <button
                      key={preset.envKey}
                      type="button"
                      className="runtime-preset-chip"
                      onClick={() => handleTogglePreset(preset)}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 5,
                        padding: '4px 10px',
                        borderRadius: 4,
                        fontSize: 11.5,
                        background: isApplied ? 'rgba(56, 189, 248, 0.25)' : 'rgba(255, 255, 255, 0.06)',
                        border: isApplied ? '1px solid #38bdf8' : '1px solid var(--border)',
                        color: isApplied ? '#38bdf8' : 'var(--text)',
                        cursor: 'pointer',
                        transition: 'all 0.15s ease',
                      }}
                      title={isApplied ? `点击取消 -Denv=${preset.envKey}` : `点击应用 -Denv=${preset.envKey} (对应文件: ${preset.fullRelPath})`}
                    >
                      <span style={{ fontSize: 11 }}>⚡</span>
                      <span>{preset.name}</span>
                      {isApplied ? (
                        <span style={{ fontSize: 11, color: '#34d399', fontWeight: 'bold' }}>✓</span>
                      ) : (
                        <span style={{ fontSize: 10, opacity: 0.4 }}>+</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* 启动参数 */}
          <div className="runtime-section">
            <div className="runtime-section-label">启动参数</div>

            <div className="runtime-field">
              <div className="runtime-field-head">
                <label className="runtime-field-title">☕ JVM 虚拟机参数 (VM Options)</label>
                <span className="runtime-field-hint">传递给 System.getProperty()</span>
              </div>
              <input
                type="text"
                value={config.vmArgs}
                onChange={(e) => setConfig({ ...config, vmArgs: e.target.value })}
                placeholder="例如: -Denv=local-dev -Dfile.encoding=UTF-8 -Xms256m -Xmx1024m"
                className="runtime-input"
              />
              {/* 常用 JVM 快捷标记（支持点击添加/取消） */}
              <div className="runtime-chip-row">
                <span className="runtime-field-hint">快捷参数:</span>
                {[
                  '-Denv=local-dev',
                  '-Dfile.encoding=UTF-8',
                  '-Xmx1024m',
                  '-Dspring.profiles.active=dev',
                ].map((flag) => {
                  const isPresent = config.vmArgs.includes(flag);
                  return (
                    <button
                      key={flag}
                      type="button"
                      className="runtime-preset-chip"
                      onClick={() => handleToggleVmArg(flag)}
                      style={{
                        fontSize: 10.5,
                        padding: '2px 7px',
                        borderRadius: 3,
                        background: isPresent ? 'rgba(56, 189, 248, 0.2)' : 'rgba(255, 255, 255, 0.05)',
                        border: isPresent ? '1px solid rgba(56, 189, 248, 0.6)' : '1px solid rgba(255, 255, 255, 0.1)',
                        color: isPresent ? '#38bdf8' : 'var(--text)',
                        cursor: 'pointer',
                      }}
                      title={isPresent ? `点击移除 ${flag}` : `点击添加 ${flag}`}
                    >
                      {isPresent ? `✓ ${flag}` : `+ ${flag}`}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* 高级运行选项卡片与“添加运行选项”按钮 (融入图 3 选项) */}
          <div className="runtime-section runtime-section-plain">
            <div className="runtime-options-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 13 }}>⚙️</span>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-bright)' }}>
                  运行与类路径高级选项 (Run Options)
                </span>
              </div>
              <div style={{ position: 'relative' }} ref={addOptionsRef}>
                <button
                  type="button"
                  className="runtime-add-options-btn"
                  onClick={() => setShowAddOptionsPopup((p) => !p)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    padding: '3px 9px',
                    borderRadius: 4,
                    fontSize: 11,
                    background: showAddOptionsPopup ? 'rgba(56, 189, 248, 0.2)' : 'rgba(255, 255, 255, 0.07)',
                    border: '1px solid var(--border)',
                    color: 'var(--text-bright)',
                    cursor: 'pointer',
                  }}
                >
                  <span>+ 添加运行选项 (Add Run Options)...</span>
                  <span style={{ fontSize: 9 }}>▼</span>
                </button>

                {/* 图 3 完整弹出选项菜单 (中文与英文对应，支持鼠标平滑滚动，完美适配应用主题) */}
                {showAddOptionsPopup && (
                  <div
                    onWheel={(e) => e.stopPropagation()}
                    style={{
                      position: 'absolute',
                      right: 0,
                      top: '100%',
                      marginTop: 6,
                      zIndex: 1000,
                      width: 330,
                      maxHeight: 260,
                      overflowY: 'auto',
                      overscrollBehavior: 'contain',
                      background: 'var(--bg-elevated, #1c1c20)',
                      backdropFilter: 'blur(16px)',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      boxShadow: '0 12px 32px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.05)',
                      padding: 0,
                      fontSize: 12,
                    }}
                  >
                    <div
                      style={{
                        position: 'sticky',
                        top: 0,
                        zIndex: 5,
                        padding: '7px 12px',
                        background: 'var(--bg-panel, #25252b)',
                        borderBottom: '1px solid var(--border)',
                        fontWeight: 600,
                        fontSize: 11.5,
                        color: 'var(--text-bright, #fff)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                      }}
                    >
                      <span>Add Run Options (添加运行选项)</span>
                      <span style={{ fontSize: 10, color: 'var(--muted)' }}>滚动浏览全部</span>
                    </div>

                    {/* Java 分组 */}
                    <div
                      style={{
                        padding: '6px 12px 2px',
                        fontSize: 10,
                        fontWeight: 600,
                        color: 'var(--muted)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.5px',
                        background: 'rgba(255, 255, 255, 0.02)',
                      }}
                    >
                      Java 与类路径
                    </div>

                    {/* 用户图 3 红框强调项：Add dependencies with "provided" scope to classpath */}
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '6px 12px',
                        cursor: 'pointer',
                        background: config.addProvidedToClasspath ? 'rgba(56, 189, 248, 0.12)' : 'transparent',
                        borderLeft: config.addProvidedToClasspath ? '3px solid #38bdf8' : '3px solid transparent',
                        transition: 'background 0.15s ease',
                      }}
                      onMouseEnter={(e) => {
                        if (!config.addProvidedToClasspath) e.currentTarget.style.background = 'var(--bg-hover, rgba(255,255,255,0.05))';
                      }}
                      onMouseLeave={(e) => {
                        if (!config.addProvidedToClasspath) e.currentTarget.style.background = 'transparent';
                      }}
                    >
                      <div style={{ paddingRight: 8 }}>
                        <div style={{ color: 'var(--text-bright, #fff)', fontSize: 11.5, fontWeight: 500 }}>
                          将 "provided" 作用域依赖添加到类路径
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--muted)' }}>
                          Add dependencies with "provided" scope to classpath
                        </div>
                      </div>
                      <input
                        type="checkbox"
                        checked={config.addProvidedToClasspath}
                        onChange={(e) => setConfig({ ...config, addProvidedToClasspath: e.target.checked })}
                        style={{ accentColor: '#38bdf8', cursor: 'pointer' }}
                      />
                    </label>

                    {/* Do not build before run */}
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '6px 12px',
                        cursor: 'pointer',
                        background: config.skipBuildBeforeRun ? 'rgba(56, 189, 248, 0.12)' : 'transparent',
                        borderLeft: config.skipBuildBeforeRun ? '3px solid #38bdf8' : '3px solid transparent',
                        transition: 'background 0.15s ease',
                      }}
                      onMouseEnter={(e) => {
                        if (!config.skipBuildBeforeRun) e.currentTarget.style.background = 'var(--bg-hover, rgba(255,255,255,0.05))';
                      }}
                      onMouseLeave={(e) => {
                        if (!config.skipBuildBeforeRun) e.currentTarget.style.background = 'transparent';
                      }}
                    >
                      <div style={{ paddingRight: 8 }}>
                        <div style={{ color: 'var(--text-bright, #fff)', fontSize: 11.5, fontWeight: 500 }}>
                          运行前不执行编译 (秒级直接启动)
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--muted)' }}>
                          Do not build before run
                        </div>
                      </div>
                      <input
                        type="checkbox"
                        checked={config.skipBuildBeforeRun}
                        onChange={(e) => setConfig({ ...config, skipBuildBeforeRun: e.target.checked })}
                        style={{ accentColor: '#38bdf8', cursor: 'pointer' }}
                      />
                    </label>

                    {/* Shorten command line */}
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '6px 12px',
                        cursor: 'pointer',
                        background: config.shortenCommandLine ? 'rgba(56, 189, 248, 0.12)' : 'transparent',
                        borderLeft: config.shortenCommandLine ? '3px solid #38bdf8' : '3px solid transparent',
                        transition: 'background 0.15s ease',
                      }}
                      onMouseEnter={(e) => {
                        if (!config.shortenCommandLine) e.currentTarget.style.background = 'var(--bg-hover, rgba(255,255,255,0.05))';
                      }}
                      onMouseLeave={(e) => {
                        if (!config.shortenCommandLine) e.currentTarget.style.background = 'transparent';
                      }}
                    >
                      <div style={{ paddingRight: 8 }}>
                        <div style={{ color: 'var(--text-bright, #fff)', fontSize: 11.5, fontWeight: 500 }}>
                          缩短超长命令行 (优化类路径)
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--muted)' }}>
                          Shorten command line
                        </div>
                      </div>
                      <input
                        type="checkbox"
                        checked={config.shortenCommandLine}
                        onChange={(e) => setConfig({ ...config, shortenCommandLine: e.target.checked })}
                        style={{ accentColor: '#38bdf8', cursor: 'pointer' }}
                      />
                    </label>

                    {/* Operating System 分组 */}
                    <div
                      style={{
                        padding: '6px 12px 2px',
                        fontSize: 10,
                        fontWeight: 600,
                        color: 'var(--muted)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.5px',
                        background: 'rgba(255, 255, 255, 0.02)',
                        borderTop: '1px solid var(--border)',
                        marginTop: 2,
                      }}
                    >
                      Operating System (操作系统与进程)
                    </div>
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '6px 12px',
                        cursor: 'pointer',
                        background: config.allowMultipleInstances ? 'rgba(56, 189, 248, 0.12)' : 'transparent',
                        borderLeft: config.allowMultipleInstances ? '3px solid #38bdf8' : '3px solid transparent',
                        transition: 'background 0.15s ease',
                      }}
                      onMouseEnter={(e) => {
                        if (!config.allowMultipleInstances) e.currentTarget.style.background = 'var(--bg-hover, rgba(255,255,255,0.05))';
                      }}
                      onMouseLeave={(e) => {
                        if (!config.allowMultipleInstances) e.currentTarget.style.background = 'transparent';
                      }}
                    >
                      <div style={{ paddingRight: 8 }}>
                        <div style={{ color: 'var(--text-bright, #fff)', fontSize: 11.5, fontWeight: 500 }}>
                          允许并发运行多个实例
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--muted)' }}>
                          Allow multiple instances
                        </div>
                      </div>
                      <input
                        type="checkbox"
                        checked={config.allowMultipleInstances}
                        onChange={(e) => setConfig({ ...config, allowMultipleInstances: e.target.checked })}
                        style={{ accentColor: '#38bdf8', cursor: 'pointer' }}
                      />
                    </label>

                    {/* Logs & Launch 分组 */}
                    <div
                      style={{
                        padding: '6px 12px 2px',
                        fontSize: 10,
                        fontWeight: 600,
                        color: 'var(--muted)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.5px',
                        background: 'rgba(255, 255, 255, 0.02)',
                        borderTop: '1px solid var(--border)',
                        marginTop: 2,
                      }}
                    >
                      Logs &amp; Launch (日志与启动)
                    </div>
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '6px 12px',
                        cursor: 'pointer',
                        background: config.saveConsoleToFile ? 'rgba(56, 189, 248, 0.12)' : 'transparent',
                        borderLeft: config.saveConsoleToFile ? '3px solid #38bdf8' : '3px solid transparent',
                        transition: 'background 0.15s ease',
                      }}
                      onMouseEnter={(e) => {
                        if (!config.saveConsoleToFile) e.currentTarget.style.background = 'var(--bg-hover, rgba(255,255,255,0.05))';
                      }}
                      onMouseLeave={(e) => {
                        if (!config.saveConsoleToFile) e.currentTarget.style.background = 'transparent';
                      }}
                    >
                      <div style={{ paddingRight: 8 }}>
                        <div style={{ color: 'var(--text-bright, #fff)', fontSize: 11.5, fontWeight: 500 }}>
                          将控制台输出保存到文件
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--muted)' }}>
                          Save console output to file (.echoly/logs/run.log)
                        </div>
                      </div>
                      <input
                        type="checkbox"
                        checked={config.saveConsoleToFile}
                        onChange={(e) => setConfig({ ...config, saveConsoleToFile: e.target.checked })}
                        style={{ accentColor: '#38bdf8', cursor: 'pointer' }}
                      />
                    </label>

                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '6px 12px',
                        cursor: 'pointer',
                        background: config.showSettingsBeforeRun ? 'rgba(56, 189, 248, 0.12)' : 'transparent',
                        borderLeft: config.showSettingsBeforeRun ? '3px solid #38bdf8' : '3px solid transparent',
                        transition: 'background 0.15s ease',
                      }}
                      onMouseEnter={(e) => {
                        if (!config.showSettingsBeforeRun) e.currentTarget.style.background = 'var(--bg-hover, rgba(255,255,255,0.05))';
                      }}
                      onMouseLeave={(e) => {
                        if (!config.showSettingsBeforeRun) e.currentTarget.style.background = 'transparent';
                      }}
                    >
                      <div style={{ paddingRight: 8 }}>
                        <div style={{ color: 'var(--text-bright, #fff)', fontSize: 11.5, fontWeight: 500 }}>
                          每次启动前显示此运行配置
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--muted)' }}>
                          Show settings before start
                        </div>
                      </div>
                      <input
                        type="checkbox"
                        checked={config.showSettingsBeforeRun}
                        onChange={(e) => setConfig({ ...config, showSettingsBeforeRun: e.target.checked })}
                        style={{ accentColor: '#38bdf8', cursor: 'pointer' }}
                      />
                    </label>
                  </div>
                )}
              </div>
            </div>

            {/* 已启用的选项摘要：开关本身只在「添加运行选项」弹层里操作，
                这里仅展示结果，避免同一选项出现两处勾选框 */}
            <div className="runtime-option-summary">
              {enabledOptions.length === 0 ? (
                <span className="runtime-field-hint">
                  暂未启用任何高级选项，点击右上角「添加运行选项」进行配置。
                </span>
              ) : (
                enabledOptions.map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    className="runtime-preset-chip runtime-option-chip"
                    onClick={() => setConfig({ ...config, [opt.key]: false } as ProjectRuntimeConfig)}
                    title={`点击关闭「${opt.label}」`}
                  >
                    <span className="runtime-option-check">✓</span>
                    <span>{opt.label}</span>
                    <span className="runtime-option-remove">×</span>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* 程序启动参数 (Program Arguments) */}
          <div className="runtime-field">
            <div className="runtime-field-head">
              <label className="runtime-field-title">📦 程序启动参数 (Program Arguments)</label>
              <span className="runtime-field-hint">传递给 main(String[] args) 入口参数</span>
            </div>
            <input
              type="text"
              value={config.programArgs}
              onChange={(e) => setConfig({ ...config, programArgs: e.target.value })}
              placeholder="例如: --server.port=8080 --mode=standalone"
              className="runtime-input"
            />
          </div>

          {/* 环境变量 (Environment Variables) 与 Maven Profile */}
          <div className="runtime-field-grid">
            <div className="runtime-field">
              <label className="runtime-field-title">🌐 系统环境变量 (Environment Variables)</label>
              <input
                type="text"
                value={config.envVars}
                onChange={(e) => setConfig({ ...config, envVars: e.target.value })}
                placeholder="KEY=VALUE (逗号分隔)"
                className="runtime-input"
              />
            </div>

            <div className="runtime-field">
              <label className="runtime-field-title">🏷️ Maven 激活 Profile (-P)</label>
              <input
                type="text"
                value={config.activeProfiles}
                onChange={(e) => setConfig({ ...config, activeProfiles: e.target.value })}
                placeholder="例如: dev, local"
                className="runtime-input"
              />
            </div>
          </div>

          {/* 实时生成运行命令预览 */}
          <div className="runtime-command-preview">
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ color: '#4ade80' }}>●</span> 运行命令实时预览效果:
            </div>
            <div
              style={{
                fontSize: 11.5,
                fontFamily: 'var(--font-mono, monospace)',
                color: '#86efac',
                wordBreak: 'break-all',
                lineHeight: 1.4,
              }}
            >
              {previewCommand}
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="runtime-modal-footer">
          <button type="button" className="runtime-reset-btn" onClick={handleReset}>
            重置参数
          </button>

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="panel-standard-btn"
              onClick={onClose}
              style={{ fontSize: 12, padding: '5px 14px' }}
            >
              取消
            </button>
            <button
              type="button"
              className="panel-standard-btn runtime-save-btn"
              onClick={handleSave}
            >
              保存并应用
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

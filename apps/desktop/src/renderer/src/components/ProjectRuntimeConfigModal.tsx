import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';

export interface ProjectRuntimeConfig {
  vmArgs: string; // 编译器标志 / JVM 参数 / 解释器参数
  programArgs: string; // 主程序命令行参数
  activeProfiles: string; // Maven Profile / 构建类型 (Debug/Release) / 运行模式
  envVars: string; // 环境变量，KEY=VALUE (逗号或换行分隔)
  // 高级运行选项 (IntelliJ IDEA 规范)
  addProvidedToClasspath: boolean; // 仅 Java: 将 "provided" 依赖添加到类路径
  skipBuildBeforeRun: boolean; // 运行前不执行编译 (秒级直接启动已有二进制)
  allowMultipleInstances: boolean; // 允许并发运行多个实例
  shortenCommandLine: boolean; // 仅 Java: 缩短命令行
  saveConsoleToFile: boolean; // 将控制台输出保存到文件
  showSettingsBeforeRun: boolean; // 启动前显示此运行配置
}

export type RuntimeLanguage = 'cpp' | 'java' | 'python' | 'go' | 'node';

export const DEFAULT_RUNTIME_CONFIG: ProjectRuntimeConfig = {
  vmArgs: '',
  programArgs: '',
  activeProfiles: '',
  envVars: '',
  addProvidedToClasspath: true, // 仅在 Java 下生效
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
        addProvidedToClasspath: parsed.addProvidedToClasspath !== false,
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

export const RUNTIME_LANG_META: Record<
  RuntimeLanguage,
  { label: string; tag: string; desc: string; icon: string }
> = {
  cpp: { label: 'C / C++', tag: 'Clang / CMake', desc: 'Clang/CMake 构建参数与二进制启动配置', icon: '🚀' },
  java: { label: 'Java', tag: 'Maven / Exec', desc: 'JVM 虚拟机参数与 Maven 构建 Profiles', icon: '☕' },
  python: { label: 'Python', tag: 'Python 3', desc: 'Python 解释器参数、环境变量与脚本启动', icon: '🐍' },
  go: { label: 'Go', tag: 'Go Module', desc: 'Go Run 启动参数与编译 Flags', icon: '🐹' },
  node: { label: 'Node.js', tag: 'TS / Vite', desc: 'Node / TS 运行时参数与执行环境', icon: '🟢' },
};

export function inferProjectLanguage(activePath?: string, workspace?: string): RuntimeLanguage {
  const activeFileName = (activePath || '').split('/').pop() || '';
  if (/\.(cpp|cc|cxx|c|h|hpp|hh)$/i.test(activeFileName)) return 'cpp';
  if (/\.java$/i.test(activeFileName)) return 'java';
  if (/\.(py|pyw)$/i.test(activeFileName)) return 'python';
  if (/\.go$/i.test(activeFileName)) return 'go';
  if (/\.(ts|tsx|js|jsx|mjs|cjs|json)$/i.test(activeFileName)) return 'node';

  const wsLower = (workspace || '').toLowerCase();
  if (wsLower.includes('test-c') || wsLower.includes('cpp') || wsLower.includes('c-') || wsLower.includes('cmake')) {
    return 'cpp';
  }
  if (wsLower.includes('python') || wsLower.includes('py-')) return 'python';
  if (wsLower.includes('go') || wsLower.includes('golang')) return 'go';
  if (wsLower.includes('node') || wsLower.includes('vue') || wsLower.includes('react')) return 'node';

  return 'java';
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
  const [_scanning, setScanning] = useState(false);
  const [showAddOptionsPopup, setShowAddOptionsPopup] = useState(false);
  const [copied, setCopied] = useState(false);
  const addOptionsRef = useRef<HTMLDivElement>(null);

  // 语言模式支持根据工程特征自动识别并锁定当前所需配置
  const inferred = useMemo(() => inferProjectLanguage(activePath, workspace), [activePath, workspace]);
  const [currentLang, setCurrentLang] = useState<RuntimeLanguage>(inferred);

  // 根目录工程特征嗅探以保证即使没有激活打开的文件也能准确推断
  useEffect(() => {
    if (!isOpen) return;
    const initial = inferProjectLanguage(activePath, workspace);
    setCurrentLang(initial);

    let canceled = false;
    const sniffWorkspace = async () => {
      if (!workspace || !window.ide?.listDir) return;
      try {
        const files = await window.ide.listDir('.');
        if (canceled || !Array.isArray(files)) return;
        const fileNames = files.map((f) => f.name.toLowerCase());
        const hasActiveSpecificExt = activePath && /\.(cpp|cc|cxx|c|h|hpp|java|py|go|ts|tsx|js)$/i.test(activePath);
        if (hasActiveSpecificExt) return;

        if (fileNames.includes('cmakelists.txt') || fileNames.includes('makefile') || fileNames.some(n => /\.(cpp|cc|cxx)$/.test(n))) {
          setCurrentLang('cpp');
        } else if (fileNames.includes('pom.xml') || fileNames.includes('mvnw') || fileNames.includes('build.gradle')) {
          setCurrentLang('java');
        } else if (fileNames.includes('requirements.txt') || fileNames.includes('pyproject.toml') || fileNames.some(n => /\.py$/.test(n))) {
          setCurrentLang('python');
        } else if (fileNames.includes('go.mod') || fileNames.some(n => /\.go$/.test(n))) {
          setCurrentLang('go');
        } else if (fileNames.includes('package.json') || fileNames.includes('tsconfig.json')) {
          setCurrentLang('node');
        }
      } catch {}
    };
    void sniffWorkspace();
    return () => { canceled = true; };
  }, [isOpen, activePath, workspace]);

  // ESC 快捷键取消/关闭
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

  // 加载配置
  useEffect(() => {
    if (isOpen) {
      setConfig(loadProjectRuntimeConfig(workspace));
      setShowAddOptionsPopup(false);
      setCopied(false);
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

  // 扫描项目中可能存在的环境配置文件 (仅 Java 项目自动嗅探 conf/*.conf, application-*.yml)
  useEffect(() => {
    if (!isOpen || !workspace || currentLang !== 'java') {
      setDetectedPresets([]);
      return;
    }
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
  }, [isOpen, workspace, currentLang]);

  const handleSave = useCallback(() => {
    saveProjectRuntimeConfig(config, workspace);
    onShowToast?.('运行时参数已保存', '当前项目级参数与高级运行选项已保存并生效', 'success');
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
        const regex = new RegExp(`(^|\\s)-Denv=${preset.envKey}(?=\\s|$)`, 'g');
        const updated = current.replace(regex, ' ').replace(/\s+/g, ' ').trim();
        onShowToast?.(`已取消环境参数: ${targetFlag}`, undefined, 'info');
        return { ...prev, vmArgs: updated };
      } else {
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

  // 快捷填入右侧 Profile / Build Type
  const handleToggleProfile = useCallback((val: string) => {
    setConfig((prev) => {
      if (prev.activeProfiles.trim() === val) {
        onShowToast?.(`已取消: ${val}`, undefined, 'info');
        return { ...prev, activeProfiles: '' };
      }
      onShowToast?.(`已设定: ${val}`, undefined, 'info');
      return { ...prev, activeProfiles: val };
    });
  }, [onShowToast]);

  // 快捷填入环境变量
  const handleToggleEnvVar = useCallback((chip: string) => {
    setConfig((prev) => {
      const current = prev.envVars.split(',').map((s) => s.trim()).filter(Boolean);
      const isPresent = current.includes(chip);
      const next = isPresent ? current.filter((c) => c !== chip) : [...current, chip];
      return { ...prev, envVars: next.join(',') };
    });
  }, []);

  // 根据当前语言严格过滤已启用的高级运行选项（非 Java 项目绝对不展示 provided 依赖与缩短命令行）
  const enabledOptions = useMemo<
    Array<{ key: keyof ProjectRuntimeConfig; label: string }>
  >(() => {
    const all: Array<{ key: keyof ProjectRuntimeConfig; label: string; javaOnly?: boolean }> = [
      { key: 'addProvidedToClasspath', label: 'provided 依赖加入类路径', javaOnly: true },
      { key: 'skipBuildBeforeRun', label: '运行前不编译' },
      { key: 'shortenCommandLine', label: '缩短命令行', javaOnly: true },
      { key: 'allowMultipleInstances', label: '允许并发多实例' },
      { key: 'saveConsoleToFile', label: '控制台日志存文件' },
      { key: 'showSettingsBeforeRun', label: '启动前显示配置' },
    ];
    return all.filter((o) => {
      if (o.javaOnly && currentLang !== 'java') return false;
      return config[o.key] === true;
    });
  }, [config, currentLang]);

  // 选项弹层中按语言区分的选项组
  const optionGroups = useMemo(() => {
    if (currentLang === 'java') {
      return [
        {
          group: 'Java 与类路径',
          items: [
            {
              key: 'addProvidedToClasspath' as const,
              title: '将 "provided" 作用域依赖添加到类路径',
              desc: 'Add dependencies with "provided" scope to classpath',
            },
            {
              key: 'skipBuildBeforeRun' as const,
              title: '运行前不执行编译 (秒级直接启动)',
              desc: 'Do not build before run',
            },
            {
              key: 'shortenCommandLine' as const,
              title: '缩短超长命令行 (优化类路径)',
              desc: 'Shorten command line',
            },
          ],
        },
        {
          group: '操作系统与进程',
          items: [
            {
              key: 'allowMultipleInstances' as const,
              title: '允许并发运行多个实例',
              desc: 'Allow multiple instances',
            },
          ],
        },
        {
          group: '日志与启动控制',
          items: [
            {
              key: 'saveConsoleToFile' as const,
              title: '将控制台输出保存到文件',
              desc: 'Save console output to file (.echoly/logs/run.log)',
            },
            {
              key: 'showSettingsBeforeRun' as const,
              title: '每次启动前显示此运行配置',
              desc: 'Show settings before start',
            },
          ],
        },
      ];
    }

    if (currentLang === 'cpp') {
      return [
        {
          group: 'C / C++ 构建与执行',
          items: [
            {
              key: 'skipBuildBeforeRun' as const,
              title: '运行前跳过重新编译 (直接执行已有二进制)',
              desc: 'Do not build before run',
            },
          ],
        },
        {
          group: '进程与调试控制',
          items: [
            {
              key: 'allowMultipleInstances' as const,
              title: '允许并发运行多个实例',
              desc: 'Allow multiple instances',
            },
            {
              key: 'saveConsoleToFile' as const,
              title: '将控制台输出保存到文件',
              desc: 'Save console output to file (.echoly/logs/run.log)',
            },
            {
              key: 'showSettingsBeforeRun' as const,
              title: '每次启动前显示此运行配置',
              desc: 'Show settings before start',
            },
          ],
        },
      ];
    }

    // Python / Go / Node.js
    return [
      {
        group: '执行准备',
        items: [
          {
            key: 'skipBuildBeforeRun' as const,
            title: '运行前跳过构建/检查阶段',
            desc: 'Do not build before run',
          },
        ],
      },
      {
        group: '进程与日志控制',
        items: [
          {
            key: 'allowMultipleInstances' as const,
            title: '允许并发运行多个实例',
            desc: 'Allow multiple instances',
          },
          {
            key: 'saveConsoleToFile' as const,
            title: '将控制台输出保存到文件',
            desc: 'Save console output to file (.echoly/logs/run.log)',
          },
          {
            key: 'showSettingsBeforeRun' as const,
            title: '每次启动前显示此运行配置',
            desc: 'Show settings before start',
          },
        ],
      },
    ];
  }, [currentLang]);

  // 计算多语言命令实时预览
  const previewCommand = useMemo(() => {
    const activeFileName = activePath ? activePath.split('/').pop() || '' : '';
    const logRedirect = config.saveConsoleToFile ? ' | tee -a .echoly/logs/run.log' : '';
    const envPrefix = config.envVars.trim() ? `export ${config.envVars.trim().replace(/,/g, ' ')} && ` : '';

    if (currentLang === 'cpp') {
      const isCpp = /\.(cpp|cc|cxx|hpp|hh)$/i.test(activeFileName);
      const compiler = isCpp ? 'clang++' : 'clang';
      const fileTarget = activeFileName || 'main.cpp';
      const baseName = fileTarget.replace(/\.[^.]+$/, '');
      const stdFlag = isCpp ? '-std=c++17 ' : '-std=c11 ';
      const compilerFlags = config.vmArgs.trim() ? ` ${config.vmArgs.trim()} ` : ' ';
      const progArgs = config.programArgs.trim() ? ` ${config.programArgs.trim()}` : '';
      const buildPhase = config.skipBuildBeforeRun
        ? ''
        : `mkdir -p .echoly/bin && ${compiler} ${stdFlag}${compilerFlags}-g "${fileTarget}" -o ".echoly/bin/${baseName}" && `;
      return `${envPrefix}${buildPhase}"./.echoly/bin/${baseName}"${progArgs}${logRedirect}`;
    }

    if (currentLang === 'python') {
      const targetFile = activeFileName || 'main.py';
      const pyFlags = config.vmArgs.trim() ? ` ${config.vmArgs.trim()}` : ' -u';
      const progArgs = config.programArgs.trim() ? ` ${config.programArgs.trim()}` : '';
      return `${envPrefix}python3${pyFlags} "${targetFile}"${progArgs}${logRedirect}`;
    }

    if (currentLang === 'go') {
      const targetFile = activeFileName || 'main.go';
      const goFlags = config.vmArgs.trim() ? ` ${config.vmArgs.trim()}` : '';
      const progArgs = config.programArgs.trim() ? ` ${config.programArgs.trim()}` : '';
      return `${envPrefix}go run${goFlags} "${targetFile}"${progArgs}${logRedirect}`;
    }

    if (currentLang === 'node') {
      const targetFile = activeFileName || 'index.ts';
      const nodeFlags = config.vmArgs.trim() ? ` ${config.vmArgs.trim()}` : '';
      const progArgs = config.programArgs.trim() ? ` ${config.programArgs.trim()}` : '';
      const runner = targetFile.endsWith('.ts') ? 'npx tsx' : 'node';
      return `${envPrefix}${runner}${nodeFlags} "${targetFile}"${progArgs}${logRedirect}`;
    }

    // Java
    const className = activeFileName ? activeFileName.replace(/\.java$/, '') : 'TechnologyTacticsJob';
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
    cmd += logRedirect;
    return `${envPrefix}${cmd}`;
  }, [currentLang, activePath, config]);

  // 一键复制命令
  const handleCopyCommand = useCallback(() => {
    void navigator.clipboard.writeText(previewCommand);
    setCopied(true);
    onShowToast?.('命令已复制到剪贴板', previewCommand, 'success');
    setTimeout(() => setCopied(false), 2000);
  }, [previewCommand, onShowToast]);

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
        background: 'rgba(0, 0, 0, 0.7)',
        backdropFilter: 'blur(5px)',
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 18 }}>⚡</span>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-bright, #fff)', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>项目全局运行参数配置 (Run / Debug Configuration)</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                针对不同编程语言智能提供定制参数、环境变量、独立构建变体与高级进程调试选项
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
          {/* 项目绑定确认横幅与语言聚焦指示器 */}
          <div className="runtime-bind-banner" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span style={{ fontSize: 14 }}>📁</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
                  配置绑定项目: <strong>{projectName}</strong>
                  {workspace && <span style={{ opacity: 0.7, marginLeft: 6 }}>({workspace})</span>}
                </span>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '2px 8px',
                    borderRadius: 4,
                    background: 'rgba(56, 189, 248, 0.16)',
                    color: '#38bdf8',
                    border: '1px solid rgba(56, 189, 248, 0.3)',
                    fontSize: 11,
                    fontWeight: 600,
                  }}
                  title={RUNTIME_LANG_META[currentLang].desc}
                >
                  <span>{RUNTIME_LANG_META[currentLang].icon}</span>
                  <span>{RUNTIME_LANG_META[currentLang].label} 专属配置</span>
                </span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ fontSize: 11, color: '#34d399', display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                  <span>✓</span> 项目级生效
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 11, color: 'var(--muted)' }}>切换技术栈:</span>
                  <select
                    className="runtime-lang-select"
                    value={currentLang}
                    onChange={(e) => {
                      const nextLang = e.target.value as RuntimeLanguage;
                      setCurrentLang(nextLang);
                      onShowToast?.(`已切换至 ${RUNTIME_LANG_META[nextLang].label} 配置模式`, undefined, 'info');
                    }}
                    style={{
                      background: 'rgba(255, 255, 255, 0.08)',
                      color: 'var(--text-bright, #fff)',
                      border: '1px solid var(--border)',
                      borderRadius: 4,
                      padding: '3px 8px',
                      fontSize: 11.5,
                      cursor: 'pointer',
                      outline: 'none',
                    }}
                  >
                    <option value="cpp" style={{ background: '#1e222d', color: '#fff' }}>🚀 C / C++</option>
                    <option value="java" style={{ background: '#1e222d', color: '#fff' }}>☕ Java</option>
                    <option value="python" style={{ background: '#1e222d', color: '#fff' }}>🐍 Python</option>
                    <option value="go" style={{ background: '#1e222d', color: '#fff' }}>🐹 Go</option>
                    <option value="node" style={{ background: '#1e222d', color: '#fff' }}>🟢 Node.js</option>
                  </select>
                </div>
              </div>
            </div>

            {/* 智能精简提示与所支持技术栈说明 */}
            <div
              style={{
                fontSize: 11,
                color: 'var(--muted, #94a3b8)',
                background: 'rgba(255, 255, 255, 0.03)',
                padding: '6px 10px',
                borderRadius: 6,
                border: '1px solid var(--border)',
                lineHeight: 1.5,
              }}
            >
              💡 已自动识别当前项目类型，<strong>仅呈现 {RUNTIME_LANG_META[currentLang].label} 所需配置</strong>（其他类型配置已过滤隐藏）。
              Echoly 运行配置亦原生支持: <strong>Java (Maven)、C/C++、Python、Go、Node.js</strong> 项目配置。
            </div>
          </div>

          {/* 智能检测到的环境配置文件预设（Java 项目独享） */}
          {currentLang === 'java' && detectedPresets.length > 0 && (
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

          {/* 启动参数 / 编译器标志 */}
          <div className="runtime-section">
            <div className="runtime-section-label">启动参数与运行选项</div>

            <div className="runtime-field">
              <div className="runtime-field-head">
                <label className="runtime-field-title">
                  {currentLang === 'cpp' && '⚙️ C/C++ 编译器标志 (Compiler Flags / CFLAGS / CXXFLAGS)'}
                  {currentLang === 'java' && '☕ JVM 虚拟机参数 (VM Options)'}
                  {currentLang === 'python' && '🐍 Python 解释器参数 (Python Options)'}
                  {currentLang === 'go' && '🐹 Go 构建与运行标志 (Go Build / Run Flags)'}
                  {currentLang === 'node' && '🟢 Node.js 运行时参数 (Node Options)'}
                </label>
                <span className="runtime-field-hint">
                  {currentLang === 'cpp' && '传递给 clang++ / g++ 编译选项'}
                  {currentLang === 'java' && '传递给 System.getProperty() 或 JVM 堆栈'}
                  {currentLang === 'python' && '传递给 python3 命令行选项'}
                  {currentLang === 'go' && '传递给 go run / go build 标志'}
                  {currentLang === 'node' && '传递给 node / tsx 进程标志'}
                </span>
              </div>
              <input
                type="text"
                value={config.vmArgs}
                onChange={(e) => setConfig({ ...config, vmArgs: e.target.value })}
                placeholder={
                  currentLang === 'cpp'
                    ? '例如: -std=c++17 -O2 -Wall -g -pthread'
                    : currentLang === 'java'
                    ? '例如: -Denv=local-dev -Dfile.encoding=UTF-8 -Xms256m -Xmx1024m'
                    : currentLang === 'python'
                    ? '例如: -u -B -W ignore'
                    : currentLang === 'go'
                    ? '例如: -race -v -tags=dev'
                    : '例如: --inspect --enable-source-maps --max-old-space-size=4096'
                }
                className="runtime-input"
              />
              {/* 常用快捷标记（支持点击添加/取消） */}
              <div className="runtime-chip-row">
                <span className="runtime-field-hint">快捷参数:</span>
                {(currentLang === 'cpp'
                  ? ['-std=c++17', '-std=c++20', '-O2', '-Wall', '-g', '-pthread', '-fsanitize=address']
                  : currentLang === 'java'
                  ? ['-Denv=local-dev', '-Dfile.encoding=UTF-8', '-Xmx1024m', '-Dspring.profiles.active=dev']
                  : currentLang === 'python'
                  ? ['-u', '-B', '-v', '-O', '-W ignore', '-m pytest']
                  : currentLang === 'go'
                  ? ['-race', '-v', '-tags=dev', '-ldflags="-s -w"']
                  : ['--inspect', '--enable-source-maps', '--trace-warnings', '--max-old-space-size=4096']
                ).map((flag) => {
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

          {/* 高级运行选项卡片与“添加运行选项”按钮 (严格根据当前语言隔离) */}
          <div className="runtime-section runtime-section-plain">
            <div className="runtime-options-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 13 }}>⚙️</span>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-bright)' }}>
                  运行与进程高级选项 (Run Options)
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

                {/* 弹出选项菜单：严格根据当前语言隔离 */}
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
                      maxHeight: 280,
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
                      <span>Add Run Options ({currentLang.toUpperCase()})</span>
                      <span style={{ fontSize: 10, color: 'var(--muted)' }}>勾选即可生效</span>
                    </div>

                    {optionGroups.map((grp) => (
                      <React.Fragment key={grp.group}>
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
                          }}
                        >
                          {grp.group}
                        </div>
                        {grp.items.map((item) => {
                          const isChecked = !!config[item.key];
                          return (
                            <label
                              key={item.key}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                padding: '6px 12px',
                                cursor: 'pointer',
                                background: isChecked ? 'rgba(56, 189, 248, 0.12)' : 'transparent',
                                borderLeft: isChecked ? '3px solid #38bdf8' : '3px solid transparent',
                                transition: 'background 0.15s ease',
                              }}
                              onMouseEnter={(e) => {
                                if (!isChecked) e.currentTarget.style.background = 'var(--bg-hover, rgba(255,255,255,0.05))';
                              }}
                              onMouseLeave={(e) => {
                                if (!isChecked) e.currentTarget.style.background = 'transparent';
                              }}
                            >
                              <div style={{ paddingRight: 8 }}>
                                <div style={{ color: 'var(--text-bright, #fff)', fontSize: 11.5, fontWeight: 500 }}>
                                  {item.title}
                                </div>
                                <div style={{ fontSize: 10, color: 'var(--muted)' }}>
                                  {item.desc}
                                </div>
                              </div>
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={(e) => setConfig({ ...config, [item.key]: e.target.checked } as ProjectRuntimeConfig)}
                                style={{ accentColor: '#38bdf8', cursor: 'pointer' }}
                              />
                            </label>
                          );
                        })}
                      </React.Fragment>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* 已启用的选项摘要：只读展示当前语言下的激活选项 */}
            <div className="runtime-option-summary">
              {enabledOptions.length === 0 ? (
                <span className="runtime-field-hint">
                  当前语言下暂未开启额外运行选项，可点击右上角「+ 添加运行选项」进行定制。
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
              <label className="runtime-field-title">📦 程序启动实参 (Program Arguments)</label>
              <span className="runtime-field-hint">
                {currentLang === 'cpp' && '传递给 main(int argc, char** argv)'}
                {currentLang === 'java' && '传递给 main(String[] args) 入口参数'}
                {currentLang === 'python' && '传递给 sys.argv 命令行实参'}
                {currentLang === 'go' && '传递给 os.Args 命令行切片'}
                {currentLang === 'node' && '传递给 process.argv 进程实参'}
              </span>
            </div>
            <input
              type="text"
              value={config.programArgs}
              onChange={(e) => setConfig({ ...config, programArgs: e.target.value })}
              placeholder={
                currentLang === 'cpp'
                  ? '例如: --config=app.json -v --threads=4'
                  : currentLang === 'java'
                  ? '例如: --server.port=8080 --mode=standalone'
                  : currentLang === 'python'
                  ? '例如: --port=8000 --reload --workers=4'
                  : currentLang === 'go'
                  ? '例如: --config=config.yaml -port=9000'
                  : '例如: --port=3000 --env=development'
              }
              className="runtime-input"
            />
          </div>

          {/* 环境变量 (Environment Variables) 与 构建类型/变体 (左右高度严格对称) */}
          <div className="runtime-field-grid">
            {/* 左列：环境变量 */}
            <div className="runtime-field">
              <label className="runtime-field-title">🌐 系统环境变量 (Environment Variables)</label>
              <input
                type="text"
                value={config.envVars}
                onChange={(e) => setConfig({ ...config, envVars: e.target.value })}
                placeholder={
                  currentLang === 'cpp'
                    ? 'LD_LIBRARY_PATH=.,DYLD_LIBRARY_PATH=.'
                    : currentLang === 'python'
                    ? 'PYTHONPATH=.,PYTHONUNBUFFERED=1'
                    : currentLang === 'go'
                    ? 'CGO_ENABLED=1,GOPROXY=https://goproxy.cn,direct'
                    : currentLang === 'node'
                    ? 'NODE_ENV=development,PORT=3000'
                    : 'KEY=VALUE (逗号分隔)'
                }
                className="runtime-input"
              />
              <div className="runtime-chip-row" style={{ marginTop: 4 }}>
                <span className="runtime-field-hint">快捷环境变量:</span>
                {(currentLang === 'cpp'
                  ? ['LD_LIBRARY_PATH=.', 'DYLD_LIBRARY_PATH=.', 'DEBUG=1']
                  : currentLang === 'python'
                  ? ['PYTHONPATH=.', 'PYTHONUNBUFFERED=1', 'FLASK_ENV=development']
                  : currentLang === 'go'
                  ? ['CGO_ENABLED=1', 'CGO_ENABLED=0', 'GOPROXY=https://goproxy.cn,direct']
                  : currentLang === 'node'
                  ? ['NODE_ENV=development', 'NODE_ENV=production', 'PORT=3000']
                  : ['SPRING_PROFILES_ACTIVE=dev', 'LOG_LEVEL=DEBUG']
                ).map((chip) => {
                  const isPresent = config.envVars.includes(chip);
                  return (
                    <button
                      key={chip}
                      type="button"
                      className="runtime-preset-chip"
                      onClick={() => handleToggleEnvVar(chip)}
                      style={{
                        fontSize: 10,
                        padding: '1px 6px',
                        borderRadius: 3,
                        background: isPresent ? 'rgba(56, 189, 248, 0.2)' : 'rgba(255, 255, 255, 0.05)',
                        border: isPresent ? '1px solid rgba(56, 189, 248, 0.6)' : '1px solid rgba(255, 255, 255, 0.1)',
                        color: isPresent ? '#38bdf8' : 'var(--text)',
                        cursor: 'pointer',
                      }}
                      title={isPresent ? `点击移除 ${chip}` : `点击添加 ${chip}`}
                    >
                      {isPresent ? `✓ ${chip}` : `+ ${chip}`}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 右列：构建类型 / 模式 (高度与左列完全对称) */}
            <div className="runtime-field">
              <label className="runtime-field-title">
                {currentLang === 'cpp' && '🏷️ 构建类型 / 变体 (Build Type)'}
                {currentLang === 'java' && '🏷️ Maven 激活 Profile (-P)'}
                {currentLang === 'python' && '🏷️ 运行模式 / 环境 (Mode)'}
                {currentLang === 'go' && '🏷️ 构建模式 (Build Mode)'}
                {currentLang === 'node' && '🏷️ 执行环境 (Target Mode)'}
              </label>
              <input
                type="text"
                value={config.activeProfiles}
                onChange={(e) => setConfig({ ...config, activeProfiles: e.target.value })}
                placeholder={
                  currentLang === 'cpp'
                    ? '例如: Debug 或 Release'
                    : currentLang === 'java'
                    ? '例如: dev, test, local'
                    : currentLang === 'python'
                    ? '例如: script, module, pytest'
                    : currentLang === 'go'
                    ? '例如: default, pie, race'
                    : '例如: development, production'
                }
                className="runtime-input"
              />
              <div className="runtime-chip-row" style={{ marginTop: 4 }}>
                <span className="runtime-field-hint">常用预设:</span>
                {(currentLang === 'cpp'
                  ? ['Debug', 'Release', 'RelWithDebInfo']
                  : currentLang === 'java'
                  ? ['dev', 'test', 'local', 'prod']
                  : currentLang === 'python'
                  ? ['script', 'module', 'pytest']
                  : currentLang === 'go'
                  ? ['default', 'pie', 'race']
                  : ['development', 'production', 'test']
                ).map((preset) => {
                  const isPresent = config.activeProfiles.trim() === preset;
                  return (
                    <button
                      key={preset}
                      type="button"
                      className="runtime-preset-chip"
                      onClick={() => handleToggleProfile(preset)}
                      style={{
                        fontSize: 10,
                        padding: '1px 6px',
                        borderRadius: 3,
                        background: isPresent ? 'rgba(56, 189, 248, 0.2)' : 'rgba(255, 255, 255, 0.05)',
                        border: isPresent ? '1px solid rgba(56, 189, 248, 0.6)' : '1px solid rgba(255, 255, 255, 0.1)',
                        color: isPresent ? '#38bdf8' : 'var(--text)',
                        cursor: 'pointer',
                      }}
                      title={isPresent ? `点击取消 ${preset}` : `点击应用 ${preset}`}
                    >
                      {isPresent ? `✓ ${preset}` : `+ ${preset}`}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* 拟真 macOS 终端实时命令预览卡片 */}
          <div className="runtime-terminal-card">
            <div className="runtime-terminal-titlebar">
              <div className="runtime-terminal-dots">
                <span className="runtime-terminal-dot red" />
                <span className="runtime-terminal-dot yellow" />
                <span className="runtime-terminal-dot green" />
                <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 8, fontWeight: 500 }}>
                  Terminal · 运行命令实时预览 ({currentLang.toUpperCase()})
                </span>
              </div>
              <button
                type="button"
                className="runtime-terminal-copy-btn"
                onClick={handleCopyCommand}
                title="复制完整运行命令到剪贴板"
              >
                {copied ? '✓ 已复制' : '📋 复制完整命令'}
              </button>
            </div>
            <div className="runtime-terminal-content">
              <span style={{ color: '#38bdf8', marginRight: 8, userSelect: 'none' }}>$</span>
              <span>{previewCommand}</span>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="runtime-modal-footer">
          <button type="button" className="runtime-reset-btn" onClick={handleReset}>
            重置当前参数
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

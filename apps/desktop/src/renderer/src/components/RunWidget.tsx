import { useEffect, useState, useRef, useCallback } from 'react';

interface Props {
  workspace: string | null;
  onRunCommand: (command: string) => void;
  onStopCommand?: () => void;
  isBottomExpanded: boolean;
  onExpandBottom: () => void;
}

interface ScriptOption {
  name: string;
  command: string;
  /** 来源描述，用于下拉分组展示 */
  source: 'npm' | 'makefile' | 'cargo' | 'python' | 'go' | 'generic';
}

/** 常见 npm 脚本优先级：作为默认选中 */
const NPM_PRIORITY = ['dev', 'start', 'serve', 'build', 'test'];

/** 尝试从文件内容中解析运行配置（多语言） */
async function detectScripts(workspace: string): Promise<ScriptOption[]> {
  // 先判断文件是否存在，再读取，避免对不存在文件触发 readFile 产生 ENOENT 噪音日志
  const tryRead = async (p: string): Promise<string | null> => {
    try {
      const exists = await window.ide.pathExists(p);
      if (!exists) return null;
      const content = await window.ide.readFile(p);
      return content || null;
    } catch {
      return null;
    }
  };

  // 1) package.json — npm scripts
  const pkg = await tryRead('package.json');
  if (pkg) {
    try {
      const parsed = JSON.parse(pkg);
      if (parsed && typeof parsed.scripts === 'object') {
        const opts: ScriptOption[] = Object.keys(parsed.scripts).map((key) => ({
          name: key,
          command: `npm run ${key}`,
          source: 'npm',
        }));
        if (opts.length > 0) return opts;
      }
    } catch {
      /* fallthrough */
    }
  }

  // 2) Makefile — make targets
  const makefile = await tryRead('Makefile');
  if (makefile) {
    const targets: ScriptOption[] = [];
    for (const line of makefile.split(/\r?\n/)) {
      const m = line.match(/^([a-zA-Z0-9_.-]+)\s*:\s*(.*)$/);
      // 过滤掉看似规则/变量定义的（以 . 开头或含 = 推断变量）
      if (m && !m[1].startsWith('.') && !/^[A-Z0-9_]+$/.test(m[1])) {
        targets.push({ name: m[1], command: `make ${m[1]}`, source: 'makefile' });
      }
    }
    if (targets.length > 0) return targets.slice(0, 10);
  }

  // 3) Cargo.toml — cargo 任务
  const cargo = await tryRead('Cargo.toml');
  if (cargo) {
    const targets: ScriptOption[] = [];
    const m = cargo.match(/^\[alias\]\s*([\s\S]*?)(?=^\[|\s*$)/m);
    if (m && m[1]) {
      for (const line of m[1].split(/\r?\n/)) {
        const kv = line.match(/^\s*([a-zA-Z0-9_.-]+)\s*=\s*"(.+)"\s*$/);
        if (kv) targets.push({ name: kv[1], command: `cargo ${kv[1]}`, source: 'cargo' });
      }
    }
    if (targets.length > 0) return targets;
    // 无 alias，给基础命令
    targets.push(
      { name: 'build', command: 'cargo build', source: 'cargo' },
      { name: 'run', command: 'cargo run', source: 'cargo' },
      { name: 'test', command: 'cargo test', source: 'cargo' },
    );
    return targets;
  }

  // 4) pyproject.toml — python 常用
  const pyproject = await tryRead('pyproject.toml');
  if (pyproject) {
    const targets: ScriptOption[] = [];
    const m = pyproject.match(/\[tool\.poetry\.scripts\]\s*([\s\S]*?)(?=^\[|\s*$)/m);
    if (m && m[1]) {
      for (const line of m[1].split(/\r?\n/)) {
        const kv = line.match(/^\s*([a-zA-Z0-9_.-]+)\s*=\s*"(.+)"\s*$/);
        if (kv) targets.push({ name: kv[1], command: kv[2], source: 'python' });
      }
    }
    if (targets.length > 0) return targets;
  }

  // 5) go.mod — Go 项目常用命令
  const gomod = await tryRead('go.mod');
  if (gomod) {
    return [
      { name: 'run', command: 'go run .', source: 'go' },
      { name: 'build', command: 'go build ./...', source: 'go' },
      { name: 'test', command: 'go test ./...', source: 'go' },
    ];
  }

  // 兜底：通用 npm 默认
  return [
    { name: 'dev', command: 'npm run dev', source: 'generic' },
    { name: 'build', command: 'npm run build', source: 'generic' },
    { name: 'test', command: 'npm test', source: 'generic' },
    { name: 'start', command: 'npm start', source: 'generic' },
  ];
}

export function RunWidget({
  workspace,
  onRunCommand,
  onStopCommand,
  isBottomExpanded,
  onExpandBottom,
}: Props) {
  const [scripts, setScripts] = useState<ScriptOption[]>([
    { name: 'dev', command: 'npm run dev', source: 'generic' },
    { name: 'build', command: 'npm run build', source: 'generic' },
    { name: 'test', command: 'npm test', source: 'generic' },
    { name: 'start', command: 'npm start', source: 'generic' },
  ]);
  const [selectedScript, setSelectedScript] = useState<string>('dev');
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [dropdownOpen, setDropdownOpen] = useState<boolean>(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // 尝试自动检测工程根目录的运行配置（npm / Makefile / Cargo / Python / Go）
  useEffect(() => {
    if (!workspace) return;
    let isMounted = true;
    (async () => {
      const loaded = await detectScripts(workspace);
      if (!isMounted) return;
      if (loaded.length > 0) {
        setScripts(loaded);
        // 优先选择常见开发命令
        const best = NPM_PRIORITY.find((p) => loaded.some((s) => s.name === p)) || loaded[0].name;
        setSelectedScript(best);
      }
    })();
    return () => {
      isMounted = false;
    };
  }, [workspace]);

  // 点击空白处收起下拉菜单
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    if (dropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [dropdownOpen]);

  const handleRun = useCallback(() => {
    const target = scripts.find((s) => s.name === selectedScript);
    const cmd = target ? target.command : `npm run ${selectedScript}`;
    if (!isBottomExpanded) {
      onExpandBottom();
    }
    setIsRunning(true);
    onRunCommand(cmd);
  }, [selectedScript, scripts, isBottomExpanded, onExpandBottom, onRunCommand]);

  const handleStop = useCallback(() => {
    setIsRunning(false);
    onStopCommand?.();
  }, [onStopCommand]);

  if (!workspace) return null;

  return (
    <div
      className="idea-run-widget"
      ref={dropdownRef}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        background: 'var(--bg-elevated, #25232d)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        height: 28,
        padding: '0 4px',
        gap: 2,
        position: 'relative',
        fontSize: 12,
        userSelect: 'none',
      }}
    >
      {/* 脚本选择下拉按钮 */}
      <button
        type="button"
        onClick={() => setDropdownOpen((v) => !v)}
        title="选择启动脚本配置 (Run Configuration)"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          background: 'none',
          border: 'none',
          color: 'var(--text)',
          cursor: 'pointer',
          padding: '0 6px',
          height: '100%',
          fontSize: 12,
          fontWeight: 500,
          borderRadius: 4,
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
      >
        {isRunning && (
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              backgroundColor: '#4ade80',
              boxShadow: '0 0 6px #4ade80',
            }}
          />
        )}
        <span
          style={{
            maxWidth: 110,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {selectedScript}
        </span>
        <span style={{ fontSize: 9, opacity: 0.6 }}>▾</span>
      </button>

      {/* 下拉浮层 */}
      {dropdownOpen && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            minWidth: 160,
            background: 'var(--bg-elevated, #25232d)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            boxShadow: '0 6px 16px rgba(0,0,0,0.3)',
            zIndex: 100,
            padding: 4,
          }}
        >
          <div
            style={{
              fontSize: 10,
              color: 'var(--muted)',
              padding: '4px 8px',
              borderBottom: '1px solid var(--border)',
              marginBottom: 4,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
            }}
          >
            运行配置 (Scripts)
          </div>
          {scripts.map((s) => (
            <div
              key={`${s.source}-${s.name}`}
              onClick={() => {
                setSelectedScript(s.name);
                setDropdownOpen(false);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '5px 8px',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 12,
                color: s.name === selectedScript ? 'var(--accent, #a78bfa)' : 'var(--text)',
                background: s.name === selectedScript ? 'var(--bg-hover)' : 'transparent',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
              onMouseLeave={(e) =>
                (e.currentTarget.style.background =
                  s.name === selectedScript ? 'var(--bg-hover)' : 'transparent')
              }
            >
              <span style={{ fontWeight: 600 }}>{s.name}</span>
              <span style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
                {s.command}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 分隔线 */}
      <div style={{ width: 1, height: 16, background: 'var(--border)', margin: '0 2px' }} />

      {/* 运行按钮 ▶ */}
      {!isRunning ? (
        <button
          type="button"
          onClick={handleRun}
          title={`一键运行 (Run: ${selectedScript})`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            height: 22,
            background: '#22c55e',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            padding: 0,
            transition: 'transform 0.1s, background 0.15s',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = '#16a34a')}
          onMouseLeave={(e) => (e.currentTarget.style.background = '#22c55e')}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
        </button>
      ) : (
        <button
          type="button"
          onClick={handleStop}
          title="停止当前运行 (Stop)"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            height: 22,
            background: '#ef4444',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            padding: 0,
            transition: 'transform 0.1s, background 0.15s',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = '#dc2626')}
          onMouseLeave={(e) => (e.currentTarget.style.background = '#ef4444')}
        >
          <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
        </button>
      )}
    </div>
  );
}

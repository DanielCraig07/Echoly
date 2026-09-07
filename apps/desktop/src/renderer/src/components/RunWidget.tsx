import { useEffect, useState, useRef, useCallback, useMemo } from 'react';

interface Props {
  workspace: string | null;
  activePath?: string | null;
  onRunCommand: (command: string) => void;
  onStopCommand?: () => void;
  isBottomExpanded: boolean;
  onExpandBottom: () => void;
}

export interface ScriptOption {
  id: string;
  name: string;
  command: string;
  source:
    | 'file'
    | 'npm'
    | 'pnpm'
    | 'yarn'
    | 'bun'
    | 'python'
    | 'java'
    | 'bash'
    | 'docker'
    | 'go'
    | 'cargo'
    | 'makefile'
    | 'custom'
    | 'generic';
  badge: string;
  badgeBg: string;
  badgeColor: string;
  group: 'current' | 'project' | 'custom';
  description?: string;
}

interface CustomConfig {
  id: string;
  name: string;
  command: string;
}

/** 尝试从文件系统多语言检测项目运行配置 */
async function detectProjectScripts(
  workspace: string,
  activePath?: string | null,
): Promise<ScriptOption[]> {
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

  const exists = async (p: string): Promise<boolean> => {
    try {
      return await window.ide.pathExists(p);
    } catch {
      return false;
    }
  };

  // 获取根目录文件列表
  let rootFiles: string[] = [];
  try {
    const nodes = await window.ide.listDir('.');
    if (Array.isArray(nodes)) {
      rootFiles = nodes.map((n) => n.name);
    }
  } catch {
    /* ignore */
  }

  const results: ScriptOption[] = [];

  // ── 1. 动态检测当前激活文件 (Active File) ──────────────────────────
  if (activePath) {
    let relPath = activePath;
    if (workspace && relPath.startsWith(workspace)) {
      relPath = relPath.slice(workspace.length).replace(/^[/\\]+/, '');
    }
    const fileName = relPath.split('/').pop() || relPath;
    const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';

    if (ext === 'py') {
      results.push({
        id: `active:${relPath}`,
        name: fileName,
        command: `python3 "${relPath}"`,
        source: 'python',
        badge: 'Py',
        badgeBg: 'rgba(56, 189, 248, 0.15)',
        badgeColor: '#38bdf8',
        group: 'current',
        description: '运行当前 Python 文件',
      });
    } else if (ext === 'sh' || ext === 'bash' || ext === 'zsh') {
      results.push({
        id: `active:${relPath}`,
        name: fileName,
        command: `bash "${relPath}"`,
        source: 'bash',
        badge: 'Bash',
        badgeBg: 'rgba(74, 222, 128, 0.15)',
        badgeColor: '#4ade80',
        group: 'current',
        description: '执行当前 Shell 脚本',
      });
    } else if (ext === 'ts') {
      results.push({
        id: `active:${relPath}`,
        name: fileName,
        command: `npx tsx "${relPath}"`,
        source: 'npm',
        badge: 'TS',
        badgeBg: 'rgba(59, 130, 246, 0.15)',
        badgeColor: '#60a5fa',
        group: 'current',
        description: 'tsx 运行当前 TypeScript 文件',
      });
    } else if (ext === 'js' || ext === 'mjs' || ext === 'cjs') {
      results.push({
        id: `active:${relPath}`,
        name: fileName,
        command: `node "${relPath}"`,
        source: 'npm',
        badge: 'Node',
        badgeBg: 'rgba(167, 139, 250, 0.15)',
        badgeColor: '#c084fc',
        group: 'current',
        description: 'Node 运行当前脚本',
      });
    } else if (ext === 'java') {
      results.push({
        id: `active:${relPath}`,
        name: fileName,
        command: `java "${relPath}"`,
        source: 'java',
        badge: 'Java',
        badgeBg: 'rgba(251, 146, 60, 0.15)',
        badgeColor: '#fb923c',
        group: 'current',
        description: '运行当前 Java 单文件',
      });
    } else if (ext === 'go') {
      results.push({
        id: `active:${relPath}`,
        name: fileName,
        command: `go run "${relPath}"`,
        source: 'go',
        badge: 'Go',
        badgeBg: 'rgba(45, 212, 191, 0.15)',
        badgeColor: '#2dd4bf',
        group: 'current',
        description: 'go run 运行当前文件',
      });
    }
  }

  // ── 2. Python 项目检测 ───────────────────────────────────────────
  const hasManagePy = rootFiles.includes('manage.py') || (await exists('manage.py'));
  const pyproject = await tryRead('pyproject.toml');
  const pipfile = await tryRead('Pipfile');
  const requirements = rootFiles.includes('requirements.txt') || (await exists('requirements.txt'));

  if (hasManagePy) {
    results.push(
      {
        id: 'py:manage:runserver',
        name: 'runserver',
        command: 'python3 manage.py runserver',
        source: 'python',
        badge: 'Django',
        badgeBg: 'rgba(16, 185, 129, 0.15)',
        badgeColor: '#34d399',
        group: 'project',
        description: '启动 Django 开发服务',
      },
      {
        id: 'py:manage:test',
        name: 'test',
        command: 'python3 manage.py test',
        source: 'python',
        badge: 'Django',
        badgeBg: 'rgba(16, 185, 129, 0.15)',
        badgeColor: '#34d399',
        group: 'project',
        description: '运行 Django 单元测试',
      },
    );
  }

  if (pyproject) {
    // Poetry scripts
    const m = pyproject.match(/\[tool\.poetry\.scripts\]\s*([\s\S]*?)(?=^\[|\s*$)/m);
    if (m && m[1]) {
      for (const line of m[1].split(/\r?\n/)) {
        const kv = line.match(/^\s*([a-zA-Z0-9_.-]+)\s*=\s*"(.+)"\s*$/);
        if (kv) {
          results.push({
            id: `py:poetry:${kv[1]}`,
            name: kv[1],
            command: `poetry run ${kv[1]}`,
            source: 'python',
            badge: 'Poetry',
            badgeBg: 'rgba(56, 189, 248, 0.15)',
            badgeColor: '#38bdf8',
            group: 'project',
          });
        }
      }
    }
    if (/fastapi|uvicorn/i.test(pyproject)) {
      results.push({
        id: 'py:uvicorn',
        name: 'uvicorn (FastAPI)',
        command: 'uvicorn main:app --reload',
        source: 'python',
        badge: 'FastAPI',
        badgeBg: 'rgba(20, 184, 166, 0.15)',
        badgeColor: '#2dd4bf',
        group: 'project',
        description: '启动 FastAPI 热重载服务',
      });
    }
    if (/pytest/i.test(pyproject)) {
      results.push({
        id: 'py:pytest',
        name: 'pytest',
        command: 'pytest',
        source: 'python',
        badge: 'Py',
        badgeBg: 'rgba(56, 189, 248, 0.15)',
        badgeColor: '#38bdf8',
        group: 'project',
        description: '运行 pytest 单元测试',
      });
    }
  }

  if (pipfile) {
    results.push({
      id: 'py:pipenv:run',
      name: 'pipenv run',
      command: 'pipenv run python main.py',
      source: 'python',
      badge: 'Pipenv',
      badgeBg: 'rgba(56, 189, 248, 0.15)',
      badgeColor: '#38bdf8',
      group: 'project',
    });
  }

  // 检测常见根目录 Python 入口
  const pyEntries = ['main.py', 'app.py', 'run.py', 'server.py'].filter(
    (f) => rootFiles.includes(f),
  );
  if (pyEntries.length === 0 && !hasManagePy && !pyproject && requirements) {
    // 有 requirements.txt 但暂未找到入口
    results.push(
      {
        id: 'py:main',
        name: 'python main.py',
        command: 'python3 main.py',
        source: 'python',
        badge: 'Py',
        badgeBg: 'rgba(56, 189, 248, 0.15)',
        badgeColor: '#38bdf8',
        group: 'project',
      },
      {
        id: 'py:pytest:req',
        name: 'pytest',
        command: 'pytest',
        source: 'python',
        badge: 'Py',
        badgeBg: 'rgba(56, 189, 248, 0.15)',
        badgeColor: '#38bdf8',
        group: 'project',
      },
    );
  } else {
    for (const f of pyEntries) {
      if (!results.some((r) => r.command.includes(f))) {
        results.push({
          id: `py:${f}`,
          name: f,
          command: `python3 ${f}`,
          source: 'python',
          badge: 'Py',
          badgeBg: 'rgba(56, 189, 248, 0.15)',
          badgeColor: '#38bdf8',
          group: 'project',
          description: `执行 Python 脚本 ${f}`,
        });
      }
    }
  }

  // ── 3. Java 项目检测 (Maven / Gradle) ───────────────────────────
  const pom = await tryRead('pom.xml');
  const hasGradlew = rootFiles.includes('gradlew') || (await exists('gradlew'));
  const hasBuildGradle =
    rootFiles.includes('build.gradle') ||
    rootFiles.includes('build.gradle.kts') ||
    (await exists('build.gradle')) ||
    (await exists('build.gradle.kts'));

  if (pom) {
    const isSpringBoot = /spring-boot-maven-plugin/i.test(pom) || /spring-boot/i.test(pom);
    if (isSpringBoot) {
      results.push({
        id: 'java:mvn:spring-boot',
        name: 'spring-boot:run',
        command: 'mvn spring-boot:run',
        source: 'java',
        badge: 'Spring',
        badgeBg: 'rgba(16, 185, 129, 0.15)',
        badgeColor: '#34d399',
        group: 'project',
        description: 'Spring Boot 本地启动',
      });
    }
    results.push(
      {
        id: 'java:mvn:test',
        name: 'mvn test',
        command: 'mvn test',
        source: 'java',
        badge: 'Maven',
        badgeBg: 'rgba(251, 146, 60, 0.15)',
        badgeColor: '#fb923c',
        group: 'project',
        description: '执行 Maven 单元测试',
      },
      {
        id: 'java:mvn:package',
        name: 'mvn package',
        command: 'mvn clean package -DskipTests',
        source: 'java',
        badge: 'Maven',
        badgeBg: 'rgba(251, 146, 60, 0.15)',
        badgeColor: '#fb923c',
        group: 'project',
        description: 'Maven 清理并打包',
      },
    );
  } else if (hasBuildGradle) {
    const gCmd = hasGradlew ? './gradlew' : 'gradle';
    results.push(
      {
        id: 'java:gradle:bootRun',
        name: 'bootRun',
        command: `${gCmd} bootRun`,
        source: 'java',
        badge: 'Gradle',
        badgeBg: 'rgba(2, 132, 199, 0.15)',
        badgeColor: '#38bdf8',
        group: 'project',
        description: 'Gradle 运行应用',
      },
      {
        id: 'java:gradle:test',
        name: 'test',
        command: `${gCmd} test`,
        source: 'java',
        badge: 'Gradle',
        badgeBg: 'rgba(2, 132, 199, 0.15)',
        badgeColor: '#38bdf8',
        group: 'project',
        description: 'Gradle 测试',
      },
      {
        id: 'java:gradle:build',
        name: 'build',
        command: `${gCmd} build`,
        source: 'java',
        badge: 'Gradle',
        badgeBg: 'rgba(2, 132, 199, 0.15)',
        badgeColor: '#38bdf8',
        group: 'project',
        description: 'Gradle 构建',
      },
    );
  }

  // ── 4. Bash / Shell 脚本检测 (*.sh) ──────────────────────────────
  const shFiles = rootFiles.filter((f) => f.endsWith('.sh'));
  // 如果根目录检测不到，检查常见脚本名
  if (shFiles.length === 0) {
    const commonSh = [
      'start.sh',
      'run.sh',
      'dev.sh',
      'build.sh',
      'deploy.sh',
      'test.sh',
      'setup.sh',
    ];
    for (const sh of commonSh) {
      if (await exists(sh)) shFiles.push(sh);
    }
  }
  for (const sh of shFiles) {
    results.push({
      id: `bash:${sh}`,
      name: sh,
      command: `bash ${sh}`,
      source: 'bash',
      badge: 'Bash',
      badgeBg: 'rgba(74, 222, 128, 0.15)',
      badgeColor: '#4ade80',
      group: 'project',
      description: `执行脚本 bash ${sh}`,
    });
  }

  // ── 5. TypeScript / Node.js (package.json / tsconfig.json) ────────
  const pkgStr = await tryRead('package.json');
  if (pkgStr) {
    try {
      const parsed = JSON.parse(pkgStr);
      // 判断包管理器
      let pm = 'npm';
      if (rootFiles.includes('pnpm-lock.yaml') || (await exists('pnpm-lock.yaml'))) pm = 'pnpm';
      else if (rootFiles.includes('yarn.lock') || (await exists('yarn.lock'))) pm = 'yarn';
      else if (
        rootFiles.includes('bun.lockb') ||
        rootFiles.includes('bun.lock') ||
        (await exists('bun.lockb'))
      )
        pm = 'bun';

      const isTs =
        Boolean(parsed.devDependencies?.typescript || parsed.dependencies?.typescript) ||
        rootFiles.includes('tsconfig.json') ||
        (await exists('tsconfig.json'));

      if (parsed.scripts && typeof parsed.scripts === 'object') {
        const keys = Object.keys(parsed.scripts);
        for (const key of keys) {
          const isTsKey = isTs && (key.includes('tsc') || key.includes('type') || key.includes('check'));
          results.push({
            id: `npm:${key}`,
            name: key,
            command: pm === 'npm' ? `npm run ${key}` : `${pm} run ${key}`,
            source: 'npm',
            badge: isTsKey ? 'TS' : pm,
            badgeBg: isTsKey ? 'rgba(59, 130, 246, 0.15)' : 'rgba(167, 139, 250, 0.15)',
            badgeColor: isTsKey ? '#60a5fa' : '#c084fc',
            group: 'project',
            description: parsed.scripts[key],
          });
        }
      }
    } catch {
      /* parse error */
    }
  }

  const hasTsConfig = rootFiles.includes('tsconfig.json') || (await exists('tsconfig.json'));
  if (hasTsConfig && !results.some((r) => r.command.includes('tsc --noEmit'))) {
    results.push({
      id: 'ts:check',
      name: 'tsc:check',
      command: 'npx tsc --noEmit',
      source: 'npm',
      badge: 'TS',
      badgeBg: 'rgba(59, 130, 246, 0.15)',
      badgeColor: '#60a5fa',
      group: 'project',
      description: 'TypeScript 类型静态检查',
    });
  }

  // ── 6. Docker 检测 ────────────────────────────────────────────────
  const hasDockerCompose =
    rootFiles.includes('docker-compose.yml') ||
    rootFiles.includes('docker-compose.yaml') ||
    rootFiles.includes('compose.yaml') ||
    (await exists('docker-compose.yml')) ||
    (await exists('compose.yaml'));
  const hasDockerfile = rootFiles.includes('Dockerfile') || (await exists('Dockerfile'));

  if (hasDockerCompose) {
    results.push(
      {
        id: 'docker:compose:up',
        name: 'compose up',
        command: 'docker compose up',
        source: 'docker',
        badge: 'Docker',
        badgeBg: 'rgba(56, 189, 248, 0.15)',
        badgeColor: '#38bdf8',
        group: 'project',
        description: '前台启动容器服务',
      },
      {
        id: 'docker:compose:up-d',
        name: 'compose up -d',
        command: 'docker compose up -d',
        source: 'docker',
        badge: 'Docker',
        badgeBg: 'rgba(56, 189, 248, 0.15)',
        badgeColor: '#38bdf8',
        group: 'project',
        description: '后台静默启动容器服务',
      },
      {
        id: 'docker:compose:down',
        name: 'compose down',
        command: 'docker compose down',
        source: 'docker',
        badge: 'Docker',
        badgeBg: 'rgba(56, 189, 248, 0.15)',
        badgeColor: '#38bdf8',
        group: 'project',
        description: '停止并移除容器',
      },
    );
  } else if (hasDockerfile) {
    results.push({
      id: 'docker:build',
      name: 'docker build',
      command: 'docker build -t app .',
      source: 'docker',
      badge: 'Docker',
      badgeBg: 'rgba(56, 189, 248, 0.15)',
      badgeColor: '#38bdf8',
      group: 'project',
      description: '构建 Docker 镜像',
    });
  }

  // ── 7. Go 项目检测 ───────────────────────────────────────────────
  const hasGoMod = rootFiles.includes('go.mod') || (await exists('go.mod'));
  if (hasGoMod) {
    results.push(
      {
        id: 'go:run',
        name: 'go run .',
        command: 'go run .',
        source: 'go',
        badge: 'Go',
        badgeBg: 'rgba(45, 212, 191, 0.15)',
        badgeColor: '#2dd4bf',
        group: 'project',
      },
      {
        id: 'go:test',
        name: 'go test',
        command: 'go test ./...',
        source: 'go',
        badge: 'Go',
        badgeBg: 'rgba(45, 212, 191, 0.15)',
        badgeColor: '#2dd4bf',
        group: 'project',
      },
      {
        id: 'go:build',
        name: 'go build',
        command: 'go build ./...',
        source: 'go',
        badge: 'Go',
        badgeBg: 'rgba(45, 212, 191, 0.15)',
        badgeColor: '#2dd4bf',
        group: 'project',
      },
    );
  }

  // ── 8. Rust 项目检测 ─────────────────────────────────────────────
  const cargo = await tryRead('Cargo.toml');
  if (cargo) {
    results.push(
      {
        id: 'cargo:run',
        name: 'cargo run',
        command: 'cargo run',
        source: 'cargo',
        badge: 'Rust',
        badgeBg: 'rgba(249, 115, 22, 0.15)',
        badgeColor: '#f97316',
        group: 'project',
      },
      {
        id: 'cargo:test',
        name: 'cargo test',
        command: 'cargo test',
        source: 'cargo',
        badge: 'Rust',
        badgeBg: 'rgba(249, 115, 22, 0.15)',
        badgeColor: '#f97316',
        group: 'project',
      },
      {
        id: 'cargo:build',
        name: 'cargo build',
        command: 'cargo build',
        source: 'cargo',
        badge: 'Rust',
        badgeBg: 'rgba(249, 115, 22, 0.15)',
        badgeColor: '#f97316',
        group: 'project',
      },
    );
  }

  // ── 9. Makefile 检测 ─────────────────────────────────────────────
  const makefile = await tryRead('Makefile');
  if (makefile) {
    for (const line of makefile.split(/\r?\n/)) {
      const m = line.match(/^([a-zA-Z0-9_.-]+)\s*:\s*(.*)$/);
      if (m && !m[1].startsWith('.') && !/^[A-Z0-9_]+$/.test(m[1])) {
        results.push({
          id: `make:${m[1]}`,
          name: m[1],
          command: `make ${m[1]}`,
          source: 'makefile',
          badge: 'Make',
          badgeBg: 'rgba(148, 163, 184, 0.15)',
          badgeColor: '#94a3b8',
          group: 'project',
        });
      }
    }
  }

  return results;
}

const STORAGE_CUSTOM_KEY = (ws: string) => `echoly_custom_run_configs_${ws}`;
const STORAGE_SELECTED_KEY = (ws: string) => `echoly_selected_run_config_${ws}`;

export function RunWidget({
  workspace,
  activePath,
  onRunCommand,
  onStopCommand,
  isBottomExpanded,
  onExpandBottom,
}: Props) {
  const [detectedScripts, setDetectedScripts] = useState<ScriptOption[]>([]);
  const [customConfigs, setCustomConfigs] = useState<CustomConfig[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [dropdownOpen, setDropdownOpen] = useState<boolean>(false);
  const [filterText, setFilterText] = useState<string>('');
  const [isAddingCustom, setIsAddingCustom] = useState<boolean>(false);
  const [newConfigName, setNewConfigName] = useState<string>('');
  const [newConfigCommand, setNewConfigCommand] = useState<string>('');

  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // 读取自定义配置
  useEffect(() => {
    if (!workspace) return;
    try {
      const raw = localStorage.getItem(STORAGE_CUSTOM_KEY(workspace));
      if (raw) {
        setCustomConfigs(JSON.parse(raw));
      } else {
        setCustomConfigs([]);
      }
    } catch {
      setCustomConfigs([]);
    }
  }, [workspace]);

  // 自动检测工程运行配置
  useEffect(() => {
    if (!workspace) return;
    let isMounted = true;
    (async () => {
      const loaded = await detectProjectScripts(workspace, activePath);
      if (!isMounted) return;
      setDetectedScripts(loaded);
    })();
    return () => {
      isMounted = false;
    };
  }, [workspace, activePath]);

  // 将 customConfigs 映射为 ScriptOption
  const customScriptOptions = useMemo<ScriptOption[]>(() => {
    return customConfigs.map((c) => ({
      id: `custom:${c.id}`,
      name: c.name,
      command: c.command,
      source: 'custom',
      badge: '自定义',
      badgeBg: 'rgba(244, 114, 182, 0.15)',
      badgeColor: '#f472b6',
      group: 'custom',
    }));
  }, [customConfigs]);

  // 汇总所有配置
  const allScripts = useMemo<ScriptOption[]>(() => {
    return [...detectedScripts, ...customScriptOptions];
  }, [detectedScripts, customScriptOptions]);

  // 初始化 / 记忆选中项
  useEffect(() => {
    if (!workspace || allScripts.length === 0) return;
    const savedId = localStorage.getItem(STORAGE_SELECTED_KEY(workspace));
    if (savedId && allScripts.some((s) => s.id === savedId)) {
      setSelectedId(savedId);
    } else {
      // 优先级推选：活跃文件 > dev > start > runserver > bootRun > run > 第一个
      const priorityNames = [
        'dev',
        'start',
        'runserver',
        'bootRun',
        'run',
        'compose up',
        'go run .',
        'cargo run',
      ];
      const found =
        allScripts.find((s) => s.group === 'current') ||
        allScripts.find((s) => priorityNames.includes(s.name)) ||
        allScripts[0];
      if (found) {
        setSelectedId(found.id);
      }
    }
  }, [workspace, allScripts]);

  // 点击外部收起
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
        setIsAddingCustom(false);
        setFilterText('');
      }
    };
    if (dropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [dropdownOpen]);

  // 打开下拉菜单自动聚焦搜索框
  useEffect(() => {
    if (dropdownOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 40);
    }
  }, [dropdownOpen]);

  const handleSelect = (s: ScriptOption) => {
    setSelectedId(s.id);
    if (workspace) {
      localStorage.setItem(STORAGE_SELECTED_KEY(workspace), s.id);
    }
    setDropdownOpen(false);
    setFilterText('');
  };

  const handleAddCustom = () => {
    if (!newConfigName.trim() || !newConfigCommand.trim() || !workspace) return;
    const newConf: CustomConfig = {
      id: Date.now().toString(36),
      name: newConfigName.trim(),
      command: newConfigCommand.trim(),
    };
    const nextList = [...customConfigs, newConf];
    setCustomConfigs(nextList);
    try {
      localStorage.setItem(STORAGE_CUSTOM_KEY(workspace), JSON.stringify(nextList));
    } catch {
      /* ignore */
    }
    setSelectedId(`custom:${newConf.id}`);
    localStorage.setItem(STORAGE_SELECTED_KEY(workspace), `custom:${newConf.id}`);
    setNewConfigName('');
    setNewConfigCommand('');
    setIsAddingCustom(false);
    setDropdownOpen(false);
  };

  const handleDeleteCustom = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!workspace) return;
    const realId = id.replace(/^custom:/, '');
    const nextList = customConfigs.filter((c) => c.id !== realId);
    setCustomConfigs(nextList);
    try {
      localStorage.setItem(STORAGE_CUSTOM_KEY(workspace), JSON.stringify(nextList));
    } catch {
      /* ignore */
    }
    if (selectedId === id) {
      const fallback = detectedScripts[0]?.id || '';
      setSelectedId(fallback);
      if (fallback) localStorage.setItem(STORAGE_SELECTED_KEY(workspace), fallback);
    }
  };

  const currentOption = allScripts.find((s) => s.id === selectedId) || allScripts[0] || null;

  const handleRun = useCallback(() => {
    if (!currentOption) return;
    if (!isBottomExpanded) {
      onExpandBottom();
    }
    setIsRunning(true);
    onRunCommand(currentOption.command);
  }, [currentOption, isBottomExpanded, onExpandBottom, onRunCommand]);

  const handleStop = useCallback(() => {
    setIsRunning(false);
    onStopCommand?.();
  }, [onStopCommand]);

  // 过滤选项
  const filtered = useMemo(() => {
    if (!filterText.trim()) return allScripts;
    const q = filterText.toLowerCase();
    return allScripts.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.command.toLowerCase().includes(q) ||
        s.badge.toLowerCase().includes(q),
    );
  }, [allScripts, filterText]);

  // 分组
  const currentGroup = filtered.filter((s) => s.group === 'current');
  const projectGroup = filtered.filter((s) => s.group === 'project');
  const customGroup = filtered.filter((s) => s.group === 'custom');

  if (!workspace) return null;

  return (
    <div
      className="idea-run-widget"
      ref={dropdownRef}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        background: 'var(--bg-elevated, #222226)',
        border: '1px solid rgba(255, 255, 255, 0.12)',
        borderRadius: 6,
        height: 28,
        padding: '0 3px',
        gap: 3,
        position: 'relative',
        fontSize: 12,
        userSelect: 'none',
      }}
    >
      {/* 脚本选择下拉按钮 */}
      <button
        type="button"
        onClick={() => setDropdownOpen((v) => !v)}
        title={
          currentOption
            ? `运行配置: ${currentOption.name} (${currentOption.command})`
            : '选择或配置运行命令'
        }
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
          maxWidth: 180,
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)')}
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
              flexShrink: 0,
            }}
          />
        )}
        {currentOption ? (
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            <span
              style={{
                fontSize: 10,
                padding: '1px 4px',
                borderRadius: 3,
                background: currentOption.badgeBg,
                color: currentOption.badgeColor,
                fontWeight: 600,
                flexShrink: 0,
              }}
            >
              {currentOption.badge}
            </span>
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {currentOption.name}
            </span>
          </div>
        ) : (
          <span style={{ color: 'var(--muted)' }}>无运行配置</span>
        )}
        <span style={{ fontSize: 9, opacity: 0.6, marginLeft: 2, flexShrink: 0 }}>▾</span>
      </button>

      {/* 下拉浮层 */}
      {dropdownOpen && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 5px)',
            right: 0,
            width: 320,
            maxHeight: 380,
            display: 'flex',
            flexDirection: 'column',
            background: 'rgba(28, 28, 32, 0.98)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            border: '1px solid rgba(255, 255, 255, 0.14)',
            borderRadius: 8,
            boxShadow: '0 12px 32px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(0,0,0,0.2)',
            zIndex: 1000,
            overflow: 'hidden',
          }}
        >
          {/* 顶部搜索框 */}
          <div
            style={{
              padding: '6px 8px',
              borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
              background: 'rgba(255, 255, 255, 0.02)',
            }}
          >
            <input
              ref={searchInputRef}
              type="text"
              placeholder="搜索或过滤运行配置..."
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              style={{
                width: '100%',
                background: 'rgba(0, 0, 0, 0.25)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                borderRadius: 5,
                padding: '4px 8px',
                fontSize: 11.5,
                color: '#ffffff',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>

          {/* 滚动列表 */}
          <div style={{ overflowY: 'auto', flex: 1, padding: 4 }}>
            {/* 当前文件 */}
            {currentGroup.length > 0 && (
              <div style={{ marginBottom: 6 }}>
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: 'var(--muted)',
                    padding: '4px 8px',
                    letterSpacing: '0.04em',
                  }}
                >
                  当前文件 (Active File)
                </div>
                {currentGroup.map((s) => (
                  <ScriptItem
                    key={s.id}
                    item={s}
                    isSelected={s.id === selectedId}
                    onSelect={() => handleSelect(s)}
                  />
                ))}
              </div>
            )}

            {/* 项目配置 */}
            {projectGroup.length > 0 && (
              <div style={{ marginBottom: 6 }}>
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: 'var(--muted)',
                    padding: '4px 8px',
                    letterSpacing: '0.04em',
                  }}
                >
                  项目运行配置 (Detected)
                </div>
                {projectGroup.map((s) => (
                  <ScriptItem
                    key={s.id}
                    item={s}
                    isSelected={s.id === selectedId}
                    onSelect={() => handleSelect(s)}
                  />
                ))}
              </div>
            )}

            {/* 自定义配置 */}
            {customGroup.length > 0 && (
              <div style={{ marginBottom: 6 }}>
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: 'var(--muted)',
                    padding: '4px 8px',
                    letterSpacing: '0.04em',
                  }}
                >
                  自定义配置 (Custom)
                </div>
                {customGroup.map((s) => (
                  <ScriptItem
                    key={s.id}
                    item={s}
                    isSelected={s.id === selectedId}
                    onSelect={() => handleSelect(s)}
                    onDelete={(e) => handleDeleteCustom(e, s.id)}
                  />
                ))}
              </div>
            )}

            {allScripts.length === 0 && (
              <div
                style={{
                  padding: '16px 12px',
                  textAlign: 'center',
                  fontSize: 11.5,
                  color: 'var(--muted)',
                }}
              >
                未检测到项目预置运行配置
                <br />
                <span style={{ fontSize: 10.5, opacity: 0.7 }}>
                  可打开脚本文件直接运行，或在下方添加自定义命令
                </span>
              </div>
            )}

            {filtered.length === 0 && allScripts.length > 0 && (
              <div
                style={{
                  padding: '14px 12px',
                  textAlign: 'center',
                  fontSize: 11.5,
                  color: 'var(--muted)',
                }}
              >
                无匹配运行配置
              </div>
            )}
          </div>

          {/* 底部：添加自定义命令 */}
          <div
            style={{
              borderTop: '1px solid rgba(255, 255, 255, 0.08)',
              padding: 6,
              background: 'rgba(255, 255, 255, 0.02)',
            }}
          >
            {!isAddingCustom ? (
              <button
                type="button"
                onClick={() => setIsAddingCustom(true)}
                style={{
                  width: '100%',
                  background: 'none',
                  border: '1px dashed rgba(255, 255, 255, 0.15)',
                  borderRadius: 5,
                  padding: '5px 8px',
                  fontSize: 11.5,
                  color: 'var(--muted)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 4,
                  transition: 'color 0.15s, border-color 0.15s, background 0.15s',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = '#ffffff';
                  e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.35)';
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.04)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = 'var(--muted)';
                  e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.15)';
                  e.currentTarget.style.background = 'none';
                }}
              >
                <span>+</span> 添加自定义运行命令
              </button>
            ) : (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  padding: '4px 2px',
                }}
              >
                <input
                  type="text"
                  placeholder="配置名称 (如: dev:prod, pytest, run.sh)"
                  value={newConfigName}
                  onChange={(e) => setNewConfigName(e.target.value)}
                  style={{
                    background: 'rgba(0, 0, 0, 0.3)',
                    border: '1px solid rgba(255, 255, 255, 0.14)',
                    borderRadius: 4,
                    padding: '4px 8px',
                    fontSize: 11,
                    color: '#fff',
                    outline: 'none',
                  }}
                />
                <input
                  type="text"
                  placeholder="执行命令 (如: python3 test.py --env=dev)"
                  value={newConfigCommand}
                  onChange={(e) => setNewConfigCommand(e.target.value)}
                  style={{
                    background: 'rgba(0, 0, 0, 0.3)',
                    border: '1px solid rgba(255, 255, 255, 0.14)',
                    borderRadius: 4,
                    padding: '4px 8px',
                    fontSize: 11,
                    color: '#fff',
                    outline: 'none',
                    fontFamily: 'var(--font-mono, monospace)',
                  }}
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                  <button
                    type="button"
                    onClick={() => {
                      setIsAddingCustom(false);
                      setNewConfigName('');
                      setNewConfigCommand('');
                    }}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--muted)',
                      fontSize: 11,
                      padding: '3px 8px',
                      cursor: 'pointer',
                    }}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={handleAddCustom}
                    disabled={!newConfigName.trim() || !newConfigCommand.trim()}
                    style={{
                      background: 'var(--accent, #4c8dff)',
                      border: 'none',
                      borderRadius: 4,
                      color: '#ffffff',
                      fontSize: 11,
                      fontWeight: 500,
                      padding: '3px 10px',
                      cursor:
                        !newConfigName.trim() || !newConfigCommand.trim()
                          ? 'not-allowed'
                          : 'pointer',
                      opacity: !newConfigName.trim() || !newConfigCommand.trim() ? 0.5 : 1,
                    }}
                  >
                    保存配置
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 分隔线 */}
      <div
        style={{
          width: 1,
          height: 14,
          background: 'rgba(255, 255, 255, 0.12)',
          margin: '0 1px',
        }}
      />

      {/* 运行按钮 ▶ */}
      {!isRunning ? (
        <button
          type="button"
          onClick={handleRun}
          disabled={!currentOption}
          title={
            currentOption
              ? `一键运行: ${currentOption.command}`
              : '请先选择或添加一个运行配置'
          }
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            height: 22,
            background: currentOption ? '#22c55e' : 'rgba(255, 255, 255, 0.1)',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            cursor: currentOption ? 'pointer' : 'not-allowed',
            padding: 0,
            opacity: currentOption ? 1 : 0.4,
            transition: 'transform 0.1s, background 0.15s',
          }}
          onMouseEnter={(e) => {
            if (currentOption) e.currentTarget.style.background = '#16a34a';
          }}
          onMouseLeave={(e) => {
            if (currentOption) e.currentTarget.style.background = '#22c55e';
          }}
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

function ScriptItem({
  item,
  isSelected,
  onSelect,
  onDelete,
}: {
  item: ScriptOption;
  isSelected: boolean;
  onSelect: () => void;
  onDelete?: (e: React.MouseEvent) => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '5px 8px',
        borderRadius: 5,
        cursor: 'pointer',
        fontSize: 12,
        color: isSelected ? '#ffffff' : 'var(--text)',
        background: isSelected
          ? 'rgba(76, 141, 255, 0.18)'
          : hovered
            ? 'rgba(255, 255, 255, 0.06)'
            : 'transparent',
        marginBottom: 2,
        transition: 'background 0.1s',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          minWidth: 0,
          flex: 1,
        }}
      >
        <span
          style={{
            fontSize: 9.5,
            padding: '1px 4px',
            borderRadius: 3,
            background: item.badgeBg,
            color: item.badgeColor,
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          {item.badge}
        </span>
        <span
          style={{
            fontWeight: isSelected ? 600 : 500,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 12,
          }}
        >
          {item.name}
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexShrink: 0,
          marginLeft: 8,
        }}
      >
        <span
          style={{
            fontSize: 10.5,
            color: isSelected ? 'rgba(255, 255, 255, 0.8)' : 'var(--muted)',
            fontFamily: 'var(--font-mono, monospace)',
            maxWidth: 120,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={item.command}
        >
          {item.command}
        </span>

        {onDelete && hovered && (
          <button
            type="button"
            onClick={onDelete}
            title="删除自定义配置"
            style={{
              background: 'none',
              border: 'none',
              color: '#ef4444',
              cursor: 'pointer',
              fontSize: 13,
              lineHeight: 1,
              padding: '0 2px',
            }}
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}

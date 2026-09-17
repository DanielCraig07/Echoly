export interface ScriptOptionLike {
  id: string;
  name: string;
  command: string;
  source: string;
  badge: string;
  description?: string;
}

export interface ResolvedDebugConfig {
  type: 'dap' | 'terminal';
  language: 'cpp' | 'c' | 'cmake' | 'java' | 'python' | 'node' | 'go' | 'rust' | string;
  command: string;
  terminalType: string;
  terminalTitle: string;
  port?: number;
  toastMessage: string;
}

/**
 * 针对当前选中的运行配置，智能注入多语言调试参数并生成调试指令
 */
export function resolveDebugConfig(
  option: ScriptOptionLike,
  activePath?: string | null,
): ResolvedDebugConfig {
  const { id, name, command, source, badge } = option;

  // 1. C / C++ / CMake (使用 DAP 模式，由 lldb-dap 后台原生调试)
  if (source === 'cpp' || source === 'c' || source === 'cmake') {
    return {
      type: 'dap',
      language: source,
      command,
      terminalType: 'cpp',
      terminalTitle: 'C/C++ Debug Build',
      toastMessage: '正在编译并启动 C/C++ 调试器 (lldb-dap)...',
    };
  }

  // 2. Java / Maven 调试 (基于 JDWP Socket 协议，默认监听 5005 端口)
  if (
    source === 'java' ||
    badge === 'Java' ||
    badge === 'Maven' ||
    id.startsWith('active:') && id.endsWith('.java') ||
    /\b(mvn|mvnw|java)\b/.test(command)
  ) {
    const jdwpArg = '-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=5005';
    let debugCmd = command;

    if (debugCmd.includes('exec:java')) {
      if (debugCmd.includes('-Dexec.vmArgs="')) {
        debugCmd = debugCmd.replace('-Dexec.vmArgs="', `-Dexec.vmArgs="${jdwpArg} `);
      } else {
        debugCmd += ` -Dexec.vmArgs="${jdwpArg}"`;
      }
    } else if (debugCmd.includes('spring-boot:run')) {
      debugCmd += ` -Dspring-boot.run.jvmArguments="${jdwpArg}"`;
    } else if (debugCmd.includes('test -Dtest=')) {
      debugCmd += ` -Dmaven.surefire.debug="${jdwpArg}"`;
    } else if (/\bjava\s+/.test(debugCmd)) {
      debugCmd = debugCmd.replace(/\bjava\s+/, `java ${jdwpArg} `);
    } else if (/\bmvn\b|\bmvnw\b/.test(debugCmd)) {
      debugCmd += ` -Dmaven.surefire.debug -Dexec.vmArgs="${jdwpArg}"`;
    } else {
      debugCmd += ` -Dexec.vmArgs="${jdwpArg}"`;
    }

    const termType = badge === 'Maven' ? 'mvn' : 'java';
    return {
      type: 'terminal',
      language: 'java',
      command: debugCmd,
      terminalType: termType,
      terminalTitle: 'Java (Debug: 5005)',
      port: 5005,
      toastMessage: 'Java 调试会话已启动，已挂载 JDWP 监听端口 5005',
    };
  }

  // 3. Python 调试 (基于 debugpy，默认监听 127.0.0.1:5678)
  if (
    source === 'python' ||
    badge === 'Py' ||
    badge === 'Python' ||
    badge === 'Django' ||
    badge === 'FastAPI' ||
    badge === 'Poetry' ||
    (id.startsWith('active:') && id.endsWith('.py')) ||
    /\bpython(3)?\b/.test(command)
  ) {
    let debugCmd = command;
    const debugpyFlag = '-m debugpy --listen 127.0.0.1:5678';

    if (debugCmd.includes('python3 ')) {
      debugCmd = debugCmd.replace('python3 ', `python3 ${debugpyFlag} `);
    } else if (debugCmd.includes('python ')) {
      debugCmd = debugCmd.replace('python ', `python ${debugpyFlag} `);
    } else if (debugCmd.startsWith('poetry run ')) {
      debugCmd = debugCmd.replace('poetry run ', `poetry run python ${debugpyFlag} `);
    } else {
      debugCmd = `python3 ${debugpyFlag} ${debugCmd}`;
    }

    return {
      type: 'terminal',
      language: 'python',
      command: debugCmd,
      terminalType: 'python',
      terminalTitle: 'Python (Debug: 5678)',
      port: 5678,
      toastMessage: 'Python 调试会话已启动，debugpy 监听端口 5678',
    };
  }

  // 4. Node.js / TypeScript 调试 (基于 V8 Inspector，默认监听 9229 端口)
  if (
    source === 'npm' ||
    source === 'pnpm' ||
    source === 'yarn' ||
    source === 'bun' ||
    badge === 'Node' ||
    badge === 'TS' ||
    (id.startsWith('active:') && /\.(ts|js|mjs|cjs)$/.test(id))
  ) {
    let debugCmd = command;
    if (debugCmd.includes('npx tsx ') && !debugCmd.includes('--inspect')) {
      debugCmd = debugCmd.replace('npx tsx ', 'npx tsx --inspect=9229 ');
    } else if (debugCmd.includes('node ') && !debugCmd.includes('--inspect')) {
      debugCmd = debugCmd.replace('node ', 'node --inspect=9229 ');
    } else if (!debugCmd.includes('--inspect') && !debugCmd.includes('NODE_OPTIONS')) {
      debugCmd = `NODE_OPTIONS="--inspect=9229" ${debugCmd}`;
    }

    return {
      type: 'terminal',
      language: 'node',
      command: debugCmd,
      terminalType: 'node',
      terminalTitle: 'Node (Debug: 9229)',
      port: 9229,
      toastMessage: 'Node.js 调试会话已启动，V8 Inspector 监听端口 9229',
    };
  }

  // 5. Go 调试 (基于 Delve dlv，默认监听 2345 端口)
  if (
    source === 'go' ||
    badge === 'Go' ||
    (id.startsWith('active:') && id.endsWith('.go')) ||
    /\bgo run\b/.test(command)
  ) {
    let debugCmd = command;
    if (debugCmd.startsWith('go run ')) {
      debugCmd = debugCmd.replace('go run ', 'dlv debug --headless --listen=127.0.0.1:2345 --api-version=2 ');
    } else {
      debugCmd = `dlv exec --headless --listen=127.0.0.1:2345 --api-version=2 -- ${debugCmd}`;
    }

    return {
      type: 'terminal',
      language: 'go',
      command: debugCmd,
      terminalType: 'go',
      terminalTitle: 'Go (Debug: 2345)',
      port: 2345,
      toastMessage: 'Go 调试会话已启动，Delve 监听端口 2345',
    };
  }

  // 6. 通用兜底执行
  return {
    type: 'terminal',
    language: source || 'shell',
    command,
    terminalType: source || 'shell',
    terminalTitle: `${name} (Debug)`,
    toastMessage: `已启动 ${name} 调试执行`,
  };
}

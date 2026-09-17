import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { CppToolchainStatus, CppToolItem, MultiLangToolchainStatus } from '@deepseek-ide/shared';

function findBinaryInPath(name: string): string | null {
  const isWin = process.platform === 'win32';
  const binaryName = isWin && !name.endsWith('.exe') ? `${name}.exe` : name;

  const envPath = process.env.PATH || '';
  const dirs = envPath.split(path.delimiter);
  for (const dir of dirs) {
    const full = path.join(dir, binaryName);
    try {
      if (fs.existsSync(full)) {
        return full;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

function checkTool(
  displayName: string,
  preferredCommand: string,
  knownLocations: string[],
  versionFlag = '--version',
  installGuide = '',
): CppToolItem {
  let binPath: string | null = null;

  for (const loc of knownLocations) {
    if (fs.existsSync(loc)) {
      binPath = loc;
      break;
    }
  }

  if (!binPath) {
    binPath = findBinaryInPath(preferredCommand);
  }

  if (!binPath) {
    return {
      name: displayName,
      command: preferredCommand,
      installed: false,
      installGuide,
    };
  }

  let version: string | undefined;
  try {
    const out = execSync(`"${binPath}" ${versionFlag}`, {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    });
    const firstLine = out.split('\n')[0]?.trim();
    version = firstLine || '已安装';
  } catch {
    version = '已安装';
  }

  return {
    name: displayName,
    command: preferredCommand,
    path: binPath,
    version,
    installed: true,
  };
}

export function detectCppToolchain(): CppToolchainStatus {
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';

  // 1. C/C++ 编译器 (clang++ / g++)
  const compiler = checkTool(
    isMac ? 'Apple Clang++' : (isWin ? 'MinGW G++' : 'GCC G++'),
    isMac ? 'clang++' : 'g++',
    [
      '/usr/bin/clang++',
      '/opt/homebrew/bin/clang++',
      '/usr/local/bin/clang++',
      '/usr/bin/g++',
      '/usr/local/bin/g++',
    ],
    '--version',
    isMac ? 'xcode-select --install' : (isWin ? 'winget install LLVM.LLVM 或 w64devkit' : 'sudo apt install build-essential'),
  );

  // 2. Clangd 语言服务
  const clangd = checkTool(
    'Clangd 语言服务器',
    'clangd',
    [
      '/usr/bin/clangd',
      '/opt/homebrew/bin/clangd',
      '/usr/local/bin/clangd',
      '/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clangd',
    ],
    '--version',
    isMac ? 'brew install llvm' : 'sudo apt install clangd',
  );

  // 3. 调试引擎 (lldb-dap / gdb)
  const debuggerTool = checkTool(
    isMac ? 'LLDB-DAP (Xcode / LLVM)' : 'GDB / LLDB',
    'lldb-dap',
    [
      '/Applications/Xcode.app/Contents/Developer/usr/bin/lldb-dap',
      '/Applications/Xcode.app/Contents/Developer/usr/bin/lldb-vscode',
      '/opt/homebrew/bin/lldb-dap',
      '/usr/local/bin/lldb-dap',
      '/usr/bin/lldb-dap',
      '/usr/bin/gdb',
    ],
    '--version',
    isMac ? 'xcode-select --install 或 brew install llvm' : 'sudo apt install gdb lldb',
  );

  // 4. CMake 构建系统
  const cmake = checkTool(
    'CMake 构建系统',
    'cmake',
    [
      '/usr/local/bin/cmake',
      '/opt/homebrew/bin/cmake',
      '/usr/bin/cmake',
      '/Applications/CMake.app/Contents/bin/cmake',
    ],
    '--version',
    isMac ? 'brew install cmake' : 'sudo apt install cmake',
  );

  return {
    compiler,
    clangd,
    debugger: debuggerTool,
    cmake,
  };
}

export function detectMultiLangToolchain(): MultiLangToolchainStatus {
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';
  const homeDir = process.env.HOME || '';
  const goPath = process.env.GOPATH || path.join(homeDir, 'go');

  const cpp = detectCppToolchain();

  // Python 工具链检测
  const pyInterpreter = checkTool(
    'Python 解释器',
    isWin ? 'python' : 'python3',
    [
      '/usr/bin/python3',
      '/usr/local/bin/python3',
      '/opt/homebrew/bin/python3',
      '/usr/bin/python',
    ],
    '--version',
    isMac ? 'brew install python' : (isWin ? 'winget install Python.Python.3' : 'sudo apt install python3 python3-pip'),
  );

  const pyDebugpy = checkTool(
    'Debugpy 调试引擎',
    'debugpy',
    [
      '/opt/homebrew/bin/debugpy',
      '/usr/local/bin/debugpy',
      path.join(homeDir, 'Library/Python/3.9/bin/debugpy'),
      path.join(homeDir, 'Library/Python/3.10/bin/debugpy'),
      path.join(homeDir, 'Library/Python/3.11/bin/debugpy'),
      path.join(homeDir, 'Library/Python/3.12/bin/debugpy'),
    ],
    '--version',
    'python3 -m pip install debugpy',
  );

  const pyPip = checkTool(
    'Pip 包管理器',
    'pip3',
    [
      '/usr/bin/pip3',
      '/usr/local/bin/pip3',
      '/opt/homebrew/bin/pip3',
      '/usr/bin/pip',
    ],
    '--version',
    'python3 -m ensurepip --upgrade',
  );

  // Go 工具链检测
  const goCompiler = checkTool(
    'Go 编译器',
    'go',
    [
      '/usr/local/go/bin/go',
      '/opt/homebrew/bin/go',
      '/usr/local/bin/go',
      '/usr/bin/go',
    ],
    'version',
    isMac ? 'brew install go' : 'sudo apt install golang-go',
  );

  const goDelve = checkTool(
    'Delve 调试器 (dlv dap)',
    'dlv',
    [
      '/opt/homebrew/bin/dlv',
      '/usr/local/bin/dlv',
      path.join(goPath, 'bin', isWin ? 'dlv.exe' : 'dlv'),
    ],
    'version',
    'go install github.com/go-delve/delve/cmd/dlv@latest',
  );

  const goGopls = checkTool(
    'Gopls 语言服务器',
    'gopls',
    [
      '/opt/homebrew/bin/gopls',
      '/usr/local/bin/gopls',
      path.join(goPath, 'bin', isWin ? 'gopls.exe' : 'gopls'),
    ],
    'version',
    'go install golang.org/x/tools/gopls@latest',
  );

  // Node.js 工具链检测
  const nodeRuntime = checkTool(
    'Node.js 运行时',
    'node',
    [
      '/usr/local/bin/node',
      '/opt/homebrew/bin/node',
      '/usr/bin/node',
    ],
    '--version',
    isMac ? 'brew install node' : 'sudo apt install nodejs npm',
  );

  const nodeNpm = checkTool(
    'NPM 包管理器',
    'npm',
    [
      '/usr/local/bin/npm',
      '/opt/homebrew/bin/npm',
      '/usr/bin/npm',
    ],
    '--version',
    'npm install -g npm',
  );

  const nodeTs = checkTool(
    'TypeScript 编译器 (tsc)',
    'tsc',
    [
      '/usr/local/bin/tsc',
      '/opt/homebrew/bin/tsc',
      path.join(homeDir, '.npm-global/bin/tsc'),
    ],
    '--version',
    'npm install -g typescript tsx',
  );

  return {
    cpp,
    python: {
      interpreter: pyInterpreter,
      debugpy: pyDebugpy,
      pip: pyPip,
    },
    go: {
      go: goCompiler,
      delve: goDelve,
      gopls: goGopls,
    },
    node: {
      node: nodeRuntime,
      npm: nodeNpm,
      typescript: nodeTs,
    },
  };
}

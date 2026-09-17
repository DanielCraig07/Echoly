import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { CppToolchainStatus, CppToolItem } from '@deepseek-ide/shared';

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

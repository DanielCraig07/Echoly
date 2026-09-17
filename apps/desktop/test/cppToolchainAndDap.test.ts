import { describe, it, expect } from 'vitest';
import { detectCppToolchain } from '../src/main/cppToolchainService';
import { DapService } from '../src/main/dapService';

describe('C/C++ Toolchain Detection', () => {
  it('detects C/C++ compiler, clangd, debugger, and cmake status', () => {
    const status = detectCppToolchain();
    expect(status).toBeDefined();
    expect(status.compiler).toBeDefined();
    expect(status.clangd).toBeDefined();
    expect(status.debugger).toBeDefined();
    expect(status.cmake).toBeDefined();

    if (process.platform === 'darwin') {
      // On macOS, Apple Clang++ and clangd are standard
      expect(status.compiler.name).toContain('Clang');
      expect(status.compiler.installed).toBe(true);
    }
  });
});

describe('DAP Debugger Service', () => {
  it('initializes and manages breakpoints correctly', async () => {
    const mockWorkspace = {
      getRoot: () => '/mock/workspace',
    } as any;

    const dap = new DapService(() => mockWorkspace);

    // Test offline breakpoint caching
    const bps = await dap.setBreakpoints('/mock/workspace/src/main.cpp', [10, 25, 42]);
    expect(bps).toHaveLength(3);
    expect(bps[0].line).toBe(10);
    expect(bps[1].line).toBe(25);
    expect(bps[2].line).toBe(42);

    // Test conditional breakpoint caching and metadata
    const condBps = await dap.setBreakpoints('/mock/workspace/src/main.cpp', [
      { line: 15, condition: 'x > 10' },
      { line: 20 },
    ]);
    expect(condBps).toHaveLength(2);
    expect(condBps[0].line).toBe(15);
    expect(condBps[0].condition).toBe('x > 10');
    expect(condBps[1].line).toBe(20);
    expect(condBps[1].condition).toBeUndefined();

    // Verify non-existent binary error handling
    const result = await dap.startSession({
      program: '/mock/workspace/non_existent_binary',
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();

    dap.dispose();
  });
});

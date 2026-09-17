import { describe, it, expect, beforeEach } from 'vitest';
import { detectProjectScripts } from '../src/renderer/src/components/RunWidget';

describe('C/C++ and CMake Project Detection', () => {
  beforeEach(() => {
    // Mock window.ide
    (global as any).window = {
      ide: {
        pathExists: async (p: string) => false,
        readFile: async (p: string) => null,
        listDir: async (p: string) => [],
      },
    };
  });

  it('detects single C++ file with main() function and produces clang++/g++ build & run command', async () => {
    (global as any).window.ide = {
      pathExists: async (p: string) => true,
      readFile: async (p: string) => {
        if (p === 'main.cpp') {
          return `#include <iostream>\nint main(int argc, char** argv) {\n  std::cout << "Hello C++" << std::endl;\n  return 0;\n}`;
        }
        return null;
      },
      listDir: async () => [],
    };

    const scripts = await detectProjectScripts('/workspace', '/workspace/main.cpp');
    const cppScript = scripts.find((s) => s.id === 'active:main.cpp');

    expect(cppScript).toBeDefined();
    expect(cppScript?.name).toBe('main');
    expect(cppScript?.badge).toBe('C++');
    expect(cppScript?.command).toContain('-std=c++17');
    expect(cppScript?.command).toContain('.echoly/bin/main');
  });

  it('detects C++ test file with GTest and configures test runner with -lgtest', async () => {
    (global as any).window.ide = {
      pathExists: async (p: string) => true,
      readFile: async (p: string) => {
        if (p === 'test/calc_test.cpp') {
          return `#include <gtest/gtest.h>\nTEST(CalcTest, Add) { EXPECT_EQ(1 + 1, 2); }`;
        }
        return null;
      },
      listDir: async () => [],
    };

    const scripts = await detectProjectScripts('/workspace', '/workspace/test/calc_test.cpp');
    const testScript = scripts.find((s) => s.id === 'active:test:test/calc_test.cpp');

    expect(testScript).toBeDefined();
    expect(testScript?.name).toBe('测试: calc_test');
    expect(testScript?.badge).toBe('C++ Test');
    expect(testScript?.command).toContain('-lgtest');
    expect(testScript?.command).toContain('.echoly/bin/calc_test_test');
  });

  it('detects C++ header file and provides syntax checking command', async () => {
    (global as any).window.ide = {
      pathExists: async (p: string) => true,
      readFile: async (p: string) => `class Solution { public: int add(int a, int b); };`,
      listDir: async () => [],
    };

    const scripts = await detectProjectScripts('/workspace', '/workspace/solution.hpp');
    const headerScript = scripts.find((s) => s.id === 'active:check:solution.hpp');

    expect(headerScript).toBeDefined();
    expect(headerScript?.name).toBe('语法检查: solution.hpp');
    expect(headerScript?.command).toContain('-fsyntax-only');
  });

  it('detects CMake project with multiple targets and ctest', async () => {
    const cmakeContent = `
cmake_minimum_required(VERSION 3.15)
project(MyEngine)
add_executable(server src/main.cpp)
add_executable(cli src/cli.cpp)
enable_testing()
add_test(NAME unit_test COMMAND server --test)
`;

    (global as any).window.ide = {
      pathExists: async (p: string) => p === 'CMakeLists.txt',
      readFile: async (p: string) => (p === 'CMakeLists.txt' ? cmakeContent : null),
      listDir: async () => [{ name: 'CMakeLists.txt', isDirectory: false }],
    };

    const scripts = await detectProjectScripts('/workspace');
    
    // Check CMake: Build All
    const buildAll = scripts.find((s) => s.id === 'cmake:build');
    expect(buildAll).toBeDefined();
    expect(buildAll?.command).toContain('cmake -B build');
    expect(buildAll?.command).toContain('cmake --build build');

    // Check targets: server & cli
    const serverRun = scripts.find((s) => s.id === 'cmake:run:server');
    expect(serverRun).toBeDefined();
    expect(serverRun?.command).toContain('--target server');

    const cliRun = scripts.find((s) => s.id === 'cmake:run:cli');
    expect(cliRun).toBeDefined();
    expect(cliRun?.command).toContain('--target cli');

    // Check CTest
    const ctest = scripts.find((s) => s.id === 'cmake:test');
    expect(ctest).toBeDefined();
    expect(ctest?.command).toContain('ctest --test-dir build');

    // Check Clean
    const clean = scripts.find((s) => s.id === 'cmake:clean');
    expect(clean).toBeDefined();
    expect(clean?.command).toContain('--target clean');
  });
});

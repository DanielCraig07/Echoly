import { defineConfig } from 'vitest/config';

/**
 * 覆盖率默认只统计**手写的源码**。
 *
 * 不加 include 的话 v8 会把所有被 import 过的文件都算进去，包括 `node_modules` 里
 * 被 workspace 依赖拉进来的第三方实现 —— 那些数字既不由我们决定、也无法改进，
 * 混进来只会把整体百分比稀释成一条没有信息量的曲线。
 * 测试文件自己也要排除：统计「测试被覆盖了多少」没有任何意义。
 */
const COVERAGE_INCLUDE = [
  'packages/*/src/**/*.ts',
  'apps/desktop/src/main/**/*.ts',
  'apps/desktop/src/renderer/src/**/*.{ts,tsx}',
];

const COVERAGE_EXCLUDE = [
  '**/*.d.ts',
  '**/*.test.ts',
  'apps/desktop/src/renderer/src/monaco.ts',
  // 纯资源/样式入口：没有可执行分支
  'apps/desktop/src/renderer/src/runtimeConfig.css',
];

/** 每个 project 都重复一份：vitest 的 coverage 配置是按 project 生效的。 */
const project = (name: string, root: string) => ({
  test: {
    name,
    root,
    include: ['test/**/*.test.ts'],
    environment: 'node' as const,
  },
});

export default defineConfig({
  test: {
    testTimeout: 25000,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      include: COVERAGE_INCLUDE,
      exclude: COVERAGE_EXCLUDE,
      // 不设阈值门禁：现有覆盖率还没到「一降就说明出问题」的水平，
      // 设一个够不着的数字只会让 CI 长期红着，然后被人习惯性忽略。
    },
    projects: [
      project('tools', 'packages/tools'),
      project('llm', 'packages/llm'),
      project('agent', 'packages/agent'),
      project('skills', 'packages/skills'),
      project('desktop', 'apps/desktop'),
    ],
  },
});

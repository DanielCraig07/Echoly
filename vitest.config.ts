import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'tools',
          root: 'packages/tools',
          include: ['test/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'llm',
          root: 'packages/llm',
          include: ['test/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'agent',
          root: 'packages/agent',
          include: ['test/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'desktop',
          root: 'apps/desktop',
          include: ['test/**/*.test.ts'],
          environment: 'node',
        },
      },
    ],
  },
});

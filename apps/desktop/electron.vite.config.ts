import { resolve } from 'path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

const workspacePackages = [
  '@deepseek-ide/shared',
  '@deepseek-ide/llm',
  '@deepseek-ide/agent',
  '@deepseek-ide/tools',
  '@deepseek-ide/skills',
  '@deepseek-ide/vscode-shim',
];

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: workspacePackages,
      }),
    ],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
        },
        output: {
          format: 'cjs',
        },
      },
    },
  },
  preload: {
    plugins: [
      externalizeDepsPlugin({
        exclude: workspacePackages,
      }),
    ],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
        },
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
      },
    },
    plugins: [react()],
  },
});

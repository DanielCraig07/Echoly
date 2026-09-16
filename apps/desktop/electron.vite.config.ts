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

// 禁止 Vite dev 阶段在系统浏览器中打开 5173 等开发端口
process.env.BROWSER = 'none';

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: workspacePackages,
      }),
    ],
    build: {
      lib: {
        entry: resolve('src/main/index.ts'),
      },
      watch: {
        include: [
          resolve('src/main/**'),
          resolve('../../packages/**/src/**'),
        ],
      },
      rollupOptions: {
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
      lib: {
        entry: resolve('src/preload/index.ts'),
      },
    },
  },
  renderer: {
    server: {
      port: Number(process.env.VITE_PORT) || 5200,
      open: false,
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
      },
    },
    plugins: [react()],
  },
});

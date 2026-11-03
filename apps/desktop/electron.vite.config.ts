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
        include: [resolve('src/main/**'), resolve('../../packages/**/src/**')],
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
      // 两个入口：
      // - `index` 是主窗口的 preload（暴露 window.ide / window.extensions）；
      // - `webview-guest` 是扩展界面那个 `<webview>` 的 preload，只搭一条消息桥。
      //   它必须单独成包：主窗口那份会把整套 API 也挂到访客页面上，既没必要，
      //   也让「这个页面是扩展的、不是我们自己的」这件事变得看不清。
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          'webview-guest': resolve('src/preload/webviewGuest.ts'),
        },
        // 文件名必须可预测：主进程按 `../preload/webview-guest.js` 找它
        output: { format: 'cjs', entryFileNames: '[name].js' },
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

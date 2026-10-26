import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/out/**',
      '**/dist/**',
      '**/release/**',
      '**/coverage/**',
      '**/*.d.ts',
      'apps/desktop/out/**',
      'apps/desktop/release/**',
    ],
  },
  {
    files: ['**/*.{ts,tsx,js,mjs,jsx}'],
    languageOptions: {
      globals: {
        // Node / Electron main-process globals
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        // Browser globals (renderer)
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        localStorage: 'readonly',
        fetch: 'readonly',
      },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  /**
   * 只开 `rules-of-hooks` 一条，而且是 error。
   *
   * 这类错误**只在运行时炸**，且炸得很晚：`SettingsModal` 里一个 `useEffect` 被写在
   * `if (!open || !settings) return null` 之后，直到用户点开设置页才抛
   * 「Rendered more hooks than during the previous render」，整个设置页变成错误页 ——
   * typecheck 全绿、测试全绿、构建也能过，CI 一声不吭。加这一条是让它变成编译期问题。
   *
   * 不开 `react-hooks/exhaustive-deps`：它会给现有的依赖数组灌一屏 warning
   * （有意省略依赖、依赖稳定的 ref 之类），把上面这条真正的 error 淹掉。
   */
  {
    files: ['**/*.{tsx,jsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
    },
  },
  prettier,
  {
    rules: {
      // Electron 主进程 / externalized deps 使用 require 是预期行为
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-namespace': 'off',
      // 以下为既有代码中的刻意写法（ANSI 转义剥离、VSCode shim 的 arguments/this 别名、
      // 重新抛错不携带 cause），保留以便新代码不被历史包袱阻塞
      'no-control-regex': 'off',
      'prefer-rest-params': 'off',
      'preserve-caught-error': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-useless-assignment': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', args: 'none' },
      ],
    },
  },
);

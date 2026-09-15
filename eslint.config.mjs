import js from '@eslint/js';
import tseslint from 'typescript-eslint';
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

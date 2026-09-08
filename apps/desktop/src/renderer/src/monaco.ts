import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') return new jsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};

// 内网环境无法访问 jsDelivr CDN，改为打包本地 monaco-editor
loader.config({ monaco });

// ── TypeScript / JavaScript 语言服务（tsserver）配置 ─────────────────────────
// Monaco 内置的 ts.worker 与 VS Code 的 tsserver 同源。配置好 compilerOptions 与
// 诊断选项后，配合 @monaco-editor/react 的 `path` prop（为每个打开文件创建
// `file:///abs/path` 的 model + eager sync），即可对工作区已打开文件做工程级分析：
// 跨文件跳转定义、重命名、实时类型错误。
const tsDefaults = monaco.languages.typescript.typescriptDefaults;
const jsDefaults = monaco.languages.typescript.javascriptDefaults;

const sharedCompilerOptions: monaco.languages.typescript.CompilerOptions = {
  target: monaco.languages.typescript.ScriptTarget.ES2020,
  module: monaco.languages.typescript.ModuleKind.ESNext,
  moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
  jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
  allowJs: true,
  checkJs: false,
  esModuleInterop: true,
  allowSyntheticDefaultImports: true,
  resolveJsonModule: true,
  strict: true,
  baseUrl: '.',
  typeRoots: ['node_modules/@types'],
  skipLibCheck: true,
  noEmit: true,
};

tsDefaults.setCompilerOptions(sharedCompilerOptions);
jsDefaults.setCompilerOptions(sharedCompilerOptions);

tsDefaults.setDiagnosticsOptions({
  noSemanticValidation: false,
  noSyntaxValidation: false,
  noSuggestionDiagnostics: false,
  diagnosticCodesToIgnore: [7027, 6133, 6196, 6198, 6199, 6205, 6504],
});

jsDefaults.setDiagnosticsOptions({
  noSemanticValidation: false,
  noSyntaxValidation: false,
  noSuggestionDiagnostics: true,
});

// 让 ts.worker 尽早同步所有已打开 model，实现跨文件分析（跳转/诊断不只限当前文件）
tsDefaults.setEagerModelSync(true);
jsDefaults.setEagerModelSync(true);

// 自定义与工作区完全一致的编辑区与 Peek Widget 深色主题
monaco.editor.defineTheme('custom-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#1E1E1E',
    'editorGutter.background': '#1E1E1E',
    // 行号颜色：与暗色主题和谐，避免过亮/过暗
    'editorLineNumber.foreground': '#4a5568',          // 普通行号 —— 深灰蓝，低调不抢眼
    'editorLineNumber.activeForeground': '#a0aec0',    // 当前行行号 —— 亮灰，清晰可见
    // 覆盖 Monaco 默认刺眼的深蓝 (#001f4d) Peek View，与深色 IDE 保持一致
    'peekView.border': '#007acc',
    'peekViewEditor.background': '#181818',
    'peekViewEditorGutter.background': '#181818',
    'peekViewEditor.matchHighlightBackground': '#ea5c004d',
    'peekViewResult.background': '#202020',
    'peekViewResult.fileForeground': '#ffffff',
    'peekViewResult.lineForeground': '#9ca3af',
    'peekViewResult.matchHighlightBackground': '#ea5c004d',
    'peekViewResult.selectionBackground': '#094771',
    'peekViewResult.selectionForeground': '#ffffff',
    'peekViewTitle.background': '#1e1e1e',
    'peekViewTitleDescription.foreground': '#9ca3af',
    'peekViewTitleLabel.foreground': '#ffffff',
  },
});


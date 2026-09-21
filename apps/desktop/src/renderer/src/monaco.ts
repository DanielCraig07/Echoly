import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import 'monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css';
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

// 全局初始化 Monaco 编辑器右键菜单中文汉化及快捷键对齐
import { setupMonacoChineseLocalization } from './monacoLocalization';
setupMonacoChineseLocalization();

// ── AI 智能快速修复提供程序 (Fix with AI - ⌥.) ──────────────────────
monaco.languages.registerCodeActionProvider('*', {
  provideCodeActions(model, _range, context) {
    const markers = context.markers || [];
    if (!markers.length) return { actions: [], dispose: () => {} };
    const err = markers.find(
      (m) => m.severity === monaco.MarkerSeverity.Error || m.severity === monaco.MarkerSeverity.Warning,
    );
    if (!err) return { actions: [], dispose: () => {} };

    return {
      actions: [
        {
          title: `✦ Fix with AI: 智能修复此代码错误 (⌥.)`,
          kind: 'quickfix',
          isPreferred: true,
          diagnostics: [err],
          command: {
            id: 'echoly.action.fixWithAi',
            title: 'Fix with AI: 智能修复',
            arguments: [err],
          },
        },
      ],
      dispose: () => {},
    };
  },
});

monaco.editor.registerCommand('echoly.action.fixWithAi', (_accessor, marker) => {
  window.dispatchEvent(new CustomEvent('echoly:fixWithAi', { detail: marker }));
});

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

// ── 现代化全语言语法高亮规则集 (VS Code Modern Dark+ / One Dark Pro 工业级规范) ──
// 涵盖关键词（定义/控制流）、类/接口/枚举/结构体、函数/方法/调用、变量/参数/对象属性、
// 注解/装饰器、字符串/正则表达式、数字/布尔字面量、JSX/HTML 标签与属性等全套语义分类。
export const modernDarkRules: monaco.editor.ITokenThemeRule[] = [
  // ── 注释 (斜体自然森绿，清晰且柔和不喧宾夺主) ──
  { token: 'comment', foreground: '6A9955', fontStyle: 'italic' },
  { token: 'comment.doc', foreground: '608B4E', fontStyle: 'italic' },
  { token: 'comment.block', foreground: '6A9955', fontStyle: 'italic' },

  // ── 关键字 (定义/存储关键字天蓝，控制流品红/粉紫) ──
  { token: 'keyword', foreground: '569CD6' },
  { token: 'keyword.control', foreground: 'C586C0' },
  { token: 'keyword.flow', foreground: 'C586C0' },
  { token: 'keyword.return', foreground: 'C586C0' },
  { token: 'keyword.if', foreground: 'C586C0' },
  { token: 'keyword.else', foreground: 'C586C0' },
  { token: 'keyword.for', foreground: 'C586C0' },
  { token: 'keyword.while', foreground: 'C586C0' },
  { token: 'keyword.try', foreground: 'C586C0' },
  { token: 'keyword.catch', foreground: 'C586C0' },
  { token: 'keyword.finally', foreground: 'C586C0' },
  { token: 'keyword.class', foreground: '569CD6' },
  { token: 'keyword.def', foreground: '569CD6' },
  { token: 'keyword.function', foreground: '569CD6' },
  { token: 'keyword.import', foreground: 'C586C0' },
  { token: 'keyword.from', foreground: 'C586C0' },
  { token: 'keyword.export', foreground: 'C586C0' },
  { token: 'keyword.async', foreground: 'C586C0' },
  { token: 'keyword.await', foreground: 'C586C0' },
  { token: 'keyword.operator', foreground: '569CD6' },
  { token: 'storage', foreground: '569CD6' },
  { token: 'storage.type', foreground: '569CD6' },
  { token: 'storage.modifier', foreground: '569CD6' },

  // ── 类、接口、枚举、结构体与类型定义 (现代薄荷碧玉青 #4EC9B0，告别单调纯白) ──
  { token: 'type', foreground: '4EC9B0' },
  { token: 'type.identifier', foreground: '4EC9B0' },
  { token: 'class', foreground: '4EC9B0' },
  { token: 'class.identifier', foreground: '4EC9B0' },
  { token: 'interface', foreground: '4EC9B0' },
  { token: 'interface.identifier', foreground: '4EC9B0' },
  { token: 'struct', foreground: '4EC9B0' },
  { token: 'enum', foreground: '4EC9B0' },
  { token: 'enumMember', foreground: '4FC1FF' },
  { token: 'typeParameter', foreground: '4EC9B0' },

  // ── 函数与方法 (经典明快暖金黄 #DCDCAA) ──
  { token: 'function', foreground: 'DCDCAA' },
  { token: 'function.call', foreground: 'DCDCAA' },
  { token: 'function.declaration', foreground: 'DCDCAA' },
  { token: 'method', foreground: 'DCDCAA' },
  { token: 'method.call', foreground: 'DCDCAA' },
  { token: 'support.function', foreground: 'DCDCAA' },

  // ── 变量、参数、对象属性与内置语言变量 ──
  { token: 'variable', foreground: '9CDCFE' },
  { token: 'variable.parameter', foreground: '9CDCFE' },
  { token: 'parameter', foreground: '9CDCFE' },
  { token: 'variable.predefined', foreground: '569CD6' },
  { token: 'variable.language', foreground: '569CD6' },
  { token: 'property', foreground: '9CDCFE' },
  { token: 'variable.property', foreground: '9CDCFE' },
  { token: 'member', foreground: '9CDCFE' },

  // ── 注解与装饰器 (@decorator, @Override, @Component) ──
  { token: 'annotation', foreground: 'DCDCAA' },
  { token: 'decorator', foreground: 'DCDCAA' },
  { token: 'tag', foreground: '569CD6' },

  // ── 字符串、转义与正则表达式 ──
  { token: 'string', foreground: 'CE9178' },
  { token: 'string.escape', foreground: 'D7BA7D' },
  { token: 'string.regex', foreground: 'D16969' },
  { token: 'character', foreground: 'CE9178' },

  // ── 数字、布尔、常量与字面量 ──
  { token: 'number', foreground: 'B5CEA8' },
  { token: 'number.hex', foreground: 'B5CEA8' },
  { token: 'number.float', foreground: 'B5CEA8' },
  { token: 'number.octal', foreground: 'B5CEA8' },
  { token: 'number.binary', foreground: 'B5CEA8' },
  { token: 'constant', foreground: '569CD6' },
  { token: 'constant.numeric', foreground: 'B5CEA8' },
  { token: 'constant.language', foreground: '569CD6' },
  { token: 'boolean', foreground: '569CD6' },

  // ── JSX / TSX / HTML 标签与属性 ──
  { token: 'tag.id', foreground: '4EC9B0' },
  { token: 'tag.class', foreground: '4EC9B0' },
  { token: 'attribute.name', foreground: '9CDCFE' },
  { token: 'attribute.value', foreground: 'CE9178' },

  // ── 运算符与定界符 ──
  { token: 'operator', foreground: 'D4D4D4' },
  { token: 'delimiter', foreground: 'D4D4D4' },
  { token: 'delimiter.bracket', foreground: 'D4D4D4' },
  { token: 'delimiter.curly', foreground: 'D4D4D4' },
  { token: 'delimiter.parenthesis', foreground: 'D4D4D4' },
];

export const modernLightRules: monaco.editor.ITokenThemeRule[] = [
  { token: 'comment', foreground: '008000', fontStyle: 'italic' },
  { token: 'comment.doc', foreground: '008000', fontStyle: 'italic' },
  { token: 'keyword', foreground: '0000FF' },
  { token: 'keyword.control', foreground: 'AF00DB' },
  { token: 'keyword.flow', foreground: 'AF00DB' },
  { token: 'type', foreground: '267F99' },
  { token: 'type.identifier', foreground: '267F99' },
  { token: 'class', foreground: '267F99' },
  { token: 'interface', foreground: '267F99' },
  { token: 'function', foreground: '795E26' },
  { token: 'function.call', foreground: '795E26' },
  { token: 'method', foreground: '795E26' },
  { token: 'variable', foreground: '001080' },
  { token: 'variable.parameter', foreground: '001080' },
  { token: 'parameter', foreground: '001080' },
  { token: 'annotation', foreground: '811F3F' },
  { token: 'decorator', foreground: '811F3F' },
  { token: 'string', foreground: 'A31515' },
  { token: 'string.escape', foreground: 'EE0000' },
  { token: 'number', foreground: '098658' },
  { token: 'constant', foreground: '0000FF' },
  { token: 'boolean', foreground: '0000FF' },
  { token: 'tag.id', foreground: '800000' },
  { token: 'attribute.name', foreground: 'E50000' },
  { token: 'attribute.value', foreground: '0000FF' },
];

// 自定义与工作区完全一致的编辑区与 Peek Widget 深色主题
monaco.editor.defineTheme('custom-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: modernDarkRules,
  colors: {
    'editor.background': '#181818',
    'editorGutter.background': '#181818',
    // 行号颜色：与暗色主题和谐，标准 VS Code 灰色
    'editorLineNumber.foreground': '#6e7681',
    'editorLineNumber.activeForeground': '#ffffff',
    // 当前行高亮与选区（严格与截图 #252525 对齐）
    'editor.lineHighlightBackground': '#252525',
    'editor.lineHighlightBorder': '#00000000',
    'editor.selectionBackground': '#264f78',
    'editor.inactiveSelectionBackground': '#3a3d41',
    'editorCursor.foreground': '#aeafad',
    'editorWhitespace.foreground': '#e3e4e229',
    'editorIndentGuide.background': '#404040',
    'editorIndentGuide.activeBackground': '#707070',
    // 覆盖 Monaco 默认深蓝 Peek View，与 IDE 主题完美融合
    'peekView.border': '#007acc',
    'peekViewEditor.background': '#181818',
    'peekViewEditorGutter.background': '#181818',
    'peekViewEditor.matchHighlightBackground': '#007acc40',
    'peekViewResult.background': '#141414',
    'peekViewResult.fileForeground': '#cccccc',
    'peekViewResult.lineForeground': '#858585',
    'peekViewResult.matchHighlightBackground': '#007acc40',
    'peekViewResult.selectionBackground': '#04395e',
    'peekViewResult.selectionForeground': '#ffffff',
    'peekViewTitle.background': '#141414',
    'peekViewTitleDescription.foreground': '#858585',
    'peekViewTitleLabel.foreground': '#cccccc',
    // 彻底清除光标处自动出现的单词高亮/选中框与相似文本高亮
    'editor.wordHighlightBackground': '#00000000',
    'editor.wordHighlightStrongBackground': '#00000000',
    'editor.wordHighlightBorder': '#00000000',
    'editor.wordHighlightStrongBorder': '#00000000',
    'editor.selectionHighlightBackground': '#00000000',
    'editor.selectionHighlightBorder': '#00000000',
    // 缩略图不透明背景与滚动条差异概览色条
    'minimap.background': '#181818',
    'editorOverviewRuler.border': '#00000000',
    'editorOverviewRuler.addedForeground': '#487e02',
    'editorOverviewRuler.deletedForeground': '#f14c4c',
    'editorOverviewRuler.modifiedForeground': '#1b81a8',
    // 菜单（右键上下文菜单、下拉菜单）
    'menu.background': '#141414',
    'menu.foreground': '#cccccc',
    'menu.selectionBackground': '#04395e',
    'menu.selectionForeground': '#ffffff',
    'menu.selectionBorder': '#00000000',
    'menu.separatorBackground': '#ffffff14',
    'menu.border': '#00000000',
    // 快捷命令面板 (Command Palette - Quick Input)
    'quickInput.background': '#141414',
    'quickInput.foreground': '#cccccc',
    'quickInputList.focusBackground': '#04395e',
    'quickInputList.focusForeground': '#ffffff',
    'quickInputTitle.background': '#141414',
  },
});

// 自定义与工作区完全一致的浅色主题
monaco.editor.defineTheme('custom-light', {
  base: 'vs',
  inherit: true,
  rules: modernLightRules,
  colors: {
    'editor.background': '#FFFFFF',
    'editorGutter.background': '#FFFFFF',
    'editorLineNumber.foreground': '#94a3b8',
    'editorLineNumber.activeForeground': '#334155',
    'peekView.border': '#4c8dff',
    'peekViewEditor.background': '#f8fafc',
    'peekViewEditorGutter.background': '#f8fafc',
    'peekViewEditor.matchHighlightBackground': '#4c8dff25',
    'peekViewResult.background': '#f1f5f9',
    'peekViewResult.fileForeground': '#0f172a',
    'peekViewResult.lineForeground': '#64748b',
    'peekViewResult.matchHighlightBackground': '#4c8dff25',
    'peekViewResult.selectionBackground': '#e0e7ff',
    'peekViewResult.selectionForeground': '#1e1b4b',
    'peekViewTitle.background': '#f8fafc',
    'peekViewTitleDescription.foreground': '#64748b',
    'peekViewTitleLabel.foreground': '#0f172a',
    'minimap.background': '#FFFFFF',
    'editorOverviewRuler.border': '#00000000',
    'editorOverviewRuler.addedForeground': '#1a7f37',
    'editorOverviewRuler.deletedForeground': '#cf222e',
    'editorOverviewRuler.modifiedForeground': '#bf8700',
    // 菜单（右键上下文菜单、下拉菜单）浅色配置
    'menu.background': '#ffffff',
    'menu.foreground': '#1f2937',
    'menu.selectionBackground': '#007acc',
    'menu.selectionForeground': '#ffffff',
    'menu.selectionBorder': '#00000000',
    'menu.separatorBackground': '#00000015',
    'menu.border': '#00000015',
    // 快捷命令面板 (Command Palette - Quick Input)
    'quickInput.background': '#ffffff',
    'quickInput.foreground': '#1f2937',
    'quickInputList.focusBackground': '#007acc',
    'quickInputList.focusForeground': '#ffffff',
    'quickInputTitle.background': '#f8fafc',
  },
});

// ── 增强 Python 语言词法分词器 ──
// 原生 Monaco Python Monarch 将函数名、类名、类型统一标记为 identifier (导致全是单调白色)。
// 这里扩展 Python 词法分词规则，精确识别 def 函数定义、class 类定义、PascalCase 类型标识、
// 函数调用、装饰器及 self/cls，使 Python 代码即时获得细腻炫彩的现代 IDE 级视觉表现。
const enhancedPythonLanguage: monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.python',
  keywords: [
    'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await',
    'break', 'case', 'class', 'continue', 'def', 'del', 'elif', 'else',
    'except', 'exec', 'finally', 'for', 'from', 'global', 'if', 'import',
    'in', 'is', 'lambda', 'match', 'nonlocal', 'not', 'or', 'pass', 'print',
    'raise', 'return', 'try', 'type', 'while', 'with', 'yield',
  ],
  builtins: [
    'int', 'float', 'str', 'bool', 'list', 'dict', 'set', 'tuple', 'bytes',
    'object', 'len', 'range', 'enumerate', 'zip', 'map', 'filter',
    'isinstance', 'issubclass', 'iter', 'next', 'reversed', 'sorted', 'sum',
    'min', 'max', 'abs', 'all', 'any', 'open', 'id', 'repr',
    'super', 'property', 'classmethod', 'staticmethod',
  ],
  brackets: [
    { open: '{', close: '}', token: 'delimiter.curly' },
    { open: '[', close: ']', token: 'delimiter.bracket' },
    { open: '(', close: ')', token: 'delimiter.parenthesis' },
  ],
  tokenizer: {
    root: [
      { include: '@whitespace' },
      { include: '@numbers' },
      { include: '@strings' },
      [/[,:;]/, 'delimiter'],
      [/[{}[\]()]/, '@brackets'],

      // 装饰器: @decorator, @staticmethod 等
      [/@[a-zA-Z_]\w*/, 'annotation'],

      // 函数声明: def func_name(...)
      [/(def\s+)([a-zA-Z_]\w*)/, ['keyword.def', 'function']],

      // 类声明: class ClassName(...)
      [/(class\s+)([a-zA-Z_]\w*)/, ['keyword.class', 'type.identifier']],

      // self 与 cls 内置语言标识符
      [/\b(self|cls)\b/, 'variable.predefined'],

      // 函数/方法调用: func_name(...)
      [/[a-zA-Z_]\w*(?=\s*\()/, {
        cases: {
          '@keywords': 'keyword',
          '@builtins': 'support.function',
          '@default': 'function.call',
        },
      }],

      // 大驼峰 PascalCase 类名/类型 (如 ModelTargetBinding, StreamProcessingRepository)
      [/\b[A-Z][a-zA-Z0-9_]*\b/, {
        cases: {
          '@keywords': 'keyword',
          '@default': 'type',
        },
      }],

      // 其它标识符与关键字
      [/[a-zA-Z_]\w*/, {
        cases: {
          '@keywords': 'keyword',
          '@builtins': 'type',
          '@default': 'identifier',
        },
      }],

      [/[+\-*/%=<>!&|^~]/, 'operator'],
    ],
    whitespace: [
      [/\s+/, 'white'],
      [/(^#.*$)/, 'comment'],
      [/'''/, 'string', '@endDocString'],
      [/"""/, 'string', '@endDblDocString'],
    ],
    endDocString: [
      [/[^']+/, 'string'],
      [/\\'/, 'string'],
      [/'''/, 'string', '@popall'],
      [/'/, 'string'],
    ],
    endDblDocString: [
      [/[^"]+/, 'string'],
      [/\\"/, 'string'],
      [/"""/, 'string', '@popall'],
      [/"/, 'string'],
    ],
    numbers: [
      [/-?0x([abcdef]|[ABCDEF]|\d)+[lL]?/, 'number.hex'],
      [/-?(\d*\.)?\d+([eE][-+]?\d+)?[jJ]?[lL]?/, 'number'],
    ],
    strings: [
      [/'$/, 'string.escape', '@popall'],
      [/f'{1,3}/, 'string.escape', '@fStringBody'],
      [/'/, 'string.escape', '@stringBody'],
      [/"$/, 'string.escape', '@popall'],
      [/f"{1,3}/, 'string.escape', '@fDblStringBody'],
      [/"/, 'string.escape', '@dblStringBody'],
    ],
    fStringBody: [
      [/[^\\'{}]+$/, 'string', '@popall'],
      [/\{/, { token: 'delimiter.curly', next: '@fInterpolation' }],
      [/[^\\'{}]+/, 'string'],
      [/\\./, 'string.escape'],
      [/'/, 'string.escape', '@popall'],
    ],
    fDblStringBody: [
      [/[^\\"{}]+$/, 'string', '@popall'],
      [/\{/, { token: 'delimiter.curly', next: '@fInterpolation' }],
      [/[^\\"{}]+/, 'string'],
      [/\\./, 'string.escape'],
      [/"/, 'string.escape', '@popall'],
    ],
    fInterpolation: [
      [/\}/, { token: 'delimiter.curly', next: '@pop' }],
      { include: 'root' },
    ],
    stringBody: [
      [/[^\\']+$/, 'string', '@popall'],
      [/[^\\']+/, 'string'],
      [/\\./, 'string.escape'],
      [/'/, 'string.escape', '@popall'],
    ],
    dblStringBody: [
      [/[^\\"]+$/, 'string', '@popall'],
      [/[^\\"]+/, 'string'],
      [/\\./, 'string.escape'],
      [/"/, 'string.escape', '@popall'],
    ],
  },
};

// ── 增强 Java 语言词法分词器 ──
const enhancedJavaLanguage: monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.java',
  keywords: [
    'abstract', 'continue', 'for', 'new', 'switch', 'assert', 'default',
    'goto', 'package', 'synchronized', 'boolean', 'do', 'if', 'private',
    'this', 'break', 'double', 'implements', 'protected', 'throw', 'byte',
    'else', 'import', 'public', 'throws', 'case', 'enum', 'instanceof',
    'return', 'transient', 'catch', 'extends', 'int', 'short', 'try',
    'char', 'final', 'interface', 'static', 'void', 'class', 'finally',
    'long', 'strictfp', 'volatile', 'const', 'float', 'native', 'super',
    'while', 'true', 'false', 'yield', 'record', 'sealed', 'non-sealed', 'permits',
  ],
  brackets: [
    { open: '{', close: '}', token: 'delimiter.curly' },
    { open: '[', close: ']', token: 'delimiter.bracket' },
    { open: '(', close: ')', token: 'delimiter.parenthesis' },
  ],
  tokenizer: {
    root: [
      { include: '@whitespace' },
      { include: '@numbers' },
      { include: '@strings' },
      [/[,;.]/, 'delimiter'],
      [/[{}[\]()]/, '@brackets'],

      // 注解: @Override, @Autowired, @Component
      [/@\s*[a-zA-Z_$][\w$]*/, 'annotation'],

      // 类/接口声明
      [/((?:class|interface|enum|record)\s+)([a-zA-Z_$][\w$]*)/, ['keyword', 'type.identifier']],

      // 函数/方法调用
      [/[a-zA-Z_$][\w$]*(?=\s*\()/, {
        cases: {
          '@keywords': 'keyword',
          '@default': 'function.call',
        },
      }],

      // PascalCase 类名/类型
      [/\b[A-Z][\w$]*\b/, {
        cases: {
          '@keywords': 'keyword',
          '@default': 'type',
        },
      }],

      // 标识符与关键字
      [/[a-zA-Z_$][\w$]*/, {
        cases: {
          '@keywords': 'keyword',
          '@default': 'identifier',
        },
      }],

      [/[=><!~?:&|+\-*^%/]+/, 'operator'],
    ],
    whitespace: [
      [/[ \t\r\n]+/, 'white'],
      [/\/\*\*(?!\/)/, 'comment.doc', '@javadoc'],
      [/\/\*/, 'comment', '@comment'],
      [/\/\/.*$/, 'comment'],
    ],
    javadoc: [
      [/[^/*]+/, 'comment.doc'],
      [/\/\*/, 'comment.doc.invalid'],
      [/\*\//, 'comment.doc', '@pop'],
      [/[/*]/, 'comment.doc'],
    ],
    comment: [
      [/[^/*]+/, 'comment'],
      [/\/\*/, 'comment.invalid'],
      [/\*\//, 'comment', '@pop'],
      [/[/*]/, 'comment'],
    ],
    numbers: [
      [/0[xX][0-9a-fA-F_]+[Ll]?/, 'number.hex'],
      [/0[bB][01_]+[Ll]?/, 'number.binary'],
      [/\d+[eE][-+]?\d+[fFdD]?/, 'number.float'],
      [/\d+\.\d*([eE][-+]?\d+)?[fFdD]?/, 'number.float'],
      [/\d+[lLfFdD]?/, 'number'],
    ],
    strings: [
      [/"""/, 'string', '@multistring'],
      [/"([^"\\]|\\.)*"/, 'string'],
      [/'([^'\\]|\\.)'/, 'string'],
    ],
    multistring: [
      [/[^\\"]+/, 'string'],
      [/\\./, 'string.escape'],
      [/"""/, 'string', '@pop'],
      [/"/, 'string'],
    ],
  },
};

const registerEnhancedLanguages = () => {
  try {
    monaco.languages.setMonarchTokensProvider('python', enhancedPythonLanguage);
    monaco.languages.setMonarchTokensProvider('java', enhancedJavaLanguage);
  } catch (e) {
    console.error('Failed to set enhanced monarch tokens', e);
  }
};

monaco.languages.onLanguage('python', registerEnhancedLanguages);
monaco.languages.onLanguage('java', registerEnhancedLanguages);
registerEnhancedLanguages();

// ── Groovy / Jenkinsfile 语言注册 ─────────────────────────────────────────────
// Monaco 不内置 Groovy，手动注册 Monarch tokenizer。
// 涵盖 Groovy 语法 + Jenkins Pipeline DSL 关键字（pipeline/stage/steps 等）。
monaco.languages.register({ id: 'groovy', extensions: ['.groovy', '.gvy', '.gy'], filenames: ['Jenkinsfile'] });

monaco.languages.setMonarchTokensProvider('groovy', {
  defaultToken: '',
  tokenPostfix: '.groovy',

  // Jenkins Pipeline DSL + Groovy 关键字合集
  keywords: [
    'abstract', 'assert', 'break', 'case', 'catch', 'class', 'const', 'continue',
    'def', 'default', 'do', 'else', 'enum', 'extends', 'final', 'finally', 'for',
    'goto', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'native',
    'new', 'package', 'private', 'protected', 'public', 'return', 'static', 'strictfp',
    'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'trait', 'transient',
    'try', 'volatile', 'while',
    // Jenkins Pipeline DSL
    'pipeline', 'agent', 'stages', 'stage', 'steps', 'post', 'environment',
    'options', 'parameters', 'triggers', 'tools', 'when', 'parallel', 'matrix',
    'axes', 'axis', 'excludes', 'input', 'libraries', 'script', 'node', 'label',
    'always', 'success', 'failure', 'unstable', 'changed', 'aborted', 'cleanup',
    'any', 'none', 'dockerfile',
  ],

  typeKeywords: ['boolean', 'byte', 'char', 'double', 'float', 'int', 'long', 'short', 'void', 'String', 'Integer', 'Boolean', 'List', 'Map', 'Object'],

  operators: ['=', '>', '<', '!', '~', '?', ':', '==', '<=', '>=', '!=', '&&', '||', '++', '--', '+', '-', '*', '/', '&', '|', '^', '%', '<<', '>>', '>>>', '+=', '-=', '*=', '/=', '&=', '|=', '^=', '%=', '<<=', '>>=', '>>>=', '->', '::', '?.', '**'],

  symbols: /[=><!~?:&|+\-*^%/]+/,
  escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,

  tokenizer: {
    root: [
      // Shebang line
      [/^#!.*$/, 'comment'],

      // Identifiers & keywords
      [/[a-zA-Z_$][\w$]*/, {
        cases: {
          '@keywords': 'keyword',
          '@typeKeywords': 'type',
          '@default': 'identifier',
        },
      }],

      // Whitespace
      { include: '@whitespace' },

      // Delimiters
      [/[{}()[\]]/, '@brackets'],
      [/[<>](?!@symbols)/, '@brackets'],
      [/@symbols/, {
        cases: {
          '@operators': 'operator',
          '@default': '',
        },
      }],

      // Annotations / decorators
      [/@[a-zA-Z_$][\w$]*/, 'annotation'],

      // Numbers
      [/\d*\.\d+([eE][-+]?\d+)?[fFdD]?/, 'number.float'],
      [/0[xX][0-9a-fA-F_]+[lL]?/, 'number.hex'],
      [/\d+[lL]?/, 'number'],

      // Delimiter
      [/[;,.]/, 'delimiter'],

      // Strings (triple-quoted first)
      [/"""/, 'string', '@tripleDoubleString'],
      [/'''/, 'string', '@tripleSingleString'],
      [/"([^"\\]|\\.)*$/, 'string.invalid'],
      [/"/, 'string', '@doubleString'],
      [/'([^'\\]|\\.)*$/, 'string.invalid'],
      [/'/, 'string', '@singleString'],

      // GString / slashy string
      [/\/(?![/*])/, 'string', '@slashyString'],
    ],

    whitespace: [
      [/[ \t\r\n]+/, ''],
      [/\/\*\*(?!\/)/, 'comment.doc', '@javadoc'],
      [/\/\*/, 'comment.block', '@comment'],
      [/\/\/.*$/, 'comment'],
    ],

    comment: [
      [/[^/*]+/, 'comment.block'],
      [/\/\*/, 'comment.block', '@push'],
      [/\*\//, 'comment.block', '@pop'],
      [/[/*]/, 'comment.block'],
    ],

    javadoc: [
      [/[^/*]+/, 'comment.doc'],
      [/\/\*/, 'comment.doc', '@push'],
      [/\*\//, 'comment.doc', '@pop'],
      [/[/*]/, 'comment.doc'],
    ],

    tripleDoubleString: [
      [/[^"\\]+/, 'string'],
      [/@escapes/, 'string.escape'],
      [/\\./, 'string.escape.invalid'],
      [/"""/, 'string', '@pop'],
      [/"/, 'string'],
    ],

    tripleSingleString: [
      [/[^'\\]+/, 'string'],
      [/@escapes/, 'string.escape'],
      [/\\./, 'string.escape.invalid'],
      [/'''/, 'string', '@pop'],
      [/'/, 'string'],
    ],

    doubleString: [
      [/[^"\\$]+/, 'string'],
      [/@escapes/, 'string.escape'],
      [/\\./, 'string.escape.invalid'],
      [/"/, 'string', '@pop'],
    ],

    singleString: [
      [/[^'\\]+/, 'string'],
      [/@escapes/, 'string.escape'],
      [/\\./, 'string.escape.invalid'],
      [/'/, 'string', '@pop'],
    ],

    slashyString: [
      [/[^/\\]+/, 'string'],
      [/\\./, 'string.escape'],
      [/\//, 'string', '@pop'],
    ],
  },
});

// 补全提示关键字
monaco.languages.setLanguageConfiguration('groovy', {
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
  brackets: [['{', '}'], ['[', ']'], ['(', ')']],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"', notIn: ['string'] },
    { open: "'", close: "'", notIn: ['string', 'comment'] },
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
  indentationRules: {
    increaseIndentPattern: /^.*\{[^}"']*$/,
    decreaseIndentPattern: /^(.*\*\/)?\s*\}.*$/,
  },
});



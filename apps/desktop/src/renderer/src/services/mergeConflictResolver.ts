import type * as monaco from 'monaco-editor';

export interface ConflictBlock {
  id: string;
  startLine: number; // 1-indexed line of <<<<<<<
  currentHeader: string;
  currentStartLine: number;
  currentEndLine: number;
  currentText: string;

  hasBase: boolean;
  baseHeader?: string;
  baseText?: string;

  separatorLine: number; // line of =======
  incomingStartLine: number;
  incomingEndLine: number;
  incomingHeader: string;
  incomingText: string;
  endLine: number; // line of >>>>>>>
}

/**
 * 解析文本中包含的所有 Git 合并冲突块 (支持标准冲突及 diff3 base 模式)
 */
export function parseConflictBlocks(content: string): ConflictBlock[] {
  if (!content || !content.includes('<<<<<<<')) return [];

  const lines = content.split(/\r?\n/);
  const blocks: ConflictBlock[] = [];

  let inConflict = false;
  let inBase = false;
  let startLine = 0;
  let currentHeader = '';
  let currentLines: string[] = [];
  let baseHeader = '';
  let baseLines: string[] = [];
  let separatorLine = 0;
  let incomingLines: string[] = [];
  let blockIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i];

    if (!inConflict) {
      if (line.startsWith('<<<<<<<')) {
        inConflict = true;
        inBase = false;
        startLine = lineNum;
        currentHeader = line.slice(7).trim() || 'Current Change (当前更改)';
        currentLines = [];
        baseLines = [];
        incomingLines = [];
        separatorLine = 0;
      }
    } else {
      // 处于冲突块内部
      if (!separatorLine && line.startsWith('|||||||')) {
        inBase = true;
        baseHeader = line.slice(7).trim() || 'Base Change (共同基底)';
      } else if (line.startsWith('=======') && !line.startsWith('========')) {
        inBase = false;
        separatorLine = lineNum;
      } else if (line.startsWith('>>>>>>>')) {
        // 冲突结束
        const incomingHeader = line.slice(7).trim() || 'Incoming Change (传入更改)';
        const endLine = lineNum;

        const currentStartLine = startLine + 1;
        const currentEndLine = separatorLine ? separatorLine - 1 : lineNum - 1;
        const incomingStartLine = separatorLine ? separatorLine + 1 : startLine + 1;
        const incomingEndLine = endLine - 1;

        blocks.push({
          id: `conflict-${blockIndex++}-${startLine}`,
          startLine,
          currentHeader,
          currentStartLine,
          currentEndLine,
          currentText: currentLines.join('\n'),
          hasBase: baseLines.length > 0,
          baseHeader: baseHeader || undefined,
          baseText: baseLines.length > 0 ? baseLines.join('\n') : undefined,
          separatorLine: separatorLine || startLine,
          incomingStartLine,
          incomingEndLine,
          incomingHeader,
          incomingText: incomingLines.join('\n'),
          endLine,
        });

        inConflict = false;
        inBase = false;
        separatorLine = 0;
      } else {
        if (!separatorLine) {
          if (inBase) {
            baseLines.push(line);
          } else {
            currentLines.push(line);
          }
        } else {
          incomingLines.push(line);
        }
      }
    }
  }

  return blocks;
}

/**
 * 解决单个冲突块并返回替换后的完整文本
 */
export function resolveSingleConflict(
  content: string,
  block: ConflictBlock,
  resolution: 'current' | 'incoming' | 'both',
): string {
  const lines = content.split(/\r?\n/);
  let replacementLines: string[] = [];

  if (resolution === 'current') {
    replacementLines = block.currentText ? block.currentText.split('\n') : [];
  } else if (resolution === 'incoming') {
    replacementLines = block.incomingText ? block.incomingText.split('\n') : [];
  } else if (resolution === 'both') {
    const cur = block.currentText ? block.currentText.split('\n') : [];
    const inc = block.incomingText ? block.incomingText.split('\n') : [];
    replacementLines = [...cur, ...inc];
  }

  // 1-indexed to 0-indexed splice
  const deleteCount = block.endLine - block.startLine + 1;
  lines.splice(block.startLine - 1, deleteCount, ...replacementLines);
  return lines.join('\n');
}

/**
 * 一键解决全部冲突块
 */
export function resolveAllConflicts(
  content: string,
  resolution: 'current' | 'incoming' | 'both',
): string {
  const blocks = parseConflictBlocks(content);
  if (!blocks.length) return content;

  // 从后往前替换，保持前面行号不发生偏移
  let updated = content;
  for (let i = blocks.length - 1; i >= 0; i--) {
    updated = resolveSingleConflict(updated, blocks[i], resolution);
  }
  return updated;
}

/**
 * 注册 Monaco 编辑器 Git 冲突 CodeLens 提供者
 */
export function registerConflictCodeLensProvider(
  monacoInstance: typeof monaco,
  onResolve?: (block: ConflictBlock, resolution: 'current' | 'incoming' | 'both') => void,
): monaco.IDisposable {
  return monacoInstance.languages.registerCodeLensProvider('*', {
    provideCodeLenses(model) {
      const content = model.getValue();
      if (!content.includes('<<<<<<<')) return { lenses: [], dispose: () => {} };

      const blocks = parseConflictBlocks(content);
      const lenses: monaco.languages.CodeLens[] = [];

      for (const block of blocks) {
        const range: monaco.IRange = {
          startLineNumber: block.startLine,
          startColumn: 1,
          endLineNumber: block.startLine,
          endColumn: 1,
        };

        lenses.push({
          range,
          command: {
            id: 'echoly.resolveConflict',
            title: `✦ 采用当前更改 (${block.currentHeader || 'HEAD'})`,
            arguments: [block, 'current'],
          },
        });

        lenses.push({
          range,
          command: {
            id: 'echoly.resolveConflict',
            title: `✦ 采用传入更改 (${block.incomingHeader || 'Incoming'})`,
            arguments: [block, 'incoming'],
          },
        });

        lenses.push({
          range,
          command: {
            id: 'echoly.resolveConflict',
            title: `✦ 保留双方更改`,
            arguments: [block, 'both'],
          },
        });
      }

      return {
        lenses,
        dispose: () => {},
      };
    },
    resolveCodeLens(_model, codeLens) {
      return codeLens;
    },
  });
}

/**
 * 注册全局 Git 冲突 CodeLens 命令执行器
 */
export function registerConflictCommands(
  monacoInstance: typeof monaco,
  onResolve?: (block: ConflictBlock, resolution: 'current' | 'incoming' | 'both') => void,
): monaco.IDisposable {
  return monacoInstance.editor.registerCommand(
    'echoly.resolveConflict',
    (_accessor, block: ConflictBlock, resolution: 'current' | 'incoming' | 'both') => {
      if (onResolve) {
        onResolve(block, resolution);
      }
      window.dispatchEvent(
        new CustomEvent('echoly:resolveConflict', {
          detail: { block, resolution },
        }),
      );
    },
  );
}

/**
 * 为冲突区块生成 Monaco 语法高亮装饰器 (Current 为绿底，Incoming 为蓝紫底)
 */
export function createConflictDecorations(
  blocks: ConflictBlock[],
): monaco.editor.IModelDeltaDecoration[] {
  const decorations: monaco.editor.IModelDeltaDecoration[] = [];

  for (const b of blocks) {
    // 1. Current 区块背景
    decorations.push({
      range: {
        startLineNumber: b.startLine,
        startColumn: 1,
        endLineNumber: b.separatorLine ? b.separatorLine - 1 : b.endLine - 1,
        endColumn: 1,
      },
      options: {
        isWholeLine: true,
        className: 'conflict-current-range',
        linesDecorationsClassName: 'conflict-gutter-current',
      },
    });

    // 2. Incoming 区块背景
    if (b.separatorLine) {
      decorations.push({
        range: {
          startLineNumber: b.separatorLine + 1,
          startColumn: 1,
          endLineNumber: b.endLine,
          endColumn: 1,
        },
        options: {
          isWholeLine: true,
          className: 'conflict-incoming-range',
          linesDecorationsClassName: 'conflict-gutter-incoming',
        },
      });
    }
  }

  return decorations;
}

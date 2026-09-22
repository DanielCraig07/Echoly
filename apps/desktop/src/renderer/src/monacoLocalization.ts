// @ts-expect-error internal monaco private module
import { ActionViewItem } from 'monaco-editor/esm/vs/base/browser/ui/actionbar/actionViewItems.js';
// @ts-expect-error internal monaco private module
import { Menu } from 'monaco-editor/esm/vs/base/browser/ui/menu/menu.js';
// @ts-expect-error internal monaco private module
import { QuickInputTree } from 'monaco-editor/esm/vs/platform/quickinput/browser/quickInputTree.js';

export const MONACO_ZH_TRANSLATIONS: Record<string, string> = {
  // AI
  'Inline AI Edit': '✦ 行内 AI 编辑',
  'Add to AI Chat': '✦ 添加到 AI 对话',

  // Navigation
  'Go to Definition': '转到定义',
  'Go to References': '转到引用',
  'Go to Symbol...': '转到符号...',
  'Go to Declaration': '转到声明',
  'Go to Type Definition': '转到类型定义',
  'Go to Implementations': '转到实现',
  'Find All References': '查找所有引用',

  // Peek
  'Peek': '快速查看',
  'Peek Definition': '查看定义',
  'Peek References': '查看引用',
  'Peek Declaration': '查看声明',
  'Peek Type Definition': '查看类型定义',
  'Peek Implementation': '查看实现',

  // Modification
  'Rename Symbol': '重命名符号',
  'Change All Occurrences': '更改所有匹配项',
  'Format Document': '格式化文档',
  'Format Selection': '格式化选中内容',
  'Refactor...': '重构...',
  'Source Action...': '源代码操作...',
  'Quick Fix...': '快速修复...',

  // Clipboard & Selection
  'Cut': '剪切',
  'Copy': '复制',
  'Paste': '粘贴',
  'Select All': '全选',
  'Undo': '撤销',
  'Redo': '重做',

  // Command Palette
  'Command Palette': '命令面板',

  // Git
  'Git: View File History': 'Git: View File History',

  // Terminal
  'Open in Integrated Terminal': '在集成终端中打开',
  '在集成终端中打开': '在集成终端中打开',
};

const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC');

export const MONACO_KEYBINDINGS: Record<string, string> = {
  // AI
  'echoly.inlineAi': isMac ? '⌘K' : 'Ctrl+K',
  'echoly.addToChat': isMac ? '⌘L' : 'Ctrl+L',
  '✦ 行内 AI 编辑': isMac ? '⌘K' : 'Ctrl+K',
  '✦ 添加到 AI 对话': isMac ? '⌘L' : 'Ctrl+L',

  // Navigation
  'editor.action.revealDefinition': isMac ? '⌘F12' : 'F12',
  'Go to Definition': isMac ? '⌘F12' : 'F12',
  '转到定义': isMac ? '⌘F12' : 'F12',

  'editor.action.referenceSearch.trigger': isMac ? '⇧F12' : 'Shift+F12',
  'Go to References': isMac ? '⇧F12' : 'Shift+F12',
  '转到引用': isMac ? '⇧F12' : 'Shift+F12',

  'editor.action.quickOutline': isMac ? '⇧⌘O' : 'Ctrl+Shift+O',
  'Go to Symbol...': isMac ? '⇧⌘O' : 'Ctrl+Shift+O',
  '转到符号...': isMac ? '⇧⌘O' : 'Ctrl+Shift+O',

  'editor.action.peekDefinition': isMac ? '⌥F12' : 'Alt+F12',
  'Peek Definition': isMac ? '⌥F12' : 'Alt+F12',
  '查看定义': isMac ? '⌥F12' : 'Alt+F12',

  'editor.action.rename': 'F2',
  'Rename Symbol': 'F2',
  '重命名符号': 'F2',

  'editor.action.changeAll': isMac ? '⌘F2' : 'Ctrl+F2',
  'Change All Occurrences': isMac ? '⌘F2' : 'Ctrl+F2',
  '更改所有匹配项': isMac ? '⌘F2' : 'Ctrl+F2',

  'editor.action.formatDocument': isMac ? '⌥⇧F' : 'Shift+Alt+F',
  'Format Document': isMac ? '⌥⇧F' : 'Shift+Alt+F',
  '格式化文档': isMac ? '⌥⇧F' : 'Shift+Alt+F',

  'editor.action.clipboardCutAction': isMac ? '⌘X' : 'Ctrl+X',
  'Cut': isMac ? '⌘X' : 'Ctrl+X',
  '剪切': isMac ? '⌘X' : 'Ctrl+X',

  'editor.action.clipboardCopyAction': isMac ? '⌘C' : 'Ctrl+C',
  'Copy': isMac ? '⌘C' : 'Ctrl+C',
  '复制': isMac ? '⌘C' : 'Ctrl+C',

  'editor.action.clipboardPasteAction': isMac ? '⌘V' : 'Ctrl+V',
  'Paste': isMac ? '⌘V' : 'Ctrl+V',
  '粘贴': isMac ? '⌘V' : 'Ctrl+V',

  'editor.action.quickCommand': isMac ? '⇧⌘P' : 'F1',
  'Command Palette': isMac ? '⇧⌘P' : 'F1',
  '命令面板': isMac ? '⇧⌘P' : 'F1',
};

function translateText(text: string): string {
  const trimmed = text.trim();
  if (MONACO_ZH_TRANSLATIONS[trimmed]) {
    return MONACO_ZH_TRANSLATIONS[trimmed];
  }
  // Try case insensitive or partial match
  for (const [en, zh] of Object.entries(MONACO_ZH_TRANSLATIONS)) {
    if (trimmed.toLowerCase() === en.toLowerCase()) {
      return zh;
    }
  }
  return text;
}

function getKeybindingFor(idOrLabel: string): string | null {
  const trimmed = idOrLabel.trim();
  if (MONACO_KEYBINDINGS[trimmed]) return MONACO_KEYBINDINGS[trimmed];
  const zh = MONACO_ZH_TRANSLATIONS[trimmed];
  if (zh && MONACO_KEYBINDINGS[zh]) return MONACO_KEYBINDINGS[zh];
  return null;
}

/**
 * 拦截并汉化 Monaco Editor 右键菜单项与快捷键提示
 */
export function setupMonacoChineseLocalization() {
  // 1. Monkey-patch ActionViewItem
  try {
    const proto = ActionViewItem.prototype as any;
    const origRender = proto.render;
    proto.render = function (container: HTMLElement) {
      origRender.call(this, container);
      try {
        if (this.action) {
          const rawLabel = this.action.label || '';
          const zh = translateText(rawLabel);
          if (zh !== rawLabel && this.label) {
            this.label.textContent = zh;
          }
          const kb = getKeybindingFor(this.action.id) || getKeybindingFor(rawLabel) || getKeybindingFor(zh);
          if (kb && this.element) {
            let kbEl = this.element.querySelector('.keybinding');
            if (!kbEl) {
              kbEl = document.createElement('span');
              kbEl.className = 'keybinding';
              this.element.appendChild(kbEl);
            }
            kbEl.textContent = kb;
          }
        }
      } catch (err) {
        console.warn('Monaco ActionViewItem localization error:', err);
      }
    };

    const origUpdateLabel = proto.updateLabel;
    proto.updateLabel = function () {
      origUpdateLabel.call(this);
      try {
        if (this.options?.label && this.label && this.action?.label) {
          const zh = translateText(this.action.label);
          if (zh !== this.action.label) {
            this.label.textContent = zh;
          }
        }
      } catch (err) {
        console.warn('Monaco ActionViewItem updateLabel error:', err);
      }
    };
  } catch (e) {
    console.warn('Failed to patch ActionViewItem:', e);
  }

  // 2. Monkey-patch Menu.prototype.doGetActionViewItem
  try {
    const menuProto = Menu.prototype as any;
    const origDoGetActionViewItem = menuProto.doGetActionViewItem;
    menuProto.doGetActionViewItem = function (action: any, options: any, parentData: any) {
      if (action) {
        if (action.label) {
          const zh = translateText(action.label);
          if (zh !== action.label) {
            action.label = zh;
          }
        }
        if (Array.isArray(action.actions)) {
          for (const sub of action.actions) {
            if (sub && sub.label) {
              const zhSub = translateText(sub.label);
              if (zhSub !== sub.label) {
                sub.label = zhSub;
              }
            }
          }
        }
      }
      const item = origDoGetActionViewItem.call(this, action, options, parentData);
      return item;
    };
  } catch (e) {
    console.warn('Failed to patch Menu.prototype.doGetActionViewItem:', e);
  }

  // 3. 增强 QuickInputTree：鼠标真实移动时同步焦点，键盘滚动时严格防止静止鼠标指针劫持焦点
  try {
    let lastMouseClientX = -1;
    let lastMouseClientY = -1;
    let lastKeyboardTime = 0;

    if (typeof window !== 'undefined') {
      window.addEventListener(
        'keydown',
        (e) => {
          if (
            e.key === 'ArrowUp' ||
            e.key === 'ArrowDown' ||
            e.key === 'PageUp' ||
            e.key === 'PageDown' ||
            e.key === 'Home' ||
            e.key === 'End'
          ) {
            lastKeyboardTime = Date.now();
          }
        },
        true
      );
    }

    const treeProto = QuickInputTree.prototype as any;
    const origRegisterHover = treeProto._registerHoverListeners;
    if (origRegisterHover) {
      treeProto._registerHoverListeners = function () {
        origRegisterHover.call(this);
        if (this._tree) {
          this._register(
            this._tree.onMouseOver((e: any) => {
              // 1. 键盘导航保护：用户使用键盘方向键滚动时，严格禁止静止鼠标抢夺焦点
              if (Date.now() - lastKeyboardTime < 350) {
                return;
              }

              // 2. 坐标位移校验：若鼠标物理坐标未发生真实改变（如列表在静止鼠标下方滚动），坚决忽略
              const mouseEvent = e.browserEvent;
              if (mouseEvent && typeof mouseEvent.clientX === 'number') {
                if (mouseEvent.clientX === lastMouseClientX && mouseEvent.clientY === lastMouseClientY) {
                  return;
                }
                lastMouseClientX = mouseEvent.clientX;
                lastMouseClientY = mouseEvent.clientY;
              }

              if (e.element && e.element.item) {
                const currentFocus = this._tree.getFocus();
                if (!currentFocus || currentFocus[0] !== e.element) {
                  this._tree.setFocus([e.element]);
                }
              }
            })
          );
        }
      };
    }
  } catch (e) {
    console.warn('Failed to patch QuickInputTree hover focus:', e);
  }

  // 3. DOM 动态监听增强兜底：当 Monaco 渲染右键菜单时，即时扫描并汉化文本与补齐快捷键
  if (typeof document !== 'undefined') {
    const processMenuNode = (node: HTMLElement) => {
      const container = node.classList.contains('monaco-menu-container')
        ? node
        : node.querySelector<HTMLElement>('.monaco-menu-container') || node;
      container.classList.add('monaco-styled-menu');
      container.style.border = 'none';
      container.style.outline = 'none';
      container.querySelectorAll<HTMLElement>('.monaco-scrollable-element, .actions-container').forEach((el) => {
        el.style.border = 'none';
        el.style.outline = 'none';
      });

      const items = node.querySelectorAll<HTMLElement>('.action-item, .action-menu-item');
      items.forEach((item) => {
        const labelEl = item.querySelector<HTMLElement>('.action-label');
        if (labelEl && labelEl.textContent) {
          const currentText = labelEl.textContent.trim();
          const translated = translateText(currentText);
          if (translated !== currentText) {
            labelEl.textContent = translated;
          }

          if (currentText.includes('AI') || translated.includes('AI') || currentText.includes('✦')) {
            item.classList.add('monaco-ai-menu-item');
          }

          const kb = getKeybindingFor(currentText) || getKeybindingFor(translated);
          if (kb) {
            let kbEl = item.querySelector<HTMLElement>('.keybinding');
            if (!kbEl) {
              kbEl = document.createElement('span');
              kbEl.className = 'keybinding';
              item.appendChild(kbEl);
            }
            if (kbEl.textContent !== kb) {
              kbEl.textContent = kb;
            }
          }
        }
      });
    };

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const added of Array.from(m.addedNodes)) {
          if (added instanceof HTMLElement) {
            if (added.classList.contains('monaco-menu-container') || added.querySelector('.monaco-menu-container')) {
              processMenuNode(added);
            } else if (added.classList.contains('action-menu-item') || added.classList.contains('action-item')) {
              const parentMenu = added.closest<HTMLElement>('.monaco-menu-container');
              if (parentMenu) {
                processMenuNode(parentMenu);
              }
            }
          }
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }
}

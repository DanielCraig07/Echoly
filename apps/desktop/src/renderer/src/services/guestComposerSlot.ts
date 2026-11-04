/**
 * 在扩展页面里，给我们的「文件已被改动」栏**腾一块地方**。
 *
 * 为什么需要这个：Claude Code / Codex 的输入框长在**扩展自己的 webview 里**，我们既插不
 * 进去、也拿不到它的高度。这一栏理想的位置是「紧贴在它自己的输入框上方」（Cursor 就是
 * 这样），但那意味着我们的 DOM 要伸进访客页面的版面里。
 *
 * 好消息是 `<webview>` 可以执行访客页面里的 JS（`executeJavaScript`）。于是做法是：
 *
 * 1. 在访客页面里找到「输入框那一整块」；
 * 2. 在它**上面**插一个和我们的栏一样高的空位（`flex` 布局会把输入框整体顶上去）；
 * 3. 把这块空位的坐标读回来，我们的栏就浮在那块空位上 —— 正好在它自己的输入框上方，
 *    而且不遮任何东西。
 *
 * 三条「必须做对」的规矩：
 *
 * - **插了要自检**：有的界面把输入框钉死在底部（`position: fixed`），在它前面插空位
 *   一点用都没有。这时**必须把空位撤掉** —— 留着它只会让我们的栏盖住用户打字的地方。
 *   没插成、或者顶不动，就返回 `null`，调用方退回「浮在左下角」那种保守做法。
 * - **每次先收掉上一次那块**：消息在长、用户在打字，输入框的位置一直在变，拿旧空位去
 *   比会得出错的结论。
 * - **这段函数必须是自包含的**：它在访客页面里执行，碰不到我们这个模块里的任何东西
 *   （见 `buildMeasureScript`）。
 *
 * 还有一条是从真实事故里补回来的：**认不出输入框时宁可不插**。第一版只按「最靠下的
 * 可编辑元素」找，结果 Claude 的输入框（在 shadow root 里、普通查询穿不过去）没被认出来，
 * 转录区里一个可编辑块被当成了锚点 —— 栏就飘在对话中间。所以现在：深挖 shadow root，
 * 并且**要求锚点贴着视口底部那一带**（输入框永远在底部，转录区里那种块不是）。
 */

/** 访客页面里那块空位的 id。改这里就要改 `measureComposerSlot` 里的同名常量（有测试钉着）。 */
export const COMPOSER_SLOT_ID = 'echoly-pending-bar-slot';

export interface GuestComposerSlot {
  /** 空位上沿到访客视口顶部的距离。webview 铺满面板，所以这就是在面板里的 y 偏移。 */
  top: number;
  /** 空位高度（= 我们那一栏的高度）。 */
  height: number;
}

interface GuestRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

interface GuestElement {
  parentElement: GuestElement | null;
  /** `TEXTAREA` / `INPUT`（会转成大写比较）。 */
  tagName?: string;
  /** 浏览器自己算出来的「这个元素真的能编辑吗」—— `contenteditable` 的继承也算在内。 */
  isContentEditable?: boolean;
  /** 自定义元素把自己的内容藏在里面（VS Code 风格的界面到处都是），要深挖进去。 */
  shadowRoot?: { querySelectorAll(selector: string): ArrayLike<GuestElement> } | null;
  style: { cssText: string };
  getBoundingClientRect(): GuestRect;
  insertBefore(node: GuestElement, reference: GuestElement | null): void;
  removeChild(node: GuestElement): void;
  setAttribute(name: string, value: string): void;
}

interface GuestDocument {
  body: GuestElement | null;
  documentElement: GuestElement | null;
  getElementById(id: string): GuestElement | null;
  querySelectorAll(selector: string): ArrayLike<GuestElement>;
  createElement(tag: string): GuestElement;
}

interface GuestWindow {
  innerHeight: number;
}

export function measureComposerSlot(
  doc: GuestDocument,
  win: GuestWindow,
  barHeight: number,
): GuestComposerSlot | null {
  const SLOT_ID = 'echoly-pending-bar-slot';
  if (!doc || !win || !(barHeight > 0)) return null;

  const viewportH = win.innerHeight || 0;
  if (!(viewportH > 0)) return null;

  const rectOf = (el: GuestElement | null): GuestRect | null =>
    el && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;

  /* 每次先收掉上一次那块：输入框的位置一直在变，拿旧空位去比会得出错的结论 */
  const previous = doc.getElementById(SLOT_ID);
  if (previous && previous.parentElement) previous.parentElement.removeChild(previous);

  /* 1) 找「输入框本体」。三个条件并用 —— 少一个都会挑错人：
        - **深挖 shadow root**：VS Code 风格的界面把控件放在自定义元素里，普通的
          `querySelectorAll` 穿不过去；
        - 只认**最外层**那个可编辑元素（里面的 span 不算，叠加的是同一个输入框）；
        - 必须**贴着视口底部那一带**。这一条是血的教训：找不到输入框时，转录区里
          随便一个可编辑块（diff 预览、代码块之类）都会被当成锚点，
          于是栏就飘在对话中间了。输入框永远在底部，那种块不是。 */
  const allNodes: GuestElement[] = [];
  const collectAll = (
    root: { querySelectorAll(selector: string): ArrayLike<GuestElement> } | null,
    out: GuestElement[],
  ): void => {
    if (!root) return;
    const nodes = root.querySelectorAll('*');
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      out.push(el);
      if (el.shadowRoot) collectAll(el.shadowRoot, out);
    }
  };
  collectAll(doc, allNodes);

  const bottomZone = Math.max(140, viewportH * 0.25);
  let input: GuestElement | null = null;
  let bestBottom = -Infinity;
  for (let i = 0; i < allNodes.length; i++) {
    const el = allNodes[i];
    const tag = String(el.tagName || '').toUpperCase();
    const isField = tag === 'TEXTAREA' || tag === 'INPUT';
    if (!isField && !el.isContentEditable) continue;
    /* 只要最外层那个可编辑元素：里面的子节点属于同一个输入框 */
    if (!isField && el.parentElement && el.parentElement.isContentEditable) continue;

    const rect = rectOf(el);
    if (!rect) continue;
    if (!(rect.width > 40 && rect.height > 8)) continue;
    if (rect.bottom <= 0 || rect.top >= viewportH) continue;
    if (viewportH - rect.bottom > bottomZone) continue;
    if (rect.bottom > bestBottom) {
      bestBottom = rect.bottom;
      input = el;
    }
  }
  if (!input) return null;

  /* 2) 往上走到「输入框那一整块」。
        判据是「没有高出一大截」：那样的一层层包裹都还属于输入框那一块；
        一旦某个父节点高出一大截（那是消息区）就停手。
        底下留 80px 的落差是有意的 —— 输入框下面常常还有一行工具栏（模型选择、发送
        按钮…），要求底边严格齐平就会把那一整块漏掉、把空位塞进输入框和工具栏之间。 */
  let block = input;
  for (let guard = 0; guard < 12; guard++) {
    const parent = block.parentElement;
    if (!parent || parent === doc.body || parent === doc.documentElement) break;
    const pr = rectOf(parent);
    const br = rectOf(block);
    if (!pr || !br) break;
    if (pr.bottom - br.bottom > 80) break;
    if (pr.height - br.height > 80) break;
    if (pr.height > viewportH * 0.6) break;
    block = parent;
  }

  /* 3) 在它前面插空位。插不动就往上再试一层 —— 有的界面把输入框包在一个不带 flex 的
        容器里，插在那一层不会把它顶上去。 */
  let host = block.parentElement;
  for (let attempt = 0; attempt < 3 && host; attempt++) {
    const slot = doc.createElement('div');
    slot.setAttribute('id', SLOT_ID);
    slot.setAttribute('data-echoly', 'pending-bar');
    /* pointer-events:none：这块空位只是占地方，点它应该落到下面的页面上 */
    slot.style.cssText = 'flex:0 0 auto;width:100%;height:' + barHeight + 'px;pointer-events:none;';
    host.insertBefore(slot, block);

    /* 3) 自检。插进去**不等于**插对了 —— 有的界面把输入框钉死（`position: fixed`），
          空位会直接落在输入框身上；有的容器不是 flex，插一行会把输入框顶出视口。
          这两种都必须撤掉并返回 null：栏盖住用户打字的地方，比栏跑到左下角糟得多。

          注意**不要求输入框的位置发生变化**：正常的 flex 列里，空位是让上面的消息区
          缩掉、输入框继续贴着底边 —— 空位就是它上面那一行，这正是我们要的。 */
    const slotRect = rectOf(slot);
    const blockRect = rectOf(block);
    const overlapsBlock =
      !!slotRect &&
      !!blockRect &&
      slotRect.bottom > blockRect.top + 2 &&
      slotRect.top < blockRect.bottom - 2;
    const placed =
      !!slotRect &&
      !!blockRect &&
      slotRect.height >= barHeight - 4 &&
      slotRect.top >= -2 &&
      !overlapsBlock &&
      blockRect.bottom <= viewportH + 2;
    if (placed) {
      return { top: slotRect.top, height: barHeight };
    }

    host.removeChild(slot);

    const outer = host.parentElement;
    if (!outer || outer === doc.body || outer === doc.documentElement) break;
    block = host;
    host = outer;
  }

  return null;
}

/**
 * 把上面那个函数塞进访客页面执行的源码。
 *
 * 直接 `Function.prototype.toString()`：这样**被测试的就是被执行的**那一份，
 * 不会出现「测试里那份是对的、注入进页面的那份是抄错的」。所以那个函数必须自包含 ——
 * 不能引用模块里的任何常量或别的函数。
 */
export function buildMeasureScript(barHeight: number): string {
  const height = Number.isFinite(barHeight) && barHeight > 0 ? Math.round(barHeight) : 0;
  return `(${measureComposerSlot.toString()})(document, window, ${height})`;
}

/** 收掉访客页面里那块空位（这一栏关掉/换位置时必须调，否则页面上会留一块空白）。 */
export function buildClearSlotScript(): string {
  return `(function(){var el=document.getElementById(${JSON.stringify(
    COMPOSER_SLOT_ID,
  )});if(el&&el.parentElement){el.parentElement.removeChild(el);}})()`;
}

/** `executeJavaScript` 回来的东西不可信（可能是 undefined、字符串、被扩展改过的对象）。 */
export function isGuestComposerSlot(value: unknown): value is GuestComposerSlot {
  if (!value || typeof value !== 'object') return false;
  const slot = value as Partial<GuestComposerSlot>;
  return (
    typeof slot.top === 'number' &&
    Number.isFinite(slot.top) &&
    typeof slot.height === 'number' &&
    Number.isFinite(slot.height) &&
    slot.height > 0
  );
}

/** `<webview>` 在这里只需要这一个方法；用一个最小的结构类型，测试里也好造假的。 */
export interface ScriptableWebview {
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
}

/**
 * 量一次访客页面里的空位。任何一步失败都返回 `null`（调用方退回「浮在左下角」），
 * **不抛**：这条路上出问题只会让位置差一点，绝不该把界面弄崩。
 */
export async function measureSlotInWebview(
  webview: ScriptableWebview | null | undefined,
  barHeight: number,
): Promise<GuestComposerSlot | null> {
  if (!webview || typeof webview.executeJavaScript !== 'function') return null;
  if (!(barHeight > 0)) return null;
  try {
    const result = await webview.executeJavaScript(buildMeasureScript(barHeight), false);
    return isGuestComposerSlot(result) ? result : null;
  } catch {
    // 页面还没就绪 / 扩展把自己的 DOM 换掉了：这一轮当没有空位，下一轮再试
    return null;
  }
}

export async function clearSlotInWebview(
  webview: ScriptableWebview | null | undefined,
): Promise<void> {
  if (!webview || typeof webview.executeJavaScript !== 'function') return;
  try {
    await webview.executeJavaScript(buildClearSlotScript(), false);
  } catch {
    // 页面已经没了：空位跟着一起没了，不用管
  }
}

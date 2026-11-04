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
  /**
   * 栏的**下边**离访客视口底部有多远。
   *
   * 调用方按这个值贴（`bottom: bottomInset`），而不是按 `top`。这样栏的下边永远钉在
   * 输入框的上沿：栏自己变高变矮（文件多了、折叠了）都只会**往上长**，绝不会往下压到
   * 输入框 —— 高度估短了也不会盖住用户打字的地方。
   */
  bottomInset: number;
  /**
   * 这个位置是怎么定出来的。
   *
   * - `slot`：在输入框那一块**外面**插了一块空位，页面真的让出了地方（最干净，谁也不遮）；
   * - `inside`：外面插不动（那一块被钉在底部），改在它**里面**最前面插一行 —— 它自己
   *   往上长，空出来的地方给我们（同样谁也不遮）；
   * - `overlay`：上面两条都不成，位置同样是按输入框的上沿算的（只可能盖住输入框**上面**
   *   那条空档或转录区的一点点，绝不盖输入框）。
   */
  mode?: 'slot' | 'inside' | 'overlay';
  /**
   * 诊断用：认到的那个元素的 tag.class@上-下。
   *
   * 这套东西是在**别人的页面**里认输入框，认错了只会表现成「位置不对」—— 从界面上
   * 完全看不出是没认到、还是认到了别的元素。带上这一句，一条日志就够定位。
   */
  anchor?: string;
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
  /** 第一个孩子（往「里面最前面」插东西要用它）。 */
  firstChild?: GuestElement | null;
  /** `TEXTAREA` / `INPUT`（会转成大写比较）。 */
  tagName?: string;
  /** 只有诊断日志用得到。SVG 上它不是字符串，所以得判一下类型。 */
  className?: unknown;
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
  /** 读元素的 computed style（这里只用 `order`）。取不到就跳过。 */
  getComputedStyle?: (el: GuestElement) => { order?: string } | null;
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

  /** 只给日志用：认到的到底是谁。 */
  const describe = (el: GuestElement): string => {
    const tag = String(el.tagName || '?').toLowerCase();
    const cls =
      typeof el.className === 'string'
        ? el.className
            .split(/\s+/)
            .filter((name) => name)
            .slice(0, 2)
            .join('.')
        : '';
    const rect = rectOf(el);
    return (
      tag +
      (cls ? '.' + cls : '') +
      (rect ? '@' + Math.round(rect.top) + '-' + Math.round(rect.bottom) : '')
    );
  };
  const anchor = describe(block);

  /* 3) 先试「在它上面插一块空位」—— 最干净的做法：页面的流里真的让出地方，输入框被
        顶上去一点，我们的栏落在空位上，谁也不遮谁。插不动就往上再试一层（有的界面把
        输入框包在一个不带 flex 的容器里，插在那一层不会把它顶上去）。 */
  /* 往上爬的那个游标。**不能动 `block` 本身** —— 后面「塞进它里面」和「兜底算位置」
     都还得用最初认定的那一块。 */
  let probe = block;
  let host = probe.parentElement;
  for (let attempt = 0; attempt < 3 && host; attempt++) {
    const slot = doc.createElement('div');
    slot.setAttribute('id', SLOT_ID);
    slot.setAttribute('data-echoly', 'pending-bar');

    /* 抄一份 `order`。有的界面用 flex 的 `order` 排「消息区 / 输入框」，我们这块默认
       `order: 0` 会被排到**最前面** —— 表现就是「栏跑到面板顶部去了」（真实事故）。
       抄一份之后，同一个 order 内部按文档顺序决定，而我们就插在输入框前面，正好贴着它。 */
    let orderStyle = '';
    if (typeof win.getComputedStyle === 'function') {
      try {
        const computed = win.getComputedStyle(probe);
        if (computed && computed.order && computed.order !== '0') {
          orderStyle = 'order:' + computed.order + ';';
        }
      } catch {
        // 拿不到就算了：下面还有「覆盖」那条兜底
      }
    }

    /* pointer-events:none：这块空位只是占地方，点它应该落到下面的页面上 */
    slot.style.cssText =
      'flex:0 0 auto;width:100%;height:' + barHeight + 'px;pointer-events:none;' + orderStyle;
    host.insertBefore(slot, probe);

    /* 自检，只认一种「插对了」：空位**紧贴着输入框那一块的上沿**。
       注意**不要求输入框的位置发生变化** —— 正常的 flex 列里，空位是让上面的消息区
       缩掉、输入框继续贴着底边，空位就是它上面那一行，这正是我们要的。

       反过来，只要空位没贴在它上面（被 `order` 排到别处、被钉死的输入框顶开…），就
       **必须**撤掉：留着它既挡不住输入框、又会在页面上留一段莫名其妙的空白。 */
    const slotRect = rectOf(slot);
    const blockRect = rectOf(probe);
    const adjacent = !!slotRect && !!blockRect && Math.abs(slotRect.bottom - blockRect.top) <= 2;
    const placed =
      adjacent &&
      slotRect!.height >= barHeight - 4 &&
      slotRect!.top >= viewportH * 0.35 &&
      blockRect!.bottom <= viewportH + 2;
    if (placed) {
      const inputNow = rectOf(input);
      return {
        top: Math.round(slotRect!.top),
        height: barHeight,
        bottomInset: inputNow ? viewportH - inputNow.top : viewportH - slotRect!.bottom,
        mode: 'slot',
        anchor,
      };
    }

    host.removeChild(slot);

    const outer = host.parentElement;
    if (!outer || outer === doc.body || outer === doc.documentElement) break;
    probe = host;
    host = outer;
  }

  /* 输入框平时在哪儿 —— 「栏贴在哪里」全靠它。 */
  const inputRectBefore = rectOf(input);
  if (!inputRectBefore) return null;

  /**
   * 栏贴在哪里：**紧贴着输入框的上沿**（`输入框上沿 - 栏高`）。
   *
   * 为什么不贴「输入框那一块」的上沿：那一块的内部结构是对方的自由，顶上可能有内边距、
   * 也可能夹着一小段别的东西。贴着**输入框自己**算，栏的下边就永远等于输入框的上边 ——
   * 一个字都不会盖住用户打字的地方。
   */
  const topFor = (inputRect: GuestRect): number => inputRect.top - barHeight;

  /* 3b) 再试「把空位塞进输入框**自己的父容器**里、紧挨着它上面」。
        有的界面把输入框那一块钉在底部（absolute/fixed 那种），在它外面插兄弟节点它压根
        不动；但往输入框上面塞一行，它自己会让出地方来。

        插在**输入框正上方**（而不是容器顶部）是有意的：中间夹着别的东西时，那些东西会
        被我们的栏盖住 —— 紧挨着插，中间就只可能有内边距。

        「请求多少」和「真的让出多少」不是一回事（对方可能有 max-height、可能只按比例长、
        也可能把内容挤下去），所以**不猜**：量出实际的空档，不够就按这一轮的比例再加一点
        重试（最多三次）。还不够就整条作废，绝不把栏塞进去盖住输入框。 */
  const insertParent = input.parentElement;
  const parentRectBefore = rectOf(insertParent);
  if (insertParent && parentRectBefore) {
    const inputHeightBefore = inputRectBefore.height;
    const spaceBefore = inputRectBefore.top - parentRectBefore.top;
    let request = barHeight;

    for (let attempt = 0; attempt < 3; attempt++) {
      const inner = doc.createElement('div');
      inner.setAttribute('id', SLOT_ID);
      inner.setAttribute('data-echoly', 'pending-bar');
      inner.style.cssText =
        'display:block;width:100%;height:' + request + 'px;flex:0 0 auto;pointer-events:none;';
      insertParent.insertBefore(inner, input);

      const parentRect = rectOf(insertParent);
      const inputRect = rectOf(input);
      /* 输入框上面现在有多少空档（那才是能放我们这一栏的地方） */
      const space = parentRect && inputRect ? inputRect.top - parentRect.top : -1;
      const inputIntact = !!inputRect && inputRect.height >= inputHeightBefore - 4;
      /* 撑住的这一层**不能顶破它外面那一层**。只把输入框往下挤、外面那一块纹丝不动，
         说明它的高度是钉死的 —— 内容只会被挤出去（工具栏会被顶到视口外面）。 */
      const blockRectNow = rectOf(block);
      const contained =
        !!blockRectNow &&
        !!parentRect &&
        parentRect.top >= blockRectNow.top - 2 &&
        parentRect.bottom <= blockRectNow.bottom + 2;
      const sane =
        !!inputRect &&
        !!parentRect &&
        inputRect.bottom <= viewportH + 2 &&
        parentRect.bottom <= viewportH + 2 &&
        parentRect.top >= viewportH * 0.05;

      if (inputRect && space >= barHeight - 2 && inputIntact && contained && sane) {
        return {
          top: Math.round(topFor(inputRect)),
          height: barHeight,
          bottomInset: viewportH - inputRect.top,
          mode: 'inside',
          anchor,
        };
      }

      insertParent.removeChild(inner);

      const gained = space - spaceBefore;
      const need = barHeight - spaceBefore;
      if (gained <= 0 || need <= 0) break;
      /* 按这一轮的实际比例反推：想让空档长到够用，得请求多高 */
      const next = Math.min(Math.ceil((need * request) / gained) + 8, barHeight * 5);
      if (next <= request) break;
      request = next;
    }
  }

  /* 4) 兜底：上面两条都不成（对方把输入框钉死了、容器不是 flex、怎么插都不让…），
        就按输入框的上沿算位置直接盖 —— 只可能盖住输入框**上面**那条空档或转录区的
        一点点，绝不盖输入框本身。 */
  const fallbackTop = topFor(inputRectBefore);
  if (fallbackTop >= viewportH * 0.35 && inputRectBefore.bottom <= viewportH + 2) {
    return {
      top: Math.round(fallbackTop),
      height: barHeight,
      bottomInset: viewportH - inputRectBefore.top,
      mode: 'overlay',
      anchor,
    };
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
    slot.height > 0 &&
    typeof slot.bottomInset === 'number' &&
    Number.isFinite(slot.bottomInset) &&
    slot.bottomInset >= 0
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

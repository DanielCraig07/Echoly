import { describe, expect, it } from 'vitest';
import {
  buildClearSlotScript,
  buildMeasureScript,
  COMPOSER_SLOT_ID,
  isGuestComposerSlot,
  measureComposerSlot,
  measureSlotInWebview,
} from '../src/renderer/src/services/guestComposerSlot';

/**
 * 「在扩展页面里给我们的栏腾地方」这件事的判定规则。
 *
 * 这段代码是在**别人的页面**里跑的，写错的代价不对称：
 * - 空位没插成却报告成功 → 我们的栏盖在用户的输入框上，正好挡住他打字的地方；
 * - 明明能插却报告失败 → 栏退回左下角，丑但无害。
 * 所以每条用例都在钉「什么时候必须拒绝」。
 *
 * 用一个假 DOM 来测：真 DOM 在 node 环境里没有，而这里要验的本来就是**判定逻辑**
 * （挑哪个节点、插在哪一层、插完自检），不是浏览器的布局引擎。
 */

interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

const rect = (top: number, height: number): Rect => ({
  top,
  bottom: top + height,
  left: 0,
  right: 400,
  width: 400,
  height,
});

/** 每次结构变化后重排的回调（由场景装进来）。 */
let onMutation: () => void = () => {};

class FakeEl {
  id = '';
  attrs: Record<string, string> = {};
  tagName = 'DIV';
  /** 浏览器算出来的「真的能编辑吗」（`contenteditable` 的继承也算在内）。 */
  isContentEditable = false;
  /** 自定义元素藏内容的地方（VS Code 风格界面到处都是）。 */
  shadowRoot: { querySelectorAll(selector: string): FakeEl[] } | null = null;
  /** flex 的 `order`（有的界面用它排「消息区 / 输入框」）。 */
  order = 0;
  /** 高度由内容决定（真实的输入框那一块就是这样，往里面插一行它会长高）。 */
  autoHeight = false;
  /** 固定高度；null = flex:1，吃掉剩下的高度。 */
  fixedHeight: number | null = null;
  /** 子节点从下往上排（`display:flex; flex-direction:column`）。 */
  column = false;
  /** 位置钉死（`position: fixed` 那种）：插兄弟节点不会让它动。 */
  pinned = false;
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  rect: Rect = rect(0, 0);

  private css = '';

  /** 服务里写的是 `slot.style.cssText = '...height:56px;...'`。 */
  get style(): FakeEl {
    return this;
  }
  get cssText(): string {
    return this.css;
  }
  set cssText(value: string) {
    this.css = value;
  }

  get parentElement(): FakeEl | null {
    return this.parent;
  }

  get firstChild(): FakeEl | null {
    return kids(this)[0] ?? null;
  }

  /** 生效的 `order`：cssText 里写了就用它（宿主给我们那块空位就是这么设的）。 */
  get cssOrder(): number {
    const matched = /order:\s*(-?\d+)/.exec(this.css);
    return matched ? Number(matched[1]) : this.order;
  }

  /** 自己多高：cssText 里写了 `height:Npx` 就用它，否则用固定高度。 */
  get ownHeight(): number | null {
    const matched = /height:\s*(\d+(?:\.\d+)?)px/.exec(this.css);
    if (matched) return Number(matched[1]);
    return this.fixedHeight;
  }

  getBoundingClientRect(): Rect {
    return { ...this.rect };
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
    if (name === 'id') this.id = value;
  }

  insertBefore(node: FakeEl, reference: FakeEl | null): void {
    node.parent = this;
    const at = reference ? this.children.indexOf(reference) : -1;
    if (at >= 0) this.children.splice(at, 0, node);
    else this.children.push(node);
    onMutation();
  }

  removeChild(node: FakeEl): void {
    const at = this.children.indexOf(node);
    if (at >= 0) this.children.splice(at, 1);
    node.parent = null;
    onMutation();
  }
}

function findByClass(root: FakeEl, pick: (el: FakeEl) => boolean): FakeEl | null {
  if (pick(root)) return root;
  for (const child of kids(root)) {
    const found = findByClass(child, pick);
    if (found) return found;
  }
  return null;
}

function collectDescendants(root: FakeEl, into: FakeEl[] = []): FakeEl[] {
  for (const child of kids(root)) {
    into.push(child);
    collectDescendants(child, into);
  }
  return into;
}

/**
 * 一个像 Claude Code 那样的版面：
 *
 *   body（视口高度的一列）
 *     ├─ 消息区（flex:1）
 *     └─ 输入框那一整块（110px）
 *          └─ 里面一列：[输入框 40px] [工具栏 30px]   ← 输入框**不**贴着整块的底边
 *
 * 「输入框不贴底」是有意的：截图里 Claude 的输入框下面还有一行工具栏，
 * 于是「从输入框往上找到那一整块」这条规则必须能跨过 30px 的落差。
 */
/** 内容撑出来的高度（`autoHeight` 那种盒子：往里面插一行它就长一行）。 */
function contentHeight(node: FakeEl): number {
  let sum = 0;
  for (const child of kids(node)) {
    if (child.pinned) continue;
    // flex:1 那种孩子按它当前的实测高度算（它不撑高，也不塌掉）
    sum += heightOf(child) ?? child.rect.height;
  }
  return sum;
}

/** 一个孩子在父容器里的高度：写死的高度 > 内容高度 > null（flex:1，吃剩下的）。 */
function heightOf(child: FakeEl): number | null {
  const own = child.ownHeight;
  if (own != null) return own;
  return child.autoHeight ? contentHeight(child) : null;
}

/** `kids()`：一个节点的孩子（含 shadow root 里的那些）。 */
function kids(node: FakeEl): FakeEl[] {
  const shadow = node.shadowRoot ? node.shadowRoot.querySelectorAll('*') : [];
  return [...node.children, ...shadow];
}

function makeScene(
  options: {
    pinnedComposer?: boolean;
    /** 输入框那一块的高度由内容决定（往里面插一行它会长高）。 */
    autoComposer?: boolean;
    shadowComposer?: boolean;
    /** 用 flex `order` 排「消息区 / 输入框」的那种界面。 */
    flexOrder?: boolean;
    /** 装成「读不到 computed style」的样子（order 抄不过来）。 */
    noComputedStyle?: boolean;
  } = {},
) {
  const VIEWPORT_H = 800;
  const body = new FakeEl();
  body.column = true;

  const messages = new FakeEl();
  const box = new FakeEl();
  box.column = true;
  box.pinned = Boolean(options.pinnedComposer);
  if (options.autoComposer) {
    // 高度由内容决定：往里面插一行它真的会长高（真实界面里输入框那一块就是这样）
    box.autoHeight = true;
    box.fixedHeight = null;
  } else {
    box.fixedHeight = 110;
  }

  const inner = new FakeEl();
  inner.column = true;

  const input = new FakeEl();
  input.tagName = 'TEXTAREA';
  input.isContentEditable = true;
  input.fixedHeight = 40;

  const toolbar = new FakeEl();
  toolbar.fixedHeight = 30;

  inner.children = [input, toolbar];
  input.parent = inner;
  toolbar.parent = inner;
  box.children = [inner];
  inner.parent = box;
  body.children = [messages, box];
  messages.parent = body;
  box.parent = body;

  function layoutChildren(node: FakeEl): void {
    const { top, height } = node.rect;
    if (!node.column) {
      for (const child of kids(node)) {
        if (child.pinned) continue; // 钉死的自己说了算
        layoutNode(child, top, height);
      }
      return;
    }
    /* 先把「固定高度」的加起来，剩下的给 flex:1 那个 —— 真实的 flex 列就是这个算法。
       钉死的（position: fixed）不占流里的位置，也不参与这个加法。 */
    /* 真实的 flex 列会先按 `order` 排，再按文档顺序（稳定排序）。有的界面就是靠
       `order` 把输入框放到最后的 —— 我们插进去的那一块如果 `order` 是默认的 0，
       会被排到最前面（= 面板顶部），这正是「栏跑到顶上了」那个事故。 */
    const flow = kids(node)
      .filter((child) => !child.pinned)
      .map((child, index) => ({ child, index }))
      .sort((a, b) => a.child.cssOrder - b.child.cssOrder || a.index - b.index)
      .map((entry) => entry.child);
    let used = 0;
    let hasFlex = false;
    for (const child of flow) {
      const h = heightOf(child);
      if (h == null) hasFlex = true;
      else used += h;
    }
    const flexHeight = hasFlex ? Math.max(0, height - used) : 0;

    let bottom = top + height;
    for (let i = flow.length - 1; i >= 0; i--) {
      const child = flow[i];
      const childHeight = heightOf(child) ?? flexHeight;
      layoutNode(child, bottom - childHeight, childHeight);
      bottom -= childHeight;
    }

    /* 钉死的孩子不占流里的位置，但**要让它自己重新锚定**：高度由内容决定的盒子
       （真实界面里的输入框那一块）在内容变多时会往上长。 */
    for (const child of kids(node)) {
      if (!child.pinned) continue;
      layoutNode(child, child.rect.top, Math.max(child.rect.height, contentHeight(child)));
    }
  }

  function layoutNode(node: FakeEl, top: number, height: number): void {
    if (node.pinned && node.rect.height > 0) {
      if (node.autoHeight) {
        // 钉在底部 + 高度由内容决定 ⇒ 内容变多时**往上长**（底边不动）
        const grown = contentHeight(node) || node.rect.height;
        node.rect = rect(node.rect.bottom - grown, grown);
      }
      layoutChildren(node); // 位置不变，但里面的东西要跟着排
      return;
    }
    node.rect = rect(top, height);
    layoutChildren(node);
  }

  const layout = () => layoutNode(body, 0, VIEWPORT_H);
  onMutation = layout;
  layout();

  if (options.shadowComposer) {
    /* 输入框藏在自定义元素的 shadow root 里：普通 `querySelectorAll` 是找不到它的 */
    const host = new FakeEl();
    host.fixedHeight = 110;
    host.children = [];
    host.shadowRoot = { querySelectorAll: () => [box] };
    box.parent = host;
    body.children = [messages, host];
    host.parent = body;
    layout();
  }

  if (options.pinnedComposer) {
    // 钉死在底部：插兄弟节点也不会让它动（真实界面里这就是 position: fixed）
    box.rect = rect(690, 110);
    inner.rect = rect(690, 110);
    input.rect = rect(730, 40);
    toolbar.rect = rect(770, 30);
  }

  const doc = {
    body,
    documentElement: body,
    getElementById: (id: string) => findByClass(body, (el) => el.id === id),
    querySelectorAll: () => collectDescendants(body),
    createElement: () => new FakeEl(),
  };
  if (options.flexOrder) {
    messages.order = 1;
    box.order = 2;
    layout();
  }

  const win: {
    innerHeight: number;
    getComputedStyle?: (el: FakeEl) => { order: string };
  } = { innerHeight: VIEWPORT_H };
  if (!options.noComputedStyle) {
    win.getComputedStyle = (el: FakeEl) => ({ order: String(el.cssOrder) });
  }

  return { doc, win, body, messages, input, box, inner, layout };
}

describe('measureComposerSlot', () => {
  it('在输入框那一整块**上面**插空位，并把坐标报回来', () => {
    const scene = makeScene();
    const slot = measureComposerSlot(scene.doc as never, scene.win as never, 56);

    // 输入框那一整块贴着底边（690..800），空位就落在它上面（634..690）
    expect(slot).toMatchObject({ top: 634, height: 56, mode: 'slot' });
    // 日志里带上「认到的到底是谁」：位置不对时一条日志就够定位
    expect(slot?.anchor).toContain('@690-800');
    // 插在「输入框那一整块」前面，而不是塞进输入框和工具栏之间
    const inserted = findByClass(scene.body, (el) => el.id === COMPOSER_SLOT_ID);
    expect(inserted?.parent).toBe(scene.body);
    // 空位是让上面的消息区缩掉、输入框继续贴着底边 —— 不是把输入框顶出视口
    expect(scene.box.getBoundingClientRect().bottom).toBe(800);
    expect(scene.input.getBoundingClientRect().bottom).toBe(770);
  });

  it('输入框被钉死在底部（position:fixed）→ 不插空位，改成「紧贴它上方」覆盖', () => {
    const scene = makeScene({ pinnedComposer: true });
    const slot = measureComposerSlot(scene.doc as never, scene.win as never, 56);

    // 钉死的输入框不占流里的位置：空位会**正好落在它身上**（挡住用户打字的地方），
    // 所以必须撤掉 —— 位置改成「输入框那一块的上沿之上」直接算出来。
    expect(slot).toMatchObject({ top: 634, height: 56, mode: 'overlay' });
    expect(findByClass(scene.body, (el) => el.id === COMPOSER_SLOT_ID)).toBeNull();
  });

  it('输入框那一块钉在底部、高度由内容决定 → 塞进它**里面**最前面，它自己往上长', () => {
    const scene = makeScene({ pinnedComposer: true, autoComposer: true });
    const slot = measureComposerSlot(scene.doc as never, scene.win as never, 56);

    // 外面插兄弟节点它不动（钉死的），但往它自己里面插一行它会长高 ——
    // 长出来的那块正好放我们的栏，转录区和输入框都不被挡
    expect(slot).toMatchObject({ top: 634, height: 56, mode: 'inside' });
    const inserted = findByClass(scene.body, (el) => el.id === COMPOSER_SLOT_ID);
    expect(inserted?.parent).toBe(scene.box);
    // 输入框那一块确实往上长了：底边没动，上沿从 690 变成 634
    expect(scene.box.getBoundingClientRect().bottom).toBe(800);
    expect(scene.box.getBoundingClientRect().top).toBe(634);
  });

  it('界面用 flex `order` 排输入框 → 抄一份 order，空位照样贴着它', () => {
    const scene = makeScene({ flexOrder: true });
    const slot = measureComposerSlot(scene.doc as never, scene.win as never, 56);

    expect(slot).toMatchObject({ top: 634, height: 56 });
    // 抄了 order 才贴得上：不抄的话空位默认 order:0，会被排到消息区**前面**去
    expect(findByClass(scene.body, (el) => el.id === COMPOSER_SLOT_ID)).not.toBeNull();
  });

  it('抄不到 order（读不到 computed style）→ 空位撤掉，位置靠算，绝不飘到面板顶上', () => {
    /* 这是真实事故：空位被 order 排到消息区前面，栏就跑到面板顶部去了。撤掉空位之后
       至少要落在「输入框上方」—— 位置是从输入框那一块的坐标算出来的。 */
    const scene = makeScene({ flexOrder: true, noComputedStyle: true });
    const slot = measureComposerSlot(scene.doc as never, scene.win as never, 56);

    expect(slot).toMatchObject({ top: 634, height: 56, mode: 'overlay' });
    expect(findByClass(scene.body, (el) => el.id === COMPOSER_SLOT_ID)).toBeNull();
  });

  it('页面上没有可编辑元素 → 拒绝', () => {
    const scene = makeScene();
    scene.input.isContentEditable = false;
    scene.input.tagName = 'DIV';
    expect(measureComposerSlot(scene.doc as never, scene.win as never, 56)).toBeNull();
  });

  it('输入框藏在 shadow root 里也能找到（VS Code 风格的界面就是这样）', () => {
    const scene = makeScene({ shadowComposer: true });
    const slot = measureComposerSlot(scene.doc as never, scene.win as never, 56);
    expect(slot).toMatchObject({ top: 634, height: 56, mode: 'slot' });
  });

  it('只有转录区里那种可编辑块（离底部很远）→ 拒绝，绝不拿它当锚点', () => {
    /* 上一版的真实事故：Claude 的输入框在 shadow root 里没被认出来，转录区里一个
       可编辑块被当成锚点，栏就飘在对话中间了。锚点必须贴着视口底部那一带。 */
    const scene = makeScene();
    scene.input.isContentEditable = false;
    scene.input.tagName = 'DIV';

    const editable = new FakeEl();
    editable.tagName = 'TEXTAREA';
    editable.isContentEditable = true;
    editable.fixedHeight = 40;
    scene.messages.column = true;
    const filler = new FakeEl();
    scene.messages.children = [editable, filler];
    editable.parent = scene.messages;
    filler.parent = scene.messages;
    scene.layout();

    expect(editable.getBoundingClientRect().bottom).toBeLessThan(200);
    expect(measureComposerSlot(scene.doc as never, scene.win as never, 56)).toBeNull();
    expect(findByClass(scene.body, (el) => el.id === COMPOSER_SLOT_ID)).toBeNull();
  });

  it('高度为 0 / 非法 → 拒绝（宁可不出这一栏，也不要插一块 0 高度的空位）', () => {
    const scene = makeScene();
    expect(measureComposerSlot(scene.doc as never, scene.win as never, 0)).toBeNull();
    expect(measureComposerSlot(scene.doc as never, scene.win as never, Number.NaN)).toBeNull();
  });

  it('量第二次会先把上一次那块收掉（不然页面上会越积越多空位）', () => {
    const scene = makeScene();
    measureComposerSlot(scene.doc as never, scene.win as never, 56);
    measureComposerSlot(scene.doc as never, scene.win as never, 56);

    let count = 0;
    const walk = (el: FakeEl) => {
      if (el.id === COMPOSER_SLOT_ID) count++;
      el.children.forEach(walk);
    };
    walk(scene.body);
    expect(count).toBe(1);
  });

  it('空位高度跟着我们的栏走（栏变高，空位跟着变高）', () => {
    const scene = makeScene();
    const first = measureComposerSlot(scene.doc as never, scene.win as never, 56);
    const second = measureComposerSlot(scene.doc as never, scene.win as never, 96);
    expect(first?.height).toBe(56);
    expect(second?.height).toBe(96);
    // 更高的空位 ⇒ 上沿更靠上
    expect(second!.top).toBeLessThan(first!.top);
  });
});

describe('注入访客页面的脚本', () => {
  it('把 id 和高度都带进去（两处常量必须一致）', () => {
    const script = buildMeasureScript(56);
    expect(script).toContain(COMPOSER_SLOT_ID);
    expect(script).toContain('56');
    // 自包含：不能引用模块里的任何东西，否则在访客页面里直接 ReferenceError
    expect(script).not.toContain('COMPOSER_SLOT_ID');
  });

  it('清理脚本用的也是同一个 id', () => {
    expect(buildClearSlotScript()).toContain(COMPOSER_SLOT_ID);
  });

  it('高度是小数时取整（px 用不着小数）', () => {
    expect(buildMeasureScript(56.7)).toContain('57');
  });
});

describe('measureSlotInWebview', () => {
  const fakeWebview = (result: unknown | Error) => ({
    executeJavaScript: () =>
      result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
  });

  it('拿到合法结果就用它', async () => {
    const slot = await measureSlotInWebview(fakeWebview({ top: 12, height: 56 }), 56);
    expect(slot).toEqual({ top: 12, height: 56 });
  });

  it('结果不合法 / 页面还没就绪（抛错）→ 当没有，不抛', async () => {
    expect(await measureSlotInWebview(fakeWebview(null), 56)).toBeNull();
    expect(await measureSlotInWebview(fakeWebview('nope'), 56)).toBeNull();
    expect(await measureSlotInWebview(fakeWebview({ top: 1 }), 56)).toBeNull();
    expect(await measureSlotInWebview(fakeWebview(new Error('not ready')), 56)).toBeNull();
    expect(await measureSlotInWebview(null, 56)).toBeNull();
  });

  it('isGuestComposerSlot 认得出「差一点」的结果', () => {
    expect(isGuestComposerSlot({ top: 0, height: 56 })).toBe(true);
    expect(isGuestComposerSlot({ top: 0, height: 0 })).toBe(false);
    expect(isGuestComposerSlot({ top: Number.NaN, height: 56 })).toBe(false);
    expect(isGuestComposerSlot(undefined)).toBe(false);
  });
});

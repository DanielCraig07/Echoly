# UI 工具栏与按钮交互规范 (Maven 对齐标准)

> **本文件是全仓唯一权威版本。** `AGENTS.md`、`GEMINI.md`、`CLAUDE.md` 里只保留摘要
> 并指回这里 —— 同一条规范抄四份，改的时候必然只改到其中一两份，剩下几份会长期
> 写着旧尺寸而不报错。**新增或修改规范只改本文件。**

本文件是工作区永久规范。在任何涉及侧边栏面板、二级工具栏、操作按钮和交互的设计与开发中，**必须无条件严格遵循 Maven 面板标准**。严禁任何 AI 助手、代码生成器或开发者违背本规范。

---

## 1. 二级面板头部与工具栏容器标准

所有左侧/右侧面板（如 Maven、Git、文件资源管理器 Explorer、全局搜索 Search 等）的二级顶部栏容器必须严格统一：

```tsx
<div
  style={{
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 30, // 严格统一为 30px 高度
    padding: '0 10px', // 左右各 10px 内边距
    boxSizing: 'border-box',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
    userSelect: 'none',
  }}
>
  {/* 标题区 */}
  <div
    style={{
      fontSize: 12,
      fontWeight: 700,
      color: 'var(--text)',
      letterSpacing: '0.05em',
      display: 'flex',
      alignItems: 'center',
      gap: 4,
    }}
  >
    <span className="chevron" style={{ fontSize: 12, color: 'rgba(255, 255, 255, 0.75)' }}>
      ▾
    </span>
    面板名称
  </div>

  {/* 操作按钮区 */}
  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>{/* 按钮列表 */}</div>
</div>
```

---

## 2. 操作按钮标准规范 (`.panel-action-btn`)

### 2.1 基础按钮格式

所有图标操作按钮必须使用系统预设样式类 `.panel-action-btn`：

```tsx
<button
  type="button"
  className="panel-action-btn"
  title="描述清晰的中文功能提示"
  onClick={handleAction}
>
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {/* 图标路径 */}
  </svg>
</button>
```

### 2.2 激活/选中态

当按钮处于激活或选中状态时，追加 `active` 或 `selected` 类：

```tsx
className={`panel-action-btn${isActive ? ' active' : ''}`}
```

### 2.3 严禁内联尺寸覆盖（红线原则）

- **严禁** 在按钮元素上写 `style={{ width: 22, height: 22, minWidth: ... }}` 等内联硬编码尺寸！
- 尺寸（26x26px，min-width: 26px，height: 26px）、内边距（padding: 3px）、圆角（border-radius: 6px）、悬浮动画（`transform: scale(1.05)`、背景提亮）与点击反馈（`transform: scale(0.95)`）全部由 `.panel-action-btn` 统一控制。
- 任何通过内联样式压缩或篡改按钮尺寸的行为均属**严重不合规**。

### 2.4 图标标准

- 统一使用 SVG 矢量图标。
- 推荐尺寸：`width="14" height="14"` 或 `width="16" height="16"`。
- 线条宽度：`strokeWidth="2"`（高清晰度纯色渲染）。
- 颜色：`stroke="currentColor"`，随主题与悬浮状态自动变色。

### 2.5 带文字的小胶囊按钮

若按钮需附带简短状态文字（如“自动”指示器），**不要就地写内联尺寸** —— 用
`panel-action-btn--compact`（[styles.css](../../apps/desktop/src/renderer/src/styles.css)
中定义），它把 26x26 压到 20px 高并留出左右外边距：

```tsx
<button type="button" className="panel-action-btn panel-action-btn--compact" title="自动同步状态">
  {/* 图标 + 文字 */}
</button>
```

需要新的紧凑变体就**往 `.panel-action-btn--compact` 里加**，不要在调用处写
`style={{ height: 24, minWidth: 44, padding: '0 6px' }}`：那种写法每个调用点一份，
调完一个面板另外几个面板尺寸就对不上了，而且不写不错、只看单个文件根本发现不了。

其余纯图标按钮一律严禁添加任何内联 style！

---

## 3. 字号基线（`--ui-font-size`）

全仓的界面字号基线是 `--ui-font-size`（`styles.css` 的 `:root` 块，12px）。
**但 `html` / `body` / `#root` 上并没有声明 `font-size`** —— 浏览器默认的 16px
才是真正的根值。任何一条没写 `font-size` 的规则，都会把这个 16px 一路继承下去。

**这条规范存在的原因**：设置页的 MCP 服务器页曾经整屏字号偏大、字段名和输入框叠在
一起。根因不是「谁写错了一个 16px」，而是 `.settings-modal` → `.settings-layout` →
`.settings-content` → `.settings-panel-section` → `.panel-title-bar` 这一整条链
**一级都没写 `font-size`**，正文安静地继承了 16px；而 `.settings-modal button`
（0,1,1）又单独把按钮压回 12px —— 同一屏里两种字号并存，看起来就像布局坏了。
这类 bug 不会报错、不会告警，只在有人盯着屏幕看的时候才存在。

规则：

- **新增面板容器时必须显式声明 `font-size: var(--ui-font-size, 12px)`**，
  不要指望继承 —— 继承链上少写一级，症状就出现在使用者那一屏，而不是你改的那一行。
- 基线写在**最窄的那个容器**上。设置页写在 `.settings-content` 而不是
  `.settings-modal`：后者被 `SwitchWorkspaceModal` / `UnsavedChangesModal` 共用，
  写在外层会把那两个弹窗的字号一起改掉。
- **按钮的 `font-size` 要带 `.settings-modal ` 之类的前缀**。`.settings-modal button`
  的权重是 (0,1,1)，单个类名 (0,1,0) 压不过它 —— 不前缀的 padding / font-size
  会被静默覆盖。
- 行高一并给（`line-height` 同样默认继承），否则 12px 的字配上 16px 行高，
  行距看着是散的。

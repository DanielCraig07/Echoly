# UI 工具栏与按钮交互规范 (Maven 对齐标准)

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
  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
    {/* 按钮列表 */}
  </div>
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
若按钮需附带简短状态文字（如“自动”指示器）：
```tsx
<button
  type="button"
  className={`panel-action-btn active`}
  style={{
    height: 24,
    minWidth: 44,
    padding: '0 6px',
    fontSize: 11,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
  }}
  title="自动同步状态"
  onClick={handleToggle}
>
  {/* 图标 + 文字 */}
</button>
```
其余纯图标按钮一律严禁添加任何内联 style！

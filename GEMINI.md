# GEMINI.md

This file defines behavioral constraints and workspace directives for Gemini / Antigravity agents.

## 核心持久化开发指令

### 1. UI 按钮与二级工具栏严格对齐 Maven 规范
在任何面板（Git、Explorer、Maven、Search 等）生成或修改二级工具栏按钮时：
- 容器高度：严格 `30px`，`padding: '0 10px'`，`boxSizing: 'border-box'`。
- 按钮外层：`display: 'flex'`, `alignItems: 'center'`, `gap: 4`。
- 按钮元素：必须使用 `<button type="button" className="panel-action-btn" title="...">`。
- **红线禁止项**：绝不允许在按钮上添加 `style={{ width: 22, height: 22, ... }}` 等内联尺寸缩放！全部由 `.panel-action-btn` 统一样式处理。
- 图标：标准 SVG，`strokeWidth="2"`，`stroke="currentColor"`，清晰居中，严禁畸变。
- 详细规范见：`.agents/rules/ui-guidelines.md`。

### 2. 终端系统环境集成
- 本地终端与执行环境必须包含 macOS Homebrew 路径（`/opt/homebrew/bin` 等）及系统 PATH，保证 `brew` 等工具正常执行。
- 启动终端时必须传入 `-l` 登录 Shell 参数。

### 3. Git 分支切换修改状态留存
- 切换 Git 分支必须记录并留存改动，并在分支切回时自动恢复。
- 分支切换后立即同步刷新打开的编辑器标签、文件树及状态栏。

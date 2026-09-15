# AGENTS.md

This file provides system instructions and workspace guidelines for all AI agents working in this repository.

## 1. 语言规范 (Language)
此项目文档、注释及提交信息默认使用中文。所有终端命令、API 调用等按原文保留。

## 2. 核心架构与 UI 设计规范（永久强制）

### 2.1 工具栏与按钮交互对齐 Maven 规范 (MANDATORY)
**所有二级工具栏与面板按钮必须无条件对齐 Maven 面板规范，任何时候不要让用户提醒：**

1. **面板二级顶部栏容器**：
   - 高度严格等于 `30px` (`height: 30`, `boxSizing: 'border-box'`)。
   - 内边距：`padding: '0 10px'`。
   - 布局：`display: 'flex'`, `alignItems: 'center'`, `justifyContent: 'space-between'`, `borderBottom: '1px solid var(--border)'`, `flexShrink: 0`。
   - 标题：`fontSize: 12`, `fontWeight: 700`, `letterSpacing: '0.05em'`, 折叠三角 `▾` (`fontSize: 12`)。
   - 按钮容器：`display: 'flex'`, `alignItems: 'center'`, `gap: 4`。

2. **操作按钮规范 (`.panel-action-btn`)**：
   - 必须使用 `<button type="button" className="panel-action-btn" title="...">`。
   - **绝对禁止内联硬编码尺寸**：严禁在按钮上编写 `style={{ width: 22, height: 22, minWidth: ... }}` 等内联样式！尺寸统一由 `.panel-action-btn` 提供（26x26px，内边距 3px，圆角 6px，自带 hover 放大与 active 点击反馈）。
   - 图标：标准 SVG 矢量，`width="14"` 或 `"16"`，`strokeWidth="2"`，`stroke="currentColor"`，清晰居中。
   - 提示：所有按钮必须包含明确的中文 `title` 属性。

## 3. 本地环境与系统集成
- 本地终端与子进程环境必须继承系统全量环境（特别是 macOS 上的 `/opt/homebrew/bin`、`/opt/homebrew/sbin`、`/usr/local/bin` 等路径），确保 `brew`、`git`、`mvn` 等系统工具随时可用。
- 启动终端 Shell 时默认使用登录 Shell 标志（`-l`）。

## 4. Git 状态与分支切换
- 同一项目切换 Git 分支时，必须保持修改状态安全留存，切回分支时自动恢复。
- 分支切换后立即重新载入编辑器干净文件，自增 `treeRefreshKey` 刷新文件树，并同步更新全局 Git 状态与各面板。

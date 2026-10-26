# AGENTS.md

This file provides system instructions and workspace guidelines for all AI agents working in this repository.

## 1. 语言规范 (Language)

此项目文档、注释及提交信息默认使用中文。所有终端命令、API 调用等按原文保留。

## 2. 核心架构与 UI 设计规范（永久强制）

### 2.1 工具栏与按钮交互对齐 Maven 规范 (MANDATORY)

**权威定义在 [`.agents/rules/ui-guidelines.md`](.agents/rules/ui-guidelines.md)，改动规范只改那一份。**
本处只留摘要，方便开工前扫一眼：

1. **面板二级顶部栏容器**：`height: 30`、`padding: '0 10px'`、`boxSizing: 'border-box'`、
   `display: 'flex'`、`alignItems: 'center'`、`justifyContent: 'space-between'`、
   `borderBottom: '1px solid var(--border)'`、`flexShrink: 0`。
   标题 `fontSize: 12` / `fontWeight: 700` / `letterSpacing: '0.05em'`，折叠三角 `▾`；
   按钮容器 `display: 'flex'`, `alignItems: 'center'`, `gap: 4`。
2. **操作按钮**：必须 `<button type="button" className="panel-action-btn" title="...">`。
   **绝对禁止内联硬编码尺寸**（`style={{ width: 22, height: 22, … }}`）—— 26x26px、
   `padding: 3px`、`border-radius: 6px`、hover `scale(1.05)`、active `scale(0.95)`
   全部由该类提供。需要紧凑变体用 `panel-action-btn--compact`，不要就地写尺寸。
3. **图标**：SVG，`width`/`height` 14 或 16，`strokeWidth="2"`，`stroke="currentColor"`。
4. **字号基线**：`html`/`body`/`#root` 上**没有** `font-size`，真正的根值是浏览器默认
   16px。新增面板容器必须显式写 `font-size: var(--ui-font-size, 12px)`，别指望继承 ——
   设置页 MCP 页整屏字号偏大就是继承链上少写了这一级。
5. **提示**：所有按钮必须带明确的中文 `title`。

## 3. 本地环境与系统集成

- 本地终端与子进程环境必须继承系统全量环境（特别是 macOS 上的 `/opt/homebrew/bin`、`/opt/homebrew/sbin`、`/usr/local/bin` 等路径），确保 `brew`、`git`、`mvn` 等系统工具随时可用。
- 启动终端 Shell 时默认使用登录 Shell 标志（`-l`）。

## 4. Git 状态与分支切换

- 同一项目切换 Git 分支时，必须保持修改状态安全留存，切回分支时自动恢复。
- 分支切换后立即重新载入编辑器干净文件，自增 `treeRefreshKey` 刷新文件树，并同步更新全局 Git 状态与各面板。

# Echoly 对齐 Cursor：实施清单

> 本清单跟踪本轮「能力补齐 + UI 对齐」的全部工作项。
> 约定：每一项完成前必须通过 `npm run typecheck && npm test && npm run format:check`，
> 涉及 UI 的改动还要跑 `npm run dev` 截图回归。

## 0. 前置结论（已确认）

- **内网网关没有 embedding 通道。** `GET /v1/models` 返回 200，但清单只有 5 个对话/多模态模型；
  `POST /v1/embeddings` 对 `text-embedding-3-small`、`bge-m3`、`bge-large-zh-v1.5`、
  `text-embedding-ada-002`、`embedding-2` 一律返回 503 `No available channel`。
  → 语义索引改走**本地 embedding 模型**（`@huggingface/transformers` + `bge-small-zh-v1.5` 量化版），
  首次使用下载并缓存到 userData，完全不出网；BM25 保留为硬降级。
- **联网出口**：允许直连，无需代理。
- **内网访问策略（已定）**：默认拦截私有网段，走白名单放行 —— 设置页维护「允许的内网主机」
  清单，命中才放行。`.local` / `.internal` / `.lan` / 单标签主机名等内网约定也一并按私有处理。
- **字号**：允许从 12px 调整到 13px（需先做样式审计）。

## A. 纯本地可完成

### A1 工程门面

- [x] 新增 `LICENSE`（MIT 全文）
- [x] 根 `package.json` 补 `"license": "MIT"`
- [x] `.github/ISSUE_TEMPLATE/`（bug / feature）

### A2 Agent 联网与文档工具

- [x] `packages/tools/src/web.ts`：URL 安全校验（SSRF 防护）+ HTML→Markdown + 按字节安全截断（+26 单测）
- [x] `apps/desktop/src/main/webService.ts`：手动跟随重定向（每跳重新校验）+ 超时 + 边读边卡上限 + JSON/HTML 分流（+7 单测）
- [x] `packages/tools`：新增 `web_search`、`fetch_url` 工具定义与执行分支，并入 `READONLY_TOOL_NAMES`
- [x] DuckDuckGo HTML 结果解析器（纯逻辑 + 5 单测）；`webService.searchWeb` 走 `rawBody` 抓原始 HTML
- [x] 在 `packages/agent/src/index.ts` 注入 `ctx.web`（`AgentRunOptions.web` → `toolCtx.web`）
- [x] `AppSettings.webEnabled` / `webAllowedHosts` + 默认值；`agentService` 用 `createWebToolHost` 组装
- [x] 设置页 UI：联网总开关 + 「允许的内网主机」多行输入（常规分区）
- [ ] 设置页联网总开关（默认关，会话内可临时开启）
- [ ] `specialMentions.ts` 支持 `@Web`
- [ ] `@Docs` 文档源管理（设置页维护站点 + 本地索引 + `search_docs` / `read_doc`）

### A3 多文件规则系统

- [x] `packages/tools/src/rules.ts`：规则文件解析（frontmatter 的 description / globs / alwaysApply）+ 三档分流纯逻辑（+13 单测）
- [x] `main/directoryRules.ts`：扫描 `.echoly/rules/*.md`（兼容 `.cursor/rules`），从工作区根逐级向下收集，子目录规则排后即高优先级
- [x] `collectDirectoryRules` 单测：层级顺序、兄弟目录隔离、越界路径、非规则文件过滤、空正文跳过（+8 单测）
- [x] 接进 Agent 的 `rulesText` 组装：以所有已打开文件为上下文收集 + 按路径去重
- [ ] 把三档分流结果接进 Agent 的 prompt 组装
- [ ] 三档注入：常驻 / 按当前文件 glob 命中 / 按 Agent 检索命中
- [ ] 从工作区根逐级向下收集，子目录优先
- [ ] `.echolyrules`、`.cursorrules` 保留为 alwaysApply 兼容
- [x] IPC `rules:list-directory` + preload `rulesListDirectory` + `IpcApi` 类型（返回来源与作用域）
- [x] `ProjectMemoryModal` 消费 `rulesListDirectory` 渲染「当前生效规则」视图（可折叠，只读）
- [ ] 单测：globs 匹配、嵌套优先级、缓存失效

### A4 Review 面板

- [x] `components/ReviewPanel.tsx`：按文件分组的审阅面板（整组/逐条接受拒绝、串行写盘、Esc 关闭、复用 useModalResize）
- [x] 接进 `App.tsx`：绑定 accept/reject，`Cmd/Ctrl+Shift+R` 打开（无改动时不拦截按键）
- [ ] 补逐 hunk 的 diff 预览（嵌 Monaco diff 视图 + 大文件性能）
- [x] `services/reviewGrouping.ts`：按文件聚合一轮改动（同文件多条合并、大小写/斜杠归一、首现次序）+8 单测
- [ ] 与 Agent 会话绑定，每轮结束生成一个 review 批次
- [ ] 键盘流：`Cmd+Shift+R` 打开、`J/K` 切文件、`Cmd+Enter` 全接受

### A5 UI 对齐

- [x] 状态栏左侧 `.status-remote` 实心蓝块 → 透明底，仅远程会话上强调色
- [x] 状态栏「字数」→「字符」（`docStats.charCount` 语义对齐）
- [x] 状态栏间距规范化：11.5px 半像素字号统一为 12px、组内 gap 收紧到 2px、条目内边距 6→7px、左右组各留 4/6px 外边距
- [x] 输入区提示条常驻（`@` / `/` 指引从 placeholder 抽离，随 Ask/Plan/Agent 变化）
- [x] 模型胶囊截断修复（宽度自适应）
- [x] 活动栏语义：在「文件/搜索/Git」与「Maven/数据库」之间加分隔线区分两组

  **做法调整**：原计划是把 Maven / 数据库挪出一级导航。查证后发现这一排
  （`App.tsx` 左侧面板头部）**就是这两个面板唯一的入口**（全仓 `setLeftPanel('maven'|'database')`
  只出现在这里），挪走等于让人找不到面板。改为加分隔线把「跨项目基础导航」与
  「领域面板」在视觉上分组，语义问题解决而不损失可达性。

- [x] `services/navigationHistory.ts`：浏览器式导航栈（中途跳转截断分支、重复跳转不堆记录、上限 50）+7 单测
- [x] 标题栏前进/后退按钮 + 接上导航栈（监听 activePath 而非在 openFile 埋点）
- [x] 底部面板：去掉 `TerminalPanel` 工具栏里重复的「终端」图标+文字（上一行已标注面板名）
- [ ] 底部面板两行 tab 真正合并为一行（方案 A，已选）

  **结构定位**：第一行在 `App.tsx:5480-5560`（`.bottom-panel-tab`，三个面板类型共用外壳）；
  第二行在 `TerminalPanel.tsx:2496+`（`.terminal-toolbar`，35px，类型胶囊 + 会话标签）。

  **推荐实现（不改组件所有权，用 portal 让标签"显示在"第一行）**：
  1. [x] `TerminalPanel` 用 `TabStripPortal` 包裹 `.terminal-tabs`：存在
         `#bottom-panel-tab-slot` 则 `createPortal` 渲染进去，否则原地渲染（回退，行为不变）
  2. [x] `App.tsx` 面板类型按钮容器末尾放 `<div id="bottom-panel-tab-slot" style={{display:'contents'}} />`
  3. [ ] **待做**：第二行（`.terminal-toolbar`）现在只剩类型胶囊 + 分隔线，仍是 35px 的整行，看起来偏空 —— 需压到 22px 并与第一行合并视觉边界

  比"提升 state 到 App.tsx"风险低：会话标签的所有权仍在 `TerminalPanel`，
  App 只提供一个容器，两者之间没有新的状态耦合。步骤 1 单独上线时行为不变（无 slot 即回退），
  可以分两次提交、每次都可回滚。

  **验收要点（需要人工跑 `npm run dev`）**：新建终端、关闭终端、左右分屏、SSH 会话切换、
  以及切到「调试控制台」「问题」面板时槽位是否正确释放。

- [x] **样式审计已完成，结论推翻了原计划（见下）**

  **审计结果：字号根本没有中心化，「把 12px 改成 13px」这个前提是错的。**

  | 位置                                  | 数量               | 说明                                                                                                |
  | ------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------- |
  | `styles.css` 硬编码 `font-size: Npx`  | ~700 处，14 种取值 | 11px(184)、12px(158)、**11.5px(93)**、10px(68)、13px(64)、**12.5px(31)**、**10.5px(25)**、14px(19)… |
  | `styles.css` 用 `var(--ui-font-size)` | **仅 19 处**       | 占 ~2.7%                                                                                            |
  | 组件内联 `fontSize:`                  | ~1000 处，8 种取值 | 11(393)、12(295)、10(143)、13(88)…                                                                  |

  改 `--ui-font-size: 12px → 13px` 只会影响那 19 处，**几乎什么都看不见**。

- [ ] 【重新定义】字号体系统一：不是改一个 token，而是收敛 ~1700 处声明
  - [x] 第一步：**159 处半像素值**（9.5 / 10.5 / 11.5 / 12.5 / 13.5 / 14.5px）归整到相邻整数档
        —— 半像素在不同缩放比下会被各自取整，同一界面出现大小不一的同类文字，
        外接屏与内建屏并排时尤其明显。取整规则统一向上（10.5→11、11.5→12…），保持可读性
  - [x] 第二步：`styles.css` 里 **262 处**面板级字号收敛到 `var(--ui-font-size, 12px)`，
        硬编码 `font-size: 12px` 归零；随后把 token 由 12px 翻到 **13px**
  - [x] 第三步：组件内联 `fontSize` 迁移 **256 处**改为 `var(--ui-font-size, 12px)`
        —— 用「批量替换 + typecheck 判定 + 回退报错文件」的方式收敛：
        正则无法区分「内联样式对象」与「数字型 props」，但 typecheck 可以。
        4 个文件因此被回退（`BranchDiffModal` / `TerminalPanel` /
        `ThreeWayMergeModal` / `chat/TurnRevertModal`），其中混着样式与属性两种用法，
        留待逐个判断后再迁移。

### A6 Vim 模式

- [ ] 键位预增设 `vim` 档，接入 `monaco-vim`（先做常用操作）

## B. 有外部依赖

### B1 语义索引（改走本地模型）

- [ ] 扩展 `packages/llm/src/probe.ts`：探测 OpenAI 兼容 embedding 端点（保留，供未来网关开放时启用）
- [ ] `@huggingface/transformers` + `bge-small-zh-v1.5`（q8）本地推理，模型缓存与下载进度
- [ ] 向量粗排 topK 50 → BM25 精排 → RRF 融合
- [ ] chunk 内容 hash 缓存 + 文件级 mtime/size 增量
- [ ] 模型不可用时完全回落 BM25（绝不静默返回全 0 向量）

### B2 补全能力

- [ ] 先埋点：补全请求数 / 接受率 / 平均延迟
- [ ] 结构化输出（只回插值区间）
- [ ] fill-in-the-middle 后缀上下文 + 最近三次编辑 diff
- [ ] 多行建议 + 逐行接受
- [ ] 请求合并 / 缓存 / 取消传播
- [ ] next-edit prediction（最高成本，放最后）

### 隐私模式

- [ ] 设置页开关 + 数据流向声明（仓库内暂无 telemetry 代码，成本低）

## C. 需独立立项

- [ ] 扩展市场（Open VSX 或自建）
- [ ] 多根工作区（`workspace.ts` 为单根假设，改动面覆盖文件树/Git/终端/索引/SSH）
- [ ] 云端后台 Agent
- [ ] `.ipynb` 笔记本编辑

## 执行顺序

1. **第一轮**：A1 → A5（除字号）→ A3
2. **第二轮**：A2 → A4 → A5 字号审计 → 隐私模式
3. **第三轮**：B1（本地 embedding）→ B2 埋点
4. **单独排期**：Cursor Tab 深度优化、扩展市场、多根工作区、笔记本

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
- [ ] 状态栏左右分组与间距规范化
- [x] 输入区提示条常驻（`@` / `/` 指引从 placeholder 抽离，随 Ask/Plan/Agent 变化）
- [x] 模型胶囊截断修复（宽度自适应）
- [ ] 活动栏语义：Maven / 数据库图标移出一级横排
- [ ] 标题栏补前进 / 后退
- [ ] 底部面板两行 tab 收敛为一行
- [ ] 样式审计（面板类名 + 存量硬编码尺寸）→ 全量 12px → 13px

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

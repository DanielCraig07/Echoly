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
- [x] 设置页联网总开关（**实际按默认开做的**：`webEnabled` 默认 `true`，设置页可关）
  - 原计划写的是「默认关 + 会话内临时开启」，实现时选了默认开：Agent 联网是用户
    主动提问才会触发的能力，默认关会让「查一下这个库怎么用」直接失败，
    而用户并不知道有个开关要先去打开。改成默认开 + 显式关 + 内网白名单，
    并另加「隐私模式」一键切断所有额外出网（见下）。
- [x] `specialMentions.ts` 支持 `@Web`（+14 单测）
  - **不预抓搜索结果**：`web_search` 已是带 SSRF 防护、逐跳校验重定向、边读边卡字节上限的工具，
    在渲染层另开一条取数路径等于把那套防护重做一遍，漏掉任何一条都很难发现。
    所以 `@Web` 只把意图讲清楚，由 Agent 去调 `web_search`。
  - 联网关闭（联网开关关掉 / 隐私模式打开）时在正文里**明确说明不可用**，
    否则模型会去调一个不可用的工具，用户只看到一句含糊的失败。
  - 检索词 = 摘掉已知的 `@Git/@Terminal/@Problems/@Web` 之后的剩余文本；
    不误伤 `@types/node`、邮箱、装饰器。
  - 纯文本逻辑拆到 `services/webMention.ts`：`specialMentions.ts` 顶层 import 了 monaco，
    在 node 测试环境里 import 不进来，拆开后这几条判断才能被直接测。
- [x] `@Docs` 文档源管理（设置页维护站点 + 本地索引 + `search_docs` / `read_doc`）（+58 单测）
  - **索引来源用 `llms.txt`，不自己爬站**：爬站要处理 sitemap、分页、动态渲染、robots、限流，
    每一条都能让索引半死不活；而 `llms.txt` 是文档站主动提供的结构化清单，
    一个文件就把「有哪些页、分别讲什么」说清。没有这个文件的站点明确报不可用 ——
    爬出一份七零八落的索引，「索引里有但搜不到」比没有更让人困惑。
  - 分三层：`tools/docs.ts` 纯逻辑（解析 + 中文滑窗切词 + 字段加权打分，0 分条目丢弃）；
    `main/docsService.ts`（取数 + 落盘缓存 + 跨来源合并检索 + 读全文）；
    `main/docsToolHost.ts`（装成 `ctx.docs`，把授权边界钉死）。
  - 取数一律复用 `fetchWebPage`：SSRF 防护、逐跳重定向校验、字节上限都在那一层，
    自己再写一遍而漏一条是不会有任何报错的。
  - **`read_doc` 只放行已配置来源的同源地址**：它收的是模型给的任意字符串，
    不设边界就是一个没有名字的万能抓取器，用户「只登记了几个文档站」的授权形同虚设。
  - 缓存取不到时**退回过期缓存**：文档站偶尔抽风（限流、证书轮换、临时 5xx）很常见，
    「昨天那份清单」绝大多数情况下仍然有用。
  - 设置页「一行一条 `名称|地址`」（沿用内网白名单的多行文本模式）+「检查」按钮
    （保存后检查，避免「明明填了却说没配」）。
  - `@Docs` 提及：把可用来源讲清楚，避免「用户 @Docs 了但 Agent 不知道有文档源，跑去 web_search 乱搜」。

### A3 多文件规则系统

- [x] `packages/tools/src/rules.ts`：规则文件解析（frontmatter 的 description / globs / alwaysApply）+ 三档分流纯逻辑（+13 单测）
- [x] `main/directoryRules.ts`：扫描 `.echoly/rules/*.md`（兼容 `.cursor/rules`），从工作区根逐级向下收集，子目录规则排后即高优先级
- [x] `collectDirectoryRules` 单测：层级顺序、兄弟目录隔离、越界路径、非规则文件过滤、空正文跳过（+8 单测）
- [x] 接进 Agent 的 `rulesText` 组装：以所有已打开文件为上下文收集 + 按路径去重
- [x] 把三档分流结果接进 Agent 的 prompt 组装（`main/rulesInjection.ts` + 10 单测）
  - 原先收集到多少条就整包塞进 prompt：一个团队仓库几十条规则很常见，白吃一大截上下文，
    且带 `globs` 的规则会作用到与它无关的对话上。
  - 常驻 → 注入全文；`globs` 命中本次涉及文件 → 注入全文；两者都不是 → 只给
    「有什么规则、讲什么、文件在哪」的索引，模型需要时自己 `read_file`。
  - `globs` 明确的规则**不命中就整条不注入** —— 那是「只在这些文件上生效」的意思。
    （放进索引会让索引长到没人看；`selectRulesForContext` 原本就是这个语义，有单测。）
- [x] 从工作区根逐级向下收集，子目录优先（`main/directoryRules.ts`，排序即优先级）
- [x] `.echolyrules`、`.cursorrules` 保留为 alwaysApply 兼容（`main/rulesService.ts` 单独读取并常驻注入）
- [x] IPC `rules:list-directory` + preload `rulesListDirectory` + `IpcApi` 类型（返回来源与作用域）
- [x] `ProjectMemoryModal` 消费 `rulesListDirectory` 渲染「当前生效规则」视图（可折叠，只读）
- [x] 单测：globs 匹配（`rules.test.ts`）、嵌套优先级（`directoryRules.test.ts`）
  - 「缓存失效」无对应实现：规则每次对话都从磁盘读，没有缓存，也就没有失效问题。
    代价是每轮多几次 `readdir`（已用 100 个文件的上限兜住）。

### A4 Review 面板

- [x] `components/ReviewPanel.tsx`：按文件分组的审阅面板（整组/逐条接受拒绝、串行写盘、Esc 关闭、复用 useModalResize）
- [x] 接进 `App.tsx`：绑定 accept/reject，`Cmd/Ctrl+Shift+R` 打开（无改动时不拦截按键）
- [x] 补逐 hunk 的 diff 预览（嵌 Monaco diff 视图 + 大文件性能）
  - 每行一处改动多一个「▸」展开按钮，展开后内嵌只读 Monaco diff 视图；
    让「接受/拒绝」在面板内就能决定，不必去编辑器里翻或者盲信一句说明。
  - **同一时刻只渲染一个 diff 编辑器**：多个同屏时光是模型实例化就让面板明显变卡，
    而用户一次也只看一处。超过 200KB 的改动不内嵌渲染，给一句提示 ——
    在面板里渲染一份巨型 diff 的代价远大于它带来的方便。
- [x] `services/reviewGrouping.ts`：按文件聚合一轮改动（同文件多条合并、大小写/斜杠归一、首现次序）+8 单测
- [x] 与 Agent 会话绑定，每轮结束生成一个 review 批次
  - `PendingDiff.runId` 由 `AgentRunOptions.runId` 带上（主进程生成的同一个 id，
    与检查点回滚共用，两边必须一致）。审阅面板按轮次分批，**最新的排最前**。
  - 标签按位置给（本轮 / 上一轮 / 更早的改动），不显示 runId：一串 UUID 对用户没有意义，
    用户真正要区分的是「刚跑完这轮」和「之前留下的」。
  - 每批带「接受本轮 / 拒绝本轮」：连问三轮之后，能把刚跑完的那轮单独处理。
  - 旧数据没有 runId，归入一个 null 批次。
- [x] 键盘流：`Cmd+Shift+R` 打开、`J/K` 切文件、`Cmd+Enter` 全接受
  - `J/K` 逐文件移动高亮（两端截断不循环 —— 从末尾跳回开头会让人以为还有没看的）；
    面板顶部写明这两个键位，否则没人会去猜。
  - 键盘监听必须在早退之前注册（hook 顺序），而列表在早退之后才算出来，
    所以用 ref 转一手：既不破坏 hook 顺序，也不会读到陈旧闭包。
  - 输入框内不抢 `J/K`，带修饰键时也不抢。

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
- [x] 底部面板两行 tab 真正合并为一行（方案 A，已选）

  **结构定位**：第一行在 `App.tsx:5480-5560`（`.bottom-panel-tab`，三个面板类型共用外壳）；
  第二行在 `TerminalPanel.tsx:2496+`（`.terminal-toolbar`，35px，类型胶囊 + 会话标签）。

  **推荐实现（不改组件所有权，用 portal 让标签"显示在"第一行）**：
  1. [x] `TerminalPanel` 用 `TabStripPortal` 包裹 `.terminal-tabs`：存在
         `#bottom-panel-tab-slot` 则 `createPortal` 渲染进去，否则原地渲染（回退，行为不变）
  2. [x] `App.tsx` 面板类型按钮容器末尾放 `<div id="bottom-panel-tab-slot" style={{display:'contents'}} />`
  3. [x] 第二行 35px → **34px**。曾试 26px，实测 hover 背景被上下切平：`AGENTS.md` 规定面板按钮就是 26x26px，与行高相等时没有余量。34px = 26px 按钮 + 上下各 4px
  4. [x] 修活动栏分隔线间距：分隔线原本带 `margin: 0 4px`，叠在容器已有 4px gap 上变成 8px，比图标间距宽一倍 —— 改为 `margin: 0`

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

- [x] 【重新定义】字号体系统一：不是改一个 token，而是收敛 ~1700 处声明
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
  - [x] 第四步：把那 4 个被回退文件按调用点分类后补迁（`BranchDiffModal` 22 处、
        `ThreeWayMergeModal` 15 处、`TerminalPanel` 1 处）。
        **Monaco / xterm 的 `options` 对象必须保持数字**（`BranchDiffModal:632`、
        `ThreeWayMergeModal:339/393/439/500`、`TerminalPanel:1057`、`TurnRevertModal:578`），
        所以这次不是批量替换，而是先按「最近的 `style={{` / `options={{` 分界」
        把每一处归类，再只改样式对象。`TurnRevertModal` 那唯一一处正好是 options，无需改动。
        顺带修掉 `BranchDiffModal` 里漏掉的 `fontSize: 11.5`（半像素）。

### A6 Vim 模式

- [x] 键位预增设 `vim` 档，接入 `monaco-vim`
  - 用现成实现而不是自己写「常用操作」：vim 键位是一套有状态的小语言
    （操作符 + 动作 + 计数 + 寄存器 + `:` 命令行），自己划边界会一路漂移 ——
    用户按 `daw` 没反应时，他分不清这是「没实现」还是「坏了」。
  - 右下角挂一个模式指示条（normal / insert / visual）。没有它，用户看不出当前在哪个模式，
    而这正是 vim 里最容易出错的地方。样式内联而不是走类名：这块 DOM 由 monaco-vim
    内部替换内容，样式表一旦没加载到（打包裁剪、主题切换）就变成一条看不见的空白。
  - **初始化失败退回普通键位**并打日志：让编辑器完全没反应比没有 vim 糟得多。
  - 预设切换即时生效（用 effect 而不是 `onMount`），关掉时真的卸掉句柄。
  - 与下一步编辑预测的 Esc 冲突用**上下文键**表达互斥（`echolyNextEditVisible && !echolyVimMode`），
    而不是靠注册顺序碰运气：vim 里 Esc 是回 normal，被抢掉会让人以为 vim 坏了。

## B. 有外部依赖

### B1 语义索引（改走本地模型）

- [x] 扩展 `packages/llm/src/probe.ts`：探测 OpenAI 兼容 embedding 端点（+7 单测）
  - 逐个试候选模型名，返回「试过哪些、各自为什么失败 + 向量维度」，
    好区分「网关没开通道」（503）与「模型名不在白名单」；`200` 但响应无向量也判失败。
  - 应用侧暂不使用该端点（见下条：网关实测无 embedding 通道），保留探测是为网关开放后直接切换。
- [x] `packages/tools/src/retrieval.ts`：余弦相似度 + 向量粗排 topK + RRF 融合（+14 单测）
  - 关键约束：**维度不一致时抛错/返回空，绝不静默返回 0**。换模型、下载不完整、缓存残留旧向量
    都会造成维度不匹配；静默返回 0 会让所有块相似度相同、排序退化成文件顺序 ——
    搜索「看起来在工作」但结果全无关，且没有任何报错可查。
- [x] `packages/tools/src/embeddingSource.ts`：模型来源解析（本地目录优先 → 按需下载 → 不可用回落 BM25），
      支持 `ECHOLY_EMBEDDING_MODEL_DIR` / `ECHOLY_EMBEDDING_MODEL_ID` / `ECHOLY_EMBEDDING_DISABLED` 覆盖（+8 单测）
- [x] `@huggingface/transformers` 接入：按上面解析出的来源加载本地模型或按需下载 + 缓存
  - 装配层 `packages/llm/src/localEmbedding.ts`，模型加载通过 `ExtractorFactory` 注入（+7 单测）；
    **惰性**：光 import 不会把 onnxruntime 拖起来，首次搜索才真的加载。
- [x] `packages/llm/src/embedding.ts`：内容指纹缓存 + 批内去重 + 按批送模型 + 维度校验（+11 单测）
- [x] `packages/tools/src/hybridSearch.ts`：双路召回编排（+9 单测）
  - 向量粗排 topK 50 → BM25 精排 → RRF 融合；三条件缺一即回落纯 BM25 并带可读原因
    （无查询向量 / 索引无向量 / 维度不一致）。
- [x] 接入 `CodebaseService`：块级向量随索引落盘（Float32 → base64，约 2.7KB/块），
      重启直接复用不重算；换模型按 `vectorKey` 整批作废旧向量；`codebase_search` 走双路召回（+5 单测）
- [x] 模型不可用时完全回落 BM25（绝不静默返回全 0 向量）；降级原因进 `getStatus().embedding`，
      检索面板显示语义向量计数

> **待用户端到端验证**：沙箱内无法启动 Electron，真实 onnx 推理没跑通端到端。
> 单测覆盖的是「注入假模型 + 真实 `EmbeddingClient` / 融合层」。
> 请在真机上确认一次：打开工作区 → 搜索任意关键词（这会触发后台向量化）→
> 检索面板的「语义向量 N/M 块」应增长到 N=M；然后问一个词面对不上的问题
> （例如代码里叫 `verifySession`，你去搜「在哪里刷新 token」），应当能搜到那一块。
> 若 N 长期为 0，把鼠标悬停在计数上看降级原因（模型未下载 / 加载失败 / 已通过环境变量关闭）。

### B2 补全能力

- [x] 先埋点：补全请求数 / 接受率 / 平均延迟（+18 单测）
  - `services/completionMetrics.ts`：请求数 / 成功 / 空建议 / 失败 / 取消 / 接受数 +
    平均延迟与 P95（延迟只留最近 200 次，否则历史样本会把「刚做完的优化有没有用」淹掉）。
    **接受率的分母是「成功返回建议数」而不是请求数** —— 否则「模型没话可说」会被算成「建议不被采纳」。
  - 接受怎么判定：Monaco 不会告诉我们用户按了 Tab，只能从「光标处真的插入了建议过的文本」反推
    （同一行列 + 插入内容非空白 + 是建议文本的前缀）。见 `inlineCompletion.ts` 的 `watchAcceptance`。
  - **本地统计、不上报**：数字只进 localStorage，不出进程。
  - 界面：状态栏 ✨ Copilot 徽章点开是浮层（开关 + 统计 + 重置）。
  - 顺带修掉一个真 bug：那个 Copilot 徽章以前是**假开关** —— 只改自己的文案与颜色，
    补全提供者照样注册、照样发请求。现在 `completionEnabled.ts` 里的状态在**每次响应前**
    被真正读到，关掉时连 IPC 都不发。
- [x] 结构化输出（只回插值区间）（+20 单测）
  - 提示词要求只回 `{"insertText": "..."}`，并明确「不要重复前后缀已有内容」——
    模型顺手把光标前那半行抄一遍，插入后就变成重复代码，而这类错误在界面上只表现为「补全有点怪」。
  - 解析**逐级降级**：正常 JSON → 从夹杂文字里抠出 JSON（逐字符扫描，字符串里的花括号不参与配对）
    → 回退成裸文本（与改造前行为一致）。结构化不该成为新的失败点。
  - 顺带去掉渲染层重复的围栏裁剪：主进程已经做过，再做一次会在 markdown 里
    补全代码块时把 `\`\`\`` 本身吃掉。
  - 提示词补上当前语言（`language` 此前被透传但丢弃）。
- [x] fill-in-the-middle 后缀上下文 + 最近三次编辑 diff（+15 单测）
  - 后缀上下文原本就有（`<CURSOR>` 前后切片），这一步补的是**最近编辑**：
    只有光标前后切片时，模型不知道我刚刚在改什么。典型坏 case 是
    「刚把 `userId` 改成 `accountId`，现在补全下一行」—— 只看切片，模型很可能又写回 `userId`。
  - `services/recentEdits.ts`：per 模型最多留 3 条 `{inserted, deleted}`。
    **被删的原文得自己保存** —— Monaco 的变更事件只有「范围 + 新文本」，
    所以按模型留一份文本快照，用事件里的偏移量（基准是变更前文档）反查回来。
  - 快照有体积上限（100KB）：超大文件只记插入的那一半，不为一个大文件常年留内存副本。
  - 提示词里用「删除「X」，插入「Y」」的 diff 形式，而不是整段代码：
    整段会把当前切片淹掉，模型要的是「他刚把什么改成了什么」这个动量。
- [x] 多行建议 + 逐行接受（+1 单测）
  - 多行：Monaco 0.52 的 inline completion 本来就能渲染多行幽灵文本，缺的是模型不给多行 ——
    提示词里补上「上下文明确时可给多行」，同时保留「不确定时给最短的合理补全」，
    只写前半句会把模型推向长篇大论。要求多行时保持与前缀一致的缩进。
  - 逐行接受：Monaco 0.52 **已自带** `editor.action.inlineSuggest.acceptNextLine`，
    只是没配默认键位（留给宿主编辑器决定）。绑到 `Alt+Enter`，`when: inlineSuggestionVisible`。
    没有自己实现接受逻辑 —— 那要面对「插入后让剩余建议继续显示」的问题，而这份状态 Monaco 内部本来就有。
  - 没把 Tab 改成逐行：Tab 已是「接受全部」，再按建议行数改变 Tab 语义很难解释、也很难排查。
  - 幽灵文本悬停时会出现 Monaco 自带工具条（含 Accept / Accept Line），鼠标也能操作。
- [x] 请求合并 / 缓存 / 取消传播（+16 单测）
  - `main/completionService.ts`：按内容缓存（LRU，128 条）+ 并发合并 + 取消传播。
    补全的触发条件是「停手 350ms」，而真实编辑里大量动作是退格打回来、光标来回挪、
    撤销重做 —— 上下文一模一样却每次重问模型，这类开销整块省掉。
  - 缓存键只含「光标前后窗口 + 语言」，**不含最近编辑**：最近编辑是意图提示而非答案的决定因素，
    并进键里会让最常见的命中场景（退格再打回来）全部落空。
  - 取消要用 id 寻址：渲染层每次请求带 `requestId`，token 被取消时发 `ai:cancelCompletion`，
    主进程按 id 中止底层 HTTP（`ChatParams.signal`）。被中止的请求创**不进缓存** —— 它是被打断，不是答案。
  - 合并的请求要**所有**调用方都取消才真的中止，否则一个人切走光标会把另一个人正等着的结果一起掐掉。
- [x] next-edit prediction（+21 单测）
  - 与补全的区别：补全在**光标处**往下写；预测要找的是**别处**该跟着改的地方
    （改了参数名没改调用点、加了字段没加映射）。
  - `main/nextEditPrompt.ts`：要求回 `{"edit": {startLine, endLine, newText}}`，用行区间定位而不是字符偏移 ——
    行号是模型最稳的输出形态（字符偏移实测容易差几个字符），行区间也正好够表达这类预测。
  - `services/nextEditPrediction.ts`：停手 1.2s 后探测；**幽灵补全可见时不预测**
    （两个 AI 界面同时抢注意力，用户两个都不看）；接受走 `pushEditOperations` 进撤销栈；
    接受后静默 3s 避免追着人跑；三个键（Alt+] / Alt+[ / Esc）都带 `echolyNextEditVisible` 前提。
  - 解析校验比补全严得多：行号越界、区间倒置、空文本一律判无效 ——
    补全错了是「补得不对」，预测错了是「改到别的行」。
  - **默认关闭**（状态栏 ✨ 浮层里可开）：补全是「停下来才问一次」，预测是「每次改完都可能问一次」，
    请求量级完全不同。默认打开会让每个新用户先背上一份看不见的开销。
  - 沙箱内无法启动 Electron，装饰器与键位的实际观感**未做视觉验证**，见下方待验证清单。

> **B2 待用户端到端验证**（沙箱内起不了 Electron，以下都只过了单测与构建）：
>
> 1. 状态栏 ✨ Copilot 浮层：**点开是浮层，不再是一点就切换**；里面有开关、统计与重置。
>    「暂停补全」后应当真的不再发请求（以前那个按钮是假的，只改文案）。
> 2. 多行补全：写到一个明显的结构处（比如 `if (` 之后）应当能出现多行幽灵文本；
>    悬停幽灵文本会出现 Monaco 自带工具条（Accept / Accept Line）；`Alt+Enter` 接受下一行。
> 3. 浮层里打开「下一步编辑预测」后：改一处代码、停手一秒多，**别处**若出现带左侧竖线的
>    高亮行与斜体提示，即生效；`Alt+]` 接受（Cmd+Z 可一步撤销）、`Esc` 忽略。
> 4. 重复「退格再打回来」应当明显更快 —— 那是内容缓存命中（同一个上下文不会再问模型）。

### 隐私模式

- [x] 设置页开关 + 数据流向声明（+7 单测）
  - 开关必须有真实效果，否则就是第二个「假开关」。开启后：
    Agent 联网工具关闭（本应用里除模型端点外唯一会把内容发给第三方的路径）；
    语义检索不再按需下载模型（新增 `ECHOLY_EMBEDDING_OFFLINE`）。
  - 与「语义检索整体关闭」区分开：隐私模式禁的是**联网取权重**，
    本地已放好的模型照常用。
  - 落地方式走环境变量（`main/privacyMode.ts`），与已有的 `ECHOLY_EMBEDDING_*` 共用真相来源 ——
    两套状态并存迟早会出现「设置页关了、环境变量还开着」的矛盾组合。
    启动时与每次保存设置时各应用一次。
  - 声明写清了「哪些会出去、哪些不会」，而不是只给一个开关：
    **会出去的**是对话消息与被选中的文件/片段，目标是用户自己配置的模型端点
    （这是应用的运行前提，隐私模式不改变它）；**留本机的**是索引与向量、
    补全统计、最近编辑、对话历史；并注明仓库内没有埋点上报代码。

## C. 需独立立项

- [x] 扩展市场（Open VSX）
  - `packages/vscode-shim/src/openVsx.ts`：搜索响应解析 + 地址构造（纯逻辑，+18 单测）。
    选 Open VSX 而不是微软 marketplace：后者的条款只允许 VS Code 及其官方衍生品拉取。
  - 注册表地址可配（`ExtensionManagerOptions.registry`），企业内网可指向自建镜像。
  - 安装复用已有链路：`downloadVsix` → `loadExtensionFromVsix` → `activateExtension`。
    原来只有一个「下载 Claude Code」的入口，下载器抽成通用版本，避免每个扩展各写一份 curl。
  - **安全边界**：扩展 id 会被拼进 `extensionsDir` 下的文件名与目录名，
    含 `../` 的 id 能把解压目标指到目录之外（`unzip -o` 会照做）。
    所以解析阶段就用严格规则校验 id，不合格的条目**整条丢弃**而不是清理后使用。
  - 搜索失败只在搜索区显示原因，不设全局错误：注册表连不上不该让本地 VSIX
    安装、已装扩展这些入口看起来也坏了。
- [ ] 多根工作区（`workspace.ts` 为单根假设，改动面覆盖文件树/Git/终端/索引/SSH）
- [ ] 云端后台 Agent
- [x] `.ipynb` 笔记本编辑（+16 单测）
  - `services/notebook.ts`：解析与序列化，目标只有一条 —— **往返保真**。
    做法是「只认自己需要的字段，其余原样留在一个 extra 袋子里带回去」，
    而不是按已知字段重建：后者每遇到一个新字段就丢一次数据。
    单元里的 `id`、`outputs`、`execution_count`、`metadata`、笔记本级的扩展字段，
    以及 `source` 是字符串还是数组，全都原样保留。
  - **不执行代码**：执行笔记本需要内核（ipykernel / Jupyter 协议）。
    假装能跑（比如把代码塞进终端）会让执行计数、输出、状态都处于半真半假的状态，
    比明确不支持更糟。输出按打开时的原样只读展示（编辑源码不会让它消失 ——
    我们没有重算它的能力，删掉才是真的丢数据）。
  - **解析失败退回纯文本编辑**：半截的、被别的工具写坏的、扩展名对但没有 cells 的文件
    都真实存在，至少要能打开、能修。空文件也走这条路 —— 新建 .ipynb 时直接给 JSON 更合适。
  - 编辑结果当作普通文本交回上层保存：保存、脏标记、撤销、Agent 写文件这些链路全都不用动；
    同时按既有惯例清空 `editorRef`（主 `<Editor>` 已被换成单元视图，避免后续入口
    拿已销毁实例把内容写回上一个标签）。

## 执行顺序

1. **第一轮**：A1 → A5（除字号）→ A3
2. **第二轮**：A2 → A4 → A5 字号审计 → 隐私模式
3. **第三轮**：B1（本地 embedding）→ B2 埋点
4. **单独排期**：Cursor Tab 深度优化、扩展市场、多根工作区、笔记本

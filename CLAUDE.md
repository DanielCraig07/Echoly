# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Language**: 此项目文档、注释及提交信息默认使用中文。所有终端命令、API 调用等按原文保留。

## Commands

```bash
npm run dev           # Start Electron dev server (electron-vite + React)
npm run build         # Build for production
npm run typecheck     # TypeScript check across all workspaces（含 test/ 目录）
npm test              # vitest run（5 个 project：tools / llm / agent / skills / desktop）
npm run test:coverage # 同上 + v8 覆盖率报告（coverage/）
npm run lint          # ESLint
npm run format        # prettier --write .（format:check 是 CI 门禁）
npm run probe-llm     # Test connectivity to the LLM backend at 192.168.10.241:8002
npm run pack          # Package for Windows (dir target, unsigned)
npm run pack:mac      # Package macOS DMGs (arm64 + x64)
npm run pack:mac:arm64  # Package macOS DMG (Apple Silicon only)
npm run pack:mac:x64    # Package macOS DMG (Intel only)
```

`typecheck` runs per-package — each workspace has its own `tsconfig.json` and `npm run typecheck`. The root script runs `--workspaces --if-present`. 有测试的包还有第二份 `tsconfig.test.json`，把 `test/` 一起纳入检查：**测试里的类型错误也是错误**，只在运行时才暴露的话，一次改名就会留下一批悄悄跑歪的断言。

`npm run probe-llm` 支持用环境变量覆盖默认后端：`LLM_BASE_URL`、`LLM_MODEL`、`LLM_API_KEY`
（见 `packages/llm/src/probe.ts`）。用于临时指向另一台推理服务排查连通性，无需改代码。

## Project overview

内网 AI Agent 轻量 IDE（Electron + Monaco），默认连接 `http://192.168.10.241:8002`（Deepseek-V4 模型），无需公网访问。

**Key fact**: 所有 LLM 请求只走内网地址，不经过公网代理。模型名通过设置页「探测模型」获取，取决于 `/v1/models` 返回的实际 id。

## Project structure

```
apps/desktop/         Electron app (electron-vite)
  src/main/           Main process
    index.ts           - Window creation, app lifecycle (Electron entry)
    ipc.ts             - IPC handler registration (workspace, git, agent, terminal, settings, search)
    agentService.ts    - Agent lifecycle: create/cancel/step/resume, 3 modes (Ask/Plan/Agent)
    workspace.ts       - Workspace open/open-folder/SSH/Git Clone, recent workspaces
    sessions.ts        - Chat session persistence (save/load/list/delete to JSON files)
    gitService.ts      - Git operations via child_process (status/stage/commit/branch/push/pull/diff/log)
    settings.ts        - Settings load/save in userData
    terminal.ts        - Local shell (child_process) + SSH shell (ssh2) management
    searchService.ts   - Full-text search bridge (rg or JS fallback)
    codebaseService.ts - Symbol index + BM25 codebase search (persisted, incremental)
    mcpService.ts      - MCP server config load + client lifecycle
    diffStore.ts       - Pending diffs storage (accept/reject per hunk)
    checkpointStore.ts - Per-run pre-image records, backing "撤销本轮 AI 改动"
    diagnosticsStore.ts - Merged diagnostics cache (renderer Monaco markers + main-process LSP)
    projectConfig.ts   - `~/.echoly/projects/<hash>` 配置 + `~/.echoly/indexes/<hash>` 索引目录
    windowRegistry.ts  - Per-window service bundle, workspace-switch fan-out
    ssh/               - SSH connection management (SshSessionManager)
  src/preload/
    index.ts           - contextBridge exposing typed `window.ide` IPC API
  src/renderer/        - React 19 UI
    App.tsx            - Root layout: resizable panels (explorer/editor/bottom), toolbar, modals
    utils.ts           - UI helpers (time formatting, theme, path display)
    i18n.ts            - zh/en 主字典 + `translate` / `translateWith` / `translateSegments`
    i18nParts/         - 按领域拆分的字典分片（git / editor / db / runtime / misc）
    services/          - 纯逻辑：specialMentions / slashTrigger / gitGraph / textDiff / diffStats / dbDdl 等（见「关键渲染组件」）

packages/
  shared/              - Type definitions (AppSettings, PermissionMode, PendingDiff, SlashCommandInfo, etc.), IPC API contract, `renderCommand`
  llm/                 - OpenAI-compatible HTTP client: chat completion, streaming, model listing, tool probe
  agent/               - Agent tool-loop core: system prompt builder, Ask/Plan/Agent dispatch, tool call parse & execute
    contextCompaction.ts - 上下文压缩（锚点选取 + 摘要替换）
    mcp/               - MCP stdio 客户端：协议编解码、连接管理（McpManager）
  tools/               - Tool definitions + execution (LocalFs / SSH backends), rg/JS search, path jail, checkpoint revert
  skills/              - .cursor/skills / .deepseek/skills discovery, frontmatter parsing, scoring & prompt injection; commands.ts 发现 `.echoly/commands/*.md`
```

### 上下文压缩（`packages/agent/src/contextCompaction.ts`）

超出 `contextWindowTokens` 时不是简单截断最早的对话，而是选取一条**锚点**（通常是本轮的用户
诉求），把它之前的工具调用/结果整段替换成一条摘要消息。截断位置落在工具调用与其结果之间
会让模型看到孤立的 `tool` 消息，多数后端会直接 400。

## Architecture flow

### Agent tool loop (`packages/agent/src/index.ts`)

1. Build system prompt with tools, skills, workspace context
2. Call LLM with conversation history + tool definitions
3. Parse response: native `tool_calls` or fallback ` ```json tool` code block
4. Execute tools via provided `ToolContext` (path-jailed)
5. Repeat until `maxAgentSteps` reached or stop sequence emitted
6. On 400/tool errors: retry without tools once

At each step boundary (top of the step loop) the loop drains any user messages queued
mid-run via `options.drainQueuedMessages` and injects them as `user` messages. They are
deliberately **not** injected between a tool call and its result — the model must always
see call/result pairs together. Undelivered messages are reported back before `done`/`error`,
because the renderer clears `runId` on those events and can no longer route by it.

Three modes:

- **Ask**: readonly tools only (list_dir, read_file, read_file_lines, search_code, search_symbols, codebase_search, get_diagnostics, glob_files, ask_user)
- **Plan**: readonly + structured ` ```plan` JSON output for todos
- **Agent**: all tools including write_file, apply_patch, delete_path, move_path, run_terminal

After editing, the agent is instructed to call `get_diagnostics` and fix reported errors. That tool reads a per-window `DiagnosticsStore` (main process), which merges two sources: Monaco markers reported by the renderer via `diagnostics:report` (TS/JS language service lives only there) and `lsp:diagnostics` pushes from main-process LSP servers.

### IPC flow

- **Preload** (`contextBridge`) → **IPC handlers** (ipc.ts) → **backing services** (agentService.ts, gitService.ts, workspace.ts, etc.)
- All main↔renderer communication goes through typed `IpcApi` interface defined in `packages/shared`

### Tools & permissions (`packages/tools/src/`)

13 tools: `list_dir`, `read_file`, `read_file_lines`, `write_file`, `apply_patch`, `delete_path`, `move_path`, `search_code`, `search_symbols`, `codebase_search`, `get_diagnostics`, `glob_files`, `run_terminal`, `ask_user`

- `apply_patch` accepts an `edits` array of independent search/replace blocks (legacy `old_text`/`new_text` still works). Each `old_text` must be **unique** in the file or the patch is rejected — the model must widen the context or set `replace_all: true`.
- File operations jailed to workspace root via `pathJail.ts`
- Local: `node:fs`; SSH: `ssh2` SFTP
- Search: prefers `rg`, falls back to JS traversal
- `codebase_search` / `get_diagnostics` depend on host-injected providers (`ToolContext.codebaseSearch` / `getDiagnostics`); when absent they return an explicit "unavailable" error instead of a fake empty result
- Permission levels: `allow_all_extreme` / `allow_all` / `ask` (default) / `deny_all`

### 代码库索引与 BM25 检索 (`apps/desktop/src/main/codebaseService.ts`)

**它不是语义索引**：没有向量、没有 embedding。`GET /v1/models` 在内网后端返回 401，
无法确认是否存在 embedding 端点；而一个写错的 embedding 实现是**静默失败**的
（全零向量 → 相似度相同 → 排序退化成文件顺序），排查成本远高于收益。
所以这里给的是**做扎实的词法检索**：真实 BM25（IDF + 长度归一化）+ 字段加权。

- 索引落盘到 `~/.echoly/indexes/<哈希>/codebase.json`（与 `~/.echoly/projects/` 配置**分开放**：
  配置是用户手写的丢了要重填，索引是纯派生数据随时可删）；哈希复用 `projectConfigKey`，
  避免"配置认得这个项目、索引不认得"的错位。写入走 `.tmp` + `rename` 原子替换。
- 增量更新靠 `WorkspaceBackend.stat?()` 比对 size + mtime，未变动的文件复用旧 chunk。
  `stat` 是**可选**方法：拿不到就当作每次都变了——那是慢，不是错。
- 检索走 `WorkspaceBackend` 而不是 `node:fs`，所以 **SSH 工作区同样可索引**。
- 字段加权（都乘 IDF）：命中符号名 ×6、名字分词 ×3、注释/文档 ×2、路径分词 ×1.5。
- 工具栏「✦ BM25」旁的状态条显示索引进度；进度由 `codebase:progress` 推送
  （索引可能跑几十秒，没有它界面只能一直转圈）。
- Agent 工具用 `searchCached()` 而非 `search()`：冷启动时**立即返回空**并在后台补建，
  不让模型看起来卡住几十秒。索引缺失时模型会拿到明确的降级提示。

### Undoing a whole turn (`checkpointStore.ts` + `tools/src/checkpoint.ts`)

Every write/delete/move the agent performs is recorded _before_ it happens via
`ToolContext.onFileMutation`, grouped by `runId` in a per-window `CheckpointStore`
(an `unrecordable` entry — binary file or oversized tree — marks the whole run
un-revertable, so the UI refuses rather than half-restoring). The chat shows a
「撤销本轮改动」 button on any turn that mutated files; reverting replays the records
**in reverse** and skips any file whose content no longer matches what the turn wrote
(the user edited it afterwards). Note `DiffStore.discard` exists precisely for this
path: `accept`/`reject` would write to disk and clobber the fresh revert.

## Key renderer components

| Component                                | Purpose                                                                                                                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `App.tsx`                                | Root layout: resizable panels (explorer/editor/chat/bottom panel with terminal+diff), toolbar                                                               |
| `ChatPanel.tsx`                          | Chat message list, input, mode selector (Ask/Plan/Agent), permission display, session list, `@`-mentions, per-turn revert button, mid-run message queue     |
| `EditorPane.tsx`                         | Monaco editor multi-tab, top search file jumping with line highlight                                                                                        |
| `FileTree.tsx`                           | Sidebar file tree w/ ignore rules context menu                                                                                                              |
| `GitPanel.tsx`                           | Source Control: status, stage/unstage, commit, branch switch/create, pull/push, discard, diff                                                               |
| `TerminalPanel.tsx`                      | Local (GBK) / SSH (UTF-8) terminal via xterm.js                                                                                                             |
| `TopSearchBar.tsx`                       | Cursor-style Ctrl+P (files) + Ctrl+Shift+F (code search)                                                                                                    |
| `StatusBar.tsx`                          | Bottom bar: workspace type, mode, permission level, context tokens, agent steps                                                                             |
| `SessionDrawer.tsx` / `SessionModal.tsx` | Session history & management                                                                                                                                |
| `PlanPanel.tsx`                          | Structured plan/todo display for Plan mode                                                                                                                  |
| `ToolCallCard.tsx`                       | Agent tool call display. 卡片本体目前无人渲染，但 `commandFromArgs` / `parseTerminalResult` / `stripAnsi` 被 `chat/WorkedForGroup.tsx` 复用 —— 别顺手删文件 |
| `chat/WorkedForGroup.tsx`                | 折叠的「思考 + 工具执行过程」分组，实际渲染工具调用与实时输出                                                                                               |
| `ErrorBoundary.tsx`                      | 面板级渲染错误兜底（`App.tsx` 给 7 个面板各包了一层），文案走字典                                                                                           |

### 从巨型组件里拆出来的纯逻辑（`renderer/src/services/`）

组件文件普遍在三千到七千行。拆的标准只有一条：**这段代码碰不碰 React / Monaco / DOM**。
碰，就留在组件里；不碰，就搬到 `services/` 并直接单测。已经拆出来的：

| 模块                         | 来源             | 说明                                                                                                                         |
| ---------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `services/gitGraph.ts`       | `GitPanel.tsx`   | 提交图轨道分配（`analyzeGitGraph`）、状态树（`buildGitTree`）、状态字母。**不返回文案**                                      |
| `components/GitGraphRow.tsx` | `GitPanel.tsx`   | 提交图的两段 SVG，只依赖 `GraphAnalysis`，不读面板状态                                                                       |
| `services/textDiff.ts`       | `EditorPane.tsx` | 行级 diff、hunk 切分、行内词级 diff。注意 `splitLines('') === []`（空文件切成零行），否则「清空文件」会被报成「改了第 1 行」 |
| `services/diffStats.ts`      | `ChatPanel.tsx`  | 气泡上的 `+N -M`。故意用 indexOf 配对而非 DP：这是渲染路径上的同步调用                                                       |

`FileTree` 的 Git 状态从「每个节点自己线性扫 `entries`」改成了顶层 `useMemo` 建一次
索引（`buildGitStatusIndex`）+ O(1) 查表 —— 可见节点数千、改动数千时，前者是每次
刷新都重算整棵树。

### Hook 不能写在提前 `return` 之后（`react-hooks/rules-of-hooks`）

`eslint.config.mjs` 里只开了 react-hooks 的这一条，且是 **error**（`exhaustive-deps`
故意没开：它会给现有依赖数组灌一屏 warning，把真正致命的那条淹掉）。

起因是设置页整页崩成错误页：`SettingsModal` 里一个 `useEffect` 写在
`if (!open || !settings) return null` **之后**，而这些弹窗都是**常驻挂载**的
（`App.tsx` 只改 `open` 属性，不卸载组件）。于是「关闭 → 打开」这一次渲染里，
早退分支比正常分支少跑了几个 hook，React 抛
`Rendered more hooks than during the previous render`。

这类 bug 的阴险之处在于**它一个门禁都过不去**：typecheck 绿、测试绿、构建绿，
只在用户点开那个弹窗的瞬间炸掉。同批修掉的还有 `GitPanel.GitTreeItemView`
（`node.isDirectory` 分支早退）、`FileTree.TreeNode`（目录分支早退）、
`TableStructureModal`（`!isOpen` 早退）。

写新组件时的判据很简单：**只要函数体里出现了 `return null`，它上面的所有 hook
调用必须一个不漏地在它之前**。需要「关闭时跳过工作」就写进 effect 体内
（`if (!open) return;`），而不是靠早退让这次渲染不发生。

## Electron-vite config

Three build targets in `electron.vite.config.ts`:

- **main**: `src/main/index.ts` (includes workspace packages as bundled deps)
- **preload**: `src/preload/index.ts`
- **renderer**: React + `@renderer/` alias

## Workspace types

1. **Local**: Open folder → register watchers, file tree, git detection
2. **SSH remote**: SFTP file browsing/editing + SSH terminal. Password session-only. Profiles saved to `userData/ssh-profiles.json`
3. **Clone**: GitHub/Git URL clone → auto-open as local workspace

## Git operations

Only supported in local workspaces. `gitService.ts` uses child_process (not simple-git library) for: status, stage/unstage, commit, branch management, push/pull, log, per-file diff.

## Skills system

Scans three locations for `SKILL.md` files:

- `.cursor/skills/<name>/SKILL.md`
- `.deepseek/skills/<name>/SKILL.md`
- user data dir `skills/<name>/SKILL.md`

Frontmatter format (Cursor-compatible):

```markdown
---
name: skill-name
description: When to use this skill
---
```

Top-scoring skills (matched against user prompt) are injected into the agent system prompt.

### Slash 命令 / prompt 模板库 (`packages/skills/src/commands.ts`)

扫描三个目录下的 `*.md`：`.echoly/commands/`、`.cursor/commands/`、`.deepseek/commands/`。
文件名即命令名，经 `normalizeCommandName()` 归一化（小写、非字母数字转 `-`）。
正文里的 `$ARGUMENTS` 会被用户敲的参数替换；没有该占位符时参数追加到正文末尾。

渲染函数 `renderCommand` 住在 **`packages/shared`** 而不是 skills 包：渲染方在 renderer
（ChatPanel 要在选中瞬间把正文填进输入框），而 skills 包依赖 `node:fs`/`node:path`，
被 renderer 引用会把 Node 内置模块打进 bundle。skills 包只做转发以保证替换规则唯一。

输入框触发解析在 `renderer/src/services/slashTrigger.ts`：

- `/` **只认行首**——斜杠在正文里到处都是（`src/a.ts`、日期、除法），放宽会让每写一个路径弹一次下拉。
- `@` 允许行内，但要求前面是空白，否则邮箱 `a@b.com` 会弹出文件列表。
- `@` 与 `/` 的下拉共用同一套键盘导航层（`suggestMode`），不各自实现一遍。

## MCP 支持（stdio）

- `packages/agent/src/mcp/`：协议编解码 + 连接管理（`McpManager`），按 JSON-RPC over stdio 通信。
- `apps/desktop/src/main/mcpService.ts`：读取配置、拉起子进程、作为生命周期宿主；
  IPC 暴露 `mcpReload` / `mcpStatus`，设置页可见连接状态。
- MCP 提供的工具与内置 13 个工具一同注入 system prompt，走同一条工具循环。

## i18n

`renderer/src/i18n.ts` 是零依赖的极简实现，导出：

| 导出                                                            | 用途                                                                 |
| --------------------------------------------------------------- | -------------------------------------------------------------------- |
| `useI18n()`                                                     | 组件里取 `{ t, locale, setLocale }`；`t(key, params?)`               |
| `Translate`                                                     | `(key, params?) => string`，给拿不到 hook 的模块级 helper 当形参类型 |
| `translate(key, locale)` / `translateWith(key, locale, params)` | 非组件环境使用                                                       |
| `translateSegments(key, locale, params)`                        | 句子中间要嵌 `<code>` 等元素时用                                     |
| `DICT` / `CORE_DICT` / `DICT_PARTS`                             | 完整字典 / 主表 / 各分片，导出**只为测试**                           |

- 整句进字典，**不做片段拼接**：中英文语序不同（「在 3 个文件中找到了 12 个结果」↔
  "Found 12 results in 3 files"，数字顺序相反），拼接写法只能二选一地出错。
- 未在 `params` 里给出的占位符**原样保留** `{n}`：字典写错时界面上一眼能认出，
  而不是悄悄消失一个空洞。
- 缺 key 时返回 key 本身，让缺口可见。
- **注意**：渲染层里的中文字符绝大多数是**注释**，注释不翻译，只翻用户可见文案。
  判定标准是「这个字符串是给用户眼睛看的，还是只给代码用的」——`language === '图片'`
  这类**比较用的字面量**、DOM 选择器、localStorage key、IPC 参数一律不翻，翻了会静默改变行为。

#### 明确**不翻**的四类字符串

铺开时逐条判过，下面几类保持中文是**结论**，不是漏掉的：

| 类别                | 例子                                                                                                                           | 为什么不翻                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 送给模型的 prompt   | `specialMentions.ts` 的附件正文、`ProblemsPanel.handleDiagnose*`、`TerminalAiKBar` 的上下文提示、EditorPane 快捷标签预填的指令 | 翻它等于换一套提示词，产出会跟着变 —— 那是另一个**行为**，不是另一种语言 |
| 落盘的标识 / 文件名 | `dbQueryScripts.DEFAULT_BASE_NAME`（`查询`）、`NEW_CONSOLE_SQL` 的正文、`techStack.TECH_STYLES` 的键                           | 翻完老数据与新数据对不上号，且**不出任何错**，只是名字变得莫名其妙       |
| 数据库原生写法      | SQL 关键字、`NULL`、类型名、驱动 id、表 / 列名                                                                                 | 翻了会写坏 SQL                                                           |
| 已算过一遍的量      | `FILTER_OPERATOR_ICONS` 的 `⊃` / `∅̸`、`(PK)` 角标                                                                              | 符号不是语言                                                             |

反过来，**凡是会进入用户视野的**就一定要进字典，包括容易被漏掉的那几处：
Monaco CodeLens 标题（`editor.conflictTake*`）、补全列表右侧的 `detail`/`documentation`
（`db.comp*`）、悬停提示（`editor.cmdClickToDefinition`）、注入进弹窗正文的 SQL 注释
（`db.renameScript*`）。它们的共同点是「不是 JSX 里的一段文本」，所以最容易在扫 JSX
的时候被整片略过。

### `translateSegments`：把 `<code>` 留在句子里

以前遇到「工作区 `X`（兼容 `.cursor/commands/`）」这种句子，只能在 JSX 里拼
`<code>`，整句话就被钉死在中文语序上。`translateSegments` 返回
`{ text, emphasis }[]`，`{占位符}` 的位置标成 `emphasis: true`，由调用方决定渲染成
`<code>` 还是普通 `<span>`。相邻同类片段会合并，避免 React 反复重建节点。

**占位符的出现顺序在中英两版里必须一致** —— 渲染层是按顺序把片段接起来的，
顺序不同就会把参数拼到错误的位置上。`test/i18n.test.ts` 会逐 key 比对。

### 字典分片与完整性测试（`apps/desktop/test/i18n.test.ts`）

字典分成 `CORE_DICT`（`i18n.ts` 主表）+ `i18nParts/*`（按领域：git / chat / editor /
db / runtime / settings / misc），在 `DICT` 里展开合并。分片是为了让并行改动各自只写
一个文件（都往同一个对象里塞几乎必然冲突）；代价是**同名 key 会被后一片静默覆盖**，
表现是「改了中文但界面没变」，所以测试里单独有一条「分片之间没有重复 key」，
在合并之前按片两两比对。加新分片的步骤见 `i18nParts/README.md`。

测试遍历真实 `DICT`（不是手工维护的 key 清单——那份清单在第一次忘记更新时就失效了），
逐 key 断言：中英两版都在、英文里没有中文（`[一-龥]`）、中英占位符集合一致。
英文为空串需要加进 `EMPTY_EN_ALLOWED` 白名单并说明理由 —— 用白名单而不是
「空串一律放过」，否则真正的漏翻也会悄悄通过，而漏翻在中文环境下根本看不出来。

### key 对账测试（`apps/desktop/test/i18nKeys.test.ts`）

字典完整性（上面那条）只管「条目本身合不合格」，管不了「有没有人用」。这个测试补反向：

- **用到的 key 都在字典里**：`translate()` 查不到 key 时原样返回 key（故意的），
  界面上安静地显示成 `git.stageAll`，中英文一样 —— 切到英文也发现不了。
- **分片里的 key 都有引用**：翻译做完后组件改回写死字符串、或 key 拼错一个字，
  留下的条目永远没人用，字典慢慢烂掉。只查分片，不查主表：主表里有本来就
  还没接上的骨架条目（如留给原生菜单的 `menu.*`），一起查会红一片无害的东西。

扫描用正则而非 AST：认的是 `t('x')` 这种**调用形状**。全量字面量扫描会把
`echoly.terminal.wordWrap`（localStorage key）、`pom.xml`（文件名）这类同形状字符串
收进来然后误报。模板字符串拼出来的 key（`t(\`tree.moveReject.${code}\`)`）扫不到，
前缀记在文末 `DYNAMIC_KEY_PREFIXES`，**新增动态 key 时记得补一行**。

### 内部哨兵值

`WorkspaceInfo.label` 在未打开工作区时是 `NO_WORKSPACE_LABEL`（定义在
`packages/shared`），它是**内部哨兵**不是文案。渲染层要显示时用 `t('panel.noWorkspace')`。
之前这个字符串在 main 与 renderer 里各写了一遍字面量，改语言时容易漏改一处。

同理，`utils/fileMoveValidation.ts` 的 `validateMove` 失败时返回
`MoveRejectionCode`（`'move-into-self' | 'move-into-child' | 'already-in-target'`）
而不是一句中文。调用方要区分「拖回原目录」这种不该报警的情况，早先靠逐字比较
中文句子——那句话一旦被改写或翻译，比较就静默失效，拖拽提示直接失灵。

**这是铺 i18n 时最容易漏掉的一类 bug**：一旦某个字符串进了字典，任何
`x.includes('中文')` / `x === '中文'` 的判定在英文环境下**必然**为假 ——
不崩、不报错、不打日志，只是那个分支永远走不到。铺开过程中已清掉这几处：

| 位置                                    | 原写法                                                   | 改成                                                       |
| --------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------- |
| `SshSessionManager` → `SshConnectModal` | `error.includes('本地网络')`                             | `SshConnectResult.needsLocalNetwork` 标志位                |
| `GitPanel.runGitAction`                 | `title.includes('分支'/'Pull'/'Fetch')`                  | 显式参数 `affectsBranch`                                   |
| `App.tsx` 终端快捷键判定                | `textContent.includes('终端')`                           | tab 按钮加 `data-tab`，读属性                              |
| `EditorPane` 差异徽章                   | `desc.includes('↔')` 再 `includes('远程'/'提交'/'版本')` | 整段删除（该分支已不可达）                                 |
| `GitPanel.runGitAction`                 | `res.detail === '取消输入' / '取消放弃修改'`             | 删除（全仓无生产者，是 v0.0.28 旧 App.tsx 的残留）         |
| `chatHistory` 熔断消息回灌              | `m.content.includes('模型在思考阶段陷入重复循环…')`      | `ChatSessionMessage.circuitBroken` / `done` 事件带同名标志 |

判定原则：**判据要来自数据，不要来自文案**。确实需要跨进程传递「失败属于哪一类」时，
在 `packages/shared` 的结构体上加显式字段，别让渲染层去错误文本里找关键词。

纯逻辑模块（无 React、被 vitest 直接单测的那些）更进一步：**它们连文案都不返回，
只返回原因码**，由渲染层查表翻译。已有的三张码表：

| 模块                           | 码表                                      | 说明                                                         |
| ------------------------------ | ----------------------------------------- | ------------------------------------------------------------ |
| `services/dbDdl.ts`            | `DB_DDL_ERROR_KEY` / `DB_ALTER_SKIP_KEY`  | 建表/改列校验；`DbAlterSkip { code, name }` 而不是拼好的句子 |
| `services/dbConnectionForm.ts` | `DB_FORM_ERROR_KEY`                       | 新建连接表单校验                                             |
| `services/dbMutations.ts`      | `DB_COMMIT_ERROR_KEY` + `DbInsertProblem` | 提交前必填校验与语句汇总                                     |

两条容易踩的细节：

- **列表分隔符也不能在纯逻辑里拼**。中文顿号「、」和英文 `, ` 不是同一个字符，
  `dbMutations` 因此返回 `columns: string[]` 而不是 `join('、')` 的结果，
  由组件用 `t('db.listSeparator')` 连接。
- 这些模块**没有 i18n 上下文**，让它们接收 `t` 会把 React hook 之外的依赖也拖进来，
  所以走码表。组件侧写 `t(KEY_TABLE[code], params)`；`i18nKeys.test.ts` 认得
  `export const \w*KEY\w*: Record<…, string>` 这种形状，不会把这些间接引用误报成死 key。

同理，有些中文字符串是**落盘标识**而不是文案 —— 例如 `utils/techStack.ts` 的
`TECH_STYLES` 用 `通用` / `目录` / `Git` 作索引，这些键会被写进最近工作区记录、
也会被 `App.tsx` 用 `tech === '通用'` 反复比较。**键保持中文，只翻渲染出来的 `label`**。
`detectTechBadge(name, path, t, explicitTech?)` 与 `resolveDebugConfig(option, t, path?)`
的 `t` 都是**必填**参数（不是带默认值的可选参数）：它们的返回值会直接显示给用户，
做成可选就等于把「英文环境显示中文」藏进类型系统看不见的地方，漏传必须是编译错误。

## Default settings

| Item                | Default                      |
| ------------------- | ---------------------------- |
| baseUrl             | `http://192.168.10.241:8002` |
| model               | `deepseek-v4`                |
| temperature         | `0.2`                        |
| maxAgentSteps       | `50`                         |
| permissionMode      | `ask`                        |
| contextWindowTokens | `128000`                     |
| theme               | `dark`                       |
| keymapPreset        | `vscode`                     |

Settings stored in Electron `userData/settings.json`.

## `@`-mentions in chat

`ChatPanel` inserts `@<path>` for files, plus three **special** mentions that expand at **submit time** (not at insert time — they describe current state):

| Mention     | Expansion                                                              |
| ----------- | ---------------------------------------------------------------------- |
| `@Git`      | branch/ahead-behind, changed-file list, and diffs of up to 8 files     |
| `@Terminal` | last ~120 lines of the focused terminal's xterm buffer (ANSI stripped) |
| `@Problems` | Error/Warning markers across the workspace (read straight from Monaco) |

Expansion lives in `renderer/src/services/specialMentions.ts` and produces `ChatAttachment`s, so the snapshot also shows up in the message history and survives multi-turn context building. Terminal buffers are reached via a module-level reader registry (`registerTerminalLogReader`) because the xterm instance and the chat input have no parent/child relationship.

## Known constraints

- **Terminal**: 两端都有 PTY。本地走 `node-pty`（`main/terminal.ts`），SSH 走 `ssh2` 的
  `client.shell({ term: 'xterm-256color', cols, rows })`（`SshSessionManager`），
  TUI 程序（vim / htop）在本地与远端都能正常使用。
- **Diff**: generated by tool output, reviewed inline in the chat diff summary (`ChatPanel.tsx`) with accept/reject all; per-file hunks are previewed in `EditorPane`.
- **Packaging**: unsigned, `dir` target on Windows (avoids winCodeSign symlink issues); `identity: null` on macOS.
- **Windows 图标**: 打包时由 `resources/icon.png` 自动生成多分辨率 `.ico` 并通过 rcedit 写入 `Echoly.exe`。**切勿在 `build.win` 里设 `signAndEditExecutable: false`** —— 那会跳过 rcedit，导致 exe 与桌面快捷方式仍显示 Electron 默认图标。Windows 打包在 `windows-latest` runner 上执行，rcedit 可原生运行。
- **SSH**: password never persisted to disk; profiles keep host/user/key paths only.
- **原生菜单未接入 i18n**：`src/main/index.ts` 里的 `Menu` 模板（`fileMenuTemplate()` 等，
  约 36 条 `label`）仍是写死中文。它跑在主进程，而 locale 存在渲染进程的 `localStorage`
  里，两者不共享；接的话需要把 locale 也走 `settings.json` 并由 IPC 通知主进程重建菜单。
  在补上之前，切到 English 时**顶部原生菜单栏仍是中文** —— 这是已知缺口，不是漏改。

## UI 规范与按钮交互（对齐 Maven 标准，永久强制）

**完整规范只维护在 [`.agents/rules/ui-guidelines.md`](.agents/rules/ui-guidelines.md)，
要改规范请改那一份。** `AGENTS.md` / `GEMINI.md` / 本文件都只是摘要 —— 同一条规则
抄四份的结局是改的时候只改到手里这一份，另外三份继续写着旧尺寸且不会报任何错。

摘要（开工前扫一眼用）：

- **容器**：`height: 30`, `padding: '0 10px'`, `boxSizing: 'border-box'`, `display: 'flex'`, `alignItems: 'center'`, `justifyContent: 'space-between'`, `borderBottom: '1px solid var(--border)'`, `flexShrink: 0`。
- **按钮**：统一使用 `<button type="button" className="panel-action-btn" title="...">`。
- **严禁内联尺寸覆盖**：绝对禁止在按钮上添加 `style={{ width: 22, height: 22 }}` 等内联尺寸硬编码，尺寸与微动效（26x26px，hover 1.05，active 0.95）由 `.panel-action-btn` 统一管理；紧凑变体是 `panel-action-btn--compact`。
- **图标**：标准高对比度 SVG 矢量（14x14 或 16x16，`strokeWidth="2"`，`stroke="currentColor"`）。
- **字号基线**：`html` / `body` / `#root` 上**没有** `font-size`，真正的根值是浏览器默认的 16px。新增面板容器必须显式写 `font-size: var(--ui-font-size, 12px)`，别指望继承（设置页 MCP 页整整一屏字号偏大就是这么来的）。

下面两条不属于 UI 规范，但同样强制：

- **终端环境**：本地终端与子进程自动集成系统与 Homebrew 路径（`/opt/homebrew/bin`），Shell 默认使用登录 Shell（`-l` 参数）。
- **Git 分支切换**：分支切换时自动保留未提交修改并在切回时自动恢复，切换后立即同步刷新打开文件、文件树与全局 Git 状态。

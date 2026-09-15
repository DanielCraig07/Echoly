# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Language**: 此项目文档、注释及提交信息默认使用中文。所有终端命令、API 调用等按原文保留。

## Commands

```bash
npm run dev           # Start Electron dev server (electron-vite + React)
npm run build         # Build for production
npm run typecheck     # TypeScript check across all workspaces
npm run probe-llm     # Test connectivity to the LLM backend at 192.168.10.241:8002
npm run pack          # Package for Windows (dir target, unsigned)
npm run pack:mac      # Package macOS DMGs (arm64 + x64)
npm run pack:mac:arm64  # Package macOS DMG (Apple Silicon only)
npm run pack:mac:x64    # Package macOS DMG (Intel only)
```

`typecheck` runs per-package — each workspace has its own `tsconfig.json` and `npm run typecheck`. The root script runs `--workspaces --if-present`.

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
    diffStore.ts       - Pending diffs storage (accept/reject per hunk)
    ssh/               - SSH connection management (SshSessionManager)
  src/preload/
    index.ts           - contextBridge exposing typed `window.ide` IPC API
  src/renderer/        - React 18 UI
    App.tsx            - Root layout: resizable panels (explorer/editor/bottom), toolbar, modals
    utils.ts           - UI helpers (time formatting, theme, path display)

packages/
  shared/              - Type definitions (AppSettings, PermissionMode, PendingDiff, etc.), IPC API contract
  llm/                 - OpenAI-compatible HTTP client: chat completion, streaming, model listing, tool probe
  agent/               - Agent tool-loop core: system prompt builder, Ask/Plan/Agent dispatch, tool call parse & execute
  tools/               - Tool definitions + execution (LocalFs / SSH backends), rg/JS search, path jail
  skills/              - .cursor/skills / .deepseek/skills discovery, frontmatter parsing, scoring & prompt injection
```

## Architecture flow

### Agent tool loop (`packages/agent/src/index.ts`)

1. Build system prompt with tools, skills, workspace context
2. Call LLM with conversation history + tool definitions
3. Parse response: native `tool_calls` or fallback ` ```json tool` code block
4. Execute tools via provided `ToolContext` (path-jailed)
5. Repeat until `maxAgentSteps` reached or stop sequence emitted
6. On 400/tool errors: retry without tools once

Three modes:

- **Ask**: readonly tools only (list_dir, read_file, search_code, glob_files, ask_user)
- **Plan**: readonly + structured ` ```plan` JSON output for todos
- **Agent**: all tools including write_file, apply_patch, run_terminal

### IPC flow

- **Preload** (`contextBridge`) → **IPC handlers** (ipc.ts) → **backing services** (agentService.ts, gitService.ts, workspace.ts, etc.)
- All main↔renderer communication goes through typed `IpcApi` interface defined in `packages/shared`

### Tools & permissions (`packages/tools/src/`)

8 tools: `list_dir`, `read_file`, `write_file`, `apply_patch`, `search_code`, `glob_files`, `run_terminal`, `ask_user`

- File operations jailed to workspace root via `pathJail.ts`
- Local: `node:fs`; SSH: `ssh2` SFTP
- Search: prefers `rg`, falls back to JS traversal
- Permission levels: `allow_all_extreme` / `allow_all` / `ask` (default) / `deny_all`

## Key renderer components

| Component                                | Purpose                                                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| `App.tsx`                                | Root layout: resizable panels (explorer/editor/chat/bottom panel with terminal+diff), toolbar |
| `ChatPanel.tsx`                          | Chat message list, input, mode selector (Ask/Plan/Agent), permission display, session list    |
| `EditorPane.tsx`                         | Monaco editor multi-tab, top search file jumping with line highlight                          |
| `FileTree.tsx`                           | Sidebar file tree w/ ignore rules context menu                                                |
| `GitPanel.tsx`                           | Source Control: status, stage/unstage, commit, branch switch/create, pull/push, discard, diff |
| `TerminalPanel.tsx`                      | Local (GBK) / SSH (UTF-8) terminal via xterm.js                                               |
| `TopSearchBar.tsx`                       | Cursor-style Ctrl+P (files) + Ctrl+Shift+F (code search)                                      |
| `DiffPanel.tsx`                          | Diff review from tool output: accept/reject per hunk                                          |
| `StatusBar.tsx`                          | Bottom bar: workspace type, mode, permission level, context tokens, agent steps               |
| `SessionDrawer.tsx` / `SessionModal.tsx` | Session history & management                                                                  |
| `PlanPanel.tsx`                          | Structured plan/todo display for Plan mode                                                    |
| `ToolCallCard.tsx`                       | Agent tool call display with animated step indicators                                         |
| `ReasoningStep.tsx`                      | Expandable reasoning chain display                                                            |

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

Settings stored in Electron `userData/settings.json`.

## Known constraints

- **Terminal**: no PTY (child_process spawn / SSH shell channel). No node-pty yet.
- **Diff**: generated by tool output, rendered in DiffPanel for accept/reject per hunk.
- **Packaging**: unsigned, `dir` target on Windows (avoids winCodeSign symlink issues); `identity: null` on macOS.
- **Windows 图标**: 打包时由 `resources/icon.png` 自动生成多分辨率 `.ico` 并通过 rcedit 写入 `Echoly.exe`。**切勿在 `build.win` 里设 `signAndEditExecutable: false`** —— 那会跳过 rcedit，导致 exe 与桌面快捷方式仍显示 Electron 默认图标。Windows 打包在 `windows-latest` runner 上执行，rcedit 可原生运行。
- **SSH**: password never persisted to disk; profiles keep host/user/key paths only.

## UI 规范与按钮交互（对齐 Maven 标准，永久强制）

所有二级面板工具栏（Maven、Git、Explorer、Search 等）必须严格对齐 Maven 标准：
- **容器**：`height: 30`, `padding: '0 10px'`, `display: 'flex'`, `alignItems: 'center'`, `justifyContent: 'space-between'`, `borderBottom: '1px solid var(--border)'`。
- **按钮**：统一使用 `<button type="button" className="panel-action-btn" title="...">`。
- **严禁内联尺寸覆盖**：绝对禁止在按钮上添加 `style={{ width: 22, height: 22 }}` 等内联尺寸硬编码，尺寸与微动效（26x26px，hover 1.05，active 0.95）由 `.panel-action-btn` 统一管理。
- **图标**：标准高对比度 SVG 矢量（14x14 或 16x16，`strokeWidth="2"`，`stroke="currentColor"`）。
- **终端环境**：本地终端与子进程自动集成系统与 Homebrew 路径（`/opt/homebrew/bin`），Shell 默认使用登录 Shell（`-l` 参数）。
- **Git 分支切换**：分支切换时自动保留未提交修改并在切回时自动恢复，切换后立即同步刷新打开文件、文件树与全局 Git 状态。

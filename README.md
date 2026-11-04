# Echoly

> AI 原生、轻量极速的现代智能代码编辑器。融合 Monaco Editor、AI Agent 与全功能开发者工具链，为开发者提供沉浸式的工程体验。

## ✨ 核心特性

- **AI 协同中枢**：预置 DeepSeek-V4.1（内网）、DeepSeek-R1、Claude、GPT-4o 等模型，可自定义任意 OpenAI 兼容端点；聊天区下拉直切，支持自定义 Base URL / API Key。
- **三大交互模式**：💬 **Ask**（只读问答）、📋 **Plan**（调研并生成步骤化计划与 Todo）、⚡ **Agent**（自主搜索、读写文件、执行终端，闭环完成任务）。
- **上下文感知**：`@file` / `@folder` 精准引用工作区文件；实时 Token 用量与步数监控；超长对话自动压缩上下文。
- **命令面板**：`Cmd/Ctrl+P` 开文件、`Cmd/Ctrl+Shift+P` 动作指令、`Cmd/Ctrl+Shift+F` 全文检索；双击 `Shift` 唤起 Search Everywhere。
- **Run Configuration**：自动解析 `package.json` 的 `scripts`，一键 ▶ 启动 / ⏹ 停止。
- **Git 全闭环**：Monaco 行级 Blame、暂存与提交、分支切换与创建、Pull / Push；非 Git 项目提供一键 `git init` 引导。
- **远程 SSH 开发**：SFTP 文件工作区 + SSH 交互式终端，5 秒心跳保活、抖动自动重连。
- **其他**：本地 / SSH 终端（PTY）、代码库 BM25 索引检索、`.cursor/skills` 技能与 `.echoly/commands` 斜杠命令、MCP (stdio) 工具接入、中英双语界面。

## 🚀 快速开始

**环境要求**：Node.js >= 20、npm >= 10；macOS (Apple Silicon / Intel) 或 Windows 10/11 (x64 / ia32)。

```bash
git clone https://github.com/DanielCraig07/Echoly.git
cd Echoly
npm install
npm run dev
```

### 校验与测试

```bash
npm run typecheck     # 全工作区类型检查（含 test/）
npm run build         # 编译主进程与渲染进程
npm test              # 全部单元测试（vitest）
npm run test:coverage # 带 v8 覆盖率（coverage/）
npm run lint          # ESLint
npm run format        # prettier --write
npm run format:check  # 只检查（CI 门禁）
```

> 提交前请至少跑 `npm run typecheck && npm test && npm run format:check` —— 这三条正是 CI `quality-gate` 卡住合并的部分。

## 📦 打包

**macOS**（需在 macOS 上执行，依赖原生 `hdiutil`）：

```bash
npm run pack:mac:arm64   # Apple Silicon
npm run pack:mac:x64     # Intel
npm run pack:mac         # 两种架构
```

产物：`apps/desktop/release/Echoly-<version>-<arch>.dmg`。

**Windows**：

```bash
npm run pack        # x64 安装包
npm run pack:win32  # ia32
```

产物：`apps/desktop/release/Echoly-<version>-<arch>-Setup.exe` 与免安装目录 `win-unpacked/`。

## 📂 项目结构

采用 npm workspaces 的 Monorepo：

```text
apps/desktop/            # Electron 主进程、Preload 与 React 渲染层
packages/
  agent/                 # AI Agent 推理执行引擎（工具循环、上下文压缩、MCP 客户端）
  llm/                   # 大模型驱动与多 Provider 协议适配
  shared/                # 全局共享类型定义与 IPC 契约
  skills/                # 技能（Skills）扫描、评分与注入
  tools/                 # 工具集（文件读写、搜索、终端等，本地 / SSH 双后端）
  runner/                # 远端 Agent runner：在 SSH 主机上执行 Agent 并回写事件
  cursor-extension/      # Cursor / VSCode 扩展连接层
  vscode-shim/           # VSCode API 运行期兼容垫片
scripts/                 # 构建、打包与辅助脚本
```

详细架构与开发约定见 [CLAUDE.md](CLAUDE.md)。

## 🛠️ 快捷键

| 快捷键 (macOS / Win)           | 功能                    |
| :----------------------------- | :---------------------- |
| `Cmd+P` / `Ctrl+P`             | 文件快速打开            |
| `Cmd+Shift+P` / `Ctrl+Shift+P` | 动作指令面板            |
| `Cmd+Shift+F` / `Ctrl+Shift+F` | 全文代码检索            |
| 双击 `Shift`                   | Search Everywhere       |
| `Cmd+Shift+B` / `Ctrl+Shift+B` | 展开 / 折叠左侧边栏     |
| `Cmd+J` / `Ctrl+J`             | 展开 / 折叠底部终端     |
| `Cmd+B` / `Ctrl+B`             | 展开 / 折叠右侧 AI 面板 |
| `Cmd+Shift+G` / `Ctrl+Shift+G` | 切到 Git 面板           |
| `Cmd+,` / `Ctrl+,`             | 打开设置                |

## 📄 许可证

本项目基于 [MIT License](LICENSE) 开源。

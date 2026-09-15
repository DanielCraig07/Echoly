# Echoly

> **Echoly** 是一款 AI 原生、轻量极速的现代智能代码编辑器（AI-first Intelligent IDE）。深度融合 Monaco Editor、智能 AI Agent 与全功能开发者工具链，为开发者提供媲美商业级 IDE 的沉浸式工程体验。

---

## ✨ 核心特性

### 🤖 1. 下一代 AI 协同中枢

- **多模型灵活切换 (Model Switcher)**：
  - 开箱即用支持 **DeepSeek-V3 / DeepSeek-R1（深度思考）**、**Claude 3.5 Sonnet**、**OpenAI GPT-4o** 等主流前沿大模型；
  - 聊天输入区直观下拉切换当前模型，支持自定义 Base URL 与 API Key。
- **三大 AI 交互模式**：
  - 💬 **Ask 模式**：纯只读提问与代码答疑；
  - 📋 **Plan 模式**：只读深度调研，自动生成步骤化执行计划与 Todo 事项；
  - ⚡ **Agent 模式**：具备自主探索闭环（文件搜索、代码阅读、写入、文件替换、终端执行与交互式确认）。
- **智能上下文感知**：
  - 支持 `@file`、`@folder` 精准引用工作区文件作为 Prompt 背景；
  - 实时 Token 上下文用量监控与步数穿透。

### ⚡ 2. 全能指令面板 (Command Palette / Search Everywhere)

- 键盘流极速操作：
  - 📂 **文件快速打开**：`Cmd+P` / `Ctrl+P`，极速模糊检索全工程文件；
  - ⚡ **动作指令面板**：`Cmd+Shift+P` / `Ctrl+Shift+P`（或在搜索框输入 `>` 自动切入），一键触发 IDE 各项操作（切换分支、新建会话、拉取提交、清空终端、打开设置等）；
  - 🔍 **代码符号检索**：`Cmd+Shift+F` / `Ctrl+Shift+F`，全文代码检索并精准定位行号。

### ▶️ 3. IDEA 风格 Run Configuration 一键运行

- 位于顶部导航栏中央标志性位置；
- **自动脚本扫描**：自动解析当前项目 `package.json` 中的 `scripts`（如 `dev`, `start`, `build`, `test`, `lint` 等）；
- **一键启动 ▶**：用户无需手动打开终端，点击绿色运行按钮自动展开底部终端并执行脚本，支持微光状态指示与一键 ⏹ 停止。

### 🌿 4. 工业级 Git 版本控制全闭环

- **Monaco 行级 Git Blame**：光标在任意代码行停留时，行末以优雅淡灰字实时浮现最后提交作者、相对时间与 Commit 摘要；
- **完整 Git 周期管理**：工作区更改列表、单文件/全部文件暂存与取消暂存、提交、分支切换与创建、Pull / Push；
- **智能空状态引导**：当打开非 Git 项目时，展示现代卡片引导界面，支持一键 `git init` 初始化仓库。

### 🌐 5. 远程 SSH 开发与弹性保活

- **SFTP 远程文件工作区**：直连 Linux 服务器，无缝浏览与编辑远程代码；
- **远程终端会话**：内置 SSH 交互式终端，支持高低延迟网络自适应；
- **连接弹性保活与容灾**：5 秒智能心跳保持，网络临时抖动自动重试，平滑保持 Git 与编辑状态，杜绝误判断线。

---

## 🚀 快速开始

### 运行环境

- **Node.js** >= 20.0.0
- **npm** >= 10.0.0
- 系统要求：macOS (Apple Silicon / Intel) 或 Windows 10/11 (x64 / ia32)

### 安装依赖与启动

```bash
# 1. 克隆代码仓库
git clone https://github.com/DanielCraig07/Echoly.git
cd Echoly

# 2. 安装项目依赖
npm install

# 3. 启动开发模式
npm run dev
```

### 类型检查与编译验证

```bash
# 执行全工作区 TypeScript 类型严格检查
npm run typecheck

# 编译主进程与渲染进程
npm run build
```

---

## 📦 打包构建指南

### macOS (DMG 安装镜像)

> **注意**：必须在 macOS 环境下执行打包（依赖系统原生 `hdiutil`）。

```bash
# 打包 Apple Silicon (M1/M2/M3/M4) 架构 DMG (推荐)
npm run pack:mac:arm64

# 打包 Intel (x64) 架构 DMG
npm run pack:mac:x64

# 同时构建两种架构
npm run pack:mac
```

- 构建完成后，DMG 安装包将产出至 `apps/desktop/release/Echoly-<version>-<arch>.dmg`。

### Windows (EXE 安装包 & 便携版)

```bash
# 打包 64 位安装程序 (NSIS Setup.exe)
npm run pack

# 打包 32 位程序
npm run pack:win32
```

- 构建产物包含：
  - **安装向导包**：`apps/desktop/release/Echoly-<version>-<arch>-Setup.exe`
  - **免安装绿色便携目录**：`apps/desktop/release/win-unpacked/`

---

## 📂 项目工程架构

本项目采用基于 npm workspaces 的 Monorepo 模块化架构：

```text
Echoly/
├── apps/
│   └── desktop/               # Electron 主进程、Preload 与 React 渲染层
├── packages/
│   ├── agent/                 # AI Agent 自主推理执行引擎
│   ├── llm/                   # 统一大模型驱动与多 Provider 协议适配层
│   ├── shared/                # 全局共享 TypeScript 类型定义与通用工具
│   ├── skills/                # 外部扩展技能 (Skills) 扫描与注入管理
│   ├── tools/                 # IDE 工具环（文件读写、搜索、Git、终端等）
│   ├── cursor-extension/      # Cursor / VSCode 扩展连接层
│   └── vscode-shim/           # VSCode API 运行期兼容垫片
├── scripts/                   # 打包与辅助构建脚本
├── package.json               # 根项目工作区配置
└── README.md
```

---

## 🛠️ 键盘快捷键速查

| 快捷键 (macOS / Win)           | 功能描述                               |
| :----------------------------- | :------------------------------------- |
| `Cmd+P` / `Ctrl+P`             | 打开文件快速检索面板                   |
| `Cmd+Shift+P` / `Ctrl+Shift+P` | 唤起全局动作指令面板 (Command Palette) |
| `Cmd+Shift+F` / `Ctrl+Shift+F` | 全文代码符号检索                       |
| `Cmd+Shift+B` / `Ctrl+Shift+B` | 展开 / 折叠左侧资源管理器边栏          |
| `Cmd+J` / `Ctrl+J`             | 展开 / 折叠底部控制台终端              |
| `Cmd+B` / `Ctrl+B`             | 展开 / 折叠右侧 AI 助手面板            |
| `Cmd+Shift+G` / `Ctrl+Shift+G` | 快速切到 Git 版本控制面板              |
| `Cmd+,` / `Ctrl+,`             | 打开系统首选项与模型设置               |

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源协议。

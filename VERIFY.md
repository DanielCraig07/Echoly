# Echoly 验证清单

> 本文件汇总本轮全部改动的**验证方式**。PLAN.md 记录「做了什么、为什么这么做」，
> 这里只回答一个问题：**每一条改动，怎么知道它真的能用。**
>
> 分三层，从便宜到贵：
>
> 1. **门禁**：四条命令，几秒钟，任何改动后都该先过这一层。
> 2. **已自动验证**：已经跑过、且可以重跑的验证，包括那些「真模型 / 真注册表 / 真文件系统」
>    的部分 —— 它们不是单测，但也不是靠人眼看，所以能随时重来一遍。
> 3. **需要真机确认**：必须在跑起来的 Electron 里点一遍的部分。沙箱内起不了 GUI，
>    这一层只能由你在本机完成。

## 1. 门禁

在仓库根目录，逐条跑（不要串成一条，否则中间失败会被后面的输出盖掉）：

| 命令                               | 期望                                 | 它拦什么                                                                                                                   |
| ---------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `npx prettier --check .`           | 全部 ok                              | 格式漂移                                                                                                                   |
| `npm run typecheck`                | 退出码 0                             | 类型错误（含各 workspace）                                                                                                 |
| `npm run lint`                     | **0 error**（会有 96 条 warning）    | `react-hooks/rules-of-hooks` 是 error，专拦「hook 写在提前 return 之后」这类只在运行时炸、typecheck 与测试都看不出来的问题 |
| `npm test`                         | **5027 passed / 139 files**          | 逻辑回归                                                                                                                   |
| `npm run build -w @echoly/desktop` | 构建成功                             | 打包期才会暴露的问题（含 runner 打包）                                                                                     |
| `npm run audit:wiring`             | `✓ 没有发现「有实现、没入口」的接线` | **「功能做了但界面上够不到」** —— 这类问题其他门禁全拦不住：代码合法、类型正确、单测全绿，只是没人调用它                   |

关于 warning：96 条全是 `no-unused-vars`（历史遗留的未使用导入/局部变量），**不是**本次改动引入的。
（数量会随「删掉一段没人读的状态」这类清理小幅下降 —— 比如 `currentExtensionId` 只被写、从来没被读过。）
这批是刻意留在 `warn` 级别的，没有批量清理 —— 逐个删未使用的代码有误删「有意留的脚手架」的风险，
收益也不对等。真要清，建议单独一个提交、并且只清未使用的 **import**。

单元测试的分布（`npm test` 会全部跑到）：

| 范围                 | 用例数 |
| -------------------- | ------ |
| apps/desktop         | 4464   |
| packages/tools       | 229    |
| packages/llm         | 126    |
| packages/agent       | 92     |
| packages/skills      | 20     |
| packages/vscode-shim | 91     |
| packages/runner      | 11     |

## 2. 已自动验证（可以随时重跑）

这些不是「写了个单测」，而是真的把东西跑起来了。任何一条怀疑失效，照最后一列重跑即可。

| 验证对象                                    | 证据                                                                                                                                                                                                                                                                                                           | 复跑方式                                                                              |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 本地语义检索（真 onnx 推理）                | 真的下载并加载 `Xenova/bge-small-zh-v1.5`，输出 **512 维、范数 1.000000**；中文查询把相关代码片段排在无关片段之前                                                                                                                                                                                              | `npm run verify:embedding`（首次下载约 25MB，之后几毫秒）                             |
| 扩展市场（真注册表）                        | 对 `open-vsx.org` 实跑 `python` / `git` 查询：搜索 200、解析 5 条，条目下载地址经 HEAD 确认是 `200 application/octet-stream`（真是 .vsix，不是 404 网页）                                                                                                                                                      | `npx vitest run packages/vscode-shim`（解析逻辑）；联网实跑见 PLAN 的 C 节记录        |
| 多根工作区（真文件系统）                    | 在临时目录上真的读写：写入落到附加文件夹、读回/exists/mkdir/remove 按文件夹路由、跨文件夹改名明确报错、移除后报错而非退回主根、持久化重开恢复                                                                                                                                                                  | `npx vitest run apps/desktop/test/workspaceMultiRoot.test.ts`                         |
| 远端 runner（真执行）                       | 起假的 OpenAI 兼容服务，runner 跑完整轮：模型给出 `write_file` 调用 → 工具真的写出文件 → 事件流 seq 连续 → meta `done`；取消（启动前 / 跑到一半）1 秒内停下且不写文件                                                                                                                                          | `npx vitest run apps/desktop/test/remoteAgentService.test.ts`（内含同样的完整链路）   |
| 远端编排层（模拟远端 = 临时目录 + 真 `sh`） | 10 项：完整跑完 / 凭据文件 0600 且结束后被删 / 未开无人值守时写操作被拒 / runner 不重复上传 / 取消 / 本地记录落盘重开仍在 / 删除                                                                                                                                                                               | 同上                                                                                  |
| 远端协议层                                  | 37 项，含**把生成的启动脚本交给真 `sh -n` 做语法校验**、拿恶意串（`'; rm -rf ~ #`、`$(whoami)`、换行）撞转义                                                                                                                                                                                                   | `npx vitest run apps/desktop/test/remoteRunnerProtocol.test.ts`                       |
| 后台任务登记簿                              | 12 项：摘要/裁剪/状态收敛只许一次/清理/落盘往返/重启把残留 running 收成 cancelled/文件损坏退化                                                                                                                                                                                                                 | `npx vitest run apps/desktop/test/backgroundJobs.test.ts`                             |
| 扩展下载与校验                              | `validateVsix` / `buildCurlArgs` 单测：小扩展（实测 693KB）必须被接受、`--http1.1` 等抗断流参数必须在位、50MB 下限只作用于 Claude Code 那条路径                                                                                                                                                                | `npx vitest run --project vscode-shim`                                                |
| Cursor Tab 跨文件上下文                     | 6 项：跨文件条目带来源文件名、按时间排序、最多带 2 个别文件、当前文件仍限最近 3 次                                                                                                                                                                                                                             | `npx vitest run apps/desktop/test/recentEdits.test.ts`                                |
| 扩展 README（真注册表实跑）                 | `Anthropic.claude-code`（平台专属构建）的 README：只拼 `/{version}/file/README.md` 是 **404**，注册表给的平台路径与 `/latest/` 都是 **200**；现在按候选顺序抓，实测取到 1467 字节正文                                                                                                                          | 见「扩展 README 的候选顺序」小节（需要联网）                                          |
| 下载进度解析（真 curl 输出）                | 实测 macOS curl 8.x：stderr 接管道时进度表**每条更新之间是 `\r` 不是 `\n`**；续传时 curl 报的总量只算剩余段（从 753664 续传 10485760 的文件，curl 报的总量是 9732096）                                                                                                                                         | `npx vitest run --project vscode-shim`（`readCurlProgress` 用的是真输出片段）         |
| 扩展激活入口（真扩展实跑）                  | `es6kr.claude-sessions`（Claude Code Sessions）：补 `window.registerCustomEditorProvider` **之前**激活失败（`... is not a function`），补上之后**激活成功**并注册了自定义编辑器 `claudeSessions.jsonlPreview`                                                                                                  | `HOME=$(mktemp -d) npm run verify:extension es6kr.claude-sessions`                    |
| vscode API 表面                             | 21 个「扩展激活早期一定会碰到」的入口逐一断言存在 + 白名单外命名空间返回 stub 而不是 undefined（shim 缺方法的后果是**整个扩展激活失败**，不是功能降级）                                                                                                                                                        | `npx vitest run --project vscode-shim`（`vscodeApi.test.ts`）                         |
| 真扩展激活（补 API 前后对照）               | 四个曾经装不上的扩展现在都跑通下载→解压→加载→**激活**：`es6kr.claude-sessions`（缺 `registerCustomEditorProvider`）、`esbenp.prettier-vscode@12`（缺 `CodeActionKind.append` / `LanguageStatusSeverity`）、`vishalguptax.claude-manager@2.21.0`（缺 `RelativePattern`）、`ShahadIshraq.vscode-claude-sessions` | `HOME=$(mktemp -d) npm run verify:extension <publisher.name>`                         |
| 目录名 ≠ 扩展 id                            | 真临时目录上跑 `ExtensionManager`：`claude-code/` 里的扩展到列表里必须是 `Anthropic.claude-code`；禁用状态按 id 落盘、重开仍生效；卸载按 id 找到真实目录并删掉同名 vsix；不存在的 id 明确失败（不是静默成功）；半截安装的目录不算已安装                                                                        | `npx vitest run apps/desktop/test/extensionManager.test.ts`                           |
| 输入框底色不再写死                          | 扫 79 个 tsx / 184 个字段标签 / 44 处内联底色，断言没有写死色值、也没有用「容器自身的底色」token（`--bg-input` / `--bg-editor` / …）                                                                                                                                                                           | `npx vitest run apps/desktop/test/fieldSurface.test.ts`                               |
| 平台专属扩展装本机那一份                    | `Anthropic.claude-code`：搜索/详情默认给的是 **alpine-arm64**，现在自动改用 **darwin-arm64**，真下载 143489KB → 解压 → 加载 → **激活成功**（扩展自己起了一个 localhost MCP server）                                                                                                                            | `HOME=$(mktemp -d) npm run verify:extension Anthropic.claude-code`（122MB，要几分钟） |

### 扩展安装链路（`npm run verify:extension [publisher.name]`）

真的从 Open VSX 下一个扩展，然后走**与主进程同一套函数**：下载 → 解压 → 加载主模块 →
在 `ExtensionHost` 里激活。默认用 `christian-kohler.npm-intellisense`（约 1.2MB）。
纯 Node 就能跑：`vscode` 模块的注入是 `Module.prototype.require` 打补丁，不需要 Electron。

它现在还顺带验「禁用 / 卸载」的前提：激活后 `ExtensionHost.listExtensionCommands()`
列出的每条命令都必须记在**这个扩展**名下（没有归属就无从摘起），
再 deactivate 一次，断言该扩展的命令与视图全部被摘干净 —— 实测：

- `es6kr.claude-sessions`：24 条命令，全部归属正确，停用后归零；
- `vishalguptax.claude-manager`：9 条命令 + 2 个视图（`claudeCodeManager.view` /
  `claudeCodeManager.secondaryView`），停用后同样归零。

这条脚本第一次跑还抓出三个真问题（都已修）：

1. `main` 不带 `.js` 的扩展加载不了主模块 —— 实测 `"./out/src/extension"` 被判成「文件不存在」，
   而这几乎覆盖所有 TypeScript 编译出来的扩展；
2. 以 ESM 发布的扩展 `import 'vscode'` 解析不到 —— require 补丁拦不住 ESM，
   现在会在扩展目录旁生成一个真的 `node_modules/vscode`（双入口 cjs + mjs）；
3. 三处失败以前只打日志：装上了、什么都没发生、界面上没有任何解释。
   现在主模块失败会记进 `LoadedExtension.mainModuleError` 并被激活流程抛出，
   安装结果返回一句 `warning`，面板会显示「已安装，但激活失败：<原因>」。

### 扩展界面（webview 视图）为什么起不来，以及现在怎么验

症状：装了 Claude Code，点「打开」之后编辑器区的标签里只看到它自己的一句
**「Claude Code couldn't load — webview/index.js could not be fetched」**。

查下来是两层原因叠在一起，都能在**纯 Node** 里复现，不需要 Electron：

1. **shim 的 `Uri.joinPath` 把路径片段丢了**（直接 `return uri`）。扩展用
   `Uri.joinPath(extensionUri, 'webview', 'index.js')` 定位自己的 bundle，拿回来的是
   扩展根目录 —— 于是 `<script src>` 指向一个目录。这一条以前是靠正则硬改 Claude 的
   src 绕过去的，而那段正则里还写死了版本号（`Anthropic.claude-code-2.1.234@darwin-arm64`），
   升级一次就失效。
2. **`file://` 加载不了 `<script type="module">`**。扩展的 bundle 基本都是 module
   script，Chromium 对 `file://` 的模块请求按 CORS 处理并拒绝；路径里的空格
   （macOS 的 `Application Support`）也没有编码。

改法（对齐 VS Code / Cursor 的做法）：注册 `echoly-webview://` 自定义协议，
`asWebviewUri` 返回协议地址，主进程的协议处理器把扩展目录里的文件端出去；
访客页面的 origin 变成 `echoly-webview://ext`，扩展自己写的
`style-src ${webview.cspSource}` 正好对上。消息也补齐了双向（页面 ↔ 扩展）。

离线可验的部分（不需要 Electron、不需要联网）：

```bash
# 地址规则 / 目录穿越 / 真实扩展目录里的 bundle 能否被解析到
npx vitest run apps/desktop/test/extensionWebview.test.ts

# 端到端：假扩展 → resolveWebviewView → 协议处理器 → 消息往返
npx vitest run apps/desktop/test/extensionManager.test.ts

# shim 的 Uri.joinPath（故障根因）
npx vitest run --project vscode-shim
```

用真实扩展跑一遍（会真的激活 Claude Code，需要临时 HOME）：把真扩展目录软链到临时
userData 下，调 `resolveWebviewView` 看生成的 HTML —— 实测输出的正是：

```
<link href="echoly-webview://ext/claudeVSCodeSidebar/webview/index.css" rel="stylesheet">
<script id="claude-panel-script" nonce="…" src="echoly-webview://ext/claudeVSCodeSidebar/webview/index.js" type="module">
Content-Security-Policy: … style-src echoly-webview://ext; font-src echoly-webview://ext; …
```

**仍然只能在真机上看的一件事**：这个页面有没有真的画出来。协议的解析 / 文件读取 /
消息往返都验过了，但「Chromium 把 `echoly-webview://` 的 module script 拉起来并执行」
只有跑起 Electron 才知道。

### 扩展 README 的候选顺序（需要联网）

`buildReadmeCandidates` 按「成功率从高到低」给三条地址，第一条拿到正文就用：

1. 注册表在详情里给的 `files.readme` —— 平台专属扩展**唯一**的正确地址，
   例如 Claude Code 是 `/api/Anthropic/claude-code/alpine-arm64/2.1.317/file/README.md`；
2. `/{version}/file/README.md` —— 通用扩展一直是这条；
3. `/latest/file/README.md` —— 注册表只为当前版本保留文件，
   平台专属扩展带上版本号（哪怕版本号是对的）会 404。

复跑（会真的去 open-vsx.org 抓一次，并把三条候选的返回码都打出来）：

```bash
npm run verify:readme                      # 默认 Anthropic.claude-code
npm run verify:readme -- ms-python.python  # 换一个通用扩展对照
```

期望：`Anthropic.claude-code` 那一次第一行就是
`200 1467 字节 …/alpine-arm64/2.1.317/file/README.md`，
而 `/{version}/file/README.md` 那条是 404。

## 3. 需要真机确认（必须在跑起来的应用里点）

先 `npm run dev` 起应用。下表每条都是「操作 → 期望 → 不对时看哪里」。

### 3.1 A 组：Agent 能力与界面

| 项目                 | 操作                                                                                                                                           | 期望                                                                                                                                                                                     | 不对时看哪里                                                                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 联网工具             | 设置页确认「联网」开着；在聊天里问一个需要查资料的问题                                                                                         | Agent 会调用 `web_search` / `fetch_url`，而不是说「我没有联网能力」                                                                                                                      | 设置页的联网开关；关掉时 Agent 应明确说「未启用」而不是给空结果                                                                                                                     |
| 内网白名单           | 设置页填一个内网主机（如 `192.168.10.241`），让 Agent 去访问它；再试一个**没在白名单**的内网地址                                               | 白名单内可访问；名单外的被拒并说明原因                                                                                                                                                   | 设置页「允许的内网主机」多行输入                                                                                                                                                    |
| `@Web` 提及          | 输入框打 `@` 看候选；选 `@Web` 后提问                                                                                                          | 输入区显示联网意图；Agent 据此去联网                                                                                                                                                     | `specialMentions` 相关单测已覆盖解析                                                                                                                                                |
| `@Docs` 文档源       | 设置页添加一个文档站点（有 `llms.txt` 的），再在聊天里 `@Docs` 提问                                                                            | 能搜索到该站点的条目并引用；没配站点时明确报「尚未配置」                                                                                                                                 | 设置页文档源列表                                                                                                                                                                    |
| 规则系统             | 在工作区放 `.echoly/rules/*.md`（含 frontmatter 的 `description` / `globs` / `alwaysApply`）                                                   | 项目记忆弹窗里能看到「当前生效规则」；`alwaysApply` 常驻、`globs` 命中的才注入                                                                                                           | 项目记忆弹窗                                                                                                                                                                        |
| Review 面板          | Agent 改完代码后按 `Cmd/Ctrl+Shift+R`                                                                                                          | 打开按文件分组的审阅面板；`J`/`K` 切文件、`Cmd+Enter` 全接受、`Esc` 关闭；展开能看到逐 hunk diff                                                                                         | 无改动时该快捷键不该被拦截                                                                                                                                                          |
| Vim 模式             | **设置 → 常规 → 快捷键方案（VS Code / IntelliJ / Vim）→ 选 Vim**                                                                               | 编辑器进入 vim 键位；右下角有模式指示；`Esc` 回 normal                                                                                                                                   | 若 `Esc` 不生效，检查「下一步编辑预测」的互斥条件                                                                                                                                   |
| 状态栏与活动栏       | 看状态栏左右两组                                                                                                                               | 间距一致、字号统一（无 11.5px 半像素）、远程会话徽标不再是一块实心蓝                                                                                                                     | 本次把内联字号也统一了，若某处仍偏小，多半是漏迁的回退文件                                                                                                                          |
| 导航前进/后退        | 在文件间跳转几次，用标题栏的 ←/→                                                                                                               | 按浏览器语义回退/前进；中途跳转截断分支                                                                                                                                                  | `navigationHistory` 单测覆盖了栈语义                                                                                                                                                |
| 底部面板             | 展开底部面板                                                                                                                                   | 原来的两行 tab 已合并为一行；不再出现重复的「终端」图标+文字                                                                                                                             | —                                                                                                                                                                                   |
| 活动栏布局           | 看左侧面板顶部那一排图标                                                                                                                       | 图标收在一个圆角容器里、**整组水平居中**、选中项是圆角高亮块                                                                                                                             | 若这一排看起来还是散着的裸图标，说明 `.activity-pill` 的样式没生效                                                                                                                  |
| 更多面板菜单         | 点活动栏末尾的 chevron                                                                                                                         | 图标条下方拉出一块菜单，列出**当前可用的全部面板**（Maven 只在 Maven 项目里出现），每行「图标 + 名字 + 快捷键 + 图钉」，当前所在那行整行高亮；点名字切换面板并关掉菜单，Esc 或点别处关闭 | 菜单里没有的面板是当前上下文里用不到的，不是漏了                                                                                                                                    |
| 固定 / 取消固定      | 在菜单里点某一行的图钉                                                                                                                         | 该面板立刻出现在活动栏图标条上（或从中消失）；图钉实色=已固定、灰色=未固定；**重开应用后保持**                                                                                           | 固定列表存在设置里（`LayoutSettings.pinnedPanels`），随其他布局一起落盘                                                                                                             |
| 面板快捷键           | 按 `⌘⇧E`（Windows/Linux `Ctrl+Shift+E`）与 `⌘⇧X`                                                                                               | 分别切到「文件」与「扩展市场」，侧栏若折叠会自动展开                                                                                                                                     | 菜单里印出来的快捷键只有 E/F/G/X 四个是真处理了的，不印假提示                                                                                                                       |
| 输入框底色（全应用） | 随便挑几个：版本控制面板的提交信息框、设置页的输入框、新建数据库连接弹窗、Maven 面板、运行配置下拉、调试面板的表达式输入、浏览器起始页的搜索框 | 每个框都**一眼看出边界**；暗色下不该有「比周围还黑的一块」，亮色下不该有「黑框 / 看不出框」。换主题再看一遍                                                                              | 全仓 40 处内联底色已按三档收敛：`--bg-elevated`（面板）/ `--bg-field`（弹窗·浮层）/ `--bg-field-inset`（编辑器表面）。别再写死色值 —— `apps/desktop/test/fieldSurface.test.ts` 会拦 |

### 3.2 B 组：补全与语义检索

| 项目                             | 操作                                                                             | 期望                                                                                     | 不对时看哪里                                                                                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 语义索引真的建起来               | 打开工作区 → 任意搜索一次（触发后台向量化）                                      | 检索面板的「语义向量 N/M 块」增长到 **N=M**                                              | 若 N 长期为 0：鼠标悬停在计数上看降级原因（模型未下载 / 加载失败 / 被环境变量关掉）。也可以用 `npm run verify:embedding` 单独确认模型这一侧没问题 |
| 语义召回                         | 搜一个**词面对不上**的问题（代码里叫 `verifySession`，你搜「在哪里刷新 token」） | 能搜到那一块                                                                             | 同上                                                                                                                                              |
| Copilot 浮层                     | 点状态栏 ✨                                                                      | **点开是浮层**（不是一点就切换），里面有开关、统计、重置                                 | —                                                                                                                                                 |
| 暂停补全是真的                   | 在浮层里点「暂停补全」，然后在编辑器里打字                                       | **真的不再发请求**（以前那个按钮只改文案）                                               | 埋点数在浮层里                                                                                                                                    |
| 多行补全 + 逐行接受              | 写到一个明显结构处（比如 `if (` 之后）                                           | 出现多行幽灵文本；悬停出现 Monaco 工具条；`Alt+Enter` 接受下一行                         | —                                                                                                                                                 |
| 下一步编辑预测                   | 浮层里打开它 → 改一处代码 → 停手一秒多                                           | **别处**出现带左侧竖线的高亮行与斜体提示；`Alt+]` 接受（`Cmd+Z` 可一步撤销）、`Esc` 忽略 | 默认关闭；幽灵补全可见时会让位给它                                                                                                                |
| **Tab 键语义（本次改动重点）**   | 上一条的提示出现后**按 Tab**                                                     | 光标跳到那一行并居中；**再按一次 Tab** 才是应用建议                                      | 见下一条                                                                                                                                          |
| **Tab 没有回归（最该盯的一条）** | 在没有上述提示的普通编辑状态下按 Tab                                             | **仍然只是缩进**，行为与改动前完全一致                                                   | 若 Tab 行为异常，看 `nextEditPrediction.ts` 里 Tab 命令的 `when` 前提（应为 `echolyNextEditVisible && !inlineSuggestionVisible`）                 |
| 跨文件上下文                     | 先在 `a.ts` 改一个标识符，再切到 `b.ts` 写下一行                                 | 补全/预测「跟着 a.ts 的改法」走                                                          | 提示词里跨文件条目会带 `[文件名]` 前缀                                                                                                            |
| 内容缓存                         | 重复「退格再打回来」                                                             | 明显更快（同一上下文不再问模型）                                                         | 浮层里的请求数不会跟着涨                                                                                                                          |

### 3.3 C 组：扩展市场 / 笔记本 / 多根 / 后台与远端任务

| 项目                         | 操作                                                                                           | 期望                                                                                                                                                              | 不对时看哪里                                                                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 扩展市场                     | **左侧竖条（活动栏）分隔线下方的拼图图标** → 面板里搜 `python`                                 | 出结果列表（真的查 Open VSX）；点安装能看到进度并激活                                                                                                             | 搜索失败只在搜索区显示原因，不设全局错误                                                                                                                      |
| 装一个**小**扩展             | 搜 `vim`（约 700KB）并安装                                                                     | 能装上并激活 —— 这条以前是坏的（通用下载器里有 50MB 下限），已修                                                                                                  | 若报「文件太小」，说明又有人把特定扩展的体积假设塞回了通用路径                                                                                                |
| 安装进度会动                 | 装 Claude Code（122MB，最能看出进度）或任意大一点的扩展，盯住行内那条进度条                    | 百分比**持续增长**，不是从头到尾一个数                                                                                                                            | 以前它只按 `\n` 切 curl 的进度表，而 curl 用 `\r` 原地刷新 —— 整段下载粘成一行，正则只在行首命中一次，于是永远停在第一个百分比                                |
| 平台专属扩展的安装           | 搜 `claude` → 点 Claude Code 那一行的「安装」                                                  | 装的是**本机平台**那一份（macOS 上是 darwin-arm64，不是注册表默认给的 alpine-arm64），装完能激活                                                                  | 日志里有 `[ExtensionManager] Anthropic.claude-code 改用 darwin-arm64 构建`；注册表没有本机构建时会退回原样并在结果里说明                                      |
| 「管理」按钮                 | 扩展面板「已安装的扩展」分区里，任一条点「管理」                                               | 在**编辑器区**打开这个扩展的详情标签（和点它的名字/图标同一个入口）                                                                                               | 以前这个按钮接的是右侧 AI 区：点**任何**一个已安装扩展都会弹出一个跟它无关的 Claude 对话面板                                                                  |
| 禁用 / 启用                  | 「已安装的扩展」分区里，任一条点「禁用」                                                       | 该行状态点变灰、文字变「已禁用」，按钮翻成「启用」；它贡献的命令从命令面板消失、视图标签打开会报「没有 provider」；**重开应用后仍是禁用**                         | 禁用状态存在 userData 的 `extensions-state.json`（不是扩展目录里，否则会被当成一个扩展）                                                                      |
| 卸载                         | 任一条点「卸载」                                                                               | 弹确认框并列出要删的 **标识符 + 版本**；确认后该行消失、本地目录被删；**同一 id 可以立刻重装**（卸载会顺手把它从禁用名单里摘掉）                                  | 卸载先 deactivate 再删文件；删不掉会把真实原因显示出来，不假装成功                                                                                            |
| 打开扩展视图                 | 装好一个**贡献了视图**的扩展（Claude Code 是最典型的一个），行内点「打开」                     | 编辑器区新开一个标签，里面是扩展自己的界面（Claude Code 会出现它自己的侧栏）。**不该**再出现「Claude Code couldn't load / webview/index.js could not be fetched」 | 没有视图的扩展不会出现这个按钮；地址是 `echoly-webview://ext/<viewId>/index.html`，由主进程的协议处理器端出                                                   |
| 扩展界面能用（不只是画出来） | 在扩展界面里点一下（Claude Code 侧栏里新建 / 切换会话）                                        | 界面**真的响应**，扩展那边也收到消息                                                                                                                              | 双向消息：页面 → 访客 preload → `extension:webview-post` → 扩展的 onDidReceiveMessage；扩展 `postMessage` → `extension:webview-message` → 页面的 message 事件 |
| 贡献的功能都在详情页         | 打开一个**已安装且启用**的扩展的详情页（点它的名字或「管理」），看右侧那一列                   | 多出「贡献的功能」区：**每个**视图一行「打开 xxxView」（不是只给第一个）、每条命令一行「标题 + 运行」。禁用的扩展不显示这一区（它已经没有视图与命令了）           | `vishalguptax.claude-manager` 有两视图 + 九命令，是最好用的对照                                                                                               |
| 命令面板里的扩展命令         | 装一个贡献了命令的扩展 → 打开顶部搜索框 → 切到「命令」模式 → 搜扩展名                          | 能看到「扩展」分类下它的命令，标题取自扩展 `package.json` 的 `contributes.commands[].title`；回车执行，失败会提示命令 id                                          | 以前这些命令注册了却没有任何界面能枚举（审计豁免里那条就是它），现在豁免已删除                                                                                |
| Claude 标签                  | 装好 Claude Code 之后看右侧面板顶部                                                            | 出现「对话 / Claude」两个标签；没装时只有一个（不出现点开是空的标签）                                                                                             | 判据是 `getLoadedExtensions` 里有 Claude Code，或收到 `claudeVSCodeSidebar` 的 `extension:webview-registered`                                                 |
| 扩展面板布局                 | 从活动栏进入「扩展市场」（图标或 `⌘⇧X`）——**它现在是左侧栏里的常驻面板，不再弹窗**             | 搜索框固定在最上，下面的分区列表自己滚；「已安装 / 推荐」两个分区各带计数胶囊、可折叠；每行是「图标 + 名称 + 统计 + 描述 + 发布者 + 右侧按钮」                    | 图标显示成首字母是正常的（注册表不通或没提供图标时的回退）                                                                                                    |
| 推荐列表                     | 刚打开面板时看「推荐」分区（不需要先搜索）                                                     | 自动拉取热门扩展并按下载量倒序；带下载量与评分；第一条是 Claude Code                                                                                              | 失败时会显示原因和「重试」，不影响「已安装」与本地 VSIX 入口                                                                                                  |
| 搜索即搜                     | 在搜索框里连着敲几个字母                                                                       | 停顿约 0.4 秒后自动出结果；按回车立即查；按 Esc 或点 × 清空并回到推荐列表                                                                                         | 结果区标题会从「推荐」变成「搜索结果」                                                                                                                        |
| 隐藏已安装                   | 点搜索框右侧的漏斗                                                                             | 变高亮，市场列表里已装过的条目被过滤掉；再点一次恢复                                                                                                              | 它只作用于市场那一侧，「已安装」分区不受影响                                                                                                                  |
| 扩展图标                     | 看推荐列表里每一条左边的图标                                                                   | 是注册表上的真实图标（主进程代理抓取后转 data URL）；抓不到时显示首字母                                                                                           | 首字母说明图标没抓到，见「已知边界」里的 CSP / 注册表说明                                                                                                     |
| 扩展详情页                   | 点任意一条扩展的**名字或图标**（不是「安装」按钮）                                             | 编辑器区打开一个 `扩展名` 标签：图标、发布者、下载量/评分、README 正文，右侧一列标识符/版本/体积/分类/资源；装完这里会提示「已安装」                              | 详情拉不到时给一句原因和「重试」，不会变成错误页                                                                                                              |
| 详情页里安装                 | 在详情页点「安装」                                                                             | 装好后左侧面板的「已安装」列表**立刻**出现它（两边靠一个 window 事件同步）                                                                                        | 若面板没刷新，看 `EXTENSION_INSTALLED_EVENT`                                                                                                                  |
| 平台专属扩展的 README        | 打开 **Claude Code**（`Anthropic.claude-code`）的详情页                                        | 能读到 README 正文；不该再出现「注册表没有提供这个扩展的说明文档」                                                                                                | 若仍为空：看主进程日志里三条候选地址的返回码（`files.readme` → `/{version}/` → `/latest/`）                                                                   |
| 详情页的 README              | 打开一个 README 里有 `<img>` / `<details>` 的扩展（如 `ms-python.vscode-python-environments`） | 正文里**不会**出现 `<img src="https://..." width=734>` 这种原文；标签被剥掉，正文干净                                                                             | 图片不显示是刻意的：README 来自任何发布者，渲染原始 HTML 等于把任意 DOM 注入渲染进程（见 services/extensionReadme）                                           |
| 内网镜像                     | 把注册表地址改成自建镜像                                                                       | 搜索走新地址                                                                                                                                                      | 注册表地址可配                                                                                                                                                |
| `.ipynb`                     | 打开一个真实的 notebook（含输出）                                                              | 以单元视图打开；**编辑并保存后输出不丢**；解析失败的文件退回纯文本编辑                                                                                            | 不执行代码（需要内核），输出按打开时原样只读展示                                                                                                              |
| 多根工作区                   | **文件树面板标题栏的「添加文件夹」按钮**（或文件树**空白处**右键 →「添加文件夹到工作区」）     | 该目录作为根节点出现；能展开、打开、保存；**重开应用后仍在**；右键该根节点可移除（磁盘文件不动）                                                                  | 已知：Git / 终端 / 索引 / 全局搜索仍只看主根                                                                                                                  |
| 后台任务（本地托管）         | 聊天里发起一个稍长的任务                                                                       | 状态栏「后台任务」徽标显示运行中计数                                                                                                                              | —                                                                                                                                                             |
| 后台任务续跑                 | 关掉窗口（macOS 下应用不退出）                                                                 | 任务继续；跑完时若应用不在前台，收到**系统通知**                                                                                                                  | 应用**退出**则会结束（这是刻意的边界）                                                                                                                        |
| 后台任务记录                 | 重开窗口 → 点开浮层                                                                            | 能看到刚跑完的任务与结果摘要                                                                                                                                      | 记录落在 userData 的 `background-jobs.json`                                                                                                                   |
| 远端环境体检                 | 连上 SSH → 打开远端工作区 → 状态栏「后台任务」→「新建远端任务」                                | 投递前会先体检；远端没 node / 版本过低 / 没连 SSH 都会**直接显示原因**                                                                                            | 失败原因就在浮层的投递表单里                                                                                                                                  |
| 远端任务（只读）             | 不勾「无人值守」投一个小任务（如「读一下 README 并总结」）                                     | 能跑完并给出摘要；**不会改远端文件**                                                                                                                              | —                                                                                                                                                             |
| 远端任务（可写）             | 勾上「无人值守」投一个会改文件的任务                                                           | 远端文件真的被改；列表里该任务的凭据标记为「带走了凭据」                                                                                                          | 结束后远端的 config 文件会被删掉（里面有 apiKey）                                                                                                             |
| 远端任务续跑                 | 投递后**关掉本机窗口**（甚至退出应用）                                                         | 任务**在远端继续跑**；重开应用后列表里能看到它的状态与结果                                                                                                        | 这是这一档的核心价值：不依赖本机进程                                                                                                                          |
| 远端任务取消                 | 对运行中的远端任务点「取消」                                                                   | 1 秒内停下，终态为「已取消」，不留半截文件                                                                                                                        | 先落 cancel 标记、再发信号，两者缺一不可                                                                                                                      |
| 隐私模式                     | 设置页打开隐私模式                                                                             | Agent 联网工具关闭；语义检索不再**联网下载**模型（已放好的本地模型仍可用）                                                                                        | 设置页有数据流向声明：哪些会出去、哪些留本机                                                                                                                  |

## 3.4 接线审计：这类问题不会再悄悄出现

`npm run audit:wiring` 检查四件事，任何一条不过就非 0 退出：

| 检查 | 内容                                                                         |
| ---- | ---------------------------------------------------------------------------- |
| A    | `ipcMain.handle` 与 `ipcRenderer.invoke` 必须一一对应（死通道 / 点了就报错） |
| B    | preload 暴露的每个方法，渲染层至少调用一次                                   |
| C    | `AppSettings` 的每个字段在界面上至少出现一次                                 |
| D    | 面板 / 标签枚举（`LeftPanel` / `BottomTab`）的每个取值都有人设置过           |

为什么值得单独做一道门禁：这一轮里，**「扩展市场」和「AI 任务看板」都是这样做完却点不到的**
—— 面板写好了、也接进了渲染，但没有任何一处把对应状态设成 `true` / 设成那个枚举值。
类型检查、单测、构建、prettier 全都不会出声，因为「没人调用」不是错误。

**允许例外，但不允许没有理由的例外。** 确实不该有入口的，要写进
`scripts/audit-ui-wiring.mjs` 的 `WAIVERS` / `SETTINGS_WAIVERS` / `PANEL_WAIVERS`，
并且写明理由 —— 理由写得出来，说明是想过的；写不出来，就说明该去补入口。

当前豁免 4 条，每条都带理由：`dapGetThreads`（调试面板暂只支持单线程）、
`autoApproveReadonlyTerminal` / `requireConfirmForWrites`（已废弃，由 permissionMode 取代）、
`LeftPanel='agent-tasks'`（AI 任务看板已实现但被有意停用，见下）。

原先的 `extensions.executeCommand` 豁免（「扩展贡献的命令没有入口」）这一轮**已删除**：
命令面板现在会列出扩展贡献的命令，缺口补上了，豁免自然就失效了 ——
这正是这套机制的用法：豁免是欠条，补上入口就得还。

**待你决定的一件事**：`AgentTaskPanel`（AI 任务看板，600 行）是**有意停用**的 ——
`App.tsx` 里有一条守卫把 `leftPanel` 从 `agent-tasks` 弹回 `explorer`。
它既不是漏了入口，也不是在正常工作。两个选择：启用（去掉守卫 + 活动栏加入口 + 真机验证），
或者删掉（连带组件一起清理）。现在保持停用，并在守卫处写明了原因与做法。

## 4. 已知边界（确定没有覆盖，不是「待测」）

这些是**设计上的取舍**，不是遗漏。列出来是为了避免你在验证时把它们当成 bug：

| 边界                            | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 远端任务的 ssh2 适配            | `execRemoteRaw` / `uploadRemoteFile` / `readRemoteFile` 三个方法本机无法验证（起不了 sshd）。编排逻辑已由「模拟远端 + 真 `sh`」完整覆盖，剩下的是薄适配                                                                                                                                                                                                                                                                                                 |
| 界面本身                        | 上表第 3 节全部 —— 沙箱里起不了 Electron，只过了构建与类型检查                                                                                                                                                                                                                                                                                                                                                                                          |
| 多根下的子系统                  | Git / 集成终端 / 代码库索引 / 全局搜索 / SSH 仍只作用于**主根**。附加文件夹只在本地工作区可用                                                                                                                                                                                                                                                                                                                                                           |
| 远端任务不自动收尾              | 跑到 `maxSteps` 上限就停，不自动续跑；不自动 commit/push，改动留在远端工作树                                                                                                                                                                                                                                                                                                                                                                            |
| 远端可用的工具更少              | 远端没有 LSP 诊断 / 代码库索引 / MCP / 文档源。这些能力对模型**明确报「不可用」**，而不是返回空结果                                                                                                                                                                                                                                                                                                                                                     |
| 笔记本不执行                    | `.ipynb` 只做编辑与保真保存，不执行（需要内核）                                                                                                                                                                                                                                                                                                                                                                                                         |
| 后台任务不是云端                | 本地托管：关窗口能继续，**退出应用会结束**                                                                                                                                                                                                                                                                                                                                                                                                              |
| lint warning                    | 97 条历史遗留的 `no-unused-vars`，见第 1 节说明                                                                                                                                                                                                                                                                                                                                                                                                         |
| 调试面板只支持单线程            | `dapGetThreads` 没有消费方，栈回溯固定用线程 1。多线程切换是独立的一件事，见审计豁免                                                                                                                                                                                                                                                                                                                                                                    |
| 一个组件仍是死代码              | `SessionDrawer.tsx` 没有被任何地方引用（应用实际用的是 `SessionModal`）。不影响功能，属于可清理项。（原先并列在这里的 `ClaudePanel.tsx` 已被泛化成 `ExtensionViewPanel` 并真正接进「打开扩展视图」那条链路，不再是死代码）                                                                                                                                                                                                                              |
| 扩展 API 覆盖度                 | shim 是一份**最小实现**，不是完整的 vscode API。缺 API 会让**整个扩展激活失败**（界面明确报「已安装，但激活失败：…」，不是静默失效）。截至本次，实测碰到过且已补齐的有：`registerCustomEditorProvider`、`CodeActionKind`（带值的类，不是字符串常量）、`LanguageStatusSeverity` + `createLanguageStatusItem`、`RelativePattern`、`Uri.with()`、`workspace.fs`、`languages` 命名空间兜底。**没有做穷举**：下一个扩展碰到新 API 仍会失败，那时按同样方式补 |
| 文件监视与查找是空实现          | `createFileSystemWatcher` / `findFiles` 收得下 `RelativePattern` 与 glob，也返回形状完整的对象，但**不会真的监听、不会真的查找**（调用时打一行日志说明）。表现：扩展装得上、激活得起来，但「文件变了自动刷新」这类行为不会发生。做真实 fs watch 是独立的一件事                                                                                                                                                                                          |
| 自定义编辑器：`option` 不抢文件 | `contributes.customEditors` 里标了 `priority: 'option'` 的那些（Office Viewer 的图片 / HTML / parquet 预览）**不会**自动接管文件，和 VS Code 一致：它们只在用户显式「打开方式」时生效。目前界面还没做「打开方式」，所以这类编辑器暂时打不开 —— 这是有意留的口子，不是 bug                                                                                                                                                                               |
| 自定义编辑器不驱动语言能力      | 扩展界面的渲染已经接通（见第 2 节），但 `languages.register*Provider`（补全/悬停/定义）仍然只收下注册、**不驱动** —— 内置编辑器里的补全与悬停还是我们自己的 LSP，不是扩展的。装一个语言扩展不会让内置编辑器多出它的补全                                                                                                                                                                                                                                 |
| 扩展宿主与 Node 同进程          | 扩展跑在主进程里（`Module.prototype.require` 打补丁注入 `vscode`），不是独立进程。一个扩展把主进程拖死会连带整个应用，这是与 VS Code 的结构性差异                                                                                                                                                                                                                                                                                                       |
| Claude Code 没有固定行          | 面板不再为 Claude Code 留专门的推荐行（按你的要求去掉）。它仍然装得上：在搜索框里搜 `claude`，打开详情页后按钮是「一键在线安装」——**走专用通道**，因为它在注册表上只有平台专属构建，走通用安装可能在 macOS 上装到 alpine 的包                                                                                                                                                                                                                           |
| ⌘⇧E 改了含义                    | 这个组合键原先也是「折叠左侧栏」的别名，现在按 VS Code 的约定给了「文件」面板；折叠左侧栏仍可用 ⌘⇧B。⌘⇧E / ⌘⇧X 现在被印在活动栏菜单里，印了就必须真的生效                                                                                                                                                                                                                                                                                               |
| 扩展面板不再是弹窗              | 改为左侧栏的常驻面板（`LeftPanel = 'extensions'`），原来的 `ExtensionModal` 与配套样式一并删除；面板内滚动只发生在列表区，搜索框不跟着滚                                                                                                                                                                                                                                                                                                                |
| 固定列表可能被过滤              | 活动栏固定的是**用户的选择**，渲染时按当前项目收敛：非 Maven 项目里固定了 Maven 也不显示，切回 Maven 项目会自己回来（设置里的 `pinnedPanels`）                                                                                                                                                                                                                                                                                                          |
| 推荐列表只收通用构建            | Open VSX 上同一个扩展可能按平台分别发布，而它的搜索接口**不按当前机器过滤**（传 targetPlatform 参数实测无效）。推荐列表里放一份装不上的构建，用户点了必然失败，所以推荐只收不带平台后缀的条目（Claude Code 走专用通道）                                                                                                                                                                                                                                 |
| 搜索仍可能给出平台专属构建      | 平台过滤只加在「推荐」上（那是我们替用户挑的）。搜索结果里仍会混有别的 OS/架构的构建，但**安装时会自动改用本机那一份**（`decidePlatformDownload` → `/api/{ns}/{name}/{os-arch}`）；注册表若没有本机构建，会照原样装并在结果里说明                                                                                                                                                                                                                       |
| 扩展视图只在注册后才可打开      | 「打开」按钮只在扩展**激活并注册了视图**之后出现（判据是 `listInstalled` 返回的 `views` 非空）。纯命令类扩展没有视图，就不摆这个按钮。视图内容由扩展自己的 provider 生成，渲染在编辑器区的 `<webview>` 里                                                                                                                                                                                                                                               |
| 扩展视图靠自定义协议提供        | 扩展界面的页面与资源走 `echoly-webview://ext/<viewId>/…`，由主进程的协议处理器端出（`file://` 加载不了 module script，见下面那节）。这条链路能离线验证到「HTML 生成 / 资源响应 / 消息往返」，但**页面真的画出来**只能在真机上看                                                                                                                                                                                                                         |
| 扩展界面在 `<webview>` 里       | 与主窗口是不同的进程、不同的 session 分区，所以主进程必须把协议**也**注册到那个分区上。改分区名时两边要一起改（串在 `@deepseek-ide/shared` 的 `EXTENSION_WEBVIEW_PARTITION`）                                                                                                                                                                                                                                                                           |
| 图标依赖注册表可达              | 图标要经主进程从配置的注册表抓取（渲染层 CSP 只放行 `data:`）。内网/离线时会全部回退成首字母头像，不影响列表与安装                                                                                                                                                                                                                                                                                                                                      |
| 活动栏展开状态不持久            | chevron 的展开/收起每次启动都重置为「收起」。数据库面板本身的位置不受影响（重开应用仍会停在原面板，此时 chevron 自动高亮提示入口在哪儿）                                                                                                                                                                                                                                                                                                                |

## 4.5 本轮（自定义编辑器接线 + 三处界面问题）

### 图 2：装了 Office Viewer，打开 .md 还是内置编辑器 —— 已接通

真扩展（`cweijan.vscode-office@4.2.3`，装在
`~/Library/Application Support/Echoly/extensions/`）实跑结论：

| 检查                                                          | 结果                                                                        |
| ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 扩展激活并注册 provider                                       | 8 个 viewType（`cweijan.markdownViewer` 等），归属 `cweijan.vscode-office`  |
| `a.md` → 选中谁                                               | `cweijan.markdownViewer`（`file:/**/*.md`，default 优先级）                 |
| `deep/nested/x.MARKDOWN` / 工作区外的 .md                     | 同上（大小写不敏感、不限工作区内）                                          |
| `a.csv` → `openCustomDocument` + `resolveCustomEditor` 那条路 | `cweijan.officeViewer`，421KB HTML 生成出来                                 |
| `a.png`（`option` 优先级）                                    | 不接管 → `null`，交回内置编辑器（有意为之）                                 |
| 生成的 HTML 里资源地址                                        | `echoly-webview://ext/editor:1/resource/markdown/index.js` 等，全部 **200** |
| 目录穿越                                                      | `../../etc/passwd` 被拒（非 200）                                           |
| 保存（`WorkspaceEdit` → `applyEdit`）                         | 真的写进磁盘（`# Edited`），不是假装成功                                    |

复跑方式：`npx vitest run apps/desktop/test/customEditorRouting.test.ts`
（用的是一个**真会激活的假扩展**，不依赖本机装没装 Office Viewer）+
`npx vitest run --project vscode-shim`（`Uri.with` / `getExtension` / `WorkspaceEdit`）。

链路上挖出来的两个真问题，一起修了：

1. **`Uri.with()` 不存在 → 界面渲染直接断。** Office Viewer 的 markdown 编辑器在
   `resolveCustomTextEditor` 里先 `uri.with({query:'',fragment:''})`，而它在调用处
   **没有 await**（扩展写的），异常不会冒到 `resolveCustomTextEditor`，只留一条
   unhandledRejection。界面上看不出任何报错，只有「装了、点了没反应」。
   → 新增 `packages/vscode-shim/src/uri.ts`（成型的 `ShimUri`），宿主造 `document.uri`
   也改用它。
2. **`extensions.getExtension()` 对任何 id 都返回假对象。** Office Viewer 在**模块顶层**
   找 `vscode.git`，假对象的 `exports.getAPI` 不是函数（`?.` 拦不住）→ TypeError，
   每次加载扩展留一条 unhandledRejection。扩展普遍写的是 `if (!git) return`，
   `undefined` 才是它们期望的分支。
   → 新增 `extensionRegistry`（`loadExtension` 读完 manifest 就登记，早于模块加载），
   `getExtension` 只认登记过的，`all` 也给真值，`exports` 换成真模块导出。

### 图 1：顶栏两个同名标签 + 编辑器里那块颜色不对

| 现象                                                         | 处理                                                                                                                                                    | 怎么确认                                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 「Claude Code for VS Code」并排出现两个（详情页 + 扩展界面） | 扩展界面标签改用**视图自己的名字**（Claude Code 是「Claude Code」），详情页仍用扩展名；「只读」徽标不再挂在虚拟标签上                                   | 真机：详情页与扩展界面各开一次，看两个标签的字                         |
| 编辑器区那块灰和主题对不上                                   | 扩展界面里的颜色全是 `var(--vscode-*)`，在 VS Code 里由宿主注入；现在渲染进程把自有 token 翻成这批变量推给主进程，由主进程以 `<link>` 注入每份扩展 HTML | 真机：切换主题，已打开的扩展界面应立刻跟着换色                         |
| Claude 的界面在**编辑器区**和**右侧面板**各出现一份          | 打开视图时若该视图已有「正式的家」（Claude 侧栏 = 右侧「Claude 扩展」标签），改为**揭示已有的那个**，不再开第二个实例（两份 webview 各自持有状态）      | 真机：扩展列表点「打开」→ 右侧面板切到 Claude 标签，编辑器区不多出标签 |

### 顺手修掉的回归：扩展界面永远转圈

抽出 `useExtensionWebview` 时，`ExtensionViewPanel` 里那段「向主进程要地址」的
`useEffect` 被一起删掉了 —— `src` 一直是空串，`<webview>` 根本没挂上来，面板永远停在
转圈上，而所有消息通道都是好的。已补回（`npm run audit:wiring` 正是靠
「preload 方法在渲染层从未被调用」把这条抓出来的：`extensionResolveWebview`
当时报的就是它）。

详情页的「贡献的功能」这一轮多了一组**「接管的文件」**：列出该扩展的
`contributes.customEditors`（界面名 + 它认的后缀）。用户问「为什么这个插件对我的 .md
没作用」时，答案就在这一行里 —— 要么它认这个后缀（那说明没接上），要么它不认。

### 第二轮补丁：两个「看起来一样、原因完全不同」的问题

**「打开」点了没反应。** 揭示右侧面板本身是对的（那是 Claude 侧栏的家），但面板**本来
就开着、本来就停在这个标签上**时，揭示等于屏幕上什么都不变 —— 看起来就是按钮坏了。
现在揭示之后面板会闪一下（`.panel-attention`，1.2 秒）作为「你要的东西在这儿」的回应；
面板本来是收起的话，展开本身就是明显的反应。不弹 toast：每次点都弹一句比没反应更烦人。

**`.md` 还是内置编辑器。** 上一轮离线验证过主进程那条链路是通的（见上表），所以问题在
「什么时候没人问主进程」。查出来是两个，都修了：

1. **会话恢复绕过了路由。** 重开应用时，上次开着的文件是「恢复」出来的，走的是
   `restoreOpenFilesForRoot`（直接 `readFile` 当文本），压根不问「这个文件归谁」。
   表现极具误导性：**同一个 .md，点文件树能出扩展编辑器，重启应用后又变回内置编辑器**。
   现在恢复也会问一次（`services/customEditorRoute.ts`，文件树与恢复共用同一个函数，
   免得两边规则再漂移）。
2. **启动竞态。** 扩展是异步加载的（不阻塞启动），而恢复会话正好落在那几百毫秒里 ——
   provider 还没注册，问题就有了答案：「没人认领」。现在 `matchCustomEditor` 在
   「有扩展声明认这个文件、但 provider 还没上来」时会等启动加载结束（上限 5 秒），
   其它情况一次都不等。回归测试见 `customEditorRouting.test.ts` 里那条
   「扩展还没注册完就问也不许判没人认领」。

已知的残留（不是 bug，但会让人困惑）：如果某个 `.md` **已经**是以普通文本标签开着的
（比如上一版应用留下来的），点文件树不会再把它换成扩展编辑器 —— 打开已有的标签是
「切前台」，不该偷偷换渲染方式。关掉那个标签再打开一次即可。

### 第三轮：扩展编辑器「一直闪」+ Claude 入口

**自定义编辑器一直在闪。** 一个典型的 effect 依赖踩坑：`ExtensionEditorView` 的
「打开面板」effect 依赖了 `onFallback`，而调用方传的是**内联箭头函数**（每次渲染都是
新的）。于是每一轮渲染后都重跑一次：重跑 = 重新 `openCustomEditor` = 新的 panelKey =
新的 state = 再渲染一轮 —— 停不下来的循环，每轮还会把上一个面板 dispose 掉。
界面上就是「编辑器一直在闪」。现在回调走 ref、不进依赖数组（依赖只剩 `filePath`），
组件对任何调用方都稳。

**Claude 的入口位置。** Claude 的界面是按**侧栏宽度**设计的，塞进编辑器区会摊成
一大片空白（截图里那个大面积留白 + 右边一条代码就是这个）。所以「用 Claude」的正确
入口是「把右侧面板切到它」，而不是开一个编辑器标签。这一轮的改动：

- 标题栏加了一个 Claude 星芒图标（只在扩展真的在场时出现），点一下把右侧面板切到
  Claude、再点一下收起 —— 与已有的 AI 面板开关同一套语义；
- 扩展列表点「打开」时**不再判断 `claudeTabAvailable` 再决定走哪条路**。那个判据本身
  会落空（扩展异步加载，启动探针可能跑在激活之前；注册事件也可能早于渲染层订阅），
  一旦判空就回退到「在编辑器区开一个扩展界面标签」—— 正是最不该去的地方。
  用户点得到「打开」就说明视图在，直接认定可用即可。

### 第四轮：Office Viewer「不生效」的真凶（这次有日志证据）

前面几轮一直在渲染层找原因，其实是**主进程的时序**问题。证据在应用自己的日志里
（`~/Library/Logs/Echoly/main.log`）：

```
15:48:04.696 [error] Error occurred in handler for 'extension:set-webview-theme':
              Error: No handler registered for 'extension:set-webview-theme'
15:48:04.697 [error] Error occurred in handler for 'extension:get-loaded':
              Error: No handler registered for 'extension:get-loaded'
15:48:04.697 [error] Error occurred in handler for 'extension:list-commands': ...
15:48:04.719 [info]  Extension Manager initialized. Extensions dir: …
```

主进程是「窗口先起来、扩展管理器 `setTimeout(…, 2000)` 之后再初始化」的，而**渲染层一
挂载就会问扩展的事**。那 2 秒里所有 `invoke` 都落到「No handler registered」上。
后果不是「晚两秒生效」，而是**又静默又持久**：

- 会话恢复问「这个文件归谁」→ 拿不到答案 → `.md` 被当成普通文本恢复；
- 之后在文件树里点它，命中「这个标签已经开着」，只是切前台 —— 于是**永远**走不到
  扩展编辑器。用户看到的就是「装了 Office Viewer 却一直不生效」。

这也解释了为什么它时好时坏：直接打开一个**没有**开着的 `.md`（且在 2 秒之后）是通的，
所以第一轮验证时它是好的；一旦那个 `.md` 被文本标签占住，就再也回不来了。

四处改动：

1. **IPC 处理器提前到管理器构造时注册**（`ExtensionManager` 构造函数），不再等
   `initialize()`。回归测试钉住了这一条：「构造完成时扩展的 IPC 处理器已经注册好了」。
2. **主进程不再延迟 2 秒**（依然 `void`，不 await，UI 不被阻塞）。
3. 渲染层兜底：`resolveCustomEditorClaim` 只在 `invoke` **抛错**（不是「查到了没人认领」）
   时按 0 / 400 / 1200 / 2500ms 重试。
4. `openFile` 的「自定义编辑器」判断挪到「这个文件已经开着」**之前**：一份**没改过**的
   过期文本标签会被就地换成扩展编辑器（改过的不动）。这样已经卡住的标签不用手动关掉
   重开 —— 直接点它就会换成 Office Viewer。

离线复验（真扩展）：管理器**构造完成时**已有 21 个 IPC 通道，`note.md` →
`cweijan.markdownViewer`，`openCustomEditor` 返回 ok。

### Claude 的界面开在编辑器区

按你的要求改成和截图一样：Claude 的界面**开在编辑器区**（和「打开」其它扩展界面同一条
路），标题栏那个星芒图标就是它的开关（开着再点一下关掉）。

顺带一个约束：打开它会**把右侧面板切回 AI 对话** —— 右侧那个「Claude 扩展」标签渲染的
是同一份 webview，两边同时活着就是你最早说的「为什么会有两个」，而且两份各自持有状态
（一边在对话，另一边还停在引导页）。手动点右侧那个标签仍然可以，只是不再由「打开 /
星芒」替你打开。

### 第五轮：Office Viewer 的按钮 + Claude 那一栏

**先说一件事实**：`~/Library/Application Support/Echoly/extensions-state.json` 里
`cweijan.vscode-office` 一度是**禁用**状态（17:22 写进去的，日志里 17:22:59 那条
`Deactivating extension` 就是它）。禁用之后它当然不再认领任何文件 —— 这是当时
「点一下就退出 md 预览」的直接原因。这一轮加了两条，让这件事**不再静默**：

- 文件被某个**已禁用**的扩展声明认领时，主进程在匹配结果里带上 `disabledClaimant`，
  界面弹一次提示：「扩展 X 已禁用，这个文件用内置编辑器打开」。回归测试钉住了
  `findDisabledClaimant`（按文件区分，别的文件不受牵连）。
- 扩展的提示（`showErrorMessage` 等）现在真的弹成 toast —— 见下。

**扩展「跟用户说话」的那几条路原来是断的。** 主进程把扩展的提示转发出去之后
**渲染层没人听**；`showOpenDialog` / `showSaveDialog` / `showQuickPick` / `withProgress`
一律 `return undefined`（等于用户点了取消）；`env.openExternal` 返回 `true` 却什么都不做。
Office Viewer 工具栏上的每个按钮最终都落在这些上面 —— 从用户视角看就是「点了没反应」。
现在这些都由宿主实现：

| 扩展调用                                                             | 现在变成                                                                                     |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `show{Information,Warning,Error}Message`                             | 渲染层的 toast（错误 / 警告 / 信息三档）                                                     |
| `showOpenDialog` / `showSaveDialog`                                  | 真的系统对话框（官方 filters → electron filters）                                            |
| `showQuickPick`                                                      | 系统消息框的按钮（扩展里绝大多数是「是 / 否」确认）                                          |
| `withProgress`                                                       | **真的把任务跑起来**（以前直接 resolve(undefined)）                                          |
| `env.openExternal`                                                   | `shell.openExternal`，真的用浏览器打开                                                       |
| `commands.executeCommand('workbench.action.files.save' / 'saveAll')` | 渲染层保存对应标签；**扩展编辑器标签跳过** —— 它的内容早由扩展写进磁盘，再写一次会把文件清空 |
| `commands.executeCommand('vscode.openWith' / 'vscode.open')`         | 用内置编辑器打开（Office Viewer 的「用 VS Code 编辑」按钮）                                  |
| `toggleDevTools` / `revealFileInOS`                                  | 主进程直接做                                                                                 |

离线复验（真扩展）：激活 → `note.md` → `cweijan.markdownViewer` → 面板打开 ok。

**右侧「Claude 扩展」那一栏。** 以前挂的是自造的 `ClaudeChatPanel` —— 一个长得像聊天框、
实际跑我们自己 Agent 的壳，跟 Claude Code 扩展没有半点关系（用户在它里面发的消息到不了
Claude）。现在它渲染的就是**扩展自己的界面**（`registerWebviewViewProvider` 给的那份，
和编辑器区「打开扩展视图」同一个组件、同一份 HTML）。那个自造组件已经删掉，连带着它
的 7 条文案和一段只属于它的样式。

标题栏的星芒图标与扩展列表的「打开」都改成**展开右侧面板并切到 Claude**，
不再在编辑器区开标签 —— 同一份 webview 只留一个实例。

### 第六轮：md 预览「点一下就退出」的真凶 + 扩展认的项目

**`ext://` 标签没被当成虚拟路径。** 这是个一石多鸟的漏判，表现却只有一句话：
「md 预览点任何一个按钮就退出」。链条是这样的：

1. 在扩展编辑器里点**任何**会改到文档的按钮（加粗、标题、链接、调色…）→ Vditor 改动内容；
2. 扩展防抖后保存 → `WorkspaceEdit` → `applyEdit` → 主进程真的写盘；
3. 写盘之后主进程按惯例广播 `fs:changed`（「文件变了，界面刷新一下」）；
4. 渲染层的刷新逻辑会拿**每个标签的路径**去 `pathExists()`，不存在的就当成
   「文件已被删除」清掉；
5. 那时 `isVirtualPath` 只认 `untitled:` / `db://` / `browser://` —— `ext://editor/…`
   不在其中，于是拿它去问磁盘，当然不存在，**把预览自己的标签关掉了**。

现在 `ext://`（详情 / 界面 / 自定义编辑器）一律算虚拟路径，上面第 4 步会跳过它。
同时区分出「一次性虚拟路径」：`ext://editor/…` 里带着文件的绝对路径，重启后还要还原成
同一个标签，所以会话的存与取用 `isEphemeralPath`（`isVirtualPath && !ext://`），
其余「有没有磁盘内容」的判断用 `isVirtualPath`。
回归测试见 `dbTabPath.test.ts` 的「扩展标签的虚拟路径判定」。

**扩展认的项目 = 用户打开的项目。** 以前扩展宿主的 workspace 是启动时按
`app.getPath('userData')` 给的、之后再也不改，而 Claude Code 认定「项目根」的依据是
**`process.cwd()`**（它内部的 `VB()` 就是 `process.cwd()`，用来初始化会话的 projectRoot）。
开发时主进程的 cwd 是**应用自己的仓库** —— 于是「让它分析我打开的项目」变成了
「分析 Echoly 自己」。

现在 `workspace:set` 会把工作区同步给扩展管理器，做三件事：

1. `workspace.workspaceFolders` 改成按当前根**现算**（以前是一次性快照）；
2. 自定义编辑器 glob 匹配的相对路径基准跟着换；
3. `process.chdir(工作区)` —— 这条最关键，Claude 的 CLI 就是这么认项目的。
   chdir 是进程级的，所以另外两处「靠 cwd 找自己资源」的地方
   （node-pty 的 spawn-helper、打包好的 runner bundle）先补上了不依赖 cwd 的候选，
   否则终端会因为找不到 spawn-helper 起不来。

离线复验（真扩展）：`setWorkspaceRoot(项目)` 之后
`workspaceFolders[0].uri.fsPath` 与 `process.cwd()` 都变成该项目，两个扩展照常激活。

### 第七轮：一条消息投递 6 次 + 「Claude 扩展」改名

**界面发回的消息被投递了 N 遍。** 主进程日志里一眼能看出来：

```
Received message from webview: {"type":"request",…,"request":{"type":"engine_ui_attach"…   ← 同一秒 6 条
Received message from webview: {"type":"request",…,"request":{"type":"webview_focused"}…  ← 同一秒 5 条
```

原因是 `resolveWebviewView` **每解析一次就往 `webviewMessageHandlers` 里再加一个回调**，
而旧界面的回调没人摘 —— 扩展那边的 Disposable 只在**停用扩展**时才 dispose，
对「界面重开一次」来说太晚了。切一次右侧标签（React 重挂载）就多一份。

扩展因此重复 attach、重复建会话，或者把重复的那几次当成冲突丢掉 —— 表现出来就是
「点了没反应」这种最难查的样子（比如点「+」不新增会话）。
现在解析视图前先把该 viewId 的旧回调清掉；渲染层也改成**保持挂载、只切显隐**，
不再因为切换标签把 Claude 的界面整个卸载重来。
回归测试：`extensionManager.test.ts` 的「重新解析视图之后，一条消息只投递一次」。

另外补了两行日志，方便下次定位「某个按钮到底有没有到主进程」：

```
[webview→扩展] claudeVSCodeSidebar: request/newSession
```

（只记类型不记载荷 —— 载荷里有对话内容。）

**「Claude 扩展」改名「Claude Code」**（右侧面板那一栏的标签）。

### 第八轮：拖动分隔条「松不开手」+ Claude 点「+」新增会话

**拖动右侧 AI 面板宽度之后，分隔条一直粘在手上。** 拖动时指针会滑到中间列的
`<webview>`（扩展界面，跑在**独立进程**里）上，那一层不把 `mousemove`/`mouseup`
交回本文档 —— window 上的 `mouseup` 永远收不到，`body.resizing` 一直挂着，
松手了还在拖、选中状态不释放。日志里那串隔几秒一条的 `engine_ui_attach` 就是它：
卡在拖动态之后，鼠标随便一动就继续改面板宽度，扩展界面被反复 resize。

现在拖动期间在整窗口盖一层透明遮罩（`.resize-shield`，渲染成 app-shell 的最后一个
子节点），指针始终命中本文档的元素；CSS 再兜底一条 `body.resizing webview{pointer-events:none}`；
另补 `window blur` / `document mouseleave` 两个兜底释放。

**Claude 面板点「+」（新会话）什么都不发生，当前对话却被清空。** 两个原因叠在一起：

1. `window.createWebviewPanel` 在 shim 里是个**空壳** —— `webview.html = …` 被丢掉、
   面板不会出现在界面上，而扩展那边已经把这次会话记成「开在面板里」，于是把侧栏清空；
2. 扩展用 `openNewInTab`（= 「这个界面是不是一个编辑器面板」）决定「+」干什么 ——
   面板模式发消息给扩展、开一个新标签；侧栏模式则**就地新建会话**（清空当前对话）。
   右侧那一栏渲染的正是侧栏那份界面，所以走的是后一条。

现在把 `WebviewPanel` 补全成真的：扩展 `createWebviewPanel` → 主进程登记 →
渲染层在右侧 AI 面板里多一个会话标签。放右侧面板而不是编辑器区，是因为用户要的就是
「AI 那一栏里多一个会话」；而且右侧面板是常驻挂载的（只切显隐），切标签不会把 webview
卸载重载 —— 编辑器区只有当前标签是活的，切走再切回来会话就没了。

布局分两行（挤在一行里分不清哪个是面板、哪个是会话）：

```
┌──────────────────────────────┐
│ AI 对话 │ Claude Code         │  ← 固定的两个「面板」
├──────────────────────────────┤
│ ＋新会话 │ 💬 NEW CHAT × │ …   │  ← 可增可减的「会话」，样式照扩展自己那条会话栏
└──────────────────────────────┘
```

第一行是固定的两个面板标签；第二行是扩展开出来的会话（气泡图标 + 名称 + ×，
当前那个亮底亮边框）。第二行左边还有一个「新会话」按钮，它调的是扩展自己注册的
`claude-vscode.newConversation` —— 会话怎么建由扩展说了算，我们不去猜。

面板和「视图」共用同一套协议与消息通道，只是多了一张「谁开的」的登记表；
资源走 `-/abs/<base64url>`（面板的 HTML 是扩展自己拼的，拿不到扩展目录）。
关标签（那个 ×）时回推 `panel.onDidDispose`，扩展才会把会话从 `sessionPanels` 里注销；
标题也会跟着扩展走（`panel.title = …` → 标签改名）—— Claude 的会话名是第一条消息
之后才生成的，不推的话几个标签永远都叫「Claude Code」。

同时把发给 Claude 侧栏那份界面的状态里 `openNewInTab` 改成 `true`（只动这一个布尔），
于是点「+」会走 `claude-vscode.editor.open` → 扩展真开一个新面板 → 右侧面板多一个标签，
侧栏那一栏（当前会话）不被清空。

离线复验（假扩展，真链路）：扩展 `createWebviewPanel` → 主进程登记 → 生成的 HTML 里
资源是协议地址且注入了 `acquireVsCodeApi` → 协议能取到 `-/abs/` 那个文件 →
界面发回的消息投到扩展的 `onDidReceiveMessage` → 改标题推给宿主 →
关面板触发 `onDidDispose`。回归测试在 `vscodeApi.test.ts` 与 `extensionManager.test.ts`。

已知边界：**禁用/卸载一个扩展时，它已经打开的面板标签不会被自动关掉**（面板的归属
没法可靠地回溯到扩展）—— 那种标签会停在一个不再响应的界面上，手动关掉即可。

### 需要你在真机上确认的

1. **完全退出应用再启动**（不是关窗口）。这几轮改了**主进程**，光靠渲染层热更新不生效。
2. **先看 Office Viewer 是不是「启用」状态**（扩展面板里那一行）。它一度被禁用过 ——
   禁用时打开 `.md` 会弹一句「扩展 … 已禁用」，照着提示启用即可。
3. 打开一个 `.md`：应由 Office Viewer 的编辑器打开（哪怕是已经开着的文本标签，也会
   就地换成扩展编辑器）。改一行、保存、关掉重开，看内容在不在；
   重启应用后它还得是扩展编辑器（这条专验会话恢复）。
4. 在 md 预览里点几个按钮：保存 / 导出 / 插入图片 / 切换主题。不该再「退出预览」；
   需要选文件或选目录的，应该真的弹出系统对话框。
5. 扩展列表点 Claude 的「打开」，或点**标题栏上的 Claude 星芒图标**：右侧面板展开并切到
   Claude 那一栏，里面是**扩展自己的界面**（不再是那个自造的聊天壳）；
   编辑器区不再多标签。星芒再点一次收起面板。
6. 切一次主题（亮/暗）：已打开的扩展界面应立刻跟着变，不再是一块对不上的灰。
7. **拖动**右栏与编辑器之间的分隔条（也可以试试左右/上下两条）：松手之后
   `resizing` 状态要立刻释放（鼠标样式回到普通箭头、再移动鼠标不该继续改宽度）。
8. 在右侧 Claude 面板里点**「+」**：右侧面板**第二行**（会话那一行）应多出一个会话
   （气泡图标 + 名称 + ×），当前那一栏的对话**不该被清空**；
   在该会话里发一条消息，等扩展生成标题，那一项的文字应跟着变。
   切到「AI 对话」再切回来，会话内容还在。点那一项的 × 能关掉它；
   关掉之后扩展那边也不该再认为它开着（再点同一会话应能重新打开）。
   第二行左边的**「新会话」**按钮应等价于点扩展界面里的「+」。

## 5. 建议顺序

1. `npm run dev` 之前先过**第 1 节门禁**（四条命令）。这一步不过，后面的现象都不可信。
2. 冒烟：能打开工作区、能开一个文件、能在聊天里问一句拿到回答、状态栏正常渲染。
   这四项挂了说明是启动级问题，不必往下测。
3. 按 **B3 → B2 → 多根 → 后台任务 → 远端任务** 的顺序测（从「影响最小、最容易回退」
   到「影响最大」）。其中 **B3 的「Tab 没有回归」和多根的「重开后仍在」最值得先看**。
4. 每组测完记一下：哪条没过、当时的操作、界面上的原话。有了这三样，
   问题基本能直接定位到代码。

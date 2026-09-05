---
name: dev-changelog
description: >-
  Maintain the project development log. Use whenever code, docs, config, or
  features are changed, fixed, added, or shipped in this workspace. After every
  update, append a timestamped entry to 开发日志.html at the repo root.
---

# 开发日志更新（dev-changelog）

## 硬性要求

每次更新都要把更新工作记录按时间戳计入开发日志中。

完成任意会改变仓库状态的工作（功能、修复、重构、依赖、配置、文档、Skills 等）后，**必须**更新工作区根目录的 `开发日志.html`，不得跳过。

## 何时执行

- 实现或修改功能后
- 修 bug / 排障后
- 调整配置、依赖、构建后
- 更新 README 或其他文档后
- 用户明确要求「记一笔」时

同一轮对话若有多处改动，可合并为**一条**日志，但须写清要点；不要只写「做了一些改动」。

## 写入位置与格式

文件：`开发日志.html`（仓库根目录）

在 `<section class="timeline" id="log">` 内**追加**一条 `<article class="entry">`（推荐插在现有条目之前，最新在上；若选择按时间顺序到底部追加也可以，保持全文一致即可）。

时间戳规则：

- 使用本地时区 **Asia/Shanghai (UTC+8)**
- `datetime` 与可见文本都写全：`YYYY-MM-DDTHH:mm:ss+08:00` / `YYYY-MM-DD HH:mm`
- 取当前真实时间，不要伪造

条目模板：

```html
<article class="entry" data-ts="YYYY-MM-DDTHH:mm:ss+08:00">
  <time datetime="YYYY-MM-DDTHH:mm:ss+08:00">YYYY-MM-DD HH:mm</time>
  <h2><span class="tag FEATURE_OR_FIX">标签</span>简短标题</h2>
  <ul>
    <li>做了什么、为什么、涉及哪些关键路径（可选）</li>
  </ul>
</article>
```

标签 class 约定：

| class            | 用途                      |
| ---------------- | ------------------------- |
| `feature`        | 新功能 / 增强             |
| `fix`            | Bug 修复                  |
| `docs`           | 文档 / 日志 / Skill 说明  |
| （无特殊 class） | 重构、杂项可用默认 `.tag` |

## 内容要求

- 标题一句话说清变更主题
- 列表 1–5 条，写「做了什么 + 关键结论」，避免空话
- 保留既有历史条目，禁止清空或改写旧时间戳内容（除非用户明确要求勘误）
- 不要把密钥、密码、内网凭证写入日志

## 完成后

确认 `开发日志.html` 已保存且新条目时间戳正确；若本轮任务就是「补日志」，补完即可结束，无需额外提交 git（除非用户要求提交）。

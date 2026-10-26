import fs from 'node:fs/promises';
import path from 'node:path';
import type { SlashCommandInfo } from '@deepseek-ide/shared';

/**
 * slash 命令的发现：把若干目录下的 Markdown 文件读成一条条 prompt 模板。
 *
 * 与 skills 的关键区别（这决定了它是独立文件而不是 skills 的一个分支）：
 *
 * - **skills 是「模型自动挑」**：按 prompt 打分、注入 top-N，用户看不见挑了什么。
 * - **命令是「用户显式点」**：名字出现在 `/` 下拉里，选中的一定被用上，不做任何打分。
 *
 * 因此这里没有任何评分逻辑，只有「扫描 + 解析 + 按名字去重」。
 * 把两者混在一个模块里，早晚会有人给命令也加上打分，于是用户输入 `/fix` 却拿到了别的模板。
 *
 * 格式与 skills 保持兼容（frontmatter 可选、`name`/`description`），因为用户往往
 * 已经写过一堆 Cursor 风格的 skill 文件，让命令格式凭空另一套是在为难他们。
 */

/** 扫描的目录，按优先级从高到低。同名命令由前面的目录胜出。 */
const COMMAND_DIRS: Array<{ rel: string; source: SlashCommandInfo['source'] }> = [
  { rel: '.echoly/commands', source: 'workspace' },
  { rel: '.cursor/commands', source: 'workspace' },
  { rel: '.deepseek/commands', source: 'workspace' },
];

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  if (!raw.startsWith('---')) return { meta: {}, body: raw.trim() };
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return { meta: {}, body: raw.trim() };
  const fm = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).trim();
  const meta: Record<string, string> = {};
  for (const line of fm.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    meta[m[1]] = m[2].replace(/^['"]|['"]$/g, '').trim();
  }
  return { meta, body };
}

/**
 * 命令名规范化。
 *
 * 规则必须与输入框的 `/` 触发解析完全一致，否则会出现「下拉里看得见、敲进去匹配不到」。
 * 允许空格会让 `/code review` 这种带参数的形式与命令名混淆，所以一律换成 `-`。
 */
export function normalizeCommandName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^\/+/, '')
    .replace(/\s+/g, '-');
}

async function loadCommandsFromDir(
  dir: string,
  source: SlashCommandInfo['source'],
): Promise<SlashCommandInfo[]> {
  const out: SlashCommandInfo[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    // 只收 .md 文件。不递归子目录：命令列表要保持扁平可扫，
    // 嵌套目录会让下拉里出现一堆需要展开才能分辨的同名项。
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
    const filePath = path.join(dir, entry.name);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const { meta, body } = parseFrontmatter(raw);
      const name = normalizeCommandName(meta.name || entry.name.replace(/\.md$/i, ''));
      if (!name) continue;
      out.push({
        name,
        // 描述缺失时退回正文首行 —— 下拉里必须有个能认出来的东西，
        // 空白描述会让用户只能靠命令名猜。
        description: meta.description || firstMeaningfulLine(body),
        body,
        source,
        path: filePath,
        origin: filePath,
      });
    } catch {
      // 单个文件读失败不该让整批命令消失
    }
  }
  return out;
}

function firstMeaningfulLine(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const t = line.replace(/^#+\s*/, '').trim();
    if (t) return t.length > 80 ? `${t.slice(0, 80)}…` : t;
  }
  return '';
}

export async function discoverCommands(options: {
  workspaceRoot?: string | null;
  userCommandsDir?: string | null;
  /** 主进程传入的原始信息，用于把 origin 显示成工作区相对路径。 */
  toDisplayPath?: (absPath: string) => string;
}): Promise<SlashCommandInfo[]> {
  const found: SlashCommandInfo[] = [];

  if (options.workspaceRoot) {
    for (const { rel, source } of COMMAND_DIRS) {
      const dir = path.join(options.workspaceRoot, rel);
      const loaded = await loadCommandsFromDir(dir, source);
      for (const c of loaded) {
        c.origin = options.toDisplayPath ? options.toDisplayPath(c.path) : rel;
      }
      found.push(...loaded);
    }
  }
  if (options.userCommandsDir) {
    const loaded = await loadCommandsFromDir(options.userCommandsDir, 'user');
    for (const c of loaded) c.origin = '用户命令目录';
    found.push(...loaded);
  }

  // 先出现的胜出：COMMAND_DIRS 已按优先级排列，用户级排在最后，
  // 于是工作区里的 `/review` 会盖掉个人的 `/review`。
  const byName = new Map<string, SlashCommandInfo>();
  for (const c of found) {
    if (!byName.has(c.name)) byName.set(c.name, c);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 把一条命令渲染成实际发给模型的内容。
 *
 * 实现放在 `@deepseek-ide/shared`：**渲染方在渲染进程**（ChatPanel 要在用户选中
 * 命令的瞬间把正文填进输入框），而这个包依赖 node:fs / node:path，
 * 让渲染进程直接引用会把 Node 内置模块打进 renderer bundle。
 * 这里只做转发，保证两边用的是同一份替换规则。
 */
export { renderCommand } from '@deepseek-ide/shared';

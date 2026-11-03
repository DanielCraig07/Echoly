#!/usr/bin/env node
/**
 * 界面接线审计：找出「功能实现了，但界面上没有入口」的东西。
 *
 * 为什么需要这个脚本：这类问题**任何一道既有门禁都拦不住**。
 * 代码是合法的、类型是对的、单测全绿、构建也能过 —— 因为「没人调用它」不是错误。
 * 直到用户来问「这个功能在哪」，才发现扩展面板已经挂了很久（`extensionPanelOpen`
 * 只有设 false 的地方，没有一处设 true）。
 *
 * 所以这里把「接线」本身当成待验证的契约，检查三件事：
 *
 * A. `ipcMain.handle` 与 `ipcRenderer.invoke` 必须一一对应。
 *    有 handler 没 invoke = 死通道；有 invoke 没 handler = 点了就报错。
 * B. preload 暴露的每个方法，渲染层至少要调用一次。**例外必须写进下面的 WAIVERS，
 *    并带上理由** —— 允许例外、但不允许「没理由的例外」，是这个检查能长期有效的前提。
 * C. AppSettings 的每个字段都要在界面上有落点（同样是带理由的例外机制）。
 *
 * 用法：npm run audit:wiring（非 0 退出码表示有问题）
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();

/** 递归收集源码文件，跳过构建产物与依赖。 */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (['node_modules', 'out', 'dist', 'release', 'coverage'].includes(entry)) continue;
      walk(full, out);
    } else if (/\.(ts|tsx|mts)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const read = (file) => readFileSync(file, 'utf8');

/**
 * 允许「渲染层不调用」的例外。
 *
 * 每条都必须能回答一个问题：**它为什么不调用是合理的？**
 * 不能回答的，就应该去补入口（或者把这段接线删掉）——而不是加到这里来。
 */
const WAIVERS = {
  // 调试面板目前只支持单线程调试（见 VERIFY.md 的已知边界）。多线程切换是独立的一件事，
  // 不是「漏了按钮」；真要做需要调试面板的线程选择器。
  dapGetThreads: '调试面板暂只支持单线程，见 VERIFY.md 已知边界',
  // 扩展自己贡献的命令，目前没有任何界面能枚举出来（缺一条「列出已注册命令」的 IPC），
  // 所以渲染层无处可调。这是既有缺口，不是本次新增的；补上它要先给扩展宿主加枚举接口，
  // 属于独立的一件事，见 VERIFY.md 已知边界。
  'extensions.executeCommand': '扩展贡献的命令暂无可执行入口（命令面板未接入扩展命令列表）',
};

/**
 * 允许「枚举里有、但没有入口」的面板。
 *
 * 这一维是补出来的：`AgentTaskPanel` 整整 600 行、也接进了渲染，
 * 但没有任何地方把 `leftPanel` 设成 `agent-tasks` —— 前两轮检查都看不见它，
 * 因为面板枚举既不是 IPC 也不是设置项。
 */
const PANEL_WAIVERS = {
  'agent-tasks': '面板已实现但被有意停用（App.tsx 里有守卫把它弹回 explorer），待决定启用还是删除',
};

/** 允许「界面上没有」的 AppSettings 字段。 */
const SETTINGS_WAIVERS = {
  providers: '旧版按 provider 存的模型配置，已被 models 取代，仅作读取兜底',
  autoApproveReadonlyTerminal: '已废弃：由 permissionMode 取代',
  requireConfirmForWrites: '已废弃：由 permissionMode 取代',
};

const mainFiles = walk(path.join(root, 'apps/desktop/src/main'));
const preloadFiles = walk(path.join(root, 'apps/desktop/src/preload'));
const rendererFiles = walk(path.join(root, 'apps/desktop/src/renderer/src'));
const testFiles = walk(path.join(root, 'apps/desktop/test'));
const allFiles = [...mainFiles, ...preloadFiles, ...rendererFiles, ...testFiles];

const problems = [];
const notes = [];

// ── A. IPC 通道一一对应 ────────────────────────────────────────────────────
const handles = new Set();
for (const file of mainFiles) {
  for (const m of read(file).matchAll(/ipcMain\.handle\(\s*['"`]([^'"`]+)['"`]/g))
    handles.add(m[1]);
}
const invokes = new Set();
for (const file of allFiles) {
  for (const m of read(file).matchAll(/ipcRenderer\.invoke\(\s*['"`]([^'"`]+)['"`]/g)) {
    invokes.add(m[1]);
  }
}
for (const channel of handles) {
  if (!invokes.has(channel)) problems.push(`[A] IPC 通道没有任何 ipcRenderer.invoke：${channel}`);
}
for (const channel of invokes) {
  if (!handles.has(channel)) problems.push(`[A] ipcRenderer.invoke 没有对应的 handler：${channel}`);
}

// ── B. preload 方法必须在渲染层被调用 ──────────────────────────────────────
const preload = read(path.join(root, 'apps/desktop/src/preload/index.ts'));
const apiStart = preload.indexOf('const api: IpcApi = {');
const apiEnd = preload.indexOf('\nconst ', apiStart + 10);
const apiBody = preload.slice(apiStart, apiEnd);
const apiKeys = [...apiBody.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]);

/**
 * `extensionBridge.ts` 走 `contextBridge.exposeInMainWorld('extensions', …)`，
 * 是**另一套** preload 对象，结构上不在 `api` 里 —— 最早那版审计只看 `index.ts`，
 * 于是扩展那一整块（installClaudeCode / loadFromPath / searchMarketplace…）
 * 从来没被这道检查覆盖过。这里把它一并收进来：那一块的入口本来就最容易丢。
 */
const bridge = read(path.join(root, 'apps/desktop/src/preload/extensionBridge.ts'));
const bridgeStart = bridge.indexOf('export function createExtensionAPI()');
const bridgeBody = bridge.slice(bridgeStart);
const bridgeKeys = [...bridgeBody.matchAll(/^ {4}(?:async )?([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm)].map(
  (m) => m[1],
);
for (const key of bridgeKeys) apiKeys.push(`extensions.${key}`);

const rendererText = rendererFiles.map(read).join('\n');
const mainText = mainFiles.map(read).join('\n');
for (const key of apiKeys) {
  // `extensions.foo` 这种带点的键要整体匹配，否则 `.foo` 会被 extensions 面板之外的
  // 同名方法（比如某个 `.getName()`）误判成「已经调用过」。
  // 可选链也要算：「调用了」跟写成 `extensions.onMessage` 还是 `extensions?.onMessage`
  // 没有关系，但后者少了 `?.` 的正则会漏判 —— 这正是扩展事件那两条被漏掉的原因。
  const keyPattern = key.includes('.')
    ? new RegExp(`\\b${key.split('.').join('\\??\\.')}\\b`)
    : new RegExp(`\\.${key}\\b`);
  if (keyPattern.test(rendererText)) continue;
  if (WAIVERS[key]) {
    notes.push(`[B] ${key}：未在渲染层调用（已豁免：${WAIVERS[key]}）`);
    continue;
  }
  const where = keyPattern.test(mainText) ? '（只在主进程里出现）' : '（全仓只出现在 preload）';
  problems.push(`[B] preload 方法在渲染层从未被调用：${key} ${where}`);
}

// ── C. AppSettings 字段必须有界面落点 ──────────────────────────────────────
const shared = read(path.join(root, 'packages/shared/src/index.ts'));
const ifaceStart = shared.indexOf('export interface AppSettings {');
const ifaceEnd = shared.indexOf('\n}', ifaceStart);
const ifaceBody = shared.slice(ifaceStart, ifaceEnd);
const settingsFields = [...ifaceBody.matchAll(/^ {2}([a-zA-Z_][a-zA-Z0-9_]*)\??:/gm)].map(
  (m) => m[1],
);
for (const field of settingsFields) {
  if (new RegExp(`\\b${field}\\b`).test(rendererText)) continue;
  if (SETTINGS_WAIVERS[field]) {
    notes.push(`[C] ${field}：界面上没有（已豁免：${SETTINGS_WAIVERS[field]}）`);
    continue;
  }
  problems.push(
    `[C] AppSettings.${field} 在渲染层从未出现，可能是一个「有配置项、没有界面」的字段`,
  );
}

// ── D. 面板 / 标签枚举必须有人设置它 ────────────────────────────────────────
//
// 「值存在、组件也渲染了、就是没有入口」是最难发现的一类：类型是对的、代码是活的，
// 只有真去点才发现够不着。这里直接拿 union 的取值列表去比对「谁把它设过」。
function checkEnum(unionName, setterName, waiverPrefix) {
  const appText = read(path.join(root, 'apps/desktop/src/renderer/src/App.tsx'));
  const unionMatch = appText.match(new RegExp(`type ${unionName} = ([^;]+);`));
  if (!unionMatch) return;
  const values = [...unionMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const setterTargets = new Set(
    [...appText.matchAll(new RegExp(`${setterName}\\(\\s*'([^']+)'`, 'g'))].map((m) => m[1]),
  );
  for (const value of values) {
    if (setterTargets.has(value)) continue;
    const key = `${waiverPrefix}${value}`;
    if (PANEL_WAIVERS[key] || PANEL_WAIVERS[value]) {
      notes.push(
        `[D] ${unionName} = '${value}'：没有入口（已豁免：${PANEL_WAIVERS[key] ?? PANEL_WAIVERS[value]}）`,
      );
      continue;
    }
    problems.push(`[D] ${unionName} 的取值 '${value}' 没有任何地方设置过 —— 面板做完了却点不到`);
  }
}

checkEnum('BottomTab', 'setBottomTab', 'BottomTab:');

// ── D2. 左侧面板：数据驱动之后的入口判定 ────────────────────────────────────
//
// 活动栏与「更多面板」菜单现在都从 LEFT_PANEL_DEFS 渲染，App.tsx 里不再有
// `setLeftPanel('explorer')` 这种字面量 —— 直接沿用上面那套会**全部误报成没有入口**。
// 所以左侧面板这一维单独判：一个取值算「够得着」，要么 App.tsx 里显式设过它，
// 要么它在面板定义表里且没被标 hidden（表里每一条都会渲染成菜单里可点的一行）。
//
// 联合类型改成从 shared 读（面板 id 进了 LayoutSettings）；**读不到就直接失败**，
// 不能像原来那样 `return` —— 那种「悄悄什么都没检查」正是这道审计要防的事。
function leftPanelIdValues() {
  const sharedText = read(path.join(root, 'packages/shared/src/index.ts'));
  const m = sharedText.match(/export type LeftPanelId =([^;]+);/);
  if (!m) return null;
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

function panelDefsFromTable() {
  const text = read(path.join(root, 'apps/desktop/src/renderer/src/services/leftPanels.ts'));
  const start = text.indexOf('export const LEFT_PANEL_DEFS');
  if (start < 0) return null;
  const body = text.slice(start, text.indexOf('];', start));
  const reachable = new Set();
  const hidden = new Set();
  // 每个 `id: 'x'` 开始一段，直到下一个 id —— 段内的 hidden:true 属于这一条
  for (const chunk of body.split(/(?=\bid:\s*')/).slice(1)) {
    const id = chunk.match(/id:\s*'([^']+)'/)?.[1];
    if (!id) continue;
    // 不要求 hidden 独占一行：表被 prettier 压成一行时，用「行首」去判会漏，
    // 而漏判的后果是「hidden 的面板」被算成可达 —— 这道检查就白做了。
    (/\bhidden:\s*true/.test(chunk) ? hidden : reachable).add(id);
  }
  return { reachable, hidden };
}

{
  const values = leftPanelIdValues();
  const defs = panelDefsFromTable();
  const appText = read(path.join(root, 'apps/desktop/src/renderer/src/App.tsx'));
  const explicit = new Set([...appText.matchAll(/setLeftPanel\(\s*'([^']+)'/g)].map((m) => m[1]));
  if (!values) {
    problems.push('[D] 读不到 LeftPanelId 联合类型（shared/src/index.ts）—— 这一维没有真的在检查');
  } else if (!defs) {
    problems.push('[D] 读不到 LEFT_PANEL_DEFS（services/leftPanels.ts）—— 这一维没有真的在检查');
  } else {
    for (const value of values) {
      if (explicit.has(value) || defs.reachable.has(value)) continue;
      const key = `LeftPanel:${value}`;
      if (PANEL_WAIVERS[key] || PANEL_WAIVERS[value]) {
        notes.push(
          `[D] LeftPanel = '${value}'：没有入口（已豁免：${PANEL_WAIVERS[key] ?? PANEL_WAIVERS[value]}）`,
        );
        continue;
      }
      if (defs.hidden.has(value)) {
        problems.push(
          `[D] LeftPanel 的取值 '${value}' 在面板表里被标成 hidden 且别处没人设置它 —— 那它就真的进不去`,
        );
        continue;
      }
      problems.push(
        `[D] LeftPanel 的取值 '${value}' 既不在面板表里、也没人 setLeftPanel —— 面板做完了却点不到`,
      );
    }
  }
}

// ── 报告 ───────────────────────────────────────────────────────────────────
console.log(
  `接线审计：IPC handler ${handles.size} 个 / invoke ${invokes.size} 个 / preload 方法 ${apiKeys.length} 个 / 设置字段 ${settingsFields.length} 个`,
);
if (notes.length) {
  console.log('\n已豁免：');
  for (const note of notes) console.log('  ', note);
}
if (problems.length) {
  console.log(`\n✗ 发现 ${problems.length} 处接线问题：`);
  for (const problem of problems) console.log('  ', problem);
  console.log('\n  处理方式二选一：补上入口（界面能点到），或者删掉这段接线（不再暴露）。');
  console.log('  确实不该有入口的，在 scripts/audit-ui-wiring.mjs 的 WAIVERS 里写明理由。');
  process.exit(1);
}
console.log('\n✓ 没有发现「有实现、没入口」的接线');

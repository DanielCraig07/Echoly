import type { WorkspaceBackend } from './backend.js';
import type { FileMutation, PathSnapshot } from './index.js';

/**
 * 撤销一轮 AI 改动的回放逻辑。
 *
 * 为什么放在 tools 而不是主进程：它唯一的依赖是 `WorkspaceBackend`，而
 * 「逆序回放、跳过冲突、如实报告」这套判断是纯逻辑，放在这里能直接跑单测 ——
 * 撤销是那种「写错了会静默吃掉用户代码」的功能，靠手工点一遍来验证是不够的。
 */

export interface RevertResult {
  /** 真正恢复的路径。 */
  reverted: string[];
  /**
   * 因为没有记录而跳过的路径（例如写入了二进制无法留底、或宿主未开记录）。
   * 与 `conflicts` 分开，是因为两者对用户的含义不同：一个是「我们没记全」，
   * 一个是「你后来自己改过」，处理动作也不一样（前者重跑，后者手工合并）。
   */
  skipped: Array<{ path: string; reason: string }>;
  /** 与记录不符、为避免覆盖用户改动而跳过的路径。 */
  conflicts: string[];
}

async function readIfExists(backend: WorkspaceBackend, relPath: string): Promise<string | null> {
  try {
    if (!(await backend.exists(relPath))) return null;
  } catch {
    return null;
  }
  try {
    return await backend.readFile(relPath);
  } catch {
    return null;
  }
}

/**
 * 路径当前是否被占用（文件**或目录**都算）。
 *
 * 与 `readIfExists` 分开是必要的：目录能通过 `exists` 却读不出内容，
 * 若用「读到 null 就当作不存在」，撤销一次删除时会把旧文件直接盖进一个已经重建的同名目录里。
 */
async function pathOccupied(backend: WorkspaceBackend, relPath: string): Promise<boolean> {
  try {
    return await backend.exists(relPath);
  } catch {
    return false;
  }
}

async function restoreSnapshot(backend: WorkspaceBackend, snapshot: PathSnapshot): Promise<void> {
  // dirs 按层级升序排列（父在前），逐个确保存在；再写文件，写文件本身也会补父目录，
  // 但空目录不会有文件，必须显式建出来，否则撤销后目录结构少一层。
  for (const dir of snapshot.dirs) {
    try {
      await backend.mkdir(dir);
    } catch {
      // 已存在或无权限：继续尝试写文件，失败会在 files 阶段被记录
    }
  }
  for (const file of snapshot.files) {
    await backend.writeFile(file.path, file.content);
  }
}

/**
 * 逆序回放一轮的写前记录。
 *
 * **必须逆序**：同一文件在一轮里可能被写多次（读 → 改 → 再改），只有从最后一次往前回放，
 * 第一次的 `original` 才会在最后落到磁盘上。正序回放会把中间态留在文件里。
 *
 * 冲突检测：写入类记录带着当时写进去的 `written`。若磁盘现在的既不是 `written` 也不是
 * `original`，说明这段内容在本轮之后被人（用户、格式化工具、另一个 Agent）动过。
 * 这种情况下覆盖会静默吞掉那笔改动，所以跳过并报告，交给用户决定。
 */
export async function revertMutations(
  backend: WorkspaceBackend,
  mutations: FileMutation[],
): Promise<RevertResult> {
  const result: RevertResult = { reverted: [], skipped: [], conflicts: [] };
  const revertedSet = new Set<string>();

  for (let i = mutations.length - 1; i >= 0; i--) {
    const m = mutations[i];
    try {
      if (m.kind === 'write') {
        const current = await readIfExists(backend, m.path);
        if (
          m.written !== null &&
          current !== null &&
          current !== m.written &&
          current !== m.original
        ) {
          result.conflicts.push(m.path);
          continue;
        }
        if (m.original === null) {
          // 本轮新建的文件：撤销即删除。已经不存在了就当作已还原。
          if (current !== null) await backend.remove(m.path);
        } else {
          await backend.writeFile(m.path, m.original);
        }
        revertedSet.add(m.path);
      } else if (m.kind === 'delete') {
        if (!m.snapshot) {
          result.skipped.push({ path: m.path, reason: '删除时未能留底，内容无法恢复' });
          continue;
        }
        // 先检查目标位置有没有被别的东西占住：撤销不该覆盖撤掉之后新建的内容
        if (await pathOccupied(backend, m.path)) {
          result.conflicts.push(m.path);
          continue;
        }
        await restoreSnapshot(backend, m.snapshot);
        revertedSet.add(m.path);
      } else if (m.kind === 'move') {
        // move 的逆操作要求目标还在原位；不在了就说明用户后来又动过它
        if (!(await pathOccupied(backend, m.to))) {
          result.conflicts.push(m.to);
          continue;
        }
        if (await pathOccupied(backend, m.from)) {
          // 原位置已被占：移回去会覆盖，跳过
          result.conflicts.push(m.from);
          continue;
        }
        await backend.rename(m.to, m.from);
        revertedSet.add(m.from);
      } else {
        result.skipped.push({ path: m.path, reason: m.reason });
      }
    } catch (err) {
      result.skipped.push({
        path: m.kind === 'move' ? m.from : m.path,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  result.reverted = [...revertedSet];
  return result;
}

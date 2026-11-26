/**
 * 一步里多处文件改动的「合并确认」。
 *
 * 权限模式是 `ask` 时，每个写文件的工具都会各自发一次 `confirm_request`。
 * 一条回复改五个文件，用户就要点五次「允许」—— 而这五次说的是同一件事：
 * 「这条回复的这批改动，你同意吗？」。逐条弹窗还带来一个更实际的问题：
 * 用户点到第三个时已经不看内容了，确认失去了它本来的意义。
 *
 * 这里的做法是**在执行这批工具之前**先把它们会碰的路径收出来，合成一次询问，
 * 之后每条工具自己的询问由 `BatchApprovalGate` 直接放行（或直接拒绝），
 * 所以 「同意」与「拒绝」都是整批一致的，且工具层不需要知道合并这回事。
 *
 * 刻意只合并**文件路径**类的确认：终端命令各有各的风险（一条 `rm -rf` 与一条
 * `npm test` 不该共享一个答案），MCP 工具的作用范围取决于它连的系统，
 * 更不该混进「改这几个文件」的那一句里。
 */

/**
 * 参与合并确认的工具，以及它们在参数里表示路径的字段。
 *
 * **只有写入类**（`write_file` / `apply_patch`）在此列：`delete_path` 与
 * `move_path` 刻意留在外面。它们也能被「一次回复改了好几个文件」带上，
 * 但删文件与改文件的风险不是一回事 —— 把一条删除混进「本轮将改动 N 个文件」
 * 的同意框里，用户按下的是「改」，实际发生了「删」。
 *
 * 导出是为了让测试盯住这张表：新加一个写入工具却忘了登记，表现是它照常单独
 * 弹一次确认 —— 不会坏，只是「这次回复的所有改动一次同意」悄悄漏掉一个文件。
 */
export const BATCH_CONFIRM_PATH_FIELDS: Readonly<Record<string, string>> = {
  write_file: 'path',
  apply_patch: 'path',
};

export interface BatchToolCall {
  name: string;
  /** 原生 tool_calls 里是 JSON 字符串；测试与降级解析可能直接给对象。 */
  args: unknown;
}

/** 与 `PendingDiff.path` 同一套归一化：反斜杠转正斜杠、大小写不敏感。 */
export function normalizeConfirmPath(input: string): string {
  return (input ?? '').replace(/\\/g, '/').toLowerCase();
}

function argsObject(args: unknown): Record<string, unknown> {
  if (args && typeof args === 'object') return args as Record<string, unknown>;
  if (typeof args !== 'string' || !args.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(args);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    // 参数写坏的工具执行时会自己报错；这里不重复报，只是收不到路径。
    return {};
  }
}

/**
 * 收出这批工具调用会碰的、需要确认的文件路径（去重，保留首次出现次序）。
 *
 * 顺序保留 Agent 的改动次序而不是排序：确认清单读起来应当和它接下来的动作一致。
 * 少于两个路径时返回空 —— 只有一个文件时本来就只有一次询问，合并没有意义，
 * 而且会白白多一次「先问一遍、再逐条问」的重复。
 */
export function collectBatchWritePaths(toolCalls: readonly BatchToolCall[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const call of toolCalls) {
    const field = BATCH_CONFIRM_PATH_FIELDS[call.name];
    if (!field) continue;
    const raw = argsObject(call.args)[field];
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const path = raw.replace(/\\/g, '/');
    const key = normalizeConfirmPath(path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out.length >= 2 ? out : [];
}

/**
 * 合并确认的结论，供逐条确认时查表。
 *
 * **同意**在这一轮里一直有效：用户批准的是「这轮改这几个文件」，模型随后在同一轮里
 * 再微调同一批文件仍属于那个范围。若每次用完就作废，模型每修一次就再弹一次窗，
 * 等于没合并。
 *
 * **拒绝**只对这一次尝试有效（取走即清）：模型换个写法重试同一个文件时，
 * 应当再问一次 —— 把一次拒绝当成整轮的永久封条，用户就再也没有机会在看到
 * 新方案之后改口。
 *
 * 只记**路径**，不记「允许一切」：这一轮里冒出来的新文件仍然会单独询问。
 */
export class BatchApprovalGate {
  private approved = new Set<string>();
  private rejected = new Set<string>();

  /** 记下一批路径的结论。 */
  resolve(paths: readonly string[], accepted: boolean): void {
    for (const path of paths) {
      const key = normalizeConfirmPath(path);
      if (accepted) {
        this.rejected.delete(key);
        this.approved.add(key);
      } else {
        this.approved.delete(key);
        this.rejected.add(key);
      }
    }
  }

  /**
   * 查这条路径是否已被合并确认处理过。
   *
   * 返回 `null` 表示「没问过，照常问用户」；`true` / `false` 表示直接采纳结论。
   */
  take(path: string | undefined): boolean | null {
    if (!path) return null;
    const key = normalizeConfirmPath(path);
    if (this.approved.has(key)) return true;
    if (this.rejected.delete(key)) return false;
    return null;
  }

  clear(): void {
    this.approved.clear();
    this.rejected.clear();
  }

  /**
   * 进入新的一步：把上一步没被消费掉的「拒绝」作废。
   *
   * 拒绝只在它被给出的那一步里有效。若某个写工具在走到确认之前就失败了
   * （比如 apply_patch 的 old_text 不唯一），那条拒绝没人消费；留着它会让
   * 下一步对同一个文件的写入被**静默**驳掉 —— 用户根本没看到任何询问。
   *
   * 「同意」不在此列：用户批准的是这一轮这几个文件，见类注释。
   */
  beginStep(): void {
    this.rejected.clear();
  }

  /**
   * 这批路径里还没被问过的那些。
   *
   * 后续步骤里再次出现的已同意文件不该被重新问一遍 —— 那正是「合并」要消除的打扰。
   * 只读查询，不消耗任何结论。
   */
  pending(paths: readonly string[]): string[] {
    return paths.filter((path) => {
      const key = normalizeConfirmPath(path);
      return !this.approved.has(key) && !this.rejected.has(key);
    });
  }
}

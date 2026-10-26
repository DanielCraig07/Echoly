/**
 * 差异统计：给出 `+N / -M` 两个数字，用于聊天气泡里的改动摘要。
 *
 * 从 `ChatPanel.tsx` 搬出来（那份文件四千多行），因为它与 React、与组件状态
 * 都无关，只是一个文本函数 —— 混在组件里既没法单测，也让「气泡上那两个数字
 * 是怎么来的」需要翻很远才能找到。
 *
 * 算法是**逐行配对**而不是真 LCS：两万行的文件做 DP 会把主线程卡住，
 * 而这里只需要一个大致准确的行数，不需要精确到每一个 hunk。
 */

export interface LineDiffStats {
  added: number;
  deleted: number;
}

export function computeLineDiffStats(original?: string, modified?: string): LineDiffStats {
  const origText = original ?? '';
  const modText = modified ?? '';
  if (!origText) {
    // 新建文件：按非空行数算，全空行时给 1（显示 `+0` 会让人以为没写进去）
    const lines = modText.split(/\r?\n/).filter((l) => l.trim().length > 0);
    return { added: lines.length || 1, deleted: 0 };
  }
  if (!modText) {
    const lines = origText.split(/\r?\n/).filter((l) => l.trim().length > 0);
    return { added: 0, deleted: lines.length || 1 };
  }

  const origLines = origText.split(/\r?\n/);
  const modLines = modText.split(/\r?\n/);

  let added = 0;
  let deleted = 0;
  let oi = 0;
  let mi = 0;

  while (oi < origLines.length || mi < modLines.length) {
    if (oi < origLines.length && mi < modLines.length && origLines[oi] === modLines[mi]) {
      oi++;
      mi++;
    } else {
      // 向两侧找「下一处能对齐的行」，取更近的那个方向先把差异记上。
      // 这就是它便宜的原因：只做 indexOf，不做 O(n·m) 的 DP。
      const findOrig = origLines.indexOf(modLines[mi], oi);
      const findMod = modLines.indexOf(origLines[oi], mi);

      if (findOrig !== -1 && (findMod === -1 || findOrig - oi <= findMod - mi)) {
        deleted += findOrig - oi;
        oi = findOrig;
      } else if (findMod !== -1) {
        added += findMod - mi;
        mi = findMod;
      } else {
        if (oi < origLines.length) {
          deleted++;
          oi++;
        }
        if (mi < modLines.length) {
          added++;
          mi++;
        }
      }
    }
  }

  return { added, deleted };
}

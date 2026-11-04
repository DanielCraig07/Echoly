/**
 * 编辑器与差异视图用的**纯文本比较**工具：行级 diff、hunk 切分、行内词级 diff。
 *
 * 从 `EditorPane.tsx`（七千多行）搬出来。这些函数不依赖 Monaco、不依赖 React、
 * 输入输出都是字符串与数组 —— 混在组件文件里既不能被单测直接 import，
 * 也让「这个文件到底在渲染什么」变得难读。
 *
 * 算法都是朴素的 LCS：先掐掉首尾相同的行，只对中间真正不同的那一段做 DP，
 * 于是「改一行」这类常见情况的代价与文件长度无关。
 */

export interface GitLineDiff {
  type: 'added' | 'modified' | 'deleted';
  startLine: number;
  endLine: number;
}

/**
 * 按行切分，**空文本切成零行**。
 *
 * 直接 `text.split('\n')` 会把空文件切成 `['']` —— 一行「空行」。后果是下面
 * `subN === 0` / `subM === 0` 这两个「纯新增 / 纯删除」分支**永远走不到**：
 * 把一个文件清空会被报成「第 1 行被修改」，而不是「这些行被删除」。
 * 空文件里没有行，这是一个纯粹的实现细节泄漏到判断里。
 */
function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.replace(/\r/g, '').split('\n');
}

export function computeLineDiffs(originalText: string, modifiedText: string): GitLineDiff[] {
  const origLines = splitLines(originalText);
  const modLines = splitLines(modifiedText);

  const N = origLines.length;
  const M = modLines.length;

  let start = 0;
  while (start < N && start < M && origLines[start] === modLines[start]) {
    start++;
  }

  let origEnd = N - 1;
  let modEnd = M - 1;
  while (origEnd >= start && modEnd >= start && origLines[origEnd] === modLines[modEnd]) {
    origEnd--;
    modEnd--;
  }

  const subOrig = origLines.slice(start, origEnd + 1);
  const subMod = modLines.slice(start, modEnd + 1);

  const subN = subOrig.length;
  const subM = subMod.length;

  const diffs: GitLineDiff[] = [];

  if (subN === 0 && subM === 0) {
    return diffs;
  }

  if (subN === 0 && subM > 0) {
    diffs.push({
      type: 'added',
      startLine: start + 1,
      endLine: start + subM,
    });
    return diffs;
  }

  if (subN > 0 && subM === 0) {
    diffs.push({
      type: 'deleted',
      startLine: Math.max(1, start),
      endLine: Math.max(1, start),
    });
    return diffs;
  }

  // Standard DP LCS for the sub-range
  const dp: number[][] = Array.from({ length: subN + 1 }, () => new Array(subM + 1).fill(0));
  for (let i = 1; i <= subN; i++) {
    for (let j = 1; j <= subM; j++) {
      if (subOrig[i - 1] === subMod[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  let i = subN;
  let j = subM;
  type DiffOp = { type: 'equal' | 'added' | 'deleted'; origIdx: number; modIdx: number };
  const ops: DiffOp[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && subOrig[i - 1] === subMod[j - 1]) {
      ops.push({ type: 'equal', origIdx: i - 1, modIdx: j - 1 });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: 'added', origIdx: i, modIdx: j - 1 });
      j--;
    } else {
      ops.push({ type: 'deleted', origIdx: i - 1, modIdx: j });
      i--;
    }
  }

  ops.reverse();

  // Group consecutive non-equal ops into hunks
  let k = 0;
  while (k < ops.length) {
    if (ops[k].type === 'equal') {
      k++;
      continue;
    }

    let delCount = 0;
    let addCount = 0;
    const hunkStartMod = ops[k].modIdx;
    let firstModIdx = -1;
    let lastModIdx = -1;

    while (k < ops.length && ops[k].type !== 'equal') {
      if (ops[k].type === 'deleted') {
        delCount++;
      } else if (ops[k].type === 'added') {
        addCount++;
        if (firstModIdx === -1) firstModIdx = ops[k].modIdx;
        lastModIdx = ops[k].modIdx;
      }
      k++;
    }

    if (delCount > 0 && addCount > 0) {
      diffs.push({
        type: 'modified',
        startLine: start + (firstModIdx >= 0 ? firstModIdx : hunkStartMod) + 1,
        endLine: start + (lastModIdx >= 0 ? lastModIdx : hunkStartMod) + 1,
      });
    } else if (addCount > 0) {
      diffs.push({
        type: 'added',
        startLine: start + firstModIdx + 1,
        endLine: start + lastModIdx + 1,
      });
    } else if (delCount > 0) {
      const lineNum = Math.min(M, Math.max(1, start + hunkStartMod + 1));
      diffs.push({
        type: 'deleted',
        startLine: lineNum,
        endLine: lineNum,
      });
    }
  }

  return diffs;
}

export interface LineChangeCounts {
  additions: number;
  deletions: number;
}

/**
 * 「加了多少行、删了多少行」—— 改动卡片上那两个 `+N -M`。
 *
 * 和 `computeLineDiffs` 同一套思路（掐掉首尾相同的行，只算中间真正不同的那一段），
 * 但用途不同：这里**只要两个数字**，不要行号。而 LCS 的结论本来就只需要一个长度：
 * 一次 diff 恰好是 `n - lcs` 行删除 + `m - lcs` 行新增，于是 DP 只用两行滚动数组，
 * 内存与文件长度无关。
 *
 * 为什么还要给一个大文件的退路：这东西挂在**每一次外部改动**的卡片上，代理一次
 * 动手可能就是几万行的文件，`O(n*m)` 的 DP 会把渲染线程卡住。超过阈值就退化成
 * 「按行做多重集合差」：仍然报「加了几行、删了几行」，只是被**移动**的行会算成
 * 一次删 + 一次增（量级和方向都对得上，只是不是最小编辑距离）。
 */
export function countLineChanges(originalText: string, modifiedText: string): LineChangeCounts {
  const orig = splitLines(originalText);
  const mod = splitLines(modifiedText);

  let start = 0;
  while (start < orig.length && start < mod.length && orig[start] === mod[start]) start++;
  let origEnd = orig.length - 1;
  let modEnd = mod.length - 1;
  while (origEnd >= start && modEnd >= start && orig[origEnd] === mod[modEnd]) {
    origEnd--;
    modEnd--;
  }

  const subOrig = orig.slice(start, origEnd + 1);
  const subMod = mod.slice(start, modEnd + 1);
  const n = subOrig.length;
  const m = subMod.length;

  if (n === 0 && m === 0) return { additions: 0, deletions: 0 };
  if (n === 0) return { additions: m, deletions: 0 };
  if (m === 0) return { additions: 0, deletions: n };

  /** DP 单元格上限：2000×2000。再大就走下面的近似。 */
  const MAX_CELLS = 4_000_000;
  const common = n * m <= MAX_CELLS ? lcsLength(subOrig, subMod) : multisetCommon(subOrig, subMod);
  return { additions: m - common, deletions: n - common };
}

/** LCS 的长度，滚动数组，内存 O(min(n, m))。 */
function lcsLength(a: string[], b: string[]): number {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  let prev = new Array<number>(short.length + 1).fill(0);
  let cur = new Array<number>(short.length + 1).fill(0);
  for (let j = 1; j <= long.length; j++) {
    for (let i = 1; i <= short.length; i++) {
      cur[i] = long[j - 1] === short[i - 1] ? prev[i - 1] + 1 : Math.max(prev[i], cur[i - 1]);
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return prev[short.length];
}

/** 「两边都有的行」按多重集合算：不许「一行抵两行」。 */
function multisetCommon(a: string[], b: string[]): number {
  const counts = new Map<string, number>();
  for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
  let common = 0;
  for (const line of b) {
    const left = counts.get(line) ?? 0;
    if (left > 0) {
      counts.set(line, left - 1);
      common++;
    }
  }
  return common;
}

export interface InlineDiffOp {
  type: 'same' | 'del' | 'add';
  origNum?: number;
  modNum?: number;
  text: string;
}

export interface InlineDiffHunk {
  id: number;
  dels: InlineDiffOp[];
  adds: InlineDiffOp[];
  startOrigLine: number;
  endOrigLine: number;
  startModLine: number;
  endModLine: number;
  opsStartIndex: number;
  opsEndIndex: number;
}

export function computeInlineHunks(
  originalText: string,
  modifiedText: string,
): {
  ops: InlineDiffOp[];
  hunks: InlineDiffHunk[];
} {
  const origLines = originalText.replace(/\r/g, '').split('\n');
  const modLines = modifiedText.replace(/\r/g, '').split('\n');

  const N = origLines.length;
  const M = modLines.length;

  let start = 0;
  while (start < N && start < M && origLines[start] === modLines[start]) {
    start++;
  }

  let origEnd = N - 1;
  let modEnd = M - 1;
  while (origEnd >= start && modEnd >= start && origLines[origEnd] === modLines[modEnd]) {
    origEnd--;
    modEnd--;
  }

  const subOrig = origLines.slice(start, origEnd + 1);
  const subMod = modLines.slice(start, modEnd + 1);
  const subN = subOrig.length;
  const subM = subMod.length;

  const dp: number[][] = Array.from({ length: subN + 1 }, () => new Array(subM + 1).fill(0));
  for (let i = 1; i <= subN; i++) {
    for (let j = 1; j <= subM; j++) {
      if (subOrig[i - 1] === subMod[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  let i = subN;
  let j = subM;
  const subOps: Array<{
    type: 'same' | 'del' | 'add';
    origSubIdx?: number;
    modSubIdx?: number;
    text: string;
  }> = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && subOrig[i - 1] === subMod[j - 1]) {
      subOps.push({ type: 'same', origSubIdx: i - 1, modSubIdx: j - 1, text: subOrig[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      subOps.push({ type: 'add', modSubIdx: j - 1, text: subMod[j - 1] });
      j--;
    } else {
      subOps.push({ type: 'del', origSubIdx: i - 1, text: subOrig[i - 1] });
      i--;
    }
  }
  subOps.reverse();

  const ops: InlineDiffOp[] = [];
  for (let k = 0; k < start; k++) {
    ops.push({ type: 'same', origNum: k + 1, modNum: k + 1, text: origLines[k] });
  }
  for (const s of subOps) {
    if (s.type === 'same') {
      const origNum = start + s.origSubIdx! + 1;
      const modNum = start + s.modSubIdx! + 1;
      ops.push({ type: 'same', origNum, modNum, text: s.text });
    } else if (s.type === 'del') {
      const origNum = start + s.origSubIdx! + 1;
      ops.push({ type: 'del', origNum, text: s.text });
    } else {
      const modNum = start + s.modSubIdx! + 1;
      ops.push({ type: 'add', modNum, text: s.text });
    }
  }
  for (let k = origEnd + 1; k < N; k++) {
    const origNum = k + 1;
    const modNum = modEnd + 1 + (k - origEnd);
    ops.push({ type: 'same', origNum, modNum, text: origLines[k] });
  }

  const hunks: InlineDiffHunk[] = [];
  let curHunk: InlineDiffHunk | null = null;

  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op.type === 'same') {
      if (curHunk) {
        hunks.push(curHunk);
        curHunk = null;
      }
    } else {
      if (!curHunk) {
        curHunk = {
          id: hunks.length + 1,
          dels: [],
          adds: [],
          startOrigLine: op.origNum ?? 1,
          endOrigLine: op.origNum ?? 1,
          startModLine: op.modNum ?? 1,
          endModLine: op.modNum ?? 1,
          opsStartIndex: k,
          opsEndIndex: k,
        };
      }
      if (op.type === 'del') {
        curHunk.dels.push(op);
        if (op.origNum != null) {
          if (curHunk.dels.length === 1) curHunk.startOrigLine = op.origNum;
          curHunk.endOrigLine = op.origNum;
        }
      } else {
        curHunk.adds.push(op);
        if (op.modNum != null) {
          if (curHunk.adds.length === 1) curHunk.startModLine = op.modNum;
          curHunk.endModLine = op.modNum;
        }
      }
      curHunk.opsEndIndex = k;
    }
  }
  if (curHunk) hunks.push(curHunk);

  return { ops, hunks };
}

export function computeLineSimilarity(s1: string, s2: string): number {
  if (s1 === s2) return 1;
  if (!s1 || !s2) return 0;
  const t1 = s1.trim();
  const t2 = s2.trim();
  if (t1 === t2) return 0.95;
  let p = 0;
  while (p < t1.length && p < t2.length && t1[p] === t2[p]) p++;
  let s = 0;
  while (s < t1.length - p && s < t2.length - p && t1[t1.length - 1 - s] === t2[t2.length - 1 - s])
    s++;
  return ((p + s) * 2) / (t1.length + t2.length);
}

export interface InlineDiffPart {
  text: string;
  isDiff: boolean;
}

export function computeLineTokenDiff(
  oldStr: string,
  newStr: string,
): {
  partsOld: InlineDiffPart[];
  partsNew: InlineDiffPart[];
} {
  const t1 = oldStr.match(/(\s+|\w+|[^\w\s]+)/g) || [];
  const t2 = newStr.match(/(\s+|\w+|[^\w\s]+)/g) || [];
  const n = t1.length;
  const m = t2.length;
  if (n === 0 && m === 0) {
    return { partsOld: [], partsNew: [] };
  }
  if (n === 0) {
    return {
      partsOld: [],
      partsNew: [{ text: newStr, isDiff: true }],
    };
  }
  if (m === 0) {
    return {
      partsOld: [{ text: oldStr, isDiff: true }],
      partsNew: [],
    };
  }

  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      if (t1[i] === t2[j]) {
        dp[i + 1][j + 1] = dp[i][j] + 1;
      } else {
        dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const matched1 = new Set<number>();
  const matched2 = new Set<number>();
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (t1[i - 1] === t2[j - 1]) {
      matched1.add(i - 1);
      matched2.add(j - 1);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  const merge = (tokens: string[], matched: Set<number>): InlineDiffPart[] => {
    const merged: InlineDiffPart[] = [];
    for (let idx = 0; idx < tokens.length; idx++) {
      const isDiff = !matched.has(idx);
      if (merged.length > 0 && merged[merged.length - 1].isDiff === isDiff) {
        merged[merged.length - 1].text += tokens[idx];
      } else {
        merged.push({ text: tokens[idx], isDiff });
      }
    }
    return merged;
  };

  return {
    partsOld: merge(t1, matched1),
    partsNew: merge(t2, matched2),
  };
}

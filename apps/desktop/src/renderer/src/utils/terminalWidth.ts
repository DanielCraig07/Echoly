/**
 * 终端 buffer 内容宽度的测量工具。
 *
 * 「不换行」模式靠把 xterm 的列数撑到「内容最宽行」来避免折行，列数直接决定横向滚动区宽度
 * （xterm 的 canvas 宽度 = 单元格宽度 × 列数）。因此这个测量值必须是「内容」的函数，
 * 且与当前列数无关；否则 resize → 重排 → 重新测量会形成反馈循环，
 * 横向滚动条长度就会一轮轮地失真（曾经出现的「不换行后滚动条一点点变短」）。
 *
 * 这里把测量逻辑从组件中独立出来，便于用 mock buffer 覆盖折行、空单元格、宽字符等边界。
 */

/** xterm IBufferCell 的最小结构 */
export interface CellLike {
  getWidth(): number;
  getCode(): number;
}

/** xterm IBufferLine 的最小结构 */
export interface LineLike {
  readonly isWrapped: boolean;
  readonly length: number;
  getCell(x: number, cell?: CellLike): CellLike | undefined;
}

/** xterm IBuffer 的最小结构 */
export interface BufferLike {
  readonly length: number;
  getLine(y: number): LineLike | undefined;
  getNullCell(): CellLike;
}

/**
 * 扫描 buffer，返回内容真实占用的最大列数（按单元格宽度计，CJK/emoji 记 2 列）。
 *
 * 三条约束，缺一不可：
 * 1. 只统计「有字符」的单元格：空单元格 getWidth() 同样是 1，必须再用 getCode() !== 0 排除，
 *    否则折行行尾的空白也会被当成内容，测量值恒等于当前列数。
 * 2. 逻辑行口径：isWrapped 的连续物理行属于同一条逻辑行，宽度要累加后再取最右端，
 *    直接取「最长物理行」只会量到折行宽度本身。
 * 3. 偏移量必须是各物理行真实宽度（行被截断时按 cols）的累加，不能用物理行下标。
 *
 * @param buf xterm 的 `term.buffer.active`
 * @param cols 当前列数，用于把 line.length（resize 后可能超出列数）截断到可视范围
 */
export function measureContentColumns(buf: BufferLike, cols: number, maxLinesToScan = 300): number {
  const bufLength = buf.length;
  const scratch = buf.getNullCell();
  let widest = 0;
  let logicalBase = 0;
  // 仅扫描最近活跃的最多 maxLinesToScan 行（历史最长行由 maxLineLenRef 高水位线持久保持），
  // 彻底杜绝拥有几千上万行历史时每次遍历 100,000+ 单元格卡死渲染主线程的问题
  const startY = Math.max(0, bufLength - maxLinesToScan);
  for (let y = startY; y < bufLength; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    // 新的逻辑行从 0 重新累计列偏移
    if (!line.isWrapped) logicalBase = 0;
    const upto = Math.min(line.length, cols);
    for (let x = upto - 1; x >= 0; x--) {
      const cell = line.getCell(x, scratch);
      if (!cell) continue;
      const w = cell.getWidth();
      const code = cell.getCode();
      // code === 0 是空单元格，code === 32 是行尾普通空格，均不计入有效内容宽度
      // 避免 Windows ConPTY 等在行尾补满空格导致测量值等于总列数并在多帧间一长一短剧烈跳变
      if (w > 0 && code !== 0 && code !== 32) {
        const end = logicalBase + x + w;
        if (end > widest) widest = end;
        break;
      }
    }
    logicalBase += upto;
  }
  return widest;
}

/**
 * 表数据视图的列布局：列宽与「显示哪几列」。
 *
 * 与 `dbColumnCache.ts` 一样收在 service 里（无 React 依赖，vitest 直测）：
 * 这两件事都是纯数据变换，散在组件里既测不到，也容易在多处各写一份判断。
 *
 * 列名是唯一的身份：宽度与隐藏标记都按**列名**存，不按下标 —— 下标会在加列 / 改结构后错位，
 * 那样用户拖过的宽度就会跑到别的列上，隐藏的列也会换一张脸出现。
 */

/** 行号列固定宽度，与 `.db-data-th.index` 的 CSS 保持一致 */
export const INDEX_COLUMN_WIDTH = 46;
export const MIN_COLUMN_WIDTH = 60;
export const MAX_COLUMN_WIDTH = 900;
export const DEFAULT_COLUMN_WIDTH = 160;

export interface ColumnLayoutPrefs {
  /** 列名 → 用户拖出来的宽度。只存**显式拖过**的列，其余走类型推断的默认值 */
  widths: Record<string, number>;
  /** 被隐藏的列名 */
  hidden: string[];
  /**
   * 用户拖列宽时**给整张表定下的总宽**（含行号列）。
   *
   * 为什么需要它：常规布局会把「容器比列宽之和多出来的空白」成比例摊给各列，
   * 好让列少时表格铺满面板。但用户一旦亲手拖过某一列，他心里那张表就已经有了确定尺寸 ——
   * 松手后再按老规矩铺满，整张表会当着他的面重新摊一遍（**跳一下**），
   * 而且他拉窄的那一列会被空白重新顶宽，「拖了却像没拖」。
   *
   * 拖过之后就以这个宽度为准：各列严格按 `widths` 渲染，超出容器就横向滚动，
   * 不足容器就留白 —— 所见即所得。未拖过（字段缺省）时仍走铺满逻辑。
   */
  tableWidth?: number;
}

export const EMPTY_COLUMN_PREFS: ColumnLayoutPrefs = { widths: {}, hidden: [] };

/** 把宽度夹进可用区间，并取整（拖动会产生小数，落到 px 上没必要） */
export function clampColumnWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_COLUMN_WIDTH;
  return Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, width)));
}

/**
 * 按列类型给一个初始宽度。
 *
 * 一个 63 列的表如果每列都吃默认宽度，横向滚到底要划很久；而 `id` / `status` 这种列
 * 给 260px 也是纯浪费。这里只做粗分档，用户拖过的以拖的为准。
 */
export function defaultColumnWidth(meta?: { type?: string }): number {
  const type = (meta?.type ?? '').toUpperCase();
  if (!type) return DEFAULT_COLUMN_WIDTH;
  // 大字段：内容长且几乎从不看全，给宽一点，剩下的交给省略号
  if (/(TEXT|JSON|JSONB|BLOB|CLOB|BYTEA|XML)/.test(type)) return 260;
  if (/CHAR|VARCHAR/.test(type)) {
    const len = Number(/\((\d+)/.exec(type)?.[1] ?? 0);
    // 短码列（状态 / 类型 / 标志位）给窄一点；其余 VARCHAR 一律 180，
    // 不再按长度加宽 —— 255 是默认长度，为它多留 80px 是在浪费所有表的横向空间
    if (len > 0 && len <= 12) return 120;
    return 180;
  }
  if (/(INT|SERIAL|DECIMAL|NUMERIC|FLOAT|DOUBLE|REAL|MONEY)/.test(type)) return 120;
  if (/(DATE|TIME)/.test(type)) return 170;
  if (/BOOL/.test(type)) return 96;
  return DEFAULT_COLUMN_WIDTH;
}

/** 实际渲染宽度：用户拖过的优先，否则按类型推断 */
export function resolveColumnWidth(
  prefs: ColumnLayoutPrefs,
  column: string,
  meta?: { type?: string },
): number {
  const explicit = prefs.widths[column];
  return typeof explicit === 'number' ? clampColumnWidth(explicit) : defaultColumnWidth(meta);
}

/** 记下拖动结果。宽度没变时**原样返回**，避免制造一个内容相同的新对象 */
export function setColumnWidth(
  prefs: ColumnLayoutPrefs,
  column: string,
  width: number,
): ColumnLayoutPrefs {
  const next = clampColumnWidth(width);
  if (prefs.widths[column] === next) return prefs;
  return { ...prefs, widths: { ...prefs.widths, [column]: next } };
}

/** 拖到一半的位移：起点宽度 + 位移，夹进区间 */
export function resizeFromDrag(startWidth: number, deltaX: number): number {
  return clampColumnWidth(startWidth + deltaX);
}

/** 恢复某一列的默认宽度（双击分隔条）。删掉这条记录即可，不需要记住默认值 */
export function resetColumnWidth(prefs: ColumnLayoutPrefs, column: string): ColumnLayoutPrefs {
  if (!(column in prefs.widths)) return prefs;
  const widths = { ...prefs.widths };
  delete widths[column];
  // 恢复默认宽度意味着「不再坚持我拖过的那张表」，连带丢掉整表宽度，
  // 让它回到铺满容器的默认表现
  return { widths, hidden: prefs.hidden, tableWidth: undefined };
}

/**
 * 拖动收尾：把当帧各列的宽度与整表宽度一并落盘。
 *
 * 只记被拖的那一列是不够的：松手后若还走「铺满容器」的常规布局，
 * 表格会按新基准重算一遍摊平，整张表当着用户的面跳一下。写下 `tableWidth`
 * 之后 `layoutColumns` 直接按各列的显式宽度渲染，松手前后的画面完全一致。
 */
export function commitColumnFrame(
  prefs: ColumnLayoutPrefs,
  widths: Readonly<Record<string, number>>,
  tableWidth: number,
): ColumnLayoutPrefs {
  const next: Record<string, number> = { ...prefs.widths };
  let changed = prefs.tableWidth !== Math.round(tableWidth);
  for (const [column, width] of Object.entries(widths)) {
    const clamped = clampColumnWidth(width);
    if (next[column] !== clamped) {
      next[column] = clamped;
      changed = true;
    }
  }
  if (!changed) return prefs;
  return { widths: next, hidden: prefs.hidden, tableWidth: Math.round(tableWidth) };
}

/**
 * 丢掉已经不存在的列名。
 *
 * 表结构是会变的（加列 / 删列 / 换个同名表）。留着旧名字本身无害，
 * 但用户下次恰好新建一列叫这个名字时，会莫名其妙地发现它一出生就是隐藏的 ——
 * 那种 bug 极难联想到是这里。
 */
export function sanitizeHidden(hidden: readonly string[], columns: readonly string[]): string[] {
  if (hidden.length === 0) return [];
  const known = new Set(columns);
  return hidden.filter((name) => known.has(name));
}

/**
 * 真正要渲染的列。
 *
 * 兜底：全都隐藏时返回全部列。列全被藏着会让表变成一片空白，
 * 而「把列藏完」几乎总是误操作（连点了几下「全不选」），不该让界面无路可走。
 */
export function pickVisibleColumns(
  columns: readonly string[],
  hidden: readonly string[],
): string[] {
  const effective = sanitizeHidden(hidden, columns);
  if (effective.length === 0) return [...columns];
  const hiddenSet = new Set(effective);
  const visible = columns.filter((c) => !hiddenSet.has(c));
  return visible.length > 0 ? visible : [...columns];
}

/** 勾 / 取消勾单列 */
export function setColumnHidden(
  prefs: ColumnLayoutPrefs,
  column: string,
  hidden: boolean,
): ColumnLayoutPrefs {
  const set = new Set(prefs.hidden);
  if (hidden) set.add(column);
  else set.delete(column);
  return { ...prefs, hidden: Array.from(set) };
}

/**
 * 「全选 / 全不选」。
 *
 * 全不选时**留下一列**（第一列）：这里的返回会被 pickVisibleColumns 的兜底再兜一次，
 * 但那一层兜底会把所有列放回来 —— 用户看到的就是「点了全不选却什么都没变」。
 * 直接在这里留下一列，行为才对得上按钮的名字。
 */
export function setAllColumnsHidden(
  prefs: ColumnLayoutPrefs,
  columns: readonly string[],
  hidden: boolean,
): ColumnLayoutPrefs {
  if (!hidden) return { ...prefs, hidden: [] };
  if (columns.length === 0) return { ...prefs, hidden: [] };
  return { ...prefs, hidden: columns.slice(1) };
}

/**
 * 是否已经只剩一列可见（「全不选」按钮该置灰）。
 *
 * 判据与 `pickVisibleColumns` 的兜底保持一致：全都隐藏时表格仍会渲染全部列，
 * 而 `setAllColumnsHidden` 会留下第一列，所以「还剩一列」就是能到达的尽头。
 */
export function isOnlyOneColumnVisible(
  columns: readonly string[],
  hidden: readonly string[],
): boolean {
  if (columns.length <= 1) return true;
  const effective = sanitizeHidden(hidden, columns);
  return effective.length >= columns.length - 1;
}

export interface ColumnLayoutResult {
  /** 列名 → 这一帧实际使用的宽度（已含「空白摊给最后一列」的处理） */
  widths: Record<string, number>;
  /** 表格元素应有的宽度 */
  tableWidth: number;
}

/**
 * 拖动中的临时状态。
 *
 * `frozen` 是按下鼠标那一刻各列的宽度（含行号列之外的每一列）。带上它之后，
 * 拖动期间**只有被拖的那一列会变**，其余列纹丝不动，表格宽度跟着指针走。
 * 不带 `frozen` 时退回「把空白成比例摊给各列」的常规布局 —— 那条路径是给「非拖动」用的。
 */
export interface ColumnDragOverride {
  column: string;
  width: number;
  frozen?: Record<string, number> | null;
}

/**
 * 把「用户设定的列宽」摊平成「这一帧真正用的宽度」，分三种情形：
 *
 * 1. **拖动中**（给了 `override`）：完全不摊。被拖的那一列严格跟手，其余列冻结在
 *    按下那一刻的宽度，表格总宽随之增减。早期版本在拖动时也做摊平，结果是
 *    **拖一列、所有列一起变** —— 用户会觉得「我明明只拖了 id，怎么别的列也动了」。
 * 2. **拖过之后**（`prefs.tableWidth` 有值）：各列严格按显式宽度渲染，整表用他定下的宽度，
 *    超出容器就横向滚动、不足就留白。回到摊平会把空白重新顶回各列，
 *    「拖了却像没拖」。
 * 3. **从没拖过**：列少时表格铺满面板（否则表头下划线在面板中间断掉，看着像坏了），
 *    做法是把「超出列宽之和的空白」按各自基准宽度**成比例**分给各列（窄列仍窄）。
 *
 * 第 3 种情形的分配基数是**存下来的偏好**而不是上一帧的结果：否则每帧都在上一帧的基础上
 * 再摊一次，宽度会一路飘走。最后一个收尾的列吃掉取整余数，保证总和与表格宽度严丝合缝。
 */
export function layoutColumns(
  visibleColumns: readonly string[],
  prefs: ColumnLayoutPrefs,
  metaOf: (column: string) => { type?: string } | undefined,
  containerWidth: number,
  override?: ColumnDragOverride | null,
): ColumnLayoutResult {
  const widths: Record<string, number> = {};

  // ── 拖动中：只让被拖的那一列动 ──
  if (override) {
    for (const col of visibleColumns) {
      if (col === override.column) {
        widths[col] = clampColumnWidth(override.width);
        continue;
      }
      const frozen = override.frozen?.[col];
      widths[col] =
        typeof frozen === 'number' ? clampColumnWidth(frozen) : resolveColumnWidth(prefs, col, metaOf(col));
    }
    const sum = INDEX_COLUMN_WIDTH + visibleColumns.reduce((acc, c) => acc + widths[c], 0);
    // 不铺满、不让位：表格宽度就是各列之和，拖动结果所见即所得
    return { widths, tableWidth: sum };
  }

  for (const col of visibleColumns) {
    widths[col] = resolveColumnWidth(prefs, col, metaOf(col));
  }

  // 列都按显式宽度排好后，这一帧的内容宽度就是各列之和
  const contentWidth = INDEX_COLUMN_WIDTH + visibleColumns.reduce((acc, c) => acc + widths[c], 0);

  // 用户拖过列宽：整表尺寸以他定下的宽度为准，不再铺满容器。
  // 回到铺满会把空白摊回各列，他刚拉窄的列会被重新顶宽 —— 「拖了却像没拖」
  const target =
    typeof prefs.tableWidth === 'number'
      ? Math.max(contentWidth, Math.round(prefs.tableWidth))
      : Math.max(Math.round(containerWidth), contentWidth);

  const slack = target - contentWidth;
  // 没有多余空间可分（用户定下的宽度已不够放各列，或容器本来就窄）：原样返回，靠横向滚动看
  if (slack <= 0) return { widths, tableWidth: contentWidth };

  const baseSum = visibleColumns.reduce((acc, col) => acc + widths[col], 0);
  if (baseSum <= 0) return { widths, tableWidth: contentWidth };

  let assigned = 0;
  for (const col of visibleColumns) {
    const share = Math.floor((slack * widths[col]) / baseSum);
    widths[col] += share;
    assigned += share;
  }
  // 取整丢掉的零头补给第一列：不用操心谁拿更合适，只要求总和不多不少
  widths[visibleColumns[0]] += slack - assigned;

  return { widths, tableWidth: target };
}

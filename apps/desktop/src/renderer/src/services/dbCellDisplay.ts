/**
 * 单元格值的「显示 / 回填」格式化。
 *
 * 无 React 依赖，便于 vitest 直接单测 —— 与 `dbMutations.ts` / `dbTableQuery.ts` 同款风格。
 *
 * ## 为什么要单独做时间格式化
 *
 * 三个驱动返回时间类型的口径并不一致：MySQL 的 `DATETIME` / `TIMESTAMP` 与 PostgreSQL 的
 * `timestamp` 都是 JS `Date` 对象，SQLite 则按 TEXT 原样返回字符串。
 * `Date` 直接 `JSON.stringify`（原来的 `typeof value === 'object'` 分支会走到这里）
 * 会得到 `"2024-01-01T00:00:00.000Z"` —— 表格里既多出一对引号、又是 UTC 时刻，
 * 和用户在数据库客户端里看到的本地时间对不上。因此统一按本地时间格式化成
 * `YYYY-MM-DD HH:mm:ss`。
 *
 * 代价：`timestamptz` 这类带时区的列，编辑回填时会丢掉原始偏移量。本机与库同时区时
 * 往返无损，跨时区部署时请改用 SQL 控制台精确指定。这是为了让绝大多数场景下
 * 「看到的就是本地时间」而做的取舍。
 */

/** 把 Date 按**本地时间**渲染成 `YYYY-MM-DD HH:mm:ss`（毫秒非零时才补 `.SSS`） */
export function formatDateValue(date: Date): string {
  if (Number.isNaN(date.getTime())) return 'Invalid Date';
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const base =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  // 毫秒通常为 0（DATETIME 无小数秒），为零时不显示，避免表格里全是 .000 噪声
  return date.getMilliseconds() === 0 ? base : `${base}.${pad(date.getMilliseconds(), 3)}`;
}

/** 二进制列（Buffer / TypedArray）：长度比内容有用得多，不要打印一堆乱码 */
function describeBinary(value: ArrayBufferView): string {
  return `<binary ${value.byteLength} bytes>`;
}

/**
 * 任意查询结果值 → 表格里显示、以及编辑器里回填用的字符串。
 *
 * `null` / `undefined` 返回空串：显示成 `NULL` 还是留白由调用方决定
 * （数据视图用斜体 `NULL`，导出 CSV 用空单元格），这里不做决定。
 */
export function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return formatDateValue(value);
  if (typeof value === 'object') {
    if (ArrayBuffer.isView(value)) return describeBinary(value);
    try {
      return JSON.stringify(value) ?? '';
    } catch {
      // 循环引用等极端情况：宁可给出一个粗糙的字符串，也不要让整个表格渲染崩掉
      return String(value);
    }
  }
  return String(value);
}

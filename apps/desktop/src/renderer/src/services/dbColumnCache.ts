/**
 * 列元数据缓存的身份判定。
 *
 * 背景：`DbTableDataView` 在 `db://data/*` 各个标签之间是**同一个组件实例**
 * （`EditorPane` 按位置渲染，没有给 `key`），切到另一张表时 state / ref 会原样留着。
 * 而缓存命中判断过去只看「columns 非空」，于是新表沿用上一张表的列清单：
 * 工具栏的「N 列」显示的是别人家的数字，数值 / 文本的类型判定也跟着错。
 *
 * 把「这份缓存属于哪张表」显式编码成一个 key，交给纯函数比较，既修掉串表，
 * 也能在 vitest 里直接钉死回归。
 */

/**
 * 表身份的缓存键。
 *
 * 每一段都带上自己的长度再拼接（`<长度>:<内容>`），而不是挑一个「不太可能出现」的分隔符：
 * 长度前缀让拼接结果**无条件可逆**，任何字符出现在库名 / 表名里都不会让两张不同的表
 * 拼出同一个键。挑分隔符的写法只是在赌标识符里不含那个字符，赌输了就是把 A 表的列
 * 用到 B 表上 —— 代价和收益不成比例。
 */
export function columnCacheKey(
  connectionId: string,
  schemaName: string | undefined,
  tableName: string,
): string {
  const part = (value: string) => `${value.length}:${value}`;
  return [part(connectionId), part(schemaName ?? ''), part(tableName)].join('|');
}

/**
 * 缓存是否仍然对得上当前这张表。
 *
 * 要求「key 相同」**且**「确实缓存到了列」——空数组代表上次没查到（表不存在、权限不足），
 * 不该被当成有效缓存一直短路下去。
 */
export function isColumnCacheHit(
  cachedKey: string,
  currentKey: string,
  cachedCount: number,
): boolean {
  return cachedKey === currentKey && cachedCount > 0;
}

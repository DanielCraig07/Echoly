/**
 * 「当前查询」SQL 栏的展开 / 折叠偏好（图3）。
 *
 * 与 `structureViewMode.ts` 同一套做法：纯界面偏好走 localStorage 而不是 settings.json，
 * 丢了也只是回到默认形态。读写一律包 try/catch —— 隐私模式或配额满时读不到，
 * 不该让数据视图打不开。
 *
 * **默认折叠**：完整 SQL 一展开就是十来行，数据表被压得只剩几行可看，
 * 而多数时候用户并不核对语句。默认收起、点标题条展开，让「想看的人能看到、
 * 不看的人不被占地方」这两件事都不吃亏。
 */

const STORAGE_KEY = 'echoly:db_sql_bar_expanded';

/** 默认收起：数据优先，语句按需展开 */
export const DEFAULT_SQL_BAR_EXPANDED = false;

export function loadSqlBarExpanded(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    // 只认显式的 '1' / '0'：其它任何残留值（旧版本写入的、手改的）都退回默认
    if (raw === '1') return true;
    if (raw === '0') return false;
    return DEFAULT_SQL_BAR_EXPANDED;
  } catch {
    return DEFAULT_SQL_BAR_EXPANDED;
  }
}

export function saveSqlBarExpanded(expanded: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, expanded ? '1' : '0');
  } catch {
    // 记不住偏好不影响用
  }
}

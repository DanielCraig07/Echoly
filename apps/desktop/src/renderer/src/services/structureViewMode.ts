/**
 * 表结构视图的展示形态：DDL 文本 or 列清单（图4）。
 *
 * 走 localStorage 而不是 settings.json：这是**纯界面偏好**（就像列宽一样），
 * 塞进设置文件会让它随工作区同步、越滚越大，而丢了也只是回到默认形态。
 * 读写一律包 try/catch —— 隐私模式或配额满时读不到不该让视图打不开。
 */

export type StructureViewMode = 'columns' | 'ddl';

const STORAGE_KEY = 'echoly:db_structure_view_mode';

/** 默认进列视图：图4 那种可编辑的列清单是这次改造的主角，DDL 退居其后的「原文」视图 */
const DEFAULT_MODE: StructureViewMode = 'columns';

export function loadStructureViewMode(): StructureViewMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === 'ddl' || raw === 'columns' ? raw : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

export function saveStructureViewMode(mode: StructureViewMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // 记不住偏好不影响用
  }
}

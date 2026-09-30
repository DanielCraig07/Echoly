import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { DatabaseColumnMeta, DatabaseQueryResult } from '@deepseek-ide/shared';
import { DbFilterPopover } from './DbFilterPopover';
import { DbColumnMenu } from './DbColumnMenu';
import { DbColumnPicker } from './DbColumnPicker';
import { DbFilterSqlBar } from './DbFilterSqlBar';
import { DbHoverCard } from './DbHoverCard';
import { buildFullTableSql } from '../services/dbSqlPreview';
import { buildColumnTooltip, type DbColumnTooltip } from '../services/dbColumnTooltip';
import { buildTableSelectSql } from '../services/dbIdentifiers';
import { formatCellValue } from '../services/dbCellDisplay';
import { columnCategoryBadge } from '../services/dbColumnType';
import { columnCacheKey, isColumnCacheHit } from '../services/dbColumnCache';
import {
  EMPTY_COLUMN_PREFS,
  INDEX_COLUMN_WIDTH,
  layoutColumns,
  pickVisibleColumns,
  resetColumnWidth,
  resizeFromDrag,
  setAllColumnsHidden,
  setColumnHidden,
  commitColumnFrame,
  type ColumnLayoutPrefs,
} from '../services/dbColumnLayout';
import { buildSqlConfirmMarkdown } from '../services/dbConfirmContent';
import { DbConfirmModal } from './DbConfirmModal';
import {
  buildCommitStatements,
  buildDeleteSql,
  buildInsertSql,
  buildRowKey,
  buildRowWhereClause,
  buildUpdateSql,
  countStagedChanges,
  defaultDisplayHint,
  emptyStagedChanges,
  isSameCellValue,
  pkColumnsOf,
  stageCellEdit,
  stageDeleteRow,
  stageInsertCellEdit,
  stageInsertRow,
  unstageDeleteRow,
  unstageInsertRow,
  validateStagedInserts,
  type DbStagedChanges,
} from '../services/dbMutations';
import {
  EMPTY_VIEW_STATE,
  buildTableQuerySql,
  describeFilter,
  describeSort,
  isEmptyViewState,
  nextSortState,
  sortDirectionOf,
  type DbTableFilterCondition,
  type DbTableFilterOperator,
  type DbTableViewState,
} from '../services/dbTableQuery';

export interface DbTableDataViewProps {
  connectionId: string;
  tableName: string;
  /** MySQL 库名 / PostgreSQL schema 名 / SQLite 的 main */
  schemaName?: string;
  /** 驱动类型：决定标识符引号与是否需要库 / schema 限定 */
  driver?: 'sqlite' | 'mysql' | 'postgres';
  onOpenConsole?: (initialSql: string) => void;
  onShowToast?: (
    title: string,
    detail?: string,
    type?: 'success' | 'error' | 'info' | 'warn',
  ) => void;
  /** 外部（左侧树「按此列排序 / 筛选」）下发的初始筛选排序状态 */
  initialView?: DbTableViewState;
  /** 每变一次就重新套用 initialView：同一张表连续下发两次不同排序时靠它区分 */
  viewNonce?: number;
}

/**
 * 生成全表查询语句。
 *
 * 必须按驱动拼限定名：MySQL 一个连接下可有多个库，不限定库名会直接报「No database selected」；
 * PostgreSQL / SQLite 的 `"schema"."table"` 双引号形式则两边都成立。
 * 引号规则统一收在 `dbIdentifiers.ts`，避免在组件里散落三元判断。
 */
function buildSelectSql(
  driver: 'sqlite' | 'mysql' | 'postgres',
  schemaName: string | undefined,
  tableName: string,
): string {
  // MySQL 下 schemaName 就是库名，需要限定；PG / SQLite 由 dbQuery 的 schemaName 参数负责切会话
  const schema = driver === 'mysql' ? schemaName : undefined;
  return buildTableSelectSql(driver, schema, tableName).replace(/;$/, '');
}

/** 值 → 表格里显示 / 编辑回填用的字符串（时间按本地时间渲染，不带 JSON 引号） */
function displayValue(val: any): string {
  return formatCellValue(val);
}

/**
 * 列宽 / 隐藏列的记忆。
 *
 * 走 localStorage 而不是 settings.json：这是**每张表各自一份**的纯界面偏好，
 * 塞进设置文件会让它随工作区同步、越滚越大，而丢了也只是列宽回到默认值。
 * 读写一律包 try/catch —— 隐私模式或配额满时读不到东西不该让表格打不开。
 */
function loadColumnPrefs(key: string): ColumnLayoutPrefs {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return EMPTY_COLUMN_PREFS;
    const parsed = JSON.parse(raw) as Partial<ColumnLayoutPrefs>;
    const widths =
      parsed && typeof parsed.widths === 'object' && parsed.widths ? parsed.widths : {};
    return {
      widths,
      hidden: parsed && Array.isArray(parsed.hidden) ? parsed.hidden.map(String) : [],
      // 老记录没有 tableWidth：那时只存宽度、一律铺满容器，读回来按「没拖过」处理即可
      tableWidth:
        typeof parsed?.tableWidth === 'number' ? parsed.tableWidth : undefined,
    };
  } catch {
    return EMPTY_COLUMN_PREFS;
  }
}

function saveColumnPrefs(key: string, prefs: ColumnLayoutPrefs): void {
  try {
    localStorage.setItem(key, JSON.stringify(prefs));
  } catch {
    // 配额满 / 隐私模式：记不住偏好不影响用表
  }
}

export function DbTableDataView({
  connectionId,
  tableName,
  schemaName,
  driver = 'sqlite',
  onOpenConsole,
  onShowToast,
  initialView,
  viewNonce,
}: DbTableDataViewProps) {
  const [columns, setColumns] = useState<DatabaseColumnMeta[]>([]);
  const [queryResult, setQueryResult] = useState<DatabaseQueryResult | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [page, setPage] = useState<number>(1);
  const pageSize = 50;
  const [filterText, setFilterText] = useState<string>('');
  const [copiedCell, setCopiedCell] = useState<string | null>(null);

  // ── 筛选 / 排序（SQL 级，跨页生效）──
  const [view, setView] = useState<DbTableViewState>(initialView ?? EMPTY_VIEW_STATE);
  const [filterTarget, setFilterTarget] = useState<{
    column: string;
    anchor: { x: number; y: number };
    initial?: DbTableFilterCondition;
    /** 列头菜单里直接点的那一项：只定运算符，值留空等用户填 */
    initialOperator?: DbTableFilterOperator;
  } | null>(null);

  // ── 行数据暂存改动 ──
  const [staged, setStaged] = useState<DbStagedChanges>(emptyStagedChanges());
  /** rowKey → 该行在数据库里的原始值（生成 WHERE 与「改回原值即撤销」都靠它） */
  const originalRowsRef = useRef<Record<string, Record<string, any>>>({});
  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null);

  // ── 单元格编辑 ──
  //
  // `original` 是进入编辑器时的原值，用于「改回原值即撤销」判定；`value` 是输入框里的文本。
  const [editing, setEditing] = useState<{
    rowKey?: string;
    tempId?: string;
    column: string;
    /** 该列在数据库里的原值，用于「改回原值即撤销」判定 */
    original: any;
    value: string;
  } | null>(null);
  /** 最近一次提交编辑的时刻：用来区分「点走来结束编辑」与「点一下想复制」 */
  const justCommittedRef = useRef<number>(0);

  // ── 行右键菜单 ──
  const [rowMenu, setRowMenu] = useState<{
    x: number;
    y: number;
    rowKey: string;
  } | null>(null);
  const rowMenuRef = useRef<HTMLDivElement | null>(null);

  // ── 列头菜单（排序 + 筛选合一）──
  const [columnMenu, setColumnMenu] = useState<{
    column: string;
    anchor: { x: number; y: number };
  } | null>(null);

  // ── 列头悬浮卡片（图2：类型约束 + 数据库列注释）──
  const [columnCard, setColumnCard] = useState<{
    content: DbColumnTooltip;
    anchor: { x: number; y: number; width: number; height: number };
  } | null>(null);
  /** 悬浮延时的计时器：移出列名时必须清掉，否则快速划过一整排列头会连弹好几张卡片 */
  const columnCardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * 悬浮列名延时 500ms 再弹卡片 —— 与全局 `GlobalTooltip` 的下限取同一个值，
   * 两种提示的「反应速度」才一致，不会一个急着弹一个慢半拍。
   */
  const openColumnCard = useCallback(
    (meta: DatabaseColumnMeta, rect: DOMRect) => {
      if (columnCardTimerRef.current) clearTimeout(columnCardTimerRef.current);
      columnCardTimerRef.current = setTimeout(() => {
        const content = buildColumnTooltip({
          meta,
          table: tableName,
          schema: schemaName,
          driver,
          comment: meta.comment,
        });
        if (!content) return;
        setColumnCard({
          content,
          anchor: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        });
      }, 500);
    },
    [tableName, schemaName, driver],
  );

  const closeColumnCard = useCallback(() => {
    if (columnCardTimerRef.current) {
      clearTimeout(columnCardTimerRef.current);
      columnCardTimerRef.current = null;
    }
    setColumnCard(null);
  }, []);

  // 卸载时清掉待弹的定时器，避免切表后卡片凭空冒在别的表上
  useEffect(() => () => {
    if (columnCardTimerRef.current) clearTimeout(columnCardTimerRef.current);
  }, []);

  // ── 列宽与「显示哪些字段」──
  //
  // 按表存：不同表的字段数量与名字天差地别，共用一份设置只会互相污染。
  // 键里带连接与库，避免两个项目里同名的表串味。
  const layoutStorageKey = `echoly:db_col_layout:${columnCacheKey(connectionId, schemaName, tableName)}`;
  const [columnPrefs, setColumnPrefs] = useState<ColumnLayoutPrefs>(EMPTY_COLUMN_PREFS);
  const columnPrefsRef = useRef<ColumnLayoutPrefs>(columnPrefs);
  columnPrefsRef.current = columnPrefs;
  /** 正在拖动的列与起点信息；null 表示没在拖 */
  const [resizing, setResizing] = useState<{ column: string; startX: number; startWidth: number } | null>(
    null,
  );
  /**
   * 拖动过程中这一列真正跟到哪了。
   *
   * 不走 state：拖动要在**每一次鼠标移动**时立刻改变宽度，而 mousemove 比 React 的提交频率高，
   * 用 state 传递就必然有一帧的滞后 —— 表现就是「鼠标走了、宽度过一会儿才跟上」。
   * 用 ref 中转，再靠一个 rAF 循环把最新值同步给 state 渲染。
   */
  const dragWidthRef = useRef<number>(0);
  /** 每帧同步给渲染用的拖动宽度（拖动中）；null 表示没在拖 */
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  /** rAF 循环上一帧提交过的值，用来跳过「没动鼠标」的那些帧 */
  const lastFrameWidthRef = useRef<number>(0);
  /** 本次拖动是否真的移动过：没动过就当成一次点击，不写偏好、也不动选中区 */
  const dragMovedRef = useRef<boolean>(false);
  /** 拖动起点处各列已生效的宽度：整帧落盘时用它，避免与 state 抢时间 */
  const dragBaseWidthsRef = useRef<Record<string, number>>({});
  /** 列选择器浮层（右上角「显示字段」按钮） */
  const [pickerAnchor, setPickerAnchor] = useState<{
    x: number;
    y: number;
    align?: 'left' | 'right';
  } | null>(null);
  /** 「显示字段」按钮：浮层关闭时把焦点交还出去，别让按钮一直挂着焦点高亮 */
  const pickerBtnRef = useRef<HTMLButtonElement | null>(null);

  const [submitting, setSubmitting] = useState<boolean>(false);

  /**
   * 提交前要确认的语句 + 对应的 Markdown 正文。
   *
   * 非空即为「确认框已打开」：提交的后续步骤挂在弹窗的 onConfirm 里，
   * 而不是像原来那样在 `window.confirm` 后面顺着往下写 —— 这也是能自定义外观的前提。
   */
  const [submitConfirm, setSubmitConfirm] = useState<{
    statements: string[];
    content: string;
  } | null>(null);

  // 列元数据既要驱动查询语句的类型判定，又要在加载里复用，放 ref 里避免把它塞进依赖导致循环重载。
  // ref 里同时记着「这份缓存属于哪张表」：本组件实例在 db://data 各标签之间复用，
  // 切表后连接 / 库 / 表任一变化都必须重新取，否则会拿上一张表的列去拼 SQL、显示错的列数。
  const columnsRef = useRef<DatabaseColumnMeta[]>([]);
  columnsRef.current = columns;
  const columnsKeyRef = useRef<string>('');

  /**
   * 换表时把整份视图状态重置。
   *
   * `db://data/*` 的各个标签共用同一个组件实例（EditorPane 按位置渲染，没给 key），
   * 切表后 state 会原样留着。不清掉的话，后果不只是「N 列」显示错：
   * 上一张表的暂存改动会被带到新表，点提交时 `buildCommitStatements` 用的却是新表名 ——
   * 那些 UPDATE / DELETE 会打到另一张表上。
   *
   * 用 React 官方的「渲染期调整 state」写法：它在子节点渲染前同步生效，
   * 不会先闪一帧上一张表的列头与数据。
   */
  const columnsKey = columnCacheKey(connectionId, schemaName, tableName);
  const [appliedColumnsKey, setAppliedColumnsKey] = useState<string>(columnsKey);
  if (appliedColumnsKey !== columnsKey) {
    setAppliedColumnsKey(columnsKey);
    setColumns([]);
    setQueryResult(null);
    setStaged(emptyStagedChanges());
    setSelectedRowKey(null);
    setFilterText('');
    setView(EMPTY_VIEW_STATE);
    setEditing(null);
    setColumnMenu(null);
    setFilterTarget(null);
    setRowMenu(null);
    // 缓存键一并作废：ensureColumns 是异步的，光靠 setColumns([]) 还没轮到重渲染时
    // 就可能被调用，那一下会把上一张表的列当成命中直接返回。
    columnsKeyRef.current = '';
    originalRowsRef.current = {};
  }

  const pkColumns = useMemo(() => pkColumnsOf(columns), [columns]);
  const hasPk = pkColumns.length > 0;
  const pkNames = useMemo(() => new Set(pkColumns.map((c) => c.name)), [pkColumns]);

  /** 列名 → 元数据（列宽推断、表头悬浮、筛选浮层都要用） */
  const metaOf = useCallback(
    (colName: string): DatabaseColumnMeta | undefined => columns.find((c) => c.name === colName),
    [columns],
  );

  // 换表时把这一张表的列宽 / 隐藏列读回来；同一张表来回切也不会丢
  const loadedLayoutKeyRef = useRef<string>('');
  useEffect(() => {
    loadedLayoutKeyRef.current = layoutStorageKey;
    setColumnPrefs(loadColumnPrefs(layoutStorageKey));
    setPickerAnchor(null);
    setResizing(null);
    setDragWidth(null);
  }, [layoutStorageKey]);

  // 偏好一旦改变就落盘。key 刚切换、偏好还是上一张表的那一帧必须跳过，
  // 否则会拿空偏好把磁盘上刚存好的记录冲掉。
  useEffect(() => {
    if (loadedLayoutKeyRef.current !== layoutStorageKey) return;
    saveColumnPrefs(layoutStorageKey, columnPrefs);
  }, [layoutStorageKey, columnPrefs]);

  /**
   * 真正渲染的列。
   *
   * 用**结果集的列**而不是元数据里的列：结果集才是这一屏实际有什么，
   * 元数据是异步取的，切表瞬间可能还是上一张表的。
   */
  const visibleColumns = useMemo(
    () => pickVisibleColumns(queryResult?.columns ?? [], columnPrefs.hidden),
    [queryResult?.columns, columnPrefs.hidden],
  );

  /** 表格所在滚动容器的宽度：列少时表格要铺满它，拖动时又是「不让位」的基准 */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState<number>(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setContainerWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      if (w) setContainerWidth(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** 拖动中那一列的临时宽度 + 按下那一刻各列的冻结宽度（其余列拖动期间纹丝不动） */
  const widthOverride =
    resizing && dragWidth !== null
      ? { column: resizing.column, width: dragWidth, frozen: dragBaseWidthsRef.current }
      : null;

  /** 这一帧真正生效的列宽与表格总宽 */
  const { widths: columnWidths, tableWidth } = useMemo(
    () => layoutColumns(visibleColumns, columnPrefs, metaOf, containerWidth, widthOverride),
    [visibleColumns, columnPrefs, metaOf, containerWidth, widthOverride],
  );

  /**
   * 拖动列宽。
   *
   * move / up 都挂在 window 上，指针滑出列头甚至滑出表格也不会断。
   *
   * 宽度的传递刻意绕开 React 的 state 更新节奏：mousemove 的触发频率高于渲染帧，
   * 每次移动都 setState 会让宽度**追不上鼠标**（看到的就是「拖了但列不动，松手才跳过去」）。
   * 这里只把最新宽度写进 ref，再由一个 rAF 循环按帧同步给 state —— 每帧只提交一次，
   * 且提交的一定是最新值。
   */
  useEffect(() => {
    if (!resizing) return;
    dragMovedRef.current = false;
    dragWidthRef.current = resizing.startWidth;

    const onMove = (e: MouseEvent) => {
      if (e.clientX !== resizing.startX) dragMovedRef.current = true;
      dragWidthRef.current = resizeFromDrag(resizing.startWidth, e.clientX - resizing.startX);
      // 拖动期间每帧清一次选中区：`user-select: none` 只拦「新起」的选区，
      // 如果按下前页面上本来就有选中（或系统菜单 / 输入法打断了禁用态），它会一直留着
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) sel.removeAllRanges();
    };

    const onUp = () => {
      const column = resizing.column;
      const moved = dragMovedRef.current;
      setResizing(null);
      setDragWidth(null);
      // 没真正拖过就不要写偏好：单击分隔条（含双击恢复默认的第一次抬起）不该留下一条列宽记录
      if (moved) {
        // 落盘「最后一帧的各列宽度 + 整表宽度」：松手后 layoutColumns 直接按这套值渲染，
        // 不会重新摊一次平，画面纹丝不动（这就是「拖完表格跳一下」的根治点）
        const frameWidths = { ...dragBaseWidthsRef.current, [column]: dragWidthRef.current };
        const frameTableWidth =
          INDEX_COLUMN_WIDTH +
          Object.values(frameWidths).reduce((acc, w) => acc + w, 0);
        setColumnPrefs((prev) => commitColumnFrame(prev, frameWidths, frameTableWidth));
      }
      // 收尾清掉选中区。拖动过程中禁用了选中，但指针**滑出窗口**再松开时，
      // 浏览器不会给我们 mouseup，禁用态会在 blur 后才撤销 —— 那一瞬间的
      // 一次原生点击就足以在光标位置留下一段选中文本，这就是「失焦后选中了点击处」的来源。
      // 只在焦点不在输入类元素上时才 blur：单元格编辑器里正在输入时不该被这下一脚踢掉
      const active = document.activeElement as HTMLElement | null;
      const typing =
        !!active &&
        (active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.isContentEditable);
      if (active && !typing) active.blur();
      window.getSelection()?.removeAllRanges();
      document.body.classList.remove('db-col-resizing');
      dragMovedRef.current = false;
    };

    let rafId = 0;
    const tick = () => {
      // 只在真正变化时提交：不动鼠标的那些帧不该引起重渲染
      if (dragWidthRef.current !== lastFrameWidthRef.current) {
        lastFrameWidthRef.current = dragWidthRef.current;
        setDragWidth(dragWidthRef.current);
      }
      rafId = requestAnimationFrame(tick);
    };
    setDragWidth(dragWidthRef.current);
    lastFrameWidthRef.current = dragWidthRef.current;
    rafId = requestAnimationFrame(tick);

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    // 指针移出窗口 / 窗口失焦时直接收尾，避免拖动状态悬空挂在 body 上
    window.addEventListener('blur', onUp);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onUp);
      document.body.classList.remove('db-col-resizing');
    };
  }, [resizing]);

  /** MySQL 需要限定库名，其余驱动靠 dbQuery 的 schemaName 切会话 */
  const querySchema = driver === 'mysql' ? schemaName : undefined;

  const ensureColumns = useCallback(async (): Promise<DatabaseColumnMeta[]> => {
    const key = columnCacheKey(connectionId, schemaName, tableName);
    if (isColumnCacheHit(columnsKeyRef.current, key, columnsRef.current.length)) {
      return columnsRef.current;
    }
    if (!window.ide?.dbGetTableSchema) return [];
    const res = await window.ide.dbGetTableSchema(connectionId, tableName, schemaName);
    if (res.ok && res.columns) {
      columnsKeyRef.current = key;
      columnsRef.current = res.columns;
      setColumns(res.columns);
      return res.columns;
    }
    return [];
  }, [connectionId, tableName, schemaName]);

  /** 加载某一页数据；`nextView` 用于在筛选/排序刚变化时立刻用新条件查询（state 尚未更新） */
  const loadData = useCallback(
    async (targetPage: number, currentSize: number, nextView?: DbTableViewState) => {
      if (!window.ide?.dbQuery || !connectionId || !tableName) return;
      const effectiveView = nextView ?? view;
      try {
        setLoading(true);
        const cols = await ensureColumns();
        const sql = buildTableQuerySql(driver, querySchema, tableName, cols, effectiveView);
        const res = await window.ide.dbQuery(
          connectionId,
          sql,
          targetPage,
          currentSize,
          schemaName,
        );
        setQueryResult(res);
        setPage(targetPage);
        if (!res.ok) {
          onShowToast?.(`加载表数据失败: ${res.error}`, undefined, 'error');
        } else {
          // 累积原始行快照（而不是每次覆盖）：暂存改动里的 WHERE 必须基于「读到的原值」，
          // 用户翻到第 2 页后再提交第 1 页改的那几行时，靠覆盖式快照会找不到原始行而整批失败
          const snapshot: Record<string, Record<string, any>> = {};
          res.rows.forEach((row, idx) => {
            snapshot[buildRowKey(pkColumns, row, idx)] = row;
          });
          originalRowsRef.current = { ...originalRowsRef.current, ...snapshot };
        }
      } catch (err: any) {
        onShowToast?.('查询异常', err.message || String(err), 'error');
      } finally {
        setLoading(false);
      }
    },
    [
      connectionId,
      tableName,
      schemaName,
      driver,
      querySchema,
      pkColumns,
      view,
      ensureColumns,
      onShowToast,
    ],
  );

  // 首次加载与页大小变化
  useEffect(() => {
    void loadData(1, pageSize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, tableName, schemaName, pageSize]);

  // 外部（左侧树）下发的排序 / 筛选：nonce 变化时套用并立即按新条件重查。
  // 记下已套用的 nonce，避免刚挂载时（initialView 已作为初始 state 生效）又重复查一次。
  const appliedNonceRef = useRef<number | undefined>(viewNonce);
  useEffect(() => {
    if (viewNonce === undefined || !initialView) return;
    if (appliedNonceRef.current === viewNonce) return;
    appliedNonceRef.current = viewNonce;
    setView(initialView);
    void loadData(1, pageSize, initialView);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewNonce]);

  /** 筛选 / 排序变化后统一从这里重查：回到第 1 页，避免停在越界页码上看空表 */
  const applyView = useCallback(
    (next: DbTableViewState) => {
      setView(next);
      void loadData(1, pageSize, next);
    },
    [loadData, pageSize],
  );

  // 页内搜索仍然保留：它是「在这一页里快速找」，与 SQL 级筛选是两层，文案上必须区分开
  const displayRows = useMemo(() => {
    const rows = queryResult?.rows ?? [];
    if (!filterText.trim()) return rows;
    const lower = filterText.toLowerCase();
    return rows.filter((row) =>
      Object.values(row).some(
        (val) => val !== null && val !== undefined && String(val).toLowerCase().includes(lower),
      ),
    );
  }, [queryResult?.rows, filterText]);

  const changeCount = countStagedChanges(staged);
  const stagedCount = staged.updates.length + staged.deletes.length;
  const newRowCount = staged.inserts.length;

  // ── 复制 ──────────────────────────────────────────────────────────────────

  const copy = useCallback(
    async (text: string, label: string) => {
      try {
        await navigator.clipboard.writeText(text);
        onShowToast?.(`已复制${label}`, text, 'success');
      } catch {
        onShowToast?.(`复制${label}失败`, undefined, 'error');
      }
    },
    [onShowToast],
  );

  const handleCopyCell = (text: string, key: string) => {
    void navigator.clipboard.writeText(text).catch(() => {});
    setCopiedCell(key);
    setTimeout(() => setCopiedCell(null), 1500);
  };

  const handleExportCsv = () => {
    if (!queryResult?.rows || queryResult.rows.length === 0) {
      onShowToast?.('当前无数据可导出');
      return;
    }
    const cols = queryResult.columns;
    const headerLine = cols.map((c) => `"${c.replace(/"/g, '""')}"`).join(',');
    const rowLines = queryResult.rows.map((r) =>
      cols
        .map((c) => {
          // 与表格里显示的一致（时间走本地时间格式化），避免导出出来和界面看到的不一样
          const text = formatCellValue(r[c]);
          if (text === '') return '';
          return `"${text.replace(/"/g, '""')}"`;
        })
        .join(','),
    );
    const csvContent = [headerLine, ...rowLines].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${tableName}_export.csv`;
    a.click();
    URL.revokeObjectURL(url);
    onShowToast?.(`已导出 CSV: ${tableName}_export.csv`, undefined, 'success');
  };

  // ── 单元格编辑 ────────────────────────────────────────────────────────────

  const beginEdit = (
    payload: { rowKey?: string; tempId?: string; column: string },
    current: any,
  ) => {
    setEditing({ ...payload, original: current, value: displayValue(current) });
  };

  const commitEdit = () => {
    if (!editing) return;
    const raw = editing.value;
    // 空串要按「空」提交而不是字符串 ""：清空一个 NOT NULL 列时，
    // 该写进去的是 NULL（由数据库决定是否符合约束），而不是一个空字符串
    const value: any = raw === '' ? null : raw;
    // 「改回原值就撤销标记」的比对要用**显示形态**：日期列的原值是 Date 对象，
    // 而输入框里是格式化后的字符串，直接比会永远判定为「改过」——
    // 用户双击一个时间格再点走，就会凭空多出一条 UPDATE。
    // NULL 仍按 null 参与比较（'' 与 null 在 isSameCellValue 里不等价）。
    const originalForCompare =
      editing.original === null || editing.original === undefined
        ? null
        : displayValue(editing.original);
    if (editing.tempId !== undefined) {
      setStaged((prev) => stageInsertCellEdit(prev, editing.tempId!, editing.column, value));
    } else if (editing.rowKey !== undefined) {
      setStaged((prev) =>
        stageCellEdit(prev, editing.rowKey!, editing.column, value, originalForCompare),
      );
    }
    // 记下刚提交的时刻：紧随其后的那次 click 只是「点走来结束编辑」，不该再当成复制
    justCommittedRef.current = Date.now();
    setEditing(null);
  };

  const cancelEdit = () => setEditing(null);

  /**
   * 点单元格 = 复制单元格内容；若这次点击刚好用来结束上一个编辑，则不复制。
   *
   * 值的提交全部发生在 `onBlur`（点走即落暂存），这里不碰值 —— 因为 mousedown
   * 先于 click，若在这里提交，紧随的 click 会把编辑器的值再复制进剪贴板。
   *
   * 另外，早期版本在 `onBlur` 里读 DOM 的 `input.value` 来提交，结果「输入后光标移走
   * 又变回原样」：React 重建 `<td>` 时输入框里的文本会丢，提交上去的是原值。
   * 现在输入值存在 `editing.value` 里由 `onChange` 同步，`onBlur` 直接读 state。
   */
  const handleCellClick = (text: string, key: string) => {
    if (Date.now() - justCommittedRef.current < 200) return;
    if (text) handleCopyCell(text, key);
  };

  // ── 暂存改动的操作 ────────────────────────────────────────────────────────

  const handleAddRow = () => {
    const tempId = `new_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    setStaged((prev) => stageInsertRow(prev, tempId));
  };

  const handleDeleteSelected = () => {
    if (!selectedRowKey) return;
    if (!hasPk) {
      onShowToast?.('该表无主键', '无法唯一定位一行，因此不支持删除。可改用 SQL 控制台手动操作。', 'warn');
      return;
    }
    setStaged((prev) => stageDeleteRow(prev, selectedRowKey));
    setSelectedRowKey(null);
  };

  const handleRevertAll = () => {
    setStaged(emptyStagedChanges());
    setEditing(null);
    setSelectedRowKey(null);
  };

  // ── 提交 ──────────────────────────────────────────────────────────────────

  /** 把暂存改动汇总成语句；失败时返回中文原因 */
  const currentStatements = useCallback((): { ok: true; statements: string[] } | { ok: false; error: string } => {
    const problems = validateStagedInserts(columns, staged.inserts);
    if (problems.length > 0) return { ok: false, error: problems.join('；') };
    return buildCommitStatements(
      staged,
      driver,
      querySchema,
      tableName,
      columns,
      originalRowsRef.current,
    );
  }, [staged, columns, driver, querySchema, tableName]);

  const handleGenerateSql = () => {
    const built = currentStatements();
    if (!built.ok) {
      onShowToast?.('无法生成 SQL', built.error, 'warn');
      return;
    }
    onOpenConsole?.(built.statements.join('\n'));
  };

  const handleSubmit = async (statements: string[]) => {
    if (!window.ide?.dbExecuteBatch) return;

    setSubmitting(true);
    try {
      const res = await window.ide.dbExecuteBatch(connectionId, statements, schemaName);
      if (res.ok) {
        setStaged(emptyStagedChanges());
        setSelectedRowKey(null);
        onShowToast?.(`已提交 ${changeCount} 项改动`, `影响 ${res.results.length} 条语句`, 'success');
        await loadData(page, pageSize);
      } else {
        // 保留暂存：用户的编辑没有落库，清掉等于让他重敲一遍
        const bad = res.results.find((r) => !r.ok);
        const detail = bad ? `${bad.sql}\n\n${bad.error}` : res.error;
        onShowToast?.('提交失败，已整体回滚', detail, 'error');
        if (res.rolledBack === false) {
          onShowToast?.(
            '回滚未成功',
            '数据可能处于半改状态，请刷新后核对数据再重试。',
            'error',
          );
        }
      }
    } catch (err: any) {
      onShowToast?.('提交异常', err.message || String(err), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  // ── 右键菜单贴边翻转 / 关闭 ───────────────────────────────────────────────

  useEffect(() => {
    if (!rowMenu) return;
    const el = rowMenuRef.current;
    if (el) {
      const rect = el.getBoundingClientRect();
      let x = rowMenu.x;
      let y = rowMenu.y;
      if (x + rect.width > window.innerWidth - 8) x = Math.max(8, window.innerWidth - rect.width - 8);
      if (y + rect.height > window.innerHeight - 8) y = Math.max(8, window.innerHeight - rect.height - 8);
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    }
    const onDown = (e: MouseEvent) => {
      if (rowMenuRef.current && !rowMenuRef.current.contains(e.target as Node)) setRowMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setRowMenu(null);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [rowMenu]);

  // ── 列头：排序与筛选 ──────────────────────────────────────────────────────

  /**
   * 列菜单里直接指定方向。
   *
   * - `null` = 清除该列的排序；**必须单独处理**，不能把 null 交给 `nextSortState` 的
   *   循环语义（那会变成「升序 → 降序 → 取消」的推进，在未排序的列上等于反而加了个升序）。
   * - `append` 恒为真：菜单里没有修饰键可用，而多列排序是这个视图的既有能力，
   *   所以菜单只管「这一列的排序」，其余列保留；要去掉某一列用「清除排序」，
   *   要全清用条件栏的「全部清空」。
   */
  const handleSortPick = (colName: string, direction: 'asc' | 'desc' | null) => {
    setColumnMenu(null);
    if (direction === null) {
      applyView({ ...view, sorts: view.sorts.filter((s) => s.column !== colName) });
      return;
    }
    applyView({ ...view, sorts: nextSortState(view.sorts, colName, true, direction) });
  };

  /** 从列菜单进入筛选浮层；浮层锚点沿用菜单的位置，视线不用跳 */
  const openFilterFromColumnMenu = (colName: string, operator?: DbTableFilterOperator) => {
    const anchor = columnMenu?.anchor ?? { x: 0, y: 0 };
    const existing = view.filters.find((f) => f.column === colName);
    setColumnMenu(null);
    // 从菜单直接点了某个条件时，**不**预填已有的值：用户点的是「包含」这类新条件，
    // 带进旧值再让他改反而是干扰；要改旧条件走「修改筛选条件…」，那条路径带 initial。
    setFilterTarget(
      operator
        ? { column: colName, anchor, initialOperator: operator }
        : { column: colName, anchor, initial: existing },
    );
  };

  const removeFilter = (index: number) => {
    applyView({ ...view, filters: view.filters.filter((_, i) => i !== index) });
  };

  const removeFilterOfColumn = (column: string) => {
    applyView({ ...view, filters: view.filters.filter((f) => f.column !== column) });
  };

  const removeSort = (column: string) => {
    applyView({ ...view, sorts: view.sorts.filter((s) => s.column !== column) });
  };

  const clearView = () => applyView(EMPTY_VIEW_STATE);

  // ── 渲染辅助 ──────────────────────────────────────────────────────────────

  const hasNext = (queryResult?.rows?.length ?? 0) === pageSize;
  const hasPrev = page > 1;
  const viewActive = !isEmptyViewState(view);

  /**
   * 左上角展示用的完整语句。
   *
   * 与 `loadData` 里真正下发的语句**同源**（同一个 `buildTableQuerySql`），
   * 只多补一段 `LIMIT/OFFSET` —— 分页在主进程 `applyPagination` 里追加，
   * 主进程那条规则与 `buildFullTableSql` 必须保持一致，否则展示的就不是真正执行的语句。
   */
  const currentSql = useMemo(
    () =>
      buildFullTableSql(driver, querySchema, tableName, columns, view, page, pageSize),
    [driver, querySchema, tableName, columns, view, page, pageSize],
  );

  /** 该格是否被暂存改过（画橙色左边框标记） */
  const stagedCellsOf = (rowKey: string): Record<string, any> =>
    staged.updates.find((u) => u.rowKey === rowKey)?.cells ?? {};

  /** 渲染一个可编辑单元格 */
  const renderCell = (
    colName: string,
    value: any,
    key: string,
    editTarget: { rowKey?: string; tempId?: string },
    options?: { readOnly?: boolean; struck?: boolean },
  ) => {
    const meta = metaOf(colName);
    // 暂存过的格直接显示**暂存里的新值**：否则用户双击改完，格子里还是旧内容，
    // 只能靠一条橙色边框猜自己改成了什么
    const stagedCells =
      editTarget.rowKey !== undefined ? stagedCellsOf(editTarget.rowKey) : undefined;
    const hasStagedValue = stagedCells !== undefined && colName in stagedCells;
    const shown = hasStagedValue ? stagedCells![colName] : value;
    const isNull = shown === null || shown === undefined;
    const isEditing =
      editing &&
      editing.column === colName &&
      editing.rowKey === editTarget.rowKey &&
      editing.tempId === editTarget.tempId;
    const edited = hasStagedValue;
    // 主键列在**已有行**上只读：改 PK 会让 rowKey 漂移，暂存改动的归属就乱了。
    // 但新增行例外 —— 那时主键还没有值，用户本来就可能要显式指定。
    const readOnly =
      options?.readOnly || !hasPk || (pkNames.has(colName) && editTarget.rowKey !== undefined);

    if (isEditing) {
      return (
        <td key={key} className="db-data-cell editing">
          <input
            autoFocus
            type="text"
            className="db-cell-editor"
            value={editing.value}
            onChange={(e) => {
              const next = e.target.value;
              setEditing((prev) => (prev ? { ...prev, value: next } : prev));
            }}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitEdit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                // Esc 是「放弃这次编辑」：先把值还原成进入编辑器时的文本，
                // 否则紧接着的 blur 会把改到一半的内容照样提交进暂存
                setEditing((prev) => (prev ? { ...prev, value: displayValue(prev.original) } : prev));
                cancelEdit();
              }
            }}
          />
        </td>
      );
    }

    const displayStr = isNull ? 'NULL' : displayValue(shown);

    /**
     * 新增行里有默认值、用户又还没填的列：给一句灰色提示。
     *
     * 它**只是提示，不是值** —— 不写进 `ins.cells`，`buildInsertSql` 就会把该列排除在
     * INSERT 的列清单之外，数据库应用它自己的默认值。若这里顺手把提示赋成真值，
     * `CURRENT_TIMESTAMP` 这类会被写死成一个固定字符串，自动默认值当场失效。
     */
    const defaultHint =
      editTarget.tempId !== undefined && !hasStagedValue && isNull
        ? defaultDisplayHint(meta, driver)
        : null;

    return (
      <td
        key={key}
        className={`db-data-cell${edited ? ' staged' : ''}${options?.struck ? ' struck' : ''}`}
        title={
          readOnly
            ? pkNames.has(colName)
              ? '主键列不可直接编辑，请用 SQL 控制台修改'
              : '该表无主键，不支持修改已有数据'
            : `双击编辑 · 单击复制${meta?.type ? ` · ${meta.type}` : ''}`
        }
        onClick={() => handleCellClick(displayStr === 'NULL' ? '' : displayStr, key)}
        onDoubleClick={(e) => {
          e.stopPropagation();
          if (readOnly) return;
          beginEdit({ ...editTarget, column: colName }, value);
        }}
        style={{
          color: isNull ? 'rgba(255, 255, 255, 0.3)' : 'var(--text)',
          fontStyle: isNull ? 'italic' : 'normal',
          cursor: readOnly ? 'default' : 'text',
          background:
            copiedCell === key ? 'rgba(16, 185, 129, 0.15)' : edited ? 'rgba(245, 158, 11, 0.1)' : undefined,
        }}
      >
        {defaultHint ? <span className="db-cell-default-hint">默认 {defaultHint}</span> : displayStr}
      </td>
    );
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        background: 'var(--bg-editor, #141414)',
        color: 'var(--text)',
        fontSize: 12,
        userSelect: 'text',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      {/* ── 顶部数据操作栏（对齐 Maven 规范：height 30 / padding 0 10px / panel-action-btn） ── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          height: 30,
          padding: '0 10px',
          boxSizing: 'border-box',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
          gap: 8,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <span style={{ fontSize: 12, fontWeight: 700 }}>{tableName}</span>
          {/* 列数以**这次真正查出来的结果集**为准：列元数据是异步取的，切表瞬间可能还是上一张表的，
              用它来报数就会和表头渲染出来的列对不上（「63 列」却只看到几列）*/}
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {queryResult?.columns.length ?? columns.length} 列
          </span>
          {!hasPk && (
            <span style={{ fontSize: 11, color: '#f59e0b' }} title="没有主键就无法唯一定位一行">
              无主键
            </span>
          )}
        </div>

        {/* 页内搜索（注意与下面的 SQL 级「筛选条件」是两层） */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, maxWidth: 360 }}>
          <div style={{ position: 'relative', width: '100%' }}>
            <input
              type="text"
              placeholder="页内搜索（仅过滤本页已加载的行）"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                background: 'var(--bg-panel, #1e1e1e)',
                color: 'var(--text)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                padding: '3px 8px',
                fontSize: 11,
                outline: 'none',
              }}
            />
            {filterText && (
              <span
                onClick={() => setFilterText('')}
                style={{
                  position: 'absolute',
                  right: 8,
                  top: 3,
                  cursor: 'pointer',
                  color: 'var(--text-muted)',
                  fontSize: 12,
                }}
              >
                ✕
              </span>
            )}
          </div>
          {queryResult && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
              {queryResult.executionTimeMs}ms
            </span>
          )}
        </div>

        {/* 右侧操作群 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
          <button
            type="button"
            className="panel-action-btn"
            title={hasPk ? '新增一行（暂存，提交后写库）' : '新增一行（该表无主键，仅支持新增）'}
            onClick={handleAddRow}
            disabled={loading}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>

          <button
            type="button"
            className="panel-action-btn"
            title={hasPk ? '删除选中的行（先点行号选中）' : '该表无主键，不支持删除'}
            onClick={handleDeleteSelected}
            disabled={!selectedRowKey || !hasPk}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18" />
              <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
              <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
            </svg>
          </button>

          {/* 撤销是「兜底」动作，不是高频操作：给它一个描边而非实心的次要样式，
              避免和旁边绿色的「提交」抢视线，也让它一眼看出是「清空」而不是又一个写库按钮 */}
          {changeCount > 0 && (
            <button
              type="button"
              className="db-btn-undo"
              title="撤销全部未提交的改动"
              onClick={handleRevertAll}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7v6h6" />
                <path d="M3.51 13a9 9 0 1 0 2.13-9.36L3 7" />
              </svg>
              <span>撤销 {changeCount} 项</span>
            </button>
          )}

          <button
            type="button"
            className="panel-action-btn"
            title="把暂存改动生成 SQL 并在控制台打开（可先核对再执行）"
            onClick={handleGenerateSql}
            disabled={changeCount === 0 || !onOpenConsole}
          >
            <span style={{ fontSize: 11, padding: '0 4px' }}>生成 SQL</span>
          </button>

          <button
            type="button"
            className="db-btn-commit"
            title="在一个事务里提交全部暂存改动，失败整体回滚"
            onClick={() => {
              const built = currentStatements();
              if (!built.ok) {
                onShowToast?.('无法提交', built.error, 'warn');
                return;
              }
              // 先弹确认框；真正下发在弹窗的 onConfirm 里（见 handleSubmit）
              setSubmitConfirm({
                statements: built.statements,
                content: buildSqlConfirmMarkdown({
                  intro: `即将提交 **${changeCount}** 项改动，共 ${built.statements.length} 条语句。`,
                  statements: built.statements,
                  notes: ['这些语句会在**同一个事务**里执行，任一失败则整体回滚。'],
                }),
              });
            }}
            disabled={changeCount === 0 || submitting}
          >
            {submitting ? '提交中…' : `提交 ${changeCount} 项改动`}
          </button>

          <div style={{ width: 1, height: 16, background: 'var(--border)', margin: '0 4px' }} />

          <button
            type="button"
            className="panel-action-btn"
            title="刷新数据"
            onClick={() => void loadData(page, pageSize)}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ animation: loading ? 'spin 1s linear infinite' : undefined }}
            >
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
            </svg>
          </button>

          {onOpenConsole && (
            <button
              type="button"
              className="panel-action-btn"
              title="在 SQL 查询控制台中打开"
              onClick={() =>
                onOpenConsole(`${buildSelectSql(driver, schemaName, tableName)} LIMIT 100;`)
              }
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
            </button>
          )}

          <button
            type="button"
            className="panel-action-btn"
            title="导出当前结果为 CSV"
            onClick={handleExportCsv}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>

          {/* 显示字段：字段多的表在表头里横向划很久才能找到目标列，这里可搜可勾 */}
          <button
            type="button"
            ref={pickerBtnRef}
            className={`panel-action-btn${pickerAnchor ? ' active' : ''}${
              visibleColumns.length < (queryResult?.columns.length ?? 0) ? ' filtered' : ''
            }`}
            title="选择要显示哪些字段"
            disabled={!queryResult || visibleColumns.length === 0}
            onClick={(e) => {
              e.stopPropagation();
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              // 右边缘对齐按钮右边缘：浮层从按钮正下方往左展开，
              // 看上去就是「挂在」那个按钮上，而不是飘在工具栏中间
              setPickerAnchor((prev) =>
                prev ? null : { x: rect.right, y: rect.bottom + 4, align: 'right' as const },
              );
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginLeft: 4 }}>
            <button
              type="button"
              className="panel-action-btn"
              title="上一页"
              disabled={!hasPrev || loading}
              onClick={() => void loadData(page - 1, pageSize)}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
            <button
              type="button"
              className="panel-action-btn"
              title="下一页"
              disabled={!hasNext || loading}
              onClick={() => void loadData(page + 1, pageSize)}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* ── 完整 SQL + 筛选 / 排序条件（SQL 级，跨页生效） ──
          即使没有任何筛选，也把完整语句亮出来：用户最常问的就是「这一屏到底查的是什么」。 */}
      <DbFilterSqlBar
        sql={currentSql}
        columns={columns}
        view={view}
        onEditFilter={(column, anchor) => {
          const initial = view.filters.find((f) => f.column === column);
          setFilterTarget({ column, anchor, initial });
        }}
        onRemoveFilter={removeFilter}
        onRemoveSort={removeSort}
        onClearAll={clearView}
        onShowToast={onShowToast}
      />

      {/* 无主键提示：只允许新增，改 / 删会被拦下 */}
      {!hasPk && !loading && columns.length > 0 && (
        <div className="db-no-pk-banner">
          该表没有主键，无法唯一定位一行 —— 仅支持新增行；修改 / 删除请使用 SQL 控制台。
        </div>
      )}

      {/* ── 数据表格展示区 ── */}
      <div
        ref={scrollRef}
        style={{ flex: 1, overflow: 'auto', minHeight: 0, position: 'relative' }}
      >
        {loading && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: 'rgba(20, 20, 20, 0.4)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 10,
            }}
          >
            <div style={{ color: '#60a5fa', fontSize: 12 }}>加载数据中...</div>
          </div>
        )}

        {queryResult ? (
          <table
            className="db-data-table"
            style={{
              // 宽度由 layoutColumns 算好：列少时铺满面板，拖宽某列时由最后一列让位，
              // 被拖的列 1:1 跟手。交给 CSS 自动布局做不到 —— 表格被撑宽后
              // 浏览器会把多出来的空间按比例摊回各列，拖动效果就被冲淡了。
              width: tableWidth,
              borderCollapse: 'collapse',
              fontSize: 12,
              textAlign: 'left',
              fontFamily: 'var(--font-mono, monospace)',
              tableLayout: 'fixed',
            }}
          >
            {/* 列宽走 colgroup：给 th 加 sticky / z-index 时宽度会被内容挤变，
                colgroup 是唯一能让拖动结果稳定生效的地方 */}
            <colgroup>
              <col style={{ width: INDEX_COLUMN_WIDTH }} />
              {visibleColumns.map((col) => (
                <col key={col} style={{ width: columnWidths[col] }} />
              ))}
            </colgroup>
            <thead>
              <tr
                style={{
                  background: 'var(--db-bg-header)',
                  position: 'sticky',
                  top: 0,
                  zIndex: 2,
                  boxShadow: '0 1px 2px rgba(0, 0, 0, 0.2)',
                }}
              >
                <th className="db-data-th index">#</th>
                {visibleColumns.map((colName) => {
                  const meta = metaOf(colName);
                  const dir = sortDirectionOf(view.sorts, colName);
                  const sortIndex = view.sorts.findIndex((s) => s.column === colName);
                  const filterIndex = view.filters.findIndex((f) => f.column === colName);
                  const menuOpen = columnMenu?.column === colName;
                  return (
                    <th key={colName} className="db-data-th">
                      <div className="db-col-head">
                        {/* 类型角标（123 / A-Z / 🕐）：放在列名**左边**，扫一眼就知道这列能不能比大小。
                            三个字符的宽度是固定的，所以列名该截断还是照旧截断 */}
                        {meta && (
                          <span className="db-col-type">
                            {columnCategoryBadge(meta, driver)}
                          </span>
                        )}
                        {/* 字段名是纯标签，不可点：原来整块列宽都是下拉热区，
                            点列名想选中/拖宽时会误开菜单。热区收窄到右侧那个箭头。

                            这里**刻意不写 title**：全局 GlobalTooltip 会把 title 摘走改成
                            data-app-tooltip 并回退成纯文本提示，与下面的 DbHoverCard 打架。
                            类型 / 主键 / 注释都交给悬浮卡片去说。 */}
                        <span
                          className="db-col-name"
                          onMouseEnter={(e) => {
                            if (!meta) return;
                            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                            openColumnCard(meta, rect);
                          }}
                          onMouseLeave={closeColumnCard}
                        >
                          {colName}
                        </span>
                        {meta?.pk && <span className="db-col-pk-dot" title="主键" />}
                        {dir && (
                          <span className="db-col-dir">
                            {dir === 'asc' ? '▲' : '▼'}
                            {/* 多列排序时标出次序，否则用户不知道哪个是主排序 */}
                            {view.sorts.length > 1 ? sortIndex + 1 : ''}
                          </span>
                        )}
                        {filterIndex >= 0 && <span className="db-col-filter-dot" title="已设置筛选条件" />}
                        {/* 排序 / 筛选菜单只从这一个箭头打开（点列名不再触发） */}
                        <button
                          type="button"
                          className={`db-col-trigger${dir ? ' sorted' : ''}${
                            filterIndex >= 0 ? ' filtered' : ''
                          }${menuOpen ? ' open' : ''}`}
                          title="排序或筛选本字段"
                          onClick={(e) => {
                            e.stopPropagation();
                            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                            setColumnMenu((prev) =>
                              prev?.column === colName
                                ? null
                                : { column: colName, anchor: { x: rect.left, y: rect.bottom + 2 } },
                            );
                          }}
                        >
                          <svg
                            className="db-col-caret"
                            width="11"
                            height="11"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        </button>
                      </div>
                      {/* 拖列宽的分隔条：只有右边缘这一条热区，双击恢复默认宽度 */}
                      <span
                        className={`db-col-resizer${resizing?.column === colName ? ' active' : ''}`}
                        title="拖动调整列宽 · 双击恢复默认"
                        onClick={(e) => e.stopPropagation()}
                        onMouseDown={(e) => {
                          // 只处理左键：右键 / 中键点到这里不该进入拖动态
                          if (e.button !== 0) return;
                          e.preventDefault();
                          e.stopPropagation();
                          // 同步禁用整页选中，不能等 effect：effect 要等这次 mousedown
                          // 走完才跑，而浏览器此刻**已经**按原生行为起了选区
                          document.body.classList.add('db-col-resizing');
                          window.getSelection()?.removeAllRanges();
                          dragMovedRef.current = false;
                          // 记下起点这一帧各列的宽度：松手时整帧落盘，画面才不会跳
                          dragBaseWidthsRef.current = columnWidths;
                          const startWidth = columnWidths[colName] ?? 0;
                          dragWidthRef.current = startWidth;
                          lastFrameWidthRef.current = startWidth;
                          setDragWidth(startWidth);
                          setResizing({ column: colName, startX: e.clientX, startWidth });
                        }}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          setColumnPrefs((prev) => resetColumnWidth(prev, colName));
                        }}
                      />
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {/* 新增行排在最前：它们还没落库，要一眼能看到自己刚加了什么 */}
              {staged.inserts.map((ins, insIdx) => (
                <tr key={ins.tempId} className="db-data-row new">
                  <td className="db-data-cell index">
                    <button
                      type="button"
                      className="db-new-badge"
                      title="撤销这一新增行"
                      onClick={() => setStaged((prev) => unstageInsertRow(prev, ins.tempId))}
                    >
                      +{insIdx + 1} ✕
                    </button>
                  </td>
                  {visibleColumns.map((col) =>
                    renderCell(col, ins.cells[col], `${ins.tempId}-${col}`, { tempId: ins.tempId }),
                  )}
                </tr>
              ))}

              {displayRows.map((row, rowIdx) => {
                const rowKey = buildRowKey(pkColumns, row, rowIdx);
                const isDeleted = staged.deletes.includes(rowKey);
                const hasEdits = staged.updates.some((u) => u.rowKey === rowKey);
                const globalIdx = (page - 1) * pageSize + rowIdx + 1;
                return (
                  <tr
                    key={rowKey}
                    className={`db-data-row${isDeleted ? ' deleted' : ''}${
                      selectedRowKey === rowKey ? ' selected' : ''
                    }${hasEdits ? ' edited' : ''}`}
                    onClick={() => setSelectedRowKey(rowKey)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setSelectedRowKey(rowKey);
                      setRowMenu({ x: e.clientX, y: e.clientY, rowKey });
                    }}
                  >
                    <td
                      className="db-data-cell index"
                      title="点击选中该行 · 右键更多操作"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedRowKey(rowKey);
                      }}
                    >
                      {globalIdx}
                    </td>
                    {visibleColumns.map((col) =>
                      renderCell(col, row[col], `${rowIdx}-${col}`, { rowKey }, { struck: isDeleted }),
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div
            style={{
              padding: '48px 16px',
              textAlign: 'center',
              color: 'var(--text-muted)',
              fontSize: 13,
            }}
          >
            当前表中无数据记录
          </div>
        )}

        {queryResult && displayRows.length === 0 && newRowCount === 0 && (
          <div
            style={{
              padding: '32px 16px',
              textAlign: 'center',
              color: 'var(--text-muted)',
              fontSize: 12,
            }}
          >
            {filterText
              ? '本页没有符合页内搜索的行（页内搜索只作用于已加载的这一页）'
              : viewActive
                ? '没有符合筛选条件的数据'
                : '当前表中无数据记录'}
          </div>
        )}
      </div>

      {/* ── 底部状态行 ── */}
      <div
        style={{
          height: 24,
          padding: '0 10px',
          borderTop: '1px solid var(--border)',
          background: 'rgba(0, 0, 0, 0.2)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: 11,
          color: 'var(--text-muted)',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', gap: 12 }}>
          {/* 总数仍是主进程的 rows.length 语义（控制台也在用），因此这里如实说「本页 M 行」而不是「共 X 页」 */}
          <span>
            第 {page} 页 · 本页 {queryResult?.rows?.length ?? 0} 行
          </span>
          {filterText && <span>页内搜索命中 {displayRows.length} 行</span>}
          {stagedCount > 0 && (
            <span style={{ color: '#f59e0b' }}>
              已修改 {stagedCount} 行
              {newRowCount > 0 ? ` · 新增 ${newRowCount} 行` : ''}
            </span>
          )}
        </div>
        <div>双击单元格编辑 · 单击复制 · 行号右键更多操作</div>
      </div>

      {/* 提交确认：Markdown 渲染，每条 SQL 各自一个可复制的代码块 */}
      <DbConfirmModal
        isOpen={submitConfirm !== null}
        title={`提交 ${changeCount} 项改动`}
        content={submitConfirm?.content ?? ''}
        confirmLabel="确认提交"
        onConfirm={() => {
          const statements = submitConfirm?.statements ?? [];
          setSubmitConfirm(null);
          void handleSubmit(statements);
        }}
        onCancel={() => setSubmitConfirm(null)}
      />

      {/* 列头悬浮卡片（图2）：类型约束 + 数据库列注释。
          与全局 GlobalTooltip 是两套机制 —— 列名元素上刻意没有 title，
          否则 GlobalTooltip 会把 title 摘走再回退成纯文本，两张提示会同时出现。 */}
      {columnCard && <DbHoverCard content={columnCard.content} anchor={columnCard.anchor} />}

      {/* 列头菜单：排序 + 筛选入口 */}
      {columnMenu && (
        <DbColumnMenu
          column={columnMenu.column}
          meta={metaOf(columnMenu.column)}
          sortDirection={sortDirectionOf(view.sorts, columnMenu.column)}
          hasFilter={view.filters.some((f) => f.column === columnMenu.column)}
          filterSummary={(() => {
            const f = view.filters.find((x) => x.column === columnMenu.column);
            return f ? describeFilter(f, metaOf(columnMenu.column)?.type) : undefined;
          })()}
          anchor={columnMenu.anchor}
          onSort={(dir) => handleSortPick(columnMenu.column, dir)}
          onFilter={(operator) => openFilterFromColumnMenu(columnMenu.column, operator)}
          onClearFilter={() => {
            const col = columnMenu.column;
            setColumnMenu(null);
            removeFilterOfColumn(col);
          }}
          onHide={() => {
            const col = columnMenu.column;
            setColumnMenu(null);
            setColumnPrefs((prev) => setColumnHidden(prev, col, true));
          }}
          onClose={() => setColumnMenu(null)}
        />
      )}

      {/* 列选择器：右上角「显示字段」按钮 */}
      {pickerAnchor && queryResult && (
        <DbColumnPicker
          columns={queryResult.columns}
          metaOf={metaOf}
          hidden={columnPrefs.hidden}
          anchor={pickerAnchor}
          onToggle={(column, hidden) =>
            setColumnPrefs((prev) => setColumnHidden(prev, column, hidden))
          }
          onSetAll={(hidden) =>
            setColumnPrefs((prev) =>
              setAllColumnsHidden(prev, queryResult.columns, hidden),
            )
          }
          onResetWidths={() => setColumnPrefs((prev) => ({ ...prev, widths: {} }))}
          onClose={() => {
            setPickerAnchor(null);
            pickerBtnRef.current?.blur();
          }}
        />
      )}

      {/* 列筛选浮层 */}
      {filterTarget && (
        <DbFilterPopover
          column={filterTarget.column}
          meta={metaOf(filterTarget.column)}
          initial={filterTarget.initial}
          initialOperator={filterTarget.initialOperator}
          anchor={filterTarget.anchor}
          onApply={(condition) => {
            const rest = view.filters.filter((f) => f.column !== condition.column);
            setFilterTarget(null);
            applyView({ ...view, filters: [...rest, condition] });
          }}
          onCancel={() => setFilterTarget(null)}
        />
      )}

      {/* 行右键菜单 */}
      {rowMenu && (
        <div
          ref={rowMenuRef}
          className="tab-context-menu"
          style={{ top: rowMenu.y, left: rowMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="menu-item"
            role="menuitem"
            onClick={() => {
              const key = rowMenu.rowKey;
              const row = originalRowsRef.current[key];
              setRowMenu(null);
              if (!row) return;
              const isDeleted = staged.deletes.includes(key);
              setStaged((prev) =>
                isDeleted ? unstageDeleteRow(prev, key) : stageDeleteRow(prev, key),
              );
            }}
          >
            <div className="menu-item-left">
              <span className="menu-item-icon" />
              <span>
                {staged.deletes.includes(rowMenu.rowKey) ? '取消删除此行' : '删除此行（暂存）'}
              </span>
            </div>
          </div>
          <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
          <div
            className="menu-item"
            role="menuitem"
            onClick={() => {
              const row = originalRowsRef.current[rowMenu.rowKey];
              setRowMenu(null);
              if (row) void copy(buildInsertSql(driver, querySchema, tableName, columns, row), 'INSERT 语句');
            }}
          >
            <div className="menu-item-left">
              <span className="menu-item-icon" />
              <span>复制为 INSERT</span>
            </div>
          </div>
          <div
            className="menu-item"
            role="menuitem"
            onClick={() => {
              const row = originalRowsRef.current[rowMenu.rowKey];
              setRowMenu(null);
              if (!row) return;
              // 用整行现值拼一条 UPDATE 模板：用户拿到控制台里改几个值就能直接用
              const filtered: Record<string, any> = {};
              for (const col of columns) {
                if (pkNames.has(col.name)) continue;
                filtered[col.name] = row[col.name];
              }
              const sql = buildUpdateSql(driver, querySchema, tableName, filtered, columns, row);
              if (sql) void copy(sql, 'UPDATE 语句');
              else onShowToast?.('无法生成 UPDATE', '该表没有主键，无法定位行', 'warn');
            }}
          >
            <div className="menu-item-left">
              <span className="menu-item-icon" />
              <span>复制为 UPDATE</span>
            </div>
          </div>
          <div
            className="menu-item"
            role="menuitem"
            onClick={() => {
              const key = rowMenu.rowKey;
              const row = originalRowsRef.current[key];
              setRowMenu(null);
              if (!row) return;
              const where = buildRowWhereClause(driver, pkColumns, row);
              if (where) void copy(where, 'WHERE 片段');
              else onShowToast?.('无法生成 WHERE', '该表没有主键', 'warn');
            }}
          >
            <div className="menu-item-left">
              <span className="menu-item-icon" />
              <span>复制主键 WHERE</span>
            </div>
          </div>
          <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
          <div
            className="menu-item"
            role="menuitem"
            onClick={() => {
              const row = originalRowsRef.current[rowMenu.rowKey];
              setRowMenu(null);
              if (!row) return;
              const sql = buildDeleteSql(driver, querySchema, tableName, columns, row);
              if (sql) void copy(sql, 'DELETE 语句');
            }}
          >
            <div className="menu-item-left">
              <span className="menu-item-icon" />
              <span>复制为 DELETE</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

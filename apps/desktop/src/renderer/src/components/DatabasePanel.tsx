import React, { useState, useEffect, useCallback, useLayoutEffect, useRef } from 'react';
import type {
  DatabaseConnectionInfo,
  DatabaseTableInfo,
  DatabaseColumnMeta,
  DatabaseSchemaInfo,
  DbConnectionView,
  DbObjectGroup,
  DbSavedConnection,
  DbSchemaObjects,
  WorkspaceInfo,
} from '@deepseek-ide/shared';
import { NewDbConnectionModal } from './NewDbConnectionModal';
import { TableStructureModal } from './TableStructureModal';
import { PanelChevron } from './PanelChevron';
import {
  DbGroupRow,
  DbObjectRow,
  EMPTY_GROUP_HINT,
  GroupIcon,
  groupNames,
  OBJECT_GROUPS,
} from './DbObjectGroups';
import { buildTableSelectSql, qualifyIdent, quoteIdent } from '../services/dbIdentifiers';
import { checkConnectionPreflight } from '../services/dbConnectionForm';
import {
  buildCreateDatabaseSql,
  buildDropDatabaseSql,
  buildDropTableSql,
  buildRenameDatabaseScript,
  databaseLevelNoun,
  supportsDatabaseLevel,
} from '../services/dbDdl';
import { buildRowInsertSql } from '../services/dbMutations';
import { buildSqlConfirmMarkdown, confirmLabelFor, mdCode } from '../services/dbConfirmContent';
import { NEW_CONSOLE_SQL } from '../services/dbQueryScripts';
import { useDbConfirm } from '../hooks/useDbConfirm';
import type { DbTableFilterCondition, DbTableViewState } from '../services/dbTableQuery';

/** 树节点右键菜单的目标层级 */
type DbMenuTarget =
  | { kind: 'conn'; connId: string }
  | { kind: 'schema'; connId: string; schemaName: string }
  | { kind: 'table'; connId: string; schemaName: string; tableName: string }
  | { kind: 'column'; connId: string; schemaName: string; tableName: string; columnName: string };

export interface DatabasePanelProps {
  /** schema 为 MySQL 的库名 / PostgreSQL 的 schema 名 / SQLite 的 main */
  onOpenTableData?: (
    connId: string,
    tableName: string,
    schemaName?: string,
    /** 由树上的「按此列排序 / 筛选」带过来的初始条件 */
    view?: DbTableViewState,
  ) => void;
  /**
   * 打开「表结构」视图。
   *
   * 名字从「查看表 DDL」改成「查看表结构」：编辑区里不止有 DDL 原文，
   * 还多了一个可编辑的列清单（图4），DDL 只是其中一种呈现形态。
   */
  onOpenTableStructure?: (connId: string, tableName: string, schemaName?: string) => void;
  onOpenSqlConsole?: (
    connId: string,
    schemaName: string | undefined,
    initialSql: string,
    title: string,
  ) => void;
  /**
   * 项目里保存过的查询脚本（磁盘上的 `queries/` 清单，不是当前打开的标签）。
   *
   * 由 App 投影下来：面板自己读不到项目配置目录，也无权知道当前工作区是哪一个。
   */
  scripts?: DbProjectScriptEntry[];
  /** 点开一个已保存的脚本：在 SQL 控制台里打开并可直接运行 */
  onOpenScript?: (script: DbProjectScriptEntry) => void;
  /** 删除一个已保存的脚本（会二次确认） */
  onDeleteScript?: (script: DbProjectScriptEntry) => void;
  /** 当前打开着的脚本相对路径集合：列表里给它们一个「已打开」记号 */
  openScriptPaths?: string[];
  onShowToast?: (title: string, detail?: string, type?: 'success' | 'error' | 'info' | 'warn') => void;
}

/** 面板底部「项目查询脚本」列表里的一条 */
export interface DbProjectScriptEntry {
  /** 相对项目配置目录的路径，`queries/<连接>/<库段>/<文件>.sql` */
  scriptPath: string;
  fileName: string;
  /** 标签标题（去掉 .sql 后缀） */
  title: string;
  connectionId: string;
  /** 落盘时的库段；新脚本恒为 `_project` */
  scope: string;
  /** 连接名，用于消除「同名脚本属于哪条连接」的歧义 */
  connectionLabel?: string;
}

// ── SVG 图标组件 ─────────────────────────────────────────────────────────────

function IconReload({ spinning }: { spinning?: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        animation: spinning ? 'spin 1s linear infinite' : undefined,
        display: 'block',
      }}
    >
      <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
    </svg>
  );
}

function IconPlus() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function IconBolt() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

// ── 右键菜单图标（与 .menu-item-icon 的 13x13 视觉尺寸一致）────────────────────

function IconMenuData() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M3 9h18" />
      <path d="M3 15h18" />
      <path d="M12 3v18" />
    </svg>
  );
}

function IconMenuDdl() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="13" y2="17" />
    </svg>
  );
}

function IconMenuColumns() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="9" x2="20" y2="9" />
      <line x1="4" y1="15" x2="20" y2="15" />
      <line x1="10" y1="3" x2="8" y2="21" />
      <line x1="16" y1="3" x2="14" y2="21" />
    </svg>
  );
}

function IconMenuCopy() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="14" height="14" x="8" y="8" rx="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}

function IconMenuRefresh() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
    </svg>
  );
}

function IconMenuExpand() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="7 13 12 18 17 13" />
      <polyline points="7 6 12 11 17 6" />
    </svg>
  );
}

function IconMenuPlug() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22v-5" />
      <path d="M9 8V2" />
      <path d="M15 8V2" />
      <path d="M18 8v3a6 6 0 0 1-12 0V8z" />
    </svg>
  );
}

function IconMenuCsv() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function IconTable() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v18" />
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M3 9h18" />
      <path d="M3 15h18" />
    </svg>
  );
}

function IconColumn() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="9" x2="20" y2="9" />
      <line x1="4" y1="15" x2="20" y2="15" />
      <line x1="10" y1="3" x2="8" y2="21" />
      <line x1="16" y1="3" x2="14" y2="21" />
    </svg>
  );
}

function IconKey() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="m21 2-9.6 9.6" />
      <path d="m15.5 7.5 3 3L22 7l-3-3" />
    </svg>
  );
}

function IconChevronRight() {
  return <PanelChevron expanded={false} size={12} />;
}

function IconChevronDown() {
  return <PanelChevron expanded={true} size={12} />;
}

function IconDatabase() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
      <path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </svg>
  );
}

function IconMenuLink() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 17H7A5 5 0 0 1 7 7h2" />
      <path d="M15 7h2a5 5 0 1 1 0 10h-2" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </svg>
  );
}

function IconMenuEdit() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z" />
    </svg>
  );
}

/** 树节点下方的错误行（避免像以前那样把错误吞进 console 里） */
function TreeError({ message }: { message: string }) {
  return (
    <div
      style={{
        fontSize: 11,
        color: '#f87171',
        padding: '2px 6px 4px 22px',
        lineHeight: 1.4,
        wordBreak: 'break-word',
      }}
      title={message}
    >
      ⚠ {message}
    </div>
  );
}

/** 右键菜单的分组标题，视觉上对齐标签页菜单 */
function MenuDivider() {
  return <div className="menu-divider" />;
}

interface MenuItemProps {
  icon: React.ReactNode;
  label: string;
  danger?: boolean;
  onClick: () => void;
}

function MenuItem({ icon, label, danger, onClick }: MenuItemProps) {
  return (
    <div
      className={`menu-item${danger ? ' menu-item-danger' : ''}`}
      onClick={onClick}
      role="menuitem"
      tabIndex={-1}
    >
      <div className="menu-item-left">
        <span className="menu-item-icon" style={{ display: 'inline-flex' }}>
          {icon}
        </span>
        <span>{label}</span>
      </div>
    </div>
  );
}

/** 复制文本到剪贴板，失败时回退到 execCommand（Electron 渲染进程里 clipboard API 偶尔被权限拦截） */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

// ── 项目查询脚本列表（面板底部，图3）────────────────────────────────────────

/**
 * 面板底部的「项目查询脚本」分组。
 *
 * 列出的是**项目里落盘的脚本**（`queries/` 下所有 `.sql`），而不是当前打开的标签：
 * 用户关掉标签之后脚本并没有消失，能在列表里再次找到它才是这个分组的价值。
 * 已经打开的那些额外标一个记号，省得点开一个才发现「它早就在标签里了」。
 *
 * 标题条可点，收起后整块只剩一条 30px 的头 —— 面板高度是宝贵的，
 * 不写脚本的时候不该被这份清单一直占着。
 */
function ProjectScriptsList({
  scripts,
  openPaths,
  onOpen,
  onDelete,
}: {
  scripts: DbProjectScriptEntry[];
  openPaths: string[];
  onOpen?: (script: DbProjectScriptEntry) => void;
  onDelete?: (script: DbProjectScriptEntry) => void;
}) {
  const [collapsed, setCollapsed] = useState<boolean>(false);
  const openSet = new Set(openPaths);

  return (
    <div className={`db-scripts${collapsed ? ' collapsed' : ''}`}>
      <div
        className="db-scripts-head"
        // 用 role + tabIndex 而不是 <button>：头里还要放动作按钮，按钮套按钮是非法的
        role="button"
        tabIndex={0}
        title={collapsed ? '展开项目查询脚本' : '收起项目查询脚本'}
        onClick={() => setCollapsed((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setCollapsed((v) => !v);
          }
        }}
      >
        <PanelChevron expanded={!collapsed} size={12} color="var(--text-muted)" />
        <span>
          项目查询脚本
          {scripts.length > 0 && <span className="db-scripts-count">({scripts.length})</span>}
        </span>
      </div>

      {!collapsed && (
        <div className="db-scripts-list">
          {scripts.length === 0 ? (
            <div className="db-scripts-empty">
              在 SQL 控制台里保存过的脚本会出现在这里；脚本跟项目走，关掉标签也还在。
            </div>
          ) : (
            scripts.map((s) => (
              <div
                key={s.scriptPath}
                className={`db-script-row${openSet.has(s.scriptPath) ? ' open' : ''}`}
                title={s.scriptPath}
                onClick={() => onOpen?.(s)}
              >
                {/* 已打开的脚本用实心圆点，未打开的用空心 —— 光靠文字颜色区分在亮色主题下太弱 */}
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    flexShrink: 0,
                    background: openSet.has(s.scriptPath) ? 'currentColor' : 'transparent',
                    border: '1px solid currentColor',
                    opacity: openSet.has(s.scriptPath) ? 1 : 0.45,
                  }}
                />
                <span className="db-script-name">{s.title}</span>
                {s.connectionLabel && <span className="db-script-meta">{s.connectionLabel}</span>}
                {onDelete && (
                  <button
                    type="button"
                    className="panel-action-btn"
                    title="删除这个脚本文件（不可撤销）"
                    onClick={(e) => {
                      // 点删除不该顺带把脚本打开
                      e.stopPropagation();
                      onDelete(s);
                    }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 6h18" />
                      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                    </svg>
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ── DatabasePanel 主组件 (DBeaver 导航风格) ───────────────────────────────────

export function DatabasePanel({
  onOpenTableData,
  onOpenTableStructure,
  onOpenSqlConsole,
  scripts,
  onOpenScript,
  onDeleteScript,
  openScriptPaths,
  onShowToast,
}: DatabasePanelProps) {
  const [connections, setConnections] = useState<DbConnectionView[]>([]);  /** connId -> 库 / schema 列表 */
  const [schemasMap, setSchemasMap] = useState<Record<string, DatabaseSchemaInfo[]>>({});
  /** `${connId}:${schema}` -> 表列表 */
  const [tablesMap, setTablesMap] = useState<Record<string, DatabaseTableInfo[]>>({});
  /** `${connId}:${schema}:${table}` -> 列列表 */
  const [columnsMap, setColumnsMap] = useState<Record<string, DatabaseColumnMeta[]>>({});
  /**
   * `${connId}:${schema}` -> 六类对象清单（表 / 视图 / 索引 / 存储过程 / 触发器 / 事件）。
   *
   * 与 `tablesMap` 并存而不是替代：表与视图要的是**带行数、带注释**的 `DatabaseTableInfo`
   * （才能撑起数据视图 / DDL / 查询那排按钮），其余四类只需要名字。硬塞进一个结构里
   * 会让「表」这一组丢掉一半信息，所以两份数据各取所需。
   */
  const [objectsMap, setObjectsMap] = useState<Record<string, DbSchemaObjects>>({});

  // 展开状态
  const [expandedConns, setExpandedConns] = useState<Record<string, boolean>>({});
  const [expandedSchemas, setExpandedSchemas] = useState<Record<string, boolean>>({});
  const [expandedTables, setExpandedTables] = useState<Record<string, boolean>>({});
  /** `${connId}:${schema}:${group}` -> 分组是否展开 */
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  // 加载中与错误（错误必须在树上可见）
  const [loadingKeys, setLoadingKeys] = useState<Record<string, boolean>>({});
  const [errorMap, setErrorMap] = useState<Record<string, string>>({});

  const [loading, setLoading] = useState<boolean>(false);
  const [isNewModalOpen, setIsNewModalOpen] = useState<boolean>(false);
  /** 非空表示弹窗处于「编辑已有连接」模式 */
  const [editing, setEditing] = useState<DbSavedConnection | null>(null);
  // 所有写操作的确认框统一走 Markdown 弹窗（SQL 逐条可复制，配色跟随主题），
  // 以 `await confirm(...)` 的形式接回各处理函数的直线流程
  const dbConfirm = useDbConfirm();

  // 区分「首次挂载」与「手动刷新」：手动刷新不应该强制展开第一个连接
  const initializedRef = useRef(false);
  const loadingKeysRef = useRef(loadingKeys);
  loadingKeysRef.current = loadingKeys;
  /** 记住最近一次「项目根」：workspace:changed 也会因打开其他文件夹之外的原因触发，只认真正的切换 */
  const lastWorkspaceRootRef = useRef<string | null>(null);
  /** loadSchemas 里需要判断节点是否已连接，用 ref 避免把它挂进 useCallback 依赖 */
  const connectionsRef = useRef(connections);
  connectionsRef.current = connections;
  /**
   * 展开态的三个快照。
   *
   * `refreshExpandedNodes`（编辑区改了表结构后刷树）要读展开态，但**不能**把它写进
   * useCallback 的依赖里：展开 / 折叠会让这个回调换新身份，事件监听跟着反复重挂。
   * 与上面几个 ref 是同一种处理。
   */
  const expandedConnsRef = useRef(expandedConns);
  expandedConnsRef.current = expandedConns;
  const expandedSchemasRef = useRef(expandedSchemas);
  expandedSchemasRef.current = expandedSchemas;
  const expandedTablesRef = useRef(expandedTables);
  expandedTablesRef.current = expandedTables;

  const setError = useCallback((key: string, message: string | null) => {
    setErrorMap((prev) => {
      if (message === null) {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: message };
    });
  }, []);

  const setLoadingKey = useCallback((key: string, value: boolean) => {
    setLoadingKeys((prev) => {
      if (value) {
        if (prev[key]) return prev;
        return { ...prev, [key]: true };
      }
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  /** 加载某连接下的库 / schema 列表 */
  const loadSchemas = useCallback(
    async (connId: string, force = false) => {
      if (!window.ide?.dbListSchemas) return;
      // 未连接的节点没有会话可取：不要白跑一趟 IPC，直接在树上给出可读原因。
      // force 用于「刚刚重连成功、但 connections 状态尚未回流」的调用方。
      const known = connectionsRef.current.find((c) => c.id === connId);
      if (!force && known && !known.connected) {
        setError(`schemas:${connId}`, '未连接：点击该连接即可用保存的配置重连');
        return;
      }
      const key = `schemas:${connId}`;
      if (loadingKeysRef.current[key]) return;
      setLoadingKey(key, true);
      try {
        const res = await window.ide.dbListSchemas(connId);
        if (res.ok) {
          setSchemasMap((prev) => ({ ...prev, [connId]: res.schemas }));
          setError(key, null);
        } else {
          setError(key, res.error || '加载库 / Schema 失败');
        }
      } catch (err: any) {
        setError(key, `加载库 / Schema 失败: ${err.message || String(err)}`);
      } finally {
        setLoadingKey(key, false);
      }
    },
    [setError, setLoadingKey],
  );

  /** 加载某库 / schema 下的表列表 */
  const loadTables = useCallback(
    async (connId: string, schemaName: string) => {
      if (!window.ide?.dbListTables) return;
      const key = `tables:${connId}:${schemaName}`;
      if (loadingKeysRef.current[key]) return;
      setLoadingKey(key, true);
      try {
        const res = await window.ide.dbListTables(connId, schemaName);
        if (res.ok) {
          setTablesMap((prev) => ({ ...prev, [`${connId}:${schemaName}`]: res.tables }));
          setError(key, null);
        } else {
          setError(key, res.error || '加载数据表失败');
        }
      } catch (err: any) {
        setError(key, `加载数据表失败: ${err.message || String(err)}`);
      } finally {
        setLoadingKey(key, false);
      }
    },
    [setError, setLoadingKey],
  );

  /**
   * 加载某库下的六类对象清单。
   *
   * 与 `loadTables` 并行发起而不是串行：两者互不依赖，串起来只会让展开库这一下多等一个来回。
   * 失败各记各的 key —— 索引查询失败不该把表也一起判成「加载失败」。
   */
  const loadObjects = useCallback(
    async (connId: string, schemaName: string) => {
      if (!window.ide?.dbListObjects) return;
      const key = `objects:${connId}:${schemaName}`;
      if (loadingKeysRef.current[key]) return;
      setLoadingKey(key, true);
      try {
        const res = await window.ide.dbListObjects(connId, schemaName);
        if (res.ok && res.objects) {
          setObjectsMap((prev) => ({ ...prev, [`${connId}:${schemaName}`]: res.objects! }));
          setError(key, null);
        } else {
          setError(key, res.error || '加载数据库对象失败');
        }
      } catch (err: any) {
        setError(key, `加载数据库对象失败: ${err.message || String(err)}`);
      } finally {
        setLoadingKey(key, false);
      }
    },
    [setError, setLoadingKey],
  );

  /** 加载单表列字段 */
  const loadTableSchema = useCallback(
    async (connId: string, schemaName: string, tableName: string) => {
      if (!window.ide?.dbGetTableSchema) return;
      const mapKey = `${connId}:${schemaName}:${tableName}`;
      const key = `columns:${mapKey}`;
      if (loadingKeysRef.current[key]) return;
      setLoadingKey(key, true);
      try {
        const res = await window.ide.dbGetTableSchema(connId, tableName, schemaName);
        if (res.ok) {
          setColumnsMap((prev) => ({ ...prev, [mapKey]: res.columns }));
          setError(key, null);
        } else {
          setError(key, res.error || '加载表字段失败');
        }
      } catch (err: any) {
        setError(key, `加载表字段失败: ${err.message || String(err)}`);
      } finally {
        setLoadingKey(key, false);
      }
    },
    [setError, setLoadingKey],
  );

  // ── 库 / 表结构变更（新建、删除、重命名、设计表） ─────────────────────────
  //
  // DDL 一律**逐条**走 dbQuery（`dbExecuteBatch` 只服务 DML —— MySQL 的 DDL 会隐式提交，
  // 混进事务里会静默破坏原子性）。这里按顺序执行，第一条失败即停并把错误抛给调用方。

  /** 表结构弹窗的状态；`mode: 'create'` 时不带 tableName / existingColumns */
  const [structureModal, setStructureModal] = useState<{
    mode: 'create' | 'alter';
    connId: string;
    schemaName?: string;
    tableName?: string;
    existingColumns?: DatabaseColumnMeta[];
  } | null>(null);

  /** 逐条执行 DDL；返回第一条失败的信息 */
  const runDdl = useCallback(
    async (connId: string, schemaName: string | undefined, statements: string[]) => {
      if (!window.ide?.dbQuery) return { ok: false, error: '当前环境不支持执行 SQL' };
      for (let i = 0; i < statements.length; i++) {
        const res = await window.ide.dbQuery(connId, statements[i], 1, 50, schemaName);
        if (!res.ok) {
          const suffix = i > 0 ? `（前 ${i} 条已生效，DDL 无法回滚）` : '';
          return { ok: false, error: `${res.error || '执行失败'}${suffix}` };
        }
      }
      return { ok: true as const };
    },
    [],
  );

  /** 执行一批 DDL 并刷新树上对应节点 */
  const executeDdl = useCallback(
    async (connId: string, schemaName: string | undefined, statements: string[]) => {
      const res = await runDdl(connId, schemaName, statements);
      if (res.ok) {
        // 结构变了：表列表与列缓存都过期了，刷新策略按「改的是不是列」由调用方决定
        if (schemaName) await loadTables(connId, schemaName);
        else await loadSchemas(connId, true);
      }
      return res;
    },
    [runDdl, loadTables, loadSchemas],
  );

  /** 新建库 / 新建 Schema */
  const handleCreateDatabase = async (connId: string, driver: 'sqlite' | 'mysql' | 'postgres') => {
    const noun = databaseLevelNoun(driver);
    const name = await dbConfirm.confirm({
      title: `新建${noun}`,
      content: `填写名称后将在连接 **${connLabelOf(connId)}** 上创建新的${noun}。`,
      confirmLabel: '创建',
      input: {
        label: `新${noun}名称：`,
        placeholder: `${noun}名`,
      },
    });
    if (name === null || !name.trim()) return;
    const sql = buildCreateDatabaseSql(driver, name.trim(), { ifNotExists: true });
    if (!sql) {
      onShowToast?.(`该驱动不支持新建${noun}`, undefined, 'warn');
      return;
    }
    const res = await runDdl(connId, undefined, [sql]);
    if (res.ok) {
      onShowToast?.(`已创建${noun}`, name.trim(), 'success');
      await loadSchemas(connId, true);
    } else {
      onShowToast?.(`创建${noun}失败`, res.error, 'error');
    }
  };

  /** 删除库 / 删除 Schema（要求手输名称） */
  const handleDropDatabase = async (
    connId: string,
    schemaName: string,
    driver: 'sqlite' | 'mysql' | 'postgres',
  ) => {
    const noun = databaseLevelNoun(driver);
    const sql = buildDropDatabaseSql(driver, schemaName, { ifExists: true });
    if (!sql) {
      onShowToast?.(`该驱动不支持删除${noun}`, undefined, 'warn');
      return;
    }
    const ok = await dbConfirm.confirm({
      title: `删除${noun}`,
      tone: 'danger',
      confirmLabel: confirmLabelFor('drop'),
      content: buildSqlConfirmMarkdown({
        intro: `即将删除${noun} ${mdCode(schemaName)} 及其中的 **全部数据**。`,
        statements: [sql],
        notes: [`删除整个${noun}无法回滚，请确认其中没有还需要的数据。`],
        tone: 'danger',
      }),
      requireTyping: schemaName,
    });
    if (ok === null) return;
    const res = await runDdl(connId, undefined, [sql]);
    if (res.ok) {
      onShowToast?.(`已删除${noun}`, schemaName, 'success');
      setExpandedSchemas((prev) => {
        const next = { ...prev };
        delete next[`${connId}:${schemaName}`];
        return next;
      });
      await loadSchemas(connId, true);
    } else {
      onShowToast?.(`删除${noun}失败`, res.error, 'error');
    }
  };

  /** 重命名库：只生成脚本（MySQL 没有 RENAME DATABASE），送到 SQL 控制台由用户逐句确认 */
  const handleRenameDatabase = async (
    connId: string,
    schemaName: string,
    driver: 'sqlite' | 'mysql' | 'postgres',
  ) => {
    const noun = databaseLevelNoun(driver);
    const name = await dbConfirm.confirm({
      title: `重命名${noun}`,
      content: `将 ${mdCode(schemaName)} 重命名为新的${noun}。名称需与旧名称不同。`,
      confirmLabel: '生成脚本',
      input: {
        label: `新的${noun}名称：`,
        defaultValue: `${schemaName}_new`,
        placeholder: `${noun}名`,
      },
    });
    if (name === null || !name.trim() || name.trim() === schemaName) return;
    // 需要表清单才能生成逐表迁移语句；读不到就退化为「未读取到表清单」的提示脚本
    let tables: string[] = [];
    try {
      const res = await window.ide?.dbListTables?.(connId, schemaName);
      if (res?.ok) tables = res.tables.map((t) => t.name);
    } catch {
      // 忽略：脚本里已带「未读取到表清单」的说明
    }
    const script = buildRenameDatabaseScript(driver, schemaName, name.trim(), tables);
    if (!script) {
      onShowToast?.(`该驱动不支持重命名${noun}`, undefined, 'warn');
      return;
    }
    // 绝不自动执行：这条脚本涉及建库 + 逐表迁移 + 删旧库，必须由用户逐句过目
    onOpenSqlConsole?.(connId, schemaName, script, `重命名${noun} - ${schemaName}`);
    onShowToast?.('已生成重命名脚本', '请逐条检查后手动执行；执行前务必备份。', 'info');
  };

  /** 删除表（要求手输表名） */
  const handleDropTable = async (
    connId: string,
    schemaName: string,
    tableName: string,
    driver: 'sqlite' | 'mysql' | 'postgres',
  ) => {
    const sql = buildDropTableSql(driver, schemaName, tableName, { ifExists: true });
    const ok = await dbConfirm.confirm({
      title: '删除表',
      tone: 'danger',
      confirmLabel: confirmLabelFor('drop'),
      content: buildSqlConfirmMarkdown({
        intro: `即将删除表 ${mdCode(tableName)} 及其中的 **全部数据**。`,
        statements: [sql],
        notes: ['删除表无法回滚，请确认没有程序仍在依赖它。'],
        tone: 'danger',
      }),
      requireTyping: tableName,
    });
    if (ok === null) return;
    const res = await executeDdl(connId, schemaName, [sql]);
    if (res.ok) {
      onShowToast?.(`已删除表 ${tableName}`, undefined, 'success');
      setExpandedTables((prev) => {
        const next = { ...prev };
        delete next[`${connId}:${schemaName}:${tableName}`];
        return next;
      });
    } else {
      onShowToast?.('删除表失败', res.error, 'error');
    }
  };

  /** 表结构弹窗执行入口（新建表 / 设计表共用） */
  const handleStructureExecute = useCallback(
    async (statements: string[]) => {
      const target = structureModal;
      if (!target) return { ok: false, error: '弹窗状态已失效，请重新打开' };
      const res = await runDdl(target.connId, target.schemaName, statements);
      if (res.ok) {
        // 结构变更后，该表的列缓存必须作废，否则树上展开还是旧字段
        if (target.schemaName && target.tableName) {
          setColumnsMap((prev) => {
            const next = { ...prev };
            delete next[`${target.connId}:${target.schemaName}:${target.tableName}`];
            return next;
          });
        }
        if (target.schemaName) await loadTables(target.connId, target.schemaName);
        else await loadSchemas(target.connId, true);
      }
      return res;
    },
    [structureModal, runDdl, loadTables, loadSchemas],
  );

  // 刷新连接列表：首次挂载展开第一个**已连接**的连接；手动刷新只重载已展开节点的缓存
  const refreshConnections = useCallback(async () => {
    if (!window.ide?.dbListConnections) return;
    try {
      setLoading(true);

      // 顺手记下当前项目根，供 workspace:changed 判断「是否真的换了项目」
      try {
        const info = await window.ide.getWorkspaceInfo?.();
        if (info) {
          lastWorkspaceRootRef.current = info.root ?? null;
        }
      } catch {
        // 拿不到工作区信息不影响连接列表
      }

      const conns = (await window.ide.dbListConnections()) || [];
      setConnections(conns);

      const isFirstLoad = !initializedRef.current;
      initializedRef.current = true;

      // 重新拉取已展开节点（连接列表变化后旧缓存可能失效）。
      // 首次挂载只自动展开「已连接」的第一个：未连接的节点展开只会得到一行「未连接」，
      // 不该在用户还没动手时就往树上堆红色错误。
      const connIds = new Set(conns.map((c) => c.id));
      const firstConnected = conns.find((c) => c.connected)?.id;
      const targets = isFirstLoad
        ? firstConnected
          ? [firstConnected]
          : []
        : Object.keys(expandedConns).filter(
            (id) => expandedConns[id] && connIds.has(id) && conns.find((c) => c.id === id)?.connected,
          );

      // 首次挂载时把「上一轮遗留的展开态」收敛到实际会加载的节点上
      if (isFirstLoad) {
        setExpandedConns((prev) => {
          const next: Record<string, boolean> = {};
          for (const id of Object.keys(prev)) if (connIds.has(id) && prev[id]) next[id] = true;
          for (const id of connIds) next[id] = false;
          for (const id of targets) next[id] = true;
          return next;
        });
      } else if (targets.length > 0) {
        setExpandedConns((prev) => {
          const next = { ...prev };
          for (const id of targets) next[id] = true;
          return next;
        });
      }

      for (const id of targets) {
        await loadSchemas(id);
      }

      // 已展开的库 / 表同步重载
      for (const key of Object.keys(expandedSchemas)) {
        if (!expandedSchemas[key]) continue;
        const [connId, schemaName] = key.split(':');
        if (connIds.has(connId)) {
          await loadTables(connId, schemaName);
          await loadObjects(connId, schemaName);
        }
      }
      for (const key of Object.keys(expandedTables)) {
        if (!expandedTables[key]) continue;
        const [connId, schemaName, tableName] = key.split(':');
        if (connIds.has(connId)) await loadTableSchema(connId, schemaName, tableName);
      }
    } catch (err: any) {
      onShowToast?.('加载数据库连接失败', err.message || String(err), 'error');
    } finally {
      setLoading(false);
    }
    // expandedSchemas / expandedTables 仅作刷新时的读取快照，避免把展开动作变成重复刷新
  }, [onShowToast, loadSchemas, loadTables, loadObjects, loadTableSchema]);

  useEffect(() => {
    void refreshConnections();
  }, [refreshConnections]);

  // 切工作区：连接配置属于项目，根一变就把树清空重来，避免上一个项目的库表残留。
  // 只有根**真的变了**才清空：workspace:changed 还会因 SSH 重连等场景发出，
  // 那种情况下清空会把用户正看着的库表树全掀掉。
  useEffect(() => {
    const off = window.ide?.onWorkspaceChanged?.((info: any) => {
      const nextRoot = (info?.root ?? null) as string | null;
      const changed = lastWorkspaceRootRef.current !== nextRoot;
      lastWorkspaceRootRef.current = nextRoot;
      if (!changed) return;
      setConnections([]);
      setSchemasMap({});
      setTablesMap({});
      setColumnsMap({});
      setObjectsMap({});
      setExpandedConns({});
      setExpandedSchemas({});
      setExpandedTables({});
      setExpandedGroups({});
      setErrorMap({});
      initializedRef.current = false;
      void refreshConnections();
    });
    return () => off?.();
  }, [refreshConnections]);

  /**
   * 重新拉一遍已展开的库 / 表 / 列。
   *
   * 与上面 `refreshConnections` 里那段的区别：那段是「连接变了，全部重来」，
   * 这段只针对**结构被别处改过**（表在编辑区里改了名或改了列），
   * 不碰连接与展开状态，用户看不出树被重置。
   */
  const refreshExpandedNodes = useCallback(async () => {
    const schemaKeys = Object.keys(expandedSchemasRef.current).filter(
      (k) => expandedSchemasRef.current[k],
    );
    const connIds = new Set(Object.keys(expandedConnsRef.current).filter((k) => expandedConnsRef.current[k]));
    for (const key of schemaKeys) {
      const [connId, schemaName] = key.split(':');
      if (!connIds.has(connId)) continue;
      await loadTables(connId, schemaName);
    }
    for (const key of Object.keys(expandedTablesRef.current)) {
      if (!expandedTablesRef.current[key]) continue;
      const [connId, schemaName, tableName] = key.split(':');
      if (!connIds.has(connId)) continue;
      await loadTableSchema(connId, schemaName, tableName);
    }
  }, [loadTables, loadTableSchema]);

  /**
   * 编辑区改了表结构（目前只有改名）→ 树上的旧名字要立刻消失。
   *
   * 走 window 事件而不是把回调从 App 一路传下来：这条线是「编辑区 → 左侧数据库面板」，
   * 两个组件之间没有直接通路，而仓库里跨面板的这类通知本来就是事件
   * （`echoly:refreshFileTree` / `echoly:refreshTree` 都是这个走法）。
   */
  useEffect(() => {
    const onRefresh = () => void refreshExpandedNodes();
    window.addEventListener('echoly:refreshDbTree', onRefresh);
    return () => window.removeEventListener('echoly:refreshDbTree', onRefresh);
  }, [refreshExpandedNodes]);

  // 切换展开连接
  const toggleConn = (connId: string) => {
    const next = !expandedConns[connId];
    setExpandedConns((prev) => ({ ...prev, [connId]: next }));
    if (next && !schemasMap[connId]) {
      void loadSchemas(connId);
    }
  };

  // 切换展开库 / schema
  const toggleSchema = (connId: string, schemaName: string) => {
    const key = `${connId}:${schemaName}`;
    const next = !expandedSchemas[key];
    setExpandedSchemas((prev) => ({ ...prev, [key]: next }));
    if (next) {
      if (!tablesMap[key]) void loadTables(connId, schemaName);
      if (!objectsMap[key]) void loadObjects(connId, schemaName);
    }
  };

  // 切换展开分组（Tables / Views / Indexes / ...）
  const toggleGroup = (connId: string, schemaName: string, group: DbObjectGroup) => {
    const key = `${connId}:${schemaName}:${group}`;
    setExpandedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // 切换展开表
  const toggleTable = (connId: string, schemaName: string, tableName: string) => {
    const key = `${connId}:${schemaName}:${tableName}`;
    const next = !expandedTables[key];
    setExpandedTables((prev) => ({ ...prev, [key]: next }));
    if (next && !columnsMap[key]) {
      void loadTableSchema(connId, schemaName, tableName);
    }
  };

  /** 清掉某连接下的全部缓存（库 / 表 / 列），断开或删除后调用，避免残留幽灵节点 */
  const clearConnectionCache = useCallback((connId: string) => {
    const prefixA = `${connId}:`;
    const prefixB = `schemas:${connId}`;
    setSchemasMap((prev) => {
      if (!(connId in prev)) return prev;
      const next = { ...prev };
      delete next[connId];
      return next;
    });
    setTablesMap((prev) => {
      const next: Record<string, DatabaseTableInfo[]> = {};
      for (const [k, v] of Object.entries(prev)) if (!k.startsWith(prefixA)) next[k] = v;
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
    setColumnsMap((prev) => {
      const next: Record<string, DatabaseColumnMeta[]> = {};
      for (const [k, v] of Object.entries(prev)) if (!k.startsWith(prefixA)) next[k] = v;
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
    setObjectsMap((prev) => {
      const next: Record<string, DbSchemaObjects> = {};
      for (const [k, v] of Object.entries(prev)) if (!k.startsWith(prefixA)) next[k] = v;
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
    setExpandedConns((prev) => {
      if (!(connId in prev)) return prev;
      const next = { ...prev };
      delete next[connId];
      return next;
    });
    setExpandedSchemas((prev) => {
      const next: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(prev)) if (!k.startsWith(prefixA)) next[k] = v;
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
    setExpandedTables((prev) => {
      const next: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(prev)) if (!k.startsWith(prefixA)) next[k] = v;
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
    setExpandedGroups((prev) => {
      const next: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(prev)) if (!k.startsWith(prefixA)) next[k] = v;
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
    setErrorMap((prev) => {
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (k.startsWith(prefixA) || k === prefixB) continue;
        next[k] = v;
      }
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, []);

  // 断开连接：只断会话、保留项目里的配置（节点变成「未连接」，点击即可重连）
  const handleDisconnect = async (connId: string) => {
    if (!window.ide?.dbDisconnect) return;
    try {
      await window.ide.dbDisconnect(connId);
      onShowToast?.('已断开数据库连接', undefined, 'info');
      clearConnectionCache(connId);
      await refreshConnections();
    } catch (err: any) {
      onShowToast?.('断开失败', err.message || String(err), 'error');
    }
  };

  /**
   * 断开连接的确认入口。
   *
   * 右键菜单与行内插头按钮都从这里走 —— 断开本身丢的只是一个会话，
   * 但两条入口的确认口径必须一致，否则「菜单里问了、按钮上没问」会让人以为按钮是安全的。
   */
  const requestDisconnect = async (conn: DbConnectionView) => {
    const ok = await dbConfirm.confirm({
      title: '断开连接',
      content: `确定断开连接 ${mdCode(conn.name)} 吗？断开后树上的库 / 表列表需要重新连接才能展开。`,
      confirmLabel: '断开',
    });
    if (ok === null) return;
    await handleDisconnect(conn.id);
  };

  // 用项目里保存的配置重连（未连接节点点击即触发）
  const handleConnectSaved = async (connId: string): Promise<boolean> => {
    if (!window.ide?.dbConnectSaved) return false;
    const conn = connections.find((c) => c.id === connId);
    const label = conn?.name ?? '数据库';

    // 准入判断：没存密码的连接不能拿空密码去撞，否则只会拿到一个看不懂的鉴权错误
    const preflight = checkConnectionPreflight(conn);

    if (preflight.action === 'prompt-password') {
      if (preflight.reason) onShowToast?.('无法直接连接', preflight.reason, 'error');
      else
        onShowToast?.(
          '该连接未保存密码',
          '请点击「编辑连接…」补上密码后连接',
          'warn',
        );
      // 直接把编辑弹窗打开，省掉用户再找一遍菜单
      if (conn) {
        setEditing(conn);
        setIsNewModalOpen(true);
      }
      return false;
    }

    if (preflight.action === 'unknown') {
      // 配置还没读到（例如刚切完工作区）：重拉列表，让用户看清状态再点
      await refreshConnections();
      const refreshed = connectionsRef.current.find((c) => c.id === connId);
      if (!refreshed) {
        onShowToast?.('未找到该连接配置', '它可能已从当前项目中被删除', 'error');
        return false;
      }
      if (!refreshed.connected) {
        onShowToast?.('该连接无法直接重连', '请点击「编辑连接…」确认参数后再连接', 'warn');
        return false;
      }
      return true;
    }

    try {
      setLoadingKey(`connect:${connId}`, true);
      const res = await window.ide.dbConnectSaved(connId);
      if (res?.ok) {
        onShowToast?.(`已连接「${label}」`, undefined, 'success');
        await refreshConnections();
        // 连上后自动展开，省去用户再点一次。此时 connections 状态可能还没回流，
        // 故 force 绕过「未连接」短路。
        setExpandedConns((prev) => ({ ...prev, [connId]: true }));
        await loadSchemas(connId, true);
        return true;
      }
      const msg = res?.error || '连接失败';
      onShowToast?.(`连接「${label}」失败`, msg, 'error');
      setError(`schemas:${connId}`, msg);
      return false;
    } catch (err: any) {
      const msg = err.message || String(err);
      onShowToast?.(`连接「${label}」失败`, msg, 'error');
      setError(`schemas:${connId}`, msg);
      return false;
    } finally {
      setLoadingKey(`connect:${connId}`, false);
    }
  };

  // 删除项目里的连接配置（先确认；若正连着会先断开）
  const handleDeleteConnection = async (connId: string) => {
    if (!window.ide?.dbDeleteConnection) return;
    try {
      const res = await window.ide.dbDeleteConnection(connId);
      if (res?.ok) {
        onShowToast?.('已从项目中删除该连接配置', undefined, 'info');
        clearConnectionCache(connId);
        setEditing(null);
        await refreshConnections();
      } else {
        onShowToast?.('删除连接失败', res?.error, 'error');
      }
    } catch (err: any) {
      onShowToast?.('删除连接失败', err.message || String(err), 'error');
    }
  };

  // 新连接成功回调：列表结构以主进程为准（是否已连接由 savedId 对应关系决定）
  const handleConnected = (_conn: DatabaseConnectionInfo) => {
    void refreshConnections();
  };

  // ── 树节点右键菜单 ────────────────────────────────────────────────────────
  const [menu, setMenu] = useState<{ x: number; y: number; target: DbMenuTarget } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const openMenu = useCallback((e: React.MouseEvent, target: DbMenuTarget) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, target });
  }, []);

  // 点击别处 / Esc / 滚动时关闭，避免菜单与树状态脱节
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  // 贴边翻转：避免菜单被窗口右 / 下边缘裁掉
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el || !menu) return;
    const rect = el.getBoundingClientRect();
    let x = menu.x;
    let y = menu.y;
    if (x + rect.width > window.innerWidth - 8) x = Math.max(8, window.innerWidth - rect.width - 8);
    if (y + rect.height > window.innerHeight - 8) y = Math.max(8, window.innerHeight - rect.height - 8);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, [menu]);

  const connById = useCallback(
    (connId: string) => connections.find((c) => c.id === connId),
    [connections],
  );

  /** 连接的中文短标签，用在确认弹窗正文里指明「这条语句要打在哪个库上」 */
  const connLabelOf = useCallback(
    (connId: string) => connById(connId)?.name ?? connId,
    [connById],
  );

  /** 统一的剪贴板反馈，避免每个菜单项各写一遍 toast 文案 */
  const copyText = useCallback(
    async (text: string, label: string) => {
      const ok = await copyToClipboard(text);
      onShowToast?.(ok ? `已复制${label}` : `复制${label}失败`, text, ok ? 'success' : 'error');
      setMenu(null);
    },
    [onShowToast],
  );

  /** 按目标层级决定「全限定名」的拼法 */
  const qualifiedNameOf = useCallback(
    (target: DbMenuTarget): string => {
      const conn = connById(target.connId);
      const driver = conn?.type ?? 'sqlite';
      if (target.kind === 'table') {
        return qualifyIdent(driver, target.schemaName, target.tableName);
      }
      if (target.kind === 'schema') return qualifyIdent(driver, target.schemaName, '');
      return conn?.name ?? target.connId;
    },
    [connById],
  );

  /** 刷新某个已展开节点的缓存（右键菜单里的「刷新」） */
  const refreshNode = useCallback(
    async (target: DbMenuTarget) => {
      setMenu(null);
      if (target.kind === 'conn') {
        await refreshConnections();
        return;
      }
      if (target.kind === 'schema') {
        await loadTables(target.connId, target.schemaName);
        return;
      }
      await loadTableSchema(target.connId, target.schemaName, target.tableName);
      await loadTables(target.connId, target.schemaName);
    },
    [refreshConnections, loadTables, loadTableSchema],
  );

  /** 展开 / 折叠某个节点 */
  const toggleNode = useCallback(
    (target: DbMenuTarget) => {
      setMenu(null);
      if (target.kind === 'conn') toggleConn(target.connId);
      else if (target.kind === 'schema') toggleSchema(target.connId, target.schemaName);
      else toggleTable(target.connId, target.schemaName, target.tableName);
    },
    // toggleConn / toggleSchema / toggleTable 是本组件内的普通函数，依赖它们的读取快照即可
    [expandedConns, expandedSchemas, expandedTables, schemasMap, tablesMap, columnsMap],
  );

  /** 渲染某个层级的菜单项 */
  const renderMenuItems = (target: DbMenuTarget) => {
    const conn = connById(target.connId);
    const driver = conn?.type ?? 'sqlite';

    if (target.kind === 'table') {
      const { schemaName, tableName } = target;
      return (
        <>
          <MenuItem
            icon={<IconMenuData />}
            label="查看表数据"
            onClick={() => {
              setMenu(null);
              onOpenTableData?.(target.connId, tableName, schemaName);
            }}
          />
          <MenuItem
            icon={<IconMenuDdl />}
            label="查看表结构"
            onClick={() => {
              setMenu(null);
              onOpenTableStructure?.(target.connId, tableName, schemaName);
            }}
          />
          <MenuItem
            icon={<IconMenuColumns />}
            label={expandedTables[`${target.connId}:${schemaName}:${tableName}`] ? '折叠列结构' : '展开列结构'}
            onClick={() => toggleNode(target)}
          />
          {onOpenSqlConsole && (
            <MenuItem
              icon={<IconBolt />}
              label="在新 SQL 控制台查询此表"
              onClick={() => {
                setMenu(null);
                onOpenSqlConsole(
                  target.connId,
                  schemaName,
                  buildTableSelectSql(driver, schemaName, tableName, 50),
                  `查询 - ${tableName}`,
                );
              }}
            />
          )}
          <MenuDivider />
          <MenuItem
            icon={<IconMenuCopy />}
            label="复制表名"
            onClick={() => void copyText(tableName, '表名')}
          />
          <MenuItem
            icon={<IconMenuCopy />}
            label="复制全限定名"
            onClick={() => void copyText(qualifiedNameOf(target), '全限定名')}
          />
          <MenuItem
            icon={<IconMenuCopy />}
            label="复制 SELECT 语句"
            onClick={() =>
              void copyText(buildTableSelectSql(driver, schemaName, tableName, 100), 'SELECT 语句')
            }
          />
          <MenuDivider />
          <MenuItem
            icon={<IconMenuEdit />}
            label="设计表…（修改列结构）"
            onClick={() => {
              setMenu(null);
              setStructureModal({
                mode: 'alter',
                connId: target.connId,
                schemaName,
                tableName,
                existingColumns: columnsMap[`${target.connId}:${schemaName}:${tableName}`] || [],
              });
            }}
          />
          <MenuItem
            icon={<IconPlus />}
            label="在此库新建表…"
            onClick={() => {
              setMenu(null);
              setStructureModal({ mode: 'create', connId: target.connId, schemaName });
            }}
          />
          <MenuItem
            icon={<IconMenuCsv />}
            label="复制 INSERT 模板"
            onClick={() => {
              const cols =
                columnsMap[`${target.connId}:${schemaName}:${tableName}`] ||
                [];
              if (cols.length === 0) {
                onShowToast?.('请先展开列结构', '展开后即可按真实列名生成 INSERT 模板。', 'info');
                return;
              }
              const empty: Record<string, any> = {};
              for (const c of cols) empty[c.name] = null;
              void copyText(
                buildRowInsertSql(driver, schemaName, tableName, cols, empty),
                'INSERT 模板',
              );
            }}
          />
          <MenuDivider />
          <MenuItem
            icon={<IconMenuRefresh />}
            label="刷新此表"
            onClick={() => void refreshNode(target)}
          />
          <MenuItem
            icon={<IconTrash />}
            label="删除表…"
            danger
            onClick={() => {
              setMenu(null);
              void handleDropTable(target.connId, schemaName, tableName, driver);
            }}
          />
        </>
      );
    }

    if (target.kind === 'column') {
      const { schemaName, tableName, columnName } = target;
      const tableColumns = columnsMap[`${target.connId}:${schemaName}:${tableName}`] || [];
      const meta = tableColumns.find((c) => c.name === columnName);
      const openWithView = (partial: Partial<DbTableViewState>) => {
        setMenu(null);
        onOpenTableData?.(target.connId, tableName, schemaName, {
          filters: partial.filters ?? [],
          sorts: partial.sorts ?? [],
        });
      };
      /** 该列的单行值取自……树上没有行数据，这里只给「按列」级别的语句 */
      const fullName = `${qualifyIdent(driver, schemaName, tableName)}.${quoteIdent(driver, columnName)}`;
      return (
        <>
          <MenuItem
            icon={<IconMenuData />}
            label="按此列升序排列"
            onClick={() => openWithView({ sorts: [{ column: columnName, direction: 'asc' }] })}
          />
          <MenuItem
            icon={<IconMenuData />}
            label="按此列降序排列"
            onClick={() => openWithView({ sorts: [{ column: columnName, direction: 'desc' }] })}
          />
          <MenuItem
            icon={<IconMenuColumns />}
            label="按此列筛选…"
            onClick={() => {
              setMenu(null);
              void (async () => {
                // 树上没有输入值的控件，用一个输入弹窗收集条件值 —— 比「先打开数据视图再让用户自己找漏斗」少两步
                const raw = await dbConfirm.confirm({
                  title: '按列筛选',
                  content:
                    `目标列：${mdCode(fullName)}\n\n` +
                    '输入要匹配的值（默认按「包含」匹配文本，输入纯数字按「等于」匹配）；确认后将打开表数据视图并按该条件查询。',
                  confirmLabel: '打开并筛选',
                  input: {
                    label: '要匹配的值：',
                    placeholder: '例如 alice 或 42',
                  },
                });
                if (raw === null || !raw.trim()) return;
                const text = raw.trim();
                const numeric = /^-?\d+(\.\d+)?$/.test(text);
                const condition: DbTableFilterCondition = numeric
                  ? { column: columnName, operator: 'eq', value: Number(text) }
                  : { column: columnName, operator: 'contains', value: text };
                onOpenTableData?.(target.connId, tableName, schemaName, {
                  filters: [condition],
                  sorts: [],
                });
              })();
            }}
          />
          <MenuDivider />
          <MenuItem
            icon={<IconMenuCopy />}
            label="复制列名"
            onClick={() => void copyText(columnName, '列名')}
          />
          <MenuItem
            icon={<IconMenuCopy />}
            label="复制全限定列名"
            onClick={() => void copyText(fullName, '全限定列名')}
          />
          <MenuItem
            icon={<IconMenuCopy />}
            label="复制 WHERE 片段"
            onClick={() => void copyText(`${quoteIdent(driver, columnName)} = ?`, 'WHERE 片段')}
          />
          <MenuItem
            icon={<IconMenuCopy />}
            label="复制 SELECT 语句（含此列）"
            onClick={() =>
              void copyText(
                `SELECT ${quoteIdent(driver, columnName)} FROM ${qualifyIdent(driver, schemaName, tableName)} LIMIT 100;`,
                'SELECT 语句',
              )
            }
          />
          {meta && (
            <>
              <MenuDivider />
              <MenuItem
                icon={<IconMenuColumns />}
                label={`列类型：${meta.type || 'ANY'}${meta.notnull ? ' · NOT NULL' : ''}${
                  meta.pk ? ' · 主键' : ''
                }`}
                onClick={() => setMenu(null)}
              />
            </>
          )}
        </>
      );
    }

    if (target.kind === 'schema') {
      const { schemaName } = target;
      const tables = tablesMap[`${target.connId}:${schemaName}`] || [];
      return (
        <>
          {onOpenSqlConsole && (
            <MenuItem
              icon={<IconBolt />}
              label="在此库新建 SQL 控制台"
              onClick={() => {
                setMenu(null);
                onOpenSqlConsole(
                  target.connId,
                  schemaName,
                  NEW_CONSOLE_SQL,
                  `查询 - ${schemaName}`,
                );
              }}
            />
          )}
          <MenuItem
            icon={<IconMenuExpand />}
            label={expandedSchemas[`${target.connId}:${schemaName}`] ? '折叠此库' : '展开此库'}
            onClick={() => toggleNode(target)}
          />
          <MenuDivider />
          <MenuItem
            icon={<IconPlus />}
            label="在此库新建表…"
            onClick={() => {
              setMenu(null);
              setStructureModal({ mode: 'create', connId: target.connId, schemaName });
            }}
          />
          {supportsDatabaseLevel(driver) && (
            <>
              <MenuItem
                icon={<IconPlus />}
                label={`新建${databaseLevelNoun(driver)}…`}
                onClick={() => {
                  setMenu(null);
                  void handleCreateDatabase(target.connId, driver);
                }}
              />
              <MenuItem
                icon={<IconMenuEdit />}
                label={`重命名${databaseLevelNoun(driver)}…（生成脚本）`}
                onClick={() => {
                  setMenu(null);
                  void handleRenameDatabase(target.connId, schemaName, driver);
                }}
              />
            </>
          )}
          <MenuDivider />
          <MenuItem
            icon={<IconMenuCopy />}
            label="复制库 / Schema 名"
            onClick={() => void copyText(schemaName, '库名')}
          />
          <MenuItem
            icon={<IconMenuCopy />}
            label="复制全部表名"
            onClick={() =>
              void copyText(
                tables.map((t) => t.name).join('\n'),
                `全部表名 (${tables.length} 张)`,
              )
            }
          />
          <MenuDivider />
          <MenuItem
            icon={<IconMenuRefresh />}
            label="刷新此库的表列表"
            onClick={() => void refreshNode(target)}
          />
          {supportsDatabaseLevel(driver) && (
            <MenuItem
              icon={<IconTrash />}
              label={`删除${databaseLevelNoun(driver)}…`}
              danger
              onClick={() => {
                setMenu(null);
                void handleDropDatabase(target.connId, schemaName, driver);
              }}
            />
          )}
        </>
      );
    }

    const connTarget = connById(target.connId);
    const connDesc = connTarget
      ? connTarget.type === 'sqlite'
        ? connTarget.path || ''
        : `${connTarget.host || ''}:${connTarget.port ?? ''}${connTarget.database ? `/${connTarget.database}` : ''}`
      : '';
    const isConnected = Boolean(connTarget?.connected);
    return (
      <>
        {!isConnected && (
          <MenuItem
            icon={<IconMenuLink />}
            label="连接"
            onClick={() => {
              setMenu(null);
              void handleConnectSaved(target.connId);
            }}
          />
        )}
        {onOpenSqlConsole && isConnected && (
          <MenuItem
            icon={<IconBolt />}
            label="新建 SQL 控制台"
            onClick={() => {
              setMenu(null);
              onOpenSqlConsole(
                target.connId,
                undefined,
                NEW_CONSOLE_SQL,
                `查询 - ${connTarget?.name ?? '数据库'}`,
              );
            }}
          />
        )}
        <MenuItem
          icon={<IconMenuExpand />}
          label={expandedConns[target.connId] ? '折叠连接' : '展开连接'}
          onClick={() => toggleNode(target)}
        />
        <MenuDivider />
        <MenuItem
          icon={<IconMenuEdit />}
          label="编辑连接…"
          onClick={() => {
            setMenu(null);
            if (connTarget) {
              setEditing(connTarget);
              setIsNewModalOpen(true);
            }
          }}
        />
        <MenuItem
          icon={<IconMenuCopy />}
          label="复制连接名"
          onClick={() => void copyText(connTarget?.name ?? target.connId, '连接名')}
        />
        <MenuItem
          icon={<IconMenuCopy />}
          label="复制连接地址"
          onClick={() => void copyText(connDesc, '连接地址')}
        />
        <MenuDivider />
        <MenuItem
          icon={<IconMenuRefresh />}
          label="刷新连接与库列表"
          onClick={() => void refreshNode(target)}
        />
        {isConnected && (
          <MenuItem
            icon={<IconMenuPlug />}
            label="断开此连接"
            onClick={() => {
              setMenu(null);
              void (async () => {
                const ok = await dbConfirm.confirm({
                  title: '断开连接',
                  content: `确定断开连接 ${mdCode(connTarget?.name ?? target.connId)} 吗？断开后树上的库 / 表列表需要重新连接才能展开。`,
                  confirmLabel: '断开',
                });
                if (ok === null) return;
                void handleDisconnect(target.connId);
              })();
            }}
          />
        )}
        <MenuItem
          icon={<IconTrash />}
          label="删除此连接"
          danger
          onClick={() => {
            setMenu(null);
            void (async () => {
              const ok = await dbConfirm.confirm({
                title: '删除连接',
                tone: 'danger',
                confirmLabel: confirmLabelFor('delete'),
                content:
                  `确定从当前项目中删除连接 ${mdCode(connTarget?.name ?? target.connId)} 吗？\n\n` +
                  '> 该连接配置将从本机该项目绑定的配置中移除，已保存的密码一并失效。\n' +
                  '> 数据库本身不受影响，只删本地配置。',
              });
              if (ok === null) return;
              void handleDeleteConnection(target.connId);
            })();
          }}
        />
      </>
    );
  };

  return (
    <div
      className="database-panel"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        background: 'var(--bg-panel)',
        color: 'var(--text)',
        fontSize: 13,
        userSelect: 'none',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      {/* ── 顶部栏：严格对齐 Maven 规范（高度 30px、padding: 0 10px、.panel-action-btn） ── */}
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
        }}
      >
        <div
          className="panel-header-title"
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: 'var(--text)',
            letterSpacing: '0.05em',
            display: 'flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          <PanelChevron expanded={true} size={12} />
          <span>数据库集成</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button
            type="button"
            className="panel-action-btn"
            title="刷新连接、库与数据表"
            onClick={() => void refreshConnections()}
          >
            <IconReload spinning={loading} />
          </button>
          <button
            type="button"
            className="panel-action-btn"
            title="新建数据库连接 (DBeaver 风格向导)"
            onClick={() => {
              setEditing(null);
              setIsNewModalOpen(true);
            }}
          >
            <IconPlus />
          </button>
          {connections.some((c) => c.connected) && onOpenSqlConsole && (
            <button
              type="button"
              className="panel-action-btn"
              title="在主编辑区新建 SQL 控制台"
              onClick={() => {
                const first = connections.find((c) => c.connected)!;
                onOpenSqlConsole(first.id, undefined, NEW_CONSOLE_SQL, `查询 - ${first.name}`);
              }}
            >
              <IconBolt />
            </button>
          )}
          {/* 新建表：需要知道往哪个库建，所以先取第一个已连接连接下的第一个已加载库 / schema */}
          {connections.some((c) => c.connected) && (
            <button
              type="button"
              className="panel-action-btn"
              title="新建数据表（DDL）"
              onClick={() => {
                const conn = connections.find((c) => c.connected)!;
                const schemas = schemasMap[conn.id] || [];
                if (schemas.length === 0) {
                  onShowToast?.(
                    '请先展开一个数据库',
                    '需要先确定新表建在哪个库 / Schema 下。',
                    'info',
                  );
                  return;
                }
                setStructureModal({
                  mode: 'create',
                  connId: conn.id,
                  schemaName: schemas[0].name,
                });
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="3" y1="9" x2="21" y2="9" />
                <line x1="12" y1="13" x2="12" y2="19" />
                <line x1="9" y1="16" x2="15" y2="16" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* ── 项目查询脚本（图3）：磁盘上保存过的脚本，点一下就在控制台打开 ──
          数据来源是项目配置目录的 `queries/`，不是当前打开的标签 ——
          关掉标签脚本依然在，这正是它比标签列表有用的地方。
          **位置在树之上**：早先放在面板最底部，脚本一多就被树挤到看不见，
          而「找回上次写的查询」恰恰是打开数据库面板时的常见第一步。 */}
      {connections.length > 0 && (
        <ProjectScriptsList
          scripts={scripts ?? []}
          openPaths={openScriptPaths ?? []}
          onOpen={onOpenScript}
          onDelete={onDeleteScript}
        />
      )}

      {/* ── 导航树区域 (Database Navigator) ── */}
      {connections.length === 0 ? (
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '24px 16px',
            textAlign: 'center',
            color: 'var(--text-muted)',
            gap: 12,
          }}
        >
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: 'rgba(59, 130, 246, 0.12)',
              color: '#60a5fa',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 20,
            }}
          >
            🗄️
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
            数据库导航器 (Database Navigator)
          </div>
          <div style={{ fontSize: 12, lineHeight: 1.5, maxWidth: 260 }}>
            像 DBeaver 一样直观管理数据库连接、库与表结构。双击表直接在编辑区全屏查看表数据、DDL 语句或执行 SQL。
          </div>
          <button
            type="button"
            onClick={() => {
              setEditing(null);
              setIsNewModalOpen(true);
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 14px',
              fontSize: 12,
              borderRadius: 6,
              background: 'var(--accent, #3b82f6)',
              color: '#fff',
              border: 'none',
              cursor: 'pointer',
              fontWeight: 500,
            }}
          >
            <IconPlus />
            新建数据库连接
          </button>
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto', padding: '6px 4px' }}>
          {connections.map((conn) => {
            const isConnExpanded = !!expandedConns[conn.id];
            const isConnected = conn.connected;
            const isConnecting = !!loadingKeys[`connect:${conn.id}`];
            const schemas = schemasMap[conn.id] || [];
            const schemasKey = `schemas:${conn.id}`;

            return (
              <div key={conn.id} style={{ marginBottom: 6 }}>
                {/* 连接根节点：未连接的节点点击即用保存的配置重连 */}
                <div
                  className="db-tree-row"
                  style={{ padding: '4px 6px', background: 'rgba(255, 255, 255, 0.03)' }}
                  onClick={() => {
                    if (isConnecting) return;
                    if (!isConnected) {
                      void handleConnectSaved(conn.id);
                      return;
                    }
                    toggleConn(conn.id);
                  }}
                  onContextMenu={(e) => openMenu(e, { kind: 'conn', connId: conn.id })}
                  title={
                    isConnected
                      ? `${conn.type.toUpperCase()} · ${conn.host ? `${conn.host}:${conn.port ?? ''}` : conn.path ?? ''}（右键查看更多操作）`
                      : conn.requiresPassword
                        ? '未连接 · 该连接未保存密码，点击补上密码后连接'
                        : '未连接 · 点击使用项目保存的配置重连（右键查看更多操作）'
                  }
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                    <span style={{ color: 'var(--text-muted)', display: 'flex' }}>
                      {isConnecting ? (
                        <IconReload spinning />
                      ) : isConnExpanded ? (
                        <IconChevronDown />
                      ) : (
                        <IconChevronRight />
                      )}
                    </span>
                    <span style={{ fontSize: 13, opacity: isConnected ? 1 : 0.55 }}>🗄️</span>
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: isConnected ? 'var(--text)' : 'var(--text-muted)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {conn.name}
                    </span>
                    <span
                      style={{
                        fontSize: 10,
                        padding: '1px 4px',
                        borderRadius: 3,
                        background: 'rgba(59, 130, 246, 0.15)',
                        color: '#60a5fa',
                        flexShrink: 0,
                      }}
                    >
                      {conn.type.toUpperCase()}
                    </span>
                    {!isConnected && (
                      <span
                        style={{
                          fontSize: 10,
                          padding: '1px 4px',
                          borderRadius: 3,
                          background: 'rgba(148, 163, 184, 0.18)',
                          color: 'var(--text-muted)',
                          flexShrink: 0,
                        }}
                      >
                        {isConnecting ? '连接中…' : '未连接'}
                      </span>
                    )}
                    {isConnected && conn.database && (
                      <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>
                        {conn.database}
                      </span>
                    )}
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    {isConnected && onOpenSqlConsole && (
                      <button
                        type="button"
                        className="panel-action-btn"
                        title="新建 SQL 控制台"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenSqlConsole(conn.id, undefined, NEW_CONSOLE_SQL, `查询 - ${conn.name}`);
                        }}
                      >
                        <IconBolt />
                      </button>
                    )}
                    {isConnected ? (
                      <button
                        type="button"
                        className="panel-action-btn"
                        title="断开此连接（配置仍保留在项目中）"
                        onClick={(e) => {
                          e.stopPropagation();
                          // 与右键菜单里的「断开此连接」走同一段确认，两条入口不能一个有确认一个没有
                          void requestDisconnect(conn);
                        }}
                      >
                        <IconMenuPlug />
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="panel-action-btn"
                        title="连接（使用项目中保存的配置）"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleConnectSaved(conn.id);
                        }}
                      >
                        <IconMenuLink />
                      </button>
                    )}
                  </div>
                </div>

                {/* 展开：库 / schema 列表 */}
                {isConnExpanded && (
                  <div style={{ paddingLeft: 14, marginTop: 4 }}>
                    {loadingKeys[schemasKey] && schemas.length === 0 && (
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '3px 6px' }}>
                        加载库 / Schema 中...
                      </div>
                    )}
                    {errorMap[schemasKey] && <TreeError message={errorMap[schemasKey]} />}

                    {schemas.map((schema) => {
                      const schemaKey = `${conn.id}:${schema.name}`;
                      const isSchemaExpanded = !!expandedSchemas[schemaKey];
                      const tables = tablesMap[schemaKey] || [];
                      const tablesKey = `tables:${schemaKey}`;
                      const objects = objectsMap[schemaKey];
                      const objectsKey = `objects:${schemaKey}`;

                      /** 表 / 视图共用的行节点：两者都有列结构、都能开数据视图，只有图标与文案不同 */
                      const renderTableNode = (t: DatabaseTableInfo, kind: 'table' | 'view') => {
                        const mapKey = `${schemaKey}:${t.name}`;
                        const isTableExpanded = !!expandedTables[mapKey];
                        const columns = columnsMap[mapKey] || [];
                        const columnsKey = `columns:${mapKey}`;

                        return (
                          <div key={t.name}>
                            {/* 表 / 视图节点 */}
                            <div
                              className="db-tree-row"
                              style={{ padding: '3px 6px' }}
                              onClick={() => toggleTable(conn.id, schema.name, t.name)}
                              onDoubleClick={() => onOpenTableData?.(conn.id, t.name, schema.name)}
                              onContextMenu={(e) =>
                                openMenu(e, {
                                  kind: 'table',
                                  connId: conn.id,
                                  schemaName: schema.name,
                                  tableName: t.name,
                                })
                              }
                              title={`${t.comment ? `${t.name} — ${t.comment}` : t.name}（双击查看数据 · 右键更多操作）`}
                            >
                              <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
                                <span style={{ color: 'var(--text-muted)', display: 'flex' }}>
                                  {isTableExpanded ? <IconChevronDown /> : <IconChevronRight />}
                                </span>
                                {kind === 'view' ? <GroupIcon group="views" /> : <IconTable />}
                                <span
                                  style={{
                                    fontSize: 12,
                                    fontWeight: 500,
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                  }}
                                >
                                  {t.name}
                                </span>
                                {t.rowCount !== undefined && (
                                  <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>
                                    ({t.rowCount})
                                  </span>
                                )}
                              </div>

                              {/* 类似 DBeaver 的快捷动作栏 */}
                              <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                                <button
                                  type="button"
                                  className="panel-action-btn"
                                  title="在编辑区查看表数据 (Data View)"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onOpenTableData?.(conn.id, t.name, schema.name);
                                  }}
                                >
                                  <span style={{ fontSize: 11 }}>📊</span>
                                </button>
                                <button
                                  type="button"
                                  className="panel-action-btn"
                                  title="查看表结构（DDL / 列清单可切换）"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onOpenTableStructure?.(conn.id, t.name, schema.name);
                                  }}
                                >
                                  <span style={{ fontSize: 11 }}>📜</span>
                                </button>
                                {onOpenSqlConsole && (
                                  <button
                                    type="button"
                                    className="panel-action-btn"
                                    title="查询此表 (SQL Console)"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      onOpenSqlConsole(
                                        conn.id,
                                        schema.name,
                                        buildTableSelectSql(conn.type, schema.name, t.name, 50),
                                        `查询 - ${t.name}`,
                                      );
                                    }}
                                  >
                                    <IconBolt />
                                  </button>
                                )}
                              </div>
                            </div>

                            {/* 展开：列字段列表 */}
                            {isTableExpanded && (
                              <div style={{ paddingLeft: 22, paddingBottom: 4 }}>
                                {loadingKeys[columnsKey] && columns.length === 0 && (
                                  <div style={{ fontSize: 10, color: 'var(--text-muted)', padding: '2px 0' }}>
                                    加载列结构...
                                  </div>
                                )}
                                {errorMap[columnsKey] && <TreeError message={errorMap[columnsKey]} />}
                                {columns.map((col) => (
                                  <div
                                    key={col.name}
                                    className="db-tree-row"
                                    style={{
                                      fontSize: 11,
                                      padding: '2px 4px',
                                      color: 'var(--text-muted)',
                                    }}
                                    onContextMenu={(e) =>
                                      openMenu(e, {
                                        kind: 'column',
                                        connId: conn.id,
                                        schemaName: schema.name,
                                        tableName: t.name,
                                        columnName: col.name,
                                      })
                                    }
                                    title={`${col.name} · ${col.type || 'ANY'}${col.pk ? ' · 主键' : ''}${
                                      col.notnull ? ' · NOT NULL' : ''
                                    }（右键：排序 / 筛选 / 复制）`}
                                  >
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                      {col.pk ? <IconKey /> : <IconColumn />}
                                      <span style={{ color: col.pk ? '#f59e0b' : 'var(--text)' }}>
                                        {col.name}
                                      </span>
                                    </div>
                                    <span style={{ fontSize: 10, opacity: 0.7 }}>
                                      {col.type || 'ANY'}
                                      {col.notnull ? ' · NN' : ''}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      };

                      return (
                        <div key={schema.name}>
                          {/* 库 / schema 节点 */}
                          <div
                            className="db-tree-row"
                            style={{ padding: '3px 6px' }}
                            onClick={() => toggleSchema(conn.id, schema.name)}
                            onContextMenu={(e) =>
                              openMenu(e, {
                                kind: 'schema',
                                connId: conn.id,
                                schemaName: schema.name,
                              })
                            }
                            title={`${schema.name}（右键查看更多操作）`}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                              <span style={{ color: 'var(--text-muted)', display: 'flex' }}>
                                {isSchemaExpanded ? <IconChevronDown /> : <IconChevronRight />}
                              </span>
                              <IconDatabase />
                              <span
                                style={{
                                  fontSize: 12,
                                  fontWeight: 500,
                                  whiteSpace: 'nowrap',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                }}
                              >
                                {schema.name}
                              </span>
                              {isSchemaExpanded && !errorMap[tablesKey] && (
                                <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>
                                  ({tables.length})
                                </span>
                              )}
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                              {onOpenSqlConsole && (
                                <button
                                  type="button"
                                  className="panel-action-btn"
                                  title={`在此库新建 SQL 控制台 (${schema.name})`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onOpenSqlConsole(
                                      conn.id,
                                      schema.name,
                                      NEW_CONSOLE_SQL,
                                      `查询 - ${schema.name}`,
                                    );
                                  }}
                                >
                                  <IconBolt />
                                </button>
                              )}
                            </div>
                          </div>

                          {/* 展开：六个分组（Tables / Views / Indexes / Procedures / Triggers / Events） */}
                          {isSchemaExpanded && (
                            <div style={{ paddingLeft: 14 }}>
                              {/* 分组导航在加载期间就渲染出来（表的是否为空此刻还不知道），
                                  这样展开库的那一下不会先闪出一段空白再长出六个节点 */}
                              {OBJECT_GROUPS.map(({ key: group, label }) => {
                                const isGroupExpanded = !!expandedGroups[`${schemaKey}:${group}`];
                                const names = groupNames(objects, group);
                                // 表 / 视图这一对来自 tablesMap：它们要的是带行数、带注释的行节点。
                                // 用 kind 分流，缺省（老驱动返回的行没有 kind）按表处理。
                                const kindRows =
                                  group === 'tables'
                                    ? tables.filter((t) => (t.kind ?? 'table') === 'table')
                                    : group === 'views'
                                      ? tables.filter((t) => t.kind === 'view')
                                      : null;
                                const count = kindRows ? kindRows.length : names.length;
                                // 仅表 / 视图依赖 tables 那条请求；其余四类只看 objects
                                const dependKey = kindRows ? tablesKey : objectsKey;
                                const waiting =
                                  !kindRows && !!loadingKeys[objectsKey] && !objects;
                                // 分组各自的错误优先；整条 objects 请求都失败时（清单根本没拿到），
                                // 退回显示那条总错误 —— 否则四个分组会一起安静地显示「(0)」，
                                // 把「查询失败了」伪装成「确实没有」
                                const groupError = kindRows
                                  ? errorMap[tablesKey]
                                  : (objects?.errors?.[group] ??
                                    (objects ? undefined : errorMap[objectsKey]));

                                return (
                                  <DbGroupRow
                                    key={group}
                                    group={group}
                                    label={label}
                                    count={count}
                                    supported={kindRows ? true : (objects?.supported?.[group] ?? true)}
                                    error={waiting ? undefined : groupError}
                                    expanded={isGroupExpanded}
                                    loading={!!loadingKeys[dependKey] && count === 0}
                                    onToggle={() => toggleGroup(conn.id, schema.name, group)}
                                  >
                                    {count === 0 ? (
                                      // 空分组展开后也要有话说：一片空白会被读成「还没加载」
                                      <div style={{ fontSize: 10, color: 'var(--text-muted)', padding: '2px 0' }}>
                                        {EMPTY_GROUP_HINT[group]}
                                      </div>
                                    ) : kindRows ? (
                                      kindRows.map((t) => renderTableNode(t, group as 'table' | 'view'))
                                    ) : (
                                      names.map((name) => (
                                        <DbObjectRow
                                          key={name}
                                          name={name}
                                          title={name}
                                          icon={<GroupIcon group={group} />}
                                        />
                                      ))
                                    )}
                                  </DbGroupRow>
                                );
                              })}
                            </div>
                          )}

                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 新建 / 编辑连接对话框 */}
      <NewDbConnectionModal
        isOpen={isNewModalOpen}
        editing={editing}
        onClose={() => {
          setIsNewModalOpen(false);
          setEditing(null);
        }}
        onConnected={handleConnected}
        onSaved={() => void refreshConnections()}
        onShowToast={onShowToast}
      />

      {/* 表结构弹窗（新建表 / 设计表） */}
      <TableStructureModal
        isOpen={structureModal !== null}
        mode={structureModal?.mode ?? 'create'}
        driver={
          (structureModal && connById(structureModal.connId)?.type) || 'sqlite'
        }
        schemaName={structureModal?.schemaName}
        tableName={structureModal?.tableName}
        existingColumns={structureModal?.existingColumns}
        onClose={() => setStructureModal(null)}
        onExecute={handleStructureExecute}
        onShowToast={onShowToast}
      />

      {/* 树节点右键菜单（连接 / 库 / 表三个层级共用一套浮层） */}
      {menu && (
        <div
          ref={menuRef}
          className="tab-context-menu"
          style={{ top: menu.y, left: menu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          {renderMenuItems(menu.target)}
        </div>
      )}

      {/* 写操作确认弹窗（Markdown 渲染，SQL 逐条可复制） */}
      {dbConfirm.modal}
    </div>
  );
}

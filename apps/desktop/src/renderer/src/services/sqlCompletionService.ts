import type {
  DatabaseColumnMeta,
  DatabaseTableInfo,
  DatabaseSchemaInfo,
} from '@deepseek-ide/shared';
import * as monaco from 'monaco-editor';
import { columnCacheKey } from './dbColumnCache';
import type { Translate } from '../i18n';

export interface SqlMetadataProvider {
  getConnectionId: () => string;
  getSchemaName: () => string | undefined;
}

// 缓存容器
const schemasCache = new Map<string, DatabaseSchemaInfo[]>();
const tablesCache = new Map<string, DatabaseTableInfo[]>();
const columnsCache = new Map<string, DatabaseColumnMeta[]>();

// 正在进行的并发请求去重
const pendingTables = new Map<string, Promise<DatabaseTableInfo[]>>();
const pendingColumns = new Map<string, Promise<DatabaseColumnMeta[]>>();

function schemaCacheKey(connId: string): string {
  return connId;
}

function tableListCacheKey(connId: string, schema?: string): string {
  return `${connId}:${schema ?? ''}`;
}

/**
 * 异步获取连接下的所有库/schema
 */
export async function getOrFetchSchemas(connId: string): Promise<DatabaseSchemaInfo[]> {
  if (!connId) return [];
  const key = schemaCacheKey(connId);
  const cached = schemasCache.get(key);
  if (cached) return cached;

  try {
    const res = await window.ide.dbListSchemas(connId);
    if (res.ok && res.schemas) {
      schemasCache.set(key, res.schemas);
      return res.schemas;
    }
  } catch (err) {
    console.warn('[sqlCompletion] 获取 schemas 失败:', err);
  }
  return [];
}

/**
 * 异步获取指定库下的所有数据表
 */
export async function getOrFetchTables(
  connId: string,
  schema?: string,
): Promise<DatabaseTableInfo[]> {
  if (!connId) return [];
  const key = tableListCacheKey(connId, schema);
  const cached = tablesCache.get(key);
  if (cached) return cached;

  if (pendingTables.has(key)) {
    return pendingTables.get(key)!;
  }

  const p = (async () => {
    try {
      const res = await window.ide.dbListTables(connId, schema);
      if (res.ok && res.tables) {
        tablesCache.set(key, res.tables);
        return res.tables;
      }
    } catch (err) {
      console.warn('[sqlCompletion] 获取 tables 失败:', err);
    } finally {
      pendingTables.delete(key);
    }
    return [];
  })();

  pendingTables.set(key, p);
  return p;
}

/**
 * 异步获取指定数据表的字段清单
 */
export async function getOrFetchColumns(
  connId: string,
  schema: string | undefined,
  tableName: string,
): Promise<DatabaseColumnMeta[]> {
  if (!connId || !tableName) return [];
  const key = columnCacheKey(connId, schema, tableName);
  const cached = columnsCache.get(key);
  if (cached) return cached;

  if (pendingColumns.has(key)) {
    return pendingColumns.get(key)!;
  }

  const p = (async () => {
    try {
      const res = await window.ide.dbGetTableSchema(connId, tableName, schema);
      if (res.ok && res.columns) {
        columnsCache.set(key, res.columns);
        return res.columns;
      }
    } catch (err) {
      console.warn('[sqlCompletion] 获取 columns 失败:', err);
    } finally {
      pendingColumns.delete(key);
    }
    return [];
  })();

  pendingColumns.set(key, p);
  return p;
}

/**
 * 清除特定连接或库的元数据缓存（如刷新树或更改结构时）
 */
export function invalidateSqlMetadataCache(connId?: string): void {
  if (!connId) {
    schemasCache.clear();
    tablesCache.clear();
    columnsCache.clear();
    return;
  }
  schemasCache.delete(connId);
  for (const k of Array.from(tablesCache.keys())) {
    if (k.startsWith(`${connId}:`)) tablesCache.delete(k);
  }
  for (const k of Array.from(columnsCache.keys())) {
    if (k.startsWith(`${connId.length}:${connId}|`)) columnsCache.delete(k);
  }
}

// 常用 SQL 标准关键字
const SQL_KEYWORDS = [
  'SELECT',
  'FROM',
  'WHERE',
  'AND',
  'OR',
  'NOT',
  'IN',
  'LIKE',
  'BETWEEN',
  'IS NULL',
  'IS NOT NULL',
  'JOIN',
  'INNER JOIN',
  'LEFT JOIN',
  'RIGHT JOIN',
  'FULL JOIN',
  'CROSS JOIN',
  'ON',
  'AS',
  'GROUP BY',
  'HAVING',
  'ORDER BY',
  'ASC',
  'DESC',
  'LIMIT',
  'OFFSET',
  'UNION',
  'UNION ALL',
  'INSERT INTO',
  'VALUES',
  'UPDATE',
  'SET',
  'DELETE FROM',
  'CREATE TABLE',
  'ALTER TABLE',
  'DROP TABLE',
  'TRUNCATE TABLE',
  'CREATE INDEX',
  'DROP INDEX',
  'DISTINCT',
  'COUNT',
  'SUM',
  'AVG',
  'MAX',
  'MIN',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'CAST',
  'COALESCE',
  'CONCAT',
  'SUBSTRING',
  'EXISTS',
  'PRIMARY KEY',
  'FOREIGN KEY',
  'AUTO_INCREMENT',
  'DEFAULT',
];

export interface TableReference {
  raw: string;
  schema?: string;
  tableName: string;
  alias?: string;
}

/**
 * 从当前 SQL 文本中提取已知表名和表别名映射（例如 FROM users u, FROM cvm.cvm_location AS cl, JOIN orders o）
 */
export function parseTableReferences(sqlText: string): {
  tableRefs: TableReference[];
  aliasMap: Map<string, { schema?: string; tableName: string }>;
} {
  const tableRefs: TableReference[] = [];
  const aliasMap = new Map<string, { schema?: string; tableName: string }>();

  // 匹配形如: FROM [schema.]table [[AS] alias], JOIN [schema.]table [[AS] alias], INTO [schema.]table, UPDATE [schema.]table
  const regex = /(?:FROM|JOIN|INTO|UPDATE)\s+((?:([a-zA-Z0-9_\u4e00-\u9fa5]+)\.)?([a-zA-Z0-9_\u4e00-\u9fa5]+))(?:\s+(?:AS\s+)?([a-zA-Z0-9_\u4e00-\u9fa5]+))?/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(sqlText)) !== null) {
    const raw = match[1];
    const schema = match[2];
    const tableName = match[3];
    const alias = match[4];
    if (tableName) {
      const ref: TableReference = { raw, schema, tableName, alias };
      tableRefs.push(ref);
      aliasMap.set(tableName.toLowerCase(), { schema, tableName });
      if (alias && !/^(WHERE|ON|LEFT|RIGHT|INNER|JOIN|GROUP|ORDER|LIMIT|SET|HAVING|AND|OR)$/i.test(alias)) {
        aliasMap.set(alias.toLowerCase(), { schema, tableName });
      }
    }
  }
  return { tableRefs, aliasMap };
}

/**
 * 识别光标所在的 SQL 子句语法上下文：
 * - 'table': 处于 FROM, JOIN, INTO, UPDATE 后面，应优先提示表名与数据库名
 * - 'column': 处于 SELECT 列表、WHERE, ON, SET, ORDER BY, GROUP BY 后面，应优先提示当前已引用表的字段名
 * - 'any': 常规混合上下文
 */
export function detectSqlContext(fullSqlBeforeCursor: string): 'table' | 'column' | 'any' {
  // 清除注释和单引号字符串，避免干扰判断
  const cleanSql = fullSqlBeforeCursor
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, ' ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");

  // 匹配光标前方最后一个 SQL 核心子句关键字
  const matches = Array.from(
    cleanSql.matchAll(/\b(SELECT|FROM|JOIN|WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|ON|SET|INTO|UPDATE|TABLE)\b/gi),
  );
  if (matches.length > 0) {
    const lastKw = matches[matches.length - 1][1].toUpperCase().replace(/\s+/g, ' ');
    if (['FROM', 'JOIN', 'INTO', 'UPDATE', 'TABLE'].includes(lastKw)) {
      return 'table';
    }
    if (['SELECT', 'WHERE', 'ON', 'SET', 'ORDER BY', 'GROUP BY', 'HAVING'].includes(lastKw)) {
      return 'column';
    }
  }
  return 'any';
}

/**
 * 补全项 `documentation` 的拼装（多行「标签: 值」）。
 *
 * 收成函数是因为同样的拼装在下面出现了十几处：写死中文时改一处措辞要改十几遍，
 * 而漏掉的第 N 处**不报错、不崩**，只是那一格继续显示中文 —— 正是 i18n 铺开时
 * 最难发现的一类缺口。
 */
function docLines(entries: Array<[string, string] | null>): string {
  return entries
    .filter((e): e is [string, string] => e !== null)
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n');
}

/**
 * 字段补全项的 detail，如 `[users 字段] VARCHAR(20) 🔑 [主键] · 用户名`。
 *
 * `pkBadge` 为假时只画一个钥匙不写「[主键]」—— 早期两种写法并存，这里按原样保留。
 */
function fieldDetail(
  t: Translate,
  table: string,
  col: DatabaseColumnMeta,
  opts: { pkBadge: boolean },
): string {
  const pk = col.pk ? t(opts.pkBadge ? 'db.compPkBadge' : 'db.compPkBadgeShort') : '';
  const comment = col.comment ? ` · ${col.comment}` : '';
  return `${t('db.compFieldOf', { table })} ${col.type}${pk}${comment}`;
}

/**
 * 字段补全项的 documentation。
 *
 * 两种版式刻意都留着（历史上就是这样，改动它们等于顺带改工具提示的信息量）：
 * - `full`（点号补全）：所属库 / 所属表 / 字段名 / 数据类型 / 可空 / 主键 / 默认值 / 注释
 * - `compact`（SQL 里已引用到的表）：所属表 / 字段名(类型) / 主键 / 注释
 *
 * 库名未知时不写「所属库」这一行 —— 写一个「默认库」会让人以为库名就叫这个。
 */
function fieldDoc(
  t: Translate,
  col: DatabaseColumnMeta,
  where: { schema?: string; table: string; layout: 'full' | 'compact' },
): string {
  if (where.layout === 'compact') {
    return docLines([
      [t('db.compDocTable'), where.table],
      [t('db.compDocColumn'), `${col.name} (${col.type})`],
      col.pk ? [t('db.compDocPk'), t('db.compYes')] : null,
      col.comment ? [t('db.compDocComment'), col.comment] : null,
    ]);
  }
  return docLines([
    where.schema ? [t('db.compDocSchema'), where.schema] : null,
    [t('db.compDocTable'), where.table],
    [t('db.compDocColumn'), col.name],
    [t('db.compDocType'), col.type],
    [t('db.compDocNullable'), col.notnull ? t('db.compNo') : t('db.compYes')],
    col.pk ? [t('db.compDocPk'), t('db.compYes')] : null,
    col.dflt_value !== undefined && col.dflt_value !== null
      ? [t('db.compDocDefault'), String(col.dflt_value)]
      : null,
    col.comment ? [t('db.compDocComment'), col.comment] : null,
  ]);
}

/** 表补全项的 documentation */
function tableDoc(
  t: Translate,
  table: { name: string; kind?: string; comment?: string },
  schema?: string,
): string {
  return docLines([
    [t('db.compDocTableName'), table.name],
    [t('db.compDocKind'), table.kind ? table.kind.toUpperCase() : 'TABLE'],
    schema ? [t('db.compDocSchema'), schema] : null,
    table.comment ? [t('db.compDocRemark'), table.comment] : null,
  ]);
}

/** 表补全项的 detail：有注释就用注释，否则退到 `[表 · 库名]` / `[表]` */
function tableDetail(
  t: Translate,
  table: { comment?: string },
  schema?: string,
): string {
  if (table.comment) return `${t('db.compTable')} ${table.comment}`;
  return schema ? t('db.compTableIn', { schema }) : t('db.compTablePlain');
}

/**
 * 构造 SQL 智能补全项
 */
export async function provideSqlCompletions(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  provider: SqlMetadataProvider,
  /**
   * 翻译函数。**刻意不叫 `t`**：下面 `for (const t of tables)` 会把 `t` 遮住，
   * 那正是本次 i18n 铺开里犯过的错（CSS 里的 `t` 被当成翻译函数调用）。
   */
  translate: Translate,
): Promise<monaco.languages.CompletionList> {
  const connId = provider.getConnectionId();
  const currentSchema = provider.getSchemaName();

  if (!connId) {
    return { suggestions: [] };
  }

  const lineContent = model.getLineContent(position.lineNumber);
  const lineUntilCursor = lineContent.slice(0, position.column - 1);
  const word = model.getWordUntilPosition(position);

  const range: monaco.IRange = {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endColumn: word.endColumn,
  };

  const suggestions: monaco.languages.CompletionItem[] = [];

  // 1. 判断是否处于点号「.」之后（支持单点 `cvm.` 或多段点 `cvm.cvm_location.`）
  const dotMatch = /(?:([a-zA-Z0-9_\u4e00-\u9fa5]+)\.)?([a-zA-Z0-9_\u4e00-\u9fa5]+)\.([a-zA-Z0-9_\u4e00-\u9fa5]*)$/.exec(
    lineUntilCursor,
  );

  if (dotMatch) {
    const schemaPrefix = dotMatch[1]?.trim();
    const qualifier = dotMatch[2].trim();
    const qualifierLower = qualifier.toLowerCase();

    // 场景 A: 两段式点号（例如 `cvm.cvm_location.`），schemaPrefix 明确为库名，qualifier 为表名
    if (schemaPrefix) {
      const columns = await getOrFetchColumns(connId, schemaPrefix, qualifier);
      if (columns && columns.length > 0) {
        for (const col of columns) {
          suggestions.push({
            label: col.name,
            kind: monaco.languages.CompletionItemKind.Field,
            detail: fieldDetail(translate, qualifier, col, { pkBadge: true }),
            documentation: fieldDoc(translate, col, {
              schema: schemaPrefix,
              table: qualifier,
              layout: 'full',
            }),
            insertText: col.name,
            range,
            sortText: `0_${col.pk ? '0' : '1'}_${col.name}`,
          });
        }
        return { suggestions };
      }
    }

    // 场景 B: qualifier 是数据库名（例如 `cvm.`），提示该库下的所有数据表
    const schemas = await getOrFetchSchemas(connId);
    const matchedSchema = schemas.find((s) => s.name.toLowerCase() === qualifierLower);
    if (matchedSchema) {
      const tables = await getOrFetchTables(connId, matchedSchema.name);
      for (const t of tables) {
        suggestions.push({
          label: t.name,
          kind: monaco.languages.CompletionItemKind.Class,
          detail: tableDetail(translate, t, matchedSchema.name),
          documentation: tableDoc(translate, t, matchedSchema.name),
          insertText: t.name,
          range,
          sortText: `0_${t.name}`,
        });
      }
      return { suggestions };
    }

    // 场景 C: qualifier 是表名或表别名（例如 `from cvm.cvm_location cl where cl.` 或 `cvm_location.`）
    const fullText = model.getValue();
    const { aliasMap } = parseTableReferences(fullText);
    const resolved = aliasMap.get(qualifierLower);
    const targetSchema = resolved?.schema || currentSchema;
    const targetTableName = resolved?.tableName || qualifier;

    const columns = await getOrFetchColumns(connId, targetSchema, targetTableName);
    if (columns && columns.length > 0) {
      for (const col of columns) {
        suggestions.push({
          label: col.name,
          kind: monaco.languages.CompletionItemKind.Field,
          detail: fieldDetail(translate, targetTableName, col, { pkBadge: true }),
          documentation: fieldDoc(translate, col, {
            schema: targetSchema || translate('db.compDocDefaultSchema'),
            table: targetTableName,
            layout: 'full',
          }),
          insertText: col.name,
          range,
          sortText: `0_${col.pk ? '0' : '1'}_${col.name}`,
        });
      }
      return { suggestions };
    }

    // 容错兜底：尝试检查当前活跃库下是否有该表
    const fallbackTables = await getOrFetchTables(connId, currentSchema);
    const exactTable = fallbackTables.find((t) => t.name.toLowerCase() === qualifierLower);
    if (exactTable) {
      const cols = await getOrFetchColumns(connId, currentSchema, exactTable.name);
      for (const col of cols) {
        suggestions.push({
          label: col.name,
          kind: monaco.languages.CompletionItemKind.Field,
          detail: fieldDetail(translate, exactTable.name, col, { pkBadge: false }),
          insertText: col.name,
          range,
          sortText: `0_${col.name}`,
        });
      }
      return { suggestions };
    }

    return { suggestions };
  }

  // 2. 常规输入模式（无点号）：根据语法上下文智能决定表与字段的优先推荐
  const fullText = model.getValue();
  const offset = typeof model.getOffsetAt === 'function' ? model.getOffsetAt(position) : fullText.length;
  const fullSqlBeforeCursor = fullText.slice(0, offset);
  const context = detectSqlContext(fullSqlBeforeCursor);

  // 解析当前 SQL 中引用的所有数据表（支持带库名，如 cvm.cvm_location）
  const { tableRefs } = parseTableReferences(fullText);

  // 提取已引用表的字段（优先呈现）
  const tableColumns: monaco.languages.CompletionItem[] = [];
  for (const ref of tableRefs.slice(0, 4)) {
    const cols = await getOrFetchColumns(connId, ref.schema || currentSchema, ref.tableName);
    for (const col of cols) {
      tableColumns.push({
        label: col.name,
        kind: monaco.languages.CompletionItemKind.Field,
        detail: fieldDetail(translate, ref.tableName, col, { pkBadge: false }),
        documentation: fieldDoc(translate, col, {
          table: ref.raw,
          layout: 'compact',
        }),
        insertText: col.name,
        range,
        // 在字段上下文（SELECT/WHERE/ON/ORDER BY）中置于最高优先级 0_
        sortText: context === 'column' ? `0_${col.pk ? '0' : '1'}_${col.name}` : `2_${col.name}`,
      });
    }
  }

  // 获取当前活跃库下的数据表
  const tables = await getOrFetchTables(connId, currentSchema);
  const tableItems: monaco.languages.CompletionItem[] = [];
  for (const t of tables) {
    tableItems.push({
      label: t.name,
      kind: monaco.languages.CompletionItemKind.Class,
      detail: tableDetail(translate, t),
      documentation: tableDoc(translate, t),
      insertText: t.name,
      range,
      // 在表上下文（FROM/JOIN/INTO/UPDATE）中置于最高优先级 0_
      sortText: context === 'table' ? `0_${t.name}` : context === 'column' ? `3_${t.name}` : `1_${t.name}`,
    });
  }

  // 获取当前连接下的数据库列表
  const schemas = await getOrFetchSchemas(connId);
  const schemaItems: monaco.languages.CompletionItem[] = [];
  for (const s of schemas) {
    schemaItems.push({
      label: s.name,
      kind: monaco.languages.CompletionItemKind.Module,
      detail: translate('db.compDatabase'),
      documentation: `${translate('db.compDocDatabase')}: ${s.name}`,
      insertText: s.name,
      range,
      sortText: context === 'table' ? `1_${s.name}` : `4_${s.name}`,
    });
  }

  // SQL 标准关键字
  const keywordItems: monaco.languages.CompletionItem[] = [];
  for (const kw of SQL_KEYWORDS) {
    keywordItems.push({
      label: kw,
      kind: monaco.languages.CompletionItemKind.Keyword,
      detail: translate('db.compSqlKeyword'),
      insertText: kw,
      range,
      sortText: `5_${kw}`,
    });
  }

  // 根据上下文合并候选列表
  if (context === 'column') {
    // 字段上下文：已引用表的字段 > 表名 > 数据库 > 关键字
    suggestions.push(...tableColumns, ...tableItems, ...schemaItems, ...keywordItems);
  } else if (context === 'table') {
    // 表上下文：表名 > 数据库 > 字段 > 关键字
    suggestions.push(...tableItems, ...schemaItems, ...tableColumns, ...keywordItems);
  } else {
    // 混合上下文：字段与表名均靠前，关键字随后
    suggestions.push(...tableColumns, ...tableItems, ...schemaItems, ...keywordItems);
  }

  return { suggestions };
}

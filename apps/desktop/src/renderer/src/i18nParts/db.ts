/**
 * 数据库面板及其数据 / 结构 / 控制台视图与连接弹窗的文案分片。
 *
 * 为什么字典要分片：i18n 铺开阶段有多个改动在并行加 key，
 * 全塞进 i18n.ts 同一个对象里几乎必然冲突。分片后「一个领域一个文件」，
 * 合并顺序集中在 i18n.ts 一处。
 *
 * 注意**不进字典**的东西：驱动 id（`mysql` / `postgres` / `sqlite`）、列类型名
 * （`varchar` / `int`）、SQL 关键字、表名 / 列名 / 库名、`NULL` 展示值、主键角标
 * `(PK)`、localStorage key —— 它们是内部标识或数据库原生写法，翻了会写坏 SQL。
 */
export const dbDict: Record<string, { zh: string; en: string }> = {
  // ── 通用动作 ──
  'db.cancel': { zh: '取消', en: 'Cancel' },
  'db.apply': { zh: '应用', en: 'Apply' },
  'db.confirmExecute': { zh: '确认执行', en: 'Confirm' },
  'db.closeEsc': { zh: '关闭 (Esc)', en: 'Close (Esc)' },
  'db.labelEsc': { zh: '{label} (Esc)', en: '{label} (Esc)' },
  'db.labelEnter': { zh: '{label} (Enter)', en: '{label} (Enter)' },
  'db.completeInputAbove': { zh: '请先完成上方输入', en: 'Complete the input above first' },
  'db.typeToConfirm': {
    zh: '此操作不可恢复。请原样输入 {name} 以确认：',
    en: 'This cannot be undone. Type {name} exactly to confirm:',
  },

  // ── 字段悬浮卡片 ──
  'db.hoverTable': { zh: '表：{line}', en: 'Table: {line}' },
  'db.hoverDescription': { zh: '说明：{text}', en: 'Description: {text}' },

  // ── 列选择器（显示字段） ──
  'db.visibleColumns': { zh: '显示的字段', en: 'Visible columns' },
  'db.searchColumnPlaceholder': { zh: '搜索字段名…', en: 'Search column name…' },
  'db.selectAllColumns': { zh: '全选', en: 'Select all' },
  'db.selectNoColumns': { zh: '全不选', en: 'Select none' },
  'db.resetColumnWidths': { zh: '重置列宽', en: 'Reset widths' },
  'db.noMatchingColumns': { zh: '没有匹配的字段', en: 'No matching columns' },

  // ── 列筛选浮层 ──
  'db.filterColumnTitle': { zh: '筛选「{column}」', en: 'Filter "{column}"' },
  'db.selectOperator': { zh: '选择比较运算符', en: 'Choose a comparison operator' },
  'db.filterValuePlaceholder': {
    zh: '输入要比较的值，回车确定',
    en: 'Enter a value to compare, press Enter',
  },

  // ── 列头排序 / 筛选菜单 ──
  'db.sortAsc': { zh: '升序排序', en: 'Sort ascending' },
  'db.sortDesc': { zh: '降序排序', en: 'Sort descending' },
  'db.current': { zh: '当前', en: 'Current' },
  'db.clearSort': { zh: '清除排序', en: 'Clear sort' },
  'db.editFilter': { zh: '修改筛选条件…', en: 'Edit filter…' },
  'db.filterMenu': { zh: '筛选…', en: 'Filter…' },
  'db.filtered': { zh: '已筛选', en: 'Filtered' },
  'db.filterOpNeedsValue': {
    zh: '{op}：打开后输入要比较的值',
    en: '{op}: opens a field to enter a value',
  },
  'db.filterOpNoValue': {
    zh: '{op}：无需填值，直接筛选',
    en: '{op}: no value needed, filters right away',
  },
  'db.otherOperators': { zh: '其余比较与匹配条件', en: 'Other comparison and match operators' },
  'db.moreFilters': { zh: '更多筛选', en: 'More filters' },
  'db.clearFilter': { zh: '清除筛选', en: 'Clear filter' },
  'db.hideColumnTitle': {
    zh: '隐藏这一列（用右上角「显示字段」可放回来）',
    en: 'Hide this column (bring it back from "Visible columns" at the top right)',
  },
  'db.hideColumn': { zh: '隐藏这一列', en: 'Hide this column' },

  // ── 筛选运算符名（枚举在 services/dbTableQuery 的 FILTER_OPERATORS，
  //    那边只给运算符值、不给文案，所以这里的 key 表是唯一的文案来源） ──
  'db.op.eq': { zh: '等于', en: 'equals' },
  'db.op.ne': { zh: '不等于', en: 'does not equal' },
  'db.op.gt': { zh: '大于', en: 'greater than' },
  'db.op.gte': { zh: '大于等于', en: 'greater than or equal' },
  'db.op.lt': { zh: '小于', en: 'less than' },
  'db.op.lte': { zh: '小于等于', en: 'less than or equal' },
  'db.op.contains': { zh: '包含', en: 'contains' },
  'db.op.notContains': { zh: '不包含', en: 'does not contain' },
  'db.op.startsWith': { zh: '以…开头', en: 'starts with' },
  'db.op.endsWith': { zh: '以…结尾', en: 'ends with' },
  'db.op.isNull': { zh: '为空', en: 'is null' },
  'db.op.isNotNull': { zh: '非空', en: 'is not null' },

  // 排序方向（拼进「列名 降序」这类描述里）
  'db.sortAscWord': { zh: '升序', en: 'ascending' },
  'db.sortDescWord': { zh: '降序', en: 'descending' },

  // ── 「完整 SQL + 条件 chip」栏 ──
  'db.copiedFullSql': { zh: '已复制完整 SQL', en: 'Full SQL copied' },
  'db.copyFailed': { zh: '复制失败', en: 'Copy failed' },
  'db.collapseFullSql': { zh: '收起完整 SQL', en: 'Collapse full SQL' },
  'db.expandFullSql': { zh: '展开完整 SQL', en: 'Expand full SQL' },
  'db.currentQuery': { zh: '当前查询', en: 'Current query' },
  'db.copied': { zh: '已复制', en: 'Copied' },
  'db.copyFullSql': { zh: '复制完整 SQL', en: 'Copy full SQL' },
  'db.editFilterChipTitle': {
    zh: '{column} — 点击可修改该筛选条件',
    en: '{column} — click to edit this filter',
  },
  'db.filterChip': { zh: '筛选：{summary}', en: 'Filter: {summary}' },
  'db.removeFilter': { zh: '移除该筛选条件', en: 'Remove this filter' },
  'db.removeSortTitle': { zh: '点击移除该排序', en: 'Click to remove this sort' },
  'db.sortChip': { zh: '排序：{summary}', en: 'Sort: {summary}' },
  'db.removeSort': { zh: '移除该排序', en: 'Remove this sort' },
  'db.clearAll': { zh: '全部清空', en: 'Clear all' },

  // ── 库节点下的对象分组 ──
  // 分组名（Tables / Views …）**不进字典**：它们在源码里本来就是英文的数据库客户端通用叫法，
  // 中文界面下也照旧显示 —— 译成「表」之后与右侧的 `(12)` 计数挤在一起反而更难扫。
  'db.emptyGroup.tables': { zh: '没有数据表', en: 'No tables' },
  'db.emptyGroup.views': { zh: '没有视图', en: 'No views' },
  'db.emptyGroup.indexes': { zh: '没有索引', en: 'No indexes' },
  'db.emptyGroup.procedures': { zh: '没有存储过程', en: 'No procedures' },
  'db.emptyGroup.triggers': { zh: '没有触发器', en: 'No triggers' },
  'db.emptyGroup.events': { zh: '没有事件', en: 'No events' },
  'db.groupUnsupportedTitle': {
    zh: '{label}：当前数据库类型不支持这一类对象',
    en: '{label}: this database type does not support this kind of object',
  },
  'db.groupToggleTitle': {
    zh: '{label}（{count}）{hint}',
    en: '{label} ({count}){hint}',
  },
  'db.groupClickCollapse': { zh: ' · 点击折叠', en: ' · click to collapse' },
  'db.groupClickExpand': { zh: ' · 点击展开', en: ' · click to expand' },
  'db.unsupported': { zh: '不支持', en: 'Unsupported' },
  'db.groupLoadFailed': { zh: '加载失败：{error}', en: 'Failed to load: {error}' },

  // ── 表结构视图（DDL / 列清单容器） ──
  'db.structureViewMode': { zh: '表结构展示形态', en: 'Structure view mode' },
  'db.showColumnsMode': {
    zh: '以列清单展示，可直接修改并应用',
    en: 'Show the column list, editable and applicable',
  },
  'db.columnsLabel': { zh: '列', en: 'Columns' },
  'db.viewDdlOriginal': { zh: '查看建表语句原文', en: 'View the original CREATE TABLE statement' },
  'db.columnCount': { zh: '{n} 列', en: '{n} columns' },
  'db.reloadStructure': { zh: '重新读取表结构', en: 'Reload table structure' },
  'db.loadingStructure': { zh: '正在读取表结构…', en: 'Loading table structure…' },
  'db.ddlReadFailed': {
    zh: '无法读取建表语句：{error}',
    en: 'Could not read the CREATE statement: {error}',
  },
  'db.noDdlToShow': {
    zh: '这张表没有可展示的建表语句。',
    en: 'This table has no CREATE statement to show.',
  },
  /** 多条错误拼成一行时的分隔符（中文用全角分号，英文用半角加空格） */
  'db.errorSeparator': { zh: '；', en: '; ' },

  // ── 列清单视图（表结构 · 列） ──
  'db.metaTableName': { zh: '表名', en: 'Table name' },
  'db.metaDriver': { zh: '驱动', en: 'Driver' },
  'db.metaColumnCount': { zh: '列数', en: 'Columns' },
  'db.metaComment': { zh: '注释', en: 'Comment' },
  'db.metaEngine': { zh: '引擎', en: 'Engine' },
  'db.metaCharset': { zh: '字符集', en: 'Charset' },
  'db.metaCollation': { zh: '排序规则', en: 'Collation' },
  'db.renameTableTitle': { zh: '点击可重命名这张表', en: 'Click to rename this table' },
  'db.editCommentTitle': { zh: '点击可修改表注释', en: 'Click to edit the table comment' },
  'db.addCommentPlaceholder': { zh: '点击添加注释', en: 'Click to add a comment' },
  'db.enginePlaceholder': { zh: '如 InnoDB', en: 'e.g. InnoDB' },
  'db.charsetPlaceholder': { zh: '如 utf8mb4', en: 'e.g. utf8mb4' },
  'db.collationPlaceholder': { zh: '如 utf8mb4_general_ci', en: 'e.g. utf8mb4_general_ci' },
  'db.collationPlaceholderPg': {
    zh: '留空则不改，需填库中已存在的 collation',
    en: 'Leave empty to keep it unchanged; must be an existing collation',
  },
  'db.sqliteNoTableComment': {
    zh: 'SQLite 不支持表注释',
    en: 'SQLite does not support table comments',
  },
  'db.tableWillBeRenamed': {
    zh: '表将重命名为「{name}」',
    en: 'The table will be renamed to "{name}"',
  },
  'db.invalidTableName': { zh: '表名不合法：{error}', en: 'Invalid table name: {error}' },
  'db.pendingTableOptions': {
    zh: '表选项有 {n} 项改动待应用',
    en: '{n} table option change(s) pending',
  },
  'db.headerColumnName': { zh: '列名', en: 'Column' },
  'db.headerDataType': { zh: '数据类型', en: 'Data type' },
  'db.headerLength': { zh: '长度', en: 'Length' },
  'db.headerNotNull': { zh: '非空', en: 'Not null' },
  'db.headerAutoIncrement': { zh: '自增', en: 'Auto inc.' },
  'db.headerKey': { zh: '键', en: 'Key' },
  'db.headerDefaultValue': { zh: '默认值', en: 'Default' },
  'db.headerExtra': { zh: '额外', en: 'Extra' },
  'db.columnDropped': { zh: '该列已标记删除', en: 'This column is marked for deletion' },
  'db.columnType': { zh: '列类型', en: 'Column type' },
  'db.lengthPlaceholder': { zh: '如 255', en: 'e.g. 255' },
  'db.autoIncOnNewColumn': {
    zh: '新增列的自增请在建表时指定',
    en: 'Set AUTO_INCREMENT for a new column when creating the table',
  },
  'db.autoIncMysqlOnly': {
    zh: '自增仅 MySQL 支持；PostgreSQL 请用 SERIAL 类型',
    en: 'AUTO_INCREMENT is MySQL-only; use SERIAL in PostgreSQL',
  },
  'db.autoIncrement': { zh: '自增', en: 'Auto increment' },
  'db.primaryKeyColumn': { zh: '主键列', en: 'Primary key column' },
  'db.defaultValuePlaceholder': { zh: '留空为无默认值', en: 'Empty means no default' },
  'db.undoDelete': { zh: '取消删除', en: 'Undo delete' },
  'db.markColumnDelete': { zh: '标记删除此列', en: 'Mark this column for deletion' },
  'db.removeRow': { zh: '移除这一行', en: 'Remove this row' },
  'db.addColumn': { zh: '＋ 新增字段', en: '+ Add column' },
  'db.columnsIdleHint': {
    zh: '改动会先暂存在这里，点「应用」才生成 ALTER。表注释与表选项也在同一批里。',
    en: 'Changes are staged here; ALTER is generated only when you click Apply. Table comment and options ride in the same batch.',
  },
  'db.pendingChangesCount': { zh: '{n} 条变更待应用', en: '{n} change(s) pending' },
  'db.totalColumnsCount': { zh: '共 {n} 列', en: '{n} columns in total' },
  'db.discardAllChanges': { zh: '放弃全部未应用的改动', en: 'Discard all unapplied changes' },
  'db.undo': { zh: '撤销', en: 'Undo' },
  'db.generateAlterTitle': {
    zh: '生成 ALTER，二次确认后逐条执行',
    en: 'Generate the ALTER and run it statement by statement after confirmation',
  },
  'db.nothingToApply': { zh: '没有可应用的改动', en: 'Nothing to apply' },
  'db.executing': { zh: '执行中…', en: 'Running…' },
  'db.applyWithCount': { zh: '应用（{n}）', en: 'Apply ({n})' },
  'db.confirmModifyStructure': {
    zh: '确认修改表结构 · {table}',
    en: 'Confirm structure change · {table}',
  },
  'db.columnNameProblem': { zh: '列名「{name}」：{error}', en: 'Column "{name}": {error}' },
  'db.columnLengthProblem': {
    zh: '列「{name}」长度：{error}',
    en: 'Column "{name}" length: {error}',
  },
  'db.unnamed': { zh: '未命名', en: 'unnamed' },
  // 二次确认弹窗的正文（Markdown）
  'db.confirmRenameIntro': {
    zh: '即将修改表「{table}」的结构，并把它**重命名为「{newName}」**。',
    en: 'The structure of table "{table}" will be changed and it will be **renamed to "{newName}"**.',
  },
  'db.confirmModifyIntro': {
    zh: '即将修改表「{table}」的结构。',
    en: 'The structure of table "{table}" will be changed.',
  },
  'db.ddlNoRollbackNote': {
    zh: 'DDL 逐条执行且**无法回滚**：若中途失败，前面的语句已经生效。',
    en: 'DDL runs statement by statement and **cannot be rolled back**: if one fails midway, the earlier ones have already taken effect.',
  },
  'db.renameLastNote': {
    zh: '改名排在最后一条：它前面的语句仍打在旧表名「{table}」上。',
    en: 'The rename comes last: the statements before it still target the old table name "{table}".',
  },

  // ── 表结构弹窗（新建表 / 设计表） ──
  'db.newTable': { zh: '新建表', en: 'New table' },
  'db.designTable': { zh: '设计表 · {table}', en: 'Design table · {table}' },
  'db.close': { zh: '关闭', en: 'Close' },
  'db.tableNameExample': { zh: '例如 users', en: 'e.g. users' },
  'db.willBeCreatedIn': { zh: '将创建在 {schema} 下', en: 'Will be created in {schema}' },
  'db.headerType': { zh: '类型', en: 'Type' },
  'db.headerPrimaryKey': { zh: '主键', en: 'Primary key' },
  'db.pgUseSerial': {
    zh: 'PostgreSQL 请使用 SERIAL 类型',
    en: 'Use the SERIAL type in PostgreSQL',
  },
  'db.addColumnPlain': { zh: '＋ 添加列', en: '+ Add column' },
  'db.pendingSqlPreview': {
    zh: '即将执行的 SQL（{n} 条）',
    en: 'SQL about to run ({n} statements)',
  },
  'db.pendingSqlPreviewPlain': { zh: '即将执行的 SQL', en: 'SQL about to run' },
  'db.sqlPreviewPlaceholder': {
    zh: '-- 填写完整后这里会显示生成的 SQL',
    en: '-- The generated SQL appears here once the form is complete',
  },
  // `services/dbDdl` 的校验与「被跳过的改动」返回的是**原因码**（DB_DDL_ERROR_KEY /
  // DB_ALTER_SKIP_KEY），不是文案 —— 那是纯逻辑模块，拿不到 i18n 上下文。
  'db.ddlErrNameEmpty': { zh: '名称不能为空', en: 'The name cannot be empty' },
  'db.ddlErrNameTooLong': {
    zh: '名称过长（最多 64 个字符）',
    en: 'The name is too long (64 characters max)',
  },
  'db.ddlErrNameChars': {
    zh: '只能包含字母、数字、下划线、$ 与中文，且不能以数字开头',
    en: 'Only letters, digits, underscore, $ and Chinese characters are allowed, and it cannot start with a digit',
  },
  'db.ddlErrLength': {
    zh: '长度 / 精度必须是数字，或形如 10,2',
    en: 'Length / precision must be a number, or in the form 10,2',
  },
  'db.ddlErrRenameSame': {
    zh: '新表名与原表名相同',
    en: 'The new table name is the same as the old one',
  },
  // SQLite 不支持这些 ALTER，逐条说明为什么跳过（{name} 是列名或类型名）
  'db.ddlSkipAddNotnull': {
    zh: 'SQLite 无法新增 NOT NULL 且无默认值的列「{name}」，已跳过（既有行无值可填）',
    en: 'SQLite cannot add the NOT NULL column "{name}" without a default — skipped (existing rows have no value to fill in)',
  },
  'db.ddlSkipAddPk': {
    zh: 'SQLite 无法通过 ALTER 新增主键列「{name}」，已跳过',
    en: 'SQLite cannot add the primary key column "{name}" via ALTER — skipped',
  },
  'db.ddlSkipChangeType': {
    zh: 'SQLite 不支持修改列类型（「{name}」需整表重建），已跳过',
    en: 'SQLite cannot change a column type ({name} requires rebuilding the table) — skipped',
  },
  'db.ddlSkipChangeNotnull': {
    zh: 'SQLite 不支持修改列的非空约束（「{name}」需整表重建），已跳过',
    en: 'SQLite cannot change a column NOT NULL constraint ({name} requires rebuilding the table) — skipped',
  },
  'db.ddlSkipChangeDefault': {
    zh: 'SQLite 不支持通过 ALTER 修改默认值（「{name}」需整表重建），已跳过',
    en: 'SQLite cannot change a default value via ALTER ({name} requires rebuilding the table) — skipped',
  },
  'db.runDdlTitle': {
    zh: '执行 DDL（会二次确认）',
    en: 'Run the DDL (with a confirmation step)',
  },
  'db.fillRequiredFirst': { zh: '请先补全必填项', en: 'Fill in the required fields first' },
  'db.createTable': { zh: '创建表', en: 'Create table' },
  'db.applyChanges': { zh: '应用变更', en: 'Apply changes' },
  'db.confirmCreateTable': { zh: '确认创建表', en: 'Confirm table creation' },
  'db.confirmModifyStructurePlain': {
    zh: '确认修改表结构',
    en: 'Confirm structure change',
  },
  'db.confirmCreate': { zh: '确认创建', en: 'Confirm create' },
  'db.confirmCreateIntro': {
    zh: '即将创建表「{table}」。',
    en: 'Table "{table}" will be created.',
  },
  'db.confirmAlterIntro': {
    zh: '即将修改表「{table}」的结构，共 **{n}** 条语句。',
    en: 'The structure of table "{table}" will be changed, **{n}** statements in total.',
  },
  'db.tableNameProblem': { zh: '表名：{error}', en: 'Table name: {error}' },
  'db.needAtLeastOneColumn': { zh: '至少需要一列', en: 'At least one column is required' },
  'db.tableCreated': { zh: '已创建表 {table}', en: 'Table {table} created' },
  'db.tableUpdated': { zh: '已更新表 {table} 的结构', en: 'Structure of table {table} updated' },
  'db.structureChangeFailed': { zh: '表结构变更失败', en: 'Failed to change the table structure' },
  'db.structureChangeFailedFor': {
    zh: '表 {table} 结构变更失败',
    en: 'Failed to change the structure of table {table}',
  },
  'db.structureChangePartial': {
    zh: '表 {table} 结构变更部分生效',
    en: 'Structure change for table {table} partially applied',
  },
  'db.applyStatementCount': { zh: '共执行 {n} 条语句', en: '{n} statements were run' },
  'db.applyDriverReason': { zh: '{driver}：{reason}', en: '{driver}: {reason}' },
  'db.applyPartialDetail': {
    zh: '已执行 {applied} / {total} 条，第 {failed} 条出错：{reason}',
    en: '{applied} of {total} statements ran; statement {failed} failed: {reason}',
  },
  'db.unknownReason': { zh: '未知原因', en: 'unknown reason' },
  // 重命名库脚本里的注释行（脚本会被直接倒进 SQL 控制台，注释是它唯一的说明书）
  'db.renameScriptHeader': {
    zh: '重命名数据库 {from} → {to}',
    en: 'Rename database {from} → {to}',
  },
  'db.renameScriptWhyMysql': {
    zh: 'MySQL 没有 RENAME DATABASE，以下是「建新库 → 逐表迁移 → 删旧库」的等价脚本。',
    en: 'MySQL has no RENAME DATABASE, so this is the equivalent script: create the new database, migrate each table, drop the old database.',
  },
  'db.renameScriptWarning': {
    zh: '请逐条检查后执行；执行前务必备份。',
    en: 'Review each statement before running, and take a backup first.',
  },
  'db.renameScriptNoTables': {
    zh: '未读取到表清单，请手动补充迁移语句。',
    en: 'No table list could be read — add the migration statements by hand.',
  },
  // SQL 补全项上的说明文字（Monaco 补全列表的 detail / documentation）
  'db.compFieldOf': { zh: '[{table} 字段]', en: '[{table} field]' },
  'db.compPkBadge': { zh: ' 🔑 [主键]', en: ' 🔑 [PK]' },
  'db.compPkBadgeShort': { zh: ' 🔑', en: ' 🔑' },
  'db.compTable': { zh: '[表]', en: '[table]' },
  'db.compTableIn': { zh: '[数据表 · {schema}]', en: '[table · {schema}]' },
  'db.compTablePlain': { zh: '[数据表]', en: '[table]' },
  'db.compDatabase': { zh: '[数据库]', en: '[database]' },
  'db.compSqlKeyword': { zh: '[SQL 关键字]', en: '[SQL keyword]' },
  'db.compDocSchema': { zh: '所属库', en: 'Schema' },
  'db.compDocTable': { zh: '所属表', en: 'Table' },
  'db.compDocTableName': { zh: '表名', en: 'Table name' },
  'db.compDocColumn': { zh: '字段名', en: 'Column' },
  'db.compDocType': { zh: '数据类型', en: 'Data type' },
  'db.compDocKind': { zh: '类型', en: 'Kind' },
  'db.compDocNullable': { zh: '是否允许为NULL', en: 'Nullable' },
  'db.compDocPk': { zh: '主键', en: 'Primary key' },
  'db.compDocDefault': { zh: '默认值', en: 'Default' },
  'db.compDocComment': { zh: '注释', en: 'Comment' },
  'db.compDocRemark': { zh: '备注', en: 'Remark' },
  'db.compDocDatabase': { zh: '数据库 / Schema', en: 'Database / schema' },
  'db.compDocDefaultSchema': { zh: '默认库', en: 'default schema' },
  'db.compYes': { zh: '是', en: 'yes' },
  'db.compNo': { zh: '否', en: 'no' },
  'db.renameScriptDropOld': {
    zh: '确认数据无误后，再执行下面这条删除旧库：',
    en: 'Once you have confirmed the data, run the statement below to drop the old database:',
  },

  // ── 数据库导航面板（DatabasePanel） ──
  'db.databaseIntegration': { zh: '数据库集成', en: 'Database' },
  'db.refreshConnectionsTitle': {
    zh: '刷新连接、库与数据表',
    en: 'Refresh connections, databases and tables',
  },
  'db.newConnectionWizardTitle': {
    zh: '新建数据库连接 (DBeaver 风格向导)',
    en: 'New database connection (DBeaver-style wizard)',
  },
  'db.newSqlConsoleInEditorTitle': {
    zh: '在主编辑区新建 SQL 控制台',
    en: 'Open a new SQL console in the editor',
  },
  'db.newTableDdlTitle': { zh: '新建数据表（DDL）', en: 'New table (DDL)' },
  'db.navigatorTitle': {
    zh: '数据库导航器 (Database Navigator)',
    en: 'Database Navigator',
  },
  'db.navigatorDesc': {
    zh: '像 DBeaver 一样直观管理数据库连接、库与表结构。双击表直接在编辑区全屏查看表数据、DDL 语句或执行 SQL。',
    en: 'Manage connections, databases and table structures the way DBeaver does. Double-click a table to view its data or DDL, or to run SQL, full-screen in the editor.',
  },
  'db.newConnection': { zh: '新建数据库连接', en: 'New connection' },
  'db.expandProjectScripts': { zh: '展开项目查询脚本', en: 'Expand project scripts' },
  'db.collapseProjectScripts': { zh: '收起项目查询脚本', en: 'Collapse project scripts' },
  'db.projectScripts': { zh: '项目查询脚本', en: 'Project scripts' },
  'db.projectScriptsEmpty': {
    zh: '在 SQL 控制台里保存过的脚本会出现在这里；脚本跟项目走，关掉标签也还在。',
    en: 'Scripts saved from the SQL console show up here. They belong to the project, so closing the tab does not remove them.',
  },
  'db.deleteScriptFile': {
    zh: '删除这个脚本文件（不可撤销）',
    en: 'Delete this script file (cannot be undone)',
  },
  'db.connTitleConnected': {
    zh: '{driver} · {target}（右键查看更多操作）',
    en: '{driver} · {target} (right-click for more actions)',
  },
  'db.connNotConnectedNoPassword': {
    zh: '未连接 · 该连接未保存密码，点击补上密码后连接',
    en: 'Not connected · no saved password; click to enter it and connect',
  },
  'db.connNotConnectedClick': {
    zh: '未连接 · 点击使用项目保存的配置重连（右键查看更多操作）',
    en: 'Not connected · click to reconnect with the project’s saved settings (right-click for more actions)',
  },
  'db.connecting': { zh: '连接中…', en: 'Connecting…' },
  'db.notConnected': { zh: '未连接', en: 'Not connected' },
  'db.loadingSchemas': { zh: '加载库 / Schema 中...', en: 'Loading databases / schemas…' },
  'db.loadingColumns': { zh: '加载列结构...', en: 'Loading columns…' },
  'db.tableNodeTitle': {
    zh: '{name}（双击查看数据 · 右键更多操作）',
    en: '{name} (double-click for data · right-click for more actions)',
  },
  'db.tableNodeTitleWithComment': {
    zh: '{name} — {comment}（双击查看数据 · 右键更多操作）',
    en: '{name} — {comment} (double-click for data · right-click for more actions)',
  },
  'db.schemaNodeTitle': {
    zh: '{name}（右键查看更多操作）',
    en: '{name} (right-click for more actions)',
  },
  'db.columnNodeTitle': {
    zh: '{name} · {type}{pk}{notnull}（右键：排序 / 筛选 / 复制）',
    en: '{name} · {type}{pk}{notnull} (right-click: sort / filter / copy)',
  },
  'db.pkSuffix': { zh: ' · 主键', en: ' · primary key' },
  'db.notNullSuffix': { zh: ' · NOT NULL', en: ' · NOT NULL' },
  'db.newSqlConsoleHereTitle': {
    zh: '在此库新建 SQL 控制台 ({name})',
    en: 'New SQL console in this database ({name})',
  },
  'db.viewTableDataTitle': {
    zh: '在编辑区查看表数据 (Data View)',
    en: 'View table data in the editor (Data View)',
  },
  'db.viewTableStructureTitle': {
    zh: '查看表结构（DDL / 列清单可切换）',
    en: 'View table structure (switch between DDL and column list)',
  },
  'db.queryTableTitle': { zh: '查询此表 (SQL Console)', en: 'Query this table (SQL console)' },
  'db.disconnectKeepConfig': {
    zh: '断开此连接（配置仍保留在项目中）',
    en: 'Disconnect (the settings stay in the project)',
  },
  'db.connectWithSaved': {
    zh: '连接（使用项目中保存的配置）',
    en: 'Connect (using the project’s saved settings)',
  },
  'db.newSqlConsole': { zh: '新建 SQL 控制台', en: 'New SQL console' },
  'db.queryTabTitle': { zh: '查询 - {name}', en: 'Query - {name}' },
  'db.databaseFallback': { zh: '数据库', en: 'database' },

  // 右键菜单项（表层级）
  'db.menuViewTableData': { zh: '查看表数据', en: 'View table data' },
  'db.menuViewTableStructure': { zh: '查看表结构', en: 'View table structure' },
  'db.menuCollapseColumns': { zh: '折叠列结构', en: 'Collapse columns' },
  'db.menuExpandColumns': { zh: '展开列结构', en: 'Expand columns' },
  'db.menuQueryInNewConsole': {
    zh: '在新 SQL 控制台查询此表',
    en: 'Query this table in a new SQL console',
  },
  'db.menuCopyTableName': { zh: '复制表名', en: 'Copy table name' },
  'db.menuCopyQualifiedName': { zh: '复制全限定名', en: 'Copy qualified name' },
  'db.menuCopySelect': { zh: '复制 SELECT 语句', en: 'Copy SELECT statement' },
  'db.menuDesignTable': { zh: '设计表…（修改列结构）', en: 'Design table… (edit columns)' },
  'db.menuNewTableHere': { zh: '在此库新建表…', en: 'New table in this database…' },
  'db.menuCopyInsertTemplate': { zh: '复制 INSERT 模板', en: 'Copy INSERT template' },
  'db.menuRefreshTable': { zh: '刷新此表', en: 'Refresh this table' },
  'db.menuDropTable': { zh: '删除表…', en: 'Drop table…' },
  'db.needExpandColumnsFirst': { zh: '请先展开列结构', en: 'Expand the columns first' },
  'db.needExpandColumnsFirstDetail': {
    zh: '展开后即可按真实列名生成 INSERT 模板。',
    en: 'Once expanded, the INSERT template uses the real column names.',
  },

  // 右键菜单项（列层级）
  'db.menuSortByColAsc': { zh: '按此列升序排列', en: 'Sort ascending by this column' },
  'db.menuSortByColDesc': { zh: '按此列降序排列', en: 'Sort descending by this column' },
  'db.menuFilterByCol': { zh: '按此列筛选…', en: 'Filter by this column…' },
  'db.menuCopyColumnName': { zh: '复制列名', en: 'Copy column name' },
  'db.menuCopyQualifiedColName': { zh: '复制全限定列名', en: 'Copy qualified column name' },
  'db.menuCopyWhere': { zh: '复制 WHERE 片段', en: 'Copy WHERE fragment' },
  'db.menuCopySelectWithCol': {
    zh: '复制 SELECT 语句（含此列）',
    en: 'Copy SELECT statement (including this column)',
  },
  'db.menuColumnType': {
    zh: '列类型：{type}{notnull}{pk}',
    en: 'Column type: {type}{notnull}{pk}',
  },

  // 右键菜单项（库 / Schema 层级）
  'db.menuNewSqlConsoleHere': {
    zh: '在此库新建 SQL 控制台',
    en: 'New SQL console in this database',
  },
  'db.menuCollapseDb': { zh: '折叠此库', en: 'Collapse this database' },
  'db.menuExpandDb': { zh: '展开此库', en: 'Expand this database' },
  'db.menuNewDatabase': { zh: '新建{noun}…', en: 'New {noun}…' },
  'db.menuRenameDatabase': {
    zh: '重命名{noun}…（生成脚本）',
    en: 'Rename {noun}… (generate a script)',
  },
  'db.menuDropDatabase': { zh: '删除{noun}…', en: 'Drop {noun}…' },
  'db.menuCopyDbName': { zh: '复制库 / Schema 名', en: 'Copy database / schema name' },
  'db.menuCopyAllTableNames': { zh: '复制全部表名', en: 'Copy all table names' },
  'db.menuRefreshDbTables': { zh: '刷新此库的表列表', en: 'Refresh this database’s tables' },

  // 右键菜单项（连接层级）
  'db.menuConnect': { zh: '连接', en: 'Connect' },
  'db.menuCollapseConn': { zh: '折叠连接', en: 'Collapse connection' },
  'db.menuExpandConn': { zh: '展开连接', en: 'Expand connection' },
  'db.menuEditConnection': { zh: '编辑连接…', en: 'Edit connection…' },
  'db.menuCopyConnName': { zh: '复制连接名', en: 'Copy connection name' },
  'db.menuCopyConnAddress': { zh: '复制连接地址', en: 'Copy connection address' },
  'db.menuRefreshConn': { zh: '刷新连接与库列表', en: 'Refresh connections and databases' },
  'db.menuDisconnectConn': { zh: '断开此连接', en: 'Disconnect' },
  'db.menuDeleteConn': { zh: '删除此连接', en: 'Delete this connection' },

  // 库层级名词（随驱动变化）
  'db.noun.database': { zh: '数据库', en: 'database' },
  'db.noun.schema': { zh: 'Schema', en: 'schema' },

  // 确认弹窗（断开 / 删除连接）
  'db.disconnectTitle': { zh: '断开连接', en: 'Disconnect' },
  'db.disconnectConfirm': {
    zh: '确定断开连接 {name} 吗？断开后树上的库 / 表列表需要重新连接才能展开。',
    en: 'Disconnect {name}? After disconnecting, the database and table lists require reconnecting before they can expand.',
  },
  'db.disconnectLabel': { zh: '断开', en: 'Disconnect' },
  'db.deleteConnectionTitle': { zh: '删除连接', en: 'Delete connection' },
  'db.deleteConnectionConfirm': {
    zh: '确定从当前项目中删除连接 {name} 吗？',
    en: 'Delete connection {name} from the current project?',
  },
  'db.deleteConnectionNote1': {
    zh: '该连接配置将从本机该项目绑定的配置中移除，已保存的密码一并失效。',
    en: 'The connection settings will be removed from this project’s local configuration, and any saved password stops working.',
  },
  'db.deleteConnectionNote2': {
    zh: '数据库本身不受影响，只删本地配置。',
    en: 'The database itself is untouched; only the local settings are deleted.',
  },
  'db.filterByColumnTitle': { zh: '按列筛选', en: 'Filter by column' },
  'db.filterByColumnContent': {
    zh: '目标列：{column}\n\n输入要匹配的值（默认按「包含」匹配文本，输入纯数字按「等于」匹配）；确认后将打开表数据视图并按该条件查询。',
    en: 'Target column: {column}\n\nEnter the value to match (text matches with "contains" by default; a plain number matches with "equals"). Confirming opens the table data view filtered by this condition.',
  },
  'db.filterValueLabel': { zh: '要匹配的值：', en: 'Value to match:' },
  'db.filterValueExample': { zh: '例如 alice 或 42', en: 'e.g. alice or 42' },
  'db.openAndFilter': { zh: '打开并筛选', en: 'Open and filter' },
  'db.createNoun': { zh: '新建{noun}', en: 'New {noun}' },
  'db.dropNoun': { zh: '删除{noun}', en: 'Drop {noun}' },
  'db.renameNoun': { zh: '重命名{noun}', en: 'Rename {noun}' },
  'db.createLabel': { zh: '创建', en: 'Create' },
  // 危险操作确认按钮的文案。`services/dbConfirmContent.confirmLabelKey` 返回的是
  // **这些 key**（不是文案），由调用点 t() 出来 —— 服务层拿不到 i18n 上下文。
  'db.confirmDropLabel': { zh: '确认删除', en: 'Delete' },
  'db.confirmTruncateLabel': { zh: '确认清空', en: 'Truncate' },
  'db.confirmDeleteLabel': { zh: '确认删除', en: 'Delete' },
  'db.confirmExecuteLabel': { zh: '确认执行', en: 'Run' },
  // buildSqlConfirmMarkdown 拼的弹窗正文
  'db.confirmDangerBanner': {
    zh: '⚠️ **危险操作**：{intro}',
    en: '⚠️ **Dangerous operation**: {intro}',
  },
  'db.confirmMultiStatements': {
    zh: '共 **{n}** 条语句，将按顺序执行：',
    en: '**{n}** statements will run in order:',
  },
  'db.confirmSingleStatement': { zh: '将执行以下语句：', en: 'The following statement will run:' },
  'db.generateScript': { zh: '生成脚本', en: 'Generate script' },
  'db.createDatabaseContent': {
    zh: '填写名称后将在连接 **{conn}** 上创建新的{noun}。',
    en: 'Enter a name and a new {noun} will be created on connection **{conn}**.',
  },
  'db.newNounNameLabel': { zh: '新{noun}名称：', en: 'New {noun} name:' },
  'db.nounNameLabel': { zh: '{noun}名', en: '{noun} name' },
  'db.renameDatabaseContent': {
    zh: '将 {name} 重命名为新的{noun}。名称需与旧名称不同。',
    en: 'Rename {name} to a new {noun}. The name must differ from the old one.',
  },
  'db.dropDatabaseIntro': {
    zh: '即将删除{noun} {name} 及其中的 **全部数据**。',
    en: 'The {noun} {name} and **all of its data** will be dropped.',
  },
  'db.dropDatabaseNote': {
    zh: '删除整个{noun}无法回滚，请确认其中没有还需要的数据。',
    en: 'Dropping an entire {noun} cannot be rolled back; make sure nothing in it is still needed.',
  },
  'db.driverNoCreateNoun': {
    zh: '该驱动不支持新建{noun}',
    en: 'This driver does not support creating a {noun}',
  },
  'db.driverNoDropNoun': {
    zh: '该驱动不支持删除{noun}',
    en: 'This driver does not support dropping a {noun}',
  },
  'db.driverNoRenameNoun': {
    zh: '该驱动不支持重命名{noun}',
    en: 'This driver does not support renaming a {noun}',
  },
  'db.nounCreated': { zh: '已创建{noun}', en: '{noun} created' },
  'db.nounDropped': { zh: '已删除{noun}', en: '{noun} dropped' },
  'db.nounCreateFailed': { zh: '创建{noun}失败', en: 'Failed to create the {noun}' },
  'db.nounDropFailed': { zh: '删除{noun}失败', en: 'Failed to drop the {noun}' },
  'db.renameScriptGenerated': { zh: '已生成重命名脚本', en: 'Rename script generated' },
  'db.renameScriptGeneratedDetail': {
    zh: '请逐条检查后手动执行；执行前务必备份。',
    en: 'Review each statement and run them manually; back up first.',
  },
  'db.renameConsoleTitle': { zh: '重命名{noun} - {name}', en: 'Rename {noun} - {name}' },
  'db.dropTableTitle': { zh: '删除表', en: 'Drop table' },
  'db.dropTableIntro': {
    zh: '即将删除表 {name} 及其中的 **全部数据**。',
    en: 'Table {name} and **all of its data** will be dropped.',
  },
  'db.dropTableNote': {
    zh: '删除表无法回滚，请确认没有程序仍在依赖它。',
    en: 'Dropping a table cannot be rolled back; make sure no program still depends on it.',
  },
  'db.tableDropped': { zh: '已删除表 {table}', en: 'Table {table} dropped' },
  'db.dropTableFailed': { zh: '删除表失败', en: 'Failed to drop the table' },
  'db.structureModalStale': {
    zh: '弹窗状态已失效，请重新打开',
    en: 'The dialog state expired; open it again',
  },
  'db.sqlUnsupported': { zh: '当前环境不支持执行 SQL', en: 'Running SQL is not supported here' },
  'db.ddlPartialApplied': {
    zh: '（前 {n} 条已生效，DDL 无法回滚）',
    en: ' (the first {n} statements already took effect; DDL cannot be rolled back)',
  },
  'db.stepFailed': { zh: '执行失败', en: 'Execution failed' },
  'db.loadConnectionsFailed': {
    zh: '加载数据库连接失败',
    en: 'Failed to load database connections',
  },
  'db.disconnectedOk': { zh: '已断开数据库连接', en: 'Database disconnected' },
  'db.disconnectFailed': { zh: '断开失败', en: 'Disconnect failed' },
  'db.cannotConnectDirectly': { zh: '无法直接连接', en: 'Cannot connect directly' },
  'db.noSavedPassword': { zh: '该连接未保存密码', en: 'No saved password for this connection' },
  'db.noSavedPasswordDetail': {
    zh: '请点击「编辑连接…」补上密码后连接',
    en: 'Use “Edit connection…” to add the password, then connect',
  },
  'db.connConfigNotFound': { zh: '未找到该连接配置', en: 'Connection settings not found' },
  'db.connConfigNotFoundDetail': {
    zh: '它可能已从当前项目中被删除',
    en: 'It may have been deleted from the current project',
  },
  'db.connCannotReconnect': {
    zh: '该连接无法直接重连',
    en: 'This connection cannot reconnect directly',
  },
  'db.connCannotReconnectDetail': {
    zh: '请点击「编辑连接…」确认参数后再连接',
    en: 'Check the settings in “Edit connection…” and try again',
  },
  'db.connectedTo': { zh: '已连接「{name}」', en: 'Connected to “{name}”' },
  'db.connectFailedTo': { zh: '连接「{name}」失败', en: 'Failed to connect to “{name}”' },
  'db.connectFailed': { zh: '连接失败', en: 'Connection failed' },
  'db.connDeletedOk': {
    zh: '已从项目中删除该连接配置',
    en: 'Connection settings deleted from the project',
  },
  'db.deleteConnectionFailed': { zh: '删除连接失败', en: 'Failed to delete the connection' },
  'db.expandDatabaseFirst': { zh: '请先展开一个数据库', en: 'Expand a database first' },
  'db.expandDatabaseFirstDetail': {
    zh: '需要先确定新表建在哪个库 / Schema 下。',
    en: 'The new table needs a database / schema to live in.',
  },
  'db.loadSchemasFailed': { zh: '加载库 / Schema 失败', en: 'Failed to load databases / schemas' },
  'db.loadTablesFailed': { zh: '加载数据表失败', en: 'Failed to load tables' },
  'db.loadObjectsFailed': { zh: '加载数据库对象失败', en: 'Failed to load database objects' },
  'db.loadColumnsFailed': { zh: '加载表字段失败', en: 'Failed to load table columns' },
  'db.notConnectedClickToReconnect': {
    zh: '未连接：点击该连接即可用保存的配置重连',
    en: 'Not connected: click the connection to reconnect with the saved settings',
  },
  'db.loadFailedWithDetail': { zh: '{message}: {detail}', en: '{message}: {detail}' },
  'db.copiedLabel': { zh: '已复制{label}', en: '{label} copied' },
  'db.copyLabelFailed': { zh: '复制{label}失败', en: 'Failed to copy {label}' },
  /** 复制动作的对象名（拼进「已复制…」提示） */
  'db.copyObj.tableName': { zh: '表名', en: 'table name' },
  'db.copyObj.qualifiedName': { zh: '全限定名', en: 'qualified name' },
  'db.copyObj.select': { zh: 'SELECT 语句', en: 'SELECT statement' },
  'db.copyObj.insertTemplate': { zh: 'INSERT 模板', en: 'INSERT template' },
  'db.copyObj.columnName': { zh: '列名', en: 'column name' },
  'db.copyObj.qualifiedColumnName': { zh: '全限定列名', en: 'qualified column name' },
  'db.copyObj.whereFragment': { zh: 'WHERE 片段', en: 'WHERE fragment' },
  'db.copyObj.dbName': { zh: '库名', en: 'database name' },
  'db.copyObj.allTableNames': { zh: '全部表名 ({n} 张)', en: 'all table names ({n})' },
  'db.copyObj.connName': { zh: '连接名', en: 'connection name' },
  'db.copyObj.connAddress': { zh: '连接地址', en: 'connection address' },

  // 新建 / 编辑连接弹窗（NewDbConnectionModal）
  'db.editConnectionTitle': {
    zh: '编辑数据库连接 (Edit Connection)',
    en: 'Edit Database Connection',
  },
  'db.newConnectionTitle': {
    zh: '新建数据库连接 (Database Connection)',
    en: 'New Database Connection',
  },
  'db.connDriverTypeLabel': { zh: '数据库驱动类型 (Driver Type)', en: 'Driver Type' },
  'db.connDescSqlite': { zh: '本地嵌入式 (免安装)', en: 'Embedded locally (no install)' },
  'db.connDescMysql': { zh: '标准关系型服务', en: 'Standard relational server' },
  'db.connDescPostgres': { zh: '高级对象关系型', en: 'Advanced object-relational' },
  'db.connNameLabel': { zh: '连接显示名称 (Connection Name)', en: 'Connection Name' },
  'db.connNamePlaceholderSqlite': { zh: '例如: Main SQLite DB', en: 'e.g. Main SQLite DB' },
  'db.connSqlitePathLabel': {
    zh: 'SQLite 文件路径 (*.db / *.sqlite / *.sqlite3)',
    en: 'SQLite file path (*.db / *.sqlite / *.sqlite3)',
  },
  'db.connCreateDemo': { zh: '一键创建 Demo 示例库', en: 'Create a demo database' },
  'db.connBrowse': { zh: '浏览...', en: 'Browse…' },
  /** 提示行里的强调片段与正文分开：强调部分要单独包 <strong>，整句语序由字典决定 */
  'db.connTipLabel': { zh: '提示：', en: 'Note: ' },
  'db.connSqliteTip': {
    zh: '💡 {label}系统内置零编译原生 SQLite 引擎。可直接连接项目已有的 SQLite 数据库文件，无需启动任何后台数据库服务。',
    en: '💡 {label}Built-in, zero-compilation native SQLite engine. Connect straight to an existing SQLite file in the project — no background database service needed.',
  },
  'db.connHostLabel': { zh: '主机 (Host)', en: 'Host' },
  'db.connHostPlaceholder': { zh: '127.0.0.1 或 192.168.x.x', en: '127.0.0.1 or 192.168.x.x' },
  'db.connPortLabel': { zh: '端口 (Port)', en: 'Port' },
  'db.connDatabaseLabel': { zh: '数据库名 (Database)', en: 'Database' },
  'db.connDatabasePlaceholder': { zh: '例如: tsingtec 或 test', en: 'e.g. tsingtec or test' },
  'db.connUsernameLabel': { zh: '用户名 (Username)', en: 'Username' },
  'db.connPasswordLabel': { zh: '密码 (Password)', en: 'Password' },
  'db.connPasswordSavedPlaceholder': {
    zh: '已保存，留空则保持不变',
    en: 'Saved — leave empty to keep it',
  },
  /**
   * 保存位置提示。整段话被 `<code>` 路径与 `<strong>` 强调切开，所以拆成三段、
   * 强调片段各自成 key —— 中英文里路径与强调出现的位置/数量可能不同，
   * 拼字符串只能二选一地出错。
   */
  'db.connPrivacyLead': {
    zh: '🔐 连接信息（含密码）会与当前项目绑定保存到本机的 ',
    en: '🔐 Connection info (including the password) is saved with the current project on this machine under ',
  },
  'db.connPrivacyMid': { zh: ' 下，', en: '; ' },
  'db.connPrivacyKeep': {
    zh: '不会写入项目目录',
    en: 'it is never written into the project directory',
  },
  'db.connPrivacyTail': {
    zh: '，因此也不会被提交到版本库。',
    en: ', so it is never committed to version control.',
  },
  'db.connSelectFileFailed': { zh: '选择文件失败', en: 'Failed to select the file' },
  'db.connDemoReady': { zh: 'Demo 数据库已就绪', en: 'Demo database is ready' },
  'db.connDemoCreateFailed': {
    zh: '创建 Demo 数据库失败',
    en: 'Failed to create the demo database',
  },
  'db.connOperationFailed': { zh: '操作异常', en: 'Unexpected error' },
  'db.connFormInvalid': { zh: '表单校验未通过', en: 'The form did not pass validation' },
  // `validateDbConnection` 返回的是**原因码**（见 services/dbConnectionForm 的 DB_FORM_ERROR_KEY
  // 与 DB_FORM_ERROR_KEY 表），不是文案 —— 那是个纯逻辑模块，拿不到 i18n 上下文。
  'db.formErrSqlitePath': {
    zh: '请指定 SQLite 数据库文件路径',
    en: 'Please specify the SQLite database file path',
  },
  'db.formErrHost': {
    zh: '请填写 {driver} 主机地址',
    en: 'Please enter the {driver} host address',
  },
  'db.formErrPortNumber': {
    zh: '端口必须是数字（留空则使用默认端口）',
    en: 'The port must be a number (leave it empty to use the default port)',
  },
  'db.formErrPortRange': {
    zh: '端口取值范围为 1 - 65535',
    en: 'The port must be between 1 and 65535',
  },
  'db.formErrUsername': { zh: '请填写用户名', en: 'Please enter a username' },
  'db.formErrDatabase': {
    zh: 'PostgreSQL 必须指定数据库名（Database）',
    en: 'PostgreSQL requires a database name',
  },
  'db.connTestSuccess': { zh: '{driver} 连接测试成功', en: '{driver} connection test succeeded' },
  'db.connTestFailed': { zh: '{driver} 连接失败', en: '{driver} connection failed' },
  'db.connDefaultName': { zh: 'Test {driver}', en: 'Test {driver}' },
  'db.connSaveFailed': { zh: '保存连接配置失败', en: 'Failed to save the connection settings' },
  'db.connSavedConnected': { zh: '数据库「{name}」已连接', en: 'Database “{name}” connected' },
  'db.connFailedSettingsSaved': {
    zh: '连接失败（配置已保存到项目）',
    en: 'Connection failed (the settings were saved to the project)',
  },
  'db.connTest': { zh: '测试连接 (Test)', en: 'Test connection' },
  'db.connTesting': { zh: '测试中...', en: 'Testing…' },
  'db.connConnecting': { zh: '连接中...', en: 'Connecting…' },
  'db.connSaveAndConnect': { zh: '保存并连接', en: 'Save and connect' },
  'db.connConnect': { zh: '确定连接', en: 'Connect' },

  // SQL 控制台（DbConsoleView）
  'db.sqlConnectFailedTo': { zh: '连接「{name}」失败', en: 'Failed to connect to “{name}”' },
  'db.sqlNeedSql': { zh: '请输入要执行的 SQL 语句', en: 'Enter a SQL statement to run' },
  'db.sqlNoExecutable': { zh: '没有可执行的 SQL 语句', en: 'No runnable SQL statement' },
  'db.sqlDoneStatements': {
    zh: '执行完成：{n} 条语句 · {ms}ms',
    en: 'Done: {n} statements · {ms}ms',
  },
  'db.sqlDonePlain': { zh: '执行完成 ({ms}ms)', en: 'Done ({ms}ms)' },
  'db.sqlDoneMixed': {
    zh: '执行完成：{ok} 条成功 / {fail} 条失败',
    en: 'Done: {ok} succeeded / {fail} failed',
  },
  'db.sqlExecException': { zh: '执行异常', en: 'Execution error' },
  'db.sqlEmptyCannotFavorite': {
    zh: '当前编辑器为空，无法收藏',
    en: 'The editor is empty — nothing to save',
  },
  'db.sqlFavoritePrompt': { zh: '收藏这条 SQL', en: 'Save this SQL' },
  'db.sqlFavoriteIntro': {
    zh: '把下面这条语句存进常用收藏夹，之后可一键填回编辑器。',
    en: 'Save the statement below to your favorites — you can drop it back into the editor anytime.',
  },
  'db.sqlFavoriteNameLabel': { zh: '收藏名称', en: 'Favorite name' },
  'db.sqlFavoriteSave': { zh: '收藏', en: 'Save' },
  'db.sqlFavorited': { zh: '已加入常用 SQL 收藏夹', en: 'Added to the SQL favorites' },
  'db.sqlHistoryCleared': { zh: '已清空 SQL 执行历史', en: 'SQL run history cleared' },
  'db.sqlFilledEditor': { zh: '已填入 SQL 编辑器', en: 'Inserted into the SQL editor' },
  'db.sqlFormatted': { zh: 'SQL 语句已格式化', en: 'SQL statement formatted' },
  'db.sqlFormatFailed': { zh: '格式化失败', en: 'Formatting failed' },
  'db.sqlRunSelectionTitle': {
    zh: '执行光标所在语句或选中内容 (Cmd+Enter)',
    en: 'Run the statement at the cursor or the selection (Cmd+Enter)',
  },
  'db.sqlRun': { zh: '运行', en: 'Run' },
  'db.sqlRunning': { zh: '执行中', en: 'Running' },
  'db.sqlRunAllTitle': {
    zh: '按分号切分执行全部语句 (Cmd+Shift+Enter)',
    en: 'Split on semicolons and run every statement (Cmd+Shift+Enter)',
  },
  'db.sqlAll': { zh: '全部', en: 'All' },
  'db.sqlFormatTitle': { zh: '美化/格式化 SQL 语句', en: 'Beautify / format the SQL statement' },
  'db.sqlFavoriteTitle': { zh: '收藏当前 SQL 语句', en: 'Save the current SQL as a favorite' },
  'db.sqlFavoritesDrawerTitle': {
    zh: '常用 SQL 收藏夹 ({n})',
    en: 'SQL favorites ({n})',
  },
  'db.sqlHistoryDrawerTitle': { zh: 'SQL 执行历史记录 ({n})', en: 'SQL run history ({n})' },
  'db.sqlSwitchConnTitle': {
    zh: '切换执行本控制台的连接（未连接的会在选中的同时自动连上）',
    en: 'Switch the connection this console runs on (picking a disconnected one connects it right away)',
  },
  'db.sqlSwitchSchemaTitle': {
    zh: '切换本控制台执行时打在哪个库 / Schema（只改执行目标，不影响这个标签里的 SQL）',
    en: 'Switch which database / schema this console runs against (only the target changes, not the SQL in this tab)',
  },
  'db.sqlSuccessStatus': { zh: '✓ 成功 ({ms}ms) · {detail}', en: '✓ OK ({ms}ms) · {detail}' },
  'db.sqlRowsAffected': { zh: '{n} 行受影响', en: '{n} rows affected' },
  'db.sqlRecordCount': { zh: '{n} 条记录', en: '{n} records' },
  'db.sqlErrorStatus': { zh: '✕ 错误: {error}', en: '✕ Error: {error}' },
  'db.sqlHistoryPanelTitle': { zh: '🕒 SQL 执行历史', en: '🕒 SQL run history' },
  'db.sqlClearHistory': { zh: '清空历史', en: 'Clear history' },
  'db.sqlHistorySearchPlaceholder': { zh: '搜索历史 SQL...', en: 'Search SQL history…' },
  'db.sqlNoHistory': { zh: '暂无历史执行记录', en: 'No run history yet' },
  'db.sqlRunOk': { zh: '✓ 执行成功', en: '✓ Succeeded' },
  'db.sqlRunFail': { zh: '✕ 执行失败', en: '✕ Failed' },
  'db.sqlFill': { zh: '填入', en: 'Insert' },
  'db.sqlAppend': { zh: '追加', en: 'Append' },
  'db.sqlFavoritesPanelTitle': { zh: '⭐ 常用 SQL 收藏夹', en: '⭐ SQL favorites' },
  'db.sqlFavoritesSearchPlaceholder': { zh: '搜索收藏 SQL...', en: 'Search favorite SQL…' },
  'db.sqlNoFavorites': {
    zh: '暂无收藏项（点击工具栏书签图标收藏当前 SQL）',
    en: 'No favorites yet (use the bookmark icon in the toolbar to save the current SQL)',
  },
  'db.sqlDeleteFavorite': { zh: '删除收藏', en: 'Delete favorite' },
  'db.sqlRunLog': { zh: '语句执行日志 ({n})：', en: 'Statement log ({n}):' },
  'db.sqlRunLogOk': { zh: '成功 · {ms}ms', en: 'Succeeded · {ms}ms' },
  'db.sqlRunLogFail': { zh: '失败 · {error}', en: 'Failed · {error}' },
  'db.sqlOkNoRows': {
    zh: '语句执行成功，本页无数据行',
    en: 'Statement succeeded; this page has no data rows',
  },
  'db.sqlOkNoResultSet': {
    zh: '语句执行成功，无返回行数据集',
    en: 'Statement succeeded; no row set was returned',
  },
  'db.sqlExecError': { zh: '执行错误: {error}', en: 'Execution error: {error}' },
  'db.sqlWriteAndRun': {
    zh: '编写 SQL 并点击「运行」或按下 Cmd+Enter 执行查询',
    en: 'Write SQL and click “Run” or press Cmd+Enter to execute the query',
  },

  // 表数据视图（DbTableDataView）
  'db.dataLoadFailed': { zh: '加载表数据失败: {error}', en: 'Failed to load table data: {error}' },
  'db.dataQueryException': { zh: '查询异常', en: 'Query error' },
  'db.dataNothingToExport': { zh: '当前无数据可导出', en: 'There is no data to export' },
  'db.dataExportedCsv': { zh: '已导出 CSV: {name}', en: 'Exported CSV: {name}' },
  'db.dataExportedJson': { zh: '已导出 JSON: {name}', en: 'Exported JSON: {name}' },
  'db.dataExportedExcel': { zh: '已导出 Excel: {name}', en: 'Exported Excel: {name}' },
  'db.dataNoPkTitle': { zh: '该表无主键', en: 'This table has no primary key' },
  'db.dataNoPkDeleteDetail': {
    zh: '无法唯一定位一行，因此不支持删除。可改用 SQL 控制台手动操作。',
    en: 'A single row cannot be identified, so deleting is not supported. Use the SQL console instead.',
  },
  'db.dataCannotBuildSql': { zh: '无法生成 SQL', en: 'Could not build the SQL' },
  // 提交前汇总失败的原因（代码在 services/dbMutations.ts 的 DB_COMMIT_ERROR_KEY）
  'db.commitErrNoPk': {
    zh: '该表没有主键，无法唯一定位一行，因此不支持修改或删除已有数据。可新增行，或用 SQL 控制台手动操作。',
    en: 'This table has no primary key, so a single row cannot be identified — editing or deleting existing rows is unsupported. You can add rows, or use the SQL console.',
  },
  'db.commitErrDeleteRowMissing': {
    zh: '找不到待删除行的原始数据（{rowKey}），请刷新后重试',
    en: 'The original data for the row to delete was not found ({rowKey}) — refresh and try again',
  },
  'db.commitErrDeleteSql': {
    zh: '生成删除语句失败：无法构造主键条件',
    en: 'Could not build the DELETE statement: no primary-key condition could be constructed',
  },
  'db.commitErrUpdateRowMissing': {
    zh: '找不到待修改行的原始数据（{rowKey}），请刷新后重试',
    en: 'The original data for the row to update was not found ({rowKey}) — refresh and try again',
  },
  'db.commitErrNothing': { zh: '没有可提交的改动', en: 'There is nothing to commit' },
  // 新增行缺必填列。列名列表由渲染层用 listSeparator 连接，不在这里拼
  'db.errInsertMissingRequired': {
    zh: '新增行缺少必填列：{columns}（这些列不允许为空且没有默认值）',
    en: 'New row is missing required columns: {columns} (these columns cannot be empty and have no default)',
  },
  /** 连接一列名单时的分隔符（中文顿号，英文逗号加空格） */
  'db.listSeparator': { zh: '、', en: ', ' },
  'db.dataCommitted': { zh: '已提交 {n} 项改动', en: 'Committed {n} changes' },
  'db.dataCommitAffected': { zh: '影响 {n} 条语句', en: '{n} statements affected' },
  'db.dataCommitFailedRolledBack': {
    zh: '提交失败，已整体回滚',
    en: 'Commit failed; everything was rolled back',
  },
  'db.dataRollbackFailed': { zh: '回滚未成功', en: 'Rollback did not succeed' },
  'db.dataRollbackFailedDetail': {
    zh: '数据可能处于半改状态，请刷新后核对数据再重试。',
    en: 'The data may be half-updated — refresh, check it, and try again.',
  },
  'db.dataCommitException': { zh: '提交异常', en: 'Commit error' },
  'db.dataPkReadOnly': {
    zh: '主键列不可直接编辑，请用 SQL 控制台修改',
    en: 'Primary key columns are not editable here — use the SQL console',
  },
  'db.dataNoPkReadOnly': {
    zh: '该表无主键，不支持修改已有数据',
    en: 'This table has no primary key, so existing rows cannot be edited',
  },
  'db.dataEditHint': {
    zh: '双击编辑 · 单击复制{type}',
    en: 'Double-click to edit · click to copy{type}',
  },
  'db.dataDefaultHint': { zh: '默认 {value}', en: 'Default {value}' },
  'db.dataColumnCount': { zh: '{n} 列', en: '{n} columns' },
  'db.dataNoPkBadge': { zh: '无主键', en: 'No PK' },
  'db.dataNoPkBadgeTitle': {
    zh: '没有主键就无法唯一定位一行',
    en: 'Without a primary key a single row cannot be identified',
  },
  'db.dataInPageSearchPlaceholder': {
    zh: '页内搜索（仅过滤本页已加载的行）',
    en: 'Search this page (filters only the rows already loaded here)',
  },
  'db.dataAddRowTitle': {
    zh: '新增一行（暂存，提交后写库）',
    en: 'Add a row (staged; written on commit)',
  },
  'db.dataAddRowNoPkTitle': {
    zh: '新增一行（该表无主键，仅支持新增）',
    en: 'Add a row (this table has no primary key, so adding is all that is supported)',
  },
  'db.dataDeleteRowTitle': {
    zh: '删除选中的行（先点行号选中）',
    en: 'Delete the selected row (click a row number first)',
  },
  'db.dataDeleteRowNoPkTitle': {
    zh: '该表无主键，不支持删除',
    en: 'This table has no primary key, so deleting is not supported',
  },
  'db.dataRevertAllTitle': { zh: '撤销全部未提交的改动', en: 'Revert every uncommitted change' },
  'db.dataRevertCount': { zh: '撤销 {n} 项', en: 'Revert {n}' },
  'db.dataGenerateSqlTitle': {
    zh: '把暂存改动生成 SQL 并在控制台打开（可先核对再执行）',
    en: 'Turn the staged changes into SQL and open it in the console (review before running)',
  },
  'db.dataGenerateSql': { zh: '生成 SQL', en: 'Generate SQL' },
  'db.dataCommitTitle': {
    zh: '在一个事务里提交全部暂存改动，失败整体回滚',
    en: 'Commit every staged change in one transaction; the whole thing rolls back on failure',
  },
  'db.dataCannotCommit': { zh: '无法提交', en: 'Could not commit' },
  'db.dataCommitIntro': {
    zh: '即将提交 **{n}** 项改动，共 {m} 条语句。',
    en: 'About to commit **{n}** changes across {m} statements.',
  },
  'db.dataCommitNote': {
    zh: '这些语句会在**同一个事务**里执行，任一失败则整体回滚。',
    en: 'These statements run in **one transaction**; if any fails, everything rolls back.',
  },
  'db.dataCommitting': { zh: '提交中…', en: 'Committing…' },
  'db.dataCommitCount': { zh: '提交 {n} 项改动', en: 'Commit {n} changes' },
  'db.dataRefreshTitle': { zh: '刷新数据', en: 'Refresh data' },
  'db.dataOpenInConsoleTitle': { zh: '在 SQL 查询控制台中打开', en: 'Open in the SQL console' },
  'db.dataExportCsvTitle': { zh: '导出当前结果为 CSV', en: 'Export the current result as CSV' },
  'db.dataExportJsonTitle': { zh: '导出当前结果为 JSON', en: 'Export the current result as JSON' },
  'db.dataExportExcelTitle': {
    zh: '导出当前结果为 Excel (.xls)',
    en: 'Export the current result as Excel (.xls)',
  },
  'db.dataPickColumnsTitle': { zh: '选择要显示哪些字段', en: 'Choose which columns to show' },
  'db.dataPrevPage': { zh: '上一页', en: 'Previous page' },
  'db.dataNextPage': { zh: '下一页', en: 'Next page' },
  'db.dataNoPkBanner': {
    zh: '该表没有主键，无法唯一定位一行 —— 仅支持新增行；修改 / 删除请使用 SQL 控制台。',
    en: 'This table has no primary key, so a single row cannot be identified — only adding rows is supported; use the SQL console to update or delete.',
  },
  'db.dataLoading': { zh: '加载数据中...', en: 'Loading data…' },
  'db.dataPkDotTitle': { zh: '主键', en: 'Primary key' },
  'db.dataFilterDotTitle': { zh: '已设置筛选条件', en: 'A filter is set' },
  'db.dataColMenuTitle': { zh: '排序或筛选本字段', en: 'Sort or filter this column' },
  'db.dataResizerTitle': {
    zh: '拖动调整列宽 · 双击恢复默认',
    en: 'Drag to resize · double-click to reset',
  },
  'db.dataUndoInsertRowTitle': { zh: '撤销这一新增行', en: 'Undo this new row' },
  'db.dataSelectRowTitle': {
    zh: '点击选中该行 · 右键更多操作',
    en: 'Click to select this row · right-click for more actions',
  },
  'db.dataEmptyTable': { zh: '当前表中无数据记录', en: 'This table has no rows' },
  'db.dataNoSearchHit': {
    zh: '本页没有符合页内搜索的行（页内搜索只作用于已加载的这一页）',
    en: 'No rows on this page match the search (in-page search only covers the loaded page)',
  },
  'db.dataNoFilterHit': { zh: '没有符合筛选条件的数据', en: 'No rows match the filter' },
  'db.dataPageStatus': { zh: '第 {page} 页 · 本页 {n} 行', en: 'Page {page} · {n} rows' },
  'db.dataSearchHits': { zh: '页内搜索命中 {n} 行', en: '{n} rows match the in-page search' },
  'db.dataModifiedRows': { zh: '已修改 {n} 行', en: '{n} rows modified' },
  'db.dataNewRowsSuffix': { zh: ' · 新增 {n} 行', en: ' · {n} added' },
  'db.dataFooterHint': {
    zh: '双击单元格编辑 · 单击复制 · 行号右键更多操作',
    en: 'Double-click a cell to edit · click to copy · right-click a row number for more',
  },
  'db.dataConfirmSubmitTitle': { zh: '提交 {n} 项改动', en: 'Commit {n} changes' },
  'db.dataConfirmSubmit': { zh: '确认提交', en: 'Commit' },
  'db.dataRowCancelDelete': { zh: '取消删除此行', en: 'Undo delete this row' },
  'db.dataRowDelete': { zh: '删除此行（暂存）', en: 'Delete this row (staged)' },
  'db.dataRowCopyInsert': { zh: '复制为 INSERT', en: 'Copy as INSERT' },
  'db.dataRowCopyUpdate': { zh: '复制为 UPDATE', en: 'Copy as UPDATE' },
  'db.dataRowCopyWhere': { zh: '复制主键 WHERE', en: 'Copy primary-key WHERE' },
  'db.dataRowCopyDelete': { zh: '复制为 DELETE', en: 'Copy as DELETE' },
  'db.dataCannotBuildUpdate': { zh: '无法生成 UPDATE', en: 'Could not build the UPDATE' },
  'db.dataCannotBuildUpdateDetail': {
    zh: '该表没有主键，无法定位行',
    en: 'This table has no primary key, so the row cannot be located',
  },
  'db.dataCannotBuildWhere': { zh: '无法生成 WHERE', en: 'Could not build the WHERE' },
  'db.dataCannotBuildWhereDetail': { zh: '该表没有主键', en: 'This table has no primary key' },
  'db.dataCopiedInsert': { zh: 'INSERT 语句', en: 'INSERT statement' },
  'db.dataCopiedUpdate': { zh: 'UPDATE 语句', en: 'UPDATE statement' },
  'db.dataCopiedWhere': { zh: 'WHERE 片段', en: 'WHERE fragment' },
  'db.dataCopiedDelete': { zh: 'DELETE 语句', en: 'DELETE statement' },
};

/**
 * `Translate` 的结构化别名。
 *
 * 刻意从 `../i18n` **不做 import**（哪怕只是类型）：本文件会被 `i18n.ts` 反向引入，
 * 用 `import type` 虽然编译后会被抹掉，但把一个循环依赖留在字典层没有任何收益。
 */
type DbTranslate = (key: string, params?: Record<string, string | number>) => string;

/** 筛选运算符 → 文案 key。运算符枚举见 `services/dbTableQuery` 的 `FILTER_OPERATORS`。 */
const FILTER_OPERATOR_KEY: Record<string, string> = {
  eq: 'db.op.eq',
  ne: 'db.op.ne',
  gt: 'db.op.gt',
  gte: 'db.op.gte',
  lt: 'db.op.lt',
  lte: 'db.op.lte',
  contains: 'db.op.contains',
  notContains: 'db.op.notContains',
  startsWith: 'db.op.startsWith',
  endsWith: 'db.op.endsWith',
  isNull: 'db.op.isNull',
  isNotNull: 'db.op.isNotNull',
};

/**
 * 取筛选运算符的显示名。
 *
 * 运算符名原本由 `services/dbTableQuery` 的一张「运算符 → 中文名」表给出，那张表写死中文、
 * 英文环境下会原样显示中文，已删除。渲染点改为按运算符值取文案；
 * 遇到字典里没有的运算符原样返回它的值 —— 露出 `op` 本身好过显示一个空白的菜单项。
 */
export function dbOperatorLabel(t: DbTranslate, operator: string): string {
  return t(FILTER_OPERATOR_KEY[operator] ?? operator);
}

/**
 * 筛选条件的可读描述（如 `age 大于 30`）。
 *
 * 服务层原先有一份 `describeFilter`，但运算符名写死成中文，英文环境下会原样显示中文，
 * 已删除 —— 这里按同样的规则重算一遍：**列名与值原样保留**（它们是数据库里的真实标识），
 * 只有运算符名走字典。`NULL` 也是 SQL 关键字，同样不进字典。
 */
export function dbDescribeFilter(
  t: DbTranslate,
  condition: { column: string; operator: string; value?: unknown },
  columnType?: string,
): string {
  const label = dbOperatorLabel(t, condition.operator);
  if (condition.operator === 'isNull' || condition.operator === 'isNotNull') {
    return `${condition.column} ${label}`;
  }
  const value = condition.value;
  if (value === null || value === undefined) return `${condition.column} ${label} NULL`;
  const type = (columnType || '').toUpperCase();
  const numericType = /INT|DEC|NUM|REAL|FLOAT|DOUBLE|MONEY|SERIAL/.test(type);
  if (typeof value === 'number' || (numericType && /^-?\d+(\.\d+)?$/.test(String(value)))) {
    return `${condition.column} ${label} ${value}`;
  }
  return `${condition.column} ${label} "${String(value)}"`;
}

/** 排序的可读描述（如 `age 降序`） */
export function dbDescribeSort(
  t: DbTranslate,
  sort: { column: string; direction: 'asc' | 'desc' },
): string {
  return `${sort.column} ${t(sort.direction === 'desc' ? 'db.sortDescWord' : 'db.sortAscWord')}`;
}

/**
 * 库层级在该驱动里的称呼（PostgreSQL 叫 Schema，其余叫数据库）。
 *
 * `services/dbDdl` 里曾有一份同名同义的实现，返回写死的中文；渲染层改为走这里之后
 * 它就没人调了，已删除。这里是**唯一**的一份，返回的是**已翻译好的名词**，
 * 调用方把它当作 `{noun}` 传给 `db.menuNewDatabase` 这类整句 key ——
 * 句子的语序仍由字典决定，不要在这里拼句子。
 */
export function dbLevelNoun(t: DbTranslate, driver: string): string {
  return t(driver === 'postgres' ? 'db.noun.schema' : 'db.noun.database');
}

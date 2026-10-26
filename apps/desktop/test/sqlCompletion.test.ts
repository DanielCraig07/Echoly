import { describe, expect, it, beforeEach, vi } from 'vitest';

vi.mock('monaco-editor', () => ({
  languages: {
    CompletionItemKind: {
      Class: 5,
      Field: 3,
      Module: 8,
      Keyword: 17,
    },
  },
  Position: class Position {
    constructor(public lineNumber: number, public column: number) {}
  },
}));

import * as monaco from 'monaco-editor';
import { translate, translateWith, type Translate } from '../src/renderer/src/i18n';
import {
  provideSqlCompletions,
  getOrFetchSchemas,
  getOrFetchTables,
  getOrFetchColumns,
  invalidateSqlMetadataCache,
  SqlMetadataProvider,
} from '../src/renderer/src/services/sqlCompletionService';

// 补全项的 detail / documentation 会直接显示在 Monaco 的补全列表里（过去的断言
// 就钉在中文字面上），所以服务层现在必须收一个 t。测试自己带一份 zh 的 t，
// 顺带把「key → 字典条目」这条链走通：拼错 key 会在这里失败。
const zhT: Translate = (key, params) =>
  params ? translateWith(key, 'zh', params) : translate(key, 'zh');

describe('sqlCompletionService 智能补全', () => {
  beforeEach(() => {
    if (typeof window === 'undefined') {
      (globalThis as any).window = globalThis;
    }
    invalidateSqlMetadataCache();
    // 模拟全局 window.ide 接口
    (window as any).ide = {
      dbListSchemas: vi.fn().mockResolvedValue({
        ok: true,
        schemas: [
          { name: 'cvm', kind: 'database' },
          { name: 'crm_system', kind: 'database' },
        ],
      }),
      dbListTables: vi.fn().mockImplementation((_connId: string, schema?: string) => {
        if (schema === 'cvm') {
          return Promise.resolve({
            ok: true,
            tables: [
              { name: 'filter_monitor', kind: 'table', comment: '监控表' },
              { name: 'server_instances', kind: 'table', comment: '服务器实例' },
            ],
          });
        }
        return Promise.resolve({
          ok: true,
          tables: [
            { name: 'users', kind: 'table', comment: '用户表' },
            { name: 'orders', kind: 'table', comment: '订单表' },
          ],
        });
      }),
      dbGetTableSchema: vi.fn().mockImplementation((_connId: string, tableName: string) => {
        if (tableName === 'filter_monitor') {
          return Promise.resolve({
            ok: true,
            columns: [
              { cid: 0, name: 'id', type: 'bigint', notnull: true, pk: true, dflt_value: null, comment: '主键' },
              { cid: 1, name: 'monitor_name', type: 'varchar(128)', notnull: true, pk: false, dflt_value: '', comment: '监控项名称' },
              { cid: 2, name: 'status', type: 'int', notnull: false, pk: false, dflt_value: 0, comment: '状态' },
            ],
          });
        }
        return Promise.resolve({
          ok: true,
          columns: [
            { cid: 0, name: 'id', type: 'int', notnull: true, pk: true, dflt_value: null },
            { cid: 1, name: 'username', type: 'varchar(64)', notnull: true, pk: false, dflt_value: null },
          ],
        });
      }),
    };
  });

  const mockProvider: SqlMetadataProvider = {
    getConnectionId: () => 'conn_1',
    getSchemaName: () => 'cvm',
  };

  it('获取并缓存 schemas、tables、columns', async () => {
    const schemas = await getOrFetchSchemas('conn_1');
    expect(schemas).toHaveLength(2);
    expect(schemas[0].name).toBe('cvm');

    const tables = await getOrFetchTables('conn_1', 'cvm');
    expect(tables).toHaveLength(2);
    expect(tables[0].name).toBe('filter_monitor');

    const cols = await getOrFetchColumns('conn_1', 'cvm', 'filter_monitor');
    expect(cols).toHaveLength(3);
    expect(cols[0].name).toBe('id');
    expect(cols[0].pk).toBe(true);
  });

  it('当输入类似 "select * from cvm."（库名.）时，提示该库下的所有数据表', async () => {
    const line = 'select * from cvm.';
    const model = {
      getLineContent: () => line,
      getValue: () => line,
      getWordUntilPosition: () => ({ word: '', startColumn: line.length + 1, endColumn: line.length + 1 }),
    } as any;

    const position = new monaco.Position(1, line.length + 1);
    const result = await provideSqlCompletions(model, position, mockProvider, zhT);

    expect(result.suggestions.length).toBeGreaterThanOrEqual(2);
    const labels = result.suggestions.map((s) => s.label);
    expect(labels).toContain('filter_monitor');
    expect(labels).toContain('server_instances');
  });

  it('当输入类似 "select * from filter_monitor fm where fm."（别名.）时，提示该表的字段清单', async () => {
    const sql = 'select * from filter_monitor fm where fm.';
    const model = {
      getLineContent: () => sql,
      getValue: () => sql,
      getWordUntilPosition: () => ({ word: '', startColumn: sql.length + 1, endColumn: sql.length + 1 }),
    } as any;

    const position = new monaco.Position(1, sql.length + 1);
    const result = await provideSqlCompletions(model, position, mockProvider, zhT);

    expect(result.suggestions.length).toBeGreaterThanOrEqual(3);
    const labels = result.suggestions.map((s) => s.label);
    expect(labels).toContain('id');
    expect(labels).toContain('monitor_name');
    expect(labels).toContain('status');

    // 补全列表里 label 右边那行说明也要跟着语言走：只断言 label 的话，
    // detail / documentation 里残留的中文（英文环境下照贴）永远测不出来
    const idItem = result.suggestions.find((s) => s.label === 'id')!;
    expect(idItem.detail).toContain(zhT('db.compFieldOf', { table: 'filter_monitor' }));
    expect(String(idItem.documentation)).toContain(zhT('db.compDocColumn'));
  });

  it('未输入点号时，同时提示当前库的表、连接下的库以及 SQL 关键字', async () => {
    const sql = 'sel';
    const model = {
      getLineContent: () => sql,
      getValue: () => sql,
      getWordUntilPosition: () => ({ word: 'sel', startColumn: 1, endColumn: 4 }),
    } as any;

    const position = new monaco.Position(1, 4);
    const result = await provideSqlCompletions(model, position, mockProvider, zhT);

    const labels = result.suggestions.map((s) => s.label);
    expect(labels).toContain('filter_monitor');
    expect(labels).toContain('cvm');
    expect(labels).toContain('SELECT');
  });

  it('当输入多段点号类似 "select * from cvm.filter_monitor." 时，精准提示该库该表的字段', async () => {
    const sql = 'select * from cvm.filter_monitor.';
    const model = {
      getLineContent: () => sql,
      getValue: () => sql,
      getOffsetAt: () => sql.length,
      getWordUntilPosition: () => ({ word: '', startColumn: sql.length + 1, endColumn: sql.length + 1 }),
    } as any;

    const position = new monaco.Position(1, sql.length + 1);
    const result = await provideSqlCompletions(model, position, mockProvider, zhT);

    const labels = result.suggestions.map((s) => s.label);
    expect(labels).toContain('id');
    expect(labels).toContain('monitor_name');
    expect(labels).toContain('status');
  });

  it('上下文感知：在 WHERE 子句输入时，优先推荐关联表（如 cvm.filter_monitor）的字段', async () => {
    const sql = 'select * from cvm.filter_monitor where m';
    const model = {
      getLineContent: () => sql,
      getValue: () => sql,
      getOffsetAt: () => sql.length,
      getWordUntilPosition: () => ({ word: 'm', startColumn: sql.length, endColumn: sql.length + 1 }),
    } as any;

    const position = new monaco.Position(1, sql.length + 1);
    const result = await provideSqlCompletions(model, position, mockProvider, zhT);

    // 字段的 sortText 应该以 0_ 开头（最高优先级）
    const monitorItem = result.suggestions.find((s) => s.label === 'monitor_name');
    expect(monitorItem).toBeDefined();
    expect(monitorItem?.sortText?.startsWith('0_')).toBe(true);
  });

  it('上下文感知：在 FROM/JOIN 子句后输入时，优先推荐数据表而非字段', async () => {
    const sql = 'select * from ';
    const model = {
      getLineContent: () => sql,
      getValue: () => sql,
      getOffsetAt: () => sql.length,
      getWordUntilPosition: () => ({ word: '', startColumn: sql.length + 1, endColumn: sql.length + 1 }),
    } as any;

    const position = new monaco.Position(1, sql.length + 1);
    const result = await provideSqlCompletions(model, position, mockProvider, zhT);

    // 表名的 sortText 应该以 0_ 开头（最高优先级）
    const tableItem = result.suggestions.find((s) => s.label === 'filter_monitor');
    expect(tableItem).toBeDefined();
    expect(tableItem?.sortText?.startsWith('0_')).toBe(true);
  });
});

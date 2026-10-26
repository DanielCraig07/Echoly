import { describe, expect, it } from 'vitest';
import {
  DB_FORM_ERROR_KEY,
  DEFAULT_PORTS,
  checkConnectionPreflight,
  resolvePort,
  validateDbConnection,
  type DbConnectionForm,
} from '../src/renderer/src/services/dbConnectionForm';
import { translate, translateWith, type Translate } from '../src/renderer/src/i18n';

// 校验现在回**原因码**而不是中文句子（纯逻辑模块没有 i18n 上下文），
// 文案由渲染层用 t(DB_FORM_ERROR_KEY[code]) 取。测试锁定中文断言，
// 顺便把「码 → key → 字典条目」这条链走通：key 写错或字典漏条目都会在这里失败。
const t: Translate = (key, params) =>
  params ? translateWith(key, 'zh', params) : translate(key, 'zh');

const errText = (res: {
  errorCode?: keyof typeof DB_FORM_ERROR_KEY;
  params?: Record<string, string>;
}) => t(DB_FORM_ERROR_KEY[res.errorCode!], res.params);

const baseForm: DbConnectionForm = {
  driver: 'mysql',
  sqlitePath: '',
  host: '127.0.0.1',
  port: '',
  database: '',
  username: 'root',
};

const form = (patch: Partial<DbConnectionForm> = {}): DbConnectionForm => ({
  ...baseForm,
  ...patch,
});

describe('resolvePort', () => {
  it('留空时按驱动取默认端口', () => {
    expect(resolvePort('mysql', '')).toBe(DEFAULT_PORTS.mysql);
    expect(resolvePort('postgres', '')).toBe(DEFAULT_PORTS.postgres);
    expect(resolvePort('mysql', '   ')).toBe(DEFAULT_PORTS.mysql);
  });

  it('用户输入优先于默认端口', () => {
    expect(resolvePort('mysql', '3307')).toBe(3307);
    expect(resolvePort('postgres', '15432')).toBe(15432);
    expect(resolvePort('mysql', ' 3307 ')).toBe(3307);
  });
});

describe('validateDbConnection', () => {
  it('MySQL：host 与用户名必填，端口可留空', () => {
    expect(validateDbConnection(form()).ok).toBe(true);
    expect(errText(validateDbConnection(form({ host: '' })))).toContain('主机');
    expect(errText(validateDbConnection(form({ username: '' })))).toContain('用户名');
  });

  it('端口必须为 1-65535 的整数', () => {
    expect(errText(validateDbConnection(form({ port: 'abc' })))).toContain('数字');
    expect(errText(validateDbConnection(form({ port: '0' })))).toContain('1 - 65535');
    expect(errText(validateDbConnection(form({ port: '65536' })))).toContain('1 - 65535');
    expect(validateDbConnection(form({ port: '3306' })).ok).toBe(true);
  });

  it('PostgreSQL：数据库名必填，端口可留空', () => {
    const pg = form({ driver: 'postgres', username: 'postgres' });
    expect(errText(validateDbConnection(pg))).toContain('数据库名');
    expect(validateDbConnection({ ...pg, database: 'cvm' }).ok).toBe(true);
  });

  it('SQLite：只校验文件路径', () => {
    const sqlite = form({ driver: 'sqlite' });
    expect(errText(validateDbConnection(sqlite))).toContain('SQLite');
    expect(validateDbConnection({ ...sqlite, sqlitePath: '/tmp/a.db' }).ok).toBe(true);
  });
});

describe('checkConnectionPreflight · 点击未连接节点的准入判断', () => {
  it('存了密码的连接直接重连（切工作区后「未连接」是正常状态）', () => {
    expect(
      checkConnectionPreflight({ type: 'mysql', passwordSaved: true, requiresPassword: false }),
    ).toEqual({ action: 'reconnect' });
  });

  it('没存密码的连接先让用户补密码，而不是拿空密码去撞鉴权错误', () => {
    expect(
      checkConnectionPreflight({ type: 'mysql', passwordSaved: false, requiresPassword: true })
        .action,
    ).toBe('prompt-password');
  });

  it('SQLite 不需要密码，直接重连（文件是否还在由主进程的 connect 给出中文错误）', () => {
    expect(checkConnectionPreflight({ type: 'sqlite' }).action).toBe('reconnect');
  });

  it('配置还没读到 / 状态不全时回落为 unknown，由调用方重拉列表', () => {
    expect(checkConnectionPreflight(undefined).action).toBe('unknown');
    expect(checkConnectionPreflight({ type: 'mysql' }).action).toBe('unknown');
  });
});

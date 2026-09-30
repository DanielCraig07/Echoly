import { describe, expect, it, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService, makeSavedId, connectionNeedsPassword, type DbWorkspaceIo } from '../src/main/db/databaseService';

/**
 * 指向真实临时目录的假工作区（与 databaseService.test.ts 同款，这里独立一份避免跨文件耦合）。
 *
 * 这个目录在真实运行时是用户主目录下的项目配置目录（`~/.echoly/projects/<哈希>/`），
 * 不是工作区 —— 连接配置已经不写进项目里了。
 */
function makeFakeWorkspace(root: string): DbWorkspaceIo {
  const abs = (rel: string) => path.join(root, ...rel.split('/'));
  return {
    async exists(rel) {
      return fs.existsSync(abs(rel));
    },
    async readFile(rel) {
      return fs.readFileSync(abs(rel), 'utf8');
    },
    async writeFile(rel, content) {
      fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
      fs.writeFileSync(abs(rel), content, 'utf8');
    },
    async mkdir(rel) {
      fs.mkdirSync(abs(rel), { recursive: true });
    },
  };
}

describe('makeSavedId · 稳定 id 派生', () => {
  it('同参数两次调用得到同一个 id', () => {
    const a = makeSavedId({ type: 'mysql', host: '127.0.0.1', port: 3306, database: 'demo' });
    const b = makeSavedId({ type: 'mysql', host: '127.0.0.1', port: 3306, database: 'demo' });
    expect(a).toBe(b);
    expect(a.startsWith('db_mysql_')).toBe(true);
  });

  it('host / port / database 任一变化都会改变 id', () => {
    const base = makeSavedId({ type: 'mysql', host: '127.0.0.1', port: 3306, database: 'demo' });
    expect(makeSavedId({ type: 'mysql', host: '10.0.0.2', port: 3306, database: 'demo' })).not.toBe(
      base,
    );
    expect(makeSavedId({ type: 'mysql', host: '127.0.0.1', port: 3307, database: 'demo' })).not.toBe(
      base,
    );
    expect(makeSavedId({ type: 'mysql', host: '127.0.0.1', port: 3306, database: 'other' })).not.toBe(
      base,
    );
  });

  it('sqlite 用文件路径派生，且同一路径的 / 与 \\ 视为同一个库', () => {
    const posix = makeSavedId({ type: 'sqlite', path: '/tmp/a/b.db' });
    const win = makeSavedId({ type: 'sqlite', path: 'C:\\tmp\\a\\b.db' });
    expect(posix.startsWith('db_sqlite_')).toBe(true);
    expect(posix).toBe(makeSavedId({ type: 'sqlite', path: '/tmp/a/b.db' }));
    expect(win).toBe(makeSavedId({ type: 'sqlite', path: 'C:/tmp/a/b.db' }));
    expect(posix).not.toBe(win);
  });

  it('缺省 type 时按 sqlite 处理，不会抛异常', () => {
    expect(() => makeSavedId({ path: '/tmp/x.db' })).not.toThrow();
    expect(makeSavedId({ path: '/tmp/x.db' })).toBe(makeSavedId({ type: 'sqlite', path: '/tmp/x.db' }));
  });
});

describe('connectionNeedsPassword · 判断点击能否直接重连', () => {
  it('SQLite 天然不需要密码', () => {
    expect(connectionNeedsPassword({ type: 'sqlite' })).toBe(false);
    expect(connectionNeedsPassword({ type: 'sqlite', password: '' })).toBe(false);
  });

  it('MySQL / PostgreSQL 没存密码时需要用户补', () => {
    expect(connectionNeedsPassword({ type: 'mysql' })).toBe(true);
    expect(connectionNeedsPassword({ type: 'postgres', password: '' })).toBe(true);
  });

  it('存了密码（密文或降级明文）都不需要再问', () => {
    expect(connectionNeedsPassword({ type: 'mysql', password: 'enc:v1:abc' })).toBe(false);
    expect(connectionNeedsPassword({ type: 'mysql', password: 'plain-pw' })).toBe(false);
  });
});

describe('连接配置文件的鲁棒性', () => {
  const root = path.join(os.tmpdir(), `echoly_db_saved_${Date.now()}`);
  fs.mkdirSync(root, { recursive: true });

  const cfgPath = path.join(root, 'db-connections.json');
  const writeRaw = (content: string) => {
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, content, 'utf8');
  };
  const service = () => new DatabaseService(() => makeFakeWorkspace(root));

  afterAll(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  });

  it('文件不存在时返回空列表', async () => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    expect(await service().loadSaved()).toEqual([]);
  });

  it('非法 JSON 返回空列表而不是抛异常', async () => {
    writeRaw('{ this is not json ');
    await expect(service().loadSaved()).resolves.toEqual([]);
  });

  it('顶层是 null / 数组 / 字符串时同样安全降级', async () => {
    writeRaw('null');
    expect(await service().loadSaved()).toEqual([]);
    writeRaw('[1,2,3]');
    expect(await service().loadSaved()).toEqual([]);
    writeRaw('"just a string"');
    expect(await service().loadSaved()).toEqual([]);
  });

  it('数组里混入缺关键字段的坏条目时只保留合法项', async () => {
    writeRaw(
      JSON.stringify({
        version: 1,
        connections: [
          { type: 'sqlite', path: '/tmp/ok.db', name: '合法' },
          { type: 'mysql' }, // 缺 host
          { type: 'unknown', host: 'x' }, // 未知驱动
          null,
          'nope',
          { type: 'postgres', host: '10.0.0.1', port: 5432, database: 'pg', name: 'PG' },
        ],
      }),
    );
    const list = await service().loadSaved();
    expect(list.map((c) => c.name)).toEqual(['合法', 'PG']);
    // 坏条目被丢弃，合法条目各自带上稳定 id
    expect(list[0].id).toBe(makeSavedId({ type: 'sqlite', path: '/tmp/ok.db' }));
    expect(list[1].port).toBe(5432);
  });

  it('中文连接名经序列化往返无损', async () => {
    fs.rmSync(cfgPath, { force: true });
    const svc = service();
    const saved = await svc.saveConnection({
      type: 'sqlite',
      name: '内网·测试库（中文名）',
      path: path.join(root, 'x.db'),
    });
    expect(saved.ok).toBe(true);

    const fresh = service();
    const list = await fresh.loadSaved();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('内网·测试库（中文名）');
    expect(list[0].path).toBe(path.join(root, 'x.db'));
  });

  it('配置目录里不会生成 .gitignore（配置已不在工作区，没有东西需要被忽略）', async () => {
    fs.rmSync(cfgPath, { force: true });
    await service().saveConnection({ type: 'sqlite', name: 'a', path: path.join(root, 'a.db') });
    expect(fs.existsSync(cfgPath)).toBe(true);
    // 老实现会在 .echoly/ 里写一份 .gitignore 挡住含密码的配置；配置搬走后这道防线没有意义了
    expect(fs.existsSync(path.join(root, '.gitignore'))).toBe(false);
  });

  it('未打开工作区时写入失败，但读列表安全返回空', async () => {
    const orphan = new DatabaseService(() => null);
    expect(await orphan.loadSaved()).toEqual([]);
    expect(await orphan.listConnections()).toEqual([]);
    const res = await orphan.saveConnection({ type: 'sqlite', name: 'x', path: '/tmp/x.db' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('工作区');
  });

  it('配置文件里的密码是可解回的密文（或降级明文），且明文不会以裸值出现', async () => {
    fs.rmSync(cfgPath, { force: true });
    const svc = service();
    await svc.saveConnection({
      type: 'mysql',
      name: '带密码',
      host: '10.0.0.9',
      port: 3306,
      database: 'demo',
      user: 'root',
      password: 'pw-123',
    });

    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const stored = raw.connections[0].password as string;
    expect(stored).toBeTruthy();
    // 加密可用 -> enc:v1: 密文（且不等于明文）；不支持加密的环境 -> 降级明文
    if (stored !== 'pw-123') {
      expect(stored.startsWith('enc:v1:')).toBe(true);
    }

    // connectSaved 会把密码解出来交给驱动：这里用 sqlite 之外的类型无法真连，
    // 改为断言「再次保存同一条时密码不会被二次加密」——二次加密会让原密码永久解不回。
    await svc.saveConnection({
      type: 'mysql',
      name: '带密码',
      host: '10.0.0.9',
      port: 3306,
      database: 'demo',
      user: 'root',
      // 不传 password：表示「保持已保存的密码不变」
    });
    const raw2 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    expect(raw2.connections).toHaveLength(1);
    expect(raw2.connections[0].password).toBe(stored);
  });
});

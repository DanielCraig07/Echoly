import { describe, expect, it, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService, type DbWorkspaceIo } from '../src/main/db/databaseService';

/**
 * 把 DatabaseService 的项目级 IO 指向一个真实临时目录。
 *
 * 这个目录在真实运行时**不是工作区**，而是用户主目录下的项目配置目录
 * （`~/.echoly/projects/<工作区哈希>/`）—— DatabaseService 拿到的是一组已经映射好的
 * 相对路径 IO，落点在哪由主进程决定。测试里用临时目录顶替即可。
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

describe('DatabaseService', () => {
  const service = new DatabaseService();
  const tmpDir = path.join(os.tmpdir(), `echoly_db_test_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const demoDbPath = path.join(tmpDir, 'test.db');

  let connId = '';

  afterAll(async () => {
    if (connId) {
      await service.disconnect(connId);
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('creates a demo SQLite database and connects automatically', async () => {
    const res = await service.createDemoDb(demoDbPath);
    expect(res.ok).toBe(true);
    expect(res.connection).toBeDefined();
    expect(res.connection.type).toBe('sqlite');
    connId = res.connection.id;
  });

  it('lists tables from the database', async () => {
    const res = await service.listTables(connId);
    expect(res.ok).toBe(true);
    const tableNames = res.tables.map((t) => t.name);
    expect(tableNames).toContain('users');
    expect(tableNames).toContain('orders');
    expect(tableNames).toContain('system_logs');
  });

  it('retrieves table schema metadata', async () => {
    const schema = await service.getTableSchema(connId, 'users');
    expect(schema.ok).toBe(true);
    expect(schema.columns.length).toBeGreaterThanOrEqual(4);
    const colNames = schema.columns.map((c) => c.name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('username');
    expect(colNames).toContain('email');
  });

  it('executes SELECT query and measures execution time', async () => {
    const queryRes = await service.query(connId, "SELECT * FROM users WHERE role = 'admin'");
    expect(queryRes.ok).toBe(true);
    expect(queryRes.rows.length).toBe(1);
    expect(queryRes.rows[0].username).toBe('alice');
    expect(queryRes.columns).toContain('username');
    expect(queryRes.executionTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('executes INSERT / UPDATE mutation statements and returns affectedRows', async () => {
    const insertRes = await service.query(
      connId,
      "INSERT INTO users (username, email, role) VALUES ('frank', 'frank@echoly.dev', 'intern')",
    );
    expect(insertRes.ok).toBe(true);
    expect(insertRes.affectedRows).toBe(1);

    const countRes = await service.query(connId, 'SELECT COUNT(*) as cnt FROM users');
    expect(countRes.rows[0].cnt).toBe(6);
  });

  it('retrieves accurate CREATE TABLE DDL statement', async () => {
    const ddlRes = await service.getTableDdl(connId, 'users');
    expect(ddlRes.ok).toBe(true);
    expect(ddlRes.ddl).toContain('CREATE TABLE');
    expect(ddlRes.ddl).toContain('users');
    expect(ddlRes.ddl).toContain('username');
  });

  it('lists SQLite attached databases as schemas (main)', async () => {
    const res = await service.listSchemas(connId);
    expect(res.ok).toBe(true);
    expect(res.schemas.map((s) => s.name)).toContain('main');
  });

  it('SQLite 的列元数据带 comment: null 且不抛错（SQLite 没有列注释概念，不编造）', async () => {
    const schema = await service.getTableSchema(connId, 'users');
    expect(schema.ok).toBe(true);
    expect(schema.columns.length).toBeGreaterThan(0);
    for (const c of schema.columns) {
      expect(c.comment).toBeNull();
    }
    // 悬浮卡片据此决定不渲染「说明」那一行
    const profile = schema.columns.find((c) => c.name === 'username');
    expect(profile).toBeDefined();
    expect(profile!.comment).toBeNull();
  });

  it('accepts an explicit schema argument on metadata queries', async () => {
    const tables = await service.listTables(connId, 'main');
    expect(tables.ok).toBe(true);
    expect(tables.tables.map((t) => t.name)).toContain('users');

    const schema = await service.getTableSchema(connId, 'users', 'main');
    expect(schema.ok).toBe(true);
    expect(schema.columns.map((c) => c.name)).toContain('username');

    const ddl = await service.getTableDdl(connId, 'users', 'main');
    expect(ddl.ok).toBe(true);
    expect(ddl.ddl).toContain('username');
  });

  it('still reports column names when the result set is empty', async () => {
    const res = await service.query(connId, 'SELECT * FROM users WHERE 1 = 0');
    expect(res.ok).toBe(true);
    expect(res.rows.length).toBe(0);
    expect(res.columns).toContain('username');
    expect(res.columns).toContain('email');
  });
});

describe('DatabaseService · 连接配置随项目持久化', () => {
  const projectRoot = path.join(os.tmpdir(), `echoly_db_project_${Date.now()}`);
  fs.mkdirSync(projectRoot, { recursive: true });
  const service = new DatabaseService(() => makeFakeWorkspace(projectRoot));
  const dbPath = path.join(projectRoot, 'app.db');

  let savedId = '';

  afterAll(async () => {
    await service.disconnectAll();
    try {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    } catch {}
  });

  it('保存的连接配置落到项目配置目录的 db-connections.json，且不再生成 .gitignore', async () => {
    const res = await service.saveConnection({
      type: 'sqlite',
      name: '项目内 SQLite',
      path: dbPath,
    });
    expect(res.ok).toBe(true);
    expect(res.connection?.id).toBeTruthy();
    savedId = res.connection!.id;

    const cfgPath = path.join(projectRoot, 'db-connections.json');
    expect(fs.existsSync(cfgPath)).toBe(true);

    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    expect(raw.version).toBe(1);
    expect(raw.connections).toHaveLength(1);
    expect(raw.connections[0].name).toBe('项目内 SQLite');
    expect(raw.connections[0].path).toBe(dbPath);

    // 配置已经不在工作区里了，.gitignore 这道防线随之取消：
    // 目录里不该再冒出 .gitignore（用户主目录下的文件没有被 git 扫到的可能）
    expect(fs.existsSync(path.join(projectRoot, '.gitignore'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.echoly'))).toBe(false);
  });

  it('密码不以明文落盘（safeStorage 可用时加密为 enc:v1:，不可用时降级明文）', async () => {
    const res = await service.saveConnection({
      type: 'mysql',
      name: '内网测试库',
      host: '192.168.10.241',
      port: 3306,
      database: 'tsingtec',
      user: 'root',
      password: 's3cr3t-p@ss',
    });
    expect(res.ok).toBe(true);

    const cfgPath = path.join(projectRoot, 'db-connections.json');
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const entry = raw.connections.find((c: any) => c.name === '内网测试库');
    expect(entry).toBeDefined();
    expect(entry.user).toBe('root');
    // 加密可用 -> enc:v1: 密文；环境不支持 -> 降级明文（与 settings.ts 的行为一致）
    const plain = entry.password === 's3cr3t-p@ss';
    const encrypted = String(entry.password).startsWith('enc:v1:');
    expect(plain || encrypted).toBe(true);
  });

  it('新的服务实例能读回同一条配置，且状态是「未连接」', async () => {
    const fresh = new DatabaseService(() => makeFakeWorkspace(projectRoot));
    const list = await fresh.listConnections();
    expect(list.length).toBeGreaterThanOrEqual(2);
    const sqliteCfg = list.find((c) => c.id === savedId);
    expect(sqliteCfg).toBeDefined();
    expect(sqliteCfg!.connected).toBe(false);
    expect(sqliteCfg!.name).toBe('项目内 SQLite');

    // 未连接的节点直接查库表应当得到引导性错误，而不是崩溃
    const schemas = await fresh.listSchemas('不存在的连接');
    expect(schemas.ok).toBe(false);
  });

  it('connectSaved 用保存的配置连上并落盘 savedId，列表随即标记为已连接', async () => {
    // 先造一个真实可连的 SQLite 库
    const creator = new DatabaseService(() => makeFakeWorkspace(projectRoot));
    await creator.createDemoDb(dbPath);

    const res = await service.connectSaved(savedId);
    expect(res.ok).toBe(true);
    expect(res.connection?.type).toBe('sqlite');

    const list = await service.listConnections();
    expect(list.find((c) => c.id === savedId)?.connected).toBe(true);

    const tables = await service.listTables(res.connection!.id);
    expect(tables.ok).toBe(true);
    expect(tables.tables.map((t) => t.name)).toContain('users');

    await service.disconnect(res.connection!.id);
  });

  it('用「项目配置 id」也能操作已连接的会话（连接树返回的是配置 id，不是运行时 id）', async () => {
    // 回归：dbListConnections 返回 cfg.id（db_sqlite_xxx），而会话表键是 sqlite_<ts>_<rand>。
    // 少了 id 回退，树会显示「已连接」却每个操作都报「未找到该数据库连接」。
    const fresh = new DatabaseService(() => makeFakeWorkspace(projectRoot));
    const res = await fresh.connectSaved(savedId);
    expect(res.ok).toBe(true);
    const runtimeId = res.connection!.id;
    expect(runtimeId).not.toBe(savedId); // 前提：两个 id 本来就不同

    const byConfigId = await fresh.listTables(savedId);
    expect(byConfigId.ok).toBe(true);
    expect(byConfigId.tables.map((t) => t.name)).toContain('users');

    const schemas = await fresh.listSchemas(savedId);
    expect(schemas.ok).toBe(true);

    const cols = await fresh.getTableSchema(savedId, 'users');
    expect(cols.ok).toBe(true);

    const ddl = await fresh.getTableDdl(savedId, 'users');
    expect(ddl.ok).toBe(true);

    const q = await fresh.query(savedId, 'SELECT COUNT(*) AS cnt FROM users');
    expect(q.ok).toBe(true);

    // 运行时 id 同样可用（两条路径都要通）
    const byRuntimeId = await fresh.listTables(runtimeId);
    expect(byRuntimeId.ok).toBe(true);

    await fresh.disconnectAll();
  });

  it('重复 connectSaved 复用同一个会话，不会堆出两个连接', async () => {
    const fresh = new DatabaseService(() => makeFakeWorkspace(projectRoot));
    const a = await fresh.connectSaved(savedId);
    const b = await fresh.connectSaved(savedId);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(b.connection!.id).toBe(a.connection!.id);
    await fresh.disconnectAll();
  });

  it('deleteConnection 能断开并移除基于配置 id 建立的会话', async () => {
    // 用一个独立配置，避免影响后面「deleteConnection 先断开再移出配置」那条用例
    const victimPath = path.join(projectRoot, 'victim.db');
    const victim = new DatabaseService(() => makeFakeWorkspace(projectRoot));
    await victim.createDemoDb(victimPath);
    const saved = await victim.saveConnection({
      type: 'sqlite',
      name: '待删除库',
      path: victimPath,
    });
    expect(saved.ok).toBe(true);
    const victimId = saved.connection!.id;

    const conn = await victim.connectSaved(victimId);
    expect(conn.ok).toBe(true);

    const del = await victim.deleteConnection(victimId);
    expect(del.ok).toBe(true);
    // 会话确实被断了：再拿原运行时 id 查应当失败
    const after = await victim.listTables(conn.connection!.id);
    expect(after.ok).toBe(false);
  });

  it('deleteConnection 先断开再移出配置，文件里随之消失', async () => {
    const del = await service.deleteConnection(savedId);
    expect(del.ok).toBe(true);

    const cfgPath = path.join(projectRoot, 'db-connections.json');
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    expect(raw.connections.some((c: any) => c.id === savedId)).toBe(false);

    const list = await service.listConnections();
    expect(list.some((c) => c.id === savedId)).toBe(false);
  });

  it('disconnectAll 断开全部会话但保留配置（连接属于项目，配置不该被清掉）', async () => {
    const before = await service.listConnections();
    expect(before.length).toBeGreaterThan(0);

    let connectId = '';
    const conn = await service.connect({ type: 'sqlite', path: dbPath });
    if (conn.ok && conn.connection) connectId = conn.connection.id;
    if (!conn.ok) {
      // 库文件可能已被 deleteConnection 的清理逻辑影响，这里按已有 demo.db 重新建一次
      const created = await service.createDemoDb(dbPath);
      connectId = created.connection?.id ?? '';
    }
    expect(connectId).toBeTruthy();

    await service.disconnectAll();

    const after = await service.listConnections();
    expect(after.length).toBe(before.length);
    expect(after.every((c) => !c.connected)).toBe(true);
  });

  it('校验失败时不写盘', async () => {
    const bad = await service.saveConnection({ type: 'mysql', name: '缺主机' });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('主机');

    const badPort = await service.saveConnection({
      type: 'mysql',
      name: '端口越界',
      host: 'localhost',
      user: 'root',
      port: 70000,
    });
    expect(badPort.ok).toBe(false);
    expect(badPort.error).toContain('端口');

    const cfgPath = path.join(projectRoot, 'db-connections.json');
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    expect(raw.connections.some((c: any) => c.name === '缺主机' || c.name === '端口越界')).toBe(
      false,
    );
  });
});

describe('DatabaseService · executeBatch 事务语义', () => {
  const tmpDir = path.join(os.tmpdir(), `echoly_db_batch_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const service = new DatabaseService();
  let connId = '';

  afterAll(async () => {
    await service.disconnectAll();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  /** 读一行标量，断言用 */
  const scalar = async (sql: string): Promise<any> => {
    const res = await service.query(connId, sql);
    expect(res.ok).toBe(true);
    return res.rows[0] && Object.values(res.rows[0])[0];
  };

  it('准备一个示例 SQLite 库', async () => {
    const res = await service.createDemoDb(path.join(tmpDir, 'batch.db'));
    expect(res.ok).toBe(true);
    connId = res.connection.id;
    expect(await scalar('SELECT COUNT(*) FROM users')).toBe(5);
  });

  it('全部成功时数据真落库，并逐条返回 affectedRows', async () => {
    const res = await service.executeBatch(connId, [
      "INSERT INTO users (username, email, role) VALUES ('frank', 'frank@echoly.dev', 'intern')",
      "UPDATE users SET role = 'lead' WHERE username = 'bob'",
    ]);
    expect(res.ok).toBe(true);
    expect(res.rolledBack).toBeUndefined();
    expect(res.results).toHaveLength(2);
    expect(res.results.every((r) => r.ok)).toBe(true);
    expect(res.results[0].affectedRows).toBe(1);
    expect(res.results[1].affectedRows).toBe(1);

    // 真落库了（不只是返回 ok）
    expect(await scalar('SELECT COUNT(*) FROM users')).toBe(6);
    expect(await scalar("SELECT role FROM users WHERE username = 'bob'")).toBe('lead');
  });

  it('中途一条出错 → 整体回滚，此前成功的 INSERT 在库里查不到', async () => {
    const before = await scalar('SELECT COUNT(*) FROM users');

    const res = await service.executeBatch(connId, [
      "INSERT INTO users (username, email, role) VALUES ('ghost', 'ghost@echoly.dev', 'intern')",
      'THIS IS NOT SQL',
    ]);
    expect(res.ok).toBe(false);
    expect(res.rolledBack).toBe(true);
    expect(res.results).toHaveLength(2);
    expect(res.results[0].ok).toBe(true);
    expect(res.results[1].ok).toBe(false);
    expect(res.results[1].error).toBeTruthy();

    // 事务的核心回归：第一条明明执行成功了，也必须跟着回滚掉
    expect(await scalar('SELECT COUNT(*) FROM users')).toBe(before);
    expect(await scalar("SELECT COUNT(*) FROM users WHERE username = 'ghost'")).toBe(0);
  });

  it('回滚后未执行到的语句被标记为未执行，不会伪装成成功', async () => {
    const res = await service.executeBatch(connId, [
      'THIS IS NOT SQL',
      "INSERT INTO users (username, email, role) VALUES ('never', 'never@echoly.dev', 'intern')",
    ]);
    expect(res.ok).toBe(false);
    expect(res.rolledBack).toBe(true);
    expect(res.results[0].ok).toBe(false);
    expect(res.results[1].ok).toBe(false);
    expect(res.results[1].error).toContain('未执行');
    expect(await scalar("SELECT COUNT(*) FROM users WHERE username = 'never'")).toBe(0);
  });

  it('拒绝 BEGIN / COMMIT 等事务控制语句，并给出中文错误', async () => {
    for (const sql of ['BEGIN', 'COMMIT', '  rollback ;', 'START TRANSACTION']) {
      const res = await service.executeBatch(connId, [sql]);
      expect(res.ok).toBe(false);
      expect(res.error).toContain('不接受事务控制语句');
      expect(res.results).toHaveLength(0);
    }
  });

  it('空语句被过滤；全空批次视为成功且什么都不做', async () => {
    const res = await service.executeBatch(connId, ['', '   ']);
    expect(res.ok).toBe(true);
    expect(res.results).toHaveLength(0);
  });

  it('连接已断开时给出可操作的中文错误', async () => {
    const res = await service.executeBatch('不存在的连接', ['SELECT 1']);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('连接');
  });

  it('批次进行中，同一连接上的普通 query() 被守卫拦下', async () => {
    // 事务是连接级状态：批次跑到一半时插进来的语句会跟着一起被提交或回滚，结果对用户是随机的。
    // 这里用「先占住锁，再发普通查询」来验证守卫（findActive 是私有的，测试里直接取内部会话置位），
    // 避免依赖真实并发时序 —— SQLite 走同步 API，靠时序去撞这个窗口会是个 flaky 用例。
    const active = (service as any).findActive(connId);
    expect(active).toBeTruthy();
    active!.batchRunning = true;
    try {
      const res = await service.query(connId, 'SELECT COUNT(*) AS cnt FROM users');
      expect(res.ok).toBe(false);
      expect(res.error).toContain('批量提交');

      const second = await service.executeBatch(connId, ["INSERT INTO users (username) VALUES ('x')"]);
      expect(second.ok).toBe(false);
      expect(second.error).toContain('批量提交');
    } finally {
      active!.batchRunning = false;
    }

    // 释放后恢复正常
    const after = await service.query(connId, 'SELECT COUNT(*) AS cnt FROM users');
    expect(after.ok).toBe(true);
  });
});

describe('DatabaseService · 断开与重连（回归：死连接被复用）', () => {
  const tmpDir = path.join(os.tmpdir(), `echoly_db_reconnect_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('用配置 id 断开后真的断开：列表标为未连接，且不会再把死连接复用回来', async () => {
    // 渲染层拿到的连接 id 永远是项目配置 id，而会话表的键是运行时 id。
    // 早先 disconnect 直接 delete(connectionId)，用配置 id 进来什么都没删掉 ——
    // 于是节点永远亮着「已连接」，点重连又把这个已关闭的会话原样返回（ok: true），
    // 之后每条语句都打在死连接上（MySQL: Can't add new command when connection is in closed state）。
    const svc = new DatabaseService(() => makeFakeWorkspace(tmpDir));
    const created = await svc.createDemoDb(path.join(tmpDir, 'reconnect.db'));
    expect(created.ok).toBe(true);
    const cfgId = (await svc.listConnections())[0].id;

    const disconnected = await svc.disconnect(cfgId);
    expect(disconnected.ok).toBe(true);

    const list = await svc.listConnections();
    expect(list.find((c) => c.id === cfgId)?.connected).toBe(false);

    // 重连必须给出一个**真的能用**的会话
    const again = await svc.connectSaved(cfgId);
    expect(again.ok).toBe(true);
    expect(again.connection?.id).not.toBe(created.connection!.id);

    const q = await svc.query(again.connection!.id, 'SELECT 1 AS x');
    expect(q.ok).toBe(true);
    expect(q.rows[0].x).toBe(1);

    await svc.disconnectAll();
  });

  it('会话已被判定为死连接时，listConnections 不会再报「已连接」', async () => {
    const svc = new DatabaseService(() => makeFakeWorkspace(tmpDir));
    const created = await svc.createDemoDb(path.join(tmpDir, 'dead.db'));
    expect(created.ok).toBe(true);
    const cfgId = (await svc.listConnections())[0].id;
    const runtimeId = created.connection!.id;

    // 越过服务层直接关掉底层库，模拟「服务端掐线 / 进程被动退出」：
    // 会话记录还在，但 socket 已经没了
    (svc as any).connections.get(runtimeId).db.close();

    const list = await svc.listConnections();
    expect(list.find((c) => c.id === cfgId)?.connected).toBe(false);

    // 重连必须新开一个会话，而不是复用那条死连接
    const again = await svc.connectSaved(cfgId);
    expect(again.ok).toBe(true);
    expect(again.connection!.id).not.toBe(runtimeId);
    const q = await svc.query(again.connection!.id, 'SELECT 1 AS x');
    expect(q.ok).toBe(true);

    await svc.disconnectAll();
  });
});

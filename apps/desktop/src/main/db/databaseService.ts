import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type {
  DatabaseConnectionInfo,
  DatabaseColumnMeta,
  DatabaseSchemaInfo,
  DatabaseTableInfo,
  DatabaseQueryResult,
  DbBatchResult,
  DbBatchStatementResult,
  DbSavedConnection,
  DbConnectionView,
  DbSchemaObjects,
  DbObjectGroup,
} from '@deepseek-ide/shared';
import { decryptSecret, encryptSecret } from '../settings';

/**
 * 项目级连接配置的**工作区相对路径**。
 *
 * 「相对」是因为它同时也是渲染层与主进程之间约定的逻辑名；真正的落点由 `DbWorkspaceIo`
 * 决定 —— 配置不写进工作区，而是落到 `~/.echoly/projects/<项目哈希>/db-connections.json`。
 * 这里保留 `.echoly/` 这一段前缀，是为了让老的路径语义（`.echoly/db-connections.json`）
 * 在日志与提示里仍然看得出来是同一个东西。
 */
const SAVED_FILE = 'db-connections.json';
/** 配置文件格式版本，便于将来演进结构 */
const SAVED_VERSION = 1;

// 动态载入 node:sqlite / mysql2 / pg（任一驱动缺失时降级为「驱动不可用」提示，不影响其他驱动）
let SqliteDatabaseSync: any = null;
try {
  const sqliteModule = require('node:sqlite');
  SqliteDatabaseSync = sqliteModule.DatabaseSync;
} catch {
  SqliteDatabaseSync = null;
}

let mysqlPromise: any = null;
try {
  mysqlPromise = require('mysql2/promise');
} catch {
  mysqlPromise = null;
}

let PgClient: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  PgClient = require('pg').Client;
} catch {
  PgClient = null;
}

type DbType = 'sqlite' | 'mysql' | 'postgres';

interface ActiveConnection {
  info: DatabaseConnectionInfo;
  db: any; // DatabaseSync / mysql Connection / pg Client
  type: DbType;
  /**
   * 最近一次下发到会话的库 / schema 名。
   * MySQL 的 `USE` 与 PostgreSQL 的 `SET search_path` 都是**连接级会话状态**，这里只作为缓存以避免重复下发；
   * 每次查询前仍会按需切换，因此不假设两次调用之间状态不变。
   */
  currentSchema?: string;
  /** 该会话对应的持久化配置 id（用于把「已连接」状态映射回项目里的连接列表） */
  savedId?: string;
  /**
   * 该会话上是否正有一个批量事务在执行。
   *
   * 事务是**连接级**状态：若批次进行中放进来一条普通 `query()`，那条语句会跟着一起被
   * 提交或回滚 —— 用户看到的结果就成了随机的。所以批次期间本连接对普通查询关闭。
   */
  batchRunning?: boolean;
}

/**
 * 由连接参数派生出**稳定 id**：同一份配置在任何一次会话里都得到同一个 id，
 * 这样「项目里保存的连接」与「此刻连着的会话」才能对上号。
 */
export function makeSavedId(cfg: {
  type?: string;
  host?: string;
  port?: number;
  database?: string;
  path?: string;
}): string {
  const type = cfg.type || 'sqlite';
  const key =
    type === 'sqlite'
      ? `${type}|${(cfg.path || '').replace(/\\/g, '/')}`
      : `${type}|${cfg.host || 'localhost'}|${cfg.port ?? ''}|${cfg.database || ''}`;
  const digest = createHash('sha1').update(key).digest('hex').slice(0, 12);
  return `db_${type}_${digest}`;
}

/** 该连接是否需要密码才能连（SQLite 不需要） */
export function connectionNeedsPassword(cfg: { type?: string; password?: string }): boolean {
  if ((cfg.type || 'sqlite') === 'sqlite') return false;
  // 空串与 undefined 都算「没存」——upsert 里空串表示清空
  return !cfg.password;
}

/** 把任意来源的原始条目收敛成合法的连接配置；缺关键字段则返回 null（过滤坏数据用） */
function normalizeSaved(raw: any): DbSavedConnection | null {
  if (!raw || typeof raw !== 'object') return null;
  const type = raw.type;
  if (type !== 'sqlite' && type !== 'mysql' && type !== 'postgres') return null;
  const path0 = typeof raw.path === 'string' ? raw.path : undefined;
  if (type === 'sqlite' && !path0) return null;
  const host = typeof raw.host === 'string' ? raw.host : undefined;
  if (type !== 'sqlite' && !host) return null;
  const port = Number.isFinite(raw.port) ? Number(raw.port) : undefined;
  const database = typeof raw.database === 'string' ? raw.database : undefined;
  return {
    id:
      typeof raw.id === 'string' && raw.id
        ? raw.id
        : makeSavedId({ type, host, port, database, path: path0 }),
    name: typeof raw.name === 'string' && raw.name ? raw.name : (database || path0 || type),
    type,
    path: path0,
    host,
    port,
    database,
    user: typeof raw.user === 'string' ? raw.user : undefined,
    password: typeof raw.password === 'string' ? raw.password : undefined,
    updatedAt: Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : Date.now(),
  };
}

/**
 * 标识符加引号：MySQL 用反引号，SQLite / PostgreSQL 用双引号。
 * 用于把库名、schema 名、表名安全地拼进语句（名字本身不能参数化）。
 */
function quoteIdent(type: DbType, name: string): string {
  if (type === 'mysql') return '`' + name.replace(/`/g, '``') + '`';
  return '"' + name.replace(/"/g, '""') + '"';
}

/** 形如 `db`.`table` / "schema"."table" 的全限定名 */
function qualify(type: DbType, schema: string | undefined, table: string): string {
  return schema ? `${quoteIdent(type, schema)}.${quoteIdent(type, table)}` : quoteIdent(type, table);
}

/** 给 SELECT 语句补分页（已有 LIMIT 时不动） */
function applyPagination(sql: string, page?: number, pageSize?: number): string {
  if (!page || !pageSize) return sql;
  if (!/^\s*select/i.test(sql)) return sql;
  if (/limit\s+\d+/i.test(sql)) return sql;
  const offset = (page - 1) * pageSize;
  return `${sql.replace(/;+\s*$/, '')} LIMIT ${pageSize} OFFSET ${offset};`;
}

/** 判断语句是否会返回结果集（各驱动语法不同，统一走同一个正则集合） */
function looksLikeSelect(sql: string): boolean {
  return /^\s*(select|show|describe|desc|explain|with|pragma|values)/i.test(sql);
}

/** 工作区读写接口（只用得到这几个方法，故不直接依赖 WorkspaceService 类型） */
export interface DbWorkspaceIo {
  exists(relPath: string): Promise<boolean>;
  readFile(relPath: string): Promise<string>;
  writeFile(relPath: string, content: string): Promise<void>;
  mkdir(relPath: string): Promise<void>;
}

export class DatabaseService {
  private connections = new Map<string, ActiveConnection>();

  /**
   * @param resolveWorkspace 返回当前窗口的工作区；连接配置按工作区（项目）存储，
   *   因此切项目后看到的是该项目的连接列表。返回 null 时视为「未打开工作区」，配置列表为空。
   */
  /**
   * @param resolveWorkspace 返回当前窗口的**项目配置 IO**。
   *
   *   注意它不是工作区本身：连接配置与查询脚本都不写进用户的项目里，而是落在
   *   `~/.echoly/projects/<工作区哈希>/`（映射逻辑见 windowRegistry.projectConfigWorkspaceIo）。
   *   这里保持「返回一组相对路径 IO」的形状，于是 DatabaseService 不需要知道配置到底落在哪，
   *   单测也能拿临时目录顶替。返回 null 表示「未打开工作区」，配置列表为空。
   */
  constructor(private readonly resolveWorkspace: () => DbWorkspaceIo | null = () => null) {}

  // ── 项目级连接配置的读写 ──────────────────────────────────────────────────

  /**
   * 按调用方给的 id 找会话。
   *
   * 这里必须同时接受两种 id，因为连接树里的 `conn.id` 是**项目配置 id**（`makeSavedId` 派生的
   * `db_mysql_xxx`），而会话表是以运行时 id（`mysql_<时间戳>_<随机>`）为键的：
   * `dbListConnections` 返回配置 id 并用 `savedId` 标注「是否已连接」，所以渲染层后续
   * 拿到的每个 connId 都是配置 id。2026-09 之前 `dbListConnections` 返回的是会话信息，
   * 那时两者恰好一致；改成「配置随项目」之后就不再一致了 —— 少了这个回退，
   * 树会显示「已连接」却每个操作都报「未找到该数据库连接」。
   *
   * 先按会话 id 精确命中；否则按 savedId 找回退（同一份配置重复连接时取最新一个）。
   */
  private findActive(connectionId: string): ActiveConnection | undefined {
    const direct = this.connections.get(connectionId);
    if (direct) return this.pruneIfDead(direct);
    if (!connectionId) return undefined;
    let found: ActiveConnection | undefined;
    for (const active of this.connections.values()) {
      if (active.savedId === connectionId) found = active;
    }
    return this.pruneIfDead(found);
  }


  /**
   * 读取当前工作区保存的连接配置。
   * 文件不存在、JSON 非法、结构不对 —— 一律安全降级为空列表，绝不让面板因此崩掉。
   *
   * 返回的 `password` 保持**落盘原样**（`enc:v1:` 密文，或无法加密时的降级明文）；
   * 想拿可用密码请用 {@link connectSaved}，它内部会走 `decryptSecret`。
   */
  async loadSaved(): Promise<DbSavedConnection[]> {
    const ws = this.resolveWorkspace();
    if (!ws) return [];
    try {
      if (!(await ws.exists(SAVED_FILE))) return [];
      const raw = await ws.readFile(SAVED_FILE);
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed?.connections) ? parsed.connections : [];
      return list
        .map(normalizeSaved)
        .filter((c: DbSavedConnection | null): c is DbSavedConnection => c !== null);
    } catch {
      return [];
    }
  }

  /**
   * 写回连接配置。
   *
   * 配置落在用户主目录（`~/.echoly/projects/<项目哈希>/`）而不是工作区里，所以这里
   * **不再生成 .gitignore** —— 那个文件在用户的版本库里根本不存在了，配置从一开始就不在
   * 工作区里，也就没有被 `git add .` 顺手带进版本库的可能。老项目里遗留的
   * `.echoly/.gitignore` 不必清理：删别人项目里的文件比留一个无害的忽略规则危险得多。
   */
  private async persistSaved(list: DbSavedConnection[]): Promise<void> {
    const ws = this.resolveWorkspace();
    if (!ws) throw new Error('未打开工作区，无法保存数据库连接');
    await ws.writeFile(
      SAVED_FILE,
      JSON.stringify({ version: SAVED_VERSION, connections: list }, null, 2),
    );
  }

  /** 按 id upsert 一条配置（已存在则合并非空字段） */
  private async upsertSaved(
    cfg: Partial<DbSavedConnection> & { id?: string },
  ): Promise<DbSavedConnection> {
    const list = await this.loadSaved();
    // 注意：loadSaved 返回的 password 仍是落盘时的密文（enc:v1:…）。因此这里的约定是
    // **调用方负责加密**（saveConnection / persistAfterConnect 都已先 encryptSecret），
    // 本方法只做合并 —— 否则经过这里就会二次加密，密文再也解不回来。
    const id = cfg.id || makeSavedId(cfg);
    const idx = list.findIndex((c) => c.id === id);
    const prev = idx >= 0 ? list[idx] : undefined;
    const merged: DbSavedConnection = {
      id,
      name: cfg.name || prev?.name || cfg.database || cfg.path || cfg.type || 'database',
      type: (cfg.type || prev?.type || 'sqlite') as DbSavedConnection['type'],
      path: cfg.path ?? prev?.path,
      host: cfg.host ?? prev?.host,
      port: cfg.port ?? prev?.port,
      database: cfg.database ?? prev?.database,
      user: cfg.user ?? prev?.user,
      // password 为 undefined 表示「不改动」，空串表示「清空密码」
      password: cfg.password === undefined ? prev?.password : cfg.password,
      updatedAt: Date.now(),
    };
    if (idx >= 0) list[idx] = merged;
    else list.push(merged);
    await this.persistSaved(list);
    return merged;
  }

  /** 新增 / 更新一条连接配置（对外入口；密码在此处加密） */
  async saveConnection(
    cfg: Omit<Partial<DbSavedConnection>, 'password'> & { password?: string },
  ): Promise<{ ok: boolean; connection?: DbSavedConnection; error?: string }> {
    const type = cfg.type || 'sqlite';
    if (type !== 'sqlite') {
      if (!cfg.host) return { ok: false, error: '请填写主机地址' };
      if (!cfg.user) return { ok: false, error: '请填写用户名' };
      if (type === 'postgres' && !cfg.database) {
        return { ok: false, error: 'PostgreSQL 必须指定数据库名（Database）' };
      }
      if (cfg.port != null && (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535)) {
        return { ok: false, error: '端口需为 1-65535 之间的整数' };
      }
    } else if (!cfg.path) {
      return { ok: false, error: '请填写 SQLite 数据库文件路径' };
    }

    try {
      const saved = await this.upsertSaved({
        ...cfg,
        password: cfg.password ? (encryptSecret(cfg.password) as string) : cfg.password,
      });
      return { ok: true, connection: saved };
    } catch (err: any) {
      return { ok: false, error: `保存数据库连接失败: ${err.message || String(err)}` };
    }
  }

  /** 删除一条连接配置；若该连接正连着，先断开 */
  async deleteConnection(id: string): Promise<{ ok: boolean; error?: string }> {
    try {
      // 删配置前先把基于它建立的会话断掉（会话键是运行时 id，得用 findActive 才找得到）
      const active = this.findActive(id);
      if (active) await this.disconnect(active.info.id);
      const list = (await this.loadSaved()).filter((c) => c.id !== id);
      await this.persistSaved(list);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: `删除数据库连接失败: ${err.message || String(err)}` };
    }
  }

  /** 用项目里保存的配置（含密码）重新连接 */
  async connectSaved(
    id: string,
  ): Promise<{ ok: boolean; connection?: DatabaseConnectionInfo; error?: string }> {
    const list = await this.loadSaved();
    const cfg = list.find((c) => c.id === id);
    if (!cfg) return { ok: false, error: '未找到该连接配置（可能已被删除）' };
    // 同一份配置可能已经连着（例如重复点击、或窗口刚恢复）：直接复用会话，
    // 既省掉一次建连，也避免同一配置出现两个会话、savedId 指向变得含糊。
    const existing = this.findActive(id);
    if (existing) return { ok: true, connection: existing.info };
    return this.connect({
      type: cfg.type,
      path: cfg.path,
      name: cfg.name,
      host: cfg.host,
      port: cfg.port,
      database: cfg.database,
      user: cfg.user,
      password: decryptSecret(cfg.password) || '',
      savedId: cfg.id,
    });
  }

  /** 断开当前全部会话（切换工作区时调用：连接属于项目，项目换了就不该继续连着） */
  async disconnectAll(): Promise<void> {
    for (const id of Array.from(this.connections.keys())) {
      await this.disconnect(id);
    }
  }

  /**
   * 连接成功后的落盘收尾。
   *
   * 约定：只要调用方给了 `name` 就视为「这是一条要保存的连接」（`NewDbConnectionModal` 的新建 /
   * 编辑路径都会带 name；`connectSaved`、`createDemoDb` 走 savedId 分支）。
   * 纯粹的「测试连接」不传 name（见 NewDbConnectionModal.handleTestConnection），因此不会留下垃圾配置。
   */
  private async persistAfterConnect(
    options: { name?: string; savedId?: string },
    cfg: Partial<DbSavedConnection> & { name: string; password?: string; savedId: string },
  ): Promise<void> {
    if (!options.name && !options.savedId) return;
    try {
      const { savedId, ...rest } = cfg;
      await this.upsertSaved({
        ...rest,
        id: savedId,
        password: rest.password ? (encryptSecret(rest.password) as string) : rest.password,
      });
    } catch (err: any) {
      // 「连接成功了但配置没写成」这种半成功状态必须留下痕迹：
      // 常见原因是未打开工作区，或 SSH 工作区的 SFTP 会话尚未就绪。
      // 连接本身已建立，不因此让 connect 失败，但要在日志里说清楚。
      console.error(
        `[db] 连接已建立，但连接配置未能写入项目配置目录（~/.echoly/projects/…/db-connections.json）: ${err?.message || String(err)}`,
      );
    }
  }

  /**
   * 连接到一个数据库（支持 SQLite / MySQL / PostgreSQL）
   */
  async connect(options: {
    path?: string;
    name?: string;
    type?: DbType;
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    username?: string;
    password?: string;
    /** 显式指定它对应的持久化配置 id（由 connectSaved 传入） */
    savedId?: string;
  }): Promise<{ ok: boolean; connection?: DatabaseConnectionInfo; error?: string }> {
    const type = options.type || 'sqlite';
    const filePath = options.path;

    if (type === 'sqlite') {
      if (!filePath) {
        return { ok: false, error: '请提供 SQLite 数据库文件路径' };
      }

      if (!fs.existsSync(filePath)) {
        return { ok: false, error: `数据库文件不存在: ${filePath}` };
      }

      if (!SqliteDatabaseSync) {
        return { ok: false, error: '当前运行环境未支持 node:sqlite' };
      }

      try {
        const savedId = options.savedId || makeSavedId({ type: 'sqlite', path: filePath });
        const connName = options.name || path.basename(filePath);
        const db = new SqliteDatabaseSync(filePath);

        const info: DatabaseConnectionInfo = {
          id: `sqlite_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          name: connName,
          type: 'sqlite',
          path: filePath,
          connectedAt: Date.now(),
        };

        this.connections.set(info.id, { info, db, type: 'sqlite', currentSchema: 'main', savedId });
        await this.persistAfterConnect(options, {
          type: 'sqlite',
          name: connName,
          path: filePath,
          savedId,
        });
        return { ok: true, connection: info };
      } catch (err: any) {
        return { ok: false, error: `打开数据库失败: ${err.message || String(err)}` };
      }
    }

    if (type === 'mysql') {
      if (!mysqlPromise) {
        return { ok: false, error: '未安装或无法加载 mysql2 驱动' };
      }
      const host = options.host || 'localhost';
      const port = options.port ? Number(options.port) : 3306;
      const user = options.user || options.username || 'root';
      const password = options.password || '';
      const database = options.database || undefined;

      try {
        const conn = await mysqlPromise.createConnection({
          host,
          port,
          user,
          password,
          database,
          connectTimeout: 8000,
        });

        // 探测验证连接
        await conn.query('SELECT 1');

        const savedId = options.savedId || makeSavedId({ type: 'mysql', host, port, database });
        const connName =
          options.name || (database ? `${database}@${host}` : `mysql@${host}:${port}`);

        const info: DatabaseConnectionInfo = {
          id: `mysql_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          name: connName,
          type: 'mysql',
          host,
          port,
          database,
          connectedAt: Date.now(),
        };

        this.connections.set(info.id, {
          info,
          db: conn,
          type: 'mysql',
          currentSchema: database,
          savedId,
        });
        await this.persistAfterConnect(options, {
          type: 'mysql',
          name: connName,
          host,
          port,
          database,
          user,
          password,
          savedId,
        });
        return { ok: true, connection: info };
      } catch (err: any) {
        return { ok: false, error: `MySQL 连接失败: ${err.message || String(err)}` };
      }
    }

    if (type === 'postgres') {
      if (!PgClient) {
        return { ok: false, error: '未安装或无法加载 pg 驱动（请先执行 npm i pg）' };
      }
      const host = options.host || 'localhost';
      const port = options.port ? Number(options.port) : 5432;
      const user = options.user || options.username || 'postgres';
      const password = options.password || '';
      const database = options.database || undefined;

      if (!database) {
        return { ok: false, error: 'PostgreSQL 必须指定数据库名（Database）' };
      }

      let client: any = null;
      try {
        client = new PgClient({
          host,
          port,
          user,
          password,
          database,
          connectionTimeoutMillis: 8000,
        });
        await client.connect();
        await client.query('SELECT 1');

        const savedId = options.savedId || makeSavedId({ type: 'postgres', host, port, database });
        const connName = options.name || `${database}@${host}:${port}`;

        const info: DatabaseConnectionInfo = {
          id: `pg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          name: connName,
          type: 'postgres',
          host,
          port,
          database,
          connectedAt: Date.now(),
        };

        this.connections.set(info.id, {
          info,
          db: client,
          type: 'postgres',
          currentSchema: 'public',
          savedId,
        });
        await this.persistAfterConnect(options, {
          type: 'postgres',
          name: connName,
          host,
          port,
          database,
          user,
          password,
          savedId,
        });
        return { ok: true, connection: info };
      } catch (err: any) {
        try {
          await client?.end();
        } catch {
          // 忽略清理异常
        }
        return { ok: false, error: `PostgreSQL 连接失败: ${err.message || String(err)}` };
      }
    }

    return { ok: false, error: `暂未支持的数据库类型: ${type}` };
  }

  /**
   * 断开数据库连接
   *
   * 删除时必须用**会话自己的运行时 id**（`active.info.id`）而不是传进来的 `connectionId`：
   * 渲染层拿到的永远是树上的**项目配置 id**，而会话表的键是运行时 id，两者并不相等。
   * 早先这里直接 `delete(connectionId)`，于是配置 id 进来时什么都没删掉 ——
   * 会话留在表里，`listConnections` 照旧报「已连接」；用户再点「连接」时
   * `connectSaved` 的复用分支把这个**已关闭**的会话原样返回（ok: true），
   * 之后每条语句都打在一个死连接上：MySQL 报
   * 「Can't add new command when connection is in closed state」、SQLite 报「database is not open」。
   */
  async disconnect(connectionId: string): Promise<{ ok: boolean }> {
    // 这里直接扫会话表而不是走 findActive：findActive 会把已死的会话判为「不存在」，
    // 那样就没人去删这条记录了，「已连接」会一直亮着
    const targets = Array.from(this.connections.entries()).filter(
      ([key, active]) => key === connectionId || active.savedId === connectionId,
    );
    for (const [key, active] of targets) {
      try {
        if ((active.type === 'mysql' || active.type === 'postgres') && active.db?.end) {
          await active.db.end();
        } else if (active.db && typeof active.db.close === 'function') {
          active.db.close();
        }
      } catch {
        // 关连接失败不影响「从会话表里摘掉」这个结论：留着它只会让下次重连又拿到这条死连接
      }
      this.connections.delete(key);
    }
    return { ok: true };
  }

  /**
   * 底层连接是否还活着。
   *
   * 会话表里的条目**不等于**连接可用：服务端掐过连接、进程重启、
   * 或早先版本没删干净，都会留下一条「记录还在、socket 已经没了」的会话。
   * 这种会话再被复用，用户拿到的是 ok:true 加一串看不懂的驱动报错。
   */
  private isSessionAlive(active: ActiveConnection): boolean {
    try {
      if (active.type === 'sqlite') {
        // node:sqlite 的 DatabaseSync 关掉之后 isOpen 变 false
        return active.db?.isOpen !== false;
      }
      if (active.type === 'mysql') {
        // mysql2/promise 的 PromiseConnection 把底层连接挂在 .connection 上；
        // 只有 'authenticated' 能跑语句，'error' / 'disconnected' 都是死连接
        const raw = (active.db as any)?.connection ?? active.db;
        if (raw?.fatalError) return false;
        if (typeof raw?.state === 'string') return raw.state === 'authenticated';
        return true;
      }
      // pg.Client：被服务端断掉或自己 end() 过之后 _ended / connection._ending 会置位
      return !(active.db as any)?._ended && !(active.db as any)?.connection?._ending;
    } catch {
      return false;
    }
  }

  /**
   * 取出会话；发现它已经死了就顺手从表里摘掉再当作不存在。
   *
   * 摘掉这一步很重要：不摘的话连接树会一直显示「已连接」，
   * 而点它重连又会被 connectSaved 的复用分支挡住 —— 死循环。
   */
  private pruneIfDead(active: ActiveConnection | undefined): ActiveConnection | undefined {
    if (!active) return undefined;
    if (this.isSessionAlive(active)) return active;
    this.connections.delete(active.info.id);
    return undefined;
  }

  /**
   * 在**一个事务**里顺序执行多条语句（表数据的增删改专用）。
   *
   * 为什么只有这里带事务、DDL 却不走它：
   * - MySQL 的 DDL 会隐式提交当前事务，把 CREATE/ALTER/DROP 混进批次会静默破坏原子性；
   * - 所以表结构变更一律在渲染层单条走 `dbQuery`，这里只服务行级 DML。
   * 批次里若混进 BEGIN / COMMIT 这类事务控制语句会被直接拒绝 —— 嵌套 BEGIN 在
   * `pg.Client` 这种单连接上会告警并破坏外层事务语义。
   *
   * 三驱动的差异都封在这里，渲染层只看到「一批语句 + 一个整体成败」：
   * - SQLite（node:sqlite 的 DatabaseSync，同步 API）：`exec('BEGIN')` / `prepare().run()` / `exec('COMMIT')`
   * - MySQL（mysql2/promise）：`beginTransaction()` / `query()` / `commit()` / `rollback()`
   * - PostgreSQL（pg.Client，单连接非连接池）：`query('BEGIN')` / `query()` / `query('COMMIT'|'ROLLBACK')`
   * 不用 SAVEPOINT：批次之间不嵌套，单连接上简单的整体回滚就够，少一层状态就少一处出错面。
   */
  async executeBatch(
    connectionId: string,
    statements: string[],
    schemaName?: string,
  ): Promise<DbBatchResult> {
    const startTime = performance.now();
    const elapsed = () => Number((performance.now() - startTime).toFixed(2));
    const active = this.findActive(connectionId);
    if (!active) {
      return {
        ok: false,
        results: [],
        executionTimeMs: 0,
        error: '数据库连接已断开，请重新连接',
      };
    }

    const list = (statements || []).map((s) => String(s ?? '').trim()).filter((s) => s.length > 0);
    if (list.length === 0) {
      return { ok: true, results: [], executionTimeMs: elapsed() };
    }

    const forbidden = list.find((s) =>
      /^\s*(begin|start\s+transaction|commit|rollback|savepoint|release\s+savepoint)\b/i.test(s),
    );
    if (forbidden) {
      return {
        ok: false,
        results: [],
        executionTimeMs: elapsed(),
        error: `批量提交不接受事务控制语句，请移除后重试：${forbidden.slice(0, 80)}`,
      };
    }

    if (active.batchRunning) {
      return {
        ok: false,
        results: [],
        executionTimeMs: elapsed(),
        error: '该连接正在执行批量提交，请稍后重试',
      };
    }

    active.batchRunning = true;
    const results: DbBatchStatementResult[] = [];
    /** 事务是否已开启成功（决定要不要回滚） */
    let begun = false;

    /** 按驱动开事务 */
    const begin = async () => {
      if (active.type === 'mysql') await active.db.beginTransaction();
      else if (active.type === 'postgres') await active.db.query('BEGIN');
      else active.db.exec('BEGIN');
      begun = true;
    };
    /** 按驱动执行一条语句，返回受影响行数 */
    const runOne = async (sql: string): Promise<number | undefined> => {
      if (active.type === 'mysql') {
        const [res] = await active.db.query(sql);
        return (res as any)?.affectedRows;
      }
      if (active.type === 'postgres') {
        const res = await active.db.query(sql);
        return typeof res.rowCount === 'number' ? res.rowCount : undefined;
      }
      const runRes = active.db.prepare(sql).run();
      return runRes?.changes;
    };
    /** 按驱动提交 / 回滚；回滚失败会抛出，由调用方处理 */
    const finish = async (action: 'commit' | 'rollback') => {
      if (active.type === 'mysql') {
        if (action === 'commit') await active.db.commit();
        else await active.db.rollback();
      } else if (active.type === 'postgres') {
        await active.db.query(action === 'commit' ? 'COMMIT' : 'ROLLBACK');
      } else {
        active.db.exec(action === 'commit' ? 'COMMIT' : 'ROLLBACK');
      }
    };

    try {
      // 切库要在 BEGIN 之前：MySQL 的 USE 本身不参与事务，PG 的 SET search_path 同理
      await this.applySchema(active, schemaName);
      await begin();

      for (const sql of list) {
        try {
          const affectedRows = await runOne(sql);
          results.push({ sql, ok: true, affectedRows });
        } catch (stmtErr: any) {
          results.push({ sql, ok: false, error: stmtErr?.message || String(stmtErr) });
          throw stmtErr;
        }
      }

      await finish('commit');
      return { ok: true, results, executionTimeMs: elapsed() };
    } catch (err: any) {
      let rolledBack: boolean | undefined;
      let rollbackError = '';
      if (begun) {
        try {
          await finish('rollback');
          rolledBack = true;
        } catch (rbErr: any) {
          rolledBack = false;
          rollbackError = rbErr?.message || String(rbErr);
          // 回滚都失败了，连接状态已不可信，留一条日志便于排查「数据半改」
          console.error(`[db] 批量提交回滚失败: ${rollbackError}`);
        }
      }
      // 未执行到的语句补一条「未执行」记录，避免渲染层误以为它们成功了
      for (const sql of list) {
        if (!results.some((r) => r.sql === sql)) {
          results.push({ sql, ok: false, error: '事务已回滚，该语句未执行' });
        }
      }
      const baseError = err?.message || String(err);
      return {
        ok: false,
        results,
        rolledBack,
        executionTimeMs: elapsed(),
        error: rollbackError
          ? `${baseError}（回滚未成功：${rollbackError}，数据可能处于半改状态）`
          : baseError,
      };
    } finally {
      active.batchRunning = false;
    }
  }

  /**
   * 列出当前项目保存的连接配置，并标注每条当前是否已连上。
   *
   * 注意这里读的是**磁盘上的项目配置**而不是内存里的会话表：断开一个连接不会让它从树里消失，
   * 只是变成「未连接」节点，点击即可用保存的凭据重连。
   */
  async listConnections(): Promise<DbConnectionView[]> {
    // 先把已经死掉的会话摘掉，再据此标「已连接」：否则服务端断过线之后，
    // 树上会一直亮着「已连接」，而点它重连又被复用分支挡回这条死连接
    for (const [key, active] of Array.from(this.connections.entries())) {
      if (!this.isSessionAlive(active)) this.connections.delete(key);
    }
    const saved = await this.loadSaved();
    const connectedIds = new Set(
      Array.from(this.connections.values())
        .map((c) => c.savedId)
        .filter((v): v is string => Boolean(v)),
    );
    return saved.map((cfg) => ({
      ...cfg,
      connected: connectedIds.has(cfg.id),
      passwordSaved: !connectionNeedsPassword(cfg),
      requiresPassword: connectionNeedsPassword(cfg),
    }));
  }

  /**
   * 把连接的会话切到指定库 / schema。
   * - MySQL: `USE \`db\``（会话级，逐条执行脚本时 `USE` 能自然延续到后续语句）
   * - PostgreSQL: `SET search_path TO "schema", public`
   * - SQLite: 无操作（main 之外附加库通过限定名访问）
   */
  private async applySchema(active: ActiveConnection, schemaName?: string): Promise<void> {
    if (!schemaName || schemaName === active.currentSchema) return;
    if (active.type === 'sqlite') {
      active.currentSchema = schemaName;
      return;
    }
    const quoted = quoteIdent(active.type, schemaName);
    if (active.type === 'mysql') {
      await active.db.query(`USE ${quoted}`);
    } else if (active.type === 'postgres') {
      await active.db.query(`SET search_path TO ${quoted}, public`);
    }
    active.currentSchema = schemaName;
  }

  /**
   * 列出连接下的库 / schema 节点
   * - MySQL: SHOW DATABASES（一个连接下可有多个库）
   * - PostgreSQL: information_schema.schemata（连接已绑定到某个数据库）
   * - SQLite: PRAGMA database_list（通常只有 main）
   */
  async listSchemas(
    connectionId: string,
  ): Promise<{ ok: boolean; schemas: DatabaseSchemaInfo[]; error?: string }> {
    const active = this.findActive(connectionId);
    if (!active) {
      return { ok: false, schemas: [], error: '未找到该数据库连接或连接已断开' };
    }

    try {
      if (active.type === 'mysql') {
        const [rows] = await active.db.query('SHOW DATABASES');
        const schemas: DatabaseSchemaInfo[] = (rows as any[]).map((r) => ({
          name: String(Object.values(r)[0]),
          kind: 'database' as const,
        }));
        return { ok: true, schemas };
      }

      if (active.type === 'postgres') {
        const res = await active.db.query(
          `SELECT schema_name FROM information_schema.schemata
             WHERE schema_name NOT LIKE 'pg\\_%' AND schema_name <> 'information_schema'
             ORDER BY schema_name`,
        );
        const schemas: DatabaseSchemaInfo[] = (res.rows as any[]).map((r) => ({
          name: String(r.schema_name),
          kind: 'schema' as const,
        }));
        return { ok: true, schemas };
      }

      const rows = active.db.prepare('PRAGMA database_list').all() as Array<{
        name: string;
        file: string;
      }>;
      const schemas: DatabaseSchemaInfo[] = rows.map((r) => ({
        name: r.name,
        kind: 'database' as const,
      }));
      return { ok: true, schemas: schemas.length > 0 ? schemas : [{ name: 'main', kind: 'database' }] };
    } catch (err: any) {
      return { ok: false, schemas: [], error: err.message || String(err) };
    }
  }

  /**
   * 获取指定库 / schema 下的所有表
   *
   * 元数据查询一律使用**全限定名**（information_schema.TABLE_SCHEMA / "schema".sqlite_master /
   * pg_namespace），不依赖会话当前库，避免污染连接状态。
   */
  async listTables(
    connectionId: string,
    schemaName?: string,
  ): Promise<{ ok: boolean; tables: DatabaseTableInfo[]; error?: string }> {
    const active = this.findActive(connectionId);
    if (!active) {
      return { ok: false, tables: [], error: '未找到该数据库连接或连接已断开' };
    }

    try {
      if (active.type === 'mysql') {
        const schema = schemaName || active.info.database;
        if (!schema) {
          return {
            ok: false,
            tables: [],
            error: '请先展开一个数据库节点（当前连接未指定默认库）',
          };
        }
        // TABLE_ROWS 在 InnoDB 下是估算值，仅作参考；TABLE_COMMENT 为表注释。
        // 视图一并返回并标上 kind：树上要分「表 / 视图」两个分组，靠 TABLE_TYPE 区分
        const [rows] = await active.db.query(
          `SELECT TABLE_NAME AS name, TABLE_ROWS AS rowCount, TABLE_COMMENT AS comment, TABLE_TYPE AS ttype
             FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = ? AND TABLE_TYPE IN ('BASE TABLE', 'VIEW')
            ORDER BY TABLE_NAME`,
          [schema],
        );
        const tables: DatabaseTableInfo[] = (rows as any[]).map((r) => ({
          name: String(r.name),
          // 视图没有可信行数：TABLE_ROWS 对它恒为 NULL，展示成 0 会误导
          rowCount:
            String(r.ttype) === 'VIEW' || r.rowCount === null || r.rowCount === undefined
              ? undefined
              : Number(r.rowCount),
          comment: r.comment ? String(r.comment) : undefined,
          kind: String(r.ttype) === 'VIEW' ? 'view' : 'table',
        }));
        return { ok: true, tables };
      }

      if (active.type === 'postgres') {
        const schema = schemaName || 'public';
        const res = await active.db.query(
          `SELECT c.relname AS name,
                  c.reltuples::bigint AS "rowCount",
                  c.relkind AS rkind,
                  obj_description(c.oid) AS comment
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm')
            ORDER BY c.relname`,
          [schema],
        );
        const tables: DatabaseTableInfo[] = (res.rows as any[]).map((r) => {
          const est = Number(r.rowCount);
          const isView = r.rkind === 'v' || r.rkind === 'm';
          return {
            // reltuples 为 -1 表示该表尚未 analyze，此时不展示行数
            name: String(r.name),
            rowCount: !isView && Number.isFinite(est) && est >= 0 ? est : undefined,
            comment: r.comment ? String(r.comment) : undefined,
            kind: isView ? 'view' : 'table',
          };
        });
        return { ok: true, tables };
      }

      const schema = schemaName || 'main';
      const master = qualify('sqlite', schema === 'main' ? undefined : schema, 'sqlite_master');
      const stmt = active.db.prepare(
        `SELECT name, type FROM ${master}
          WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name ASC`,
      );
      const rows = stmt.all() as Array<{ name: string; type: string }>;
      const tables: DatabaseTableInfo[] = [];

      for (const r of rows) {
        // 视图不数行：COUNT(*) 会把整张视图算一遍，展开一个库就可能卡住
        if (r.type === 'view') {
          tables.push({ name: r.name, kind: 'view' });
          continue;
        }
        let count = 0;
        try {
          const countStmt = active.db.prepare(
            `SELECT COUNT(*) as total FROM ${qualify('sqlite', schema === 'main' ? undefined : schema, r.name)}`,
          );
          const countRes = countStmt.get() as { total: number };
          count = countRes ? countRes.total : 0;
        } catch {
          count = 0;
        }

        tables.push({
          name: r.name,
          rowCount: count,
          kind: 'table',
        });
      }

      return { ok: true, tables };
    } catch (err: any) {
      return { ok: false, tables: [], error: err.message || String(err) };
    }
  }

  /**
   * 列出库 / schema 下的六类对象，供树上的分组节点展开。
   *
   * 每一组各自 try / catch：某一类查不动（权限不足、驱动版本老到没有 information_schema.EVENTS）
   * 只该让那一组显示错误，而不是让整个库展开失败 —— 表和视图几乎总是看得见的。
   * 驱动本身没有的对象类型（SQLite 没有存储过程和事件）走 `supported: false`，
   * 树上据此显示「不支持」，与「查得到但是空的」区分开。
   */
  async listObjects(
    connectionId: string,
    schemaName?: string,
  ): Promise<{ ok: boolean; objects?: DbSchemaObjects; error?: string }> {
    const active = this.findActive(connectionId);
    if (!active) {
      return { ok: false, error: '未找到该数据库连接或连接已断开' };
    }

    const empty = (): DbSchemaObjects => ({
      tables: [],
      views: [],
      indexes: [],
      procedures: [],
      triggers: [],
      events: [],
      supported: {
        tables: true,
        views: true,
        indexes: true,
        procedures: active.type !== 'sqlite',
        triggers: true,
        events: active.type === 'mysql',
      },
    });

    const objects = empty();
    const errors: Partial<Record<DbObjectGroup, string>> = {};

    /** 跑一组查询并把结果写进对应的分组；失败只记在该组名下 */
    const group = async (key: DbObjectGroup, run: () => Promise<string[]>): Promise<void> => {
      try {
        objects[key] = await run();
      } catch (err: any) {
        errors[key] = err?.message || String(err);
      }
    };

    try {
      if (active.type === 'mysql') {
        const schema = schemaName || active.info.database;
        if (!schema) {
          return { ok: false, error: '请先展开一个数据库节点（当前连接未指定默认库）' };
        }
        const nameList = async (sql: string): Promise<string[]> => {
          const [rows] = await active.db.query(sql, [schema]);
          return (rows as any[]).map((r) => String(r.name));
        };
        await group('tables', () =>
          nameList(
            `SELECT TABLE_NAME AS name FROM information_schema.TABLES
              WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
          ),
        );
        await group('views', () =>
          nameList(
            `SELECT TABLE_NAME AS name FROM information_schema.VIEWS
              WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
          ),
        );
        // 索引名在库内不唯一（每张表都有 PRIMARY），所以带上表名一起显示，
        // 否则一屏十几个 PRIMARY 谁也认不出是哪个
        await group('indexes', () =>
          nameList(
            `SELECT DISTINCT CONCAT(TABLE_NAME, '.', INDEX_NAME) AS name
               FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = ? ORDER BY name`,
          ),
        );
        await group('procedures', () =>
          nameList(
            `SELECT ROUTINE_NAME AS name FROM information_schema.ROUTINES
              WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = 'PROCEDURE' ORDER BY ROUTINE_NAME`,
          ),
        );
        await group('triggers', () =>
          nameList(
            `SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS
              WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME`,
          ),
        );
        await group('events', () =>
          nameList(
            `SELECT EVENT_NAME AS name FROM information_schema.EVENTS
              WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME`,
          ),
        );
      } else if (active.type === 'postgres') {
        const schema = schemaName || 'public';
        const nameList = async (sql: string): Promise<string[]> => {
          const res = await active.db.query(sql, [schema]);
          return (res.rows as any[]).map((r) => String(r.name));
        };
        await group('tables', () =>
          nameList(
            `SELECT c.relname AS name FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') ORDER BY c.relname`,
          ),
        );
        // 物化视图也归在「视图」下：对用户而言它就是一张只读的表
        await group('views', () =>
          nameList(
            `SELECT c.relname AS name FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = $1 AND c.relkind IN ('v', 'm') ORDER BY c.relname`,
          ),
        );
        await group('indexes', () =>
          nameList(
            `SELECT t.relname || '.' || i.relname AS name
               FROM pg_index x
               JOIN pg_class i ON i.oid = x.indexrelid
               JOIN pg_class t ON t.oid = x.indrelid
               JOIN pg_namespace n ON n.oid = t.relnamespace
              WHERE n.nspname = $1 ORDER BY name`,
          ),
        );
        // prokind = 'p' 才是真正的存储过程（PG 11+）；普通函数（'f'）不在此列，
        // 否则一个库里成百上千个函数会把这一组淹掉
        await group('procedures', () =>
          nameList(
            `SELECT p.proname AS name FROM pg_proc p
               JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = $1 AND p.prokind = 'p' ORDER BY p.proname`,
          ),
        );
        await group('triggers', () =>
          nameList(
            `SELECT t.tgname AS name FROM pg_trigger t
               JOIN pg_class c ON c.oid = t.tgrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = $1 AND NOT t.tgisinternal ORDER BY t.tgname`,
          ),
        );
        // PG 没有 MySQL 那种「事件调度器」，事件这一组不支持（supported.events 已为 false）
      } else {
        // SQLite：附件库（非 main）也要能查，所以 master 表跟着 schema 走
        const schema = schemaName || 'main';
        const master = qualify('sqlite', schema === 'main' ? undefined : schema, 'sqlite_master');
        const nameList = async (type: string): Promise<string[]> => {
          const rows = active.db
            .prepare(
              `SELECT name FROM ${master}
                WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name ASC`,
            )
            .all(type) as Array<{ name: string }>;
          return rows.map((r) => String(r.name));
        };
        await group('tables', () => nameList('table'));
        await group('views', () => nameList('view'));
        // 隐式索引（sqlite_autoindex_*）已经在 SQL 里被过滤掉：它们没有用户可读的名字
        await group('indexes', () => nameList('index'));
        await group('triggers', () => nameList('trigger'));
      }

      if (Object.keys(errors).length > 0) objects.errors = errors;
      return { ok: true, objects };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  /**
   * 获取单表的字段元数据
   */
  async getTableSchema(
    connectionId: string,
    tableName: string,
    schemaName?: string,
  ): Promise<{ ok: boolean; columns: DatabaseColumnMeta[]; error?: string }> {
    const active = this.findActive(connectionId);
    if (!active) {
      return { ok: false, columns: [], error: '未找到该数据库连接' };
    }

    try {
      if (active.type === 'mysql') {
        const schema = schemaName || active.info.database;
        // 优先走 information_schema：只有它带 COLUMN_COMMENT，而 `DESCRIBE` 取不到注释。
        // 但某些受限账号读不到 information_schema，所以失败时回退到 DESCRIBE（那时没有注释）。
        try {
          const [rows] = await active.db.query(
            `SELECT COLUMN_NAME AS name,
                    COLUMN_TYPE AS type,
                    IS_NULLABLE AS nullable,
                    COLUMN_DEFAULT AS dflt,
                    COLUMN_KEY AS colkey,
                    COLUMN_COMMENT AS comment,
                    EXTRA AS extra,
                    ORDINAL_POSITION AS pos
               FROM information_schema.columns
              WHERE table_schema = ? AND table_name = ?
              ORDER BY ORDINAL_POSITION`,
            [schema, tableName],
          );
          const columns: DatabaseColumnMeta[] = (rows as any[]).map((r, idx) => ({
            cid: Number.isFinite(Number(r.pos)) ? Number(r.pos) - 1 : idx,
            name: String(r.name),
            type: r.type ? String(r.type).toUpperCase() : 'VARCHAR',
            notnull: r.nullable === 'NO',
            dflt_value: r.dflt,
            pk: r.colkey === 'PRI',
            comment: r.comment ? String(r.comment) : null,
            extra: r.extra ? String(r.extra) : null,
          }));
          return { ok: true, columns };
        } catch {
          const [rows] = await active.db.query(
            `DESCRIBE ${qualify('mysql', schema, tableName)}`,
          );
          const columns: DatabaseColumnMeta[] = (rows as any[]).map((r, idx) => ({
            cid: idx,
            name: r.Field,
            type: r.Type ? String(r.Type).toUpperCase() : 'VARCHAR',
            notnull: r.Null === 'NO',
            dflt_value: r.Default,
            pk: r.Key === 'PRI',
            comment: null,
            // DESCRIBE 的 Extra 列就是 information_schema 的 EXTRA（自增、on update 等）
            extra: r.Extra ? String(r.Extra) : null,
          }));
          return { ok: true, columns };
        }
      }

      if (active.type === 'postgres') {
        const schema = schemaName || 'public';
        // 列注释在 pg_description 里（information_schema 不暴露它），左连一次拿回来；
        // 用 col_description 也等价，但那个函数要表的 oid，join 一遍更省事
        const res = await active.db.query(
          `SELECT c.column_name, c.data_type, c.is_nullable, c.column_default,
                  c.ordinal_position, d.description
             FROM information_schema.columns c
             LEFT JOIN pg_catalog.pg_class cl
                    ON cl.relname = c.table_name
             LEFT JOIN pg_catalog.pg_namespace ns
                    ON ns.oid = cl.relnamespace AND ns.nspname = c.table_schema
             LEFT JOIN pg_catalog.pg_description d
                    ON d.objoid = cl.oid AND d.objsubid = c.ordinal_position
            WHERE c.table_schema = $1 AND c.table_name = $2
            ORDER BY c.ordinal_position`,
          [schema, tableName],
        );
        // 主键列单独取一次（pg_index + pg_attribute）
        const pkRes = await active.db.query(
          `SELECT a.attname AS name
             FROM pg_index i
             JOIN pg_class c ON c.oid = i.indrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
            WHERE i.indisprimary AND n.nspname = $1 AND c.relname = $2`,
          [schema, tableName],
        );
        const pkSet = new Set<string>((pkRes.rows as any[]).map((r) => String(r.name)));
        const columns: DatabaseColumnMeta[] = (res.rows as any[]).map((r, idx) => ({
          cid: idx,
          name: String(r.column_name),
          type: String(r.data_type || '').toUpperCase(),
          notnull: r.is_nullable === 'NO',
          dflt_value: r.column_default,
          pk: pkSet.has(String(r.column_name)),
          comment: r.description ? String(r.description) : null,
          // PostgreSQL 的列没有 EXTRA 这个概念（自增是 SERIAL 类型 / identity 属性）
          extra: null,
        }));
        return { ok: true, columns };
      }

      const schema = schemaName || 'main';
      const pragma = schema === 'main' ? 'main' : schema;
      const stmt = active.db.prepare(
        `PRAGMA ${quoteIdent('sqlite', pragma)}.table_info(${quoteIdent('sqlite', tableName)})`,
      );
      const rawCols = stmt.all() as any[];
      const columns: DatabaseColumnMeta[] = rawCols.map((c) => ({
        cid: c.cid,
        name: c.name,
        type: c.type || 'TEXT',
        notnull: Boolean(c.notnull),
        dflt_value: c.dflt_value,
        pk: Boolean(c.pk),
        // SQLite 没有列注释这个概念：如实给 null，不编造
        comment: null,
        // 自增在 SQLite 里是 `INTEGER PRIMARY KEY` 的固有语义（rowid 别名），没有单独属性
        extra: null,
      }));

      return { ok: true, columns };
    } catch (err: any) {
      return { ok: false, columns: [], error: err.message || String(err) };
    }
  }

  /**
   * 获取单表的 DDL 创建语句
   *
   * 注意：PostgreSQL 没有 MySQL 的 `SHOW CREATE TABLE`，这里由列元数据**重建** CREATE TABLE，
   * 不包含索引、外键、CHECK 约束（属于已知限制）。
   */
  async getTableDdl(
    connectionId: string,
    tableName: string,
    schemaName?: string,
  ): Promise<{ ok: boolean; ddl?: string; error?: string }> {
    const active = this.findActive(connectionId);
    if (!active) {
      return { ok: false, error: '未找到该数据库连接' };
    }

    try {
      if (active.type === 'mysql') {
        const schema = schemaName || active.info.database;
        const [rows] = await active.db.query(
          `SHOW CREATE TABLE ${qualify('mysql', schema, tableName)}`,
        );
        if (Array.isArray(rows) && rows[0]) {
          const createSql =
            (rows[0] as any)['Create Table'] || (rows[0] as any)['Create View'];
          if (createSql) {
            return { ok: true, ddl: `${createSql};\n` };
          }
        }
        return { ok: false, error: `未找到表 ${tableName} 的 DDL 定义` };
      }

      if (active.type === 'postgres') {
        const schema = schemaName || 'public';
        const cols = await this.getTableSchema(connectionId, tableName, schema);
        if (!cols.ok || cols.columns.length === 0) {
          return { ok: false, error: cols.error || `未找到表 ${tableName} 的列定义` };
        }
        const lines = cols.columns.map((c) => {
          let line = `  ${quoteIdent('postgres', c.name)} ${c.type}`;
          if (c.notnull) line += ' NOT NULL';
          if (c.dflt_value !== null && c.dflt_value !== undefined) {
            line += ` DEFAULT ${c.dflt_value}`;
          }
          return line;
        });
        const pkCols = cols.columns.filter((c) => c.pk).map((c) => quoteIdent('postgres', c.name));
        if (pkCols.length > 0) {
          lines.push(`  PRIMARY KEY (${pkCols.join(', ')})`);
        }
        const ddl =
          `-- PostgreSQL 无服务端原始 DDL，以下由列元数据重建（不含索引 / 外键 / CHECK 约束）\n` +
          `CREATE TABLE ${qualify('postgres', schema, tableName)} (\n${lines.join(',\n')}\n);\n`;
        return { ok: true, ddl };
      }

      const schema = schemaName || 'main';
      const master = qualify('sqlite', schema === 'main' ? undefined : schema, 'sqlite_master');
      const stmt = active.db.prepare(
        `SELECT sql FROM ${master} WHERE type IN ('table', 'view') AND name = ?`,
      );
      const row = stmt.get(tableName) as { sql: string } | undefined;
      if (!row || !row.sql) {
        return { ok: false, error: `未找到表 ${tableName} 的 DDL 定义` };
      }
      return { ok: true, ddl: `${row.sql};\n` };
    } catch (err: any) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  /**
   * 执行 SQL 查询
   *
   * `schemaName` 会在执行前按需切换连接会话的默认库 / search_path，
   * 因此「全部行执行」时脚本里的 `use xxx;` 能自然影响后续语句。
   */
  async query(
    connectionId: string,
    sql: string,
    page?: number,
    pageSize?: number,
    schemaName?: string,
  ): Promise<DatabaseQueryResult> {
    const startTime = performance.now();
    const active = this.findActive(connectionId);
    if (!active) {
      return {
        ok: false,
        columns: [],
        rows: [],
        executionTimeMs: 0,
        error: '数据库连接已断开，请重新连接',
      };
    }

    const trimmed = sql.trim();
    if (!trimmed) {
      return {
        ok: true,
        columns: [],
        rows: [],
        executionTimeMs: 0,
      };
    }

    // 批次事务进行中：这条语句若放进去会跟着一起被提交或回滚，结果对用户是随机的。
    // 宁可明确拒绝，也不要给出一个说不清归属的执行结果。
    if (active.batchRunning) {
      return {
        ok: false,
        columns: [],
        rows: [],
        executionTimeMs: 0,
        error: '该连接正在执行批量提交，请稍后重试',
      };
    }

    const elapsed = () => Number((performance.now() - startTime).toFixed(2));

    try {
      // 切库：MySQL 的 USE / PostgreSQL 的 SET search_path（会话级，仅在与缓存不同时下发）
      await this.applySchema(active, schemaName);

      const executeSql = applyPagination(trimmed, page, pageSize);
      const isSelect = looksLikeSelect(trimmed);

      // 脚本里直接写 `USE xxx` 时同步刷新缓存，避免下一次调用误判会话当前库
      const useMatch = /^\s*use\s+(`[^`]+`|"[^"]+"|[\w$]+)\s*;?\s*$/i.exec(trimmed);
      if (useMatch) {
        active.currentSchema = useMatch[1].replace(/^[`"]|[`"]$/g, '');
      }

      if (active.type === 'mysql') {
        const [results, fields] = await active.db.query(executeSql);

        if (isSelect) {
          const rows = Array.isArray(results) ? (results as Record<string, any>[]) : [];
          let columns: string[] = [];
          if (Array.isArray(fields) && fields.length > 0) {
            columns = fields.map((f: any) => f.name);
          } else if (rows.length > 0) {
            columns = Object.keys(rows[0]);
          }
          return {
            ok: true,
            columns,
            rows,
            total: rows.length,
            executionTimeMs: elapsed(),
          };
        }

        const affectedRows = (results as any)?.affectedRows ?? 0;
        return {
          ok: true,
          columns: [],
          rows: [],
          affectedRows,
          executionTimeMs: elapsed(),
        };
      }

      if (active.type === 'postgres') {
        const res = await active.db.query(executeSql);
        // pg 即使返回 0 行也会带上 fields，因此列名始终可从 fields 取到
        const hasFields = Array.isArray(res.fields) && res.fields.length > 0;
        if (hasFields) {
          const rows = (res.rows as Record<string, any>[]) || [];
          return {
            ok: true,
            columns: (res.fields as any[]).map((f) => String(f.name)),
            rows,
            total: rows.length,
            executionTimeMs: elapsed(),
          };
        }
        return {
          ok: true,
          columns: [],
          rows: [],
          affectedRows: typeof res.rowCount === 'number' ? res.rowCount : 0,
          executionTimeMs: elapsed(),
        };
      }

      // SQLite
      const stmt = active.db.prepare(executeSql);
      let rows: Record<string, any>[] = [];
      let columns: string[] = [];
      let affectedRows: number | undefined;

      if (isSelect) {
        rows = (stmt.all() as any[]) || [];
        if (rows.length > 0) {
          columns = Object.keys(rows[0]);
        } else {
          // node:sqlite 的 statement 没有 columnNames()，但有 columns()，空结果集也能拿到列名
          try {
            const cols = stmt.columns?.();
            if (Array.isArray(cols)) {
              columns = cols.map((c: any) => String(c.name ?? c.column));
            }
          } catch {
            // ignore
          }
        }
      } else {
        const runRes = stmt.run();
        affectedRows = runRes?.changes || 0;
      }

      return {
        ok: true,
        columns,
        rows,
        affectedRows,
        executionTimeMs: elapsed(),
      };
    } catch (err: any) {
      return {
        ok: false,
        columns: [],
        rows: [],
        executionTimeMs: elapsed(),
        error: err.message || String(err),
      };
    }
  }

  /**
   * 一键创建示例 SQLite 数据库
   */
  async createDemoDb(
    targetPath?: string,
  ): Promise<{
    ok: boolean;
    path: string;
    connection: DatabaseConnectionInfo;
    error?: string;
  }> {
    if (!SqliteDatabaseSync) {
      return {
        ok: false,
        path: '',
        connection: {} as any,
        error: '当前环境暂未支持 node:sqlite',
      };
    }

    try {
      const savePath =
        targetPath ||
        path.join(process.cwd(), `echoly_demo_${Date.now().toString(36)}.db`);

      const db = new SqliteDatabaseSync(savePath);

      // 创建 users 表并插入示例数据
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE,
          email TEXT,
          role TEXT DEFAULT 'developer',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

      db.exec(`
        INSERT INTO users (username, email, role) VALUES
          ('alice', 'alice@echoly.dev', 'admin'),
          ('bob', 'bob@echoly.dev', 'developer'),
          ('charlie', 'charlie@echoly.dev', 'tester'),
          ('david', 'david@echoly.dev', 'designer'),
          ('eva', 'eva@echoly.dev', 'developer');
      `);

      // 创建 orders 表
      db.exec(`
        CREATE TABLE IF NOT EXISTS orders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER,
          product_name TEXT NOT NULL,
          amount REAL NOT NULL,
          status TEXT DEFAULT 'completed',
          FOREIGN KEY (user_id) REFERENCES users(id)
        );
      `);

      db.exec(`
        INSERT INTO orders (user_id, product_name, amount, status) VALUES
          (1, 'Echoly Pro Subscription', 99.0, 'completed'),
          (2, 'Cloud GPU Compute 100h', 299.5, 'completed'),
          (1, 'Agent API Token Pack', 49.0, 'pending'),
          (3, 'Developer License', 199.0, 'completed');
      `);

      // 创建 logs 表
      db.exec(`
        CREATE TABLE IF NOT EXISTS system_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          level TEXT DEFAULT 'INFO',
          message TEXT NOT NULL,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

      db.exec(`
        INSERT INTO system_logs (level, message) VALUES
          ('INFO', 'Database initialized successfully'),
          ('INFO', 'AI Agent server connected'),
          ('WARN', 'High memory usage detected on worker-1'),
          ('INFO', 'Scheduled backup finished');
      `);

      const savedId = makeSavedId({ type: 'sqlite', path: savePath });
      const info: DatabaseConnectionInfo = {
        id: `sqlite_demo_${Date.now()}`,
        name: 'Echoly Demo DB',
        type: 'sqlite',
        path: savePath,
        connectedAt: Date.now(),
      };

      this.connections.set(info.id, {
        info,
        db,
        type: 'sqlite',
        currentSchema: 'main',
        savedId,
      });
      // 示例库也随项目保存，重启后仍能从连接树里点开
      await this.persistAfterConnect(
        { name: info.name, savedId },
        { name: info.name, type: 'sqlite', path: savePath, savedId },
      );
      return { ok: true, path: savePath, connection: info };
    } catch (err: any) {
      return {
        ok: false,
        path: '',
        connection: {} as any,
        error: `创建示例数据库失败: ${err.message || String(err)}`,
      };
    }
  }
}

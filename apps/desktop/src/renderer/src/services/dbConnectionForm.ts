/**
 * 新建数据库连接表单的纯逻辑（校验 + 端口兜底），无 React 依赖，便于 vitest 直接单测。
 */

export type DbDriverType = 'sqlite' | 'mysql' | 'postgres';

export const DEFAULT_PORTS: Record<Exclude<DbDriverType, 'sqlite'>, number> = {
  mysql: 3306,
  postgres: 5432,
};

export interface DbConnectionForm {
  driver: DbDriverType;
  sqlitePath: string;
  host: string;
  port: string;
  database: string;
  username: string;
}

/**
 * 校验失败的原因。
 *
 * 返回**码**而不是中文句子：这里没有 i18n 上下文（纯逻辑模块，vitest 直接单测），
 * 返回文案就等于把英文环境钉死在中文上。调用点在渲染层，那里把码翻成字典 key。
 */
export type DbFormErrorCode =
  | 'sqlite-path-required'
  | 'host-required'
  | 'port-not-number'
  | 'port-out-of-range'
  | 'username-required'
  | 'database-required';

export interface DbConnectionValidation {
  ok: boolean;
  /** 第一个阻断性问题的原因码 */
  errorCode?: DbFormErrorCode;
  /** 原因码对应的插值参数（目前只有 host-required 需要驱动名） */
  params?: Record<string, string>;
}

export const DB_FORM_ERROR_KEY: Record<DbFormErrorCode, string> = {
  'sqlite-path-required': 'db.formErrSqlitePath',
  'host-required': 'db.formErrHost',
  'port-not-number': 'db.formErrPortNumber',
  'port-out-of-range': 'db.formErrPortRange',
  'username-required': 'db.formErrUsername',
  'database-required': 'db.formErrDatabase',
};

/**
 * 驱动对应的默认端口文本，用于**预填输入框**（不是占位符）。
 * SQLite 没有端口概念，返回空串。切换驱动时用它重置端口值。
 */
export function defaultPortFor(driver: DbDriverType): string {
  if (driver === 'sqlite') return '';
  return String(driver === 'postgres' ? DEFAULT_PORTS.postgres : DEFAULT_PORTS.mysql);
}

/**
 * 端口兜底：留空时用驱动默认端口。
 * 注意这里**只在提交/测试连接时**调用，输入框本身必须直接绑定原始字符串，
 * 否则用户无法清空重输（清空会被立刻回填成默认端口）。
 */
export function resolvePort(driver: DbDriverType, port: string): number {
  const trimmed = port.trim();
  if (!trimmed) return driver === 'postgres' ? DEFAULT_PORTS.postgres : DEFAULT_PORTS.mysql;
  return Number(trimmed);
}

export function validateDbConnection(form: DbConnectionForm): DbConnectionValidation {
  if (form.driver === 'sqlite') {
    if (!form.sqlitePath.trim()) {
      return { ok: false, errorCode: 'sqlite-path-required' };
    }
    return { ok: true };
  }

  if (!form.host.trim()) {
    return {
      ok: false,
      errorCode: 'host-required',
      params: { driver: form.driver === 'postgres' ? 'PostgreSQL' : 'MySQL' },
    };
  }

  const portText = form.port.trim();
  if (portText) {
    if (!/^\d+$/.test(portText)) {
      return { ok: false, errorCode: 'port-not-number' };
    }
    const portNum = Number(portText);
    if (portNum < 1 || portNum > 65535) {
      return { ok: false, errorCode: 'port-out-of-range' };
    }
  }

  if (!form.username.trim()) {
    return { ok: false, errorCode: 'username-required' };
  }

  if (form.driver === 'postgres' && !form.database.trim()) {
    return { ok: false, errorCode: 'database-required' };
  }

  return { ok: true };
}

// ── 从连接树点击「未连接」节点时的准入判断 ────────────────────────────────────

export type DbPreflightAction =
  /** 配置里存了密码，直接重连 */
  | 'reconnect'
  /** 配置里没存密码（或配置已不在），需要用户先补上，打开编辑弹窗 */
  | 'prompt-password'
  /** 配置还没读到，或状态异常：重拉一次列表再说 */
  | 'unknown';

/** 点「未连接」节点时，手头这条配置能不能直接连 */
export interface DbPreflightView {
  connected?: boolean;
  passwordSaved?: boolean;
  requiresPassword?: boolean;
  type?: string;
}

/**
 * 决定「点击未连接的连接节点」该做什么。
 *
 * 关键背景：`connected: false` 只是个快照，切工作区时主进程会先断开全部连接，
 * 于是每次重开项目都会看到一批「未连接」节点 —— 那是**正常状态**，点一下就该连上。
 * 所以这里不能简单地「没连接就提示错误」，而要区分：
 * - 存了密码（SQLite 天然不需要）→ 直接重连，只有真的连不上才报错；
 * - 没存密码 → 先让用户补密码，而不是拿空密码去连、拿到一个看不懂的鉴权错误。
 *
 * 刻意不做 SQLite 文件存在性预检：SQLite 由主进程用本地 `node:fs` 打开（不是远端），
 * `connect()` 在文件缺失时已经会返回「数据库文件不存在: <路径>」这句中文，重复一层预检
 * 反而会在 SSH 工作区里用错文件系统、误报「文件不存在」。
 */
export function checkConnectionPreflight(
  view: DbPreflightView | undefined,
): { action: DbPreflightAction; reason?: string } {
  if (!view) return { action: 'unknown' };
  if ((view.type || '') === 'sqlite') return { action: 'reconnect' };
  if (view.passwordSaved) return { action: 'reconnect' };
  if (view.requiresPassword) return { action: 'prompt-password' };
  return { action: 'unknown' };
}

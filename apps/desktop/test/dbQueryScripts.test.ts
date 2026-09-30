import { describe, expect, it } from 'vitest';
import {
  QUERIES_DIR,
  connectionIdFromTabPath,
  consoleTabPath,
  isQueryScriptName,
  nextScriptFileName,
  safeScriptSegment,
  scriptDirFor,
  scriptFileNameFromTabPath,
  scriptPathFor,
  scriptTitleFromFileName,
  NEW_CONSOLE_SQL,
} from '../src/renderer/src/services/dbQueryScripts';

/**
 * SQL 控制台脚本的落盘路径与命名回归。
 *
 * 这里钉死两件事：
 * 1. **路径不会逃出工作区**。库名是用户可控输入，能带分隔符、中文、空格，
 *    拼进路径前必须消毒 —— 否则一个叫 `../../` 的库就能把脚本写到项目外面。
 * 2. **标签路径与脚本路径是两回事**。标签路径不含库（换库不换标签），
 *    脚本路径含库（同一段 SQL 在不同库里各存一份）。两者不能互相推导，只能各自算。
 */

describe('safeScriptSegment 路径片段消毒', () => {
  it('分隔符与路径上有特殊含义的字符被替换掉，不会拼出跨级路径', () => {
    // `/` 与 `\` 是分隔符；`..` 单独处理，否则 `a/../..` 会翻到上层目录
    expect(safeScriptSegment('..', 'fb')).not.toContain('..');
    expect(safeScriptSegment('../../etc', 'fb')).not.toContain('..');
    expect(safeScriptSegment('a/b', 'fb')).toBe('a_b');
    expect(safeScriptSegment('a\\b', 'fb')).toBe('a_b');
    expect(safeScriptSegment('..\\..\\win', 'fb')).not.toContain('..');
    expect(safeScriptSegment('a/b', 'fb')).not.toContain('/');
  });

  it('Windows 保留字符被替换，中文与空格照常保留', () => {
    expect(safeScriptSegment('a:b*c?d"e<f>g|h', 'fb')).toBe('a_b_c_d_e_f_g_h');
    // 库名带中文是常态（MySQL 允许），不能被消毒掉
    expect(safeScriptSegment('订单库', 'fb')).toBe('订单库');
    expect(safeScriptSegment('my db', 'fb')).toBe('my db');
  });

  it('空 / 全空白 / 未定义退回 fallback，不产生空路径段', () => {
    expect(safeScriptSegment(undefined, 'fb')).toBe('fb');
    expect(safeScriptSegment('', 'fb')).toBe('fb');
    expect(safeScriptSegment('   ', 'fb')).toBe('fb');
    // 纯点串在替换阶段就被压成 `_`，同样不是合法的上级目录引用
    expect(safeScriptSegment('...', 'fb')).not.toContain('..');
    expect(safeScriptSegment('...', 'fb').length).toBeGreaterThan(0);
    // 前后空白会被 trim，避免出现 `a ` 这种在 Windows 上静默丢尾空格的目录名
    expect(safeScriptSegment('  cvm  ', 'fb')).toBe('cvm');
  });

  it('超长名字被截断，避免超出文件系统单段上限', () => {
    expect(safeScriptSegment('x'.repeat(500), 'fb').length).toBe(80);
  });
});

describe('脚本目录与完整路径', () => {
  it('按「连接 → 库」两层分层，落在项目配置目录的 queries/ 之下', () => {
    expect(scriptDirFor('db_mysql_a1b2', 'cvm')).toBe(`${QUERIES_DIR}/db_mysql_a1b2/cvm`);
    expect(scriptPathFor('db_mysql_a1b2', 'cvm', '查询 1.sql')).toBe(
      `${QUERIES_DIR}/db_mysql_a1b2/cvm/查询 1.sql`,
    );
  });

  it('没有库时用 `_` 占位，路径仍是两层（不会退化成连库名都没有的一层）', () => {
    expect(scriptDirFor('db_mysql_a1b2', undefined)).toBe(`${QUERIES_DIR}/db_mysql_a1b2/_`);
  });

  it('同名脚本在不同连接 / 不同库下互不覆盖', () => {
    const a = scriptPathFor('conn-a', 'cvm', '查询 1.sql');
    const b = scriptPathFor('conn-a', 'other', '查询 1.sql');
    const c = scriptPathFor('conn-b', 'cvm', '查询 1.sql');
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('恶意库名不会让脚本落到 queries/ 之外', () => {
    for (const evil of ['..', '../..', '../../etc', 'a/../../b', '..\\..']) {
      const p = scriptPathFor('conn-a', evil, 'x.sql');
      expect(p.startsWith(`${QUERIES_DIR}/conn-a/`)).toBe(true);
      expect(p).not.toContain('..');
    }
  });

  it('文件名同样被消毒，不会借脚本名跨目录', () => {
    const p = scriptPathFor('conn-a', 'cvm', '../../evil.sql');
    expect(p.startsWith(`${QUERIES_DIR}/conn-a/cvm/`)).toBe(true);
    expect(p).not.toContain('..');
  });
});

describe('控制台标签路径', () => {
  it('只有连接与文件名两段，库不在标签路径里', () => {
    // 标签路径不含库：换库只改执行目标，不该把用户手里的脚本挪个地方
    const p = consoleTabPath('conn-1', '查询 1.sql');
    expect(p).toBe('db://console/conn-1/%E6%9F%A5%E8%AF%A2%201.sql');
    expect(p.split('/').length).toBe(5);
  });

  it('编码后可被无损反解析（中文连接 id / 中文库名派生的脚本名）', () => {
    const path = consoleTabPath('连接 一', '查询 1.sql');
    expect(connectionIdFromTabPath(path)).toBe('连接 一');
    expect(scriptFileNameFromTabPath(path)).toBe('查询 1.sql');
  });

  it('同一个脚本名在同一连接下路径稳定：重复打开只切前台，不新开标签', () => {
    expect(consoleTabPath('conn-1', '查询 1.sql')).toBe(consoleTabPath('conn-1', '查询 1.sql'));
    // 但不同连接的同名脚本必须是两个独立标签
    expect(consoleTabPath('conn-1', 'x.sql')).not.toBe(consoleTabPath('conn-2', 'x.sql'));
  });

  it('兼容早期的三段式路径：取最后一段当文件名、第一段当连接', () => {
    const legacy = 'db://console/conn-1/cvm/ab12c.sql';
    expect(scriptFileNameFromTabPath(legacy)).toBe('ab12c.sql');
    expect(connectionIdFromTabPath(legacy)).toBe('conn-1');
  });
});

describe('新脚本命名', () => {
  it('从 1 起找第一个空位，而不是最大值 +1', () => {
    // 用户删掉「查询 2」之后，新开的应该补上这个号，否则号码会一路涨
    expect(nextScriptFileName(['查询 1.sql', '查询 3.sql'])).toBe('查询 2.sql');
    expect(nextScriptFileName([])).toBe('查询 1.sql');
    expect(nextScriptFileName(['查询 1.sql', '查询 2.sql'])).toBe('查询 3.sql');
  });

  it('已落盘的与已打开标签的名字都要计入 taken，否则会撞名', () => {
    // 只传其中一个就会返回已被占用的名字
    const taken = ['查询 1.sql', '查询 2.sql'];
    expect(taken).not.toContain(nextScriptFileName(taken));
  });

  it('空位被填满后退回时间戳，保证不重名', () => {
    const all = Array.from({ length: 9999 }, (_, i) => `查询 ${i + 1}.sql`);
    const name = nextScriptFileName(all);
    expect(all).not.toContain(name);
    expect(name.endsWith('.sql')).toBe(true);
  });

  it('支持自定义主名', () => {
    expect(nextScriptFileName(['users.sql'], 'users')).toBe('users 1.sql');
  });
});

describe('脚本名判定与标签标题', () => {
  it('只认 .sql（不区分大小写）', () => {
    expect(isQueryScriptName('查询 1.sql')).toBe(true);
    expect(isQueryScriptName('QUERY.SQL')).toBe(true);
    expect(isQueryScriptName('查询 1.sql.bak')).toBe(false);
    expect(isQueryScriptName('notes.txt')).toBe(false);
    expect(isQueryScriptName('sql')).toBe(false);
  });

  it('标题剥掉后缀，「查询 1.sql」显示成「查询 1」', () => {
    expect(scriptTitleFromFileName('查询 1.sql')).toBe('查询 1');
    expect(scriptTitleFromFileName('users.SQL')).toBe('users');
    // 剥完是空的时候退回默认名，标签上不能出现空标题
    expect(scriptTitleFromFileName('.sql')).toBe('查询');
  });
});

describe('新建控制台的预置语句', () => {
  it('以注释开头，执行它是安全的（不会误伤数据）', () => {
    expect(NEW_CONSOLE_SQL.startsWith('--')).toBe(true);
    expect(NEW_CONSOLE_SQL).toContain('SELECT 1;');
  });
});

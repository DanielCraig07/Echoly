import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DICT, DICT_PARTS } from '../src/renderer/src/i18n';

/**
 * 源码与字典之间的双向对账。
 *
 * 为什么要专门测这个：`translate()` 查不到 key 时**原样返回 key**（故意的，
 * 免得把缺口藏起来）。但它不崩、不打日志、没有类型错误 —— 界面上那一格安静地
 * 显示成 `git.stageAll`，而且中英文显示的是同一个东西，所以「切到英文看看」
 * 也发现不了。只有人盯着那一屏才会注意到。
 *
 * 扫描用正则而不是 AST：要认的就是 `t('x')` 这种调用形状，AST 更准，
 * 但为它拉一整个 parser 依赖不划算。代价是**模板字符串里的动态 key**
 * （如 t(`tree.moveReject.${code}`)）扫不到，见文末 DYNAMIC_KEY_PREFIXES。
 */

const RENDERER_ROOT = join(__dirname, '../src/renderer/src');

/** i18n 自身：里面出现的 'a.b' 字样是字典内容，不是「被引用的 key」 */
function isI18nInternals(file: string): boolean {
  return file.endsWith(`${join('', 'i18n.ts')}`) || file.includes(join('src', 'i18nParts'));
}

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...collectSourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(name)) continue;
    if (isI18nInternals(full)) continue;
    out.push(full);
  }
  return out;
}

const KEY_SHAPE = /^[a-zA-Z][\w]*(?:\.[\w]+)+$/;

/**
 * 只认**调用形状**后面的字面量 key。
 *
 * 不这么做的话，`'echoly.terminal.wordWrap'`（localStorage key）、`'pom.xml'`
 * （文件名）这类字符串形状和 i18n key 一模一样，任何一次全量字面量扫描都会把它们
 * 当成 key 然后报「字典里没有」。要求它紧跟在 `t(` / `translate(` 之后，才算数。
 */
const CALL_PATTERN = /\b(?:t|translate|translateWith|translateSegments)\(\s*'([^'\n]+)'/g;

/** 出现过的**所有**形如 key 的字面量（用于反方向：判断一条字典项有没有人用） */
const ANY_KEY_SHAPE_LITERAL = /'([a-zA-Z][\w]*(?:\.[\w]+)+)'/g;

/**
 * 只在这两类文件里找「被引用的 key」：
 * 引了 i18n 的，和**定义了 key 表的**（如 `DB_DDL_ERROR_KEY: Record<DbDdlErrorCode, string>`）。
 * 这是个宽口径 —— 它会把同文件里的 localStorage key 也收进来，但反方向问的是
 * 「字典里这条有没有人用」，多收一些字面量只会**少报**死 key，不会误报，
 * 而误报会让这条测试被无视，比漏报更糟。
 *
 * 为什么要认 key 表：服务层的纯逻辑模块（`dbDdl` / `dbConnectionForm`）拿不到 i18n 上下文，
 * 于是把「原因码 → key」写成一张表，组件再 `t(KEY_TABLE[code])` 取。扫调用形状看不到这种
 * 间接引用，这些条目就会被误报成死 key —— 而它们恰恰是**接得最紧的那种引用**。
 * 与其让人一条条往 DYNAMIC_KEY_PREFIXES 里补前缀，不如直接认这张表。
 */
const KEY_TABLE_PATTERN = /export const \w*KEY\w*\s*:\s*Record<[^>]*,\s*string>/;

function referencesIn(file: string): Set<string> {
  const source = readFileSync(file, 'utf8');
  const refs = new Set<string>();
  const importsI18n = source.includes('useI18n') || source.includes("i18n'");
  if (!importsI18n && !KEY_TABLE_PATTERN.test(source)) return refs;
  for (const m of source.matchAll(ANY_KEY_SHAPE_LITERAL)) refs.add(m[1]);
  return refs;
}

describe('i18n key 引用完整性', () => {
  const files = collectSourceFiles(RENDERER_ROOT);

  it('扫到了源码（避免文件列表为空而永远绿）', () => {
    // 这组测试的典型失败模式是「什么都没检查」：目录名一改、扩展名一换，
    // collectSourceFiles 返回空数组，下面每条断言就退化成空集等于空集。
    expect(files.length).toBeGreaterThan(50);
  });

  it('源码里用到的 key 都在字典里', () => {
    const missing = new Map<string, string[]>();
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const m of source.matchAll(CALL_PATTERN)) {
        const key = m[1];
        if (!KEY_SHAPE.test(key)) continue;
        if (DICT[key]) continue;
        const short = relative(RENDERER_ROOT, file);
        missing.set(key, [...(missing.get(key) ?? []), short]);
      }
    }
    const report = [...missing.entries()]
      .map(([key, where]) => `${key}  ←  ${[...new Set(where)].join(', ')}`)
      .sort();
    expect(report, '这些 key 被用了但字典里没有，界面上会直接显示 key 本身').toEqual([]);
  });

  /**
   * 反方向只查**分片**里的 key。
   *
   * 主表 CORE_DICT 是骨架期一次写下的，里面本来就有还没接上的条目（比如给原生菜单
   * 留的 `menu.*`），把它们一起算进来，第一次跑就会红一片真正无害的东西。
   * 分片是这次铺开过程中新加的：每加一条都对应一处刚翻完的文案，
   * 出现「加了却没人用」说明 key 名或调用点写错了一个字。
   */
  it('分片里的 key 都有引用', () => {
    const used = new Set<string>();
    for (const file of files) for (const key of referencesIn(file)) used.add(key);

    const partKeys = Object.entries(DICT_PARTS).flatMap(([part, entries]) =>
      Object.keys(entries).map((key) => ({ part, key })),
    );
    expect(partKeys.length, '分片是空的，这条测试等于没跑').toBeGreaterThan(0);

    const dead = partKeys
      .filter(({ key }) => !used.has(key))
      // 动态拼出来的 key 扫不到，别误报
      .filter(({ key }) => !DYNAMIC_KEY_PREFIXES.some((p) => key.startsWith(p)))
      .map(({ part, key }) => `${key}  (i18nParts/${part}.ts)`)
      .sort();

    expect(dead, '分片里这些 key 没有任何地方在用，要么是改名后的残留，要么是拼错了').toEqual([]);
  });
});

/**
 * 由模板字符串拼出来的 key 前缀。
 *
 * `t(\`tree.moveReject.${code}\`)` 这条调用里，扫描只看得到调用形状后面的字面量，
 * 而这里根本没有字面量，所以整个前缀下的条目都无法静态验证，只能整体排除。
 * **新增动态 key 时记得往这里加一行**，否则上面那条会开始误报。
 */
const DYNAMIC_KEY_PREFIXES: string[] = [
  'tree.moveReject.',
  // 权限档位的短标签 / 完整说明按 `PermissionMode` 拼出：t(`chat.permShort.${mode}`)
  'chat.permShort.',
  'chat.permFull.',
  // 数据库面板：分组空态按 `DbObjectGroup` 拼出：t(`db.emptyGroup.${group}`)
  'db.emptyGroup.',
  // 库层级的称呼按驱动查表（db.noun.schema / db.noun.database），库层级称呼由 dbLevelNoun 取
  'db.noun.',
  // 筛选运算符名走「运算符 → key」查表（db.op.*），表在 i18nParts/db.ts 里
  'db.op.',
  // 排序方向词由 dbDescribeSort 取（db.sortAscWord / db.sortDescWord）
  'db.sortAscWord',
  'db.sortDescWord',
];

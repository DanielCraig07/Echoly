import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

/**
 * 项目级配置的落盘位置。
 *
 * 为什么**不放在项目里**：把 `.echoly/` 写进工作区，会在用户的项目里凭空多出一个目录 ——
 * 它出现在文件树里、出现在 `git status` 里、出现在打包和构建脚本的遍历里，用户得先弄明白
 * 这是什么才敢删。而这些内容（连接配置里的密码、随手写的查询脚本）本来就不是项目的一部分：
 * 换台机器 clone 下来，那份 `db-connections.json` 对他毫无用处，里面的密文还解不开。
 *
 * 但配置又必须**跟项目绑定** —— 在 A 项目里看到的连接列表，切到 B 项目就该换掉。做法是按
 * 工作区根的哈希分目录：项目在哪台机器、放在哪个路径下，就落到哪个目录，互不串味。
 *
 * 目录名用哈希而不是项目名：路径本身可能带用户名、带客户名，而 `~/.echoly/projects/` 是
 * 一个一眼能看全的地方。要人工辨认某个目录属于哪个项目，读该目录下的 `project.json`。
 *
 * 这里刻意**不放进 packages/shared**：渲染层的 bundle 跑在沙箱化的渲染进程里，
 * 不该为了几个字符串推导就把 node:crypto 拖进去。主进程单独持有这份规则即可。
 */

/** 配置根目录：`~/.echoly/projects/<哈希>` */
export const PROJECTS_DIR_NAME = 'projects';

/** 目录内标明「这是谁」的元数据文件名 */
export const PROJECT_META_FILE = 'project.json';

/**
 * 配置目录的标识长度。
 *
 * 12 位十六进制 = 48 bit：同一台机器上几十上百个项目撞车的概率可以忽略，
 * 而目录名还不至于长到在 `ls` 里难认。
 */
const HASH_LENGTH = 12;

/**
 * 把工作区根压成稳定的目录标识。
 *
 * 同一路径必须每次都得到同一个哈希，否则用户会「切个项目回来就丢了连接列表」。
 * 归一化只做两件在 Windows 上确有必要的事：路径分隔符统一为 `/`、去掉结尾的斜杠
 * （`/proj` 与 `/proj/` 是同一个目录），以及大小写折叠（`C:\Proj` 与 `c:\proj` 同理）。
 * 其余一律原样参与哈希 —— 不必要的归一化（比如去掉 `..`、解析软链）会让「指向同一目录的
 * 不同写法」得到不同哈希，那才是真正要避免的。
 */
export function projectConfigKey(workspaceRoot: string): string {
  const normalized = workspaceRoot.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return createHash('sha1').update(normalized).digest('hex').slice(0, HASH_LENGTH);
}

/** 配置根目录的绝对路径（`~/.echoly/projects`） */
export function projectConfigsRoot(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.echoly', PROJECTS_DIR_NAME);
}

/** 某个工作区对应的配置目录绝对路径 */
export function projectConfigDir(workspaceRoot: string, homeDir: string = os.homedir()): string {
  return path.join(projectConfigsRoot(homeDir), projectConfigKey(workspaceRoot));
}

/** 元数据内容：把目录与项目路径对上号（仅供人查看，读取方不得依赖它做判定） */
export interface ProjectConfigMeta {
  /** 工作区根路径，原样记录，不做归一化 */
  root: string;
  /** 是本地项目还是 SSH 远端目录，便于用户分辨 */
  kind: 'local' | 'ssh';
  /** 最近一次绑定 / 打开的时间 */
  updatedAt: string;
}

export function buildProjectConfigMeta(
  workspaceRoot: string,
  kind: 'local' | 'ssh',
  now: number = Date.now(),
): ProjectConfigMeta {
  return { root: workspaceRoot, kind, updatedAt: new Date(now).toISOString() };
}

/**
 * 把工作区内的相对路径映射成配置目录下的**绝对**本地路径。
 *
 * 输入端是工作区相对路径（`db-connections.json`、`queries/<连接>/<库>/x.sql`），
 * 输出的路径交给 fs 直接读写本地磁盘 —— 这正是「配置不进项目」的落点：
 * 无论工作区是本地目录还是 SSH 远端，配置都落在用户自己机器的这个目录里。
 *
 * 安全上必须做的一件事：把 `..` 挡在配置目录之内。库名是用户可控输入，
 * 漏出去就会写到 `~/.echoly/` 甚至更远。
 */
export function projectConfigChildPath(
  workspaceRoot: string,
  relPath: string,
  homeDir: string = os.homedir(),
): string {
  const dir = projectConfigDir(workspaceRoot, homeDir);
  const segments = relPath
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s.length > 0 && s !== '.' && s !== '..');
  if (segments.length === 0) return dir;
  return path.join(dir, ...segments);
}

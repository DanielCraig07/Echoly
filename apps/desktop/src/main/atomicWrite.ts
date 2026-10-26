import fs from 'node:fs';
import path from 'node:path';

/**
 * 原子写：先写同目录下的临时文件，再 `rename` 覆盖目标。
 *
 * 为什么值得单独抽一个函数。主进程里有好几处「写一个小 JSON 当作持久化状态」
 * （设置、会话、待审 diff），它们原本都是 `fs.writeFileSync(target, ...)`：
 *
 * 1. **写一半就没了**。`writeFileSync` 会先把文件截断为 0 再写入。断电、进程被杀、
 *    磁盘写满，都会留下一个**半截文件**。而这些读取方在解析失败时普遍是
 *    「静默跳过」（`catch {}`），表现就是设置回默认值、会话凭空消失 —— 不报错，
 *    用户只会觉得「这软件怎么老丢东西」。
 * 2. **同目录 rename 是原子的**。POSIX 保证 `rename(2)` 对同文件系统内的替换是
 *    原子操作：任何时刻去读这个路径，读到的要么是旧内容，要么是新内容，不会是中间态。
 *
 * 临时文件名带 pid 与随机后缀：两个窗口同时保存设置不算罕见（每个窗口一个
 * SettingsService 实例），固定名字的临时文件会互相截断，反而制造出丢数据。
 *
 * 失败时把临时文件删掉再抛：`.tmp` 留在目录里既不会被任何读取方认到，又会随着
 * 每次失败越积越多（设置页一改就写一次）。真正的错误信息靠 `throw` 传出去，
 * 不需要靠残留文件保留现场。
 */
export function writeFileAtomic(
  target: string,
  data: string,
  encoding: BufferEncoding = 'utf8',
): void {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(target)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  try {
    fs.writeFileSync(tmp, data, encoding);
    fs.renameSync(tmp, target);
  } catch (err) {
    // rename 失败时临时文件已经没用了，顺手清掉；写失败则保留现场。
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

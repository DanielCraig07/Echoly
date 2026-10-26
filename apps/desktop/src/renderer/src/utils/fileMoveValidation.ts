/**
 * 校验文件树节点拖拽移动操作的合法性并生成目标相对路径。
 *
 * 失败时返回的是**错误码**而不是一句中文：
 * 这里唯一的信息是「为什么不能移动」，而最终显示成哪种语言的句子是界面的事。
 * 早先它返回中文句子，调用方为了区分「拖回原目录」这种不该报警的情况，
 * 只能拿中文字符串逐字比较 —— 那句话一旦在别处被改写，比较就静默失效了。
 */

export type MoveRejectionCode =
  /** 拖到了自己身上 */
  | 'move-into-self'
  /** 把文件夹拖进了自己的子目录（会形成环） */
  | 'move-into-child'
  /** 拖回了当前所在目录，等于没动 */
  | 'already-in-target';

export type MoveValidationResult =
  | { valid: true; newPath: string }
  | { valid: false; code: MoveRejectionCode };

export function validateMove(
  sourcePath: string,
  targetDirPath: string,
  sourceIsDir: boolean,
): MoveValidationResult {
  const normSource = sourcePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const normTarget = targetDirPath.replace(/\\/g, '/').replace(/\/+$/, '') || '.';

  // 1. 不能移动到自身
  if (normSource === normTarget) {
    return { valid: false, code: 'move-into-self' };
  }

  // 2. 目录不能移动到自身的子目录中 (防环)
  if (sourceIsDir && normTarget.startsWith(normSource + '/')) {
    return { valid: false, code: 'move-into-child' };
  }

  // 3. 计算旧父目录
  const slashIdx = normSource.lastIndexOf('/');
  const currentParent = slashIdx >= 0 ? normSource.slice(0, slashIdx) : '.';

  if (currentParent === normTarget) {
    return { valid: false, code: 'already-in-target' };
  }

  const fileName = normSource.slice(slashIdx + 1);
  const newPath = normTarget === '.' ? fileName : `${normTarget}/${fileName}`;

  return { valid: true, newPath };
}

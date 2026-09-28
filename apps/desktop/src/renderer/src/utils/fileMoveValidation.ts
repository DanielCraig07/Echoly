/**
 * 校验文件树节点拖拽移动操作的合法性并生成目标相对路径
 */
export function validateMove(
  sourcePath: string,
  targetDirPath: string,
  sourceIsDir: boolean,
): { valid: boolean; reason?: string; newPath?: string } {
  const normSource = sourcePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const normTarget = targetDirPath.replace(/\\/g, '/').replace(/\/+$/, '') || '.';

  // 1. 不能移动到自身
  if (normSource === normTarget) {
    return { valid: false, reason: '不能将文件/目录移动到自身' };
  }

  // 2. 目录不能移动到自身的子目录中 (防环)
  if (sourceIsDir && normTarget.startsWith(normSource + '/')) {
    return { valid: false, reason: '不能将文件夹移动到自身的子文件夹中' };
  }

  // 3. 计算旧父目录
  const slashIdx = normSource.lastIndexOf('/');
  const currentParent = slashIdx >= 0 ? normSource.slice(0, slashIdx) : '.';

  if (currentParent === normTarget) {
    return { valid: false, reason: '文件已在目标目录中' };
  }

  const fileName = normSource.slice(slashIdx + 1);
  const newPath = normTarget === '.' ? fileName : `${normTarget}/${fileName}`;

  return { valid: true, newPath };
}

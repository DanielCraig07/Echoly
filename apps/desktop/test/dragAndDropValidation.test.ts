import { describe, it, expect } from 'vitest';
import { validateMove } from '../src/renderer/src/utils/fileMoveValidation';

describe('dragAndDropValidation', () => {
  it('allows moving file from root to subfolder', () => {
    const res = validateMove('index.ts', 'src', false);
    expect(res.valid).toBe(true);
    expect(res.newPath).toBe('src/index.ts');
  });

  it('allows moving file between subfolders', () => {
    const res = validateMove('src/utils/math.ts', 'src/helpers', false);
    expect(res.valid).toBe(true);
    expect(res.newPath).toBe('src/helpers/math.ts');
  });

  it('allows moving file back to root directory', () => {
    const res = validateMove('src/helpers/math.ts', '.', false);
    expect(res.valid).toBe(true);
    expect(res.newPath).toBe('math.ts');
  });

  it('prevents dropping file into its own parent folder (no-op)', () => {
    const res = validateMove('src/helpers/math.ts', 'src/helpers', false);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('文件已在目标目录中');
  });

  it('prevents moving directory into its own child directory (cycle prevention)', () => {
    const res = validateMove('src/components', 'src/components/button', true);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('不能将文件夹移动到自身的子文件夹中');
  });

  it('prevents dropping onto itself', () => {
    const res = validateMove('src/components', 'src/components', true);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('不能将文件/目录移动到自身');
  });
});

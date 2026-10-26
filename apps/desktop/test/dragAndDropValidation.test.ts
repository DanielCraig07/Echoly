import { describe, it, expect } from 'vitest';
import { validateMove } from '../src/renderer/src/utils/fileMoveValidation';

describe('dragAndDropValidation', () => {
  it('allows moving file from root to subfolder', () => {
    const res = validateMove('index.ts', 'src', false);
    expect(res.valid).toBe(true);
    expect(res.valid && res.newPath).toBe('src/index.ts');
  });

  it('allows moving file between subfolders', () => {
    const res = validateMove('src/utils/math.ts', 'src/helpers', false);
    expect(res.valid).toBe(true);
    expect(res.valid && res.newPath).toBe('src/helpers/math.ts');
  });

  it('allows moving file back to root directory', () => {
    const res = validateMove('src/helpers/math.ts', '.', false);
    expect(res.valid).toBe(true);
    expect(res.valid && res.newPath).toBe('math.ts');
  });

  it('prevents dropping file into its own parent folder (no-op)', () => {
    const res = validateMove('src/helpers/math.ts', 'src/helpers', false);
    expect(res).toEqual({ valid: false, code: 'already-in-target' });
  });

  it('prevents moving directory into its own child directory (cycle prevention)', () => {
    const res = validateMove('src/components', 'src/components/button', true);
    expect(res).toEqual({ valid: false, code: 'move-into-child' });
  });

  it('prevents dropping onto itself', () => {
    const res = validateMove('src/components', 'src/components', true);
    expect(res).toEqual({ valid: false, code: 'move-into-self' });
  });

  it('returns codes, not sentences, so the caller can translate them', () => {
    // 这条是防回归的：调用方要按「是不是 already-in-target」决定报不报警，
    // 如果这里改回返回中文句子，那个判断就只能靠字符串比较，改文案即静默失效
    const res = validateMove('src/a.ts', 'src', false);
    expect(res.valid).toBe(false);
    expect(res.valid === false && res.code).toBe('already-in-target');
    expect(JSON.stringify(res)).not.toMatch(/[一-龥]/);
  });
});

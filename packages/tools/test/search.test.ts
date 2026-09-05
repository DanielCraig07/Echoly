import { describe, expect, it } from 'vitest';
import { globToRegExp } from '../src/search';

describe('globToRegExp', () => {
  it('matches simple wildcard', () => {
    expect(globToRegExp('*.ts').test('index.ts')).toBe(true);
    expect(globToRegExp('*.ts').test('index.js')).toBe(false);
  });

  it('matches double-star across directories', () => {
    const re = globToRegExp('src/**/*.ts');
    expect(re.test('src/index.ts')).toBe(true);
    expect(re.test('src/deep/nested/file.ts')).toBe(true);
    expect(re.test('other/file.ts')).toBe(false);
  });

  it('anchors the full path', () => {
    const re = globToRegExp('*.ts');
    expect(re.test('nested/index.ts')).toBe(false);
    expect(re.test('index.tsx')).toBe(false);
  });

  it('treats ? as single char', () => {
    const re = globToRegExp('file?.ts');
    expect(re.test('file1.ts')).toBe(true);
    expect(re.test('file12.ts')).toBe(false);
  });

  it('escapes regex special chars in glob', () => {
    const re = globToRegExp('a.b+c(ts)');
    expect(re.test('a.b+c(ts)')).toBe(true);
    expect(re.test('aXbXcXts')).toBe(false);
  });
});

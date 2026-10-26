import { describe, expect, it } from 'vitest';
import { globToRegExp, extractSymbolFromLine } from '../src/search';

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

  it('expands brace alternation', () => {
    // 工具描述里给的例子就是这个形状，而早先它编译成字面量 `{ts,tsx}`，静默匹配不到。
    const re = globToRegExp('**/*.{ts,tsx}');
    expect(re.test('src/a.ts')).toBe(true);
    expect(re.test('src/a.tsx')).toBe(true);
    expect(re.test('src/deep/a.tsx')).toBe(true);
    expect(re.test('a.ts')).toBe(true);
    expect(re.test('src/a.js')).toBe(false);
  });

  it('expands braces in the middle of a segment', () => {
    const re = globToRegExp('src/*.{test,spec}.ts');
    expect(re.test('src/a.test.ts')).toBe(true);
    expect(re.test('src/a.spec.ts')).toBe(true);
    expect(re.test('src/a.ts')).toBe(false);
  });

  it('handles a brace group with more than two alternatives', () => {
    const re = globToRegExp('*.{js,mjs,cjs}');
    expect(re.test('a.js')).toBe(true);
    expect(re.test('a.mjs')).toBe(true);
    expect(re.test('a.cjs')).toBe(true);
    expect(re.test('a.ts')).toBe(false);
  });

  it('treats an unclosed brace as a literal', () => {
    const re = globToRegExp('a{b');
    expect(re.test('a{b')).toBe(true);
  });
});

describe('extractSymbolFromLine', () => {
  it('extracts class declarations', () => {
    expect(extractSymbolFromLine('export class UserService extends BaseService {')).toEqual({
      name: 'UserService',
      kind: 'class',
    });
    expect(extractSymbolFromLine('abstract class Shape {')).toEqual({
      name: 'Shape',
      kind: 'class',
    });
  });

  it('extracts interface declarations', () => {
    expect(extractSymbolFromLine('export interface UserProfile {')).toEqual({
      name: 'UserProfile',
      kind: 'interface',
    });
  });

  it('extracts type and enum declarations', () => {
    expect(extractSymbolFromLine('export type ThemeMode = "light" | "dark";')).toEqual({
      name: 'ThemeMode',
      kind: 'type',
    });
    expect(extractSymbolFromLine('export enum Direction {')).toEqual({
      name: 'Direction',
      kind: 'enum',
    });
  });

  it('extracts function and arrow function declarations', () => {
    expect(extractSymbolFromLine('export async function fetchData(url: string) {')).toEqual({
      name: 'fetchData',
      kind: 'function',
    });
    expect(extractSymbolFromLine('def calculate_metrics(items):')).toEqual({
      name: 'calculate_metrics',
      kind: 'function',
    });
    expect(extractSymbolFromLine('func HandleRequest(w http.ResponseWriter) {')).toEqual({
      name: 'HandleRequest',
      kind: 'function',
    });
    expect(extractSymbolFromLine('export const renderCard = () => {')).toEqual({
      name: 'renderCard',
      kind: 'function',
    });
  });

  it('extracts struct declarations', () => {
    expect(extractSymbolFromLine('type Config struct {')).toEqual({
      name: 'Config',
      kind: 'struct',
    });
  });

  it('ignores comments and invalid lines', () => {
    expect(extractSymbolFromLine('// class CommentedClass')).toBeNull();
    expect(extractSymbolFromLine('* interface CommentedInterface')).toBeNull();
    expect(extractSymbolFromLine('const x = 123;')).toBeNull();
  });
});

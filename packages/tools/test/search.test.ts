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


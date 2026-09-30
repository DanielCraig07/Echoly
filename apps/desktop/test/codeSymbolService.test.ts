import { describe, expect, it } from 'vitest';
import { extractCodeSymbols, findCurrentSymbol } from '../src/renderer/src/services/codeSymbolService';

describe('codeSymbolService', () => {
  it('extracts TypeScript/JavaScript classes, functions, and interfaces', () => {
    const tsCode = `
import React from 'react';

export interface UserProps {
  name: string;
}

export class UserService {
  getUser() {}
}

export function fetchUser() {
  return true;
}

export const renderBadge = () => {
  return null;
};
    `;

    const symbols = extractCodeSymbols(tsCode, 'typescript');
    expect(symbols.length).toBeGreaterThanOrEqual(4);
    expect(symbols.map((s) => s.name)).toContain('UserProps');
    expect(symbols.map((s) => s.name)).toContain('UserService');
    expect(symbols.map((s) => s.name)).toContain('fetchUser');
    expect(symbols.map((s) => s.name)).toContain('renderBadge');
  });

  it('extracts Python classes and functions', () => {
    const pyCode = `
class DataPipeline:
    def __init__(self):
        pass

def run_pipeline():
    pass
    `;

    const symbols = extractCodeSymbols(pyCode, 'python');
    expect(symbols.map((s) => s.name)).toContain('DataPipeline');
    expect(symbols.map((s) => s.name)).toContain('run_pipeline');
  });

  it('finds the current symbol based on line number', () => {
    const symbols = [
      { name: 'Header', kind: 'function' as const, line: 10 },
      { name: 'Body', kind: 'function' as const, line: 30 },
      { name: 'Footer', kind: 'function' as const, line: 50 },
    ];

    expect(findCurrentSymbol(symbols, 5)).toBeNull();
    expect(findCurrentSymbol(symbols, 15)?.name).toBe('Header');
    expect(findCurrentSymbol(symbols, 35)?.name).toBe('Body');
    expect(findCurrentSymbol(symbols, 60)?.name).toBe('Footer');
  });
});

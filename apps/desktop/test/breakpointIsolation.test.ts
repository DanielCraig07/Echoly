import { describe, it, expect } from 'vitest';

interface DapBreakpoint {
  path: string;
  line: number;
  condition?: string;
  verified?: boolean;
}

function getBreakpointsStorageKey(ws?: string | null): string {
  if (!ws) return 'echoly.dap.breakpoints.global';
  return `echoly.dap.breakpoints.${ws}`;
}

function isBreakpointBelongsToWorkspace(bp: DapBreakpoint, ws?: string | null): boolean {
  if (!ws) return true;
  const normWs = ws.replace(/\\/g, '/').replace(/\/+$/, '');
  const normPath = bp.path.replace(/\\/g, '/');
  if (!normPath.startsWith('/') && !/^[A-Za-z]:/.test(normPath)) {
    return true;
  }
  return normPath.startsWith(normWs + '/') || normPath === normWs;
}

describe('Breakpoint Isolation per Workspace', () => {
  it('generates distinct storage keys for different workspaces', () => {
    const keyProjectA = getBreakpointsStorageKey('/Users/daniel/projects/project-a');
    const keyProjectB = getBreakpointsStorageKey('/Users/daniel/projects/python-demo');
    const keyGlobal = getBreakpointsStorageKey(null);

    expect(keyProjectA).toBe('echoly.dap.breakpoints./Users/daniel/projects/project-a');
    expect(keyProjectB).toBe('echoly.dap.breakpoints./Users/daniel/projects/python-demo');
    expect(keyGlobal).toBe('echoly.dap.breakpoints.global');
    expect(keyProjectA).not.toBe(keyProjectB);
  });

  it('filters out breakpoints from foreign workspaces', () => {
    const currentWorkspace = '/Users/daniel/projects/python-demo';

    const testBreakpoints: DapBreakpoint[] = [
      { path: '/Users/daniel/projects/python-demo/src/main.py', line: 10 },
      { path: 'src/calculator.py', line: 15 }, // relative path
      { path: '/Users/daniel/projects/cpp-app/main.cpp', line: 42 }, // foreign project
      { path: '/Users/daniel/Claude-demo/Echoly/App.tsx', line: 2892 }, // foreign project
    ];

    const filtered = testBreakpoints.filter((bp) =>
      isBreakpointBelongsToWorkspace(bp, currentWorkspace),
    );

    expect(filtered).toHaveLength(2);
    expect(filtered[0].path).toBe('/Users/daniel/projects/python-demo/src/main.py');
    expect(filtered[1].path).toBe('src/calculator.py');
  });
});

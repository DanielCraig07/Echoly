import { describe, expect, it } from 'vitest';
import { executeTool, type ToolContext } from '../src/index';
import { LocalFsBackend } from '../src/backend';
import os from 'os';

describe('executeTool defensive validation', () => {
  const dummyCtx: ToolContext = {
    workspaceRoot: os.tmpdir(),
    backend: new LocalFsBackend(os.tmpdir()),
    permissionMode: 'allow_all',
    requireConfirmForWrites: false,
    requestConfirm: async () => true,
    enqueueDiff: () => ({ id: 'diff-1', path: 'file', original: '', modified: '' }),
  };

  it('handles empty string arguments safely for glob_files without throwing', async () => {
    const res = await executeTool('glob_files', '', dummyCtx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('missing required "pattern" argument');
  });

  it('handles empty JSON object arguments safely for glob_files', async () => {
    const res = await executeTool('glob_files', '{}', dummyCtx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('missing required "pattern" argument');
  });

  it('handles empty arguments safely for run_terminal', async () => {
    const res = await executeTool('run_terminal', '', dummyCtx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('missing required "command" argument');
  });

  it('handles empty arguments safely for read_file', async () => {
    const res = await executeTool('read_file', '{}', dummyCtx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('missing required "path" argument');
  });

  it('handles empty arguments safely for write_file', async () => {
    const res = await executeTool('write_file', JSON.stringify({ path: 'test.txt' }), dummyCtx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('missing required "content" argument');
  });

  it('handles empty arguments safely for apply_patch', async () => {
    const res = await executeTool('apply_patch', '{}', dummyCtx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('missing required "path" argument');
  });

  it('handles empty arguments safely for search_code', async () => {
    const res = await executeTool('search_code', '{}', dummyCtx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('missing required "pattern" argument');
  });
});

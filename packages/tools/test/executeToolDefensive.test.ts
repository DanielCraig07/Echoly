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

  it('intercepts shell commands that attempt to write to workspace files', async () => {
    // 1. cat >> file
    const res1 = await executeTool(
      'run_terminal',
      JSON.stringify({ command: "cat >> ua.txt <<'EOF'\nnew ua line\nEOF" }),
      dummyCtx,
    );
    expect(res1.isError).toBe(true);
    expect(res1.content).toContain(
      'Modifying, appending to, or writing workspace files via run_terminal is forbidden',
    );

    // 2. sed -i
    const res2 = await executeTool(
      'run_terminal',
      JSON.stringify({ command: "sed -i '' '16d' ip.txt" }),
      dummyCtx,
    );
    expect(res2.isError).toBe(true);
    expect(res2.content).toContain('sed in-place edit');

    // 3. inline python script writing to file
    const res3 = await executeTool(
      'run_terminal',
      JSON.stringify({ command: "python3 - <<'PY'\nopen('ua.txt', 'w').write('new')\nPY" }),
      dummyCtx,
    );
    expect(res3.isError).toBe(true);
    expect(res3.content).toContain('inline Python script writing to file');

    // 4. echo > file
    const res4 = await executeTool(
      'run_terminal',
      JSON.stringify({ command: 'echo "hello" > foo.txt' }),
      dummyCtx,
    );
    expect(res4.isError).toBe(true);
    expect(res4.content).toContain('shell redirection to file');

    // 5. cat << 'EOF' > file (heredoc before target)
    const res5 = await executeTool(
      'run_terminal',
      JSON.stringify({ command: "cat << 'EOF' > ua.txt\nline1\nEOF" }),
      dummyCtx,
    );
    expect(res5.isError).toBe(true);
    expect(res5.content).toContain('redirection to file');

    // 6. False positive protection: echo "a > b" must NOT be intercepted
    const res6 = await executeTool(
      'run_terminal',
      JSON.stringify({ command: 'echo "score > 90"' }),
      dummyCtx,
    );
    expect(res6.content).not.toContain('Modifying, appending to, or writing workspace files');

    // 7. False positive protection: python sys.stdout.write must NOT be intercepted
    const res7 = await executeTool(
      'run_terminal',
      JSON.stringify({ command: 'python3 -c "import sys; sys.stdout.write(\'ok\')"' }),
      dummyCtx,
    );
    expect(res7.content).not.toContain('inline Python script writing to file');

    // 8. False positive protection: redirection to /dev/null must NOT be intercepted
    const res8 = await executeTool(
      'run_terminal',
      JSON.stringify({ command: 'npm test > /dev/null 2>&1' }),
      dummyCtx,
    );
    expect(res8.content).not.toContain('Modifying, appending to, or writing workspace files');
  });
});

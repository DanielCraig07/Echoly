import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitService } from '../src/main/gitService';
import type { WorkspaceService } from '../src/main/workspace';

describe('Git File Context Menu and Service Operations', () => {
  let mockWorkspace: { getRoot: ReturnType<typeof vi.fn>; readFile?: ReturnType<typeof vi.fn> };
  let gitService: GitService;

  beforeEach(() => {
    mockWorkspace = {
      getRoot: vi.fn().mockReturnValue('/test/repo'),
      readFile: vi.fn().mockResolvedValue(''),
    };
    gitService = new GitService(() => mockWorkspace as unknown as WorkspaceService);
  });

  it('blameFile parses git blame porcelain output into structured entries', async () => {
    const porcelainOutput = [
      '3ea5627bddb1df7aa238ef73b02a39ea9ddb0cc9 1 1 2',
      'author Alice Smith',
      'author-time 1700000000',
      'summary feat: add cool feature',
      'filename src/main.ts',
      '\timport React from "react";',
      '3ea5627bddb1df7aa238ef73b02a39ea9ddb0cc9 2 2',
      '\texport default function App() {}',
      '0000000000000000000000000000000000000000 3 3 1',
      'author Not Committed Yet',
      'author-time 0',
      'summary Version of src/main.ts',
      'filename src/main.ts',
      '\tconsole.log("uncommitted");',
    ].join('\n');

    vi.spyOn(gitService as any, 'runGit').mockResolvedValue({
      code: 0,
      stdout: porcelainOutput,
      stderr: '',
    });

    const res = await gitService.blameFile('src/main.ts');
    expect(res.ok).toBe(true);
    expect(res.entries).toBeDefined();
    expect(res.entries?.length).toBe(3);

    // Line 1
    expect(res.entries?.[0].line).toBe(1);
    expect(res.entries?.[0].author).toBe('Alice Smith');
    expect(res.entries?.[0].shortHash).toBe('3ea5627');
    expect(res.entries?.[0].message).toBe('feat: add cool feature');

    // Line 2 (reuses commit info)
    expect(res.entries?.[1].line).toBe(2);
    expect(res.entries?.[1].author).toBe('Alice Smith');
    expect(res.entries?.[1].shortHash).toBe('3ea5627');

    // Line 3 (uncommitted)
    expect(res.entries?.[2].line).toBe(3);
    expect(res.entries?.[2].author).toBe('You');
    expect(res.entries?.[2].relativeDate).toBe('未提交的更改');
  });

  it('showFileAtRef executes git show and returns file content at ref', async () => {
    vi.spyOn(gitService as any, 'runGit').mockResolvedValue({
      code: 0,
      stdout: 'const greeting = "hello from HEAD";\n',
      stderr: '',
    });

    const res = await gitService.showFileAtRef('HEAD', 'src/hello.ts');
    expect(res.ok).toBe(true);
    expect(res.content).toBe('const greeting = "hello from HEAD";\n');
  });

  it('diffWithRef executes git show for ref and reads local file via workspace.readFile', async () => {
    vi.spyOn(gitService as any, 'runGit').mockResolvedValue({
      code: 0,
      stdout: 'console.log("old content");\n',
      stderr: '',
    });
    mockWorkspace.readFile = vi.fn().mockResolvedValue('console.log("new local content");\n');

    const res = await gitService.diffWithRef('origin/main', 'src/index.ts');
    expect(res.ok).toBe(true);
    expect(res.original).toBe('console.log("old content");\n');
    expect(res.modified).toBe('console.log("new local content");\n');
    expect(mockWorkspace.readFile).toHaveBeenCalledWith('src/index.ts');
  });
});

import { describe, it, expect } from 'vitest';
import {
  parseContentWithCodeRefs,
  parseAnyCodeRef,
  parseAiContentCodeRefs,
  isCodeFile,
} from '../src/renderer/src/components/chat/CodeRefPill';
import { splitInputValue, buildValue } from '../src/renderer/src/components/chat/InputCodeRefOverlay';

describe('Code Reference Parsing and Input Splitting', () => {
  it('parses multiple code references with various dash types (hyphen, en-dash, em-dash, tilde)', () => {
    const text = '@App.tsx:L123-134 @App.tsx:L110–L120 @Utils.ts:L1—L10 @Core.tsx:L5~L15';
    const segments = parseContentWithCodeRefs(text);
    const refs = segments.filter((s) => s.type === 'ref');

    expect(refs).toHaveLength(4);
    expect(refs[0].ref?.fileName).toBe('App.tsx');
    expect(refs[0].ref?.startLine).toBe(123);
    expect(refs[0].ref?.endLine).toBe(134);

    expect(refs[1].ref?.fileName).toBe('App.tsx');
    expect(refs[1].ref?.startLine).toBe(110);
    expect(refs[1].ref?.endLine).toBe(120);

    expect(refs[2].ref?.fileName).toBe('Utils.ts');
    expect(refs[2].ref?.startLine).toBe(1);
    expect(refs[2].ref?.endLine).toBe(10);

    expect(refs[3].ref?.fileName).toBe('Core.tsx');
    expect(refs[3].ref?.startLine).toBe(5);
    expect(refs[3].ref?.endLine).toBe(15);
  });

  it('correctly splits multiple references into chips and keeps plainText clean', () => {
    const raw = '@App.tsx:L123-134\n@App.tsx:L110–L120';
    const { refs, plainText } = splitInputValue(raw);

    expect(refs).toHaveLength(2);
    expect(refs[0].ref.fileName).toBe('App.tsx');
    expect(refs[0].ref.startLine).toBe(123);
    expect(refs[0].ref.endLine).toBe(134);

    expect(refs[1].ref.fileName).toBe('App.tsx');
    expect(refs[1].ref.startLine).toBe(110);
    expect(refs[1].ref.endLine).toBe(120);

    expect(plainText).toBe('');
  });

  it('supports multiple references followed by user prompt question', () => {
    const raw = '@App.tsx:L123-134 @App.tsx:L110-L120 请帮我分析代码差异';
    const { refs, plainText } = splitInputValue(raw);

    expect(refs).toHaveLength(2);
    expect(plainText).toBe('请帮我分析代码差异');

    const rebuilt = buildValue(refs, plainText);
    expect(rebuilt).toBe('@App.tsx:L123-134 @App.tsx:L110-L120 请帮我分析代码差异');
  });

  it('supports Unicode and Chinese file paths in reference tokens', () => {
    const raw = '@/Users/project/中文目录/组件.tsx:L10-20';
    const segments = parseContentWithCodeRefs(raw);
    const refs = segments.filter((s) => s.type === 'ref');

    expect(refs).toHaveLength(1);
    expect(refs[0].ref?.fileName).toBe('组件.tsx');
    expect(refs[0].ref?.startLine).toBe(10);
    expect(refs[0].ref?.endLine).toBe(20);
  });

  it('correctly identifies deleted/missing paths with normalized path matching', () => {
    const missingPaths = new Set([
      'src/main/java/com/tsingtec/technicalTactics/utils/DataSourceParseUtils.java',
      'src/main/java/com/tsingtec/technicalTactics/TechnologyTacticsJob.java',
    ]);

    const isStale = (p: string) => {
      if (!p) return true;
      if (missingPaths.has(p)) return true;
      const norm = p.replace(/\\/g, '/').replace(/^\/+/, '');
      if (missingPaths.has(norm)) return true;
      for (const m of missingPaths) {
        const normM = m.replace(/\\/g, '/').replace(/^\/+/, '');
        if (norm === normM || norm.endsWith('/' + normM) || normM.endsWith('/' + norm)) {
          return true;
        }
      }
      return false;
    };

    // Exact matches
    expect(isStale('src/main/java/com/tsingtec/technicalTactics/utils/DataSourceParseUtils.java')).toBe(true);
    expect(isStale('src/main/java/com/tsingtec/technicalTactics/TechnologyTacticsJob.java')).toBe(true);

    // Leading slash normalization
    expect(isStale('/src/main/java/com/tsingtec/technicalTactics/utils/DataSourceParseUtils.java')).toBe(true);

    // Windows backslash normalization
    expect(isStale('src\\main\\java\\com\\tsingtec\\technicalTactics\\TechnologyTacticsJob.java')).toBe(true);

    // Valid existing file is not marked stale
    expect(isStale('src/main/java/com/tsingtec/technicalTactics/ValidFile.java')).toBe(false);
  });

  describe('AI Message Code Reference Resolution (parseAnyCodeRef & parseAiContentCodeRefs)', () => {
    it('accurately parses file:// URI with line ranges and URI encoding', () => {
      const ref = parseAnyCodeRef('file:///Users/developer/Echoly/apps/desktop/src/components/GitPanel.tsx#L2184-L2239');
      expect(ref).not.toBeNull();
      expect(ref?.fileName).toBe('GitPanel.tsx');
      expect(ref?.path).toBe('/Users/developer/Echoly/apps/desktop/src/components/GitPanel.tsx');
      expect(ref?.startLine).toBe(2184);
      expect(ref?.endLine).toBe(2239);
      expect(ref?.lineLabel).toBe('#L2184-2239');
    });

    it('accurately parses single-line file:// URI and colon formatted lines', () => {
      const ref = parseAnyCodeRef('file:///Users/developer/Echoly/src/App.tsx:1520');
      expect(ref).not.toBeNull();
      expect(ref?.fileName).toBe('App.tsx');
      expect(ref?.path).toBe('/Users/developer/Echoly/src/App.tsx');
      expect(ref?.startLine).toBe(1520);
      expect(ref?.endLine).toBeUndefined();
      expect(ref?.lineLabel).toBe('#L1520');
    });

    it('handles relative path with line range', () => {
      const ref = parseAnyCodeRef('src/components/GitPanel.tsx:2184-2239');
      expect(ref).not.toBeNull();
      expect(ref?.fileName).toBe('GitPanel.tsx');
      expect(ref?.path).toBe('src/components/GitPanel.tsx');
      expect(ref?.startLine).toBe(2184);
      expect(ref?.endLine).toBe(2239);
    });

    it('handles standalone file reference without line numbers', () => {
      const ref = parseAnyCodeRef('GitPanel.tsx');
      expect(ref).not.toBeNull();
      expect(ref?.fileName).toBe('GitPanel.tsx');
      expect(ref?.path).toBe('GitPanel.tsx');
      expect(ref?.startLine).toBeUndefined();
    });

    it('rejects external http/https web URLs to avoid interfering with external links', () => {
      expect(parseAnyCodeRef('https://github.com/DanielCraig07/Echoly/blob/main/GitPanel.tsx')).toBeNull();
      expect(parseAnyCodeRef('http://localhost:3000/index.html')).toBeNull();
    });

    it('rejects non-code files', () => {
      expect(parseAnyCodeRef('screenshot.png:12')).toBeNull();
      expect(parseAnyCodeRef('archive.zip')).toBeNull();
    });

    it('parses natural AI response text into text and clickable code reference segments', () => {
      const aiResponse =
        '建议查看 GitPanel.tsx:2184-2239 中的工具栏渲染逻辑，另外在 src/renderer/src/App.tsx:1616-1690 实现了文件跳转。';
      const segments = parseAiContentCodeRefs(aiResponse);
      const refs = segments.filter((s) => s.type === 'ref');

      expect(refs).toHaveLength(2);
      expect(refs[0].ref?.fileName).toBe('GitPanel.tsx');
      expect(refs[0].ref?.startLine).toBe(2184);
      expect(refs[0].ref?.endLine).toBe(2239);

      expect(refs[1].ref?.fileName).toBe('App.tsx');
      expect(refs[1].ref?.startLine).toBe(1616);
      expect(refs[1].ref?.endLine).toBe(1690);
    });

    it('supports file:/// full links embedded in natural AI text', () => {
      const text =
        '定位到：file:///Users/developer/Echoly/apps/desktop/src/components/GitPanel.tsx#L2364 进行修改。';
      const segments = parseAiContentCodeRefs(text);
      const refs = segments.filter((s) => s.type === 'ref');

      expect(refs).toHaveLength(1);
      expect(refs[0].ref?.fileName).toBe('GitPanel.tsx');
      expect(refs[0].ref?.startLine).toBe(2364);
      expect(refs[0].ref?.path).toBe('/Users/developer/Echoly/apps/desktop/src/components/GitPanel.tsx');
    });
  });
});

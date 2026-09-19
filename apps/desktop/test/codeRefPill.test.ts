import { describe, it, expect } from 'vitest';
import { parseContentWithCodeRefs } from '../src/renderer/src/components/chat/CodeRefPill';
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
});

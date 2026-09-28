import { describe, it, expect } from 'vitest';
import {
  parseConflictBlocks,
  resolveSingleConflict,
  resolveAllConflicts,
} from '../src/renderer/src/services/mergeConflictResolver';

describe('mergeConflictResolver', () => {
  const sampleConflict = `import React from 'react';

<<<<<<< HEAD
const TITLE = 'Current Branch Title';
const VERSION = '1.0.0';
=======
const TITLE = 'Incoming Feature Title';
const VERSION = '2.0.0';
>>>>>>> feature/awesome

export function App() {
  return <div>{TITLE}</div>;
}
`;

  it('correctly parses single git conflict block', () => {
    const blocks = parseConflictBlocks(sampleConflict);
    expect(blocks).toHaveLength(1);
    const b = blocks[0];
    expect(b.startLine).toBe(3);
    expect(b.currentHeader).toBe('HEAD');
    expect(b.currentText).toBe("const TITLE = 'Current Branch Title';\nconst VERSION = '1.0.0';");
    expect(b.incomingHeader).toBe('feature/awesome');
    expect(b.incomingText).toBe("const TITLE = 'Incoming Feature Title';\nconst VERSION = '2.0.0';");
    expect(b.endLine).toBe(9);
  });

  it('resolves conflict with current change', () => {
    const blocks = parseConflictBlocks(sampleConflict);
    const resolved = resolveSingleConflict(sampleConflict, blocks[0], 'current');
    expect(resolved).not.toContain('<<<<<<<');
    expect(resolved).not.toContain('=======');
    expect(resolved).not.toContain('>>>>>>>');
    expect(resolved).toContain("const TITLE = 'Current Branch Title';");
    expect(resolved).not.toContain("const TITLE = 'Incoming Feature Title';");
  });

  it('resolves conflict with incoming change', () => {
    const blocks = parseConflictBlocks(sampleConflict);
    const resolved = resolveSingleConflict(sampleConflict, blocks[0], 'incoming');
    expect(resolved).not.toContain('<<<<<<<');
    expect(resolved).not.toContain('=======');
    expect(resolved).not.toContain('>>>>>>>');
    expect(resolved).toContain("const TITLE = 'Incoming Feature Title';");
    expect(resolved).not.toContain("const TITLE = 'Current Branch Title';");
  });

  it('resolves conflict by accepting both changes', () => {
    const blocks = parseConflictBlocks(sampleConflict);
    const resolved = resolveSingleConflict(sampleConflict, blocks[0], 'both');
    expect(resolved).not.toContain('<<<<<<<');
    expect(resolved).not.toContain('=======');
    expect(resolved).not.toContain('>>>>>>>');
    expect(resolved).toContain("const TITLE = 'Current Branch Title';");
    expect(resolved).toContain("const TITLE = 'Incoming Feature Title';");
  });

  it('handles diff3 base conflicts correctly', () => {
    const diff3Text = `Line 1
<<<<<<< HEAD
code a
||||||| base
code base
=======
code b
>>>>>>> feat
Line 10`;

    const blocks = parseConflictBlocks(diff3Text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].hasBase).toBe(true);
    expect(blocks[0].currentText).toBe('code a');
    expect(blocks[0].incomingText).toBe('code b');
    expect(blocks[0].baseText).toBe('code base');

    const res = resolveSingleConflict(diff3Text, blocks[0], 'current');
    expect(res).toBe('Line 1\ncode a\nLine 10');
  });

  it('resolves multiple conflict blocks in one pass', () => {
    const multiConflict = `start
<<<<<<< HEAD
alpha 1
=======
beta 1
>>>>>>> b1
middle
<<<<<<< HEAD
alpha 2
=======
beta 2
>>>>>>> b2
end`;

    const allCurrent = resolveAllConflicts(multiConflict, 'current');
    expect(allCurrent).toBe('start\nalpha 1\nmiddle\nalpha 2\nend');

    const allIncoming = resolveAllConflicts(multiConflict, 'incoming');
    expect(allIncoming).toBe('start\nbeta 1\nmiddle\nbeta 2\nend');
  });
});

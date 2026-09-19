import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { RulesService } from '../src/main/rulesService';

describe('RulesService (.echolyrules & fallback)', () => {
  let tmpDir: string;
  let service: RulesService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'echoly-rules-test-'));
    service = new RulesService();
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('returns empty when no rules file exists', async () => {
    const rules = await service.getRules(tmpDir);
    expect(rules.ok).toBe(true);
    expect(rules.content).toBeNull();
  });

  it('reads .echolyrules when present', async () => {
    const rulesPath = path.join(tmpDir, '.echolyrules');
    fs.writeFileSync(rulesPath, '## Rule 1: Use TypeScript\n', 'utf-8');

    const rules = await service.getRules(tmpDir);
    expect(rules.ok).toBe(true);
    expect(rules.content).toBe('## Rule 1: Use TypeScript\n');
    expect(rules.filename).toBe('.echolyrules');
  });

  it('falls back to .cursorrules if .echolyrules does not exist', async () => {
    const cursorRulesPath = path.join(tmpDir, '.cursorrules');
    fs.writeFileSync(cursorRulesPath, '## Rule: Cursor fallback\n', 'utf-8');

    const rules = await service.getRules(tmpDir);
    expect(rules.ok).toBe(true);
    expect(rules.content).toBe('## Rule: Cursor fallback\n');
    expect(rules.filename).toBe('.cursorrules');
  });

  it('prioritizes .echolyrules over .cursorrules if both exist', async () => {
    fs.writeFileSync(path.join(tmpDir, '.cursorrules'), 'Cursor rules', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, '.echolyrules'), 'Echoly rules', 'utf-8');

    const rules = await service.getRules(tmpDir);
    expect(rules.ok).toBe(true);
    expect(rules.content).toBe('Echoly rules');
    expect(rules.filename).toBe('.echolyrules');
  });

  it('saves new content into .echolyrules', async () => {
    const res = await service.saveRules('## Custom Rules for Project', tmpDir);
    expect(res.ok).toBe(true);

    const fileContent = fs.readFileSync(path.join(tmpDir, '.echolyrules'), 'utf-8');
    expect(fileContent).toBe('## Custom Rules for Project');

    const loaded = await service.getRules(tmpDir);
    expect(loaded.content).toBe('## Custom Rules for Project');
    expect(loaded.filename).toBe('.echolyrules');
  });
});

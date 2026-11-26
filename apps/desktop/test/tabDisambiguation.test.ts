import { describe, it, expect } from 'vitest';
import { computeTabDisambiguationHints } from '../src/renderer/src/utils';

describe('computeTabDisambiguationHints', () => {
  it('returns empty map when there are no duplicate tab names', () => {
    const tabs = [{ path: 'src/main.ts' }, { path: 'src/app.tsx' }, { path: 'README.md' }];
    const hints = computeTabDisambiguationHints(tabs);
    expect(hints.size).toBe(0);
  });

  it('correctly disambiguates duplicate files using direct parent directory', () => {
    const tabs = [
      { path: 'doris/docker-compose.yaml' },
      { path: 'cluster/docker-compose.yaml' },
      { path: 'milvus/docker-compose.yaml' },
      { path: 'other/config.json' },
    ];
    const hints = computeTabDisambiguationHints(tabs);

    expect(hints.size).toBe(3);
    expect(hints.get('doris/docker-compose.yaml')).toBe('doris');
    expect(hints.get('cluster/docker-compose.yaml')).toBe('cluster');
    expect(hints.get('milvus/docker-compose.yaml')).toBe('milvus');
    expect(hints.has('other/config.json')).toBe(false);
  });

  it('handles multi-level directory collision by expanding to shortest unique path', () => {
    const tabs = [
      { path: 'services/doris/docker-compose.yaml' },
      { path: 'modules/doris/docker-compose.yaml' },
      { path: 'milvus/docker-compose.yaml' },
    ];
    const hints = computeTabDisambiguationHints(tabs);

    expect(hints.get('services/doris/docker-compose.yaml')).toBe('services/doris');
    expect(hints.get('modules/doris/docker-compose.yaml')).toBe('modules/doris');
    expect(hints.get('milvus/docker-compose.yaml')).toBe('milvus');
  });

  it('handles files in root directory alongside subdirectory files', () => {
    const tabs = [{ path: 'docker-compose.yaml' }, { path: 'doris/docker-compose.yaml' }];
    const hints = computeTabDisambiguationHints(tabs);

    expect(hints.get('docker-compose.yaml')).toBe('• /');
    expect(hints.get('doris/docker-compose.yaml')).toBe('doris');
  });

  it('handles Windows style backslashes seamlessly', () => {
    const tabs = [
      { path: 'cv_components\\doris\\docker-compose.yaml' },
      { path: 'cv_components\\cluster\\docker-compose.yaml' },
    ];
    const hints = computeTabDisambiguationHints(tabs);

    expect(hints.get('cv_components\\doris\\docker-compose.yaml')).toBe('doris');
    expect(hints.get('cv_components\\cluster\\docker-compose.yaml')).toBe('cluster');
  });

  it('respects custom tab titles when checking for duplicates', () => {
    const tabs = [
      { path: 'a/file.txt', title: 'CustomA' },
      { path: 'b/file.txt', title: 'CustomB' },
    ];
    // Both have distinct titles, so they should not collide
    const hints = computeTabDisambiguationHints(tabs);
    expect(hints.size).toBe(0);
  });
});

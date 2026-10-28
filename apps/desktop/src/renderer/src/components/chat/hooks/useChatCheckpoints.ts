import { useState, useCallback } from 'react';
import type { CheckpointSummary } from '@deepseek-ide/shared';
import type { SessionTab } from '../types';

export function useChatCheckpoints() {
  const [checkpoints, setCheckpoints] = useState<Record<string, CheckpointSummary | null>>({});

  const refreshCheckpoints = useCallback(async (runIds: string[]) => {
    if (runIds.length === 0) return;
    const entries = await Promise.all(
      runIds.map(async (id) => {
        try {
          return [id, await window.ide.getCheckpointSummary(id)] as const;
        } catch {
          return [id, null] as const;
        }
      }),
    );
    setCheckpoints((prev) => {
      const next = { ...prev };
      for (const [id, summary] of entries) next[id] = summary;
      return next;
    });
  }, []);

  const knownRunIds = useCallback(
    (tab: SessionTab | undefined): string[] =>
      (tab?.messages ?? [])
        .map((m) => m.runId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    [],
  );

  return {
    checkpoints,
    setCheckpoints,
    refreshCheckpoints,
    knownRunIds,
  };
}


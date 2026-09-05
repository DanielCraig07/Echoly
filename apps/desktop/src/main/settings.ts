import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_LAYOUT,
  DEFAULT_SETTINGS,
  migratePermissionMode,
  migrateToProviderSettings,
  syncPermissionBooleans,
  type AppSettings,
  type LayoutSettings,
} from '@deepseek-ide/shared';

function normalizeLayout(layout?: Partial<LayoutSettings>): LayoutSettings {
  return {
    explorerWidth: clamp(layout?.explorerWidth ?? DEFAULT_LAYOUT.explorerWidth, 140, 480),
    chatWidth: clamp(layout?.chatWidth ?? DEFAULT_LAYOUT.chatWidth, 260, 720),
    bottomHeight: clamp(layout?.bottomHeight ?? DEFAULT_LAYOUT.bottomHeight, 120, 420),
    leftPanelExpanded: layout?.leftPanelExpanded !== false,
    bottomPanelExpanded: layout?.bottomPanelExpanded === true,
    chatPanelExpanded: layout?.chatPanelExpanded !== false,
    bottomActiveTab: layout?.bottomActiveTab === 'diff' ? 'diff' : 'terminal',
  };
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normalize(raw: Partial<AppSettings>): AppSettings {
  // Migrate legacy settings to new provider structure
  const migrated = migrateToProviderSettings(raw);
  
  const permissionMode = migratePermissionMode(raw);
  const booleans = syncPermissionBooleans(permissionMode);
  const theme = raw.theme === 'light' || raw.theme === 'dark' ? raw.theme : DEFAULT_SETTINGS.theme;
  
  return {
    ...migrated,
    ...raw,
    // Ensure models & providers structure exists
    models: raw.models && Array.isArray(raw.models) && raw.models.length > 0 ? raw.models : migrated.models,
    activeModelId: raw.activeModelId || migrated.activeModelId,
    providers: raw.providers || migrated.providers,
    currentProvider: raw.currentProvider || migrated.currentProvider,
    permissionMode,
    autoApproveReadonlyTerminal: booleans.autoApproveReadonlyTerminal,
    requireConfirmForWrites: booleans.requireConfirmForWrites,
    maxAgentSteps: Number(raw.maxAgentSteps) || DEFAULT_SETTINGS.maxAgentSteps,
    contextWindowTokens: Number(raw.contextWindowTokens) || DEFAULT_SETTINGS.contextWindowTokens,
    layout: normalizeLayout(raw.layout),
    theme,
    autoSave: raw.autoSave === true,
  };
}

export class SettingsStore {
  private readonly filePath: string;
  private cache: AppSettings;

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, 'settings.json');
    this.cache = this.load();
  }

  private load(): AppSettings {
    try {
      if (!fs.existsSync(this.filePath)) return { ...DEFAULT_SETTINGS, layout: { ...DEFAULT_LAYOUT } };
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<AppSettings>;
      return normalize(raw);
    } catch {
      return { ...DEFAULT_SETTINGS, layout: { ...DEFAULT_LAYOUT } };
    }
  }

  get(): AppSettings {
    return {
      ...this.cache,
      layout: { ...this.cache.layout },
    };
  }

  save(partial: Partial<AppSettings>): AppSettings {
    const merged: Partial<AppSettings> = {
      ...this.cache,
      ...partial,
      layout: partial.layout
        ? { ...this.cache.layout, ...partial.layout }
        : this.cache.layout,
    };
    this.cache = normalize(merged);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.cache, null, 2), 'utf8');
    return this.get();
  }
}

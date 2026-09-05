import fs from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import {
  DEFAULT_LAYOUT,
  DEFAULT_SETTINGS,
  migratePermissionMode,
  migrateToProviderSettings,
  syncPermissionBooleans,
  type AiProvider,
  type AppSettings,
  type LayoutSettings,
  type ProviderConfig,
} from '@deepseek-ide/shared';

/**
 * API Key 加密（at-rest）
 *
 * 明文 key 只存在于内存中的 cache，写盘前统一加密；读取时解密。
 * 依赖 Electron 的 safeStorage（macOS Keychain / Windows DPAPI / Linux libsecret）。
 * Linux 若无 keyring，safeStorage 不可用，则降级为明文存储并保持兼容。
 */
const ENC_PREFIX = 'enc:v1:';

function isEncAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function encryptSecret(plain: string | undefined): string | undefined {
  if (!plain) return plain;
  if (!isEncAvailable()) return plain;
  try {
    return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64');
  } catch {
    return plain;
  }
}

function decryptSecret(stored: string | undefined): string | undefined {
  if (!stored) return stored;
  if (stored.startsWith(ENC_PREFIX)) {
    try {
      const buf = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64');
      return safeStorage.decryptString(buf);
    } catch {
      return '';
    }
  }
  // 旧版明文（未加密的历史数据）
  return stored;
}

function encryptAppSettings(s: AppSettings): AppSettings {
  return {
    ...s,
    models: s.models?.map((m) => ({ ...m, apiKey: encryptSecret(m.apiKey) as string })),
    providers: s.providers
      ? (Object.fromEntries(
          Object.entries(s.providers).map(([k, v]) => [
            k,
            { ...v, apiKey: encryptSecret(v.apiKey) as string },
          ]),
        ) as Record<AiProvider, ProviderConfig>)
      : s.providers,
    apiKey: encryptSecret(s.apiKey) as string,
    updateFeed: s.updateFeed
      ? { ...s.updateFeed, token: encryptSecret(s.updateFeed.token) as string }
      : s.updateFeed,
  };
}

function decryptAppSettings(raw: Partial<AppSettings>): Partial<AppSettings> {
  return {
    ...raw,
    models: raw.models?.map((m) => ({ ...m, apiKey: decryptSecret(m.apiKey) as string })),
    providers: raw.providers
      ? (Object.fromEntries(
          Object.entries(raw.providers).map(([k, v]) => [
            k,
            { ...v, apiKey: decryptSecret(v.apiKey) as string },
          ]),
        ) as Record<AiProvider, ProviderConfig>)
      : raw.providers,
    apiKey: decryptSecret(raw.apiKey) as string,
    updateFeed: raw.updateFeed
      ? { ...raw.updateFeed, token: decryptSecret(raw.updateFeed.token) as string }
      : raw.updateFeed,
  };
}

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
    models:
      raw.models && Array.isArray(raw.models) && raw.models.length > 0
        ? raw.models
        : migrated.models,
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
      if (!fs.existsSync(this.filePath))
        return { ...DEFAULT_SETTINGS, layout: { ...DEFAULT_LAYOUT } };
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<AppSettings>;
      const withKeysDecrypted = decryptAppSettings(raw);
      return normalize(withKeysDecrypted);
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
      layout: partial.layout ? { ...this.cache.layout, ...partial.layout } : this.cache.layout,
    };
    this.cache = normalize(merged);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(
      this.filePath,
      JSON.stringify(encryptAppSettings(this.cache), null, 2),
      'utf8',
    );
    return this.get();
  }
}

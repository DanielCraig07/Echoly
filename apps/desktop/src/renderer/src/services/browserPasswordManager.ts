/**
 * 内置浏览器密码与凭据管理器服务
 *
 * 支持按站点域名（Origin）安全记忆、自动填充与持久化保存账号密码。
 */

export interface SavedCredential {
  id: string;
  origin: string; // 站点源，例如 "http://localhost:3000" 或 "https://github.com"
  username: string; // 账号/用户名/邮箱
  password: string; // 明文密码（由服务层解密后供给内部使用）
  createdAt: number;
  updatedAt: number;
}

interface StoredCredentialRecord {
  id: string;
  origin: string;
  username: string;
  cipher: string; // 编码混淆后的密码
  createdAt: number;
  updatedAt: number;
}

const STORAGE_KEY = 'echoly:browser_saved_passwords';
const SECRET_SALT = 0xa5;

/** 简单双向可逆混淆，避免账号密码以明文字符串散落在 LocalStorage 中 */
function obfuscate(plain: string): string {
  try {
    const bytes = new TextEncoder().encode(plain);
    const xorBytes = bytes.map((b) => b ^ SECRET_SALT);
    return btoa(String.fromCharCode(...xorBytes));
  } catch {
    return btoa(unescape(encodeURIComponent(plain)));
  }
}

function deobfuscate(cipher: string): string {
  try {
    const binaryStr = atob(cipher);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i) ^ SECRET_SALT;
    }
    return new TextDecoder().decode(bytes);
  } catch {
    try {
      return decodeURIComponent(escape(atob(cipher)));
    } catch {
      return '';
    }
  }
}

/**
 * 规范化提取站点源 Origin (协议 + 域名 + 端口)
 */
export function extractOrigin(urlOrOrigin: string): string {
  const trimmed = (urlOrOrigin || '').trim();
  if (!trimmed || trimmed === 'about:blank') return '';
  try {
    const full = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    const parsed = new URL(full);
    return parsed.origin.toLowerCase();
  } catch {
    return trimmed.toLowerCase().split('/')[0];
  }
}

function readStorageRecords(): StoredCredentialRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeStorageRecords(records: StoredCredentialRecord[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch (err) {
    console.error('Failed to save browser credentials:', err);
  }
}

/**
 * 获取指定网站源下保存的所有账号凭据
 */
export function getCredentialsForOrigin(urlOrOrigin: string): SavedCredential[] {
  const origin = extractOrigin(urlOrOrigin);
  if (!origin) return [];
  const records = readStorageRecords();
  return records
    .filter((r) => r.origin === origin)
    .map((r) => ({
      id: r.id,
      origin: r.origin,
      username: r.username,
      password: deobfuscate(r.cipher),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
}

/**
 * 保存或更新网站账号密码凭据
 */
export function saveCredential(
  urlOrOrigin: string,
  username: string,
  password: string,
): SavedCredential {
  const origin = extractOrigin(urlOrOrigin);
  const normUser = (username || '').trim();
  const normPw = password || '';

  const records = readStorageRecords();
  const existingIdx = records.findIndex(
    (r) => r.origin === origin && r.username.toLowerCase() === normUser.toLowerCase(),
  );

  const now = Date.now();
  let resultRecord: StoredCredentialRecord;

  if (existingIdx >= 0) {
    resultRecord = {
      ...records[existingIdx],
      cipher: obfuscate(normPw),
      updatedAt: now,
    };
    records[existingIdx] = resultRecord;
  } else {
    resultRecord = {
      id: `cred-${now}-${Math.random().toString(36).slice(2, 8)}`,
      origin,
      username: normUser,
      cipher: obfuscate(normPw),
      createdAt: now,
      updatedAt: now,
    };
    records.push(resultRecord);
  }

  writeStorageRecords(records);

  return {
    id: resultRecord.id,
    origin: resultRecord.origin,
    username: resultRecord.username,
    password: normPw,
    createdAt: resultRecord.createdAt,
    updatedAt: resultRecord.updatedAt,
  };
}

/**
 * 删除单个凭据
 */
export function deleteCredential(id: string): void {
  const records = readStorageRecords();
  const filtered = records.filter((r) => r.id !== id);
  writeStorageRecords(filtered);
}

/**
 * 列出所有已保存的凭据
 */
export function listAllCredentials(): SavedCredential[] {
  const records = readStorageRecords();
  return records.map((r) => ({
    id: r.id,
    origin: r.origin,
    username: r.username,
    password: deobfuscate(r.cipher),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

/**
 * 清空指定 Origin 下的所有凭据
 */
export function clearCredentialsForOrigin(urlOrOrigin: string): void {
  const origin = extractOrigin(urlOrOrigin);
  if (!origin) return;
  const records = readStorageRecords();
  writeStorageRecords(records.filter((r) => r.origin !== origin));
}

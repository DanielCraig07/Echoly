import { describe, it, expect, beforeEach } from 'vitest';
import {
  extractOrigin,
  saveCredential,
  getCredentialsForOrigin,
  deleteCredential,
  listAllCredentials,
  clearCredentialsForOrigin,
} from '../src/renderer/src/services/browserPasswordManager';

describe('browserPasswordManager', () => {
  beforeEach(() => {
    let store: Record<string, string> = {};
    (globalThis as any).localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
      clear: () => {
        store = {};
      },
    };
  });

  it('correctly extracts origin from URLs', () => {
    expect(extractOrigin('http://localhost:5173/dashboard?tab=1')).toBe('http://localhost:5173');
    expect(extractOrigin('https://github.com/login')).toBe('https://github.com');
    expect(extractOrigin('http://127.0.0.1:3000/')).toBe('http://127.0.0.1:3000');
    expect(extractOrigin('localhost:8080')).toBe('http://localhost:8080');
    expect(extractOrigin('')).toBe('');
    expect(extractOrigin('about:blank')).toBe('');
  });

  it('saves and retrieves credentials for origin', () => {
    const cred = saveCredential('http://localhost:3000/login', 'admin', 'Secret123!');
    expect(cred.origin).toBe('http://localhost:3000');
    expect(cred.username).toBe('admin');
    expect(cred.password).toBe('Secret123!');

    const list = getCredentialsForOrigin('http://localhost:3000');
    expect(list).toHaveLength(1);
    expect(list[0].username).toBe('admin');
    expect(list[0].password).toBe('Secret123!');
  });

  it('updates password when saving the same username for origin', () => {
    saveCredential('http://localhost:5173', 'dev_user', 'old_password');
    const updated = saveCredential('http://localhost:5173/subpath', 'dev_user', 'new_password');

    const list = getCredentialsForOrigin('http://localhost:5173');
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(updated.id);
    expect(list[0].password).toBe('new_password');
  });

  it('deletes and clears credentials', () => {
    const c1 = saveCredential('http://localhost:3000', 'user1', 'p1');
    saveCredential('http://localhost:3000', 'user2', 'p2');
    saveCredential('http://localhost:8080', 'user3', 'p3');

    deleteCredential(c1.id);
    expect(getCredentialsForOrigin('http://localhost:3000')).toHaveLength(1);

    clearCredentialsForOrigin('http://localhost:3000');
    expect(getCredentialsForOrigin('http://localhost:3000')).toHaveLength(0);
    expect(getCredentialsForOrigin('http://localhost:8080')).toHaveLength(1);
    expect(listAllCredentials()).toHaveLength(1);
  });
});

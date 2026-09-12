import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { detectMavenEnvironment, initMavenWrapper } from '../src/main/mavenService';

describe('mavenService', () => {
  it('detectMavenEnvironment returns environment info', async () => {
    const env = await detectMavenEnvironment();
    expect(env).toBeDefined();
    expect(typeof env.available).toBe('boolean');
    expect(typeof env.type).toBe('string');
    expect(typeof env.executablePath).toBe('string');
    expect(typeof env.hasJava).toBe('boolean');
  });

  it('initMavenWrapper creates wrapper files in project', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'echoly-maven-test-'));
    try {
      const res = await initMavenWrapper(tempDir);
      expect(res.success).toBe(true);

      expect(fs.existsSync(path.join(tempDir, 'mvnw'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'mvnw.cmd'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, '.mvn', 'wrapper', 'maven-wrapper.properties'))).toBe(true);

      // Now detect in this folder
      const env = await detectMavenEnvironment(tempDir);
      expect(env.available).toBe(true);
      expect(env.type).toBe('wrapper');
      expect(env.executablePath).toMatch(/mvnw/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

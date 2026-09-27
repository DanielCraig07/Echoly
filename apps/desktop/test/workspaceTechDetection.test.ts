import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { detectWorkspaceTechFromDisk } from '../src/main/workspaceDetector';
import { heuristicDetectTech, detectTechBadge } from '../src/renderer/src/utils/techStack';

describe('Workspace Tech Stack Accurate Detection', () => {
  it('accurately identifies tsingtec_data_center as Java from pom.xml and does NOT misidentify as Node', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsingtec_data_center-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project></project>');
      fs.mkdirSync(path.join(tmpDir, '.mvn'));

      const detected = detectWorkspaceTechFromDisk(tmpDir);
      expect(detected).toBe('Java');

      // Check badge styling
      const badge = detectTechBadge('tsingtec_data_center', tmpDir, detected);
      expect(badge.label).toBe('Java');
      expect(badge.color).toBe('#fb923c'); // Java orange
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('accurately identifies multi-module project (e.g. server/package.json) as Node', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catering-mini-app-'));
    try {
      const serverDir = path.join(tmpDir, 'server');
      fs.mkdirSync(serverDir);
      fs.writeFileSync(path.join(serverDir, 'package.json'), '{"name":"server"}');

      const detected = detectWorkspaceTechFromDisk(tmpDir);
      expect(detected).toBe('Node');

      const badge = detectTechBadge('catering-mini-app', tmpDir, detected);
      expect(badge.label).toBe('Node');
      expect(badge.color).toBe('#4ade80'); // Node green
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('accurately detects Python, Go, Rust, C++ from configuration files', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'tech-test-'));
    try {
      const pyDir = path.join(tmpBase, 'py-proj');
      fs.mkdirSync(pyDir);
      fs.writeFileSync(path.join(pyDir, 'requirements.txt'), 'flask');
      expect(detectWorkspaceTechFromDisk(pyDir)).toBe('Python');

      const goDir = path.join(tmpBase, 'go-proj');
      fs.mkdirSync(goDir);
      fs.writeFileSync(path.join(goDir, 'go.mod'), 'module example.com/app');
      expect(detectWorkspaceTechFromDisk(goDir)).toBe('Go');

      const rustDir = path.join(tmpBase, 'rust-proj');
      fs.mkdirSync(rustDir);
      fs.writeFileSync(path.join(rustDir, 'Cargo.toml'), '[package]');
      expect(detectWorkspaceTechFromDisk(rustDir)).toBe('Rust');

      const cppDir = path.join(tmpBase, 'cpp-proj');
      fs.mkdirSync(cppDir);
      fs.writeFileSync(path.join(cppDir, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.10)');
      expect(detectWorkspaceTechFromDisk(cppDir)).toBe('C++');
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it('heuristic detection correctly tags security-vision-system as Python without disk scan', () => {
    const tech = heuristicDetectTech(
      'security-vision-system',
      'wjj25@192.168.10.208:/opt/wjj25/security-vision-system',
    );
    expect(tech).toBe('Python');
  });

  it('heuristic detection NEVER falsely flags tsingtec as Node (preventing substring ts match)', () => {
    // Should NOT be Node just because of 'ts' in 'tsingtec'
    const tech = heuristicDetectTech('tsingtec_data_center', '/Users/test/tsingtec_data_center');
    expect(tech).not.toBe('Node');
    expect(tech).toBe('通用');
  });

  it('opening a directory with .git does NOT identify as Git and detects actual code or 通用', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-repo-test-'));
    try {
      fs.mkdirSync(path.join(tmpDir, '.git'));
      // No config file, but contains Python script
      fs.writeFileSync(path.join(tmpDir, 'script.py'), 'print("hello")');

      const detected = detectWorkspaceTechFromDisk(tmpDir);
      expect(detected).toBe('Python');
      expect(detected).not.toBe('Git');

      const badge = detectTechBadge('my-python-tool', tmpDir, detected);
      expect(badge.label).toBe('Python');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('opening a plain folder with .git and no recognizable code returns 通用, never Git', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-folder-'));
    try {
      fs.mkdirSync(path.join(tmpDir, '.git'));
      fs.writeFileSync(path.join(tmpDir, 'notes.txt'), 'notes');

      const detected = detectWorkspaceTechFromDisk(tmpDir);
      expect(detected).toBe('通用');
      expect(detected).not.toBe('Git');

      const badge = detectTechBadge('random-notes', tmpDir, detected);
      expect(badge.label).toBe('通用');
      expect(badge.label).not.toBe('Git');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

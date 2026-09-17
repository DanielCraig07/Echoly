import { describe, it, expect } from 'vitest';
import { PROJECT_TEMPLATE_LIST, PROJECT_TEMPLATES } from '../src/renderer/src/utils/projectTemplates';
import { detectMultiLangToolchain } from '../src/main/cppToolchainService';

describe('Multi-Language Templates & Toolchain Suite', () => {
  it('contains comprehensive project templates for all 5 core languages', () => {
    const templateIds = PROJECT_TEMPLATE_LIST.map((t) => t.id);
    expect(templateIds).toContain('java-maven');
    expect(templateIds).toContain('python');
    expect(templateIds).toContain('go');
    expect(templateIds).toContain('node-ts');
    expect(templateIds).toContain('cpp-cmake');

    // 验证别名兼容
    expect(PROJECT_TEMPLATES['python-standard']).toBeDefined();
    expect(PROJECT_TEMPLATES['go-module']).toBeDefined();

    for (const tpl of PROJECT_TEMPLATE_LIST) {
      expect(tpl.name).toBeTruthy();
      expect(tpl.badge).toBeTruthy();
      expect(tpl.entryFile).toBeTruthy();
      expect(tpl.files.length).toBeGreaterThan(1);

      // 确保入口文件确实包含在模板文件列表中
      const hasEntry = tpl.files.some((f) => f.path === tpl.entryFile);
      expect(hasEntry).toBe(true);
    }
  });

  it('detectMultiLangToolchain returns structured diagnostics for cpp, python, go, and node', () => {
    const res = detectMultiLangToolchain();
    expect(res).toHaveProperty('cpp');
    expect(res).toHaveProperty('python');
    expect(res).toHaveProperty('go');
    expect(res).toHaveProperty('node');

    // Python 工具项
    expect(res.python.interpreter).toHaveProperty('installed');
    expect(res.python.debugpy).toHaveProperty('installed');
    expect(res.python.pip).toHaveProperty('installed');

    // Go 工具项
    expect(res.go.go).toHaveProperty('installed');
    expect(res.go.delve).toHaveProperty('installed');
    expect(res.go.gopls).toHaveProperty('installed');

    // Node 工具项
    expect(res.node.node).toHaveProperty('installed');
    expect(res.node.npm).toHaveProperty('installed');
    expect(res.node.typescript).toHaveProperty('installed');
  }, 20000);
});

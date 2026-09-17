import { describe, it, expect } from 'vitest';
import { resolveDebugConfig } from '../src/renderer/src/utils/debugLauncher';

describe('resolveDebugConfig', () => {
  it('correctly configures Java / Maven JDWP debug session', () => {
    const javaOption = {
      id: 'active:src/main/java/com/example/App.java',
      name: 'App',
      command: 'mvn compile exec:java -Dexec.mainClass="com.example.App"',
      source: 'java',
      badge: 'Java',
    };
    const res = resolveDebugConfig(javaOption);
    expect(res.type).toBe('terminal');
    expect(res.language).toBe('java');
    expect(res.port).toBe(5005);
    expect(res.terminalType).toBe('java');
    expect(res.command).toContain('-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=5005');
  });

  it('correctly configures Maven test debug session', () => {
    const testOption = {
      id: 'active:test:AppTest.java',
      name: '测试: AppTest',
      command: 'mvn test -Dtest=AppTest',
      source: 'java',
      badge: 'Maven',
    };
    const res = resolveDebugConfig(testOption);
    expect(res.terminalType).toBe('mvn');
    expect(res.command).toContain('-Dmaven.surefire.debug');
  });

  it('correctly configures Python debugpy debug session', () => {
    const pyOption = {
      id: 'active:main.py',
      name: 'main.py',
      command: 'python3 "main.py"',
      source: 'python',
      badge: 'Py',
    };
    const res = resolveDebugConfig(pyOption);
    expect(res.type).toBe('terminal');
    expect(res.language).toBe('python');
    expect(res.port).toBe(5678);
    expect(res.command).toBe('python3 -m debugpy --listen 127.0.0.1:5678 "main.py"');
  });

  it('correctly configures Node.js and TypeScript inspect debug session', () => {
    const tsOption = {
      id: 'active:server.ts',
      name: 'server.ts',
      command: 'npx tsx "server.ts"',
      source: 'npm',
      badge: 'TS',
    };
    const res = resolveDebugConfig(tsOption);
    expect(res.type).toBe('terminal');
    expect(res.language).toBe('node');
    expect(res.port).toBe(9229);
    expect(res.command).toContain('npx tsx --inspect=9229 "server.ts"');

    const npmOption = {
      id: 'npm:dev',
      name: 'dev',
      command: 'npm run dev',
      source: 'npm',
      badge: 'npm',
    };
    const resNpm = resolveDebugConfig(npmOption);
    expect(resNpm.command).toBe('NODE_OPTIONS="--inspect=9229" npm run dev');
  });

  it('correctly configures Go delve debug session', () => {
    const goOption = {
      id: 'active:main.go',
      name: 'main.go',
      command: 'go run main.go',
      source: 'go',
      badge: 'Go',
    };
    const res = resolveDebugConfig(goOption);
    expect(res.type).toBe('terminal');
    expect(res.language).toBe('go');
    expect(res.port).toBe(2345);
    expect(res.command).toContain('dlv debug --headless --listen=127.0.0.1:2345 --api-version=2');
  });

  it('correctly routes C/C++ to DAP debug mode', () => {
    const cppOption = {
      id: 'active:main.cpp',
      name: 'main.cpp',
      command: 'clang++ -g main.cpp -o .echoly/bin/main',
      source: 'cpp',
      badge: 'C++',
    };
    const res = resolveDebugConfig(cppOption);
    expect(res.type).toBe('dap');
    expect(res.language).toBe('cpp');
  });
});

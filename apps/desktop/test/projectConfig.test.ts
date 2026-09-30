import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  PROJECT_META_FILE,
  buildProjectConfigMeta,
  projectConfigChildPath,
  projectConfigDir,
  projectConfigKey,
  projectConfigsRoot,
} from '../src/main/projectConfig';

/**
 * 项目配置目录的派生规则。
 *
 * 这套规则要同时满足两件互相拉扯的事：
 * 1. **跟随项目** —— 在同一台机器上，同一个项目每次都要落到同一个目录，否则用户
 *    「切个项目回来连接列表就空了」；不同项目必须落到不同目录，否则会串味。
 * 2. **不落进项目里** —— 输出永远是 `~/.echoly/projects/` 之下，无论工作区是本地的
 *    还是 SSH 远端的，也无论传进来的相对路径里塞了什么。
 */

const HOME = '/Users/tester';

describe('projectConfigKey · 项目标识的稳定性', () => {
  it('同一路径每次得到同一个 key', () => {
    expect(projectConfigKey('/Users/tester/proj')).toBe(projectConfigKey('/Users/tester/proj'));
  });

  it('不同项目得到不同 key', () => {
    const a = projectConfigKey('/Users/tester/proj-a');
    const b = projectConfigKey('/Users/tester/proj-b');
    expect(a).not.toBe(b);
    // 前缀相同的两个路径也必须区分开，不能只看前几段
    expect(projectConfigKey('/Users/tester/proj')).not.toBe(projectConfigKey('/Users/tester/projx'));
  });

  it('结尾斜杠 / 反斜杠 / 大小写差异不改变 key（同一目录的不同写法）', () => {
    const key = projectConfigKey('/Users/tester/proj');
    expect(projectConfigKey('/Users/tester/proj/')).toBe(key);
    expect(projectConfigKey('/Users/tester/proj///')).toBe(key);
    expect(projectConfigKey('\\Users\\tester\\proj')).toBe(key);
    // Windows 上 C:\Proj 与 c:\proj 是同一个目录，不该得到两份配置
    expect(projectConfigKey('C:\\Proj')).toBe(projectConfigKey('c:/proj'));
  });

  it('key 是定长十六进制，可直接当目录名（不含分隔符与大小写歧义）', () => {
    const key = projectConfigKey('/Users/tester/proj');
    expect(key).toMatch(/^[0-9a-f]{12}$/);
    expect(key).not.toContain('/');
  });

  it('前后空白被忽略，不会因为多敲一个空格就换一份配置', () => {
    expect(projectConfigKey('  /Users/tester/proj  ')).toBe(projectConfigKey('/Users/tester/proj'));
  });
});

describe('projectConfigDir · 落点永远在用户主目录', () => {
  it('目录形如 ~/.echoly/projects/<key>', () => {
    const dir = projectConfigDir('/Users/tester/proj', HOME);
    expect(dir).toBe(path.join(HOME, '.echoly', 'projects', projectConfigKey('/Users/tester/proj')));
    expect(dir.startsWith(projectConfigsRoot(HOME))).toBe(true);
  });

  it('SSH 远端工作区的根同样只参与哈希，落点仍是本机主目录', () => {
    // 远端路径 `/var/www/app` 在本机不存在，但它只是哈希的输入，不需要存在
    const dir = projectConfigDir('/var/www/app', HOME);
    expect(dir.startsWith(projectConfigsRoot(HOME))).toBe(true);
    expect(dir).not.toContain('/var/www');
  });

  it('目录名是哈希，不含项目名 —— 辨认靠 project.json', () => {
    expect(projectConfigDir('/Users/tester/我的项目', HOME)).not.toContain('我的项目');
    expect(PROJECT_META_FILE).toBe('project.json');
  });
});

describe('projectConfigChildPath · 相对路径的映射与围栏', () => {
  it('把工作区相对路径映射到配置目录下的本地绝对路径', () => {
    const root = '/Users/tester/proj';
    const expected = path.join(projectConfigDir(root, HOME), 'queries', 'db_mysql_a1b2', 'cvm');
    expect(projectConfigChildPath(root, 'queries/db_mysql_a1b2/cvm', HOME)).toBe(expected);
  });

  it('反斜杠分隔同样被接受（Windows 风格的相对路径）', () => {
    const root = '/Users/tester/proj';
    expect(projectConfigChildPath(root, 'queries\\x.sql', HOME)).toBe(
      projectConfigChildPath(root, 'queries/x.sql', HOME),
    );
  });

  it('空路径退回配置目录本身', () => {
    const root = '/Users/tester/proj';
    expect(projectConfigChildPath(root, '', HOME)).toBe(projectConfigDir(root, HOME));
    expect(projectConfigChildPath(root, '/', HOME)).toBe(projectConfigDir(root, HOME));
  });

  it('`..` 与 `.` 被剔除：恶意库名不可能让文件逃出配置目录', () => {
    const root = '/Users/tester/proj';
    const dir = projectConfigDir(root, HOME);
    for (const evil of [
      '../escape.sql',
      '../../escape.sql',
      'queries/../../escape.sql',
      '..\\..\\escape.sql',
      'queries/./../../etc/passwd',
    ]) {
      const out = projectConfigChildPath(root, evil, HOME);
      expect(out.startsWith(dir + path.sep)).toBe(true);
      expect(out).not.toContain('..');
    }
  });

  it('纯 `..` 路径退化为配置目录本身，而不是它的上一级', () => {
    const root = '/Users/tester/proj';
    expect(projectConfigChildPath(root, '..', HOME)).toBe(projectConfigDir(root, HOME));
    expect(projectConfigChildPath(root, '../../..', HOME)).toBe(projectConfigDir(root, HOME));
  });
});

describe('buildProjectConfigMeta · 目录里那张「我是谁」的便签', () => {
  it('原样记录项目根，不做归一化（用户要能照着它找到项目）', () => {
    const meta = buildProjectConfigMeta('/Users/tester/我的项目/', 'local', 0);
    expect(meta.root).toBe('/Users/tester/我的项目/');
    expect(meta.kind).toBe('local');
  });

  it('时间戳是 ISO 字符串，可直接读', () => {
    const meta = buildProjectConfigMeta('/p', 'ssh', Date.UTC(2026, 0, 2, 3, 4, 5));
    expect(meta.updatedAt).toBe('2026-01-02T03:04:05.000Z');
    expect(meta.kind).toBe('ssh');
  });
});

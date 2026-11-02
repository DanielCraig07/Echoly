import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_URL_POLICY } from '@deepseek-ide/tools';
import { fetchWebPage } from '../src/main/webService';

/** 只有显式进白名单的私网地址才允许抓 —— 测试全程按这个前提写。 */
const allowLoopback = { ...DEFAULT_URL_POLICY, allowedPrivateHosts: ['127.0.0.1'] };

describe('fetchWebPage', () => {
  let server: Server;
  let other: Server;
  let base = '';
  let otherBase = '';

  beforeAll(async () => {
    server = createServer((req, res) => {
      switch (req.url) {
        case '/a':
          res.writeHead(302, { location: '/b' });
          res.end();
          return;
        case '/b':
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(
            '<html><head><title>标题甲</title><style>b{color:red}</style></head>' +
              '<body><h1>正文</h1><p>段落一</p><script>evil()</script></body></html>',
          );
          return;
        case '/json':
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"a":1}');
          return;
        case '/big':
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('x'.repeat(50_000));
          return;
        case '/to-other':
          // 第一跳合法，第二跳打到未放行的主机 —— SSRF 的典型形态
          res.writeHead(302, { location: `${otherBase}/secret` });
          res.end();
          return;
        default:
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('nope');
      }
    });
    other = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('SECRET');
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));

    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // 同一个进程监听，但用 localhost 这个主机名访问 —— 它不在白名单里
    otherBase = `http://localhost:${(other.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => other.close(() => resolve())),
    ]);
  });

  it('抓取 HTML 并转成 Markdown，剥掉脚本与样式', async () => {
    const result = await fetchWebPage(`${base}/b`, { policy: allowLoopback });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.title).toBe('标题甲');
    expect(result.content).toContain('# 正文');
    expect(result.content).toContain('段落一');
    expect(result.content).not.toContain('evil()');
    expect(result.content).not.toContain('color:red');
  });

  it('未进白名单的私网地址一律拒绝', async () => {
    const result = await fetchWebPage(`${base}/b`);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('私有');
  });

  it('跟随重定向并回报最终地址', async () => {
    const result = await fetchWebPage(`${base}/a`, { policy: allowLoopback });
    expect(result.ok).toBe(true);
    expect(result.url).toBe(`${base}/b`);
    expect(result.content).toContain('正文');
  });

  it('重定向的每一跳都重新校验（第二跳打到未放行主机会被拦下）', async () => {
    const result = await fetchWebPage(`${base}/to-other`, { policy: allowLoopback });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('私有');
    expect(result.content ?? '').not.toContain('SECRET');
  });

  it('响应体超过上限时截断而不是整段读进内存', async () => {
    const result = await fetchWebPage(`${base}/big`, {
      policy: { ...allowLoopback, maxBytes: 1000 },
    });
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.content?.length ?? 0).toBeLessThanOrEqual(1000);
  });

  it('JSON 响应包成代码块，便于模型直接读', async () => {
    const result = await fetchWebPage(`${base}/json`, { policy: allowLoopback });
    expect(result.ok).toBe(true);
    expect(result.content).toContain('```json');
    expect(result.content).toContain('"a":1');
  });

  it('非 2xx 不当作成功', async () => {
    const result = await fetchWebPage(`${base}/missing`, { policy: allowLoopback });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.error).toContain('404');
  });
});

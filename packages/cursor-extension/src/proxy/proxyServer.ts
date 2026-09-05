import * as http from 'node:http';

export interface ProxyManager {
  port: number;
  start(): Promise<void>;
  stop(): void;
  isRunning(): boolean;
}

export function createProxyManager(
  port: number,
  targetBaseUrl: string,
): ProxyManager {
  const normalizedTarget = targetBaseUrl.replace(/\/+$/, '');
  let server: http.Server | null = null;
  let running = false;

  function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    // Health check
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', proxying: normalizedTarget }));
      return;
    }

    const targetUrl = `${normalizedTarget}${req.url ?? ''}`;
    const parsedUrl = new URL(targetUrl);

    const options: http.RequestOptions & { rejectUnauthorized?: boolean } = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: req.method,
      headers: {
        ...req.headers,
        host: parsedUrl.host,
      },
      rejectUnauthorized: false,
    };

    // Handle streaming (for chat completions)
    const isStreaming = req.method === 'POST' &&
      parsedUrl.pathname === '/v1/chat/completions';

    const proxyReq = http.request(options, (proxyRes) => {
      if (isStreaming) {
        // 透明转发 streaming 响应
        res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
        proxyRes.pipe(res);
      } else {
        // 非 streaming：缓存后转发
        const chunks: Buffer[] = [];
        proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
        proxyRes.on('end', () => {
          const body = Buffer.concat(chunks);
          res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
          res.end(body);
        });
      }
    });

    proxyReq.on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: `Proxy error: ${err.message}`,
          type: 'proxy_error',
        },
      }));
    });

    // Forward request body
    if (req.method === 'POST' || req.method === 'PUT') {
      req.pipe(proxyReq);
    } else {
      proxyReq.end();
    }
  }

  return {
    port,

    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        if (running) {
          resolve();
          return;
        }

        server = http.createServer(handleRequest);

        server.on('error', (err) => {
          running = false;
          reject(err);
        });

        server.listen(port, '127.0.0.1', () => {
          running = true;
          resolve();
        });
      });
    },

    stop(): void {
      if (server) {
        server.close();
        server = null;
      }
      running = false;
    },

    isRunning(): boolean {
      return running;
    },
  };
}

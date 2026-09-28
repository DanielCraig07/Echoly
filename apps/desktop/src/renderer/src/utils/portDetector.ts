/**
 * 从终端输出文本中智能提取本地监听的有效网络端口
 * 支持主流框架（Vite, Next.js, Webpack, Express, Spring Boot, FastAPI, Uvicorn 等）的启动日志
 */
export function detectPortsFromText(text: string): number[] {
  if (!text) return [];
  // 过滤 ANSI 颜色及光标转义字符
  const clean = text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');

  const ports = new Set<number>();

  // 1. URL 格式：http://localhost:3000, http://127.0.0.1:5173, http://0.0.0.0:8080 等
  const urlRegex = /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})/gi;
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(clean)) !== null) {
    const port = parseInt(match[1], 10);
    if (isValidPort(port)) {
      ports.add(port);
    }
  }

  // 2. 语义词格式：port 3000, port: 8080, listening on :4000, running on port 8000
  const portWordRegex = /(?:port|listening\s+on(?:\s+port)?|running\s+on(?:\s+port)?)\s*[:=]?\s*(?::)?(\d{2,5})\b/gi;
  while ((match = portWordRegex.exec(clean)) !== null) {
    const port = parseInt(match[1], 10);
    if (isValidPort(port)) {
      ports.add(port);
    }
  }

  return Array.from(ports);
}

function isValidPort(port: number): boolean {
  // 特许常见 web 端口 80, 443
  if (port === 80 || port === 443) return true;
  // 允许 1024 到 65535 之间的非特权端口
  return port >= 1024 && port <= 65535;
}

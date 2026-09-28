import { describe, expect, it } from 'vitest';
import { detectPortsFromText } from '../src/renderer/src/utils/portDetector';

describe('detectPortsFromText', () => {
  it('detects Vite dev server output with localhost URL', () => {
    const output = `
  VITE v5.4.2  ready in 324 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: use --host to expose
  ➜  press h + enter to show help
`;
    expect(detectPortsFromText(output)).toEqual([5173]);
  });

  it('detects Next.js / Express style output with 127.0.0.1 or 0.0.0.0', () => {
    const output1 = '   ▲ Next.js 14.1.0\n   - Local:        http://127.0.0.1:3000\n';
    expect(detectPortsFromText(output1)).toEqual([3000]);

    const output2 = 'INFO: Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)';
    expect(detectPortsFromText(output2)).toEqual([8000]);
  });

  it('detects semantic port phrases like port 8080 or listening on :4000', () => {
    expect(detectPortsFromText('Server started on port: 8080')).toEqual([8080]);
    expect(detectPortsFromText('listening on port 4000')).toEqual([4000]);
    expect(detectPortsFromText('running on port 9090')).toEqual([9090]);
  });

  it('filters out ANSI escape sequences', () => {
    const ansiOutput = '\x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5174\x1b[22m/\x1b[39m';
    expect(detectPortsFromText(ansiOutput)).toEqual([5174]);
  });

  it('ignores invalid ports or non-port numbers like HTTP status codes', () => {
    const output = 'HTTP/1.1 200 OK - Content-Length: 1024. Error code: 404 in year 2026.';
    expect(detectPortsFromText(output)).toEqual([]);
  });

  it('deduplicates multiple mentions of the same port', () => {
    const output = 'Local: http://localhost:3000, visit http://127.0.0.1:3000, listening on port 3000';
    expect(detectPortsFromText(output)).toEqual([3000]);
  });
});

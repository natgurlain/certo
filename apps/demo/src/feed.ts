/**
 * Event feed of `apps/demo/EVENTS.md`: an in-memory log of JSON messages,
 * served as Server-Sent Events at `/events` (full replay on connect) next to
 * the static page in `apps/demo/web/`.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { repoFile } from './sandbox.js';

export type FeedMessage = { kind: string; [k: string]: unknown };

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

export class Feed {
  readonly log: FeedMessage[] = [];
  private readonly clients = new Set<ServerResponse>();
  private server?: Server;

  emit(m: FeedMessage): void {
    const msg = { ...m, t: Date.now() };
    this.log.push(msg);
    const line = `data: ${JSON.stringify(msg)}\n\n`;
    for (const c of this.clients) c.write(line);
  }

  /** Serve `/events` and the static page; resolves with the bound port, or null if the port is taken. */
  async listen(port: number, webDir = repoFile('apps/demo/web')): Promise<number | null> {
    const root = normalize(webDir + sep);
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
        for (const m of this.log) res.write(`data: ${JSON.stringify(m)}\n\n`);
        this.clients.add(res);
        req.on('close', () => this.clients.delete(res));
        return;
      }
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const file = normalize(join(root, rel));
      if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
        if (url.pathname === '/') {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('The demo page (apps/demo/web/index.html) is not present. The event feed is at /events.\n');
          return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found\n');
        return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      createReadStream(file).pipe(res);
    });
    const bound = await new Promise<number | null>((resolve) => {
      server.once('error', () => resolve(null));
      server.listen(port, () => {
        const a = server.address();
        resolve(typeof a === 'object' && a ? a.port : port);
      });
    });
    if (bound !== null) this.server = server;
    return bound;
  }

  async close(): Promise<void> {
    for (const c of this.clients) c.end();
    this.clients.clear();
    const s = this.server;
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
}

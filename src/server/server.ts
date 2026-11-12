import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Simulation } from '../sim/simulation.js';
import type { Recorder } from '../sim/recorder.js';
import type { Command, ReplayFile, TickDelta } from '../sim/types.js';
import { personalities } from '../agents/personalities.js';
import { scenarios } from '../scenarios/index.js';
import { VERSION } from '../version.js';

const DASHBOARD_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dashboard');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

export const SPEEDS = [0.5, 1, 2, 5, 10, 25];
/** Ticks per second at 1x. */
const BASE_TPS = 4;

export interface ServerOptions {
  port: number;
  host: string;
  mode: 'live' | 'replay';
  sim?: Simulation;
  recorder?: Recorder;
  replay?: ReplayFile;
  speed?: number;
  /** Stop advancing after this tick (0 = run forever). */
  maxTicks?: number;
  onListen?: (url: string) => void;
}

/**
 * Serves the dashboard and drives the live market loop.
 *   GET  /api/state    full history (replay-file shape) + status
 *   GET  /api/stream   Server-Sent Events, one "tick" event per simulated minute
 *   POST /api/control  { action: pause|resume|speed|command, value?, cmd? }
 *   GET  /api/replay   download the recording so far
 */
export function startServer(opts: ServerOptions) {
  const clients = new Set<ServerResponse>();
  let paused = false;
  let speed = opts.speed ?? 1;
  let timer: NodeJS.Timeout | null = null;
  let stepping = false;
  let buffered: TickDelta[] = [];

  const status = () => ({ paused, speed, speeds: SPEEDS, mode: opts.mode, tick: opts.sim?.tick ?? opts.replay?.meta.ticks ?? 0 });

  function broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(payload);
  }

  async function loop(): Promise<void> {
    timer = null;
    if (opts.mode !== 'live' || !opts.sim || !opts.recorder || paused) return;
    if (opts.maxTicks && opts.sim.tick >= opts.maxTicks) {
      paused = true;
      broadcast('status', status());
      return;
    }
    const started = Date.now();
    // At high speed run several ticks per frame so the browser isn't flooded with events.
    const tps = BASE_TPS * speed;
    const batch = Math.max(1, Math.round(tps / 20));
    stepping = true;
    try {
      for (let i = 0; i < batch; i++) {
        const d = await opts.sim.step();
        opts.recorder.push(d);
        buffered.push(d);
      }
    } catch (e) {
      console.error('[agentstreet] tick failed:', e);
      paused = true;
    } finally {
      stepping = false;
    }
    broadcast('ticks', buffered);
    buffered = [];
    const wait = Math.max(0, (1000 * batch) / tps - (Date.now() - started));
    timer = setTimeout(loop, wait);
  }

  function schedule(): void {
    if (!timer && !stepping && !paused) timer = setTimeout(loop, 0);
  }

  async function body(req: IncomingMessage): Promise<any> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 64 * 1024) throw new Error('body too large');
      chunks.push(c as Buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  }

  function json(res: ServerResponse, code: number, data: unknown): void {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;

      if (path === '/api/state') {
        const data = opts.mode === 'live' ? opts.recorder!.toJSON() : opts.replay!;
        return json(res, 200, {
          app: VERSION,
          status: status(),
          data,
          personalities: personalities().map((p) => ({ id: p.id, label: p.label, description: p.description })),
          scenarios: scenarios().map((s) => ({ id: s.id, name: s.name, description: s.description })),
          llm: opts.sim?.llmUsage() ?? [],
        });
      }

      if (path === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(`event: status\ndata: ${JSON.stringify(status())}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
        req.on('close', () => {
          clearInterval(ping);
          clients.delete(res);
        });
        return;
      }

      if (path === '/api/control' && req.method === 'POST') {
        if (opts.mode !== 'live') return json(res, 400, { error: 'replay mode is read-only' });
        const b = await body(req);
        switch (b.action) {
          case 'pause':
            paused = true;
            break;
          case 'resume':
            paused = false;
            if (opts.maxTicks && opts.sim!.tick >= opts.maxTicks) opts.maxTicks = 0;
            schedule();
            break;
          case 'speed':
            if (SPEEDS.includes(Number(b.value))) speed = Number(b.value);
            break;
          case 'command': {
            const cmd = validateCommand(b.cmd, opts.sim!);
            if (!cmd) return json(res, 400, { error: 'bad command' });
            opts.sim!.command(cmd);
            break;
          }
          default:
            return json(res, 400, { error: 'unknown action' });
        }
        broadcast('status', status());
        return json(res, 200, status());
      }

      if (path === '/api/replay') {
        const data = opts.mode === 'live' ? opts.recorder!.toJSON() : opts.replay!;
        const name = `agentstreet-${data.meta.scenario}-seed${data.meta.seed}-t${data.meta.ticks}.street.json`;
        res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': `attachment; filename="${name}"` });
        return res.end(JSON.stringify(data));
      }

      // Static dashboard files.
      const rel = path === '/' ? 'index.html' : decodeURIComponent(path.slice(1));
      const file = normalize(join(DASHBOARD_DIR, rel));
      if (!file.startsWith(DASHBOARD_DIR) || !existsSync(file)) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('not found');
      }
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(await readFile(file));
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  server.listen(opts.port, opts.host, () => {
    const shown = opts.host === '0.0.0.0' || opts.host === '::' ? 'localhost' : opts.host;
    opts.onListen?.(`http://${shown}:${opts.port}`);
    schedule();
  });

  return {
    server,
    close: () => {
      if (timer) clearTimeout(timer);
      for (const c of clients) c.end();
      server.close();
    },
  };
}

function validateCommand(c: any, sim: Simulation): Command | null {
  if (!c || typeof c !== 'object') return null;
  const sym = (s: unknown) => (typeof s === 'string' && sim.symbols.some((x) => x.symbol === s) ? s : null);
  switch (c.type) {
    case 'news': {
      const tone = c.tone === 'negative' ? 'negative' : 'positive';
      const kinds = ['breaking', 'earnings', 'product', 'rumor', 'scandal', 'macro', 'analyst', 'social', 'legal'];
      const kind = kinds.includes(c.kind) ? c.kind : 'breaking';
      const headline = typeof c.headline === 'string' && c.headline.trim() ? c.headline.trim().slice(0, 140) : undefined;
      return { type: 'news', symbol: kind === 'macro' ? null : sym(c.symbol), tone, kind, headline };
    }
    case 'rate': {
      const bps = Math.round(Number(c.bps));
      return Number.isFinite(bps) && Math.abs(bps) <= 500 ? { type: 'rate', bps } : null;
    }
    case 'crash': {
      const s = sym(c.symbol);
      return s ? { type: 'crash', symbol: s, size: Math.min(3, Math.max(0.2, Number(c.size) || 1)) } : null;
    }
    case 'pump': {
      const s = sym(c.symbol);
      return s ? { type: 'pump', symbol: s } : null;
    }
    case 'halt':
      return { type: 'halt', symbol: c.symbol === null ? null : sym(c.symbol), ticks: Math.min(120, Math.max(1, Number(c.ticks) || 15)) };
    default:
      return null;
  }
}

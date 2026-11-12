import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Simulation } from '../sim/simulation.js';
import type { Recorder } from '../sim/recorder.js';
import type { Command, ReplayFile, TickDelta } from '../sim/types.js';
import { personalities } from '../agents/personalities.js';
import { scenarios } from '../scenarios/index.js';
import { VERSION } from '../version.js';
import { findHighlights, type Highlight } from '../metrics/highlights.js';
import { envKeysPresent, detectOllama, listModels, PROVIDERS, type ModelInfo, type ProviderId } from '../agents/brains/providers.js';
import { readConfig, saveKeys, writeConfig, type AppConfig } from '../config/store.js';
import { maskKey, redact } from '../safety/redact.js';
import { DEFAULT_LIMITS } from '../safety/limits.js';
import { KEY_ENV } from '../agents/brains/providers.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATIC: Record<string, string> = { '': join(ROOT, 'dashboard'), locales: join(ROOT, 'locales') };

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

export const SPEEDS = [0.5, 1, 2, 5, 10, 25];
/** Ticks per second at 1x. */
const BASE_TPS = 4;

export interface Market {
  sim: Simulation;
  recorder: Recorder;
}

export interface ServerOptions {
  port: number;
  host: string;
  mode: 'live' | 'replay';
  /** Live: the running market, or null to start in the onboarding phase. */
  market?: Market | null;
  /** Live: builds a market once onboarding is saved. */
  makeMarket?: (cfg: AppConfig) => Market;
  replay?: ReplayFile;
  speed?: number;
  maxTicks?: number;
  onListen?: (url: string) => void;
}

/** Fixed-window limiter for HTTP endpoints. */
function windowLimiter(max: number, ms: number) {
  let start = Date.now();
  let n = 0;
  return () => {
    const now = Date.now();
    if (now - start > ms) (start = now), (n = 0);
    return ++n <= max;
  };
}

/**
 * Serves the dashboard, the onboarding wizard and the live market loop.
 *   GET  /api/state           phase, history (replay-file shape), status, highlights
 *   GET  /api/stream          Server-Sent Events: "ticks" batches and "status"
 *   POST /api/control         pause | resume | speed | command
 *   GET  /api/setup           detected keys (booleans only), local Ollama, saved config
 *   POST /api/setup/models    validate a key by listing that provider's models
 *   POST /api/setup/save      write .agentstreet/.env + config.json, open the market
 *   GET  /api/agent/:i        live X-ray: last prompt/reply of an LLM trader
 *   GET  /api/replay          download the recording so far
 */
export function startServer(opts: ServerOptions) {
  const clients = new Set<ServerResponse>();
  let market: Market | null = opts.market ?? null;
  let paused = false;
  let speed = opts.speed ?? 1;
  let timer: NodeJS.Timeout | null = null;
  let stepping = false;
  let closed = false;
  let buffered: TickDelta[] = [];
  let hlCache: { t: number; list: Highlight[] } = { t: -1, list: [] };
  const catalog = new Map<ProviderId, ModelInfo[]>();
  const pendingKeys = new Map<ProviderId, string>();
  const controlLimit = windowLimiter(40, 10_000);
  const setupLimit = windowLimiter(20, 60_000);

  const phase = () => (opts.mode === 'replay' ? 'replay' : market ? 'live' : 'setup');
  const status = () => ({ paused, speed, speeds: SPEEDS, mode: opts.mode, phase: phase(), tick: market?.sim.tick ?? opts.replay?.meta.ticks ?? 0 });

  function data(): ReplayFile | null {
    return opts.mode === 'live' ? (market?.recorder.toJSON() ?? null) : opts.replay!;
  }

  function highlights(): Highlight[] {
    const d = data();
    if (!d) return [];
    const t = d.meta.ticks;
    if (t - hlCache.t >= 10 || hlCache.t < 0 || opts.mode === 'replay') hlCache = { t, list: findHighlights(d) };
    return hlCache.list;
  }

  function broadcast(event: string, payload: unknown): void {
    const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const c of clients) c.write(msg);
  }

  async function loop(): Promise<void> {
    timer = null;
    if (closed || opts.mode !== 'live' || !market || paused) return;
    const { sim, recorder } = market;
    if (opts.maxTicks && sim.tick >= opts.maxTicks) {
      paused = true;
      broadcast('status', status());
      return;
    }
    const started = Date.now();
    const tps = BASE_TPS * speed;
    const batch = Math.min(Math.max(1, Math.round(tps / 20)), opts.maxTicks ? opts.maxTicks - sim.tick : Infinity);
    stepping = true;
    try {
      for (let i = 0; i < batch; i++) {
        const d = await sim.step();
        recorder.push(d);
        buffered.push(d);
      }
    } catch (e) {
      console.error('[agentstreet] tick failed:', redact(e instanceof Error ? e.stack ?? e.message : String(e)));
      paused = true;
    } finally {
      stepping = false;
    }
    if (closed) return;
    broadcast('ticks', buffered);
    buffered = [];
    if (sim.tick % 20 === 0) broadcast('highlights', highlights());
    const wait = Math.max(0, (1000 * batch) / tps - (Date.now() - started));
    timer = setTimeout(loop, wait);
  }

  function schedule(): void {
    if (!closed && !timer && !stepping && !paused) timer = setTimeout(loop, 0);
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

  function json(res: ServerResponse, code: number, payload: unknown): void {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(payload));
  }

  function validHost(req: IncomingMessage): boolean {
    const host = String(req.headers.host ?? '');
    return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host) || !['127.0.0.1', 'localhost', '::1'].includes(opts.host);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      if (!validHost(req)) return json(res, 403, { error: 'invalid host' });
      if (req.method === 'POST') {
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json(res, 403, { error: 'cross-origin request refused' });
        if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, 415, { error: 'expected application/json' });
      }

      if (path === '/api/state') {
        const cfg = readConfig();
        return json(res, 200, {
          app: VERSION,
          status: status(),
          data: data(),
          highlights: highlights(),
          personalities: personalities().map((p) => ({ id: p.id, label: p.label, description: p.description })),
          scenarios: scenarios().map((s) => ({ id: s.id, name: s.name, description: s.description })),
          llm: market?.sim.llmUsage() ?? [],
          limits: market?.sim.guard.limits ?? DEFAULT_LIMITS,
          config: cfg ? { mode: cfg.mode, models: cfg.models, language: cfg.language ?? null } : null,
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

      if (path === '/api/highlights') return json(res, 200, highlights());

      const agentMatch = path.match(/^\/api\/agent\/(\d+)$/);
      if (agentMatch) {
        const a = market?.sim.agents[Number(agentMatch[1])];
        if (!a) return json(res, 404, { error: 'no such agent' });
        const ex = market!.sim.guard.lastExchange.get(a.info.id);
        const usage = market!.sim.guard.budget.perAgent.get(a.info.id) ?? null;
        return json(res, 200, { exchange: ex ? { ...ex, prompt: redact(ex.prompt), reply: redact(ex.reply) } : null, usage });
      }

      /* ───────── onboarding ───────── */

      if (path === '/api/setup' && req.method === 'GET') {
        const cfg = readConfig();
        const ollama = await detectOllama();
        const env = envKeysPresent();
        const saved: Record<string, string> = {};
        for (const p of PROVIDERS) {
          const name = KEY_ENV[p];
          if (name && process.env[name]) saved[p] = maskKey(process.env[name]);
        }
        return json(res, 200, { env, saved, ollama: { running: !!ollama, models: ollama ?? [] }, config: cfg, limits: DEFAULT_LIMITS });
      }

      if (path === '/api/setup/models' && req.method === 'POST') {
        if (opts.mode !== 'live') return json(res, 400, { error: 'setup is only available in live mode' });
        if (!setupLimit()) return json(res, 429, { error: 'too many attempts, wait a minute' });
        const b = await body(req);
        const provider = b.provider as ProviderId;
        if (!PROVIDERS.includes(provider)) return json(res, 400, { error: 'unknown provider' });
        const key = typeof b.key === 'string' && b.key.trim() ? b.key.trim() : undefined;
        if (key) pendingKeys.delete(provider);
        try {
          const models = await listModels(provider, key);
          catalog.set(provider, models);
          if (key) pendingKeys.set(provider, key);
          return json(res, 200, { ok: true, models: models.slice(0, 400) });
        } catch (e) {
          return json(res, 200, { ok: false, error: redact(e instanceof Error ? e.message : String(e)) });
        }
      }

      if (path === '/api/setup/save' && req.method === 'POST') {
        if (opts.mode !== 'live') return json(res, 400, { error: 'setup is only available in live mode' });
        const b = await body(req);
        const mode = b.mode === 'offline' ? 'offline' : 'llm';
        const models: string[] = Array.isArray(b.models) ? [...new Set<string>(b.models.filter((m: unknown) =>
          typeof m === 'string' && /^[a-z]+:[^\s]{1,200}$/.test(m) && PROVIDERS.includes(m.split(':')[0] as ProviderId),
        ))].slice(0, 8) : [];
        if (mode === 'llm' && models.length === 0) return json(res, 400, { error: 'pick at least one model, or choose offline mode' });
        const keys: Partial<Record<ProviderId, string>> = {};
        for (const p of new Set((mode === 'llm' ? models : []).map((m) => m.split(':')[0] as ProviderId))) {
          const k = pendingKeys.get(p);
          if (k) keys[p] = k;
        }
        try {
          if (Object.keys(keys).length) saveKeys(keys);
        } catch (e) {
          return json(res, 400, { error: redact(e instanceof Error ? e.message : String(e)) });
        }
        pendingKeys.clear();
        const prices: Record<string, { input: number; output: number }> = {};
        for (const m of models) {
          const [p, ...rest] = m.split(':');
          const info = catalog.get(p as ProviderId)?.find((x) => x.id === rest.join(':'));
          if (info?.price) prices[m] = info.price;
        }
        const limits = {
          ...DEFAULT_LIMITS,
          ...(b.limits && typeof b.limits === 'object'
            ? Object.fromEntries(Object.entries(b.limits).filter(([k, v]) => Object.hasOwn(DEFAULT_LIMITS, k)
              && typeof v === 'number' && v < 1e9 && v >= (['rpm', 'concurrency', 'maxOutputTokens'].includes(k) ? 1 : 0)))
            : {}),
        };
        const language = typeof b.language === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(b.language) ? b.language : undefined;
        const cfg = writeConfig({ mode, models: mode === 'llm' ? models : [], prices, limits, language, newsWriter: null });
        if (!market && opts.makeMarket) {
          market = opts.makeMarket(cfg);
          paused = false;
          schedule();
        }
        broadcast('status', status());
        return json(res, 200, { ok: true, restartNeeded: !!market && opts.market !== undefined && opts.market !== null });
      }

      /* ───────── market control ───────── */

      if (path === '/api/control' && req.method === 'POST') {
        if (opts.mode !== 'live' || !market) return json(res, 400, { error: 'no live market' });
        if (!controlLimit()) return json(res, 429, { error: 'slow down' });
        const b = await body(req);
        switch (b.action) {
          case 'pause':
            paused = true;
            break;
          case 'resume':
            paused = false;
            if (opts.maxTicks && market.sim.tick >= opts.maxTicks) opts.maxTicks = 0;
            schedule();
            break;
          case 'speed':
            if (SPEEDS.includes(Number(b.value))) speed = Number(b.value);
            break;
          case 'command': {
            const cmd = validateCommand(b.cmd, market.sim);
            if (!cmd) return json(res, 400, { error: 'bad command' });
            market.sim.command(cmd);
            break;
          }
          default:
            return json(res, 400, { error: 'unknown action' });
        }
        broadcast('status', status());
        return json(res, 200, status());
      }

      if (path === '/api/replay') {
        const d = data();
        if (!d) return json(res, 404, { error: 'nothing recorded yet' });
        const name = `agentstreet-${d.meta.scenario}-seed${d.meta.seed}-t${d.meta.ticks}.street.json`;
        res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': `attachment; filename="${name}"` });
        return res.end(JSON.stringify(d));
      }

      // Static files: dashboard/ at the root, locales/ under /locales/.
      const rel = path === '/' ? 'index.html' : decodeURIComponent(path.slice(1));
      const [first, ...restParts] = rel.split('/');
      const base = first === 'locales' ? STATIC.locales! : STATIC['']!;
      const relPath = first === 'locales' ? restParts.join('/') : rel;
      const file = normalize(join(base, relPath));
      if (!(file === base || file.startsWith(base + sep)) || !existsSync(file)) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('not found');
      }
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
      res.end(await readFile(file));
    } catch (e) {
      json(res, 500, { error: redact(e instanceof Error ? e.message : String(e)) });
    }
  });

  server.listen(opts.port, opts.host, () => {
    const shown = opts.host === '0.0.0.0' || opts.host === '::' ? 'localhost' : opts.host;
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : opts.port;
    opts.onListen?.(`http://${shown.includes(':') ? `[${shown}]` : shown}:${port}`);
    schedule();
  });

  return {
    server,
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      for (const c of clients) c.end();
      server.close();
    },
  };
}

const NEWS_KINDS = ['breaking', 'earnings', 'product', 'rumor', 'scandal', 'macro', 'analyst', 'social', 'legal'];

function validateCommand(c: any, sim: Simulation): Command | null {
  if (!c || typeof c !== 'object') return null;
  const sym = (s: unknown) => (typeof s === 'string' && sim.symbols.some((x) => x.symbol === s) ? s : null);
  switch (c.type) {
    case 'news': {
      const tone = c.tone === 'negative' ? 'negative' : 'positive';
      const kind = NEWS_KINDS.includes(c.kind) ? c.kind : 'breaking';
      // Headlines are untrusted user text: strip control characters, cap the length.
      const headline =
        typeof c.headline === 'string' && c.headline.trim()
          ? c.headline.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140)
          : undefined;
      const magnitude = Number.isFinite(Number(c.magnitude)) ? Math.min(2, Math.max(0.2, Number(c.magnitude))) : undefined;
      const delay = Number.isFinite(Number(c.delay)) ? Math.min(390, Math.max(0, Math.round(Number(c.delay)))) : undefined;
      return { type: 'news', symbol: kind === 'macro' ? null : sym(c.symbol), tone, kind, headline, magnitude, delay };
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

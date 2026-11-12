import { gzipSync, gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Simulation } from './simulation.js';
import type { ReplayFile, TickDelta } from './types.js';
import { VERSION } from '../version.js';

/**
 * Accumulates every tick's delta. The same structure feeds the live
 * dashboard (history + stream) and is written out as a replay file.
 */
export class Recorder {
  readonly data: ReplayFile;
  private truncated = false;

  constructor(private readonly sim: Simulation) {
    this.data = {
      format: 'agentstreet-replay',
      version: 1,
      meta: {
        app: `agentstreet@${VERSION}`,
        created: new Date().toISOString(),
        scenario: sim.cfg.scenario,
        seed: sim.cfg.seed,
        ticks: 0,
        firstTick: 1,
        hash: sim.tradeHash(),
        truncated: false,
      },
      config: sim.cfg,
      symbols: sim.symbols.map((s) => ({ symbol: s.symbol, name: s.name, sector: s.sector, blurb: s.blurb, shares: s.shares, price: s.price })),
      agents: sim.agentInfos(),
      inputs: sim.inputs,
      llm: sim.llmLog,
      frames: [],
      trades: [],
      news: [],
      thoughts: [],
      events: [],
      equity: [],
    };
  }

  push(d: TickDelta): void {
    const r = this.data;
    r.frames.push(d.frame);
    for (const x of d.trades) r.trades.push(x);
    for (const x of d.news) r.news.push(x);
    for (const x of d.thoughts) r.thoughts.push(x);
    for (const x of d.events) r.events.push(x);
    if (d.equity) r.equity.push(d.equity);
    r.meta.ticks = d.frame.t;
    r.meta.hash = this.sim.tradeHash();
    const max = this.sim.cfg.maxHistory;
    if (max > 0 && r.frames.length > max * 1.1) this.trim(max);
  }

  /** Drop the oldest history in live mode so memory stays bounded. */
  private trim(keep: number): void {
    const r = this.data;
    const cut = r.frames[r.frames.length - keep]!.t;
    r.frames.splice(0, r.frames.length - keep);
    const drop = <T extends { t: number } | number[]>(xs: T[], tOf: (x: T) => number) => {
      let i = 0;
      while (i < xs.length && tOf(xs[i]!) < cut) i++;
      xs.splice(0, i);
    };
    drop(r.trades, (x) => x[0]!);
    drop(r.thoughts, (x) => x.t);
    drop(r.equity, (x) => x.t);
    drop(r.news, (x) => x.t);
    drop(r.events, (x) => x.t);
    r.meta.firstTick = cut;
    this.truncated = true;
    r.meta.truncated = true;
  }

  toJSON(): ReplayFile {
    return this.data;
  }

  save(path: string): number {
    mkdirSync(dirname(path), { recursive: true });
    const json = JSON.stringify(this.data);
    const buf = path.endsWith('.gz') ? gzipSync(json) : Buffer.from(json);
    writeFileSync(path, buf);
    return buf.length;
  }
}

export function loadReplay(path: string): ReplayFile {
  let buf = readFileSync(path);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
  const r = JSON.parse(buf.toString('utf8')) as ReplayFile;
  if (r.format !== 'agentstreet-replay') throw new Error(`${path} is not an AgentStreet replay`);
  return r;
}

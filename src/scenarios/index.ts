import type { Simulation } from '../sim/simulation.js';
import type { SimConfig } from '../sim/types.js';

/**
 * A scenario is a plugin: config overrides plus optional hooks that run
 * inside the deterministic tick loop. Use sim.apply(cmd) to act, and
 * sim.newsTilt / sim.newsroom.rate to shape the news flow.
 *
 *   export default {
 *     id: 'my-crash', name: 'My crash', description: '...',
 *     onTick(sim, t) { if (t === 100) sim.apply({ type: 'crash', symbol: 'QBTX' }); },
 *   } satisfies Scenario;
 */
export interface Scenario {
  id: string;
  name: string;
  description: string;
  config?: Partial<SimConfig>;
  setup?(sim: Simulation): void;
  onTick?(sim: Simulation, t: number): void;
}

const normalDay: Scenario = {
  id: 'default',
  name: 'Just Another Day',
  description: 'Random news, a few rumors, the usual chaos. Bubbles and crashes emerge on their own.',
};

const memeMania: Scenario = {
  id: 'meme-mania',
  name: 'Meme Mania',
  description:
    'Rates are low and CatNet Media (MEOW) goes viral. Retail piles in with leverage, value investors short it, and then the central bank remembers inflation exists.',
  config: { rate: 0.01, newsRate: 0.08, mix: { 'market-maker': 4, value: 6, momentum: 10, panic: 8, rumor: 12, contrarian: 4, retail: 48, degen: 12 } },
  onTick(sim, t) {
    if (t === 20 || t === 80 || t === 140 || t === 200) sim.apply({ type: 'pump', symbol: 'MEOW' });
    if (t === 60) sim.apply({ type: 'news', symbol: 'MEOW', tone: 'positive', kind: 'rumor' });
    if (t < 300) sim.newsTilt = 0.15;
    if (t === 300) {
      sim.newsTilt = -0.1;
      sim.apply({ type: 'news', symbol: 'MEOW', tone: 'negative', kind: 'scandal' });
    }
    if (t === 340) sim.apply({ type: 'rate', bps: 75 });
    if (t === 420) sim.newsTilt = 0;
  },
};

const flashCrash: Scenario = {
  id: 'flash-crash',
  name: 'Flash Crash',
  description:
    'At 10:30 a whale fat-fingers a giant market sell in Qubitron (QBTX). Watch the circuit breakers, the margin calls and the cascade, and who buys the dip.',
  onTick(sim, t) {
    if (t === 60) sim.apply({ type: 'crash', symbol: 'QBTX', size: 1.5 });
    if (t === 64) sim.apply({ type: 'crash', symbol: 'ORBF', size: 1 });
    if (t === 90) sim.apply({ type: 'news', symbol: null, tone: 'negative', kind: 'macro', headline: 'Exchange investigates "erroneous" trades; panic spreads' });
  },
};

const rateShock: Scenario = {
  id: 'rate-shock',
  name: 'Rate Shock',
  description: 'The central bank hikes 50bp every hour for four hours. Long-duration growth stocks (Quantum, Space) suffer the most.',
  onTick(sim, t) {
    if (t % 60 === 0 && t <= 240) sim.apply({ type: 'rate', bps: 50 });
    if (t >= 60 && t <= 300) sim.newsTilt = -0.12;
    if (t === 301) sim.newsTilt = 0;
  },
};

const earningsSeason: Scenario = {
  id: 'earnings-season',
  name: 'Earnings Season',
  description: 'Triple the news flow. Beats, misses, guidance cuts and analyst whiplash all day long.',
  config: { newsRate: 0.18 },
};

const BUILTIN: Scenario[] = [normalDay, memeMania, flashCrash, rateShock, earningsSeason];
const registry = new Map<string, Scenario>(BUILTIN.map((s) => [s.id, s]));

export function registerScenario(s: Scenario): void {
  registry.set(s.id, s);
}

export function getScenario(id: string): Scenario {
  const s = registry.get(id);
  if (!s) throw new Error(`Unknown scenario "${id}". Known: ${[...registry.keys()].join(', ')}`);
  return s;
}

export function scenarios(): Scenario[] {
  return [...registry.values()];
}

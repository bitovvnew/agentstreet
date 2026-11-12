import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation.js';
import { Recorder } from '../src/sim/recorder.js';
import { Rng } from '../src/core/rng.js';
import { Newsroom, publicNews } from '../src/news/newsroom.js';
import { DEFAULT_UNIVERSE } from '../src/sim/universe.js';
import { sanitizeDecision, renderObservation, LlmBrain } from '../src/agents/brains/index.js';
import { extractJson } from '../src/agents/brains/providers.js';
import { scoreAgents, groupScores } from '../src/metrics/leaderboard.js';
import type { Observation } from '../src/agents/types.js';

async function run(sim: Simulation, ticks: number) {
  const rec = new Recorder(sim);
  for (let i = 0; i < ticks; i++) rec.push(await sim.step());
  return rec;
}

describe('Rng', () => {
  it('is deterministic and forks independently', () => {
    const a = new Rng(1);
    const b = new Rng(1);
    expect([a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next()]);
    expect(new Rng('x').fork('a').next()).not.toBe(new Rng('x').fork('b').next());
    const r = new Rng(9);
    for (let i = 0; i < 1000; i++) {
      const v = r.int(3, 5);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(5);
    }
  });
});

describe('Simulation', () => {
  it('is reproducible: same seed, same trades', async () => {
    const a = await run(new Simulation({ seed: 11 }), 150);
    const b = await run(new Simulation({ seed: 11 }), 150);
    expect(a.data.meta.hash).toBe(b.data.meta.hash);
    expect(a.data.trades.length).toBeGreaterThan(100);
    const c = await run(new Simulation({ seed: 12 }), 150);
    expect(c.data.meta.hash).not.toBe(a.data.meta.hash);
  });

  it('replays recorded user commands bit-for-bit', async () => {
    const live = new Simulation({ seed: 5 });
    const rec = new Recorder(live);
    for (let t = 1; t <= 120; t++) {
      if (t === 30) live.command({ type: 'crash', symbol: 'QBTX' });
      if (t === 50) live.command({ type: 'rate', bps: 50 });
      if (t === 70) live.command({ type: 'news', symbol: 'MEOW', tone: 'positive', kind: 'rumor' });
      rec.push(await live.step());
    }
    const again = new Simulation(rec.data.config);
    const inputs = [...rec.data.inputs];
    for (let t = 1; t <= 120; t++) {
      while (inputs.length && inputs[0]!.t === t) again.command(inputs.shift()!.cmd);
      await again.step();
    }
    expect(again.tradeHash()).toBe(rec.data.meta.hash);
    expect(rec.data.events.some((e) => e.type === 'crash')).toBe(true);
    expect(rec.data.events.some((e) => e.type === 'rate')).toBe(true);
  });

  it('conserves shares across all accounts', async () => {
    const sim = new Simulation({ seed: 3, scenario: 'flash-crash' });
    const before = new Map<string, number>();
    for (const s of sim.symbols) {
      let q = 0;
      for (const a of sim.exchange.accounts.values()) q += a.pos(s.symbol);
      before.set(s.symbol, q);
    }
    await run(sim, 200);
    for (const s of sim.symbols) {
      let q = 0;
      for (const a of sim.exchange.accounts.values()) q += a.pos(s.symbol);
      // The whale is topped up when it fat-fingers; everything else nets out.
      expect(q).toBeGreaterThanOrEqual(before.get(s.symbol)!);
    }
  });

  it('flash-crash scenario trips circuit breakers', async () => {
    const rec = await run(new Simulation({ seed: 7, scenario: 'flash-crash' }), 160);
    expect(rec.data.events.some((e) => e.type === 'halt')).toBe(true);
    expect(rec.data.trades.some((t) => t[7] & 2)).toBe(true);
  });

  it('records compact frames for the dashboard', async () => {
    const rec = await run(new Simulation({ seed: 1 }), 20);
    const f = rec.data.frames[19]!;
    expect(f.t).toBe(20);
    expect(f.sym).toHaveLength(DEFAULT_UNIVERSE.length);
    expect(f.depth[0]![0].length).toBeGreaterThan(0);
    expect(f.clock).toBe('D1 09:49');
    expect(rec.data.equity[0]!.eq).toHaveLength(rec.data.agents.length);
  });

  it('runs LLM teams through a pluggable brain and records their decisions', async () => {
    const fake = {
      id: 'fake:model',
      async chat() {
        return { text: '{"thought":"buying the dip","orders":[{"symbol":"GRDX","side":"buy","type":"market","qty":10}]}', inputTokens: 10, outputTokens: 5 };
      },
    };
    const brain = new LlmBrain(fake);
    const sim = new Simulation({ seed: 2, models: ['fake:model'], llmEvery: 5 }, { brains: { 'fake:model': brain } });
    const rec = await run(sim, 30);
    expect(rec.data.agents.filter((a) => a.team === 'fake:model')).toHaveLength(5);
    expect(rec.data.llm.length).toBeGreaterThan(0);
    expect(brain.stats.calls).toBeGreaterThan(0);
    expect(rec.data.thoughts.some((t) => t.text === 'buying the dip')).toBe(true);
    // Replaying with recorded decisions reproduces the market without calling the model.
    const replay = new Simulation({ ...rec.data.config }, { replayLlm: rec.data.llm });
    for (let i = 0; i < 30; i++) await replay.step();
    expect(replay.tradeHash()).toBe(rec.data.meta.hash);
  });
});

describe('Newsroom', () => {
  it('hides ground truth from agents and resolves rumors', () => {
    const nr = new Newsroom(new Rng(4), DEFAULT_UNIVERSE, 0);
    const r = nr.make({ symbol: 'MEOW', kind: 'rumor', tone: 'positive' }, 1);
    expect(r.rumor).toBeDefined();
    const pub = publicNews(r) as Record<string, unknown>;
    expect(pub.impact).toBeUndefined();
    expect(pub.rumor).toBeUndefined();
    expect(pub.isRumor).toBe(true);
    const later = nr.tick(r.rumor!.resolvesAt);
    expect(later.some((n) => n.followUpOf === r.id && (n.kind === 'confirm' || n.kind === 'debunk'))).toBe(true);
  });
});

describe('LLM decision handling', () => {
  const obs: Observation = {
    tick: 10,
    clock: 'D1 09:39',
    agentId: 'a1',
    cash: 1_000_000,
    equity: 1_000_000,
    startEquity: 1_000_000,
    buyingPower: 500_000,
    positions: { GRDX: 20 },
    openOrders: [],
    markets: [
      { symbol: 'GRDX', name: 'NovaGrid', sector: 'Energy', last: 10_000, bid: 9_990, ask: 10_010, mid: 10_000, open: 10_000, halted: false, closes: [10_000], sessionVolume: 0, depth: { bids: [], asks: [] }, fairEstimate: null },
    ],
    news: [],
    rate: 0.04,
    fearGreed: 50,
    indexChange: 0,
  };

  it('extracts JSON from chatty replies', () => {
    expect(extractJson('Sure!\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('ok {"b":2} thanks')).toEqual({ b: 2 });
  });

  it('clamps prices, drops junk and respects buying power', () => {
    const d = sanitizeDecision(
      {
        thought: 'x'.repeat(500),
        cancel_all: true,
        orders: [
          { symbol: 'grdx', side: 'buy', type: 'limit', qty: 1000, price: 500 }, // price clamped to +15%, qty to buying power
          { symbol: 'NOPE', side: 'buy', type: 'market', qty: 1 },
          { symbol: 'GRDX', side: 'hodl', type: 'market', qty: 1 },
          { symbol: 'GRDX', side: 'sell', type: 'market', qty: 20 }, // reducing: always allowed
        ],
      },
      obs,
    );
    expect(d.cancel).toBe('all');
    expect(d.thought!.length).toBeLessThanOrEqual(140);
    expect(d.orders).toHaveLength(2);
    expect(d.orders[0]!.price).toBe(11_500);
    expect(d.orders[0]!.qty * 11_500).toBeLessThanOrEqual(500_000);
    expect(d.orders[1]).toMatchObject({ side: 'sell', qty: 20 });
  });

  it('renders a compact prompt', () => {
    const p = renderObservation(obs);
    expect(p).toContain('GRDX');
    expect(p).toContain('buying power $5000.00');
  });
});

describe('Leaderboard', () => {
  it('computes returns, drawdown and groups', () => {
    const agents = [
      { id: 'a0', name: 'A', personality: 'value', team: 'heuristic', kind: 'heuristic' as const, startEquity: 10_000 },
      { id: 'a1', name: 'B', personality: 'degen', team: 'heuristic', kind: 'heuristic' as const, startEquity: 10_000 },
    ];
    const snaps = [
      { t: 5, eq: [110, 50] },
      { t: 10, eq: [121, 80] },
    ];
    const s = scoreAgents(agents, snaps);
    expect(s[0]!.returnPct).toBeCloseTo(21);
    expect(s[1]!.maxDrawdownPct).toBeCloseTo(-50);
    const g = groupScores(s, 'personality');
    expect(g[0]!.group).toBe('value');
  });
});

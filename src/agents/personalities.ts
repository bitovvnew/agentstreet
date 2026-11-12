import type { Decision, MarketView, Observation, OrderIntent, Personality, StrategyContext } from './types.js';
import type { Rng } from '../core/rng.js';

/* ------------------------------------------------------------------ helpers */

export function sma(xs: number[], n: number): number {
  if (xs.length === 0) return 0;
  const k = Math.min(n, xs.length);
  let s = 0;
  for (let i = xs.length - k; i < xs.length; i++) s += xs[i]!;
  return s / k;
}

/** Return over the last n ticks (decimal). */
export function ret(xs: number[], n: number): number {
  if (xs.length < 2) return 0;
  const a = xs[Math.max(0, xs.length - 1 - n)]!;
  const b = xs[xs.length - 1]!;
  return a > 0 ? b / a - 1 : 0;
}

function shares(obs: Observation, budget: number, price: number): number {
  const affordable = Math.min(budget, obs.buyingPower * 0.95);
  return Math.max(0, Math.floor(affordable / Math.max(1, price)));
}

const cents = (x: number) => Math.max(1, Math.round(x));
const tradable = (o: Observation) => o.markets.filter((m) => !m.halted);
const pos = (o: Observation, s: string) => o.positions[s] ?? 0;

function recentNews(o: Observation, symbol: string | null, within: number) {
  return o.news.filter((n) => o.tick - n.tick <= within && (symbol === null || n.symbol === symbol || n.symbol === null));
}

function say(rng: Rng, p: number, lines: string[]): string | undefined {
  return rng.chance(p) ? rng.pick(lines) : undefined;
}

const buyMkt = (symbol: string, qty: number): OrderIntent => ({ symbol, side: 'buy', type: 'market', qty });
const sellMkt = (symbol: string, qty: number): OrderIntent => ({ symbol, side: 'sell', type: 'market', qty });
const buyLmt = (symbol: string, qty: number, price: number): OrderIntent => ({ symbol, side: 'buy', type: 'limit', qty, price: cents(price) });
const sellLmt = (symbol: string, qty: number, price: number): OrderIntent => ({ symbol, side: 'sell', type: 'limit', qty, price: cents(price) });

/* ---------------------------------------------------------- market maker */

const marketMaker: Personality = {
  id: 'market-maker',
  label: 'Market Maker',
  description:
    'You are a market maker. You continuously quote both a bid and an ask around the current price, earning the spread and exchange rebates. You hate inventory: when you are long you lower your quotes, when short you raise them. You widen spreads when the market is volatile and step back when a stock is crashing.',
  every: 2,
  research: false,
  startInvested: 0.5,
  capital: 400_000_000,
  traits: (rng) => ({
    spreadBps: rng.range(14, 30),
    levels: rng.int(2, 4),
    sizeFrac: rng.range(0.0025, 0.004),
    maxInvFrac: rng.range(0.12, 0.2),
    depthMul: rng.range(0.85, 1.15),
  }),
  strategy: ({ obs, mem, traits, rng }) => {
    const orders: OrderIntent[] = [];
    // Inventory is measured against the book the desk started with, not against zero.
    const target = (mem.target ??= { ...obs.positions }) as Record<string, number>;
    for (const m of tradable(obs)) {
      const ref = m.bid !== null && m.ask !== null ? m.mid : m.last;
      const vol = Math.abs(ret(m.closes, 10));
      // Fresh headlines mean informed flow: step back and widen.
      const newsy = recentNews(obs, m.symbol, 5).some((n) => n.symbol === m.symbol) ? 3 : 1;
      const half = Math.max(1, (ref * traits.spreadBps! * newsy * (1 + vol * 40)) / 1e4 / 2);
      const inv = pos(obs, m.symbol) - (target[m.symbol] ?? 0);
      const maxInv = (obs.startEquity * traits.maxInvFrac!) / Math.max(1, ref);
      const skew = -(inv / Math.max(1, maxInv)) * half * 0.8;
      const q = Math.max(1, Math.floor((obs.startEquity * traits.sizeFrac!) / ref));
      for (let lvl = 0; lvl < traits.levels!; lvl++) {
        const step = half * (1 + lvl * 0.8);
        if (inv < maxInv) orders.push(buyLmt(m.symbol, q * (lvl + 1), ref - step + skew));
        if (inv > -maxInv) orders.push(sellLmt(m.symbol, q * (lvl + 1), ref + step + skew));
      }
      // Deep "stub" quotes keep the book two-sided even when inventory is maxed out,
      // so a big order walks the price instead of finding an empty book.
      for (const k of [0.02, 0.045, 0.075, 0.12]) {
        orders.push(buyLmt(m.symbol, q * 3, ref * (1 - k * traits.depthMul!)));
        orders.push(sellLmt(m.symbol, q * 3, ref * (1 + k * traits.depthMul!)));
      }
    }
    return {
      // Quotes in halted names stay on the book and take part in the re-opening cross.
      cancel: tradable(obs).map((m) => m.symbol),
      orders,
      thought: say(rng, 0.01, [
        'Spreads are my salary. Volatility is my bonus.',
        'Inventory is a liability. Quoting tighter on the other side.',
        'Somebody keeps lifting my offer. Widening.',
        'Collecting pennies in front of a steamroller, as is tradition.',
      ]),
    };
  },
};

/* ------------------------------------------------------------- value investor */

const valueInvestor: Personality = {
  id: 'value',
  label: 'Value Investor',
  description:
    'You are a patient value investor. You estimate what each company is really worth and buy when the price is well below that value, sell when it is well above. You ignore hype, rumors and social-media noise. You use limit orders, rarely short, and you are fine waiting.',
  every: 4,
  research: true,
  startInvested: 0.5,
  capital: 60_000_000,
  traits: (rng) => ({ margin: rng.range(0.025, 0.06), bias: rng.normal(0, 0.03), size: rng.range(0.04, 0.09), shorts: rng.chance(0.35) ? 1 : 0 }),
  strategy: ({ obs, traits, rng }) => {
    const orders: OrderIntent[] = [];
    let thought: string | undefined;
    // Value investors keep bidding through halts: their orders queue for the re-opening cross.
    for (const m of obs.markets) {
      if (m.fairEstimate === null || !rng.chance(0.5)) continue;
      const est = m.fairEstimate * (1 + traits.bias!);
      const p = pos(obs, m.symbol);
      const gap = m.last / est - 1;
      if (gap < -traits.margin! && p * m.last < obs.equity * 0.45) {
        const q = shares(obs, obs.equity * traits.size!, m.last);
        if (q > 0) orders.push(buyLmt(m.symbol, q, Math.min(m.ask ?? m.last, est * (1 - traits.margin! / 2))));
        if (gap < -0.15) thought ??= `${m.symbol} trades ${Math.round(-gap * 100)}% below what it's worth. Buying with both hands.`;
      } else if (gap > traits.margin! && p > 0) {
        orders.push(sellLmt(m.symbol, p, Math.max(m.bid ?? m.last, est * (1 + traits.margin! / 2))));
        if (gap > 0.2) thought ??= `${m.symbol} is ${Math.round(gap * 100)}% overvalued. This is a bubble and I am leaving.`;
      } else if (gap > traits.margin! * 2.5 && traits.shorts && p <= 0) {
        const q = shares(obs, obs.equity * traits.size! * 0.5, m.last);
        if (q > 0) orders.push(sellLmt(m.symbol, q, m.bid ?? m.last));
        thought ??= `Shorting ${m.symbol}. The fundamentals do not support this price.`;
      }
    }
    return { cancel: 'all', orders, thought: thought && rng.chance(0.35) ? thought : undefined };
  },
};

/* ------------------------------------------------------------- momentum */

const momentum: Personality = {
  id: 'momentum',
  label: 'Momentum Chaser',
  description:
    'You are a momentum trader. The trend is your friend: you buy what has been going up and sell or short what has been going down, using market orders to get in fast. You cut positions as soon as the trend turns.',
  every: 3,
  research: false,
  startInvested: 0.25,
  capital: 25_000_000,
  traits: (rng) => ({ fast: rng.int(4, 8), slow: rng.int(18, 35), th: rng.range(0.003, 0.009), size: rng.range(0.1, 0.25), shorts: rng.chance(0.6) ? 1 : 0 }),
  strategy: ({ obs, traits, rng }) => {
    const orders: OrderIntent[] = [];
    let thought: string | undefined;
    for (const m of tradable(obs)) {
      if (m.closes.length < traits.slow!) continue;
      const sig = sma(m.closes, traits.fast!) / sma(m.closes, traits.slow!) - 1;
      const p = pos(obs, m.symbol);
      if (sig > traits.th! && p <= 0) {
        if (p < 0) orders.push(buyMkt(m.symbol, -p));
        const q = shares(obs, obs.equity * traits.size!, m.last);
        if (q > 0) orders.push(buyMkt(m.symbol, q));
        thought ??= `${m.symbol} is breaking out. Riding it.`;
      } else if (sig < -traits.th!) {
        if (p > 0) orders.push(sellMkt(m.symbol, p));
        if (traits.shorts && p >= 0) {
          const q = shares(obs, obs.equity * traits.size! * 0.7, m.last);
          if (q > 0) orders.push(sellMkt(m.symbol, q));
          thought ??= `${m.symbol} rolling over. Short it.`;
        }
      } else if (p > 0 && sig < 0) {
        orders.push(sellMkt(m.symbol, p));
      } else if (p < 0 && sig > 0) {
        orders.push(buyMkt(m.symbol, -p));
      }
    }
    return { orders, thought: thought && rng.chance(0.25) ? thought : undefined };
  },
};

/* ------------------------------------------------------------- panic seller */

const panicSeller: Personality = {
  id: 'panic',
  label: 'Panic Seller',
  description:
    'You are an anxious retail investor with weak hands. You buy after good news and rising prices, but the moment a stock you own drops a few percent or there is any bad headline, you panic and sell everything at market.',
  every: 2,
  research: false,
  startInvested: 0.6,
  capital: 10_000_000,
  traits: (rng) => ({ pain: rng.range(0.025, 0.06), size: rng.range(0.15, 0.3), courage: rng.range(0.05, 0.15) }),
  strategy: ({ obs, mem, traits, rng }) => {
    const orders: OrderIntent[] = [];
    let thought: string | undefined;
    const peaks = (mem.peaks ??= {}) as Record<string, number>;
    for (const m of tradable(obs)) {
      const p = pos(obs, m.symbol);
      if (p > 0) {
        peaks[m.symbol] = Math.max(peaks[m.symbol] ?? m.last, m.last);
        const dd = m.last / peaks[m.symbol]! - 1;
        const bad = recentNews(obs, m.symbol, 6).some((n) => n.sentiment < -0.4);
        if (dd < -traits.pain! || bad) {
          orders.push(sellMkt(m.symbol, p));
          delete peaks[m.symbol];
          thought = rng.pick([
            `${m.symbol} down ${Math.round(-dd * 100)}%. I can't take this. SELL EVERYTHING.`,
            `Get me out of ${m.symbol}. NOW.`,
            `This is 2008 all over again. Dumping ${m.symbol}.`,
            `I knew I shouldn't have bought ${m.symbol}. Out at market.`,
          ]);
        }
      } else if (p === 0 && rng.chance(traits.courage!)) {
        const good = recentNews(obs, m.symbol, 10).some((n) => n.sentiment > 0.4);
        if (good || ret(m.closes, 20) > 0.02) {
          const q = shares(obs, obs.equity * traits.size!, m.last);
          if (q > 0) {
            orders.push(buyMkt(m.symbol, q));
            peaks[m.symbol] = m.last;
            thought ??= say(rng, 0.4, [`Everyone's making money on ${m.symbol}. Buying.`, `${m.symbol} can only go up from here, right?`]);
          }
        }
      }
    }
    return { orders, thought };
  },
};

/* ------------------------------------------------------------- rumor chaser */

const rumorChaser: Personality = {
  id: 'rumor',
  label: 'Rumor Chaser',
  description:
    'You trade the headlines. Rumors, viral posts and breaking news are your edge: you jump in immediately with leverage on any juicy story, and get out after a while or as soon as the story is denied. You do not care about fundamentals.',
  every: 1,
  research: false,
  startInvested: 0.1,
  capital: 15_000_000,
  traits: (rng) => ({ hold: rng.int(25, 90), size: rng.range(0.5, 1.1), react: rng.range(0.55, 0.95) }),
  strategy: ({ obs, mem, traits, rng }) => {
    const orders: OrderIntent[] = [];
    let thought: string | undefined;
    const entries = (mem.entries ??= {}) as Record<string, number>;
    const seen = (mem.seen ??= {}) as Record<number, 1>;
    for (const n of recentNews(obs, null, 2)) {
      if (seen[n.id] || n.symbol === null) continue;
      seen[n.id] = 1;
      const m = obs.markets.find((x) => x.symbol === n.symbol);
      if (!m || m.halted || !rng.chance(traits.react!)) continue;
      const p = pos(obs, m.symbol);
      if (n.kind === 'debunk' || n.kind === 'confirm') {
        if (p !== 0) {
          orders.push(p > 0 ? sellMkt(m.symbol, p) : buyMkt(m.symbol, -p));
          delete entries[m.symbol];
          thought = n.kind === 'debunk' ? `Story on ${m.symbol} was fake?! Out.` : `Called it on ${m.symbol}. Taking profits.`;
        }
        continue;
      }
      if (Math.abs(n.hype) < 0.02 && n.kind !== 'rumor') continue;
      const q = shares(obs, obs.equity * traits.size!, m.last);
      if (q <= 0) continue;
      if (n.sentiment > 0 && p <= 0) {
        if (p < 0) orders.push(buyMkt(m.symbol, -p));
        orders.push(buyMkt(m.symbol, q));
        entries[m.symbol] = obs.tick;
        thought = rng.pick([`"${n.headline.slice(0, 48)}…" — I'm in. Full size.`, `${m.symbol} news just dropped. Buying before everyone else.`, `Heard it on the wire: ${m.symbol} to the moon.`]);
      } else if (n.sentiment < 0 && p >= 0) {
        if (p > 0) orders.push(sellMkt(m.symbol, p));
        orders.push(sellMkt(m.symbol, Math.floor(q * 0.6)));
        entries[m.symbol] = obs.tick;
        thought = `Bad news on ${m.symbol}. Shorting it into the ground.`;
      }
    }
    for (const [s, t] of Object.entries(entries)) {
      if (obs.tick - t < traits.hold!) continue;
      const m = obs.markets.find((x) => x.symbol === s);
      const p = pos(obs, s);
      if (m && !m.halted && p !== 0) orders.push(p > 0 ? sellMkt(s, p) : buyMkt(s, -p));
      delete entries[s];
    }
    return { orders, thought };
  },
};

/* ------------------------------------------------------------- contrarian */

const contrarian: Personality = {
  id: 'contrarian',
  label: 'Contrarian',
  description:
    'You are a contrarian. When a stock rips higher too fast you sell or short it; when it collapses you buy the dip. You place limit orders a little away from the market and take profit when prices revert.',
  every: 5,
  research: false,
  startInvested: 0.35,
  capital: 25_000_000,
  traits: (rng) => ({ look: rng.int(10, 30), th: rng.range(0.03, 0.06), size: rng.range(0.08, 0.18) }),
  strategy: ({ obs, traits, rng }) => {
    const orders: OrderIntent[] = [];
    let thought: string | undefined;
    for (const m of tradable(obs)) {
      const r = ret(m.closes, traits.look!);
      const p = pos(obs, m.symbol);
      if (r > traits.th! && p >= 0) {
        if (p > 0) orders.push(sellLmt(m.symbol, p, m.last * 1.001));
        const q = shares(obs, obs.equity * traits.size!, m.last);
        if (q > 0) orders.push(sellLmt(m.symbol, q, m.last * 1.004));
        thought ??= `${m.symbol} +${Math.round(r * 100)}% in ${traits.look} min? Fading it.`;
      } else if (r < -traits.th! && p <= 0) {
        if (p < 0) orders.push(buyLmt(m.symbol, -p, m.last * 0.999));
        const q = shares(obs, obs.equity * traits.size!, m.last);
        if (q > 0) orders.push(buyLmt(m.symbol, q, m.last * 0.996));
        thought ??= `Blood in the streets on ${m.symbol}. Buying the dip.`;
      } else if (Math.abs(r) < traits.th! / 4 && p !== 0) {
        orders.push(p > 0 ? sellLmt(m.symbol, p, m.ask ?? m.last) : buyLmt(m.symbol, -p, m.bid ?? m.last));
      }
    }
    return { cancel: 'all', orders, thought: thought && rng.chance(0.3) ? thought : undefined };
  },
};

/* ------------------------------------------------------------- retail crowd */

const retail: Personality = {
  id: 'retail',
  label: 'Retail Crowd',
  description:
    'You are a casual retail trader on a phone app. You trade small, mostly with market orders, buy whatever is trending or in the news, sometimes on a whim, and you get FOMO when something is ripping higher.',
  every: 4,
  research: false,
  startInvested: 0.5,
  capital: 6_000_000,
  traits: (rng) => ({ activity: rng.range(0.15, 0.45), fomo: rng.range(2, 8), size: rng.chance(0.25) ? rng.range(0.6, 1.2) : rng.range(0.05, 0.2) }),
  strategy: ({ obs, traits, rng }) => {
    if (!rng.chance(traits.activity!)) return { orders: [] };
    const ms = tradable(obs);
    if (ms.length === 0) return { orders: [] };
    // Attention: big movers and stocks in the news get looked at.
    const weights = ms.map((m) => {
      const buzz = recentNews(obs, m.symbol, 20).reduce((s, n) => s + Math.abs(n.hype) * 30 + 0.3, 0);
      return [m, 1 + Math.abs(ret(m.closes, 20)) * 60 + buzz] as const;
    });
    const m: MarketView = rng.weighted(weights);
    const r = ret(m.closes, 20);
    const buzz = recentNews(obs, m.symbol, 20).reduce((s, n) => s + n.sentiment, 0);
    const pBuy = Math.min(0.92, Math.max(0.08, 0.5 + r * traits.fomo! * 4 + buzz * 0.12 + (obs.fearGreed - 50) / 400));
    const p = pos(obs, m.symbol);
    if (rng.chance(pBuy)) {
      const q = shares(obs, obs.equity * traits.size!, m.last);
      if (q <= 0) return { orders: [] };
      return {
        orders: [rng.chance(0.75) ? buyMkt(m.symbol, q) : buyLmt(m.symbol, q, m.bid ?? m.last)],
        thought: r > 0.04 ? say(rng, 0.25, [`${m.symbol} 🚀🚀🚀 not selling`, `YOLO'd my savings into ${m.symbol}`, `Can't miss this one. ${m.symbol}!`]) : undefined,
      };
    }
    if (p > 0) {
      const q = Math.max(1, Math.floor(p * rng.range(0.3, 1)));
      return {
        orders: [sellMkt(m.symbol, q)],
        thought: r < -0.04 ? say(rng, 0.25, [`${m.symbol} bag-holder club, checking in 😭`, `Sold ${m.symbol}. Never again.`]) : undefined,
      };
    }
    return { orders: [] };
  },
};

/* ------------------------------------------------------------- leveraged degen */

const degen: Personality = {
  id: 'degen',
  label: 'Leveraged Degen',
  description:
    'You are a leveraged degen. You go all-in on ONE stock at maximum leverage, usually whatever is trending, and you double down when it dips. You take profit only on a big win. Margin calls are something that happens to other people.',
  every: 3,
  research: false,
  startInvested: 0,
  capital: 5_000_000,
  traits: (rng) => ({ tp: rng.range(0.08, 0.2), dd: rng.range(0.03, 0.06), shortBias: rng.range(0.1, 0.35), patience: rng.range(0.1, 0.4) }),
  strategy: ({ obs, mem, traits, rng }) => {
    const held = Object.entries(obs.positions).find(([, q]) => q !== 0);
    if (!held) {
      if (!rng.chance(traits.patience!)) return { orders: [] };
      const ms = tradable(obs);
      if (!ms.length) return { orders: [] };
      // Pick the loudest stock: biggest recent move plus news buzz.
      const m = rng.weighted(ms.map((x) => [x, 1 + Math.abs(ret(x.closes, 30)) * 80 + recentNews(obs, x.symbol, 30).length * 2] as const));
      const short = ret(m.closes, 30) < -0.02 && rng.chance(traits.shortBias! * 2);
      const q = shares(obs, obs.buyingPower * 0.9, m.last);
      if (q <= 0) return { orders: [] };
      mem.entry = m.last;
      return {
        orders: [short ? sellMkt(m.symbol, q) : buyMkt(m.symbol, q)],
        thought: rng.pick([
          `3x leverage on ${m.symbol}. What could possibly go wrong?`,
          `All in ${m.symbol}. My barber says it's a sure thing.`,
          `${short ? 'Shorting' : 'Aping into'} ${m.symbol} with everything I have. And some I don't.`,
        ]),
      };
    }
    const [symbol, q] = held;
    const m = obs.markets.find((x) => x.symbol === symbol)!;
    if (m.halted) return { orders: [] };
    const entry = (mem.entry as number) ?? m.last;
    const pnl = q > 0 ? m.last / entry - 1 : entry / m.last - 1;
    if (pnl > traits.tp!) {
      mem.entry = undefined;
      return { orders: [q > 0 ? sellMkt(symbol, q) : buyMkt(symbol, -q)], thought: `Closed ${symbol} for +${Math.round(pnl * 100)}% on 3x. I am a genius.` };
    }
    if (pnl < -traits.dd! && obs.buyingPower > m.last * 10 && rng.chance(0.5)) {
      const add = shares(obs, obs.buyingPower * 0.8, m.last);
      if (add > 0) {
        mem.entry = (entry * Math.abs(q) + m.last * add) / (Math.abs(q) + add);
        return {
          orders: [q > 0 ? buyMkt(symbol, add) : sellMkt(symbol, add)],
          thought: say(rng, 0.6, [`Doubling down on ${symbol}. Averaging down is a strategy.`, `${symbol} on sale. Buying more. Diamond hands.`]),
        };
      }
    }
    return { orders: [] };
  },
};

export const PERSONALITIES: Personality[] = [marketMaker, valueInvestor, momentum, panicSeller, rumorChaser, contrarian, retail, degen];

const registry = new Map<string, Personality>(PERSONALITIES.map((p) => [p.id, p]));

export function getPersonality(id: string): Personality {
  const p = registry.get(id);
  if (!p) throw new Error(`Unknown personality "${id}". Known: ${[...registry.keys()].join(', ')}`);
  return p;
}

/** Register a custom strategy (plugin API). */
export function registerPersonality(p: Personality): void {
  registry.set(p.id, p);
  if (!PERSONALITIES.includes(p)) PERSONALITIES.push(p);
}

export function personalities(): Personality[] {
  return [...registry.values()];
}

/** Default number of each personality in a demo market. */
export const DEFAULT_MIX: Record<string, number> = {
  'market-maker': 4,
  value: 8,
  momentum: 8,
  panic: 6,
  rumor: 6,
  contrarian: 5,
  retail: 22,
  degen: 6,
};

export type { Decision, StrategyContext };

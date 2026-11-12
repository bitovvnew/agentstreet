import type { Brain, Decision, Observation, OrderIntent, Personality, StrategyContext } from '../types.js';
import { createProvider, extractJson, type ChatProvider } from './providers.js';

/** Runs the personality's hand-written strategy. Deterministic given the seed. */
export class HeuristicBrain implements Brain {
  readonly team = 'heuristic';
  readonly kind = 'heuristic' as const;
  decide(ctx: StrategyContext, p: Personality): Decision {
    return p.strategy(ctx);
  }
}

export interface LlmStats {
  calls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  lastError?: string;
}

const RULES = `This is a FICTIONAL stock-market simulation with fictional companies and play money. Nothing here is real or financial advice.
You trade on the AgentStreet exchange: a real limit order book with price-time priority.
- Market orders fill immediately against resting orders; limit orders rest at your price.
- You may short-sell (sell more than you own) within margin: gross exposure <= ~3x equity. If equity falls below 20% of gross exposure you are force-liquidated at market.
- Stocks halt for 15 minutes if a trade would print more than 8% from the reference price.
- Taker fee 2bp, maker rebate 0.5bp.
Reply with ONE JSON object and nothing else:
{"thought":"<one short sentence in character, max 120 chars>","cancel_all":true|false,"orders":[{"symbol":"TICK","side":"buy"|"sell","type":"market"|"limit","qty":<int shares>,"price":<limit price in dollars, limit only>}]}
Use at most 4 orders. An empty orders list means hold.`;

function money(c: number): string {
  return (c / 100).toFixed(2);
}

/** Compact text rendering of an observation for the prompt. */
export function renderObservation(o: Observation): string {
  const lines: string[] = [];
  lines.push(`Time ${o.clock} (tick ${o.tick}). Rate ${(o.rate * 100).toFixed(2)}%. Fear&Greed ${Math.round(o.fearGreed)}/100. Index ${(o.indexChange * 100).toFixed(2)}% today.`);
  lines.push(`You: cash $${money(o.cash)}, equity $${money(o.equity)} (started $${money(o.startEquity)}), buying power $${money(o.buyingPower)}.`);
  const posStr = Object.entries(o.positions).map(([s, q]) => `${s} ${q}`).join(', ');
  lines.push(`Positions: ${posStr || 'none'}. Open orders: ${o.openOrders.length}.`);
  lines.push('Market (last | bid/ask | 10m% | 60m% | today%):');
  for (const m of o.markets) {
    const c = m.closes;
    const r = (n: number) => (c.length > n ? ((c[c.length - 1]! / c[c.length - 1 - n]! - 1) * 100).toFixed(1) : '0.0');
    const today = ((m.last / m.open - 1) * 100).toFixed(1);
    const fair = m.fairEstimate !== null ? ` | your fair-value estimate $${money(m.fairEstimate)}` : '';
    lines.push(
      `  ${m.symbol} (${m.name}, ${m.sector})${m.halted ? ' HALTED' : ''}: $${money(m.last)} | ${m.bid !== null ? money(m.bid) : '-'}/${m.ask !== null ? money(m.ask) : '-'} | ${r(10)}% | ${r(59)}% | ${today}%${fair}`,
    );
  }
  const news = o.news.slice(-8);
  if (news.length) {
    lines.push('Latest news (minutes ago):');
    for (const n of news) lines.push(`  [${o.tick - n.tick}m] ${n.isRumor ? '(unconfirmed) ' : ''}${n.headline}`);
  }
  lines.push('Your move?');
  return lines.join('\n');
}

/** Validate and clamp whatever the model returned into safe order intents. */
export function sanitizeDecision(raw: any, o: Observation): Decision {
  const orders: OrderIntent[] = [];
  const list = Array.isArray(raw?.orders) ? raw.orders.slice(0, 4) : [];
  let budget = o.buyingPower;
  for (const r of list) {
    const m = o.markets.find((x) => x.symbol === String(r?.symbol ?? '').toUpperCase());
    if (!m) continue;
    const side = r.side === 'sell' ? 'sell' : r.side === 'buy' ? 'buy' : null;
    if (!side) continue;
    const type = r.type === 'limit' ? 'limit' : 'market';
    let qty = Math.floor(Number(r.qty));
    if (!Number.isFinite(qty) || qty <= 0) continue;
    let price: number | undefined;
    if (type === 'limit') {
      const p = Math.round(Number(r.price) * 100);
      if (!Number.isFinite(p) || p <= 0) continue;
      price = Math.min(Math.round(m.last * 1.15), Math.max(Math.round(m.last * 0.85), p));
    }
    const px = price ?? m.last;
    const held = o.positions[m.symbol] ?? 0;
    const reducing = side === 'sell' ? Math.min(qty, Math.max(0, held)) : Math.min(qty, Math.max(0, -held));
    const adding = qty - reducing;
    if (adding * px > budget) qty = reducing + Math.floor(Math.max(0, budget) / px);
    if (qty <= 0) continue;
    budget -= (qty - reducing) * px;
    orders.push({ symbol: m.symbol, side, type, qty, price });
  }
  const thought = typeof raw?.thought === 'string' ? raw.thought.replace(/\s+/g, ' ').trim().slice(0, 140) : undefined;
  return { orders, cancel: raw?.cancel_all ? 'all' : undefined, thought: thought || undefined };
}

/**
 * An LLM-driven trader. Plays a personality in character; on any API or
 * parse error it falls back to that personality's heuristic for this turn.
 */
export class LlmBrain implements Brain {
  readonly kind = 'llm' as const;
  readonly team: string;
  readonly stats: LlmStats = { calls: 0, errors: 0, inputTokens: 0, outputTokens: 0 };
  private readonly provider: ChatProvider;

  constructor(
    spec: string | ChatProvider,
    private readonly timeoutMs = 25_000,
  ) {
    this.provider = typeof spec === 'string' ? createProvider(spec) : spec;
    this.team = this.provider.id;
  }

  async decide(ctx: StrategyContext, p: Personality): Promise<Decision> {
    this.stats.calls++;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.provider.chat({
        system: `${p.description}\n\n${RULES}`,
        user: renderObservation(ctx.obs),
        signal: ac.signal,
      });
      this.stats.inputTokens += res.inputTokens;
      this.stats.outputTokens += res.outputTokens;
      return sanitizeDecision(extractJson(res.text), ctx.obs);
    } catch (e) {
      this.stats.errors++;
      this.stats.lastError = e instanceof Error ? e.message.slice(0, 200) : String(e);
      return { ...p.strategy(ctx), thought: undefined };
    } finally {
      clearTimeout(timer);
    }
  }
}

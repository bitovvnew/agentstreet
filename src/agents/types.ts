import type { Rng } from '../core/rng.js';
import type { Depth, OrderType, Side, TimeInForce } from '../core/types.js';
import type { PublicNews } from '../news/newsroom.js';

/** What one stock looks like to an agent. Prices in cents. */
export interface MarketView {
  symbol: string;
  name: string;
  sector: string;
  last: number;
  bid: number | null;
  ask: number | null;
  mid: number;
  open: number;
  halted: boolean;
  /** Last ~60 per-tick prices, oldest first. */
  closes: number[];
  sessionVolume: number;
  depth: Depth;
  /**
   * The agent's private research estimate of fair value (cents). Only agents
   * whose personality does research get this; everybody else sees null.
   */
  fairEstimate: number | null;
}

export interface OpenOrderView {
  id: number;
  symbol: string;
  side: Side;
  price: number;
  qty: number;
}

export interface Observation {
  tick: number;
  clock: string;
  agentId: string;
  cash: number;
  equity: number;
  startEquity: number;
  buyingPower: number;
  positions: Record<string, number>;
  openOrders: OpenOrderView[];
  markets: MarketView[];
  /** Most recent stories, newest last. */
  news: PublicNews[];
  /** Central-bank rate (decimal). */
  rate: number;
  /** 0 (extreme fear) .. 100 (extreme greed). */
  fearGreed: number;
  /** Index change since the session open, decimal. */
  indexChange: number;
}

export interface OrderIntent {
  symbol: string;
  side: Side;
  type: OrderType;
  qty: number;
  /** Limit price in cents. */
  price?: number;
  tif?: TimeInForce;
}

export interface Decision {
  orders: OrderIntent[];
  /** 'all' cancels every open order first; a list of symbols cancels per symbol. */
  cancel?: 'all' | string[];
  /** One-line inner monologue, shown in the dashboard's chatter feed. */
  thought?: string;
}

/** Per-agent scratch memory, owned by the strategy. */
export type Memory = Record<string, unknown>;

export interface StrategyContext {
  obs: Observation;
  mem: Memory;
  rng: Rng;
  /** Agent-level traits sampled once (risk appetite, thresholds...). */
  traits: Record<string, number>;
}

export type Strategy = (ctx: StrategyContext) => Decision;

export interface Personality {
  id: string;
  label: string;
  /** Plain-English description; also the system prompt for LLM brains. */
  description: string;
  /** Decide every N ticks (heuristic brains). */
  every: number;
  /** Whether agents of this type get a private fair-value estimate. */
  research: boolean;
  /** Fraction of starting capital held as stock at the start. */
  startInvested: number;
  /** Starting capital in cents. */
  capital: number;
  traits: (rng: Rng) => Record<string, number>;
  strategy: Strategy;
}

/** A brain turns an observation into a decision: heuristic code or an LLM. */
export interface Brain {
  /** Team label for the leaderboard, e.g. "heuristic" or "openai:gpt-4o-mini". */
  team: string;
  kind: 'heuristic' | 'llm';
  decide(ctx: StrategyContext, personality: Personality): Decision | Promise<Decision>;
}

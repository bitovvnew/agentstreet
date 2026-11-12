import type { SymbolSpec } from '../core/types.js';
import type { ExchangeConfig } from '../engine/exchange.js';
import type { NewsKind } from '../news/newsroom.js';
import type { Decision } from '../agents/types.js';
import type { SpendLimits } from '../safety/limits.js';

export interface SimConfig {
  seed: number;
  scenario: string;
  universe: SymbolSpec[];
  exchange: Partial<ExchangeConfig>;
  /** personality id -> number of heuristic agents */
  mix: Record<string, number>;
  /** LLM teams, e.g. ["anthropic:claude-haiku-5-5", "ollama:llama3.1"] */
  models: string[];
  /** Personalities each LLM team fields (one agent each). */
  llmPersonalities: string[];
  /** Ticks between LLM decisions per agent. */
  llmEvery: number;
  /** 'blocking' waits for every LLM call (headless); 'async' lets the market move while models think (live). */
  llmMode: 'blocking' | 'async';
  /** Optional LLM that rewrites newsroom headlines. */
  newsWriter: string | null;
  /** Expected news stories per tick. */
  newsRate: number;
  /** Starting central-bank rate, decimal. */
  rate: number;
  /** One tick = one simulated minute; a session is 390 minutes. */
  ticksPerDay: number;
  /** Fundamental volatility time-compression: 1 sim day ~ this many real trading days. */
  timeCompression: number;
  /** Equity snapshot cadence for the leaderboard. */
  equityEvery: number;
  /** Order-book levels recorded per side per frame. */
  depthLevels: number;
  /** Live mode keeps at most this many ticks of history in memory (0 = unlimited). */
  maxHistory: number;
  /** LLM spend guardrails (rate limit, token and dollar caps). */
  limits?: Partial<SpendLimits>;
  /** USD per token for priced models (from OpenRouter's catalog or set by hand). */
  prices?: Record<string, { input: number; output: number }>;
}

export type Command =
  | {
      type: 'news';
      symbol: string | null;
      tone: 'positive' | 'negative';
      kind?: NewsKind;
      headline?: string;
      /** 0.2 .. 2: how big the story is (news editor). */
      magnitude?: number;
      /** Publish this many ticks after the command is applied (news editor schedule). */
      delay?: number;
    }
  | { type: 'rate'; bps: number }
  | { type: 'crash'; symbol: string; size?: number }
  | { type: 'halt'; symbol: string | null; ticks?: number }
  | { type: 'pump'; symbol: string };

/** Per-symbol frame tuple: [last, bid, ask, high, low, volume, fair, halted] (prices in cents). */
export type SymFrame = [number, number, number, number, number, number, number, number];

export interface Frame {
  t: number;
  clock: string;
  /** Cap-weighted index level. */
  index: number;
  rate: number;
  fearGreed: number;
  /** Annualised realised volatility of the index, percent. */
  vol: number;
  /** Total negative cash (margin loans), dollars. */
  marginDebt: number;
  /** Short interest per symbol as % of shares held. */
  shortPct: number[];
  sym: SymFrame[];
  /** Depth per symbol: [bidPx[], bidQty[], askPx[], askQty[]] */
  depth: [number[], number[], number[], number[]][];
}

/** [tick, symbolIndex, price, qty, aggressor(1 buy / -1 sell), buyerIndex, sellerIndex, flags(1 = liquidation, 2 = fat finger)] */
export type TradeTuple = [number, number, number, number, number, number, number, number];

export interface NewsRecord {
  id: number;
  t: number;
  symbol: string | null;
  kind: NewsKind;
  headline: string;
  sentiment: number;
  source: string;
  isRumor: boolean;
  followUpOf?: number;
}

export interface Thought {
  t: number;
  agent: number;
  text: string;
}

export interface SimEvent {
  t: number;
  type: 'halt' | 'resume' | 'liquidation' | 'bust' | 'rate' | 'breaker' | 'crash' | 'scenario' | 'session' | 'llm' | 'scheduled';
  symbol?: string;
  text: string;
}

export interface AgentInfo {
  id: string;
  name: string;
  personality: string;
  team: string;
  kind: 'heuristic' | 'llm' | 'system';
  startEquity: number;
}

export interface EquitySnap {
  t: number;
  /** Equity in dollars per agent, same order as `agents`. */
  eq: number[];
  /** 1 = busted, per agent. Omitted when nobody is. */
  busted?: number[];
  /** Positions per agent (shares per symbol, universe order); 0 when flat. */
  pos?: (number[] | 0)[];
}

/** Everything that changed in one tick: streamed to the dashboard, appended to the replay. */
export interface TickDelta {
  frame: Frame;
  trades: TradeTuple[];
  news: NewsRecord[];
  thoughts: Thought[];
  events: SimEvent[];
  equity?: EquitySnap;
}

export interface LlmRecord {
  t: number;
  agent: string;
  decision: Decision;
}

export interface ReplayFile {
  format: 'agentstreet-replay';
  version: 1;
  meta: {
    app: string;
    created: string;
    scenario: string;
    seed: number;
    ticks: number;
    firstTick: number;
    hash: string;
    truncated: boolean;
  };
  config: SimConfig;
  symbols: { symbol: string; name: string; sector: string; blurb: string; shares: number; price: number }[];
  agents: AgentInfo[];
  inputs: { t: number; cmd: Command }[];
  llm: LlmRecord[];
  frames: Frame[];
  trades: TradeTuple[];
  news: NewsRecord[];
  thoughts: Thought[];
  events: SimEvent[];
  equity: EquitySnap[];
}

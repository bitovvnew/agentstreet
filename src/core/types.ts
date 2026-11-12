/**
 * Shared types. Prices are integer CENTS everywhere inside the engine
 * (no floating point drift in the book); quantities are integer shares.
 */

export type Side = 'buy' | 'sell';
export type OrderType = 'limit' | 'market';
export type TimeInForce = 'gtc' | 'ioc';

export interface OrderRequest {
  agentId: string;
  symbol: string;
  side: Side;
  type: OrderType;
  qty: number;
  /** Limit price in cents. Required for limit orders. */
  price?: number;
  tif?: TimeInForce;
  /** Free-form tag, e.g. "liquidation" or "fat-finger". */
  tag?: string;
}

export interface RestingOrder {
  id: number;
  agentId: string;
  symbol: string;
  side: Side;
  price: number;
  qty: number;
  origQty: number;
  seq: number;
  tick: number;
  /** Buying-power (cents) this order has reserved per share still open. */
  commitPerShare: number;
  tag?: string;
}

export interface Fill {
  seq: number;
  tick: number;
  symbol: string;
  price: number;
  qty: number;
  buyAgent: string;
  sellAgent: string;
  buyOrderId: number;
  sellOrderId: number;
  aggressor: Side;
  tag?: string;
}

export interface BookLevel {
  price: number;
  qty: number;
  orders: number;
}

export interface Depth {
  bids: BookLevel[];
  asks: BookLevel[];
}

export interface SymbolSpec {
  symbol: string;
  name: string;
  sector: string;
  /** Starting price in cents. */
  price: number;
  /** Shares outstanding, used for the cap-weighted index. */
  shares: number;
  /** Annualised fundamental volatility (0.3 = 30%). */
  vol: number;
  blurb: string;
}

export type SubmitResult =
  | { ok: true; orderId: number; fills: Fill[]; resting: number; cancelled: number }
  | { ok: false; reason: RejectReason };

export type RejectReason =
  | 'bad-qty'
  | 'bad-price'
  | 'unknown-symbol'
  | 'unknown-account'
  | 'insufficient-margin'
  | 'account-busted'
  | 'trading-halted';

export interface Candle {
  /** First tick covered by this candle. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

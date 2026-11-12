import type {
  Fill,
  OrderRequest,
  RejectReason,
  RestingOrder,
  Side,
  SubmitResult,
  SymbolSpec,
} from '../core/types.js';
import { OrderBook } from './orderbook.js';

export interface ExchangeConfig {
  /** Fee charged to the aggressor, in basis points of notional. */
  takerFeeBps: number;
  /** Fee charged to the resting side; negative = rebate. */
  makerFeeBps: number;
  /** Gross exposure may not exceed equity / initialMargin (0.5 = 2x leverage). */
  initialMargin: number;
  /** Below equity / gross = maintenanceMargin the account is liquidated. */
  maintenanceMargin: number;
  /** Limit-up / limit-down band around the reference price (0.08 = ±8%). */
  bandPct: number;
  /** Ticks after which the band reference price rolls to the last trade. */
  bandWindow: number;
  /** How long a single-stock halt lasts. */
  haltTicks: number;
}

export const DEFAULT_EXCHANGE_CONFIG: ExchangeConfig = {
  takerFeeBps: 2,
  makerFeeBps: -0.5,
  initialMargin: 0.34,
  maintenanceMargin: 0.2,
  bandPct: 0.08,
  bandWindow: 60,
  haltTicks: 15,
};

export class Account {
  cash: number;
  readonly positions = new Map<string, number>();
  /** Buying power reserved by resting orders, in cents. */
  committed = 0;
  feesPaid = 0;
  volume = 0;
  trades = 0;
  busted = false;
  liquidations = 0;

  constructor(
    readonly id: string,
    cash: number,
  ) {
    this.cash = cash;
  }

  pos(symbol: string): number {
    return this.positions.get(symbol) ?? 0;
  }
}

export interface SymbolState {
  spec: SymbolSpec;
  last: number;
  /** Reference price for the limit-up/limit-down band. */
  ref: number;
  refTick: number;
  open: number;
  volume: number;
  notional: number;
  halted: boolean;
  haltUntil: number;
  halts: number;
}

export type ExchangeEvent =
  | { type: 'trade'; fill: Fill }
  | { type: 'halt'; symbol: string; tick: number; until: number; price: number; reason: string }
  | { type: 'resume'; symbol: string; tick: number; price: number };

/**
 * A multi-symbol exchange: one order book per symbol, cash/position accounts,
 * fees, portfolio margin with short selling, self-trade prevention and
 * limit-up/limit-down circuit breakers.
 */
export class Exchange {
  readonly cfg: ExchangeConfig;
  readonly books = new Map<string, OrderBook>();
  readonly symbols = new Map<string, SymbolState>();
  readonly accounts = new Map<string, Account>();
  private nextOrderId = 1;
  private seq = 0;
  tick = 0;
  private listeners: ((e: ExchangeEvent) => void)[] = [];

  constructor(specs: SymbolSpec[], cfg: Partial<ExchangeConfig> = {}) {
    this.cfg = { ...DEFAULT_EXCHANGE_CONFIG, ...cfg };
    for (const spec of specs) {
      this.books.set(spec.symbol, new OrderBook(spec.symbol));
      this.symbols.set(spec.symbol, {
        spec,
        last: spec.price,
        ref: spec.price,
        refTick: 0,
        open: spec.price,
        volume: 0,
        notional: 0,
        halted: false,
        haltUntil: 0,
        halts: 0,
      });
    }
  }

  on(fn: (e: ExchangeEvent) => void): void {
    this.listeners.push(fn);
  }

  private emit(e: ExchangeEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  openAccount(id: string, cash: number, positions: Record<string, number> = {}): Account {
    const a = new Account(id, cash);
    for (const [s, q] of Object.entries(positions)) if (q) a.positions.set(s, q);
    this.accounts.set(id, a);
    return a;
  }

  mark(symbol: string): number {
    return this.symbols.get(symbol)?.last ?? 0;
  }

  equity(a: Account): number {
    let e = a.cash;
    for (const [s, q] of a.positions) e += q * this.mark(s);
    return e;
  }

  gross(a: Account): number {
    let g = 0;
    for (const [s, q] of a.positions) g += Math.abs(q) * this.mark(s);
    return g;
  }

  /** Remaining buying power in cents (what a new exposure-increasing order may use). */
  buyingPower(a: Account): number {
    const eq = this.equity(a);
    if (eq <= 0) return 0;
    return Math.max(0, eq / this.cfg.initialMargin - this.gross(a) - a.committed);
  }

  /** Advance the clock: roll band references and lift halts that have expired. */
  advance(tick: number): void {
    this.tick = tick;
    for (const st of this.symbols.values()) {
      if (st.halted && tick >= st.haltUntil) this.resume(st.spec.symbol);
      if (!st.halted && tick - st.refTick >= this.cfg.bandWindow) {
        st.ref = st.last;
        st.refTick = tick;
      }
    }
  }

  newSession(): void {
    for (const st of this.symbols.values()) {
      st.open = st.last;
      st.volume = 0;
      st.notional = 0;
    }
  }

  submit(req: OrderRequest): SubmitResult {
    const book = this.books.get(req.symbol);
    const st = this.symbols.get(req.symbol);
    if (!book || !st) return reject('unknown-symbol');
    const acct = this.accounts.get(req.agentId);
    if (!acct) return reject('unknown-account');
    if (acct.busted && req.tag !== 'liquidation') return reject('account-busted');
    if (!Number.isInteger(req.qty) || req.qty <= 0) return reject('bad-qty');
    if (req.type === 'limit' && (!Number.isInteger(req.price) || (req.price ?? 0) <= 0)) return reject('bad-price');
    if (st.halted && req.type === 'market') return reject('trading-halted');

    // Margin: how much new gross exposure would this order add if fully filled?
    const refPx = req.type === 'limit' ? req.price! : Math.round(st.last * 1.05);
    const pos = acct.pos(req.symbol);
    const newPos = req.side === 'buy' ? pos + req.qty : pos - req.qty;
    const addedPerShare = (Math.max(0, Math.abs(newPos) - Math.abs(pos)) * Math.max(refPx, st.last)) / req.qty;
    if (req.tag !== 'liquidation' && addedPerShare > 0 && addedPerShare * req.qty > this.buyingPower(acct)) {
      return reject('insufficient-margin');
    }

    const id = this.nextOrderId++;
    const fills: Fill[] = [];
    let remaining = req.qty;

    if (!st.halted) {
      remaining = this.match(req, id, remaining, fills);
    }

    let resting = 0;
    let cancelled = 0;
    if (remaining > 0) {
      if (req.type === 'limit' && req.tif !== 'ioc') {
        const o: RestingOrder = {
          id,
          agentId: req.agentId,
          symbol: req.symbol,
          side: req.side,
          price: req.price!,
          qty: remaining,
          origQty: req.qty,
          seq: ++this.seq,
          tick: this.tick,
          commitPerShare: addedPerShare,
          tag: req.tag,
        };
        book.add(o);
        acct.committed += addedPerShare * remaining;
        resting = remaining;
      } else {
        cancelled = remaining;
      }
    }
    return { ok: true, orderId: id, fills, resting, cancelled };
  }

  private match(req: OrderRequest, orderId: number, qty: number, fills: Fill[]): number {
    const book = this.books.get(req.symbol)!;
    const st = this.symbols.get(req.symbol)!;
    const opposite: Side = req.side === 'buy' ? 'sell' : 'buy';
    while (qty > 0) {
      const level = book.bestLevel(opposite);
      if (!level) break;
      if (req.type === 'limit') {
        const crosses = req.side === 'buy' ? level.price <= req.price! : level.price >= req.price!;
        if (!crosses) break;
      }
      // Limit-up / limit-down: a print outside the band halts the stock instead.
      if (this.outsideBand(st, level.price)) {
        this.halt(req.symbol, `${req.side === 'buy' ? 'limit-up' : 'limit-down'} breach at ${fmt(level.price)}`);
        break;
      }
      const resting = level.front();
      if (!resting) break;
      if (resting.agentId === req.agentId) {
        // Self-trade prevention: cancel the resting (older) order.
        this.cancel(req.agentId, resting.id);
        continue;
      }
      const q = Math.min(qty, resting.qty);
      const fill = this.settle(req.symbol, resting, req.agentId, orderId, req.side, q, resting.price, req.tag);
      fills.push(fill);
      qty -= q;
    }
    return qty;
  }

  /** Book a trade between a resting (maker) order and an aggressor (taker). */
  private settle(
    symbol: string,
    resting: RestingOrder,
    takerId: string,
    takerOrderId: number,
    takerSide: Side,
    qty: number,
    price: number,
    tag: string | undefined,
  ): Fill {
    const book = this.books.get(symbol)!;
    const st = this.symbols.get(symbol)!;
    const maker = this.accounts.get(resting.agentId)!;
    const taker = this.accounts.get(takerId)!;
    maker.committed = Math.max(0, maker.committed - resting.commitPerShare * qty);
    book.reduce(resting, qty);

    const notional = price * qty;
    const buyer = takerSide === 'buy' ? taker : maker;
    const seller = takerSide === 'buy' ? maker : taker;
    buyer.cash -= notional;
    seller.cash += notional;
    buyer.positions.set(symbol, buyer.pos(symbol) + qty);
    seller.positions.set(symbol, seller.pos(symbol) - qty);
    if (buyer.pos(symbol) === 0) buyer.positions.delete(symbol);
    if (seller.pos(symbol) === 0) seller.positions.delete(symbol);

    const takerFee = (notional * this.cfg.takerFeeBps) / 1e4;
    const makerFee = (notional * this.cfg.makerFeeBps) / 1e4;
    taker.cash -= takerFee;
    maker.cash -= makerFee;
    taker.feesPaid += takerFee;
    maker.feesPaid += makerFee;
    for (const a of [maker, taker]) {
      a.volume += notional;
      a.trades++;
    }

    st.last = price;
    st.volume += qty;
    st.notional += notional;

    const fill: Fill = {
      seq: ++this.seq,
      tick: this.tick,
      symbol,
      price,
      qty,
      buyAgent: buyer.id,
      sellAgent: seller.id,
      buyOrderId: takerSide === 'buy' ? takerOrderId : resting.id,
      sellOrderId: takerSide === 'buy' ? resting.id : takerOrderId,
      aggressor: takerSide,
      tag: tag ?? resting.tag,
    };
    this.emit({ type: 'trade', fill });
    return fill;
  }

  private outsideBand(st: SymbolState, price: number): boolean {
    const b = this.cfg.bandPct;
    return price > st.ref * (1 + b) || price < st.ref * (1 - b);
  }

  halt(symbol: string, reason: string, ticks = this.cfg.haltTicks): void {
    const st = this.symbols.get(symbol);
    if (!st) return;
    st.haltUntil = Math.max(st.haltUntil, this.tick + ticks);
    if (st.halted) return;
    st.halted = true;
    st.halts++;
    this.emit({ type: 'halt', symbol, tick: this.tick, until: st.haltUntil, price: st.last, reason });
  }

  /**
   * Reopen a halted stock with a re-opening cross: the band is re-centred on
   * the indicated price and crossed orders trade (older order sets the price).
   */
  resume(symbol: string): void {
    const st = this.symbols.get(symbol);
    const book = this.books.get(symbol);
    if (!st || !book || !st.halted) return;
    st.halted = false;
    const bid = book.bestBid();
    const ask = book.bestAsk();
    // Indicative price: the book's mid if it is two-sided, else the last print.
    if (bid !== null && ask !== null) st.ref = Math.round((bid + ask) / 2);
    else st.ref = st.last;
    let crossed = false;
    // Allow the re-opening cross to move twice the normal band.
    const lo = st.ref * (1 - 2 * this.cfg.bandPct);
    const hi = st.ref * (1 + 2 * this.cfg.bandPct);
    let guard = 0;
    while (guard++ < 10000) {
      const bl = book.bestLevel('buy');
      const al = book.bestLevel('sell');
      if (!bl || !al || bl.price < al.price) break;
      const b = bl.front();
      const a = al.front();
      if (!b || !a) break;
      if (b.agentId === a.agentId) {
        this.cancel(b.agentId, b.seq > a.seq ? b.id : a.id);
        continue;
      }
      const older = b.seq < a.seq ? b : a;
      const newer = older === b ? a : b;
      const price = Math.min(hi, Math.max(lo, older.price));
      const q = Math.min(b.qty, a.qty);
      // Treat the newer order as the taker so fees apply the usual way.
      const takerAcct = this.accounts.get(newer.agentId)!;
      takerAcct.committed = Math.max(0, takerAcct.committed - newer.commitPerShare * q);
      book.reduce(newer, q);
      this.settle(symbol, older, newer.agentId, newer.id, newer.side, q, Math.round(price), newer.tag);
      crossed = true;
    }
    if (crossed) st.ref = st.last;
    st.refTick = this.tick;
    this.emit({ type: 'resume', symbol, tick: this.tick, price: st.last });
  }

  cancel(agentId: string, orderId: number): boolean {
    for (const book of this.books.values()) {
      const o = book.get(orderId);
      if (!o) continue;
      if (o.agentId !== agentId) return false;
      const c = book.cancel(orderId)!;
      const a = this.accounts.get(agentId);
      if (a) a.committed = Math.max(0, a.committed - c.commitPerShare * c.qty);
      return true;
    }
    return false;
  }

  cancelAll(agentId: string, symbol?: string): number {
    let n = 0;
    for (const book of this.books.values()) {
      if (symbol && book.symbol !== symbol) continue;
      const ids: number[] = [];
      for (const o of book.orders()) if (o.agentId === agentId) ids.push(o.id);
      for (const id of ids) if (this.cancel(agentId, id)) n++;
    }
    return n;
  }

  openOrders(agentId: string): RestingOrder[] {
    const out: RestingOrder[] = [];
    for (const book of this.books.values()) for (const o of book.orders()) if (o.agentId === agentId) out.push(o);
    return out;
  }

  /** True when the account is below maintenance margin. */
  marginCall(a: Account): boolean {
    const g = this.gross(a);
    if (g <= 0) return false;
    return this.equity(a) < g * this.cfg.maintenanceMargin;
  }

  /**
   * Forced liquidation: cancel everything and market out of every position.
   * Positions in halted stocks stay until the stock reopens.
   */
  liquidate(agentId: string): Fill[] {
    const a = this.accounts.get(agentId);
    if (!a) return [];
    a.liquidations++;
    this.cancelAll(agentId);
    const fills: Fill[] = [];
    const positions = [...a.positions.entries()].sort(
      (x, y) => Math.abs(y[1]) * this.mark(y[0]) - Math.abs(x[1]) * this.mark(x[0]),
    );
    for (const [symbol, q] of positions) {
      const r = this.submit({
        agentId,
        symbol,
        side: q > 0 ? 'sell' : 'buy',
        type: 'market',
        qty: Math.abs(q),
        tag: 'liquidation',
      });
      if (r.ok) fills.push(...r.fills);
    }
    return fills;
  }

  /** Interest on cash/margin loans and borrow fees on shorts, for one tick. */
  accrue(ratePerTick: number, borrowPerTick: number): void {
    for (const a of this.accounts.values()) {
      if (a.busted) continue;
      if (a.cash > 0) a.cash += a.cash * ratePerTick;
      else a.cash += a.cash * (ratePerTick + borrowPerTick);
      for (const [s, q] of a.positions) if (q < 0) a.cash -= -q * this.mark(s) * borrowPerTick;
    }
  }
}

function reject(reason: RejectReason): SubmitResult {
  return { ok: false, reason };
}

export function fmt(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

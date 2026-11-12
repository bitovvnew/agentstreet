import { describe, expect, it } from 'vitest';
import { Exchange, type ExchangeEvent } from '../src/engine/exchange.js';
import { OrderBook } from '../src/engine/orderbook.js';
import type { SymbolSpec } from '../src/core/types.js';

const SPEC: SymbolSpec = { symbol: 'TEST', name: 'Test Corp', sector: 'Test', price: 10_000, shares: 1e6, vol: 0.3, blurb: '' };

function mkExchange(cfg = {}) {
  const ex = new Exchange([SPEC], { takerFeeBps: 0, makerFeeBps: 0, bandPct: 0.5, ...cfg });
  for (const id of ['a', 'b', 'c', 'd']) ex.openAccount(id, 10_000_000, { TEST: 1_000 });
  const events: ExchangeEvent[] = [];
  ex.on((e) => events.push(e));
  return { ex, events };
}

const lim = (agentId: string, side: 'buy' | 'sell', price: number, qty: number) =>
  ({ agentId, symbol: 'TEST', side, type: 'limit', price, qty }) as const;

describe('OrderBook', () => {
  it('keeps best bid/ask at the touch and aggregates depth', () => {
    const b = new OrderBook('X');
    let id = 1;
    const add = (side: 'buy' | 'sell', price: number, qty: number) =>
      b.add({ id: id++, agentId: 'a', symbol: 'X', side, price, qty, origQty: qty, seq: id, tick: 0, commitPerShare: 0 });
    add('buy', 99, 10);
    add('buy', 101, 5);
    add('buy', 100, 7);
    add('buy', 101, 3);
    add('sell', 105, 4);
    add('sell', 103, 2);
    expect(b.bestBid()).toBe(101);
    expect(b.bestAsk()).toBe(103);
    expect(b.mid()).toBe(102);
    const d = b.depth(5);
    expect(d.bids).toEqual([
      { price: 101, qty: 8, orders: 2 },
      { price: 100, qty: 7, orders: 1 },
      { price: 99, qty: 10, orders: 1 },
    ]);
    expect(d.asks.map((l) => l.price)).toEqual([103, 105]);
  });

  it('cancel removes empty levels', () => {
    const b = new OrderBook('X');
    b.add({ id: 1, agentId: 'a', symbol: 'X', side: 'buy', price: 50, qty: 5, origQty: 5, seq: 1, tick: 0, commitPerShare: 0 });
    expect(b.cancel(1)?.qty).toBe(5);
    expect(b.bestBid()).toBeNull();
    expect(b.cancel(1)).toBeUndefined();
  });
});

describe('Exchange matching', () => {
  it('fills at the resting price with price-time priority', () => {
    const { ex } = mkExchange();
    ex.submit(lim('a', 'sell', 10_100, 10)); // first at 101
    ex.submit(lim('b', 'sell', 10_100, 10)); // second at 101
    ex.submit(lim('c', 'sell', 10_050, 5)); // better price
    const r = ex.submit(lim('d', 'buy', 10_100, 20));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fills.map((f) => [f.sellAgent, f.price, f.qty])).toEqual([
      ['c', 10_050, 5],
      ['a', 10_100, 10],
      ['b', 10_100, 5],
    ]);
    expect(r.resting).toBe(0);
    expect(ex.books.get('TEST')!.bestAsk()).toBe(10_100);
    expect(ex.books.get('TEST')!.depth().asks[0]!.qty).toBe(5);
  });

  it('rests the unfilled remainder of a limit order', () => {
    const { ex } = mkExchange();
    ex.submit(lim('a', 'sell', 10_000, 3));
    const r = ex.submit(lim('b', 'buy', 10_000, 10));
    expect(r.ok && r.resting).toBe(7);
    expect(ex.books.get('TEST')!.bestBid()).toBe(10_000);
  });

  it('market orders sweep the book and cancel the rest', () => {
    const { ex } = mkExchange();
    ex.submit(lim('a', 'sell', 10_000, 3));
    ex.submit(lim('b', 'sell', 10_200, 3));
    const r = ex.submit({ agentId: 'c', symbol: 'TEST', side: 'buy', type: 'market', qty: 10 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fills.reduce((s, f) => s + f.qty, 0)).toBe(6);
    expect(r.cancelled).toBe(4);
    expect(ex.symbols.get('TEST')!.last).toBe(10_200);
  });

  it('IOC limit orders never rest', () => {
    const { ex } = mkExchange();
    const r = ex.submit({ ...lim('a', 'buy', 9_000, 5), tif: 'ioc' });
    expect(r.ok && r.cancelled).toBe(5);
    expect(ex.books.get('TEST')!.size).toBe(0);
  });

  it('moves cash and shares and conserves both', () => {
    const { ex } = mkExchange();
    const cash0 = [...ex.accounts.values()].reduce((s, a) => s + a.cash, 0);
    ex.submit(lim('a', 'sell', 10_000, 100));
    ex.submit(lim('b', 'buy', 10_000, 100));
    const a = ex.accounts.get('a')!;
    const b = ex.accounts.get('b')!;
    expect(a.pos('TEST')).toBe(900);
    expect(b.pos('TEST')).toBe(1_100);
    expect(b.cash).toBe(10_000_000 - 1_000_000);
    const cash1 = [...ex.accounts.values()].reduce((s, x) => s + x.cash, 0);
    expect(cash1).toBe(cash0);
    const shares = [...ex.accounts.values()].reduce((s, x) => s + x.pos('TEST'), 0);
    expect(shares).toBe(4_000);
  });

  it('charges taker fees and pays maker rebates', () => {
    const ex = new Exchange([SPEC], { takerFeeBps: 10, makerFeeBps: -2 });
    ex.openAccount('m', 10_000_000, { TEST: 100 });
    ex.openAccount('t', 10_000_000);
    ex.submit(lim('m', 'sell', 10_000, 100));
    ex.submit(lim('t', 'buy', 10_000, 100));
    // notional 1,000,000c; taker pays 10bps = 1000c; maker earns 2bps = 200c
    expect(ex.accounts.get('t')!.cash).toBe(10_000_000 - 1_000_000 - 1_000);
    expect(ex.accounts.get('m')!.cash).toBe(10_000_000 + 1_000_000 + 200);
  });

  it('prevents self-trades by cancelling the resting order', () => {
    const { ex } = mkExchange();
    ex.submit(lim('a', 'sell', 10_000, 5));
    ex.submit(lim('b', 'sell', 10_010, 5));
    const r = ex.submit(lim('a', 'buy', 10_010, 5));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]!.sellAgent).toBe('b');
    expect(ex.openOrders('a')).toHaveLength(0);
  });

  it('cancels orders and releases committed buying power', () => {
    const { ex } = mkExchange();
    const r = ex.submit(lim('a', 'buy', 9_000, 100));
    expect(r.ok).toBe(true);
    const a = ex.accounts.get('a')!;
    expect(a.committed).toBeGreaterThan(0);
    expect(ex.cancel('b', r.ok ? r.orderId : 0)).toBe(false); // not yours
    expect(ex.cancel('a', r.ok ? r.orderId : 0)).toBe(true);
    expect(a.committed).toBe(0);
  });

  it('rejects malformed orders', () => {
    const { ex } = mkExchange();
    expect(ex.submit(lim('a', 'buy', 10_000, 0))).toEqual({ ok: false, reason: 'bad-qty' });
    expect(ex.submit(lim('a', 'buy', 10.5, 1))).toEqual({ ok: false, reason: 'bad-price' });
    expect(ex.submit({ ...lim('a', 'buy', 100, 1), symbol: 'NOPE' })).toEqual({ ok: false, reason: 'unknown-symbol' });
    expect(ex.submit(lim('zz', 'buy', 100, 1))).toEqual({ ok: false, reason: 'unknown-account' });
  });
});

describe('Margin and short selling', () => {
  it('allows shorting within margin and rejects beyond it', () => {
    const ex = new Exchange([SPEC], { takerFeeBps: 0, makerFeeBps: 0, initialMargin: 0.5 });
    ex.openAccount('s', 1_000_000); // $10,000, no shares
    ex.openAccount('mm', 100_000_000);
    // 2x leverage => max gross $20,000 => 200 shares at $100
    expect(ex.submit(lim('s', 'sell', 10_000, 150)).ok).toBe(true);
    expect(ex.submit(lim('s', 'sell', 10_000, 100))).toEqual({ ok: false, reason: 'insufficient-margin' });
    ex.submit(lim('mm', 'buy', 10_000, 150));
    expect(ex.accounts.get('s')!.pos('TEST')).toBe(-150);
  });

  it('reducing orders never need margin', () => {
    const ex = new Exchange([SPEC]);
    ex.openAccount('x', 0, { TEST: 10 });
    expect(ex.submit(lim('x', 'sell', 10_000, 10)).ok).toBe(true);
  });

  it('detects margin calls and liquidates', () => {
    const ex = new Exchange([SPEC], { takerFeeBps: 0, makerFeeBps: 0, bandPct: 0.9, initialMargin: 0.5, maintenanceMargin: 0.25 });
    ex.openAccount('lev', 1_000_000);
    ex.openAccount('mm', 1_000_000_000, { TEST: 10_000 });
    ex.submit(lim('mm', 'sell', 10_000, 200));
    ex.submit(lim('lev', 'buy', 10_000, 200)); // $20k long on $10k equity
    const lev = ex.accounts.get('lev')!;
    expect(ex.marginCall(lev)).toBe(false);
    // Price drops 40%: equity 10k - 8k = 2k vs gross 12k => 16.7% < 25%
    ex.submit(lim('mm', 'sell', 6_000, 1));
    ex.openAccount('x', 10_000_000);
    ex.submit(lim('x', 'buy', 6_000, 1));
    expect(ex.symbols.get('TEST')!.last).toBe(6_000);
    expect(ex.marginCall(lev)).toBe(true);
    ex.submit(lim('mm', 'buy', 5_900, 500));
    const fills = ex.liquidate('lev');
    expect(fills.length).toBeGreaterThan(0);
    expect(lev.pos('TEST')).toBe(0);
    expect(lev.liquidations).toBe(1);
  });
});

describe('Circuit breakers', () => {
  it('halts instead of printing outside the band, then reopens with a cross', () => {
    const ex = new Exchange([SPEC], { takerFeeBps: 0, makerFeeBps: 0, bandPct: 0.1, haltTicks: 5 });
    for (const id of ['a', 'b', 'c']) ex.openAccount(id, 100_000_000, { TEST: 1_000 });
    const events: ExchangeEvent[] = [];
    ex.on((e) => events.push(e));
    ex.submit(lim('a', 'buy', 9_500, 10));
    ex.submit(lim('a', 'buy', 8_500, 10)); // outside the -10% band
    const r = ex.submit({ agentId: 'b', symbol: 'TEST', side: 'sell', type: 'market', qty: 20 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]!.price).toBe(9_500);
    const st = ex.symbols.get('TEST')!;
    expect(st.halted).toBe(true);
    expect(events.some((e) => e.type === 'halt')).toBe(true);
    // Market orders are rejected while halted; limit orders queue up.
    expect(ex.submit({ agentId: 'c', symbol: 'TEST', side: 'sell', type: 'market', qty: 1 })).toEqual({
      ok: false,
      reason: 'trading-halted',
    });
    expect(ex.submit(lim('c', 'sell', 8_400, 5)).ok).toBe(true);
    ex.advance(5);
    expect(st.halted).toBe(false);
    expect(events.some((e) => e.type === 'resume')).toBe(true);
    // The re-opening cross matched the crossed orders.
    expect(ex.accounts.get('c')!.pos('TEST')).toBe(995);
  });
});

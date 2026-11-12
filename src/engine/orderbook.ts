import type { BookLevel, Depth, RestingOrder, Side } from '../core/types.js';

/**
 * One price level: a FIFO queue of resting orders. Cancelled orders are
 * removed lazily (their qty drops to 0) so cancel is O(1); the head pointer
 * skips them during matching and the array is compacted occasionally.
 */
export class Level {
  readonly orders: RestingOrder[] = [];
  head = 0;
  qty = 0;
  live = 0;

  constructor(readonly price: number) {}

  push(o: RestingOrder): void {
    this.orders.push(o);
    this.qty += o.qty;
    this.live++;
  }

  /** First live order in time priority, or undefined. */
  front(): RestingOrder | undefined {
    while (this.head < this.orders.length && this.orders[this.head]!.qty === 0) this.head++;
    if (this.head > 64 && this.head * 2 > this.orders.length) {
      this.orders.splice(0, this.head);
      this.head = 0;
    }
    return this.orders[this.head];
  }
}

/**
 * Price-time priority limit order book for a single symbol.
 *
 * Bids are kept as a price-sorted array (best = highest = last element) and
 * asks likewise (best = lowest = last element), so the best level is always
 * at the end and removing it is O(1). Inserting a new level is a binary search.
 */
export class OrderBook {
  /** Ascending by price; best bid at the end. */
  private readonly bidPrices: number[] = [];
  /** Descending by price; best ask at the end. */
  private readonly askPrices: number[] = [];
  private readonly bidLevels = new Map<number, Level>();
  private readonly askLevels = new Map<number, Level>();
  private readonly byId = new Map<number, RestingOrder>();

  constructor(readonly symbol: string) {}

  get size(): number {
    return this.byId.size;
  }

  bestBid(): number | null {
    const p = this.bidPrices[this.bidPrices.length - 1];
    return p === undefined ? null : p;
  }

  bestAsk(): number | null {
    const p = this.askPrices[this.askPrices.length - 1];
    return p === undefined ? null : p;
  }

  mid(): number | null {
    const b = this.bestBid();
    const a = this.bestAsk();
    if (b === null || a === null) return b ?? a;
    return (a + b) / 2;
  }

  get(id: number): RestingOrder | undefined {
    return this.byId.get(id);
  }

  /** Best level on the given side, or undefined when that side is empty. */
  bestLevel(side: Side): Level | undefined {
    const prices = side === 'buy' ? this.bidPrices : this.askPrices;
    const levels = side === 'buy' ? this.bidLevels : this.askLevels;
    const p = prices[prices.length - 1];
    return p === undefined ? undefined : levels.get(p);
  }

  /** Rest an order on the book (no matching; the exchange matches first). */
  add(o: RestingOrder): void {
    const buy = o.side === 'buy';
    const levels = buy ? this.bidLevels : this.askLevels;
    let level = levels.get(o.price);
    if (!level) {
      level = new Level(o.price);
      levels.set(o.price, level);
      insertSorted(buy ? this.bidPrices : this.askPrices, o.price, buy);
    }
    level.push(o);
    this.byId.set(o.id, o);
  }

  /** Reduce a resting order after a fill. Removes it (and its level) when done. */
  reduce(o: RestingOrder, qty: number): void {
    const level = (o.side === 'buy' ? this.bidLevels : this.askLevels).get(o.price);
    o.qty -= qty;
    if (level) level.qty -= qty;
    if (o.qty <= 0) {
      o.qty = 0;
      this.byId.delete(o.id);
      if (level) {
        level.live--;
        if (level.live <= 0) this.dropLevel(o.side, o.price);
      }
    }
  }

  /** Cancel by id. Returns the cancelled order (with its remaining qty) or undefined. */
  cancel(id: number): RestingOrder | undefined {
    const o = this.byId.get(id);
    if (!o) return undefined;
    const remaining = o.qty;
    this.reduce(o, remaining);
    return { ...o, qty: remaining };
  }

  private dropLevel(side: Side, price: number): void {
    const buy = side === 'buy';
    const levels = buy ? this.bidLevels : this.askLevels;
    const prices = buy ? this.bidPrices : this.askPrices;
    levels.delete(price);
    const i = indexOfSorted(prices, price, buy);
    if (i >= 0) prices.splice(i, 1);
  }

  /** Aggregated depth, best level first, up to `n` levels a side. */
  depth(n = 10): Depth {
    return { bids: this.side('buy', n), asks: this.side('sell', n) };
  }

  private side(side: Side, n: number): BookLevel[] {
    const prices = side === 'buy' ? this.bidPrices : this.askPrices;
    const levels = side === 'buy' ? this.bidLevels : this.askLevels;
    const out: BookLevel[] = [];
    for (let i = prices.length - 1; i >= 0 && out.length < n; i--) {
      const l = levels.get(prices[i]!)!;
      out.push({ price: l.price, qty: l.qty, orders: l.live });
    }
    return out;
  }

  /** All live orders (unordered). */
  orders(): IterableIterator<RestingOrder> {
    return this.byId.values();
  }

  /** Total resting quantity on one side within `pct` of the touch. */
  liquidityNear(side: Side, pct: number): number {
    const best = side === 'buy' ? this.bestBid() : this.bestAsk();
    if (best === null) return 0;
    const limit = side === 'buy' ? best * (1 - pct) : best * (1 + pct);
    let q = 0;
    for (const l of this.side(side, 1e9)) {
      if (side === 'buy' ? l.price < limit : l.price > limit) break;
      q += l.qty;
    }
    return q;
  }
}

/**
 * Bids: ascending array (best at end). Asks: descending array (best at end).
 */
function insertSorted(arr: number[], price: number, ascending: boolean): void {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const before = ascending ? arr[mid]! < price : arr[mid]! > price;
    if (before) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, price);
}

function indexOfSorted(arr: number[], price: number, ascending: boolean): number {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = arr[mid]!;
    if (v === price) return mid;
    const before = ascending ? v < price : v > price;
    if (before) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

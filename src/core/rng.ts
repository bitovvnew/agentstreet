/**
 * Deterministic pseudo-random numbers. Every source of randomness in a run
 * derives from one seed, so a replay file (seed + recorded inputs) reproduces
 * the exact same market, trade for trade.
 */

/** 32-bit FNV-1a hash of a string, used to derive independent sub-streams. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class Rng {
  private state: number;

  constructor(seed: number | string) {
    this.state = (typeof seed === 'string' ? hashString(seed) : seed >>> 0) || 0x9e3779b9;
  }

  /** Uniform float in [0, 1). Mulberry32. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Independent child stream; the label keeps streams stable when others are added. */
  fork(label: string): Rng {
    return new Rng((hashString(label) ^ Math.imul(this.state, 0x85ebca6b)) >>> 0);
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  int(min: number, maxInclusive: number): number {
    return Math.floor(this.range(min, maxInclusive + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }

  /** Standard normal via Box-Muller. */
  normal(mean = 0, sd = 1): number {
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Weighted choice over [item, weight] pairs. */
  weighted<T>(pairs: readonly (readonly [T, number])[]): T {
    const total = pairs.reduce((a, [, w]) => a + w, 0);
    let r = this.next() * total;
    for (const [item, w] of pairs) {
      r -= w;
      if (r <= 0) return item;
    }
    return pairs[pairs.length - 1]![0];
  }
}

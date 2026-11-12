import type { ReplayFile } from '../sim/types.js';
import { scoreAgents } from './leaderboard.js';

export type HighlightKind = 'crash' | 'rally' | 'bubble' | 'bargain' | 'breaker' | 'cascade' | 'bust' | 'rumor' | 'winner' | 'loser';

export interface Highlight {
  /** Tick to jump to (the climax). */
  t: number;
  /** Where the move started, when it is a move. */
  t0?: number;
  kind: HighlightKind;
  symbol?: string;
  /** Short English title; the dashboard localises by kind + params. */
  title: string;
  /** Magnitude used for ranking and display (percent for moves). */
  value: number;
  score: number;
}

type Data = Pick<ReplayFile, 'frames' | 'events' | 'news' | 'equity' | 'agents' | 'symbols'>;

/**
 * Finds the moments worth watching in a run: crashes and rallies, bubbles
 * (price far above hidden true value) and bargains, circuit breakers,
 * liquidation cascades, bankruptcies, rumors that moved the price, and the
 * best and worst traders. Pure function over recorded data, so it works the
 * same for live sessions and replay files.
 */
export function findHighlights(d: Data, limit = 14): Highlight[] {
  const out: Highlight[] = [];
  const f = d.frames;
  if (f.length < 2) return out;
  const t0 = f[0]!.t;
  const at = (t: number) => f[Math.max(0, Math.min(f.length - 1, t - t0))]!;

  d.symbols.forEach((s, si) => {
    // Moves: >= 7% within a 30-minute window, measured from the window's extreme.
    let cooldown = -1;
    for (let i = 30; i < f.length; i++) {
      if (i < cooldown) continue;
      const now = f[i]!.sym[si]![0];
      let hi = now, hiI = i, lo = now, loI = i;
      for (let k = i - 30; k < i; k++) {
        const p = f[k]!.sym[si]![0];
        if (p > hi) (hi = p), (hiI = k);
        if (p < lo) (lo = p), (loI = k);
      }
      const drop = now / hi - 1;
      const rise = now / lo - 1;
      if (drop <= -0.07) {
        // Extend to the trough.
        let j = i, trough = now;
        while (j + 1 < f.length && f[j + 1]!.sym[si]![0] <= trough) trough = f[++j]!.sym[si]![0];
        const v = (trough / hi - 1) * 100;
        out.push({ t: f[j]!.t, t0: f[hiI]!.t, kind: 'crash', symbol: s.symbol, title: `${s.symbol} crashes ${v.toFixed(1)}%`, value: v, score: -v * 1.2 });
        cooldown = j + 45;
      } else if (rise >= 0.07) {
        let j = i, peak = now;
        while (j + 1 < f.length && f[j + 1]!.sym[si]![0] >= peak) peak = f[++j]!.sym[si]![0];
        const v = (peak / lo - 1) * 100;
        out.push({ t: f[j]!.t, t0: f[loI]!.t, kind: 'rally', symbol: s.symbol, title: `${s.symbol} rips +${v.toFixed(1)}%`, value: v, score: v });
        cooldown = j + 45;
      }
    }
    // Bubbles and bargains: price vs hidden true value.
    let best = 0, bestI = -1, worst = 0, worstI = -1;
    for (let i = 0; i < f.length; i++) {
      const [last, , , , , , fair] = f[i]!.sym[si]!;
      const gap = fair > 0 ? last / fair - 1 : 0;
      if (gap > best) (best = gap), (bestI = i);
      if (gap < worst) (worst = gap), (worstI = i);
    }
    if (best >= 0.18) out.push({ t: f[bestI]!.t, kind: 'bubble', symbol: s.symbol, title: `${s.symbol} bubble: ${(best * 100).toFixed(0)}% above true value`, value: best * 100, score: best * 70 });
    if (worst <= -0.18) out.push({ t: f[worstI]!.t, kind: 'bargain', symbol: s.symbol, title: `${s.symbol} oversold: ${(-worst * 100).toFixed(0)}% below true value`, value: worst * 100, score: -worst * 60 });
  });

  // Breakers, busts, cascades.
  const liq: number[] = [];
  for (const e of d.events) {
    if (e.type === 'breaker') out.push({ t: e.t, kind: 'breaker', title: e.text.replace(/ —.*$/, ''), value: 0, score: 30 });
    if (e.type === 'bust') out.push({ t: e.t, kind: 'bust', title: e.text, value: 0, score: 14 });
    if (e.type === 'liquidation') liq.push(e.t);
  }
  for (let i = 0; i < liq.length; ) {
    let j = i;
    while (j + 1 < liq.length && liq[j + 1]! - liq[i]! <= 6) j++;
    const n = j - i + 1;
    if (n >= 3) out.push({ t: liq[j]!, t0: liq[i]!, kind: 'cascade', title: `Liquidation cascade: ${n} margin calls in ${liq[j]! - liq[i]! + 1} min`, value: n, score: 10 + n * 3 });
    i = j + 1;
  }

  // Rumors that resolved, with the price move over their life.
  for (const n of d.news) {
    if ((n.kind !== 'confirm' && n.kind !== 'debunk') || !n.symbol || !n.followUpOf) continue;
    const orig = d.news.find((x) => x.id === n.followUpOf);
    const si = d.symbols.findIndex((s) => s.symbol === n.symbol);
    if (!orig || si < 0 || orig.t < t0) continue;
    const move = (at(Math.min(n.t + 10, at(Infinity).t)).sym[si]![0] / at(orig.t).sym[si]![0] - 1) * 100;
    if (Math.abs(move) < 3) continue;
    out.push({ t: n.t, t0: orig.t, kind: 'rumor', symbol: n.symbol, title: `Rumor ${n.kind === 'confirm' ? 'confirmed' : 'denied'}: ${n.symbol} ${move >= 0 ? '+' : ''}${move.toFixed(1)}%`, value: move, score: Math.abs(move) * 1.5 });
  }

  // Best and worst trader so far.
  if (d.equity.length) {
    const sc = scoreAgents(d.agents, d.equity).sort((a, b) => b.returnPct - a.returnPct);
    const last = d.equity[d.equity.length - 1]!.t;
    const w = sc[0];
    const l = sc[sc.length - 1];
    if (w && w.returnPct > 5) out.push({ t: last, kind: 'winner', title: `@${w.name} leads with +${w.returnPct.toFixed(1)}%`, value: w.returnPct, score: 8 });
    if (l && l.returnPct < -10) out.push({ t: last, kind: 'loser', title: `@${l.name} is down ${l.returnPct.toFixed(1)}%`, value: l.returnPct, score: 7 });
  }

  return out
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .sort((a, b) => a.t - b.t);
}

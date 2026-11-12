import type { AgentInfo, EquitySnap } from '../sim/types.js';

export interface AgentScore {
  idx: number;
  name: string;
  personality: string;
  team: string;
  equity: number;
  pnl: number;
  returnPct: number;
  /** Sharpe ratio of per-snapshot returns, scaled by sqrt(snapshots). Unitless, sim-only. */
  sharpe: number;
  maxDrawdownPct: number;
  busted: boolean;
}

export interface GroupScore {
  group: string;
  agents: number;
  avgReturnPct: number;
  medianReturnPct: number;
  avgSharpe: number;
  worstDrawdownPct: number;
  busted: number;
}

/** Score every agent from its equity curve. `upto` limits to snapshots at or before that tick. */
export function scoreAgents(agents: AgentInfo[], snaps: EquitySnap[], upto = Infinity): AgentScore[] {
  const rows = snaps.filter((s) => s.t <= upto);
  return agents.map((a, i) => {
    const start = a.startEquity / 100;
    const curve = [start, ...rows.map((s) => s.eq[i]!)];
    const last = curve[curve.length - 1]!;
    let peak = curve[0]!;
    let mdd = 0;
    const rets: number[] = [];
    for (let k = 1; k < curve.length; k++) {
      const prev = curve[k - 1]!;
      const cur = curve[k]!;
      if (prev > 0) rets.push(cur / prev - 1);
      peak = Math.max(peak, cur);
      if (peak > 0) mdd = Math.min(mdd, cur / peak - 1);
    }
    const mean = rets.length ? rets.reduce((x, y) => x + y, 0) / rets.length : 0;
    const sd = rets.length > 1 ? Math.sqrt(rets.reduce((x, y) => x + (y - mean) ** 2, 0) / (rets.length - 1)) : 0;
    const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(rets.length) : 0;
    const lastSnap = rows[rows.length - 1];
    return {
      idx: i,
      name: a.name,
      personality: a.personality,
      team: a.team,
      equity: last,
      pnl: last - start,
      returnPct: start > 0 ? (last / start - 1) * 100 : 0,
      sharpe,
      maxDrawdownPct: mdd * 100,
      busted: !!lastSnap?.busted?.[i],
    };
  });
}

export function groupScores(scores: AgentScore[], key: 'team' | 'personality'): GroupScore[] {
  const groups = new Map<string, AgentScore[]>();
  for (const s of scores) {
    const g = groups.get(s[key]) ?? [];
    g.push(s);
    groups.set(s[key], g);
  }
  return [...groups.entries()]
    .map(([group, xs]) => {
      const r = xs.map((x) => x.returnPct).sort((a, b) => a - b);
      return {
        group,
        agents: xs.length,
        avgReturnPct: r.reduce((a, b) => a + b, 0) / r.length,
        medianReturnPct: r[Math.floor(r.length / 2)]!,
        avgSharpe: xs.reduce((a, x) => a + x.sharpe, 0) / xs.length,
        worstDrawdownPct: Math.min(...xs.map((x) => x.maxDrawdownPct)),
        busted: xs.filter((x) => x.busted).length,
      };
    })
    .sort((a, b) => b.avgReturnPct - a.avgReturnPct);
}

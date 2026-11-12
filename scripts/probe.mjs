// Dev-only: run a headless market and print dynamics for tuning.
import { Simulation } from '../dist/sim/simulation.js';
import { scoreAgents, groupScores } from '../dist/metrics/leaderboard.js';

const scenario = process.argv[2] ?? 'default';
const ticks = Number(process.argv[3] ?? 800);
const sim = new Simulation({ seed: 7, scenario });
let trades = 0;
let halts = 0;
let liq = 0;
let busts = 0;
const eq = [];
const t0 = Date.now();
for (let i = 0; i < ticks; i++) {
  const d = await sim.step();
  trades += d.trades.length;
  for (const e of d.events) {
    if (e.type === 'halt') halts++;
    if (e.type === 'liquidation') liq++;
    if (e.type === 'bust') busts++;
    if (['breaker', 'bust', 'crash'].includes(e.type)) console.log(d.frame.clock, e.text);
  }
  if (d.equity) eq.push(d.equity);
  if (i % 100 === 0 || i === ticks - 1) {
    console.log(
      d.frame.clock,
      'idx', d.frame.index.toFixed(1),
      'fg', d.frame.fearGreed,
      'vol', d.frame.vol,
      d.frame.sym.map((s, k) => `${sim.symbols[k].symbol} ${(s[0] / 100).toFixed(2)}/${(s[6] / 100).toFixed(2)} sp${s[2] && s[1] ? s[2] - s[1] : '-'}`).join(' | '),
    );
  }
}
console.log({ ms: Date.now() - t0, trades, halts, liq, busts, news: sim.newsroom.items.length, hash: sim.tradeHash() });
const scores = scoreAgents(sim.agentInfos(), eq);
console.table(groupScores(scores, 'personality').map((g) => ({ ...g, avgReturnPct: g.avgReturnPct.toFixed(2), avgSharpe: g.avgSharpe.toFixed(2), worstDrawdownPct: g.worstDrawdownPct.toFixed(1) })));

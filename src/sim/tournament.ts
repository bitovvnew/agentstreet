import { Simulation } from './simulation.js';
import { Recorder } from './recorder.js';
import { groupScores, scoreAgents, type GroupScore } from '../metrics/leaderboard.js';
import type { SimConfig } from './types.js';
import { LlmGuard } from '../agents/brains/index.js';
import { DEFAULT_LIMITS } from '../safety/limits.js';
import { VERSION } from '../version.js';

export interface TournamentOptions {
  seeds: number[];
  scenarios: string[];
  ticks: number;
  config?: Partial<SimConfig>;
  onProgress?: (done: number, total: number, label: string) => void;
}

export interface Aggregate {
  group: string;
  runs: number;
  mean: number;
  sd: number;
  /** Half-width of the 95% confidence interval of the mean (normal approx.). */
  ci95: number;
  best: number;
  worst: number;
  /** Runs in which this group had the highest average return. */
  wins: number;
  avgSharpe: number;
  busted: number;
}

export interface TournamentResult {
  app: string;
  created: string;
  ticks: number;
  seeds: number[];
  scenarios: string[];
  models: string[];
  runs: { seed: number; scenario: string; hash: string; teams: GroupScore[]; personalities: GroupScore[] }[];
  teams: Aggregate[];
  personalities: Aggregate[];
}

function aggregate(rows: { run: number; g: GroupScore }[]): Aggregate[] {
  const by = new Map<string, GroupScore[]>();
  for (const { g } of rows) {
    const l = by.get(g.group) ?? [];
    l.push(g);
    by.set(g.group, l);
  }
  const winners = new Map<number, string>();
  for (const { run, g } of rows) {
    const cur = winners.get(run);
    const curScore = cur ? rows.find((r) => r.run === run && r.g.group === cur)!.g.avgReturnPct : -Infinity;
    if (g.avgReturnPct > curScore) winners.set(run, g.group);
  }
  return [...by.entries()]
    .map(([group, xs]) => {
      const r = xs.map((x) => x.avgReturnPct);
      const mean = r.reduce((a, b) => a + b, 0) / r.length;
      const sd = r.length > 1 ? Math.sqrt(r.reduce((a, x) => a + (x - mean) ** 2, 0) / (r.length - 1)) : 0;
      return {
        group,
        runs: r.length,
        mean,
        sd,
        ci95: r.length > 1 ? (1.96 * sd) / Math.sqrt(r.length) : 0,
        best: Math.max(...r),
        worst: Math.min(...r),
        wins: [...winners.values()].filter((w) => w === group).length,
        avgSharpe: xs.reduce((a, x) => a + x.avgSharpe, 0) / xs.length,
        busted: xs.reduce((a, x) => a + x.busted, 0),
      };
    })
    .sort((a, b) => b.mean - a.mean);
}

/**
 * Run many seeds x scenarios headless and rank teams (models) and
 * strategies with confidence intervals. One seed is an anecdote; thirty
 * is evidence.
 */
export async function runTournament(o: TournamentOptions): Promise<TournamentResult> {
  const total = o.seeds.length * o.scenarios.length;
  const guard = new LlmGuard({ ...DEFAULT_LIMITS, ...(o.config?.limits ?? {}) });
  const runs: TournamentResult['runs'] = [];
  let done = 0;
  for (const scenario of o.scenarios) {
    for (const seed of o.seeds) {
      const sim = new Simulation({ ...o.config, scenario, seed, llmMode: 'blocking' }, { guard });
      const rec = new Recorder(sim);
      for (let i = 0; i < o.ticks; i++) rec.push(await sim.step());
      const scores = scoreAgents(rec.data.agents, rec.data.equity);
      runs.push({ seed, scenario, hash: rec.data.meta.hash, teams: groupScores(scores, 'team'), personalities: groupScores(scores, 'personality') });
      o.onProgress?.(++done, total, `${scenario} #${seed}`);
    }
  }
  return {
    app: `agentstreet@${VERSION}`,
    created: new Date().toISOString(),
    ticks: o.ticks,
    seeds: o.seeds,
    scenarios: o.scenarios,
    models: o.config?.models ?? [],
    runs,
    teams: aggregate(runs.flatMap((r, run) => r.teams.map((g) => ({ run, g })))),
    personalities: aggregate(runs.flatMap((r, run) => r.personalities.map((g) => ({ run, g })))),
  };
}

const pct = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`;

export function tournamentMarkdown(r: TournamentResult): string {
  const table = (title: string, rows: Aggregate[]) =>
    [
      `### ${title}`,
      '',
      '| # | Group | Mean return | ±95% CI | Best | Worst | Wins | Sharpe | Busted |',
      '|---|---|---:|---:|---:|---:|---:|---:|---:|',
      ...rows.map((a, i) => `| ${i + 1} | ${a.group} | ${pct(a.mean)} | ±${a.ci95.toFixed(2)} | ${pct(a.best)} | ${pct(a.worst)} | ${a.wins}/${r.runs.length} | ${a.avgSharpe.toFixed(2)} | ${a.busted} |`),
      '',
    ].join('\n');
  return [
    `# AgentStreet tournament`,
    '',
    `${r.runs.length} runs · ${r.scenarios.join(', ')} · seeds ${r.seeds[0]}–${r.seeds[r.seeds.length - 1]} · ${r.ticks} ticks each · ${r.app}`,
    '',
    r.teams.length > 1 ? table('Model league', r.teams) : '',
    table('Strategy league', r.personalities),
    '_Simulation only. Fictional market, play money, not financial advice._',
    '',
  ].join('\n');
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** A self-contained HTML report (no external assets) with CI bars. */
export function tournamentHtml(r: TournamentResult): string {
  const block = (title: string, rows: Aggregate[]) => {
    const lo = Math.min(0, ...rows.map((a) => a.mean - a.ci95));
    const hi = Math.max(0, ...rows.map((a) => a.mean + a.ci95));
    const X = (v: number) => ((v - lo) / (hi - lo || 1)) * 100;
    return `<h2>${esc(title)}</h2><table><thead><tr><th>#</th><th>Group</th><th class="bar">Mean return, 95% CI</th><th>Mean</th><th>Wins</th><th>Sharpe</th><th>Busted</th></tr></thead><tbody>${rows
      .map(
        (a, i) => `<tr><td>${i + 1}</td><td>${esc(a.group)}</td><td class="bar"><div class="axis" style="left:${X(0)}%"></div><div class="ci" style="left:${X(a.mean - a.ci95)}%;width:${X(a.mean + a.ci95) - X(a.mean - a.ci95)}%"></div><div class="dot ${a.mean >= 0 ? 'up' : 'down'}" style="left:${X(a.mean)}%"></div></td><td class="${a.mean >= 0 ? 'up' : 'down'}">${a.mean >= 0 ? '▲' : '▼'} ${pct(a.mean)} <span class="m">±${a.ci95.toFixed(2)}</span></td><td>${a.wins}/${r.runs.length}</td><td>${a.avgSharpe.toFixed(2)}</td><td>${a.busted}</td></tr>`,
      )
      .join('')}</tbody></table>`;
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentStreet tournament</title><style>
:root{color-scheme:dark}body{margin:0;padding:28px 16px;background:#0b0b0a;color:#f0efec;font:13px/1.45 ui-monospace,"Cascadia Mono",Menlo,Consolas,monospace}
main{max-width:1000px;margin:0 auto}h1{color:#fab219;letter-spacing:.14em;font-size:18px;margin:0 0 4px}h2{color:#fab219;font-size:12px;letter-spacing:.14em;text-transform:uppercase;margin:28px 0 8px}
.meta{color:#898781}table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}th{color:#898781;font-weight:400;text-align:left;border-bottom:1px solid #383835;padding:6px}td{padding:6px;border-bottom:1px solid #262624}
td.bar,th.bar{width:38%}td.bar{position:relative;height:18px}.axis{position:absolute;top:2px;bottom:2px;width:1px;background:#383835}.ci{position:absolute;top:8px;height:2px;background:#c3c2b7}.dot{position:absolute;top:4px;width:10px;height:10px;margin-left:-5px;border-radius:50%;border:2px solid #0b0b0a}
.dot.up{background:#199e70}.dot.down{background:#e66767}.up{color:#4cd69a}.down{color:#f08a8a}.m{color:#898781}footer{color:#898781;margin-top:28px}
@media(max-width:640px){td.bar,th.bar{display:none}}
</style></head><body><main><h1>▌AGENTSTREET TOURNAMENT</h1><div class="meta">${r.runs.length} runs · ${esc(r.scenarios.join(', '))} · seeds ${r.seeds[0]}–${r.seeds[r.seeds.length - 1]} · ${r.ticks} ticks each · ${esc(r.app)}</div>
${r.teams.length > 1 ? block('Model league', r.teams) : ''}${block('Strategy league', r.personalities)}
<footer>Simulation only. Fictional companies, play money, not financial advice. Every run is reproducible from its seed.</footer></main></body></html>`;
}

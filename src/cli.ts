import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Simulation } from './sim/simulation.js';
import { Recorder, loadReplay } from './sim/recorder.js';
import { startServer } from './server/server.js';
import { scenarios, registerScenario, type Scenario } from './scenarios/index.js';
import { registerPersonality } from './agents/personalities.js';
import type { Personality } from './agents/types.js';
import { groupScores, scoreAgents } from './metrics/leaderboard.js';
import { VERSION } from './version.js';
import type { SimConfig } from './sim/types.js';

const C = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (C ? `\x1b[${code}m${s}\x1b[0m` : s);
const amber = paint('38;5;214');
const dim = paint('2');
const bold = paint('1');
const green = paint('32');
const red = paint('31');

const HELP = `
${amber(bold('AGENTSTREET'))} ${dim(`v${VERSION}`)}  ${dim('a simulated stock exchange run by AI trader agents · play money only')}

${bold('Usage')}
  agentstreet                         live demo in your browser (no API keys needed)
  agentstreet live [options]          same, with options
  agentstreet run --ticks N [options] headless run, prints the leaderboard, saves a replay
  agentstreet replay <file>           open a replay file in the dashboard
  agentstreet verify <file>           re-simulate a replay and check it is bit-for-bit identical
  agentstreet scenarios               list built-in scenarios

${bold('Options')}
  --scenario <id>        default | meme-mania | flash-crash | rate-shock | earnings-season
  --seed <n>             random seed (same seed + same inputs = same market)
  --models <list>        LLM teams, comma separated provider:model
                         e.g. anthropic:claude-haiku-5-5,openai:gpt-4o-mini,gemini:gemini-2.0-flash,ollama:llama3.1
  --llm-every <n>        ticks between LLM decisions per agent (default 10)
  --news-writer <spec>   let an LLM rewrite newsroom headlines (provider:model)
  --plugin <file.js>     load custom strategies/scenarios (repeatable)
  --ticks <n>            stop after n ticks (live: pause; run: required)
  --out <file>           replay output path for "run" (.json or .json.gz)
  --port <n>             dashboard port (default 4600)
  --host <addr>          bind address (default 127.0.0.1)
  --speed <x>            0.5 | 1 | 2 | 5 | 10 | 25 (live, default 1)
  --no-open              don't open the browser

${bold('Keys')}  OPENAI_API_KEY · ANTHROPIC_API_KEY · GEMINI_API_KEY · OLLAMA_HOST · OPENAI_BASE_URL

${dim('Everything is fictional. Not financial advice. No real orders are ever sent anywhere.')}
`;

interface Args {
  _: string[];
  [k: string]: string | boolean | string[];
}

function parse(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=', 2) as [string, string | undefined];
      if (k.startsWith('no-')) {
        out[k.slice(3)] = false;
        continue;
      }
      const next = argv[i + 1];
      const v = inline ?? (next !== undefined && !next.startsWith('--') ? (i++, next) : true);
      if (k === 'plugin') out.plugin = [...((out.plugin as string[]) ?? []), String(v)];
      else out[k] = v;
    } else if (a === '-h') out.help = true;
    else out._.push(a);
  }
  return out;
}

async function loadPlugins(files: string[]): Promise<void> {
  for (const f of files) {
    const mod = await import(pathToFileURL(resolve(f)).href);
    const exported = mod.default ?? mod;
    const items: unknown[] = Array.isArray(exported)
      ? exported
      : [exported, ...((exported.personalities as unknown[]) ?? []), ...((exported.scenarios as unknown[]) ?? []), ...((exported.strategies as unknown[]) ?? [])];
    let n = 0;
    for (const it of items as any[]) {
      if (it && typeof it.strategy === 'function' && it.id) {
        registerPersonality(it as Personality);
        n++;
      } else if (it && it.id && it.name && (typeof it.onTick === 'function' || typeof it.setup === 'function' || it.config)) {
        registerScenario(it as Scenario);
        n++;
      }
    }
    console.log(`${green('✓')} plugin ${f} ${dim(`(${n} item${n === 1 ? '' : 's'})`)}`);
  }
}

function simConfig(a: Args): Partial<SimConfig> {
  const cfg: Partial<SimConfig> = {};
  if (a.scenario) cfg.scenario = String(a.scenario);
  if (a.seed !== undefined) cfg.seed = Number(a.seed);
  if (a.models) cfg.models = String(a.models).split(',').map((s) => s.trim()).filter(Boolean);
  if (a['llm-every']) cfg.llmEvery = Math.max(1, Number(a['llm-every']));
  if (a['news-writer']) cfg.newsWriter = String(a['news-writer']);
  if (a.mix) cfg.mix = JSON.parse(String(a.mix));
  return cfg;
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* ignore */
  }
}

function banner(): void {
  console.log(`\n  ${amber(bold('▌AGENTSTREET'))} ${dim(`v${VERSION}`)}  ${dim('— a simulated exchange run by AI agents. Play money only.')}\n`);
}

async function live(a: Args): Promise<void> {
  banner();
  const sim = new Simulation({ ...simConfig(a), llmMode: 'async', maxHistory: 20_000 });
  const rec = new Recorder(sim);
  const port = Number(a.port ?? process.env.PORT ?? 4600);
  const host = String(a.host ?? '127.0.0.1');
  const teams = [...new Set(sim.agentInfos().map((x) => x.team))];
  console.log(`  scenario  ${bold(sim.scenario.name)} ${dim(`(${sim.scenario.id}, seed ${sim.cfg.seed})`)}`);
  console.log(`  traders   ${sim.agents.length} agents · teams: ${teams.join(', ')}`);
  if (!sim.cfg.models.length) console.log(dim('  tip       add LLM teams with --models anthropic:claude-haiku-5-5,ollama:llama3.1'));
  startServer({
    port,
    host,
    mode: 'live',
    sim,
    recorder: rec,
    speed: Number(a.speed ?? 1),
    maxTicks: a.ticks ? Number(a.ticks) : 0,
    onListen: (url) => {
      console.log(`\n  ${green('●')} market open → ${bold(url)}\n  ${dim('Ctrl+C to close the market')}\n`);
      if (a.open !== false && !process.env.CI) openBrowser(url);
    },
  });
}

async function run(a: Args): Promise<void> {
  banner();
  const ticks = Number(a.ticks ?? 0);
  if (!ticks) throw new Error('run needs --ticks N');
  const sim = new Simulation({ ...simConfig(a), llmMode: 'blocking' });
  const rec = new Recorder(sim);
  const t0 = Date.now();
  let liq = 0;
  let halts = 0;
  for (let i = 0; i < ticks; i++) {
    const d = await sim.step();
    rec.push(d);
    for (const e of d.events) {
      if (e.type === 'liquidation') liq++;
      if (e.type === 'halt') halts++;
      if (e.type === 'breaker' || e.type === 'bust' || e.type === 'crash') console.log(`  ${dim(d.frame.clock)}  ${e.type === 'bust' ? red(e.text) : amber(e.text)}`);
    }
    if (process.stdout.isTTY && i % 50 === 0) process.stdout.write(`\r  ${dim(`simulating ${d.frame.clock}  ${Math.round((i / ticks) * 100)}%`)}   `);
  }
  if (process.stdout.isTTY) process.stdout.write('\r' + ' '.repeat(50) + '\r');
  const last = rec.data.frames[rec.data.frames.length - 1]!;
  console.log(`\n  ${bold(String(ticks))} ticks in ${((Date.now() - t0) / 1000).toFixed(1)}s · ${rec.data.trades.length.toLocaleString('en-US')} trades · ${halts} halts · ${liq} liquidations · index ${last.index.toFixed(1)}`);
  printLeaderboard(rec);
  for (const u of sim.llmUsage()) console.log(dim(`  ${u.team}: ${u.calls} calls, ${u.errors} errors, ${u.inputTokens + u.outputTokens} tokens`));
  const out = String(a.out ?? `replays/${sim.cfg.scenario}-seed${sim.cfg.seed}.street.json`);
  const bytes = rec.save(out);
  console.log(`\n  ${green('✓')} replay saved → ${out} ${dim(`(${(bytes / 1024 / 1024).toFixed(1)} MB, hash ${rec.data.meta.hash})`)}`);
  console.log(dim(`    open it:  agentstreet replay ${out}`));
}

function printLeaderboard(rec: Recorder): void {
  const scores = scoreAgents(rec.data.agents, rec.data.equity);
  const pct = (x: number) => {
    const s = `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`.padStart(9);
    return x >= 0 ? green(s) : red(s);
  };
  for (const key of ['team', 'personality'] as const) {
    const rows = groupScores(scores, key);
    if (key === 'team' && rows.length < 2) continue;
    console.log(`\n  ${bold(key === 'team' ? 'MODEL LEAGUE' : 'STRATEGY LEAGUE')}  ${dim('avg return · median · sharpe · worst DD · busted')}`);
    rows.forEach((r, i) => {
      console.log(
        `  ${String(i + 1).padStart(2)}. ${r.group.padEnd(30)} ${pct(r.avgReturnPct)} ${pct(r.medianReturnPct)} ${r.avgSharpe.toFixed(2).padStart(7)} ${`${r.worstDrawdownPct.toFixed(1)}%`.padStart(8)} ${String(r.busted).padStart(4)}`,
      );
    });
  }
  const top = [...scores].sort((a, b) => b.returnPct - a.returnPct);
  console.log(`\n  ${bold('TOP TRADERS')}`);
  for (const s of top.slice(0, 5)) console.log(`   ${green('▲')} @${s.name.padEnd(20)} ${s.personality.padEnd(13)} ${pct(s.returnPct)}`);
  for (const s of top.slice(-3)) console.log(`   ${red('▼')} @${s.name.padEnd(20)} ${s.personality.padEnd(13)} ${pct(s.returnPct)}${s.busted ? red(' BUSTED') : ''}`);
}

async function replay(a: Args): Promise<void> {
  banner();
  const file = a._[1];
  if (!file) throw new Error('usage: agentstreet replay <file>');
  const data = loadReplay(file);
  const port = Number(a.port ?? 4600);
  console.log(`  replay    ${bold(file)} ${dim(`(${data.meta.scenario}, seed ${data.meta.seed}, ${data.meta.ticks} ticks)`)}`);
  startServer({
    port,
    host: String(a.host ?? '127.0.0.1'),
    mode: 'replay',
    replay: data,
    onListen: (url) => {
      console.log(`\n  ${green('●')} replay → ${bold(url)}\n`);
      if (a.open !== false && !process.env.CI) openBrowser(url);
    },
  });
}

async function verify(a: Args): Promise<void> {
  const file = a._[1];
  if (!file) throw new Error('usage: agentstreet verify <file>');
  const data = loadReplay(file);
  if (data.meta.truncated) throw new Error('this replay was truncated (live history limit) and cannot be re-simulated from the start');
  const sim = new Simulation({ ...data.config, llmMode: 'blocking', newsWriter: null }, { replayLlm: data.llm });
  const inputs = [...data.inputs];
  for (let t = 1; t <= data.meta.ticks; t++) {
    while (inputs.length && inputs[0]!.t === t) sim.command(inputs.shift()!.cmd);
    await sim.step();
  }
  const ok = sim.tradeHash() === data.meta.hash;
  console.log(
    ok
      ? `${green('✓ verified')}  ${data.meta.ticks} ticks re-simulated, trade hash ${data.meta.hash} matches`
      : `${red('✗ mismatch')}  expected ${data.meta.hash}, got ${sim.tradeHash()}`,
  );
  if (!ok) process.exitCode = 1;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const a = parse(argv);
  if (a.help || a._[0] === 'help') return void console.log(HELP);
  if (a.version || a._[0] === 'version') return void console.log(VERSION);
  if (a.plugin) await loadPlugins(a.plugin as string[]);
  const cmd = a._[0] ?? 'live';
  switch (cmd) {
    case 'live':
    case 'demo':
      return live(a);
    case 'run':
      return run(a);
    case 'replay':
      return replay(a);
    case 'verify':
      return verify(a);
    case 'scenarios':
      for (const s of scenarios()) console.log(`  ${amber(s.id.padEnd(16))} ${bold(s.name)}\n  ${' '.repeat(16)} ${dim(s.description)}\n`);
      return;
    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

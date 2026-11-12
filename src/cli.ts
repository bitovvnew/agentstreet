import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface, type Interface } from 'node:readline';
import { Simulation } from './sim/simulation.js';
import { Recorder, loadReplay } from './sim/recorder.js';
import { startServer, type Market } from './server/server.js';
import { scenarios, registerScenario, type Scenario } from './scenarios/index.js';
import { registerPersonality, personalities } from './agents/personalities.js';
import type { Personality } from './agents/types.js';
import { groupScores, scoreAgents } from './metrics/leaderboard.js';
import { findHighlights } from './metrics/highlights.js';
import { runTournament, tournamentHtml, tournamentMarkdown } from './sim/tournament.js';
import { VERSION } from './version.js';
import type { SimConfig } from './sim/types.js';
import { loadEnv, readConfig, saveKeys, writeConfig, configDir, type AppConfig } from './config/store.js';
import { detectOllama, envKeysPresent, listModels, pingModel, PROVIDERS, type ModelInfo, type ProviderId } from './agents/brains/providers.js';
import { DEFAULT_LIMITS } from './safety/limits.js';
import { redact } from './safety/redact.js';
import { LANGUAGES, detectLanguage, translator } from './i18n.js';

const C = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (C ? `\x1b[${code}m${s}\x1b[0m` : s);
const amber = paint('38;5;214');
const dim = paint('2');
const bold = paint('1');
const green = paint('32');
const red = paint('31');

const HELP = `
${amber(bold('AGENTSTREET'))} ${dim(`v${VERSION}`)}  ${dim('a simulated stock exchange run by AI trader agents · play money only')}

${bold('Start')}
  agentstreet                         open the market (first run opens the setup wizard in your browser)
  agentstreet setup [--web]           configure AI providers, models and budgets
  agentstreet demo                    open a keyless market with the built-in trader strategies
  agentstreet --offline               offline mode: heuristic bots only, no keys, no network

${bold('Run & analyse')}
  agentstreet run --ticks N           headless run, prints the leaderboard, saves a replay
  agentstreet replay <file>           open a replay file in the dashboard
  agentstreet verify <file>           re-simulate a replay and check it is bit-for-bit identical
  agentstreet highlights <file>       list the moments worth watching in a replay
  agentstreet tournament              many seeds x scenarios, ranked with 95% confidence intervals
  agentstreet backtest --plugin f.js  tournament focused on your strategy plugin
  agentstreet init-strategy <name>    scaffold a strategy plugin
  agentstreet models <provider>       list the models a provider offers you right now
  agentstreet scenarios               list built-in scenarios

${bold('Options')}
  --scenario <id>        default | meme-mania | flash-crash | rate-shock | earnings-season
  --seed <n>             random seed (same seed + same inputs = same market)
  --models <list>        provider:model,... (openai, anthropic, gemini, openrouter, ollama)
  --offline              ignore saved models and trade with offline bots only
  --llm-every <n>        ticks between LLM decisions per agent (default 10)
  --budget-usd <x>       stop calling paid models after $x for the run (default ${DEFAULT_LIMITS.totalUsd})
  --budget-tokens <n>    run-wide token cap (default ${DEFAULT_LIMITS.totalTokens.toLocaleString('en-US')})
  --plugin <file.js>     load custom strategies/scenarios (repeatable)
  --ticks <n>  --out <file|dir>  --seeds 1-20  --scenarios a,b|all
  --port <n> (4600)  --host <addr> (127.0.0.1)  --speed <0.5|1|2|5|10|25>  --lang <code>  --no-open

${dim('Keys live in ./.agentstreet/.env (git-ignored, never logged). Everything is fictional. Not financial advice.')}
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
      const eq = a.indexOf('=');
      const k = eq > 0 ? a.slice(2, eq) : a.slice(2);
      const inline = eq > 0 ? a.slice(eq + 1) : undefined;
      if (k.startsWith('no-')) {
        out[k.slice(3)] = false;
        continue;
      }
      const next = argv[i + 1];
      const boolFlags = new Set(['offline', 'help', 'version', 'web']);
      const v = inline ?? (!boolFlags.has(k) && next !== undefined && !next.startsWith('--') ? (i++, next) : true);
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

function range(spec: string | boolean | string[] | undefined, dflt: number[]): number[] {
  if (typeof spec !== 'string') return dflt;
  const out: number[] = [];
  for (const part of spec.split(',')) {
    const m = part.match(/^(\d+)-(\d+)$/);
    if (m) for (let i = Number(m[1]); i <= Number(m[2]); i++) out.push(i);
    else if (/^\d+$/.test(part)) out.push(Number(part));
  }
  return out.length ? out : dflt;
}

/** Sim config from saved config + flags (flags win). */
function simConfig(a: Args, saved: AppConfig | null): Partial<SimConfig> {
  const cfg: Partial<SimConfig> = {};
  if (saved?.mode === 'llm' && !a.offline) {
    cfg.models = saved.models;
    cfg.prices = saved.prices;
    cfg.newsWriter = saved.newsWriter;
  }
  if (saved?.limits) cfg.limits = { ...saved.limits };
  if (a.scenario) cfg.scenario = String(a.scenario);
  if (a.seed !== undefined) cfg.seed = Number(a.seed);
  if (typeof a.models === 'string') cfg.models = a.models.split(',').map((s) => s.trim()).filter(Boolean);
  if (a['llm-every']) cfg.llmEvery = Math.max(1, Number(a['llm-every']));
  if (a['news-writer']) cfg.newsWriter = String(a['news-writer']);
  if (a.offline) { cfg.models = []; cfg.newsWriter = null; }
  if (a.mix) cfg.mix = JSON.parse(String(a.mix));
  if (a['budget-usd'] !== undefined) cfg.limits = { ...cfg.limits, totalUsd: Number(a['budget-usd']) };
  if (a['budget-tokens'] !== undefined) cfg.limits = { ...cfg.limits, totalTokens: Number(a['budget-tokens']) };
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

/* ───────────────────────────── live ───────────────────────────── */

async function live(a: Args, forceSetup = false): Promise<void> {
  banner();
  const saved = readConfig();
  const port = Number(a.port ?? process.env.PORT ?? 4600);
  const host = String(a.host ?? '127.0.0.1');
  const make = (cfg: Partial<SimConfig>): Market => {
    const sim = new Simulation({ ...cfg, llmMode: 'async', maxHistory: 20_000 });
    const teams = [...new Set(sim.agentInfos().map((x) => x.team))];
    console.log(`  scenario  ${bold(sim.scenario.name)} ${dim(`(${sim.scenario.id}, seed ${sim.cfg.seed})`)}`);
    console.log(`  traders   ${sim.agents.length} agents · teams: ${teams.join(', ')}`);
    if (sim.cfg.models.length) {
      const l = sim.guard.limits;
      console.log(dim(`  budget    $${l.totalUsd} (priced models) · ${l.totalTokens.toLocaleString('en-US')} tokens · ${l.rpm} req/min per provider`));
    }
    return { sim, recorder: new Recorder(sim) };
  };
  const needsSetup = forceSetup || (!saved && !a.offline && typeof a.models !== 'string');
  const market = needsSetup ? null : make(simConfig(a, saved));
  if (needsSetup) {
    console.log(`  ${amber('first run')}  finish setup in the browser, or run ${bold('agentstreet setup')} here.`);
    console.log(dim(`             (want no keys at all? use ${bold('--offline')})`));
  }
  startServer({
    port,
    host,
    mode: 'live',
    market,
    makeMarket: (cfg) => make(simConfig(a, cfg)),
    speed: Number(a.speed ?? 1),
    maxTicks: a.ticks ? Number(a.ticks) : 0,
    onListen: (url) => {
      const full = a.lang ? `${url}/?lang=${encodeURIComponent(String(a.lang))}` : url;
      console.log(`\n  ${green('●')} ${needsSetup ? 'setup' : 'market open'} → ${bold(full)}\n  ${dim('Ctrl+C to close the market')}\n`);
      if (a.open !== false && !process.env.CI) openBrowser(full);
    },
  });
}

/* ───────────────────────────── setup wizard (terminal) ───────────────────────────── */

function ask(rl: Interface, q: string): Promise<string> {
  return new Promise((r) => rl.question(q, (x) => r(x.trim())));
}

/** Read a secret without echoing it. */
function askSecret(rl: Interface, q: string): Promise<string> {
  return new Promise((resolveP) => {
    const r = rl as Interface & { _writeToOutput?: (s: string) => void; output?: NodeJS.WriteStream };
    const original = r._writeToOutput;
    let shown = false;
    r._writeToOutput = (s: string) => {
      if (!shown) {
        shown = true;
        process.stdout.write(s);
        return;
      }
      if (s.includes('\n') || s.includes('\r')) process.stdout.write('\n');
      else process.stdout.write('•');
    };
    rl.question(q, (x) => {
      r._writeToOutput = original;
      resolveP(x.trim());
    });
  });
}

const PROVIDER_LABEL: Record<ProviderId, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
  openrouter: 'OpenRouter',
  ollama: 'Ollama (local, free)',
};

async function pickModels(rl: Interface, t: ReturnType<typeof translator>, provider: ProviderId, models: ModelInfo[]): Promise<string[]> {
  let filter = '';
  for (;;) {
    const shown = models.filter((m) => !filter || `${m.id} ${m.name}`.toLowerCase().includes(filter)).slice(0, 30);
    console.log(dim(`\n  ${t('setup.cli.models', { provider: PROVIDER_LABEL[provider], n: models.length })}${filter ? ` · "${filter}"` : ''}`));
    shown.forEach((m, i) => {
      const price = m.price ? dim(` $${(m.price.input * 1e6).toFixed(2)}/$${(m.price.output * 1e6).toFixed(2)} per 1M`) : '';
      console.log(`   ${String(i + 1).padStart(2)}. ${m.id}${m.name !== m.id ? dim(` — ${m.name}`) : ''}${price}`);
    });
    const ans = await ask(rl, `  ${t('setup.cli.pickModels')} `);
    if (!ans) return [];
    if (/^[\d,\s]+$/.test(ans)) {
      const picks = ans
        .split(',')
        .map((x) => shown[Number(x.trim()) - 1])
        .filter(Boolean)
        .slice(0, 3)
        .map((m) => `${provider}:${m!.id}`);
      if (picks.length) return picks;
    } else filter = ans.toLowerCase();
  }
}

async function setup(a: Args): Promise<void> {
  banner();
  if (!process.stdin.isTTY) throw new Error('setup needs an interactive terminal. Use the browser wizard: run "agentstreet".');
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let lang = typeof a.lang === 'string' ? a.lang : detectLanguage();
  let t = translator(lang);
  try {
    console.log(`  ${bold(t('setup.cli.language'))}`);
    LANGUAGES.forEach((l, i) => console.log(`   ${i + 1}. ${l.name}${l.code === lang ? dim('  ←') : ''}`));
    const li = await ask(rl, `  ${t('setup.cli.enterKeeps')} `);
    if (li && LANGUAGES[Number(li) - 1]) lang = LANGUAGES[Number(li) - 1]!.code;
    t = translator(lang);

    const env = envKeysPresent();
    const ollama = await detectOllama();
    console.log(`\n  ${bold(t('setup.cli.detected'))}`);
    for (const p of PROVIDERS) {
      const found = p === 'ollama' ? !!ollama : env[p];
      console.log(`   ${found ? green('●') : dim('○')} ${PROVIDER_LABEL[p]}${found ? dim(p === 'ollama' ? `  ${t('setup.ollamaRunning', { n: ollama!.length })}` : `  ${t('setup.keyInEnv')}`) : ''}`);
    }

    console.log(`\n  ${bold(t('setup.cli.mode'))}`);
    console.log(`   1. ${t('setup.mode.llm')}  ${dim(t('setup.mode.llmHint'))}`);
    console.log(`   2. ${t('setup.mode.offline')}  ${dim(t('setup.mode.offlineHint'))}`);
    const mode = (await ask(rl, '  > ')) === '2' ? 'offline' : 'llm';
    if (mode === 'offline') {
      writeConfig({ mode: 'offline', models: [], language: lang, limits: DEFAULT_LIMITS, newsWriter: null });
      console.log(`\n  ${green('✓')} ${t('setup.cli.savedOffline')}\n  ${t('setup.cli.next')} ${bold('agentstreet')}\n`);
      return;
    }

    console.log(`\n  ${bold(t('setup.cli.providers'))}`);
    PROVIDERS.forEach((p, i) => console.log(`   ${i + 1}. ${PROVIDER_LABEL[p]}`));
    const which = (await ask(rl, `  ${t('setup.cli.pickProviders')} `))
      .split(/[,\s]+/)
      .map((x) => PROVIDERS[Number(x) - 1])
      .filter(Boolean) as ProviderId[];
    const chosen: string[] = [];
    const prices: Record<string, { input: number; output: number }> = {};
    for (const p of which) {
      let models: ModelInfo[] | null = null;
      if (p === 'ollama') {
        models = ollama;
        if (!models) {
          console.log(`  ${red('✗')} ${t('setup.ollamaMissing')}`);
          continue;
        }
      } else {
        for (let attempt = 0; attempt < 3 && !models; attempt++) {
          let key: string | undefined;
          if (env[p] && attempt === 0) {
            const use = await ask(rl, `  ${PROVIDER_LABEL[p]}: ${t('setup.cli.useEnvKey')} `);
            if (use.toLowerCase().startsWith('n')) key = await askSecret(rl, `  ${t('setup.cli.pasteKey', { provider: PROVIDER_LABEL[p] })} `);
          } else key = await askSecret(rl, `  ${t('setup.cli.pasteKey', { provider: PROVIDER_LABEL[p] })} `);
          process.stdout.write(dim(`  ${t('setup.validating')}… `));
          try {
            models = await listModels(p, key);
            console.log(green(`✓ ${t('setup.valid', { n: models.length })}`));
            if (key) saveKeys({ [p]: key });
          } catch (e) {
            console.log(red(`✗ ${redact(e instanceof Error ? e.message : String(e))}`));
          }
        }
      }
      if (!models) continue;
      const picks = await pickModels(rl, t, p, models);
      for (const m of picks) {
        chosen.push(m);
        const info = models.find((x) => `${p}:${x.id}` === m);
        if (info?.price) prices[m] = info.price;
      }
    }
    if (!chosen.length) {
      console.log(`\n  ${amber('!')} ${t('setup.cli.noneChosen')}`);
      writeConfig({ mode: 'offline', models: [], language: lang, limits: DEFAULT_LIMITS, newsWriter: null });
      return;
    }
    const usd = await ask(rl, `\n  ${t('setup.cli.budget', { usd: DEFAULT_LIMITS.totalUsd })} `);
    const limits = { ...DEFAULT_LIMITS, ...(usd && Number(usd) >= 0 ? { totalUsd: Number(usd) } : {}) };
    writeConfig({ mode: 'llm', models: chosen, prices, language: lang, limits, newsWriter: null });
    console.log(`\n  ${green('✓')} ${t('setup.cli.saved', { dir: configDir() })}`);
    for (const m of chosen) console.log(`     ${m}`);
    const test = await ask(rl, `\n  ${t('setup.cli.ping')} `);
    if (!test.toLowerCase().startsWith('n')) {
      for (const m of chosen) {
        const r = await pingModel(m);
        console.log(`   ${r.ok ? green('✓') : red('✗')} ${m} ${dim(r.ok ? `${r.ms} ms` : r.error ?? '')}`);
      }
    }
    console.log(`\n  ${t('setup.cli.next')} ${bold('agentstreet')}\n`);
  } finally {
    rl.close();
  }
}

/* ───────────────────────────── headless ───────────────────────────── */

async function run(a: Args): Promise<void> {
  banner();
  const ticks = Number(a.ticks ?? 0);
  if (!ticks) throw new Error('run needs --ticks N');
  const sim = new Simulation({ ...simConfig(a, a.models ? null : readConfig()), llmMode: 'blocking' });
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
      if (e.type === 'breaker' || e.type === 'bust' || e.type === 'crash' || e.type === 'llm') console.log(`  ${dim(d.frame.clock)}  ${e.type === 'bust' ? red(e.text) : amber(e.text)}`);
    }
    if (process.stdout.isTTY && i % 50 === 0) process.stdout.write(`\r  ${dim(`simulating ${d.frame.clock}  ${Math.round((i / ticks) * 100)}%`)}   `);
  }
  if (process.stdout.isTTY) process.stdout.write('\r' + ' '.repeat(50) + '\r');
  const last = rec.data.frames[rec.data.frames.length - 1]!;
  console.log(`\n  ${bold(String(ticks))} ticks in ${((Date.now() - t0) / 1000).toFixed(1)}s · ${rec.data.trades.length.toLocaleString('en-US')} trades · ${halts} halts · ${liq} liquidations · index ${last.index.toFixed(1)}`);
  printLeaderboard(rec);
  for (const u of sim.llmUsage())
    console.log(dim(`  ${u.team}: ${u.calls} calls, ${u.errors} errors, ${u.fallbacks} offline fallbacks, ${u.inputTokens + u.outputTokens} tokens${u.usd ? `, $${u.usd.toFixed(4)}` : ''}`));
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

async function highlights(a: Args): Promise<void> {
  const file = a._[1];
  if (!file) throw new Error('usage: agentstreet highlights <file>');
  const data = loadReplay(file);
  const list = findHighlights(data, Number(a.limit ?? 14));
  const clock = (t: number) => data.frames[Math.max(0, t - data.frames[0]!.t)]?.clock ?? `t${t}`;
  console.log(`\n  ${bold('HIGHLIGHTS')} ${dim(`${data.meta.scenario} · seed ${data.meta.seed}`)}\n`);
  for (const h of list) console.log(`  ${dim(clock(h.t))}  ${amber(h.kind.padEnd(8))} ${h.title}  ${dim(`?t=${h.t0 ?? h.t}`)}`);
  console.log(dim(`\n  Open a moment: agentstreet replay ${file}  then add ?t=<tick> to the URL\n`));
}

async function tournament(a: Args, focus: 'all' | 'strategies' = 'all'): Promise<void> {
  banner();
  const saved = readConfig();
  const cfg = simConfig(a, a.models ? null : saved);
  const all = scenarios().map((s) => s.id);
  const sc = typeof a.scenarios === 'string' ? (a.scenarios === 'all' ? all : a.scenarios.split(',')) : typeof a.scenario === 'string' ? [a.scenario] : ['default', 'flash-crash', 'meme-mania'];
  const seeds = range(a.seeds, focus === 'strategies' ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] : [1, 2, 3, 4, 5]);
  const ticks = Number(a.ticks ?? 390);
  if (cfg.models?.length) console.log(amber(`  ${cfg.models.length} LLM team(s): ${cfg.models.join(', ')} — budget caps apply across the whole tournament.`));
  const t0 = Date.now();
  const r = await runTournament({
    seeds,
    scenarios: sc,
    ticks,
    config: { ...cfg, scenario: undefined },
    onProgress: (done, total, label) => {
      if (process.stdout.isTTY) process.stdout.write(`\r  ${dim(`${done}/${total} ${label}`.padEnd(40))}`);
    },
  });
  if (process.stdout.isTTY) process.stdout.write('\r' + ' '.repeat(60) + '\r');
  const pct = (x: number) => (x >= 0 ? green : red)(`${x >= 0 ? '+' : ''}${x.toFixed(2)}%`.padStart(9));
  const plugins = new Set(personalities().map((p) => p.id).filter((id) => !['market-maker', 'value', 'momentum', 'panic', 'rumor', 'contrarian', 'retail', 'degen'].includes(id)));
  for (const [title, rows] of [
    ['MODEL LEAGUE', r.teams],
    ['STRATEGY LEAGUE', r.personalities],
  ] as const) {
    if (title === 'MODEL LEAGUE' && rows.length < 2) continue;
    console.log(`\n  ${bold(title)}  ${dim(`${r.runs.length} runs · mean return ±95% CI · wins · sharpe`)}`);
    rows.forEach((x, i) =>
      console.log(
        `  ${String(i + 1).padStart(2)}. ${(plugins.has(x.group) ? amber(x.group) : x.group).padEnd(plugins.has(x.group) && C ? 41 : 30)} ${pct(x.mean)} ${dim(`±${x.ci95.toFixed(2)}`.padEnd(8))} ${String(x.wins).padStart(3)}/${r.runs.length} ${x.avgSharpe.toFixed(2).padStart(7)}`,
      ),
    );
  }
  const outDir = String(a.out ?? 'reports');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const base = join(outDir, `tournament-${stamp}`);
  writeFileSync(`${base}.json`, JSON.stringify(r, null, 2));
  writeFileSync(`${base}.md`, tournamentMarkdown(r));
  writeFileSync(`${base}.html`, tournamentHtml(r));
  console.log(`\n  ${green('✓')} ${r.runs.length} runs in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${base}.{html,md,json}\n`);
}

function initStrategy(a: Args): void {
  const name = String(a._[1] ?? 'my-strategy').toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const file = resolve(`${name}.strategy.js`);
  if (existsSync(file)) throw new Error(`${file} already exists`);
  writeFileSync(
    file,
    `// AgentStreet strategy plugin: ${name}
// Run it:       agentstreet --plugin ${name}.strategy.js --scenario ${name}-arena
// Backtest it:  agentstreet backtest --plugin ${name}.strategy.js --seeds 1-20
//
// Prices are integer CENTS. Return orders; the exchange enforces margin,
// halts and fees. Use ctx.rng for randomness (never Math.random) so runs replay exactly.

/** @type {import('agentstreet').Personality} */
const strategy = {
  id: '${name}',
  label: '${name.replace(/(^|-)(\w)/g, (_m: string, _s: string, c: string) => ' ' + c.toUpperCase()).trim()}',
  // Second person: this doubles as the system prompt when an LLM plays this role.
  description: 'You buy stocks that fell sharply in the last half hour and sell them after a rebound.',
  every: 3,              // decide every 3 simulated minutes
  research: false,       // true = you also get a noisy estimate of hidden true value (m.fairEstimate)
  startInvested: 0.2,    // share of starting capital held as stock at the open
  capital: 20_000_000,   // $200,000 in cents
  traits: (rng) => ({ drop: rng.range(0.03, 0.06), take: rng.range(0.02, 0.04) }),

  /** @param {import('agentstreet').StrategyContext} ctx */
  strategy({ obs, mem, traits, rng }) {
    const orders = [];
    let thought;
    for (const m of obs.markets) {
      if (m.halted || m.closes.length < 31) continue;
      const change30 = m.last / m.closes[m.closes.length - 31] - 1;
      const pos = obs.positions[m.symbol] ?? 0;
      if (pos === 0 && change30 < -traits.drop) {
        const qty = Math.floor((obs.buyingPower * 0.25) / m.last);
        if (qty > 0) {
          orders.push({ symbol: m.symbol, side: 'buy', type: 'limit', qty, price: Math.round(m.last * 1.002) });
          mem[m.symbol] = m.last;
          thought = \`\${m.symbol} down \${Math.round(-change30 * 100)}% in 30 min. Catching the knife.\`;
        }
      } else if (pos > 0 && m.last / (mem[m.symbol] ?? m.last) - 1 > traits.take) {
        orders.push({ symbol: m.symbol, side: 'sell', type: 'market', qty: pos });
        thought = rng.chance(0.5) ? \`Took profit on \${m.symbol}.\` : undefined;
      }
    }
    return { orders, thought };
  },
};

/** A scenario to show it off: the default market plus six of your traders. */
const arena = {
  id: '${name}-arena',
  name: '${name} arena',
  description: 'The default market with six ${name} traders added.',
  config: { mix: { 'market-maker': 4, value: 8, momentum: 8, panic: 6, rumor: 6, contrarian: 5, retail: 22, degen: 6, '${name}': 6 } },
};

export default { personalities: [strategy], scenarios: [arena] };
`,
  );
  console.log(`${green('✓')} created ${file}\n  try it:    agentstreet --plugin ${name}.strategy.js --scenario ${name}-arena\n  backtest:  agentstreet backtest --plugin ${name}.strategy.js --scenario ${name}-arena`);
}

async function models(a: Args): Promise<void> {
  const p = String(a._[1] ?? '') as ProviderId;
  if (!PROVIDERS.includes(p)) throw new Error(`usage: agentstreet models <${PROVIDERS.join('|')}>`);
  const list = await listModels(p);
  for (const m of list) console.log(`${p}:${m.id}${m.price ? dim(`  $${(m.price.input * 1e6).toFixed(2)}/$${(m.price.output * 1e6).toFixed(2)} per 1M tokens`) : ''}`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const loaded = loadEnv();
  const a = parse(argv);
  if (a.help || a._[0] === 'help') return void console.log(HELP);
  if (a.version || a._[0] === 'version') return void console.log(VERSION);
  if (a.plugin) await loadPlugins(a.plugin as string[]);
  if (loaded.length && process.env.AGENTSTREET_DEBUG) console.log(dim(`  loaded ${loaded.length} key(s) from ${configDir()}`));
  const cmd = a._[0] ?? 'live';
  switch (cmd) {
    case 'live':
      return live(a);
    case 'demo':
      return live({ ...a, offline: true });
    case 'setup':
      return a.web ? live(a, true) : setup(a);
    case 'run':
      return run(a);
    case 'replay':
      return replay(a);
    case 'verify':
      return verify(a);
    case 'highlights':
      return highlights(a);
    case 'tournament':
      return tournament(a);
    case 'backtest':
      if (!a.plugin) throw new Error('backtest needs --plugin <file.js>');
      return tournament(a, 'strategies');
    case 'init-strategy':
      return initStrategy(a);
    case 'models':
      return models(a);
    case 'scenarios':
      for (const s of scenarios()) console.log(`  ${amber(s.id.padEnd(16))} ${bold(s.name)}\n  ${' '.repeat(16)} ${dim(s.description)}\n`);
      return;
    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

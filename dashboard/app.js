// AgentStreet terminal v0.1.1: live stream + time travel over the same recorded data,
// i18n, onboarding, meaningful motion, highlights, trader X-ray, share cards, clip export.
import { drawCandles, drawDepth, drawGauge, drawSpark, drawLines, drawScrub, compact, css } from './charts.js';
import { t, setLanguage, pick, apply as applyI18n, LANGUAGES, lang } from './i18n.js';
import * as F from './features.js';

const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const usd = (cents, d = 2) => (cents / 100).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
export const pct = (x, d = 2) => `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`;
export const arrow = (x) => (x > 0 ? '▲' : x < 0 ? '▼' : '■');
export const cls = (x) => (x > 0 ? 'up' : x < 0 ? 'down' : 'muted');
export const money = (d) => {
  const a = Math.abs(d);
  const s = a >= 1e6 ? `$${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `$${(a / 1e3).toFixed(1)}k` : `$${a.toFixed(0)}`;
  return d < 0 ? `-${s}` : s;
};
export const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;

// Categorical slots (validated dark-mode order). Personalities take slots in registration order.
export const SLOTS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
export const OTHER = '#898781';
const TFS = [1, 5, 15, 30];
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');

export const S = {
  data: null,
  status: { mode: 'live', phase: 'live', paused: false, speed: 1, speeds: [1] },
  personalities: [],
  scenarios: [],
  llm: [],
  limits: null,
  config: null,
  highlights: [],
  cursor: null,
  sel: 0,
  tf: 5,
  showFair: true,
  tapeScope: 'sel',
  lbTab: 'personality',
  feedTab: 'chatter',
  playing: false,
  playSpeed: 4,
  hover: { candles: null, depth: null, equity: null },
  seenAlerts: 0,
  lastSlow: -Infinity,
  dirty: true,
  colorOf: {},
  motion: true,
  // animation state
  anim: { price: null, gauge: null, depth: null, depthKey: '' },
  lastPx: [],
  lastTapeTop: null,
  breakerUntil: 0,
};

/* ───────────────────────────── data access ───────────────────────────── */

export const frames = () => S.data.frames;
export const firstT = () => frames()[0]?.t ?? 1;
export const lastT = () => frames()[frames().length - 1]?.t ?? 1;
export const T = () => (S.cursor === null ? lastT() : S.cursor);
export const frameAt = (t) => {
  const f = frames();
  return f[Math.max(0, Math.min(f.length - 1, t - firstT()))];
};
export function upper(arr, t, key) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (key(arr[m]) <= t) lo = m + 1;
    else hi = m;
  }
  return lo;
}
const until = (arr, key) => arr.slice(0, upper(arr, T(), key));
const ticksPerDay = () => S.data.config.ticksPerDay || 390;
export const dayStart = (t) => Math.floor((t - 1) / ticksPerDay()) * ticksPerDay() + 1;
export function dayOpen(si, t) {
  const ds = dayStart(t);
  if (ds - 1 >= firstT()) return frameAt(ds - 1).sym[si][0];
  return ds === 1 ? S.data.symbols[si].price : frames()[0].sym[si][0];
}
function dayOpenIndex(t) {
  const ds = dayStart(t);
  return ds - 1 >= firstT() ? frameAt(ds - 1).index : ds === 1 ? 1000 : frames()[0].index;
}
export const sym = (i = S.sel) => S.data.symbols[i];
export const agent = (i) => S.data.agents[i];
export const pLabel = (id) => S.personalities.find((p) => p.id === id)?.label ?? id;
export const fgLabel = (v) => t(`fg.${Math.min(4, Math.floor(v / 20))}`);

/* ───────────────────────────── boot ───────────────────────────── */

async function loadState() {
  const st = await (await fetch('api/state')).json();
  S.status = st.status;
  S.personalities = st.personalities;
  S.scenarios = st.scenarios;
  S.llm = st.llm;
  S.limits = st.limits;
  S.config = st.config;
  S.highlights = st.highlights ?? [];
  S.data = st.data;
  return st;
}

async function boot() {
  const st = await loadState();
  await setLanguage(pick(st.config?.language));
  buildLangSelect();
  try {
    S.motion = !REDUCED.matches && localStorage.getItem('as-motion') !== '0';
    if (localStorage.getItem('as-cvd') === '1') setCvd(true);
    const tf = Number(localStorage.getItem('as-tf'));
    if (TFS.includes(tf)) S.tf = tf;
  } catch {}
  setMotion(S.motion, false);
  REDUCED.addEventListener?.('change', () => setMotion(!REDUCED.matches, false));
  $('btn-setup').onclick = () => F.openOnboarding(api, { reconfigure: true });
  if (S.status.phase === 'setup') {
    $('app').dataset.phase = 'setup';
    renderStatus();
    F.openOnboarding(api, { reconfigure: false });
    connect();
    return;
  }
  start();
}

/** Called once a market exists (immediately, or after onboarding). */
async function start() {
  if (!S.data) await loadState();
  $('app').dataset.phase = S.status.phase;
  S.personalities.forEach((p, i) => (S.colorOf[p.id] = SLOTS[i] ?? OTHER));
  [...new Set(S.data.agents.map((a) => a.team))].forEach((tm, i) => (S.colorOf['team:' + tm] = SLOTS[i] ?? OTHER));
  S.seenAlerts = S.data.events.length;
  if (S.status.mode === 'replay') S.cursor = Math.min(lastT(), firstT() + 200);
  const q = new URLSearchParams(location.search);
  if (q.get('t')) S.cursor = Math.max(firstT(), Math.min(lastT(), Number(q.get('t'))));
  if (q.get('sym')) {
    const i = S.data.symbols.findIndex((s) => s.symbol === q.get('sym')?.toUpperCase());
    if (i >= 0) S.sel = i;
  }
  if (TFS.includes(Number(q.get('tf')))) S.tf = Number(q.get('tf'));
  if (['personality', 'team', 'agent'].includes(q.get('lb'))) S.lbTab = q.get('lb');
  if (['chatter', 'alerts'].includes(q.get('feed'))) S.feedTab = q.get('feed');
  buildStatic();
  segOn('lb-tabs', S.lbTab);
  segOn('feed-tabs', S.feedTab);
  if (q.get('xray')) F.openXray(api, Number(q.get('xray')));
  if (S.status.mode === 'live' && !sse) connect();
  requestAnimationFrame(frameLoop);
}

let sse = null;
let syncing = false;
let receivedDuringSync = [];

async function catchUp() {
  if (syncing) return;
  syncing = true;
  try {
    await loadState();
    if (S.cursor !== null) S.cursor = Math.max(firstT(), Math.min(lastT(), S.cursor));
    for (const delta of receivedDuringSync) {
      if (delta.frame.t > S.data.meta.ticks) ingest(delta);
    }
    S.dirty = true;
  } catch {
    $('status-text').textContent = t('status.reconnecting');
  } finally {
    syncing = false;
    receivedDuringSync = [];
  }
}

function connect() {
  sse = new EventSource('api/stream');
  sse.addEventListener('ticks', (e) => {
    if (!S.data) return;
    const deltas = JSON.parse(e.data);
    if (syncing || deltas[0]?.frame.t > S.data.meta.ticks + 1) {
      receivedDuringSync.push(...deltas);
      void catchUp();
      return;
    }
    for (const d of deltas) if (d.frame.t > S.data.meta.ticks) ingest(d);
    S.dirty = true;
  });
  sse.addEventListener('highlights', (e) => {
    S.highlights = JSON.parse(e.data);
    renderHlCount();
  });
  sse.addEventListener('status', async (e) => {
    const prev = S.status.phase;
    S.status = JSON.parse(e.data);
    if (prev === 'setup' && S.status.phase === 'live') {
      F.closeOnboarding();
      S.data = null;
      await start();
    } else if (S.data && S.status.tick > S.data.meta.ticks) {
      void catchUp();
    }
    renderStatus();
  });
  sse.onerror = () => {
    $('status').className = 'status';
    $('status-text').textContent = t('status.reconnecting');
  };
}

function ingest(d) {
  const r = S.data;
  r.frames.push(d.frame);
  for (const x of d.trades) r.trades.push(x);
  for (const x of d.news) r.news.push(x);
  for (const x of d.thoughts) r.thoughts.push(x);
  for (const x of d.events) {
    r.events.push(x);
    if (S.cursor === null) marketEvent(x);
  }
  if (d.equity) r.equity.push(d.equity);
  r.meta.ticks = d.frame.t;
  if (r.frames.length > 22000) {
    const cut = r.frames[r.frames.length - 20000].t;
    r.frames.splice(0, r.frames.length - 20000);
    r.meta.firstTick = cut;
    r.meta.truncated = true;
    const drop = (arr, key) => arr.splice(0, upper(arr, cut - 1, key));
    drop(r.trades, (x) => x[0]);
    drop(r.news, (x) => x.t);
    drop(r.thoughts, (x) => x.t);
    drop(r.events, (x) => x.t);
    drop(r.equity, (x) => x.t);
  }
}

/* ───────────────────────────── market-event moments ───────────────────────────── */

let breakingTimer = null;
function marketEvent(e) {
  if (e.type === 'breaker') {
    const m = e.text.match(/L(\d)/);
    $('breaker-text').textContent = `${t('alert.breaker')}${m ? ` · L${m[1]}` : ''}`;
    $('breaker').hidden = false;
    S.breakerUntil = e.t + (m && m[1] === '3' ? 60 : 15);
    shake(true);
  } else if (e.type === 'crash' || e.type === 'bust') {
    shake(e.type === 'crash');
    banner(e);
  } else if (e.type === 'llm') banner(e);
}
function banner(e) {
  const el = $('breaking');
  el.innerHTML = `${icon(e.type === 'bust' ? 'stop' : e.type === 'crash' ? 'bolt' : 'alert')}<span>${esc(e.text)}</span>`;
  el.className = 'breaking' + (e.type === 'crash' || e.type === 'llm' ? ' warn' : '');
  el.hidden = false;
  clearTimeout(breakingTimer);
  breakingTimer = setTimeout(() => (el.hidden = true), 4200);
}
function shake(withFlash) {
  if (!S.motion) return;
  const app = $('app');
  app.classList.remove('shake');
  void app.offsetWidth;
  app.classList.add('shake');
  if (withFlash) {
    const f = $('flash');
    f.classList.remove('on');
    void f.offsetWidth;
    f.classList.add('on');
  }
}

export function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 2400);
}

/* ───────────────────────────── static UI ───────────────────────────── */

function buildLangSelect() {
  const sel = $('lang-select');
  sel.innerHTML = LANGUAGES.map(([c, n]) => `<option value="${c}">${n}</option>`).join('');
  sel.value = lang;
  sel.onchange = async () => {
    await setLanguage(sel.value, true);
    S.lastSlow = -Infinity;
    if (S.data) {
      buildControls();
      buildPlaySpeed();
    }
    F.relocalize(api);
    S.dirty = true;
    renderStatus();
  };
}

let staticBuilt = false;
function buildStatic() {
  if (staticBuilt) return;
  staticBuilt = true;
  $('speed').innerHTML = S.status.speeds.map((s) => `<button data-v="${s}">${s}×</button>`).join('');
  $('speed').onclick = (e) => {
    const b = e.target.closest('button');
    if (b) control({ action: 'speed', value: Number(b.dataset.v) });
  };
  $('btn-pause').onclick = togglePause;
  $('btn-cvd').onclick = () => setCvd(document.documentElement.dataset.cvd !== '1');
  $('btn-motion').onclick = () => setMotion(!S.motion, true);
  $('btn-highlights').onclick = () => F.toggleHighlights(api);
  $('btn-export').onclick = () => F.openExport(api);
  $('tf').innerHTML = TFS.map((x) => `<button data-v="${x}" class="${x === S.tf ? 'on' : ''}">${x}m</button>`).join('');
  $('tf').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    S.tf = Number(b.dataset.v);
    try { localStorage.setItem('as-tf', String(S.tf)); } catch {}
    segOn('tf', b.dataset.v);
    S.anim.price = null;
    S.dirty = true;
  };
  $('fair-toggle').onchange = (e) => {
    S.showFair = e.target.checked;
    S.dirty = true;
  };
  tabs('tape-scope', (v) => (S.tapeScope = v));
  tabs('lb-tabs', (v) => (S.lbTab = v));
  tabs('feed-tabs', (v) => {
    S.feedTab = v;
    if (v === 'alerts') S.seenAlerts = S.data.events.length;
  });
  $('watchlist').innerHTML = S.data.symbols
    .map(
      (s, i) => `<div class="wl-row" role="option" tabindex="0" data-i="${i}" title="${esc(s.name)} — ${esc(s.blurb)}">
        <div><div class="wl-sym">${s.symbol}<span class="badge halt" hidden>${esc(t('watch.halt'))}</span></div><div class="wl-name">${esc(s.name)}</div></div>
        <div><div class="wl-px"></div><div class="wl-chg"></div></div>
        <canvas class="wl-spark"></canvas>
        <div class="wl-fair"></div>
      </div>`,
    )
    .join('');
  $('watchlist').onclick = (e) => {
    const r = e.target.closest('.wl-row');
    if (r) select(Number(r.dataset.i));
  };
  $('watchlist').onkeydown = (e) => {
    const r = e.target.closest('.wl-row');
    if (r && (e.key === 'Enter' || e.key === ' ')) select(Number(r.dataset.i));
  };
  buildPlaySpeed();
  $('scrub').oninput = (e) => {
    const v = Number(e.target.value);
    S.cursor = S.status.mode === 'live' && v >= lastT() ? null : v;
    S.anim.price = null;
    S.dirty = true;
  };
  $('btn-play').onclick = () => {
    if (S.cursor === null) S.cursor = Math.max(firstT(), lastT() - 300);
    if (S.cursor >= lastT() && S.status.mode === 'replay') S.cursor = firstT();
    S.playing = !S.playing;
    S.dirty = true;
  };
  $('btn-live').onclick = goLive;
  // Trader X-ray from the leaderboard or the chatter feed.
  $('lb-table').addEventListener('click', (e) => {
    const r = e.target.closest('[data-agent]');
    if (r) F.openXray(api, Number(r.dataset.agent));
  });
  $('feed').addEventListener('click', (e) => {
    const r = e.target.closest('[data-agent]');
    if (r) F.openXray(api, Number(r.dataset.agent));
  });
  for (const b of document.querySelectorAll('[data-close]')) b.onclick = () => ($(b.dataset.close).hidden = true);
  buildControls();
  hoverable('candles', 'candles');
  hoverable('depth', 'depth');
  hoverable('equity', 'equity');
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', () => (S.dirty = true));
  renderHlCount();
  renderStatus();
}

function buildPlaySpeed() {
  $('play-speed').innerHTML = [1, 4, 16, 60].map((s) => `<button data-v="${s}" class="${s === S.playSpeed ? 'on' : ''}">${s}×</button>`).join('');
  if (!buildPlaySpeed.bound) {
    buildPlaySpeed.bound = true;
    tabs('play-speed', (v) => (S.playSpeed = Number(v)));
  }
}

export function goLive() {
  S.cursor = null;
  S.playing = false;
  S.anim.price = null;
  S.dirty = true;
}

/** Jump the time cursor (used by highlights, X-ray, deep links). */
export function jump(t0, autoplay = true) {
  S.cursor = Math.max(firstT(), Math.min(lastT(), t0));
  S.playing = autoplay;
  S.anim.price = null;
  S.dirty = true;
}

function tabs(id, fn) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    segOn(id, b.dataset.v);
    fn(b.dataset.v);
    S.dirty = true;
    S.lastSlow = -Infinity;
  });
}
export function segOn(id, v) {
  for (const b of $(id).querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === String(v));
}
function hoverable(id, key) {
  const c = $(id);
  c.addEventListener('mousemove', (e) => {
    const r = c.getBoundingClientRect();
    S.hover[key] = { x: e.clientX - r.left, y: e.clientY - r.top, cx: e.clientX, cy: e.clientY };
    S.dirty = true;
  });
  c.addEventListener('mouseleave', () => {
    S.hover[key] = null;
    hideTip();
    S.dirty = true;
  });
}
function setCvd(on) {
  document.documentElement.dataset.cvd = on ? '1' : '0';
  $('btn-cvd').setAttribute('aria-pressed', String(on));
  try { localStorage.setItem('as-cvd', on ? '1' : '0'); } catch {}
  S.dirty = true;
}
function setMotion(on, persist) {
  S.motion = on;
  document.documentElement.dataset.motion = on ? '1' : '0';
  $('btn-motion').setAttribute('aria-pressed', String(on));
  if (persist) {
    try { localStorage.setItem('as-motion', on ? '1' : '0'); } catch {}
  }
}
function select(i) {
  S.sel = i;
  S.anim.price = null;
  S.anim.depth = null;
  S.dirty = true;
  S.lastSlow = -Infinity;
}
function onKey(e) {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || document.querySelector('dialog[open]')) return;
  if (e.key === 'Escape') {
    $('xray').hidden = true;
    $('hl-pop').hidden = true;
  } else if (e.key >= '1' && e.key <= '9' && Number(e.key) <= S.data.symbols.length) select(Number(e.key) - 1);
  else if (e.key === ' ') {
    e.preventDefault();
    if (S.status.mode === 'live') togglePause();
    else $('btn-play').click();
  } else if (e.key === 'ArrowLeft') {
    S.cursor = Math.max(firstT(), T() - (e.shiftKey ? 30 : 1));
    S.dirty = true;
  } else if (e.key === 'ArrowRight') {
    const n = T() + (e.shiftKey ? 30 : 1);
    S.cursor = n >= lastT() && S.status.mode === 'live' ? null : Math.min(lastT(), n);
    S.dirty = true;
  } else if (e.key === 'h') F.toggleHighlights(api);
}

export async function control(body) {
  try {
    const r = await fetch('api/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 429) return toast(t('toast.slowDown'));
    if (!r.ok) return toast(t('toast.commandFailed'));
    S.status = await r.json();
    renderStatus();
  } catch {
    toast(t('toast.commandFailed'));
  }
}
function togglePause() {
  if (S.status.mode !== 'live') return;
  control({ action: S.status.paused ? 'resume' : 'pause' });
}
export const cmd = (c) => control({ action: 'command', cmd: c });

function buildControls() {
  const el = $('controls');
  if (S.status.mode !== 'live') {
    $('ctrl-title').textContent = t('panel.replay');
    const m = S.data.meta;
    const sc = S.scenarios.find((s) => s.id === m.scenario);
    el.innerHTML = `<div class="replay-info">
      <b>${esc(sc?.name ?? m.scenario)}</b><br>${esc(sc?.description ?? '')}<br><br>
      seed <b>${m.seed}</b> · ${m.ticks.toLocaleString('en-US')} ticks<br>
      hash <b>${esc(m.hash)}</b><br>${esc(m.app)}<br><br>
      <span class="muted">${esc(t('ctrl.verifyHint'))}<br><code>agentstreet verify &lt;file&gt;</code></span></div>`;
    return;
  }
  $('ctrl-title').textContent = t('panel.control');
  el.innerHTML = `
    <div class="ctrl-label">${esc(t('ctrl.news'))} · <span id="ctrl-sym">${sym().symbol}</span></div>
    <div class="ctrl-row">
      <button class="btn good" data-c="good">▲ ${esc(t('ctrl.good'))}</button>
      <button class="btn bad" data-c="bad">▼ ${esc(t('ctrl.bad'))}</button>
      <button class="btn" data-c="rumor">${esc(t('ctrl.rumor'))}</button>
      <button class="btn" data-c="pump">${esc(t('ctrl.pump'))}</button>
    </div>
    <div class="ctrl-input"><input type="text" id="ctrl-headline" maxlength="140" placeholder="${esc(t('ctrl.headlinePlaceholder'))}" aria-label="${esc(t('ctrl.headlinePlaceholder'))}" /><button class="btn" data-c="publish">${esc(t('ctrl.publish'))}</button></div>
    <button class="btn" data-c="editor">${icon('pen')}${esc(t('ctrl.editor'))}</button>
    <div class="ctrl-label">${esc(t('ctrl.market'))}</div>
    <div class="ctrl-row">
      <button class="btn danger" data-c="crash">${icon('bolt')}${esc(t('ctrl.crash'))}</button>
      <button class="btn" data-c="halt">${icon('pause')}${esc(t('ctrl.halt'))}</button>
      <button class="btn" data-c="hike">${esc(t('ctrl.hike'))}</button>
      <button class="btn" data-c="cut">${esc(t('ctrl.cut'))}</button>
    </div>
    <div class="ctrl-label">${esc(t('ctrl.scenario'))}</div>
    <div class="replay-info" id="ctrl-scenario"></div>`;
  el.onclick = (e) => {
    const b = e.target.closest('button[data-c]');
    if (!b) return;
    const s = sym().symbol;
    const c = b.dataset.c;
    if (c === 'good') cmd({ type: 'news', symbol: s, tone: 'positive', kind: 'breaking' });
    if (c === 'bad') cmd({ type: 'news', symbol: s, tone: 'negative', kind: 'breaking' });
    if (c === 'rumor') cmd({ type: 'news', symbol: s, tone: 'positive', kind: 'rumor' });
    if (c === 'pump') cmd({ type: 'pump', symbol: s });
    if (c === 'crash') cmd({ type: 'crash', symbol: s, size: 1 });
    if (c === 'halt') cmd({ type: 'halt', symbol: s, ticks: 15 });
    if (c === 'hike') cmd({ type: 'rate', bps: 50 });
    if (c === 'cut') cmd({ type: 'rate', bps: -50 });
    if (c === 'editor') F.openEditor(api);
    if (c === 'publish') {
      const inp = $('ctrl-headline');
      const text = inp.value.trim();
      if (text) {
        const neg = /\b(crash|fraud|plunge|scandal|recall|probe|bankrupt|miss|cut|lawsuit|dump|collapse|fake)\b/i.test(text);
        cmd({ type: 'news', symbol: s, tone: neg ? 'negative' : 'positive', kind: 'breaking', headline: text });
        inp.value = '';
      }
    }
  };
  $('ctrl-headline').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el.querySelector('[data-c="publish"]').click();
  });
  const sc = S.scenarios.find((x) => x.id === S.data.meta.scenario);
  $('ctrl-scenario').innerHTML = `<b>${esc(sc?.name ?? '')}</b> — ${esc(sc?.description ?? '')}`;
}

/* ───────────────────────────── render loop ───────────────────────────── */

let lastPlay = 0;
let lastFrameTs = 0;
function frameLoop(now) {
  const dt = Math.min(100, now - (lastFrameTs || now));
  lastFrameTs = now;
  if (S.playing && S.cursor !== null) {
    const adv = Math.floor(((now - (lastPlay || now)) / 1000) * S.playSpeed * 4);
    if (adv >= 1) {
      lastPlay = now;
      S.cursor = Math.min(lastT(), S.cursor + adv);
      if (S.cursor >= lastT()) {
        S.playing = false;
        if (S.status.mode === 'live') S.cursor = null;
      }
      S.dirty = true;
    }
  } else lastPlay = now;
  const animating = S.motion && tickAnimations(dt);
  if ((S.dirty || animating) && S.data?.frames.length) {
    const full = S.dirty;
    S.dirty = false;
    try {
      render(now, full);
    } catch (e) {
      console.error(e);
    }
  }
  requestAnimationFrame(frameLoop);
}

/** Exponential approach toward targets; returns true while anything is still moving. */
function tickAnimations(dt) {
  const a = S.anim;
  let moving = false;
  const k = 1 - Math.exp(-dt / 90);
  if (a.price && Math.abs(a.price.v - a.price.target) > 0.0005) {
    a.price.v += (a.price.target - a.price.v) * k;
    moving = true;
  }
  if (a.gauge && Math.abs(a.gauge.v - a.gauge.target) > 0.05) {
    a.gauge.v += (a.gauge.target - a.gauge.v) * (1 - Math.exp(-dt / 220));
    moving = true;
  }
  if (a.depth && a.depth.p < 1) {
    a.depth.p = Math.min(1, a.depth.p + dt / 260);
    moving = true;
  }
  return moving;
}

function render(now, full) {
  const f = frameAt(T());
  renderChart(f);
  renderDepth(f);
  renderGauge(f);
  if (!full) return;
  renderStatus();
  renderTop(f);
  renderWatch(f);
  renderBook(f);
  renderStats(f);
  renderTape();
  renderScrub(f);
  renderBreaker(f);
  if (now - S.lastSlow > 330) {
    S.lastSlow = now;
    renderTicker();
    renderNews();
    renderFeed();
    renderLeaderboard();
    F.refreshXray(api);
  } else {
    clearTimeout(slowTimer);
    slowTimer = setTimeout(() => (S.dirty = true), 340);
  }
}
let slowTimer = null;

function renderStatus() {
  const st = $('status');
  let mode = 'live', label = t('status.live');
  if (S.status.phase === 'setup') (mode = 'paused'), (label = t('status.setup'));
  else if (S.status.mode === 'replay') (mode = 'replay'), (label = t('status.replay'));
  else if (S.cursor !== null) (mode = 'travel'), (label = t('status.travel'));
  else if (S.status.paused) (mode = 'paused'), (label = t('status.paused'));
  st.className = 'status ' + mode;
  $('status-text').textContent = label;
  const live = S.status.mode === 'live' && S.status.phase !== 'setup';
  segOn('speed', S.status.speed);
  $('speed').style.display = live ? '' : 'none';
  $('btn-pause').style.display = live ? '' : 'none';
  $('btn-pause').innerHTML = icon(S.status.paused ? 'play' : 'pause');
  $('btn-pause').title = t(S.status.paused ? 'btn.resume' : 'btn.pause');
  $('btn-live').style.display = live ? '' : 'none';
  $('btn-live').classList.toggle('off', S.cursor !== null);
  $('btn-play').innerHTML = icon(S.playing ? 'pause' : 'play');
  $('btn-setup').style.display = S.status.mode === 'live' ? '' : 'none';
}

function kpi(k, v, c = '', opt = false, title = '') {
  return `<div class="kpi${opt ? ' opt' : ''}" title="${esc(title)}"><span class="k">${esc(k)}</span><span class="v ${c}">${v}</span></div>`;
}

function renderTop(f) {
  $('clock').textContent = f.clock;
  const ic = (f.index / dayOpenIndex(f.t) - 1) * 100;
  const spend = S.llm.reduce((a, u) => a + (u.usd || 0), 0);
  const tokens = S.llm.reduce((a, u) => a + u.inputTokens + u.outputTokens, 0);
  $('top-kpis').innerHTML =
    kpi(t('kpi.index'), `${f.index.toFixed(2)} <span class="${cls(ic)}">${arrow(ic)} ${pct(ic)}</span>`, '', false, t('kpi.indexHint')) +
    kpi(t('kpi.rate'), `${(f.rate * 100).toFixed(2)}%`, '', false, t('kpi.rateHint')) +
    kpi(t('kpi.fearGreed'), `${f.fearGreed} ${esc(fgLabel(f.fearGreed).toUpperCase())}`) +
    kpi(t('kpi.volx'), f.vol.toFixed(1), '', true, t('kpi.volxHint')) +
    kpi(t('kpi.marginDebt'), money(f.marginDebt), '', true) +
    (S.llm.length ? kpi(t('kpi.llmSpend'), `$${spend.toFixed(spend < 1 ? 3 : 2)} · ${compact(tokens)}`, '', true) : '');
}

function flash(el, dir) {
  if (!S.motion || !dir) return;
  el.classList.remove('flash-up', 'flash-down');
  void el.offsetWidth;
  el.classList.add(dir > 0 ? 'flash-up' : 'flash-down');
}

function renderWatch(f) {
  const rows = $('watchlist').children;
  S.data.symbols.forEach((s, i) => {
    const row = rows[i];
    const [last, , , , , , fair, halted] = f.sym[i];
    const open = dayOpen(i, f.t);
    const chg = (last / open - 1) * 100;
    row.classList.toggle('sel', i === S.sel);
    row.setAttribute('aria-selected', String(i === S.sel));
    const px = row.querySelector('.wl-px');
    px.textContent = usd(last);
    if (S.cursor === null && S.lastPx[i] !== undefined && S.lastPx[i] !== last) flash(px, last - S.lastPx[i]);
    S.lastPx[i] = last;
    const c = row.querySelector('.wl-chg');
    c.className = 'wl-chg ' + cls(chg);
    c.textContent = `${arrow(chg)} ${pct(chg)}`;
    row.querySelector('.badge.halt').hidden = !halted;
    const gap = (last / fair - 1) * 100;
    row.querySelector('.wl-fair').innerHTML = S.showFair
      ? `${esc(t('watch.vsTrue'))} <span class="${Math.abs(gap) > 10 ? (gap > 0 ? 'down' : 'up') : 'muted'}">${pct(gap, 1)}</span>${Math.abs(gap) > 15 ? ` · ${esc(t(gap > 0 ? 'watch.bubble' : 'watch.bargain'))}` : ''}`
      : '';
    const t0 = Math.max(firstT(), f.t - 180);
    const vals = [];
    for (let tt = t0; tt <= f.t; tt += 2) vals.push(frameAt(tt).sym[i][0]);
    drawSpark(row.querySelector('.wl-spark'), vals, chg >= 0 ? css('--up') : css('--down'), open);
  });
}

export function buildCandles(si, tEnd, tf, n) {
  const kEnd = Math.floor((tEnd - 1) / tf);
  const kStart = Math.max(Math.floor((firstT() - 1) / tf), kEnd - n + 1);
  const out = [];
  for (let k = kStart; k <= kEnd; k++) {
    const a = Math.max(firstT(), k * tf + 1);
    const b = Math.min(tEnd, (k + 1) * tf);
    if (a > b) continue;
    const prev = a - 1 >= firstT() ? frameAt(a - 1).sym[si][0] : frameAt(a).sym[si][0];
    let h = prev, l = prev, v = 0, halted = 0, c = prev;
    for (let tt = a; tt <= b; tt++) {
      const s = frameAt(tt).sym[si];
      h = Math.max(h, s[3], s[0]);
      l = Math.min(l, s[4], s[0]);
      v += s[5];
      halted |= s[7];
      c = s[0];
    }
    out.push({ k, t0: a, t1: b, o: prev / 100, h: h / 100, l: l / 100, c: c / 100, v, fair: frameAt(b).sym[si][6] / 100, halted, clock: frameAt(a).clock });
  }
  return out;
}

export function newsMarkers(si, tStart, tEnd, tf, k0) {
  const out = [];
  const s = S.data.symbols[si];
  for (let i = upper(S.data.news, tStart - 1, (x) => x.t); i < S.data.news.length; i++) {
    const nw = S.data.news[i];
    if (nw.t > tEnd) break;
    if (nw.symbol !== s.symbol) continue;
    out.push({ i: Math.floor((nw.t - 1) / tf) - k0, up: nw.sentiment >= 0, headline: nw.headline, clock: frameAt(nw.t).clock });
  }
  return out;
}

function renderChart(f) {
  const s = sym();
  const [last, , , , , , fair, halted] = f.sym[S.sel];
  const open = dayOpen(S.sel, f.t);
  const chg = (last / open - 1) * 100;
  let hi = 0, lo = Infinity;
  for (let tt = Math.max(firstT(), dayStart(f.t)); tt <= f.t; tt++) {
    const x = frameAt(tt).sym[S.sel];
    hi = Math.max(hi, x[3]);
    lo = Math.min(lo, x[4]);
  }
  const head = `<span class="t">${s.symbol}</span><span class="n">${esc(s.name)} · ${esc(s.sector)}</span>
    <span class="p">$${usd(last)}</span><span class="${cls(chg)}">${arrow(chg)} ${pct(chg)}</span>
    <span class="ohl">${esc(t('chart.open'))} ${usd(open)} ${esc(t('chart.high'))} ${usd(hi)} ${esc(t('chart.low'))} ${usd(lo)}${S.showFair ? ` · <span style="color:var(--fair)">${esc(t('chart.trueValue'))} ${usd(fair)}</span>` : ''}</span>`;
  if ($('sym-head').dataset.k !== head) {
    $('sym-head').dataset.k = head;
    $('sym-head').innerHTML = head;
  }
  const stamp = $('halt-stamp');
  if (!!halted !== !stamp.hidden) {
    stamp.hidden = !halted;
    stamp.textContent = t('chart.halted');
  }
  const canvas = $('candles');
  const n = Math.max(20, Math.floor(canvas.clientWidth / 9));
  const candles = buildCandles(S.sel, f.t, S.tf, n);
  // Candle building: the forming candle's close glides to the new print.
  const lastC = candles[candles.length - 1];
  if (lastC) {
    const a = S.anim;
    if (!S.motion || !a.price || a.price.key !== `${S.sel}:${S.tf}`) a.price = { key: `${S.sel}:${S.tf}`, v: lastC.c, target: lastC.c };
    a.price.target = lastC.c;
    const v = a.price.v;
    lastC.c = v;
    lastC.h = Math.max(lastC.h, v);
    lastC.l = Math.min(lastC.l, v);
  }
  const k0 = candles[0]?.k ?? 0;
  const news = newsMarkers(S.sel, candles[0]?.t0 ?? f.t, f.t, S.tf, k0);
  const hit = drawCandles(canvas, candles, { showFair: S.showFair, news, hover: S.hover.candles });
  if (hit && S.hover.candles) {
    const c = hit.candle;
    const d = (c.c / c.o - 1) * 100;
    let html = `<div class="tt-h">${c.clock}${S.tf > 1 ? ` · ${S.tf}m` : ''}${c.halted ? ` · <b style="color:var(--warning)">${esc(t('chart.halted'))}</b>` : ''}</div>
      <div class="tt-r"><span>${esc(t('chart.open'))}</span><span>${c.o.toFixed(2)}</span></div>
      <div class="tt-r"><span>${esc(t('chart.high'))}</span><span>${c.h.toFixed(2)}</span></div>
      <div class="tt-r"><span>${esc(t('chart.low'))}</span><span>${c.l.toFixed(2)}</span></div>
      <div class="tt-r"><span>${esc(t('chart.close'))}</span><span class="${cls(d)}">${c.c.toFixed(2)} ${arrow(d)} ${pct(d)}</span></div>
      <div class="tt-r"><span>${esc(t('chart.volume'))}</span><span>${c.v.toLocaleString('en-US')}</span></div>
      ${S.showFair ? `<div class="tt-r"><span style="color:var(--fair)">${esc(t('chart.trueValue'))}</span><span>${c.fair.toFixed(2)}</span></div>` : ''}`;
    for (const nw of hit.news) html += `<div style="margin-top:5px;max-width:320px"><span class="${nw.up ? 'up' : 'down'}">${nw.up ? '▲' : '▼'}</span> ${esc(nw.headline)}</div>`;
    showTip(html, S.hover.candles.cx, S.hover.candles.cy);
  }
}

function renderBook(f) {
  const [bp, bq, ap, aq] = f.depth[S.sel];
  const halted = f.sym[S.sel][7];
  $('book-sym').textContent = sym().symbol;
  const n = 11;
  const max = Math.max(1, ...bq.slice(0, n), ...aq.slice(0, n));
  const row = (side, p, q) => `<div class="lad-row ${side}"><div class="bar" style="width:${(q / max) * 100}%"></div><span>${usd(p)}</span><span>${q.toLocaleString('en-US')}</span><span class="muted">${usd(p * q, 0)}</span></div>`;
  let asks = '';
  for (let i = Math.min(n, ap.length) - 1; i >= 0; i--) asks += row('ask', ap[i], aq[i]);
  let bids = '';
  for (let i = 0; i < Math.min(n, bp.length); i++) bids += row('bid', bp[i], bq[i]);
  const spread = ap.length && bp.length ? ap[0] - bp[0] : 0;
  const mid = ap.length && bp.length ? (ap[0] + bp[0]) / 2 : f.sym[S.sel][0];
  $('ladder').innerHTML = `<div class="lad-head"><span>${esc(t('book.price'))}</span><span>${esc(t('book.size'))}</span><span>${esc(t('book.notional'))}</span></div>
    <div class="lad-asks">${asks}</div>
    ${halted ? `<div class="halted-overlay">${esc(t('book.halted'))}</div>` : ''}
    <div class="lad-spread">${esc(t('book.mid'))} <b>${usd(mid)}</b> · ${esc(t('book.spread'))} ${usd(spread)} (${mid ? ((spread / mid) * 1e4).toFixed(1) : '0'} bp)</div>
    <div class="lad-bids">${bids}</div>`;
}

/** Depth "breathing": interpolate cumulative curves between consecutive book states. */
function renderDepth(f) {
  const [bp, bq, ap, aq] = f.depth[S.sel];
  const nb = bp.map((p, i) => [p / 100, bq[i]]);
  const na = ap.map((p, i) => [p / 100, aq[i]]);
  const a = S.anim;
  const key = `${S.sel}:${f.t}`;
  if (a.depthKey !== key) {
    const prev = a.depth && a.depth.sel === S.sel ? interpDepth(a.depth) : null;
    a.depth = { sel: S.sel, from: prev ?? { b: nb, a: na }, to: { b: nb, a: na }, p: S.motion && prev ? 0 : 1 };
    a.depthKey = key;
  }
  const cur = interpDepth(a.depth);
  const hit = drawDepth($('depth'), cur.b, cur.a, S.hover.depth);
  if (hit && S.hover.depth) {
    showTip(
      `<div class="tt-h">${hit.side === 'bid' ? 'Bids ≥' : 'Asks ≤'} ${hit.price.toFixed(2)}</div><div class="tt-r"><span>${esc(t('panel.depthHint'))}</span><span>${hit.qty.toLocaleString('en-US')}</span></div>`,
      S.hover.depth.cx,
      S.hover.depth.cy,
    );
  } else if (!S.hover.candles && !S.hover.equity) hideTip();
}
function interpDepth(d) {
  if (d.p >= 1) return d.to;
  const e = 1 - Math.pow(1 - d.p, 3);
  const mix = (A, B) =>
    B.map(([p, q], i) => {
      const o = A[i];
      return o ? [o[0] + (p - o[0]) * e, o[1] + (q - o[1]) * e] : [p, q * e];
    });
  return { b: mix(d.from.b, d.to.b), a: mix(d.from.a, d.to.a) };
}

function renderGauge(f) {
  const a = S.anim;
  if (!a.gauge || !S.motion) a.gauge = { v: f.fearGreed, target: f.fearGreed };
  a.gauge.target = f.fearGreed;
  drawGauge($('gauge'), a.gauge.v, { title: t('kpi.fearGreed').toUpperCase(), label: fgLabel(Math.round(a.gauge.v)).toUpperCase() });
}

function renderStats(f) {
  const ds = Math.max(firstT(), dayStart(f.t));
  const evs = S.data.events.slice(upper(S.data.events, ds - 1, (x) => x.t), upper(S.data.events, f.t, (x) => x.t));
  const halts = evs.filter((e) => e.type === 'halt').length;
  const liq = evs.filter((e) => e.type === 'liquidation').length;
  const busts = S.data.events.slice(0, upper(S.data.events, f.t, (x) => x.t)).filter((e) => e.type === 'bust').length;
  const trades = upper(S.data.trades, f.t, (x) => x[0]) - upper(S.data.trades, ds - 1, (x) => x[0]);
  const stat = (k, v, c = '') => `<div class="stat"><div class="k">${esc(k)}</div><div class="v ${c}">${v}</div></div>`;
  $('stat-grid').innerHTML =
    stat(t('stat.volx'), f.vol.toFixed(1)) +
    stat(t('stat.rate'), (f.rate * 100).toFixed(2) + '%') +
    stat(t('stat.marginDebt'), money(f.marginDebt)) +
    stat(t('stat.shortInterest', { sym: sym().symbol }), f.shortPct[S.sel].toFixed(1) + '%') +
    stat(t('stat.tradesToday'), trades.toLocaleString('en-US')) +
    stat(t('stat.haltsToday'), String(halts), halts ? 'down' : '') +
    stat(t('stat.liquidations'), String(liq), liq ? 'down' : '') +
    stat(t('stat.bankrupt'), String(busts), busts ? 'down' : '');
}

function renderTape() {
  const tr = S.data.trades;
  const end = upper(tr, T(), (x) => x[0]);
  const out = [];
  for (let i = end - 1; i >= 0 && out.length < 34; i--) {
    const x = tr[i];
    if (S.tapeScope === 'sel' && x[1] !== S.sel) continue;
    out.push([i, x]);
  }
  const prevTop = S.lastTapeTop;
  S.lastTapeTop = out[0]?.[0] ?? null;
  $('tape').innerHTML = out
    .map(([i, x]) => {
      const [tt, si, p, q, ag, b, s, flags] = x;
      const buyer = b >= 0 ? agent(b)?.name : 'WHALE';
      const seller = s >= 0 ? agent(s)?.name : 'WHALE';
      const big = q * p > 5_000_000;
      const fresh = S.cursor === null && prevTop !== null && i > prevTop;
      const badge = flags & 1 ? '<span class="badge liq">LIQ</span>' : flags & 2 ? '<span class="badge ff">FF</span>' : '';
      return `<div class="tp-row${big ? ' big' : ''}${fresh ? ' new' : ''}" title="${esc(t('tape.boughtFrom', { buyer, seller }))}">
        <span class="muted">${frameAt(tt).clock.slice(3)}</span><span>${S.data.symbols[si].symbol}</span>
        <span class="tp-px ${ag > 0 ? 'up' : 'down'}">${ag > 0 ? '▲' : '▼'} ${usd(p)}</span><span class="tp-q">${compact(q)}</span><span>${badge}</span></div>`;
    })
    .join('');
}

function renderBreaker(f) {
  const on = S.cursor === null && f.t < S.breakerUntil && f.sym.every((s) => s[7]);
  if ($('breaker').hidden === on) $('breaker').hidden = !on;
}

function renderTicker() {
  const ns = until(S.data.news, (x) => x.t).slice(-10).reverse();
  const key = ns.map((n) => n.id).join(',');
  if ($('ticker').dataset.key === key) return;
  $('ticker').dataset.key = key;
  const items = ns
    .map((n) => `<span class="ticker-item"><span class="${n.sentiment >= 0 ? 'up' : 'down'}">${n.sentiment >= 0 ? '▲' : '▼'}</span> ${n.symbol ? `<b>${n.symbol}</b> ` : ''}${esc(n.headline)}</span>`)
    .join('');
  const track = $('ticker');
  track.innerHTML = items + items;
  track.style.animationDuration = `${Math.max(30, ns.reduce((a, n) => a + n.headline.length, 0) * 0.18)}s`;
}

function renderNews() {
  const ns = until(S.data.news, (x) => x.t).slice(-60).reverse();
  const el = $('news');
  const key = ns.map((n) => n.id).join(',') + T() + lang;
  if (el.dataset.key === key) return;
  const prevTop = Number(el.dataset.top || 0);
  el.dataset.key = key;
  el.dataset.top = String(ns[0]?.id ?? 0);
  el.innerHTML = ns
    .map((n) => {
      const isNew = S.cursor === null && n.id > prevTop && prevTop > 0;
      const up = n.sentiment >= 0;
      const badges = [
        n.isRumor ? `<span class="badge rumor">${esc(t('news.unconfirmed'))}</span>` : '',
        n.source === 'user' ? `<span class="badge user">${esc(t('news.injected'))}</span>` : '',
        n.kind === 'confirm' ? `<span class="badge user">${esc(t('news.confirmed'))}</span>` : '',
        n.kind === 'debunk' ? `<span class="badge rumor">${esc(t('news.denied'))}</span>` : '',
      ].join('');
      return `<div class="nw-row${n.isRumor ? ' rumor' : ''}${isNew ? ' fresh' : ''}">
        <span class="time">${frameAt(n.t).clock.slice(3)}</span>
        <span class="${up ? 'up' : 'down'}">${up ? '▲' : '▼'}</span>
        <div><div class="hl">${esc(n.headline)}</div>
        <div class="meta"><span class="sym-chip">${n.symbol ?? esc(t('news.market'))}</span><span>${esc(t(`news.source.${n.source}`))}</span>${badges}</div></div></div>`;
    })
    .join('');
}

const AL = { breaker: ['critical', 'stop'], bust: ['critical', 'stop'], liquidation: ['serious', 'alert'], crash: ['serious', 'bolt'], halt: ['warning', 'pause'], resume: ['info', 'play'], rate: ['info', 'pct'], session: ['info', 'clock'], scenario: ['info', 'flag'], scheduled: ['info', 'clock'], llm: ['warning', 'alert'] };
function renderFeed() {
  const el = $('feed');
  const unseen = S.data.events.length - S.seenAlerts;
  $('alert-count').textContent = S.feedTab !== 'alerts' && unseen > 0 ? String(Math.min(99, unseen)) : '';
  if (S.feedTab === 'alerts') {
    S.seenAlerts = S.data.events.length;
    const evs = until(S.data.events, (x) => x.t).slice(-80).reverse();
    el.innerHTML = evs.length
      ? evs
          .map((e) => {
            const [lvl, ic] = AL[e.type] ?? ['info', 'dot'];
            return `<div class="al-row ${lvl}"><span class="time">${frameAt(e.t).clock.slice(3)}</span><span class="ic" aria-label="${lvl}">${icon(ic)}</span><span>${esc(e.text)}</span></div>`;
          })
          .join('')
      : `<div class="lb-note">${esc(t('feed.noAlerts'))}</div>`;
    return;
  }
  const th = until(S.data.thoughts, (x) => x.t).slice(-60).reverse();
  el.innerHTML = th
    .map((x) => {
      const a = agent(x.agent);
      if (!a) return '';
      const col = S.colorOf[a.personality] ?? OTHER;
      return `<div class="fd-row"><span class="time">${frameAt(x.t).clock.slice(3)}</span><div><span class="swatch" style="background:${col}"></span><span class="who" data-agent="${x.agent}">@${esc(a.name)}</span> <span class="role">${esc(pLabel(a.personality))}${a.kind === 'llm' ? ` · <span class="badge llm">${esc(a.team)}</span>` : ''}</span><div class="what">${esc(x.text)}</div></div></div>`;
    })
    .join('');
}

/* ───────────────────────────── leaderboard ───────────────────────────── */

export function scores(upto) {
  const snaps = S.data.equity;
  const end = upper(snaps, upto, (x) => x.t);
  return S.data.agents.map((a, i) => {
    const start = a.startEquity / 100;
    let peak = start, mdd = 0, prev = start, n = 0, sum = 0, sum2 = 0, last = start;
    for (let k = 0; k < end; k++) {
      const v = snaps[k].eq[i];
      if (prev > 0) {
        const r = v / prev - 1;
        sum += r;
        sum2 += r * r;
        n++;
      }
      prev = v;
      last = v;
      peak = Math.max(peak, v);
      if (peak > 0) mdd = Math.min(mdd, v / peak - 1);
    }
    const mean = n ? sum / n : 0;
    const sd = n > 1 ? Math.sqrt(Math.max(0, (sum2 - n * mean * mean) / (n - 1))) : 0;
    return { i, a, equity: last, pnl: last - start, ret: (last / start - 1) * 100, sharpe: sd > 0 ? (mean / sd) * Math.sqrt(n) : 0, mdd: mdd * 100, busted: !!snaps[end - 1]?.busted?.[i] };
  });
}

function renderLeaderboard() {
  const sc = scores(T());
  const tab = S.lbTab;
  const table = $('lb-table');
  let series = [];
  if (tab === 'agent') {
    const sorted = [...sc].sort((x, y) => y.ret - x.ret);
    const rows = [...sorted.slice(0, 14), ...sorted.slice(-4)];
    table.innerHTML = `<table><thead><tr><th>#</th><th>${esc(t('lb.trader'))}</th><th>${esc(t('lb.return'))}</th><th>${esc(t('lb.pnl'))}</th><th>${esc(t('lb.sharpe'))}</th><th>${esc(t('lb.maxDD'))}</th></tr></thead><tbody>${rows
      .map((r) => {
        const rank = sorted.indexOf(r) + 1;
        return `<tr data-agent="${r.i}" class="${r.busted ? 'busted' : ''}"><td class="rank">${rank}</td><td><span class="swatch" style="background:${S.colorOf[r.a.personality] ?? OTHER}"></span>@${esc(r.a.name)} <span class="muted">${esc(pLabel(r.a.personality))}${r.a.kind === 'llm' ? ' · ' + esc(r.a.team) : ''}</span>${r.busted ? ` <span class="badge liq">${esc(t('lb.bust'))}</span>` : ''}</td><td class="${cls(r.ret)}">${arrow(r.ret)} ${pct(r.ret)}</td><td>${money(r.pnl)}</td><td>${r.sharpe.toFixed(2)}</td><td>${r.mdd.toFixed(1)}%</td></tr>`;
      })
      .join('')}</tbody></table>`;
    series = sorted.slice(0, 3).concat(sorted.slice(-1)).map((r, k) => ({ label: '@' + r.a.name, color: SLOTS[k], idx: [r.i] }));
  } else {
    const key = tab === 'team' ? (r) => r.a.team : (r) => r.a.personality;
    const groups = new Map();
    for (const r of sc) {
      const g = key(r);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(r);
    }
    const rows = [...groups.entries()]
      .map(([g, xs]) => {
        const rets = xs.map((x) => x.ret).sort((a, b) => a - b);
        const best = [...xs].sort((a, b) => b.ret - a.ret)[0];
        return { g, n: xs.length, avg: rets.reduce((a, b) => a + b, 0) / rets.length, med: rets[Math.floor(rets.length / 2)], sharpe: xs.reduce((a, x) => a + x.sharpe, 0) / xs.length, mdd: Math.min(...xs.map((x) => x.mdd)), busted: xs.filter((x) => x.busted).length, idx: xs.map((x) => x.i), best: best.i };
      })
      .sort((a, b) => b.avg - a.avg);
    const color = (g) => (tab === 'team' ? S.colorOf['team:' + g] : S.colorOf[g]) ?? OTHER;
    const name = (g) => (tab === 'team' ? g : pLabel(g));
    table.innerHTML =
      `<table><thead><tr><th>#</th><th>${esc(t(tab === 'team' ? 'lb.model' : 'lb.strategy'))}</th><th>${esc(t('lb.avgReturn'))}</th><th>${esc(t('lb.median'))}</th><th>${esc(t('lb.sharpe'))}</th><th>${esc(t('lb.worstDD'))}</th><th>${esc(t('lb.bust'))}</th></tr></thead><tbody>${rows
        .map((r, k) => `<tr data-agent="${r.best}"><td class="rank">${k + 1}</td><td><span class="swatch" style="background:${color(r.g)}"></span>${esc(name(r.g))} <span class="muted">×${r.n}</span></td><td class="${cls(r.avg)}">${arrow(r.avg)} ${pct(r.avg)}</td><td>${pct(r.med)}</td><td>${r.sharpe.toFixed(2)}</td><td>${r.mdd.toFixed(1)}%</td><td>${r.busted || ''}</td></tr>`)
        .join('')}</tbody></table>` + (tab === 'team' && rows.length < 2 ? `<div class="lb-note">${esc(t('lb.onlyOffline'))}</div>` : '');
    series = rows.slice(0, 8).map((r) => ({ label: name(r.g), color: color(r.g), idx: r.idx }));
  }
  const snaps = S.data.equity;
  const end = upper(snaps, T(), (x) => x.t);
  const step = Math.max(1, Math.floor(end / 160));
  const lines = series.map((s) => {
    const pts = [];
    for (let k = 0; k < end; k += step) {
      let acc = 0;
      for (const i of s.idx) acc += (snaps[k].eq[i] / (S.data.agents[i].startEquity / 100) - 1) * 100;
      pts.push([snaps[k].t, acc / s.idx.length]);
    }
    return { label: s.label, color: s.color, points: pts };
  });
  $('lb-legend').innerHTML = lines.map((l) => `<span><span class="swatch" style="background:${l.color}"></span>${esc(l.label)}</span>`).join('');
  const hov = drawLines($('equity'), lines, S.hover.equity);
  if (hov && S.hover.equity) {
    showTip(
      `<div class="tt-h">${frameAt(hov[0].t).clock} · ${esc(t('lb.returnSince'))}</div>` +
        hov.sort((a, b) => b.value - a.value).map((r) => `<div class="tt-r"><span><span class="swatch" style="background:${r.color}"></span>${esc(r.label)}</span><span class="${cls(r.value)}">${pct(r.value)}</span></div>`).join(''),
      S.hover.equity.cx,
      S.hover.equity.cy,
    );
  }
}

/* ───────────────────────────── scrubber ───────────────────────────── */

function renderScrub(f) {
  const a = firstT(), b = lastT();
  const sl = $('scrub');
  sl.min = String(a);
  sl.max = String(b);
  sl.value = String(T());
  $('scrub-clock').textContent = f.clock;
  const step = Math.max(1, Math.floor((b - a) / 400));
  const pts = [];
  for (let tt = a; tt <= b; tt += step) pts.push([tt, frameAt(tt).index]);
  const marks = [];
  for (const e of S.data.events) {
    if (e.type === 'breaker' || e.type === 'bust') marks.push({ t: e.t, color: css('--critical'), tall: true });
    else if (e.type === 'crash') marks.push({ t: e.t, color: css('--serious'), tall: true });
    else if (e.type === 'halt') marks.push({ t: e.t, color: css('--warning') });
  }
  for (const h of S.highlights) marks.push({ t: h.t, color: css('--fair'), tall: true, flag: true });
  drawScrub($('scrub-canvas'), pts, marks, a, b, T());
}

function renderHlCount() {
  $('hl-count').textContent = S.highlights.length ? String(S.highlights.length) : '';
}

/* ───────────────────────────── tooltip ───────────────────────────── */

export function showTip(html, x, y) {
  const el = $('tooltip');
  el.innerHTML = html;
  el.hidden = false;
  const r = el.getBoundingClientRect();
  el.style.left = (x + 16 + r.width > innerWidth ? x - r.width - 16 : x + 16) + 'px';
  el.style.top = Math.min(innerHeight - r.height - 8, Math.max(8, y - 10)) + 'px';
}
export function hideTip() {
  $('tooltip').hidden = true;
}

/** The surface features.js works through. */
const api = { S, t, esc, usd, pct, arrow, cls, money, icon, toast, cmd, jump, goLive, frameAt, firstT, lastT, T, upper, scores, buildCandles, newsMarkers, sym, agent, pLabel, dayOpen, SLOTS, OTHER, applyI18n, start, loadState };

boot().catch((e) => {
  document.body.innerHTML = `<pre style="color:#f08a8a;padding:24px">AgentStreet failed to start: ${esc(e.message || e)}</pre>`;
});

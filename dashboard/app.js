// AgentStreet terminal: live stream + time travel over the same recorded data.
import { drawCandles, drawDepth, drawGauge, drawSpark, drawLines, drawScrub, fgLabel, compact, css } from './charts.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const usd = (cents, d = 2) => (cents / 100).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (x, d = 2) => `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`;
const arrow = (x) => (x > 0 ? '▲' : x < 0 ? '▼' : '■');
const cls = (x) => (x > 0 ? 'up' : x < 0 ? 'down' : 'muted');
const money = (d) => {
  const a = Math.abs(d);
  const s = a >= 1e6 ? `$${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `$${(a / 1e3).toFixed(1)}k` : `$${a.toFixed(0)}`;
  return d < 0 ? `-${s}` : s;
};

// Categorical slots (validated dark-mode order). Personalities take slots in registration order.
const SLOTS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const OTHER = '#898781';
const TFS = [1, 5, 15, 30];

const S = {
  data: null,
  status: { mode: 'live', paused: false, speed: 1, speeds: [1] },
  personalities: [],
  scenarios: [],
  llm: [],
  cursor: null, // null = follow live
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
};

/* ───────────────────────────── data access ───────────────────────────── */

const frames = () => S.data.frames;
const firstT = () => frames()[0]?.t ?? 1;
const lastT = () => frames()[frames().length - 1]?.t ?? 1;
const T = () => (S.cursor === null ? lastT() : S.cursor);
const frameAt = (t) => {
  const f = frames();
  const i = Math.max(0, Math.min(f.length - 1, t - firstT()));
  return f[i];
};
/** Index of first element with key > t (arrays sorted by tick). */
function upper(arr, t, key) {
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
const dayStart = (t) => Math.floor((t - 1) / ticksPerDay()) * ticksPerDay() + 1;
function dayOpen(si, t) {
  const ds = dayStart(t);
  if (ds - 1 >= firstT()) return frameAt(ds - 1).sym[si][0];
  return ds === 1 ? S.data.symbols[si].price : frames()[0].sym[si][0];
}
function dayOpenIndex(t) {
  const ds = dayStart(t);
  return ds - 1 >= firstT() ? frameAt(ds - 1).index : ds === 1 ? 1000 : frames()[0].index;
}
const sym = (i = S.sel) => S.data.symbols[i];
const agent = (i) => S.data.agents[i];
const pLabel = (id) => S.personalities.find((p) => p.id === id)?.label ?? id;

/* ───────────────────────────── boot ───────────────────────────── */

async function boot() {
  const res = await fetch('api/state');
  const st = await res.json();
  S.data = st.data;
  S.status = st.status;
  S.personalities = st.personalities;
  S.scenarios = st.scenarios;
  S.llm = st.llm;
  S.personalities.forEach((p, i) => (S.colorOf[p.id] = SLOTS[i] ?? OTHER));
  const teams = [...new Set(S.data.agents.map((a) => a.team))];
  teams.forEach((t, i) => (S.colorOf['team:' + t] = SLOTS[i] ?? OTHER));
  try {
    if (localStorage.getItem('as-cvd') === '1') setCvd(true);
    const tf = Number(localStorage.getItem('as-tf'));
    if (TFS.includes(tf)) S.tf = tf;
  } catch {}
  S.seenAlerts = S.data.events.length;
  if (S.status.mode === 'replay') {
    S.cursor = Math.min(lastT(), firstT() + 200);
  }
  // Deep links: ?t=240&sym=QBTX&lb=team&feed=alerts&tf=1 (handy for sharing a moment).
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
  if (S.status.mode === 'live') connect();
  requestAnimationFrame(frameLoop);
}

function connect() {
  const es = new EventSource('api/stream');
  es.addEventListener('ticks', (e) => {
    for (const d of JSON.parse(e.data)) ingest(d);
    S.dirty = true;
  });
  es.addEventListener('status', (e) => {
    S.status = JSON.parse(e.data);
    renderStatus();
  });
  es.onerror = () => {
    $('status').className = 'status';
    $('status-text').textContent = 'RECONNECTING';
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
    if (S.cursor === null && (x.type === 'breaker' || x.type === 'bust' || x.type === 'crash')) breaking(x);
  }
  if (d.equity) r.equity.push(d.equity);
  r.meta.ticks = d.frame.t;
  // Keep the browser's memory bounded too.
  if (r.frames.length > 22000) {
    const cut = r.frames[r.frames.length - 20000].t;
    r.frames.splice(0, r.frames.length - 20000);
    const drop = (arr, key) => arr.splice(0, upper(arr, cut - 1, key));
    drop(r.trades, (x) => x[0]);
    drop(r.news, (x) => x.t);
    drop(r.thoughts, (x) => x.t);
    drop(r.events, (x) => x.t);
    drop(r.equity, (x) => x.t);
  }
}

let breakingTimer = null;
function breaking(e) {
  const el = $('breaking');
  el.textContent = (e.type === 'bust' ? '☠ ' : '⚠ ') + e.text;
  el.className = 'breaking' + (e.type === 'crash' ? ' warn' : '');
  el.hidden = false;
  clearTimeout(breakingTimer);
  breakingTimer = setTimeout(() => (el.hidden = true), 4200);
}

/* ───────────────────────────── static UI ───────────────────────────── */

function buildStatic() {
  // speed
  const speed = $('speed');
  speed.innerHTML = S.status.speeds.map((s) => `<button data-v="${s}">${s}×</button>`).join('');
  speed.onclick = (e) => {
    const b = e.target.closest('button');
    if (b) control({ action: 'speed', value: Number(b.dataset.v) });
  };
  $('btn-pause').onclick = togglePause;
  $('btn-cvd').onclick = () => setCvd(document.documentElement.dataset.cvd !== '1');
  // timeframe
  $('tf').innerHTML = TFS.map((t) => `<button data-v="${t}" class="${t === S.tf ? 'on' : ''}">${t}m</button>`).join('');
  $('tf').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    S.tf = Number(b.dataset.v);
    try { localStorage.setItem('as-tf', String(S.tf)); } catch {}
    segOn('tf', b.dataset.v);
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
  // watchlist rows
  $('watchlist').innerHTML = S.data.symbols
    .map(
      (s, i) => `<div class="wl-row" role="option" tabindex="0" data-i="${i}" title="${esc(s.name)} — ${esc(s.blurb)}">
        <div><div class="wl-sym">${s.symbol}<span class="badge halt" hidden>HALT</span></div><div class="wl-name">${esc(s.name)}</div></div>
        <div><div class="wl-px"></div><div class="wl-chg"></div></div>
        <canvas class="wl-spark"></canvas>
        <div class="wl-fair" style="grid-column:1/3"></div>
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
  // scrubber
  $('play-speed').innerHTML = [1, 4, 16, 60].map((s) => `<button data-v="${s}" class="${s === S.playSpeed ? 'on' : ''}">${s}×</button>`).join('');
  tabs('play-speed', (v) => (S.playSpeed = Number(v)));
  $('scrub').oninput = (e) => {
    const v = Number(e.target.value);
    S.cursor = S.status.mode === 'live' && v >= lastT() ? null : v;
    S.dirty = true;
  };
  $('btn-play').onclick = () => {
    if (S.cursor === null) S.cursor = Math.max(firstT(), lastT() - 300);
    if (S.cursor >= lastT() && S.status.mode === 'replay') S.cursor = firstT();
    S.playing = !S.playing;
    S.dirty = true;
  };
  $('btn-live').onclick = () => {
    S.cursor = null;
    S.playing = false;
    S.dirty = true;
  };
  buildControls();
  hoverable('candles', 'candles');
  hoverable('depth', 'depth');
  hoverable('equity', 'equity');
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', () => (S.dirty = true));
  renderStatus();
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
function segOn(id, v) {
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
function select(i) {
  S.sel = i;
  S.dirty = true;
  S.lastSlow = -Infinity;
}
function onKey(e) {
  if (e.target.tagName === 'INPUT') return;
  if (e.key >= '1' && e.key <= '9' && Number(e.key) <= S.data.symbols.length) select(Number(e.key) - 1);
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
  }
}

async function control(body) {
  try {
    const r = await fetch('api/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (r.ok) {
      S.status = await r.json();
      renderStatus();
    }
  } catch {}
}
function togglePause() {
  if (S.status.mode !== 'live') return;
  control({ action: S.status.paused ? 'resume' : 'pause' });
}
const cmd = (c) => control({ action: 'command', cmd: c });

function buildControls() {
  const el = $('controls');
  if (S.status.mode !== 'live') {
    $('ctrl-title').textContent = 'Replay';
    const m = S.data.meta;
    const sc = S.scenarios.find((s) => s.id === m.scenario);
    el.innerHTML = `<div class="replay-info">
      <b>${esc(sc?.name ?? m.scenario)}</b><br>${esc(sc?.description ?? '')}<br><br>
      seed <b>${m.seed}</b> · ${m.ticks.toLocaleString('en-US')} ticks<br>
      trade hash <b>${esc(m.hash)}</b><br>
      ${esc(m.app)}<br><br>
      <span class="muted">Re-simulate it bit-for-bit:<br><code>agentstreet verify &lt;file&gt;</code></span></div>`;
    return;
  }
  el.innerHTML = `
    <div class="ctrl-label">NEWS · <span id="ctrl-sym"></span></div>
    <div class="ctrl-row">
      <button class="btn good" data-c="good">▲ Good news</button>
      <button class="btn bad" data-c="bad">▼ Bad news</button>
      <button class="btn" data-c="rumor">◌ Start rumor</button>
      <button class="btn" data-c="pump"># Meme pump</button>
    </div>
    <div class="ctrl-input"><input id="ctrl-headline" maxlength="140" placeholder="Write your own headline…" aria-label="Custom headline" /><button class="btn" data-c="publish">Publish</button></div>
    <div class="ctrl-label">MARKET</div>
    <div class="ctrl-row">
      <button class="btn danger" data-c="crash">⚡ Fat-finger crash</button>
      <button class="btn" data-c="halt">❚❚ Halt 15m</button>
      <button class="btn" data-c="hike">Rate +50bp</button>
      <button class="btn" data-c="cut">Rate −50bp</button>
    </div>
    <div class="ctrl-label">SCENARIO</div>
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
function frameLoop(now) {
  if (S.playing && S.cursor !== null) {
    const dt = now - (lastPlay || now);
    const adv = Math.floor((dt / 1000) * S.playSpeed * 4);
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
  if (S.dirty && S.data.frames.length) {
    S.dirty = false;
    try {
      render(now);
    } catch (e) {
      console.error(e);
    }
  }
  requestAnimationFrame(frameLoop);
}

function render(now) {
  const f = frameAt(T());
  renderStatus();
  renderTop(f);
  renderWatch(f);
  renderChart(f);
  renderBook(f);
  renderDepth(f);
  renderStats(f);
  renderTape();
  renderScrub(f);
  // Text-heavy panels refresh at most ~3×/s.
  if (now - S.lastSlow > 330) {
    S.lastSlow = now;
    renderTicker();
    renderNews();
    renderFeed();
    renderLeaderboard();
  } else {
    clearTimeout(slowTimer);
    slowTimer = setTimeout(() => (S.dirty = true), 340);
  }
}
let slowTimer = null;

function renderStatus() {
  const st = $('status');
  let mode = 'live', label = 'LIVE';
  if (S.status.mode === 'replay') (mode = 'replay'), (label = S.playing ? 'REPLAY ▶' : 'REPLAY');
  else if (S.cursor !== null) (mode = 'travel'), (label = 'TIME TRAVEL');
  else if (S.status.paused) (mode = 'paused'), (label = 'PAUSED');
  st.className = 'status ' + mode;
  $('status-text').textContent = label;
  const live = S.status.mode === 'live';
  segOn('speed', S.status.speed);
  $('speed').style.display = live ? '' : 'none';
  $('btn-pause').style.display = live ? '' : 'none';
  $('btn-pause').textContent = S.status.paused ? '▶' : '❚❚';
  $('btn-live').style.display = live ? '' : 'none';
  $('btn-live').classList.toggle('off', S.cursor !== null);
  $('btn-play').textContent = S.playing ? '❚❚' : '▶';
}

function kpi(k, v, c = '', opt = false, title = '') {
  return `<div class="kpi${opt ? ' opt' : ''}" title="${esc(title)}"><span class="k">${k}</span><span class="v ${c}">${v}</span></div>`;
}

function renderTop(f) {
  $('clock').textContent = f.clock;
  const io = dayOpenIndex(f.t);
  const ic = (f.index / io - 1) * 100;
  $('top-kpis').innerHTML =
    kpi('STREET-6 INDEX', `${f.index.toFixed(2)} <span class="${cls(ic)}">${arrow(ic)} ${pct(ic)}</span>`, '', false, 'Cap-weighted index of all six listed companies') +
    kpi('RATE', `${(f.rate * 100).toFixed(2)}%`, '', false, 'Central-bank policy rate') +
    kpi('FEAR & GREED', `${f.fearGreed} ${fgLabel(f.fearGreed).toUpperCase()}`) +
    kpi('VOLX', f.vol.toFixed(1), '', true, 'Annualised realised volatility of the index') +
    kpi('MARGIN DEBT', money(f.marginDebt), '', true);
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
    row.querySelector('.wl-px').textContent = usd(last);
    const c = row.querySelector('.wl-chg');
    c.className = 'wl-chg ' + cls(chg);
    c.textContent = `${arrow(chg)} ${pct(chg)}`;
    row.querySelector('.badge.halt').hidden = !halted;
    const gap = (last / fair - 1) * 100;
    row.querySelector('.wl-fair').innerHTML = S.showFair
      ? `vs true value <span class="${Math.abs(gap) > 10 ? (gap > 0 ? 'down' : 'up') : 'muted'}">${pct(gap, 1)}</span>${Math.abs(gap) > 15 ? (gap > 0 ? ' · bubble?' : ' · bargain?') : ''}`
      : '';
    const t0 = Math.max(firstT(), f.t - 180);
    const vals = [];
    for (let t = t0; t <= f.t; t += 2) vals.push(frameAt(t).sym[i][0]);
    drawSpark(row.querySelector('.wl-spark'), vals, chg >= 0 ? css('--up') : css('--down'), open);
  });
}

function buildCandles(si, tEnd, tf, n) {
  const kEnd = Math.floor((tEnd - 1) / tf);
  const kStart = Math.max(Math.floor((firstT() - 1) / tf), kEnd - n + 1);
  const out = [];
  for (let k = kStart; k <= kEnd; k++) {
    const a = Math.max(firstT(), k * tf + 1);
    const b = Math.min(tEnd, (k + 1) * tf);
    if (a > b) continue;
    const prev = a - 1 >= firstT() ? frameAt(a - 1).sym[si][0] : frameAt(a).sym[si][0];
    let h = prev, l = prev, v = 0, halted = 0, c = prev;
    for (let t = a; t <= b; t++) {
      const s = frameAt(t).sym[si];
      h = Math.max(h, s[3], s[0]);
      l = Math.min(l, s[4], s[0]);
      v += s[5];
      halted |= s[7];
      c = s[0];
    }
    const fb = frameAt(b);
    out.push({ k, t0: a, t1: b, o: prev / 100, h: h / 100, l: l / 100, c: c / 100, v, fair: fb.sym[si][6] / 100, halted, clock: frameAt(a).clock });
  }
  return out;
}

function renderChart(f) {
  const s = sym();
  const [last, , , , , , fair] = f.sym[S.sel];
  const open = dayOpen(S.sel, f.t);
  const chg = (last / open - 1) * 100;
  // session high/low
  let hi = 0, lo = Infinity;
  for (let t = Math.max(firstT(), dayStart(f.t)); t <= f.t; t++) {
    const x = frameAt(t).sym[S.sel];
    hi = Math.max(hi, x[3]);
    lo = Math.min(lo, x[4]);
  }
  $('sym-head').innerHTML = `<span class="t">${s.symbol}</span><span class="n">${esc(s.name)} · ${esc(s.sector)}</span>
    <span class="p">$${usd(last)}</span><span class="${cls(chg)}">${arrow(chg)} ${pct(chg)}</span>
    <span class="ohl">O ${usd(open)} H ${usd(hi)} L ${usd(lo)}${S.showFair ? ` · <span style="color:var(--fair)">TRUE ${usd(fair)}</span>` : ''}</span>`;
  const canvas = $('candles');
  const n = Math.max(20, Math.floor(canvas.clientWidth / 9));
  const candles = buildCandles(S.sel, f.t, S.tf, n);
  const k0 = candles[0]?.k ?? 0;
  const tStart = candles[0]?.t0 ?? f.t;
  const news = [];
  for (let i = upper(S.data.news, tStart - 1, (x) => x.t); i < S.data.news.length; i++) {
    const nw = S.data.news[i];
    if (nw.t > f.t) break;
    if (nw.symbol !== s.symbol) continue;
    news.push({ i: Math.floor((nw.t - 1) / S.tf) - k0, up: nw.sentiment >= 0, headline: nw.headline, clock: frameAt(nw.t).clock });
  }
  const hit = drawCandles(canvas, candles, { showFair: S.showFair, news, hover: S.hover.candles });
  if (hit && S.hover.candles) {
    const c = hit.candle;
    const d = (c.c / c.o - 1) * 100;
    let html = `<div class="tt-h">${c.clock}${S.tf > 1 ? ` · ${S.tf}m` : ''}${c.halted ? ' · <b style="color:var(--warning)">HALTED</b>' : ''}</div>
      <div class="tt-r"><span>Open</span><span>${c.o.toFixed(2)}</span></div>
      <div class="tt-r"><span>High</span><span>${c.h.toFixed(2)}</span></div>
      <div class="tt-r"><span>Low</span><span>${c.l.toFixed(2)}</span></div>
      <div class="tt-r"><span>Close</span><span class="${cls(d)}">${c.c.toFixed(2)} ${arrow(d)} ${pct(d)}</span></div>
      <div class="tt-r"><span>Volume</span><span>${c.v.toLocaleString('en-US')}</span></div>
      ${S.showFair ? `<div class="tt-r"><span style="color:var(--fair)">True value</span><span>${c.fair.toFixed(2)}</span></div>` : ''}`;
    for (const nw of hit.news) html += `<div style="margin-top:5px;max-width:300px"><span class="${nw.up ? 'up' : 'down'}">${nw.up ? '▲' : '▼'}</span> ${esc(nw.headline)}</div>`;
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
  $('ladder').innerHTML = `<div class="lad-head"><span>PRICE</span><span>SIZE</span><span>NOTIONAL $</span></div>
    <div class="lad-asks">${asks}</div>
    ${halted ? `<div class="halted-overlay">❚❚ TRADING HALTED — orders queue for the re-opening cross</div>` : ''}
    <div class="lad-spread">mid <b>${usd(mid)}</b> · spread ${usd(spread)} (${mid ? ((spread / mid) * 1e4).toFixed(1) : '0'} bp)</div>
    <div class="lad-bids">${bids}</div>`;
}

function renderDepth(f) {
  const [bp, bq, ap, aq] = f.depth[S.sel];
  const hit = drawDepth(
    $('depth'),
    bp.map((p, i) => [p / 100, bq[i]]),
    ap.map((p, i) => [p / 100, aq[i]]),
    S.hover.depth,
  );
  if (hit && S.hover.depth) {
    showTip(
      `<div class="tt-h">${hit.side === 'bid' ? 'Bids at or above' : 'Asks at or below'}</div><div class="tt-r"><span>Price</span><span>${hit.price.toFixed(2)}</span></div><div class="tt-r"><span>Cumulative size</span><span>${hit.qty.toLocaleString('en-US')}</span></div>`,
      S.hover.depth.cx,
      S.hover.depth.cy,
    );
  } else if (!S.hover.candles && !S.hover.equity) hideTip();
}

function renderStats(f) {
  drawGauge($('gauge'), f.fearGreed);
  const ds = Math.max(firstT(), dayStart(f.t));
  const evs = S.data.events.slice(upper(S.data.events, ds - 1, (x) => x.t), upper(S.data.events, f.t, (x) => x.t));
  const halts = evs.filter((e) => e.type === 'halt').length;
  const liq = evs.filter((e) => e.type === 'liquidation').length;
  const busts = S.data.events.slice(0, upper(S.data.events, f.t, (x) => x.t)).filter((e) => e.type === 'bust').length;
  const trades = upper(S.data.trades, f.t, (x) => x[0]) - upper(S.data.trades, ds - 1, (x) => x[0]);
  const stat = (k, v, c = '') => `<div class="stat"><div class="k">${k}</div><div class="v ${c}">${v}</div></div>`;
  $('stat-grid').innerHTML =
    stat('VolX', f.vol.toFixed(1)) +
    stat('Rate', (f.rate * 100).toFixed(2) + '%') +
    stat('Margin debt', money(f.marginDebt)) +
    stat(`Short int. ${sym().symbol}`, f.shortPct[S.sel].toFixed(1) + '%') +
    stat('Trades today', trades.toLocaleString('en-US')) +
    stat('Halts today', String(halts), halts ? 'down' : '') +
    stat('Liquidations', String(liq), liq ? 'down' : '') +
    stat('Bankrupt', String(busts), busts ? 'down' : '');
}

function renderTape() {
  const tr = S.data.trades;
  const end = upper(tr, T(), (x) => x[0]);
  const out = [];
  for (let i = end - 1; i >= 0 && out.length < 34; i--) {
    const x = tr[i];
    if (S.tapeScope === 'sel' && x[1] !== S.sel) continue;
    out.push(x);
  }
  $('tape').innerHTML = out
    .map((x) => {
      const [t, si, p, q, ag, b, s, flags] = x;
      const buyer = b >= 0 ? agent(b)?.name : 'WHALE';
      const seller = s >= 0 ? agent(s)?.name : 'WHALE';
      const big = q * p > 5_000_000;
      const badge = flags & 1 ? '<span class="badge liq">LIQ</span>' : flags & 2 ? '<span class="badge ff">FF</span>' : '';
      return `<div class="tp-row${big ? ' big' : ''}" title="@${esc(buyer)} bought from @${esc(seller)}">
        <span class="muted">${frameAt(t).clock.slice(3)}</span><span>${S.data.symbols[si].symbol}</span>
        <span class="tp-px ${ag > 0 ? 'up' : 'down'}">${ag > 0 ? '▲' : '▼'} ${usd(p)}</span><span class="tp-q">${compact(q)}</span><span>${badge}</span></div>`;
    })
    .join('');
}

function renderTicker() {
  const ns = until(S.data.news, (x) => x.t).slice(-10).reverse();
  const key = ns.map((n) => n.id).join(',');
  if ($('ticker').dataset.key === key) return;
  $('ticker').dataset.key = key;
  const items = ns
    .map((n) => `<span class="ticker-item"><span class="${n.sentiment >= 0 ? 'up' : 'down'}">${n.sentiment >= 0 ? '▲' : '▼'}</span> ${n.symbol ? `<b>${n.symbol}</b> ` : ''}${esc(n.headline)}</span>`)
    .join('');
  // Two copies so the loop is seamless; speed scales with length.
  const track = $('ticker');
  track.innerHTML = items + items;
  track.style.animationDuration = `${Math.max(30, ns.reduce((a, n) => a + n.headline.length, 0) * 0.18)}s`;
}

const SRC = { wire: 'WIRE', 'rumor-mill': 'RUMOR MILL', social: 'SOCIAL', macro: 'MACRO', desk: 'ANALYST', user: 'YOU', llm: 'LLM' };
function renderNews() {
  const ns = until(S.data.news, (x) => x.t).slice(-60).reverse();
  const el = $('news');
  const key = ns.map((n) => n.id).join(',') + T();
  if (el.dataset.key === key) return;
  const prevTop = Number(el.dataset.top || 0);
  el.dataset.key = key;
  el.dataset.top = String(ns[0]?.id ?? 0);
  el.innerHTML = ns
    .map((n) => {
      const isNew = S.cursor === null && n.id > prevTop && prevTop > 0;
      const up = n.sentiment >= 0;
      return `<div class="nw-row${n.isRumor ? ' rumor' : ''}${isNew ? ' fresh' : ''}">
        <span class="time">${frameAt(n.t).clock.slice(3)}</span>
        <span class="${up ? 'up' : 'down'}" aria-label="${up ? 'positive' : 'negative'}">${up ? '▲' : '▼'}</span>
        <div><div class="hl">${esc(n.headline)}</div>
        <div class="meta">${n.symbol ? `<span class="sym-chip">${n.symbol}</span>` : '<span class="sym-chip">MKT</span>'}<span>${SRC[n.source] ?? n.source}</span>${n.isRumor ? '<span class="badge rumor">UNCONFIRMED</span>' : ''}${n.source === 'user' ? '<span class="badge user">INJECTED</span>' : ''}${n.kind === 'confirm' ? '<span class="badge user">CONFIRMED</span>' : ''}${n.kind === 'debunk' ? '<span class="badge rumor">DENIED</span>' : ''}</div></div></div>`;
    })
    .join('');
}

const AL = {
  breaker: ['critical', '⛔'],
  bust: ['critical', '☠'],
  liquidation: ['serious', '⚠'],
  crash: ['serious', '⚡'],
  halt: ['warning', '❚❚'],
  resume: ['info', '▶'],
  rate: ['info', '%'],
  session: ['info', '☀'],
  scenario: ['info', '★'],
};
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
            const [lvl, ic] = AL[e.type] ?? ['info', '·'];
            return `<div class="al-row ${lvl}"><span class="time">${frameAt(e.t).clock.slice(3)}</span><span class="ic" aria-label="${lvl}">${ic}</span><span>${esc(e.text)}</span></div>`;
          })
          .join('')
      : '<div class="lb-note">No alerts yet. Try the fat-finger button.</div>';
    return;
  }
  const th = until(S.data.thoughts, (x) => x.t).slice(-60).reverse();
  el.innerHTML = th
    .map((x) => {
      const a = agent(x.agent);
      if (!a) return '';
      const col = S.colorOf[a.personality] ?? OTHER;
      return `<div class="fd-row"><span class="time">${frameAt(x.t).clock.slice(3)}</span><div><span class="swatch" style="background:${col}"></span><span class="who">@${esc(a.name)}</span> <span class="role">${esc(pLabel(a.personality))}${a.kind === 'llm' ? ' · ' + esc(a.team) : ''}</span><div class="what">${esc(x.text)}</div></div></div>`;
    })
    .join('');
}

/* ───────────────────────────── leaderboard ───────────────────────────── */

function scores(upto) {
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
    return {
      i,
      a,
      equity: last,
      pnl: last - start,
      ret: (last / start - 1) * 100,
      sharpe: sd > 0 ? (mean / sd) * Math.sqrt(n) : 0,
      mdd: mdd * 100,
      busted: !!snaps[end - 1]?.busted?.[i],
    };
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
    table.innerHTML = `<table><thead><tr><th>#</th><th>Trader</th><th>Return</th><th>P&amp;L</th><th>Sharpe</th><th>Max DD</th></tr></thead><tbody>${rows
      .map((r) => {
        const rank = sorted.indexOf(r) + 1;
        return `<tr class="${r.busted ? 'busted' : ''}"><td class="rank">${rank}</td><td><span class="swatch" style="background:${S.colorOf[r.a.personality] ?? OTHER}"></span>@${esc(r.a.name)} <span class="muted">${esc(pLabel(r.a.personality))}${r.a.kind === 'llm' ? ' · ' + esc(r.a.team) : ''}</span>${r.busted ? ' <span class="badge liq">BUST</span>' : ''}</td><td class="${cls(r.ret)}">${arrow(r.ret)} ${pct(r.ret)}</td><td>${money(r.pnl)}</td><td>${r.sharpe.toFixed(2)}</td><td>${r.mdd.toFixed(1)}%</td></tr>`;
      })
      .join('')}</tbody></table>`;
    const top = sorted.slice(0, 3).concat(sorted.slice(-1));
    series = top.map((r, k) => ({ label: '@' + r.a.name, color: SLOTS[k], idx: [r.i] }));
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
        return {
          g,
          n: xs.length,
          avg: rets.reduce((a, b) => a + b, 0) / rets.length,
          med: rets[Math.floor(rets.length / 2)],
          sharpe: xs.reduce((a, x) => a + x.sharpe, 0) / xs.length,
          mdd: Math.min(...xs.map((x) => x.mdd)),
          busted: xs.filter((x) => x.busted).length,
          idx: xs.map((x) => x.i),
        };
      })
      .sort((a, b) => b.avg - a.avg);
    const color = (g) => (tab === 'team' ? S.colorOf['team:' + g] : S.colorOf[g]) ?? OTHER;
    const name = (g) => (tab === 'team' ? g : pLabel(g));
    table.innerHTML =
      `<table><thead><tr><th>#</th><th>${tab === 'team' ? 'Model / brain' : 'Strategy'}</th><th>Avg return</th><th>Median</th><th>Sharpe</th><th>Worst DD</th><th>Bust</th></tr></thead><tbody>${rows
        .map(
          (r, k) =>
            `<tr><td class="rank">${k + 1}</td><td><span class="swatch" style="background:${color(r.g)}"></span>${esc(name(r.g))} <span class="muted">×${r.n}</span></td><td class="${cls(r.avg)}">${arrow(r.avg)} ${pct(r.avg)}</td><td>${pct(r.med)}</td><td>${r.sharpe.toFixed(2)}</td><td>${r.mdd.toFixed(1)}%</td><td>${r.busted || ''}</td></tr>`,
        )
        .join('')}</tbody></table>` +
      (tab === 'team' && rows.length < 2
        ? `<div class="lb-note">Only the built-in heuristic brains are trading. Pit real models against each other:<br><code>agentstreet --models anthropic:claude-haiku-5-5,openai:gpt-4o-mini,ollama:llama3.1</code></div>`
        : '');
    series = rows.slice(0, 8).map((r) => ({ label: name(r.g), color: color(r.g), idx: r.idx }));
  }
  // equity curves: average % return of each group over time
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
      `<div class="tt-h">${frameAt(hov[0].t).clock} · return since start</div>` +
        hov
          .sort((a, b) => b.value - a.value)
          .map((r) => `<div class="tt-r"><span><span class="swatch" style="background:${r.color}"></span>${esc(r.label)}</span><span class="${cls(r.value)}">${pct(r.value)}</span></div>`)
          .join(''),
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
  for (let t = a; t <= b; t += step) pts.push([t, frameAt(t).index]);
  const marks = [];
  for (const e of S.data.events) {
    if (e.type === 'breaker' || e.type === 'bust') marks.push({ t: e.t, color: css('--critical'), tall: true });
    else if (e.type === 'crash') marks.push({ t: e.t, color: css('--serious'), tall: true });
    else if (e.type === 'halt') marks.push({ t: e.t, color: css('--warning') });
  }
  drawScrub($('scrub-canvas'), pts, marks, a, b, T());
}

/* ───────────────────────────── tooltip ───────────────────────────── */

function showTip(html, x, y) {
  const el = $('tooltip');
  el.innerHTML = html;
  el.hidden = false;
  const r = el.getBoundingClientRect();
  const left = x + 16 + r.width > innerWidth ? x - r.width - 16 : x + 16;
  const top = Math.min(innerHeight - r.height - 8, Math.max(8, y - 10));
  el.style.left = left + 'px';
  el.style.top = top + 'px';
}
function hideTip() {
  $('tooltip').hidden = true;
}

boot().catch((e) => {
  document.body.innerHTML = `<pre style="color:#f08a8a;padding:24px">AgentStreet failed to start: ${esc(e.message || e)}</pre>`;
});

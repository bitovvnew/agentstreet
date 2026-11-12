// Feature modules: onboarding wizard, highlights, trader X-ray, newsroom editor,
// share cards and clip export (WebM / GIF). Everything goes through the `api` object from app.js.
import { drawCandles, drawLines, offscreen, css, compact } from './charts.js';
import { t, lang, setLanguage, LANGUAGES } from './i18n.js';
import { GifEncoder } from './gif.js';

const $ = (id) => document.getElementById(id);

/* ═════════════════════════════ onboarding ═════════════════════════════ */

const PROVIDERS = [
  { id: 'openai', name: 'OpenAI', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', name: 'Anthropic', keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'gemini', name: 'Google Gemini', keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'openrouter', name: 'OpenRouter', keyUrl: 'https://openrouter.ai/keys' },
  { id: 'ollama', name: 'Ollama', keyUrl: 'https://ollama.com/download' },
];

const OB = { setup: null, prov: {}, selected: new Set(), limits: null, reconfigure: false };

export async function openOnboarding(api, { reconfigure }) {
  OB.reconfigure = reconfigure;
  const el = $('onboarding');
  el.hidden = false;
  el.innerHTML = `<div class="ob"><p class="sub">${api.esc(t('setup.validating'))}…</p></div>`;
  try {
    OB.setup = await (await fetch('api/setup')).json();
  } catch {
    OB.setup = { env: {}, saved: {}, ollama: { running: false, models: [] }, config: null, limits: {} };
  }
  OB.limits = { ...OB.setup.limits, ...(OB.setup.config?.limits ?? {}) };
  OB.selected = new Set(OB.setup.config?.models ?? []);
  for (const p of PROVIDERS) {
    const st = OB.prov[p.id] ?? { models: null, error: null, busy: false, open: false };
    if (p.id === 'ollama' && OB.setup.ollama.running) {
      st.models = OB.setup.ollama.models;
      st.open = true;
    }
    OB.prov[p.id] = st;
  }
  renderOnboarding(api);
  // Keys already in the environment: list their models straight away.
  for (const p of PROVIDERS) if (OB.setup.env[p.id] && !OB.prov[p.id].models) validate(api, p.id, '');
}

export function closeOnboarding() {
  const el = $('onboarding');
  el.hidden = true;
  el.replaceChildren();
}

function step() {
  if (OB.selected.size) return 3;
  if (Object.values(OB.prov).some((p) => p.models)) return 2;
  return 1;
}

function renderOnboarding(api) {
  const { esc, icon } = api;
  const el = $('onboarding');
  if (el.hidden) return;
  const typedKeys = new Map([...el.querySelectorAll('[data-key]')].map((input) => [input.dataset.key, input.value]));
  const s = step();
  const prov = PROVIDERS.map((p) => {
    const st = OB.prov[p.id];
    const env = OB.setup.env[p.id];
    const saved = OB.setup.saved[p.id];
    let state = '';
    if (p.id === 'ollama') state = OB.setup.ollama.running ? `<span class="prov-state ok">${esc(t('setup.ollamaRunning', { n: OB.setup.ollama.models.length }))}</span>` : `<span class="prov-state">${esc(t('setup.ollamaMissing'))}</span>`;
    else if (st.models) state = `<span class="prov-state ok">${icon('check')} ${esc(t('setup.valid', { n: st.models.length }))}</span>`;
    else if (st.error) state = `<span class="prov-state err">${esc(t('setup.invalid', { error: st.error }))}</span>`;
    else if (env) state = `<span class="prov-state">${esc(t('setup.keyInEnv'))}</span>`;
    else if (saved) state = `<span class="prov-state">${esc(t('setup.keySaved', { mask: saved }))}</span>`;
    const keyRow =
      p.id === 'ollama'
        ? ''
        : `<div class="prov-key"><input type="password" autocomplete="off" spellcheck="false" data-key="${p.id}" placeholder="${esc(t('setup.pasteKey'))}${env ? ' · ' + esc(t('setup.useEnv')) : ''}" aria-label="${esc(p.name)} ${esc(t('setup.pasteKey'))}" />
           <button class="btn" data-validate="${p.id}" ${st.busy ? 'disabled' : ''}>${esc(st.busy ? t('setup.validating') + '…' : t('setup.validate'))}</button></div>
           <a class="hint" href="${p.keyUrl}" target="_blank" rel="noopener noreferrer">${esc(t('setup.getKey'))} ↗</a>`;
    const models = st.models
      ? `<input type="search" data-filter="${p.id}" placeholder="${esc(t('setup.searchModels'))}" value="${esc(st.filter ?? '')}" />
         <div class="models-box">${st.models
           .filter((m) => !st.filter || `${m.id} ${m.name}`.toLowerCase().includes(st.filter.toLowerCase()))
           .slice(0, 200)
           .map((m) => {
             const spec = `${p.id}:${m.id}`;
             const price = m.price ? `$${(m.price.input * 1e6).toFixed(2)} / $${(m.price.output * 1e6).toFixed(2)} ${t('setup.perMillion')}` : '';
             return `<label class="model-opt"><input type="checkbox" data-model="${esc(spec)}" ${OB.selected.has(spec) ? 'checked' : ''}/> <span>${esc(m.id)}</span><span class="price">${esc(price)}</span></label>`;
           })
           .join('')}</div>`
      : '';
    return `<div class="prov${st.models ? ' on' : ''}"><div class="prov-top"><span class="prov-name">${esc(p.name)}</span>${state}</div>${keyRow}${models}</div>`;
  }).join('');
  const L = OB.limits;
  el.innerHTML = `<div class="ob">
    <h1><em>▌</em>${esc(t('setup.title'))}</h1>
    <p class="sub">${esc(t('setup.subtitle'))}</p>
    <div class="ob-steps">${['language', 'providers', 'models', 'budget'].map((k, i) => `<div class="${i === s ? 'on' : i < s ? 'done' : ''}">${i + 1} · ${esc(t('setup.step.' + k))}</div>`).join('')}</div>
    <div class="ob-section"><h2><span class="fk">01</span>${esc(t('setup.step.language'))}</h2>
      <div class="seg" id="ob-lang">${LANGUAGES.map(([c, n]) => `<button data-lang="${c}" class="${c === lang ? 'on' : ''}">${n}</button>`).join('')}</div></div>
    <div class="ob-section"><h2><span class="fk">02</span>${esc(t('setup.step.providers'))} · ${esc(t('setup.step.models'))}</h2>
      <p class="hint">${esc(t('setup.modelsHint'))} ${esc(t('setup.privacy'))}</p>
      <div class="ob-grid">${prov}</div></div>
    <div class="ob-section"><h2><span class="fk">03</span>${esc(t('setup.budget'))}</h2>
      <p class="hint">${esc(t('setup.budgetHint'))}</p>
      <div class="ob-budget">
        <label>${esc(t('setup.budgetUsd'))}<input type="number" min="0" step="0.5" data-limit="totalUsd" value="${L.totalUsd}" /></label>
        <label>${esc(t('setup.budgetTokens'))}<input type="number" min="0" step="10000" data-limit="totalTokens" value="${L.totalTokens}" /></label>
        <label>${esc(t('setup.agentTokens'))}<input type="number" min="0" step="1000" data-limit="agentTokens" value="${L.agentTokens}" /></label>
        <label>${esc(t('setup.rpm'))}<input type="number" min="1" step="1" data-limit="rpm" value="${L.rpm}" /></label>
      </div></div>
    <div class="ob-actions">
      <button class="btn primary" id="ob-start" ${OB.selected.size ? '' : 'disabled'}>${icon('play')}${esc(t('setup.start'))} · ${esc(t('setup.selected', { n: OB.selected.size }))}</button>
      <span class="ob-note" id="ob-msg"></span>
      ${OB.reconfigure ? `<button class="btn ghost" id="ob-close">${esc(t('btn.close'))}</button>` : ''}
    </div>
    <div class="offline-card"><div><b>${esc(t('setup.mode.offline'))}</b> — ${esc(t('setup.mode.offlineHint'))}</div><button class="btn" id="ob-offline">${esc(t('setup.offlineButton'))}</button></div>
    <p class="ob-note" style="margin-top:14px">${esc(t('app.disclaimerLong'))}</p>
  </div>`;

  el.querySelector('#ob-lang').onclick = async (e) => {
    const b = e.target.closest('button[data-lang]');
    if (!b) return;
    await setLanguage(b.dataset.lang, true);
    $('lang-select').value = lang;
    renderOnboarding(api);
  };
  for (const b of el.querySelectorAll('[data-validate]')) b.onclick = () => validate(api, b.dataset.validate, el.querySelector(`[data-key="${b.dataset.validate}"]`).value);
  for (const i of el.querySelectorAll('[data-key]')) {
    i.value = typedKeys.get(i.dataset.key) ?? '';
    i.onkeydown = (e) => e.key === 'Enter' && validate(api, i.dataset.key, i.value);
  }
  for (const i of el.querySelectorAll('[data-filter]'))
    i.oninput = () => {
      OB.prov[i.dataset.filter].filter = i.value;
      const pos = i.selectionStart;
      renderOnboarding(api);
      const again = $('onboarding').querySelector(`[data-filter="${i.dataset.filter}"]`);
      again.focus();
      again.setSelectionRange(pos, pos);
    };
  for (const c of el.querySelectorAll('[data-model]'))
    c.onchange = () => {
      if (c.checked && OB.selected.size >= 8) return (c.checked = false);
      c.checked ? OB.selected.add(c.dataset.model) : OB.selected.delete(c.dataset.model);
      renderOnboarding(api);
    };
  for (const i of el.querySelectorAll('[data-limit]')) i.onchange = () => (OB.limits[i.dataset.limit] = Math.max(0, Number(i.value) || 0));
  el.querySelector('#ob-start').onclick = () => save(api, 'llm');
  el.querySelector('#ob-offline').onclick = () => save(api, 'offline');
  const close = el.querySelector('#ob-close');
  if (close) close.onclick = closeOnboarding;
}

async function validate(api, provider, key) {
  const st = OB.prov[provider];
  if (st.busy) return;
  st.busy = true;
  st.error = null;
  renderOnboarding(api);
  try {
    const r = await fetch('api/setup/models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider, key: key || undefined }) });
    const j = await r.json();
    if (j.ok) st.models = j.models;
    else { st.models = null; st.error = j.error || `HTTP ${r.status}`; }
  } catch (e) {
    st.error = String(e.message || e);
  }
  st.busy = false;
  renderOnboarding(api);
}

async function save(api, mode) {
  const msg = $('ob-msg');
  if (msg) msg.textContent = t('setup.saving') + '…';
  try {
    const r = await fetch('api/setup/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode, models: [...OB.selected], language: lang, limits: OB.limits }),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
    if (OB.reconfigure && api.S.status.phase === 'live') {
      // A market is already running: the new setup applies on the next start.
      closeOnboarding();
      api.toast(t('setup.cli.saved', { dir: '.agentstreet' }) + ' — restart to apply');
    }
    // In first-run mode the server opens the market and the SSE status event takes over.
  } catch (e) {
    if (msg) msg.textContent = t('setup.error', { error: e.message || e });
  }
}

/* ═════════════════════════════ highlights ═════════════════════════════ */

export function toggleHighlights(api) {
  const pop = $('hl-pop');
  pop.hidden = !pop.hidden;
  if (!pop.hidden) renderHighlights(api);
}

function renderHighlights(api) {
  const { S, esc, frameAt, icon } = api;
  const list = $('hl-list');
  if (!S.highlights.length) {
    list.innerHTML = `<li style="grid-template-columns:1fr;cursor:default"><span class="muted">${esc(t('hl.empty'))}</span></li>`;
    return;
  }
  list.innerHTML = S.highlights
    .map(
      (h, i) =>
        `<li data-i="${i}"><span class="muted">${esc(frameAt(h.t).clock.slice(3))}</span><span class="hl-kind ${h.kind}">${esc(t('hl.kind.' + h.kind))}</span><span>${esc(h.title)}</span><button class="btn icon ghost" title="${esc(t('hl.watch'))}">${icon('play')}</button></li>`,
    )
    .join('');
  list.onclick = (e) => {
    const li = e.target.closest('li[data-i]');
    if (!li) return;
    const h = S.highlights[Number(li.dataset.i)];
    if (h.symbol) {
      const si = S.data.symbols.findIndex((s) => s.symbol === h.symbol);
      if (si >= 0) S.sel = si;
    }
    api.jump((h.t0 ?? h.t) - 10, true);
    $('hl-pop').hidden = true;
  };
}

/* ═════════════════════════════ trader X-ray ═════════════════════════════ */

const XR = { idx: null, exchange: null, fetched: 0 };

export async function openXray(api, idx) {
  if (!api.S.data?.agents[idx]) return;
  XR.idx = idx;
  XR.exchange = null;
  $('xray').hidden = false;
  refreshXray(api, true);
  if (api.S.status.mode === 'live' && api.S.data.agents[idx].kind === 'llm') fetchExchange(api);
}

async function fetchExchange(api) {
  try {
    const j = await (await fetch(`api/agent/${XR.idx}`)).json();
    XR.exchange = j.exchange;
    XR.usage = j.usage;
    XR.fetched = Date.now();
    refreshXray(api, true);
  } catch {}
}

export function refreshXray(api, force = false) {
  if ($('xray').hidden || XR.idx === null) return;
  const { S, esc, pct, arrow, cls, money, usd, frameAt, upper, T, pLabel, scores, icon } = api;
  if (!force && S.status.mode === 'live' && S.data.agents[XR.idx].kind === 'llm' && Date.now() - XR.fetched > 5000) fetchExchange(api);
  const a = S.data.agents[XR.idx];
  const sc = scores(T())[XR.idx];
  const snaps = S.data.equity;
  const end = upper(snaps, T(), (x) => x.t);
  const last = snaps[end - 1];
  const posRow = last?.pos?.[XR.idx];
  const f = frameAt(T());
  const positions = posRow
    ? posRow
        .map((q, si) => [S.data.symbols[si].symbol, q, (q * f.sym[si][0]) / 100])
        .filter(([, q]) => q !== 0)
    : [];
  const thoughts = S.data.thoughts.slice(0, upper(S.data.thoughts, T(), (x) => x.t)).filter((x) => x.agent === XR.idx).slice(-6).reverse();
  const trades = [];
  for (let i = upper(S.data.trades, T(), (x) => x[0]) - 1; i >= 0 && trades.length < 10; i--) {
    const x = S.data.trades[i];
    if (x[5] === XR.idx || x[6] === XR.idx) trades.push(x);
  }
  const ex = XR.exchange;
  const body = $('xray-body');
  body.innerHTML = `
    <div class="xr-name">@${esc(a.name)}</div>
    <div class="xr-sub">${esc(pLabel(a.personality))} · ${a.kind === 'llm' ? `<span class="badge llm">${esc(a.team)}</span>` : esc(t('xray.offlineBrain'))}</div>
    <div class="xr-big">
      <div><div class="muted">${esc(t('xray.equity'))}</div><div class="v">${money(sc.equity)}</div></div>
      <div><div class="muted">${esc(t('lb.return'))}</div><div class="v ${cls(sc.ret)}">${arrow(sc.ret)} ${pct(sc.ret)}</div></div>
      <div><div class="muted">${esc(t('lb.maxDD'))}</div><div class="v">${sc.mdd.toFixed(1)}%</div></div>
    </div>
    <div class="xr-curve"><canvas id="xr-canvas"></canvas></div>
    <div style="display:flex;gap:8px;margin-top:10px"><button class="btn" id="xr-share">${icon('share')}${esc(t('btn.share'))}</button></div>
    <h3>${esc(t('xray.positions'))}</h3>
    ${positions.length ? `<table class="xr-table">${positions.map(([s, q, v]) => `<tr><td><b>${s}</b></td><td class="${q > 0 ? 'up' : 'down'}">${q > 0 ? '+' : ''}${q.toLocaleString('en-US')}</td><td>${money(v)}</td></tr>`).join('')}</table>` : `<div class="muted">${esc(t('xray.flat'))}</div>`}
    <h3>${esc(t('xray.thoughts'))}</h3>
    ${thoughts.map((x) => `<div style="margin-bottom:5px"><span class="muted">${frameAt(x.t).clock.slice(3)}</span> ${esc(x.text)}</div>`).join('') || '<div class="muted">—</div>'}
    <h3>${esc(t('xray.trades'))}</h3>
    ${
      trades.length
        ? `<table class="xr-table">${trades
            .map((x) => {
              const buy = x[5] === XR.idx;
              return `<tr><td class="muted">${frameAt(x[0]).clock.slice(3)}</td><td class="${buy ? 'up' : 'down'}">${esc(t(buy ? 'xray.bought' : 'xray.sold'))}</td><td>${compact(x[3])} ${S.data.symbols[x[1]].symbol}</td><td>$${usd(x[2])}</td></tr>`;
            })
            .join('')}</table>`
        : '<div class="muted">—</div>'
    }
    ${
      a.kind === 'llm' && S.status.mode === 'live'
        ? `<h3>${esc(t('xray.lastPrompt'))}</h3>${
            ex
              ? `${ex.fallback ? `<div class="down" style="margin-bottom:6px">${esc(t('xray.fallback', { reason: ex.fallback }))}</div>` : ''}<pre class="xr-pre">${esc(ex.prompt)}</pre><h3>${esc(t('xray.lastReply'))} <span class="hint">${esc(t('xray.tokens', { n: ex.inputTokens + ex.outputTokens, ms: ex.ms }))}</span></h3><pre class="xr-pre">${esc(ex.reply || '—')}</pre>`
              : `<div class="muted">${esc(t('xray.noExchange'))}</div>`
          }`
        : ''
    }`;
  const pts = [[snaps[0]?.t ?? 1, 0]];
  const step = Math.max(1, Math.floor(end / 160));
  for (let k = 0; k < end; k += step) pts.push([snaps[k].t, (snaps[k].eq[XR.idx] / (a.startEquity / 100) - 1) * 100]);
  drawLines($('xr-canvas'), [{ label: a.name, color: S.colorOf[a.personality] ?? '#898781', points: pts }]);
  $('xr-share').onclick = () => openShare(api, XR.idx);
}

/* ═════════════════════════════ share card ═════════════════════════════ */

/** Draw a 1200×630 card for one trader into a canvas. Pure function of recorded data. */
export function drawShareCard(api, idx, canvas) {
  const { S, frameAt, upper, T, pLabel, scores } = api;
  const W = 1200, H = 630;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const a = S.data.agents[idx];
  const sc = scores(T())[idx];
  const snaps = S.data.equity.slice(0, upper(S.data.equity, T(), (x) => x.t));
  const start = a.startEquity / 100;
  const curve = [start, ...snaps.map((s) => s.eq[idx])];
  const up = css('--up'), down = css('--down'), brand = '#fab219', text = '#f0efec', muted = '#8b8a83';
  const mono = 'ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, monospace';
  ctx.fillStyle = '#0a0a09';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = brand;
  ctx.fillRect(0, 0, W, 6);
  // brand
  [[56, 64, 10, 24], [72, 52, 10, 36], [88, 40, 10, 48]].forEach(([x, y, w, h]) => ctx.fillRect(x, y, w, h));
  ctx.font = `800 26px ${mono}`;
  ctx.fillText('AGENTSTREET', 116, 82);
  ctx.font = `600 16px ${mono}`;
  ctx.fillStyle = muted;
  const sc0 = S.scenarios.find((x) => x.id === S.data.meta.scenario);
  ctx.fillText(`${(sc0?.name ?? S.data.meta.scenario).toUpperCase()} · SEED ${S.data.meta.seed} · ${frameAt(T()).clock}`, 116, 106);
  // name and role
  ctx.fillStyle = text;
  ctx.font = `800 54px ${mono}`;
  ctx.fillText(`@${a.name}`, 56, 200);
  ctx.font = `500 22px ${mono}`;
  ctx.fillStyle = '#c3c2b7';
  ctx.fillText(`${pLabel(a.personality)}${a.kind === 'llm' ? ` · ${a.team}` : ''}`, 56, 236);
  // big return
  const r = sc.ret;
  ctx.font = `900 112px ${mono}`;
  ctx.fillStyle = r >= 0 ? up : down;
  ctx.fillText(`${r >= 0 ? '▲ +' : '▼ '}${r.toFixed(1)}%`, 56, 372);
  ctx.font = `600 20px ${mono}`;
  ctx.fillStyle = muted;
  const peak = Math.max(...curve), trough = Math.min(...curve);
  ctx.fillText(`${t('xray.equity').toUpperCase()} $${Math.round(sc.equity).toLocaleString('en-US')}   ${t('share.peak').toUpperCase()} $${Math.round(peak).toLocaleString('en-US')}   ${t('share.trough').toUpperCase()} $${Math.round(trough).toLocaleString('en-US')}   ${t('lb.maxDD').toUpperCase()} ${sc.mdd.toFixed(1)}%`, 56, 420);
  // equity curve
  const x0 = 56, y0 = 452, w = W - 112, h = 118;
  const lo = Math.min(...curve, start), hi = Math.max(...curve, start);
  const X = (i) => x0 + (i / Math.max(1, curve.length - 1)) * w;
  const Y = (v) => y0 + (1 - (v - lo) / (hi - lo || 1)) * h;
  ctx.strokeStyle = '#36352f';
  ctx.setLineDash([4, 6]);
  ctx.beginPath();
  ctx.moveTo(x0, Y(start));
  ctx.lineTo(x0 + w, Y(start));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  curve.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
  ctx.lineTo(X(curve.length - 1), y0 + h);
  ctx.lineTo(x0, y0 + h);
  ctx.closePath();
  ctx.fillStyle = r >= 0 ? 'rgba(25,158,112,0.16)' : 'rgba(230,103,103,0.16)';
  ctx.fill();
  ctx.strokeStyle = r >= 0 ? up : down;
  ctx.lineWidth = 3;
  ctx.beginPath();
  curve.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
  ctx.stroke();
  // footer
  ctx.fillStyle = muted;
  ctx.font = `500 15px ${mono}`;
  ctx.fillText(t('share.footer'), 56, H - 22);
  ctx.textAlign = 'right';
  ctx.fillStyle = brand;
  ctx.fillText('github.com/bitovvnew/agentstreet', W - 56, H - 22);
  ctx.textAlign = 'left';
}

export function openShare(api, idx) {
  const { esc, icon, S, T } = api;
  const dlg = $('dlg-share');
  const a = S.data.agents[idx];
  $('share-body').innerHTML = `<h3><span class="fk">SC</span>${esc(t('share.title'))}</h3><p class="sub">${esc(t('share.subtitle'))}</p>
    <canvas class="share-preview" id="share-canvas"></canvas>
    <div class="dlg-actions"><button class="btn" id="share-link">${icon('share')}${esc(t('btn.copyLink'))}</button><button class="btn primary" id="share-dl">${icon('download')}${esc(t('btn.download'))}</button><button class="btn ghost" id="share-close">${esc(t('btn.close'))}</button></div>`;
  const canvas = $('share-canvas');
  drawShareCard(api, idx, canvas);
  $('share-dl').onclick = () =>
    canvas.toBlob((b) => download(b, `agentstreet-${a.name}-t${T()}.png`), 'image/png');
  $('share-link').onclick = async () => {
    const u = new URL(location.href);
    u.search = '';
    u.searchParams.set('t', String(T()));
    u.searchParams.set('xray', String(idx));
    u.searchParams.set('lb', 'agent');
    try {
      await navigator.clipboard.writeText(u.toString());
      api.toast(t('toast.copied'));
    } catch {
      api.toast(u.toString());
    }
  };
  $('share-close').onclick = () => dlg.close();
  dlg.showModal();
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ═════════════════════════════ newsroom editor ═════════════════════════════ */

const KINDS = ['breaking', 'earnings', 'product', 'rumor', 'scandal', 'analyst', 'social', 'legal', 'macro'];

export function openEditor(api) {
  const { esc, S, icon } = api;
  const dlg = $('dlg-editor');
  const form = $('editor-form');
  form.innerHTML = `<h3><span class="fk">ED</span>${esc(t('editor.title'))}</h3><p class="sub">${esc(t('editor.subtitle'))}</p>
    <div class="field-row"><label for="ed-sym">${esc(t('editor.ticker'))}</label><select class="field" id="ed-sym">${S.data.symbols.map((s, i) => `<option value="${s.symbol}" ${i === S.sel ? 'selected' : ''}>${s.symbol} — ${esc(s.name)}</option>`).join('')}<option value="">${esc(t('editor.wholeMarket'))}</option></select></div>
    <div class="field-row"><label for="ed-kind">${esc(t('editor.kind'))}</label><select class="field" id="ed-kind">${KINDS.map((k) => `<option value="${k}">${esc(t('editor.kind.' + k))}</option>`).join('')}</select></div>
    <div class="field-row"><label>${esc(t('editor.tone'))}</label><div class="seg" id="ed-tone"><button type="button" data-v="positive" class="on">▲ ${esc(t('editor.positive'))}</button><button type="button" data-v="negative">▼ ${esc(t('editor.negative'))}</button></div></div>
    <div class="field-row"><label for="ed-mag">${esc(t('editor.magnitude'))} <span id="ed-mag-v">1.0×</span></label><input class="field" type="range" id="ed-mag" min="0.2" max="2" step="0.1" value="1" /></div>
    <div class="field-row"><label>${esc(t('editor.when'))}</label><div class="seg" id="ed-when">${[0, 5, 15, 30].map((n) => `<button type="button" data-v="${n}" class="${n === 0 ? 'on' : ''}">${esc(n ? t('editor.inMin', { n }) : t('editor.now'))}</button>`).join('')}</div></div>
    <div class="field-row"><label for="ed-hl">${esc(t('editor.headline'))}</label><input type="text" id="ed-hl" maxlength="140" placeholder="${esc(t('editor.headlineHint'))}" /></div>
    <div class="dlg-actions"><button type="button" class="btn ghost" id="ed-cancel">${esc(t('btn.cancel'))}</button><button type="submit" class="btn primary" id="ed-send">${icon('pen')}${esc(t('editor.submit'))}</button></div>`;
  let tone = 'positive', when = 0;
  const seg = (id, cb) =>
    (form.querySelector('#' + id).onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      for (const x of form.querySelectorAll(`#${id} button`)) x.classList.toggle('on', x === b);
      cb(b.dataset.v);
    });
  seg('ed-tone', (v) => (tone = v));
  seg('ed-when', (v) => (when = Number(v)));
  form.querySelector('#ed-mag').oninput = (e) => (form.querySelector('#ed-mag-v').textContent = `${Number(e.target.value).toFixed(1)}×`);
  form.querySelector('#ed-cancel').onclick = () => dlg.close();
  form.onsubmit = (e) => {
    e.preventDefault();
    const symbol = form.querySelector('#ed-sym').value || null;
    const kind = symbol ? form.querySelector('#ed-kind').value : 'macro';
    api.cmd({ type: 'news', symbol, kind, tone, magnitude: Number(form.querySelector('#ed-mag').value), delay: when, headline: form.querySelector('#ed-hl').value.trim() || undefined });
    api.toast(t('editor.sent'));
    dlg.close();
  };
  dlg.showModal();
}

/* ═════════════════════════════ clip export ═════════════════════════════ */

export function openExport(api) {
  const { esc, S, icon, frameAt } = api;
  const dlg = $('dlg-export');
  const canWebm = typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.('video/webm');
  const ranges = [
    ...[30, 60, 120].map((n) => ({ label: t('export.last', { n }), from: Math.max(api.firstT(), api.T() - n), to: api.T() })),
    ...S.highlights.slice(-6).map((h) => ({ label: t('export.highlight', { title: h.title }), from: Math.max(api.firstT(), (h.t0 ?? h.t) - 15), to: Math.min(api.lastT(), h.t + 20), symbol: h.symbol })),
  ];
  $('export-body').innerHTML = `<h3><span class="fk">EX</span>${esc(t('export.title'))}</h3><p class="sub">${esc(t('export.subtitle'))}</p>
    <div class="field-row"><label for="ex-range">${esc(t('export.range'))}</label><select class="field" id="ex-range">${ranges.map((r, i) => `<option value="${i}">${esc(r.label)} · ${frameAt(r.from).clock.slice(3)}–${frameAt(r.to).clock.slice(3)}</option>`).join('')}</select></div>
    <div class="field-row"><label>${esc(t('export.format'))}</label><div class="seg" id="ex-fmt"><button type="button" data-v="webm" class="${canWebm ? 'on' : ''}" ${canWebm ? '' : 'disabled'}>${esc(t('export.webm'))}</button><button type="button" data-v="gif" class="${canWebm ? '' : 'on'}">${esc(t('export.gif'))}</button></div></div>
    <div class="field-row"><label>${esc(t('export.length'))}</label><div class="seg" id="ex-len">${[6, 10, 15].map((n) => `<button type="button" data-v="${n}" class="${n === 10 ? 'on' : ''}">${esc(t('export.seconds', { n }))}</button>`).join('')}</div></div>
    ${canWebm ? '' : `<p class="hint">${esc(t('export.noWebm'))}</p>`}
    <div class="progress"><div id="ex-bar"></div></div><p class="hint" id="ex-msg"></p>
    <div class="dlg-actions"><button class="btn ghost" id="ex-close">${esc(t('btn.close'))}</button><button class="btn primary" id="ex-go">${icon('film')}${esc(t('export.render'))}</button></div>`;
  let fmt = canWebm ? 'webm' : 'gif', secs = 10;
  const seg = (id, cb) =>
    ($(id).onclick = (e) => {
      const b = e.target.closest('button:not([disabled])');
      if (!b) return;
      for (const x of $(id).querySelectorAll('button')) x.classList.toggle('on', x === b);
      cb(b.dataset.v);
    });
  seg('ex-fmt', (v) => (fmt = v));
  seg('ex-len', (v) => (secs = Number(v)));
  $('ex-close').onclick = () => dlg.close();
  $('ex-go').onclick = async () => {
    const r = ranges[Number($('ex-range').value)];
    $('ex-go').disabled = true;
    try {
      const blob = await renderClip(api, r, fmt, secs, (p) => {
        $('ex-bar').style.width = `${Math.round(p * 100)}%`;
        $('ex-msg').textContent = t('export.rendering', { pct: Math.round(p * 100) });
      });
      $('ex-msg').textContent = t('export.done', { size: `${(blob.size / 1024 / 1024).toFixed(1)} MB` });
      download(blob, `agentstreet-${api.S.data.meta.scenario}-t${r.from}-${r.to}.${fmt}`);
    } catch (e) {
      $('ex-msg').textContent = String(e.message || e);
    }
    $('ex-go').disabled = false;
  };
  dlg.showModal();
}

/** Compose one frame of the clip at tick `t` onto a 960×540 canvas. */
function composeFrame(api, ctx, comp, tick, si, range) {
  const { S, frameAt, buildCandles, newsMarkers } = api;
  const W = 960, H = 540;
  const f = frameAt(tick);
  const mono = 'ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, monospace';
  ctx.fillStyle = '#0a0a09';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#fab219';
  ctx.fillRect(0, 0, W, 4);
  ctx.font = `800 20px ${mono}`;
  ctx.fillText('AGENTSTREET', 20, 34);
  const s = S.data.symbols[si];
  const [last, , , , , , fair, halted] = f.sym[si];
  const open = api.dayOpen(si, tick);
  const chg = (last / open - 1) * 100;
  ctx.fillStyle = '#f0efec';
  ctx.font = `800 28px ${mono}`;
  ctx.fillText(`${s.symbol}  $${(last / 100).toFixed(2)}`, 20, 76);
  ctx.fillStyle = chg >= 0 ? css('--up-text') : css('--down-text');
  ctx.font = `700 20px ${mono}`;
  ctx.fillText(`${chg >= 0 ? '▲ +' : '▼ '}${chg.toFixed(2)}%`, 300, 76);
  ctx.fillStyle = '#8b8a83';
  ctx.font = `600 14px ${mono}`;
  ctx.textAlign = 'right';
  ctx.fillText(`${f.clock}   INDEX ${f.index.toFixed(1)}   F&G ${f.fearGreed}`, W - 20, 34);
  ctx.fillText(`${s.name.toUpperCase()} · ${t('chart.trueValue').toUpperCase()} $${(fair / 100).toFixed(2)}`, W - 20, 76);
  ctx.textAlign = 'left';
  // candles of the selected range so far
  const tf = Math.max(1, Math.round((range.to - range.from) / 70));
  const candles = buildCandles(si, tick, tf, Math.ceil((tick - range.from) / tf) + 1).filter((c) => c.t1 >= range.from);
  const k0 = candles[0]?.k ?? 0;
  drawCandles(comp, candles, { showFair: true, news: newsMarkers(si, range.from, tick, tf, k0), hover: null });
  ctx.drawImage(comp, 20, 96);
  if (halted) {
    ctx.save();
    ctx.translate(W / 2, 290);
    ctx.rotate(-0.07);
    ctx.strokeStyle = '#fab219';
    ctx.lineWidth = 4;
    ctx.strokeRect(-150, -30, 300, 60);
    ctx.fillStyle = '#fab219';
    ctx.font = `900 28px ${mono}`;
    ctx.textAlign = 'center';
    ctx.fillText(t('chart.halted').toUpperCase(), 0, 10);
    ctx.restore();
    ctx.textAlign = 'left';
  }
  // latest headline caption
  const nIdx = api.upper(S.data.news, tick, (x) => x.t) - 1;
  const n = S.data.news[nIdx];
  if (n && tick - n.t < 40) {
    ctx.fillStyle = 'rgba(17,17,16,0.95)';
    ctx.fillRect(0, H - 54, W, 54);
    ctx.fillStyle = '#fab219';
    ctx.fillRect(0, H - 54, 70, 54);
    ctx.fillStyle = '#0b0b0b';
    ctx.font = `900 14px ${mono}`;
    ctx.fillText('WIRE', 14, H - 22);
    ctx.fillStyle = n.sentiment >= 0 ? css('--up-text') : css('--down-text');
    ctx.font = `700 16px ${mono}`;
    const text = `${n.sentiment >= 0 ? '▲' : '▼'} ${n.symbol ? n.symbol + ' ' : ''}${n.headline}`;
    ctx.fillText(text.length > 86 ? text.slice(0, 85) + '…' : text, 84, H - 22);
  }
  ctx.fillStyle = '#5f5e58';
  ctx.font = `500 11px ${mono}`;
  ctx.textAlign = 'right';
  ctx.fillText(t('share.footer'), W - 12, H - 62);
  ctx.textAlign = 'left';
}

async function renderClip(api, range, fmt, secs, onProgress) {
  const W = 960, H = 540;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const comp = offscreen(W - 40, H - 96 - 64);
  let si = api.S.sel;
  if (range.symbol) {
    const i = api.S.data.symbols.findIndex((s) => s.symbol === range.symbol);
    if (i >= 0) si = i;
  }
  const fps = fmt === 'gif' ? 12 : 30;
  const frames = Math.max(10, Math.round(secs * fps));
  const tickAt = (k) => Math.round(range.from + ((range.to - range.from) * k) / (frames - 1));
  if (fmt === 'gif') {
    const gif = new GifEncoder(W, H, { delayMs: Math.round(1000 / fps) });
    for (let k = 0; k < frames; k++) {
      composeFrame(api, ctx, comp, tickAt(k), si, range);
      gif.addFrame(ctx.getImageData(0, 0, W, H).data, k === frames - 1 ? 2500 : undefined);
      onProgress((k + 1) / frames);
      if (k % 4 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    return new Blob([gif.finish()], { type: 'image/gif' });
  }
  const stream = canvas.captureStream(fps);
  const rec = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm', videoBitsPerSecond: 6_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((r) => (rec.onstop = r));
  composeFrame(api, ctx, comp, tickAt(0), si, range);
  rec.start(250);
  for (let k = 0; k < frames; k++) {
    composeFrame(api, ctx, comp, tickAt(k), si, range);
    onProgress((k + 1) / frames);
    await new Promise((r) => setTimeout(r, 1000 / fps));
  }
  await new Promise((r) => setTimeout(r, 1200));
  rec.stop();
  await done;
  return new Blob(chunks, { type: 'video/webm' });
}

/* ═════════════════════════════ i18n refresh ═════════════════════════════ */

export function relocalize(api) {
  if (!$('onboarding').hidden) renderOnboarding(api);
  if (!$('hl-pop').hidden) renderHighlights(api);
  refreshXray(api, true);
}

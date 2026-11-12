// Canvas chart primitives for the AgentStreet terminal. No dependencies.

export const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Size a canvas to its box at device pixel ratio; returns { ctx, w, h }. */
export function fit(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, canvas.clientWidth);
  const h = Math.max(1, canvas.clientHeight);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

const FONT = '10.5px ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, monospace';

/** Pick "nice" tick values for an axis. */
export function niceTicks(min, max, count = 5) {
  const span = max - min || 1;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(v);
  return out;
}

export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/* ───────────────────────────── candlesticks ───────────────────────────── */

/**
 * candles: [{ t0, t1, o, h, l, c, v, fair, halted, clock }] oldest first (prices in dollars)
 * opts: { showFair, news: [{ i, up, headline }], hover: {x,y}|null }
 * Returns hit-test info for tooltips.
 */
export function drawCandles(canvas, candles, opts) {
  const { ctx, w, h } = fit(canvas);
  const up = css('--up'), down = css('--down'), grid = css('--line'), muted = css('--muted'), text = css('--text'), fairC = css('--fair');
  const padR = 66, padB = 20, padT = 14;
  const plotW = w - padR;
  const volH = Math.max(30, (h - padB - padT) * 0.18);
  const priceH = h - padB - padT - volH - 6;
  if (!candles.length) return null;

  let lo = Infinity, hi = -Infinity, vmax = 1;
  for (const c of candles) {
    lo = Math.min(lo, c.l);
    hi = Math.max(hi, c.h);
    vmax = Math.max(vmax, c.v);
  }
  // Let the true-value line widen the scale a little, but never squash the candles.
  if (opts.showFair) {
    const span = hi - lo || hi * 0.02;
    for (const c of candles) {
      if (!c.fair) continue;
      lo = Math.min(lo, Math.max(c.fair, lo - span * 0.6));
      hi = Math.max(hi, Math.min(c.fair, hi + span * 0.6));
    }
  }
  const pad = (hi - lo) * 0.08 || hi * 0.01 || 1;
  lo -= pad;
  hi += pad;
  const y = (p) => padT + (1 - (p - lo) / (hi - lo)) * priceH;
  const slot = plotW / candles.length;
  const cw = Math.max(1, Math.min(14, slot * 0.68));
  const x = (i) => i * slot + slot / 2;

  ctx.font = FONT;
  ctx.textBaseline = 'middle';
  // grid + price axis
  for (const v of niceTicks(lo, hi, 6)) {
    const yy = Math.round(y(v)) + 0.5;
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, yy);
    ctx.lineTo(plotW, yy);
    ctx.stroke();
    ctx.fillStyle = muted;
    ctx.fillText(v.toFixed(v < 10 ? 2 : v < 100 ? 2 : 1), plotW + 8, yy);
  }
  // halted shading
  ctx.fillStyle = 'rgba(250,178,25,0.08)';
  candles.forEach((c, i) => {
    if (c.halted) ctx.fillRect(i * slot, padT, slot + 0.5, priceH + volH + 6);
  });
  // volume
  const vy0 = padT + priceH + 6 + volH;
  candles.forEach((c, i) => {
    const vh = (c.v / vmax) * volH;
    ctx.fillStyle = c.c >= c.o ? up : down;
    ctx.globalAlpha = 0.35;
    if (vh > 0) ctx.fillRect(x(i) - cw / 2, vy0 - vh, cw, vh);
    ctx.globalAlpha = 1;
  });
  // fair value (clipped to the price pane)
  if (opts.showFair) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, padT, plotW, priceH);
    ctx.clip();
    ctx.strokeStyle = fairC;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    candles.forEach((c, i) => (i ? ctx.lineTo(x(i), y(c.fair)) : ctx.moveTo(x(i), y(c.fair))));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }
  // candles: up hollow, down filled (shape is the secondary encoding)
  candles.forEach((c, i) => {
    const isUp = c.c >= c.o;
    const col = isUp ? up : down;
    const xx = Math.round(x(i)) + 0.5;
    ctx.strokeStyle = col;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(xx, y(c.h));
    ctx.lineTo(xx, y(c.l));
    ctx.stroke();
    const top = y(Math.max(c.o, c.c));
    const bh = Math.max(1, Math.abs(y(c.o) - y(c.c)));
    if (isUp) {
      ctx.fillStyle = css('--panel');
      ctx.fillRect(xx - cw / 2, top, cw, bh);
      ctx.strokeRect(xx - cw / 2, top, cw, bh);
    } else {
      ctx.fillStyle = col;
      ctx.fillRect(xx - cw / 2, top, cw, bh);
    }
  });
  // news markers
  for (const n of opts.news || []) {
    const xx = x(n.i);
    const yy = padT + 2;
    ctx.fillStyle = n.up ? up : down;
    ctx.beginPath();
    if (n.up) {
      ctx.moveTo(xx, yy);
      ctx.lineTo(xx - 4, yy + 7);
      ctx.lineTo(xx + 4, yy + 7);
    } else {
      ctx.moveTo(xx, yy + 7);
      ctx.lineTo(xx - 4, yy);
      ctx.lineTo(xx + 4, yy);
    }
    ctx.fill();
  }
  // last price tag
  const last = candles[candles.length - 1];
  const ly = y(last.c);
  const lastUp = last.c >= candles[0].o;
  ctx.strokeStyle = lastUp ? up : down;
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.moveTo(0, Math.round(ly) + 0.5);
  ctx.lineTo(plotW, Math.round(ly) + 0.5);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = lastUp ? up : down;
  roundRect(ctx, plotW + 2, ly - 9, padR - 4, 18, 3);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = 'bold ' + FONT;
  ctx.fillText(last.c.toFixed(2), plotW + 8, ly);
  ctx.font = FONT;
  // fair label
  if (opts.showFair && last.fair) {
    const fy = Math.max(padT + 6, Math.min(padT + priceH - 6, y(last.fair)));
    if (Math.abs(fy - ly) > 16) {
      const off = y(last.fair) < padT ? ' ↑' : y(last.fair) > padT + priceH ? ' ↓' : '';
      ctx.fillStyle = css('--panel');
      ctx.fillRect(plotW + 1, fy - 13, padR - 2, 26);
      ctx.strokeStyle = fairC;
      ctx.lineWidth = 1;
      roundRect(ctx, plotW + 2.5, fy - 12.5, padR - 5, 25, 3);
      ctx.stroke();
      ctx.fillStyle = fairC;
      ctx.fillText('TRUE' + off, plotW + 8, fy - 5);
      ctx.fillText(last.fair.toFixed(2), plotW + 8, fy + 6);
    }
  }
  // time axis
  ctx.fillStyle = muted;
  ctx.textBaseline = 'alphabetic';
  const every = Math.max(1, Math.ceil(70 / slot));
  for (let i = 0; i < candles.length; i += every) {
    const label = candles[i].clock.slice(3);
    ctx.fillText(label, Math.max(0, x(i) - 16), h - 5);
  }
  // crosshair
  let hit = null;
  const hv = opts.hover;
  if (hv && hv.x < plotW && hv.y > padT && hv.y < h - padB) {
    const i = Math.max(0, Math.min(candles.length - 1, Math.floor(hv.x / slot)));
    ctx.strokeStyle = 'rgba(240,239,236,0.35)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(Math.round(x(i)) + 0.5, padT);
    ctx.lineTo(Math.round(x(i)) + 0.5, h - padB);
    ctx.moveTo(0, Math.round(hv.y) + 0.5);
    ctx.lineTo(plotW, Math.round(hv.y) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    if (hv.y < padT + priceH) {
      const p = lo + (1 - (hv.y - padT) / priceH) * (hi - lo);
      ctx.fillStyle = css('--panel-3');
      roundRect(ctx, plotW + 2, hv.y - 9, padR - 4, 18, 3);
      ctx.fill();
      ctx.fillStyle = text;
      ctx.textBaseline = 'middle';
      ctx.fillText(p.toFixed(2), plotW + 8, hv.y);
    }
    hit = { i, candle: candles[i], news: (opts.news || []).filter((n) => n.i === i) };
  }
  return hit;
}

/* ───────────────────────────── depth ───────────────────────────── */

export function drawDepth(canvas, bids, asks, hover) {
  const { ctx, w, h } = fit(canvas);
  const up = css('--up'), down = css('--down'), muted = css('--muted'), grid = css('--line');
  if (!bids.length && !asks.length) return null;
  const cb = [];
  let s = 0;
  for (const [p, q] of bids) cb.push([p, (s += q)]);
  const ca = [];
  s = 0;
  for (const [p, q] of asks) ca.push([p, (s += q)]);
  const mid = cb.length && ca.length ? (cb[0][0] + ca[0][0]) / 2 : (cb[0] || ca[0])[0];
  // Symmetric window around the mid so both sides are comparable; cap at ±5%.
  const reach = Math.min(mid * 0.05, Math.max(cb.length ? mid - cb[cb.length - 1][0] : 0, ca.length ? ca[ca.length - 1][0] - mid : 0, mid * 0.004));
  const pMin = mid - reach;
  const pMax = mid + reach;
  const inB = cb.filter(([p]) => p >= pMin);
  const inA = ca.filter(([p]) => p <= pMax);
  cb.length = 0;
  cb.push(...inB);
  ca.length = 0;
  ca.push(...inA);
  const qMax = Math.max(cb.length ? cb[cb.length - 1][1] : 0, ca.length ? ca[ca.length - 1][1] : 0, 1);
  const padB = 18, padT = 8, padL = 4, padR = 46;
  const X = (p) => padL + ((p - pMin) / (pMax - pMin || 1)) * (w - padL - padR);
  const Y = (q) => padT + (1 - q / qMax) * (h - padT - padB);
  ctx.font = FONT;
  ctx.fillStyle = muted;
  ctx.textBaseline = 'middle';
  for (const v of niceTicks(0, qMax, 4)) {
    const yy = Math.round(Y(v)) + 0.5;
    ctx.strokeStyle = grid;
    ctx.beginPath();
    ctx.moveTo(padL, yy);
    ctx.lineTo(w - padR, yy);
    ctx.stroke();
    ctx.fillText(compact(v), w - padR + 6, yy);
  }
  const area = (pts, color, dir) => {
    if (!pts.length) return;
    ctx.beginPath();
    ctx.moveTo(X(pts[0][0]), Y(0));
    let prevQ = 0;
    for (const [p, q] of pts) {
      ctx.lineTo(X(p), Y(prevQ));
      ctx.lineTo(X(p), Y(q));
      prevQ = q;
    }
    ctx.lineTo(dir < 0 ? padL : w - padR, Y(prevQ));
    ctx.lineTo(dir < 0 ? padL : w - padR, Y(0));
    ctx.closePath();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
  };
  area(cb, up, -1);
  area(ca, down, 1);
  ctx.strokeStyle = css('--line-2');
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.moveTo(X(mid), padT);
  ctx.lineTo(X(mid), h - padB);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = muted;
  const ticks = niceTicks(pMin, pMax, 5);
  for (const v of ticks) ctx.fillText(v.toFixed(2), X(v) - 14, h - 4);
  if (hover && hover.x > padL && hover.x < w - padR) {
    const p = pMin + ((hover.x - padL) / (w - padL - padR)) * (pMax - pMin);
    const side = cb.length && p <= cb[0][0] ? 'bid' : 'ask';
    let q = 0;
    if (side === 'bid') for (const [bp, bq] of cb) if (bp >= p) q = bq;
    if (side === 'ask') for (const [ap, aq] of ca) if (ap <= p) q = aq;
    ctx.strokeStyle = 'rgba(240,239,236,0.35)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(hover.x, padT);
    ctx.lineTo(hover.x, h - padB);
    ctx.stroke();
    ctx.setLineDash([]);
    return { price: p, qty: q, side };
  }
  return null;
}

/* ───────────────────────────── gauge ───────────────────────────── */

const FG_LABELS = ['Extreme fear', 'Fear', 'Neutral', 'Greed', 'Extreme greed'];
export function fgLabel(v) {
  return FG_LABELS[Math.min(4, Math.floor(v / 20))];
}

export function drawGauge(canvas, value) {
  const { ctx, w, h } = fit(canvas);
  const cx = w / 2;
  const r = Math.max(20, Math.min(w / 2 - 10, h - 58));
  const cy = 22 + r + 6;
  const segs = [css('--down'), css('--serious'), '#5a5955', css('--up'), css('--good')];
  const gap = 0.025;
  for (let i = 0; i < 5; i++) {
    const a0 = Math.PI + (i / 5) * Math.PI + gap;
    const a1 = Math.PI + ((i + 1) / 5) * Math.PI - gap;
    ctx.strokeStyle = segs[i];
    ctx.globalAlpha = Math.floor(value / 20) === i || (value === 100 && i === 4) ? 1 : 0.32;
    ctx.lineWidth = Math.max(6, r * 0.16);
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.arc(cx, cy, r, a0, a1);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  const a = Math.PI + (value / 100) * Math.PI;
  ctx.strokeStyle = css('--text');
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(a) * (r - 4), cy + Math.sin(a) * (r - 4));
  ctx.stroke();
  ctx.fillStyle = css('--text');
  ctx.beginPath();
  ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.textAlign = 'center';
  ctx.font = 'bold 20px ui-monospace, Menlo, Consolas, monospace';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(String(Math.round(value)), cx, cy + 24);
  ctx.font = FONT;
  ctx.fillStyle = css('--text-2');
  ctx.fillText(fgLabel(value).toUpperCase(), cx, cy + 38);
  ctx.fillStyle = css('--muted');
  ctx.fillText('FEAR & GREED', cx, 11);
  ctx.textAlign = 'left';
}

/* ───────────────────────────── sparkline ───────────────────────────── */

export function drawSpark(canvas, values, color, base) {
  const { ctx, w, h } = fit(canvas);
  if (values.length < 2) return;
  let lo = Math.min(...values), hi = Math.max(...values);
  if (base !== undefined) {
    lo = Math.min(lo, base);
    hi = Math.max(hi, base);
  }
  const span = hi - lo || 1;
  const X = (i) => (i / (values.length - 1)) * (w - 2) + 1;
  const Y = (v) => 2 + (1 - (v - lo) / span) * (h - 4);
  if (base !== undefined) {
    ctx.strokeStyle = css('--line-2');
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(0, Y(base));
    ctx.lineTo(w, Y(base));
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  values.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
  ctx.stroke();
}

/* ───────────────────────────── multi-line (equity curves) ───────────────────────────── */

/**
 * series: [{ label, color, points: [[t, value]] }] — value in % return.
 */
export function drawLines(canvas, series, hover) {
  const { ctx, w, h } = fit(canvas);
  const all = series.flatMap((s) => s.points);
  if (all.length < 2) return null;
  let lo = Math.min(0, ...all.map((p) => p[1]));
  let hi = Math.max(0, ...all.map((p) => p[1]));
  const pad = (hi - lo) * 0.08 || 1;
  lo -= pad;
  hi += pad;
  const t0 = Math.min(...all.map((p) => p[0]));
  const t1 = Math.max(...all.map((p) => p[0]));
  const padR = 44, padB = 6, padT = 6;
  const X = (t) => ((t - t0) / (t1 - t0 || 1)) * (w - padR);
  const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);
  ctx.font = FONT;
  ctx.textBaseline = 'middle';
  for (const v of niceTicks(lo, hi, 4)) {
    ctx.strokeStyle = v === 0 ? css('--line-2') : css('--line');
    ctx.beginPath();
    ctx.moveTo(0, Math.round(Y(v)) + 0.5);
    ctx.lineTo(w - padR, Math.round(Y(v)) + 0.5);
    ctx.stroke();
    ctx.fillStyle = css('--muted');
    ctx.fillText((v > 0 ? '+' : '') + v.toFixed(Math.abs(hi - lo) < 4 ? 1 : 0) + '%', w - padR + 5, Y(v));
  }
  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    s.points.forEach(([t, v], i) => (i ? ctx.lineTo(X(t), Y(v)) : ctx.moveTo(X(t), Y(v))));
    ctx.stroke();
  }
  if (hover && hover.x < w - padR) {
    const t = t0 + (hover.x / (w - padR)) * (t1 - t0);
    ctx.strokeStyle = 'rgba(240,239,236,0.35)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(X(t), padT);
    ctx.lineTo(X(t), h - padB);
    ctx.stroke();
    ctx.setLineDash([]);
    const rows = series.map((s) => {
      let best = s.points[0];
      for (const p of s.points) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
      ctx.fillStyle = s.color;
      ctx.strokeStyle = css('--panel');
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(X(best[0]), Y(best[1]), 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      return { label: s.label, color: s.color, value: best[1], t: best[0] };
    });
    return rows;
  }
  return null;
}

/* ───────────────────────────── scrubber background ───────────────────────────── */

export function drawScrub(canvas, points, marks, t0, t1, cursor) {
  const { ctx, w, h } = fit(canvas);
  if (points.length < 2) return;
  const lo = Math.min(...points.map((p) => p[1]));
  const hi = Math.max(...points.map((p) => p[1]));
  const X = (t) => ((t - t0) / (t1 - t0 || 1)) * w;
  const Y = (v) => 4 + (1 - (v - lo) / (hi - lo || 1)) * (h - 8);
  ctx.fillStyle = 'rgba(250,178,25,0.06)';
  ctx.fillRect(0, 0, w, h);
  ctx.beginPath();
  ctx.moveTo(0, h);
  points.forEach(([t, v]) => ctx.lineTo(X(t), Y(v)));
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fillStyle = 'rgba(240,239,236,0.06)';
  ctx.fill();
  ctx.strokeStyle = css('--text-2');
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  points.forEach(([t, v], i) => (i ? ctx.lineTo(X(t), Y(v)) : ctx.moveTo(X(t), Y(v))));
  ctx.stroke();
  for (const m of marks) {
    ctx.fillStyle = m.color;
    ctx.fillRect(Math.round(X(m.t)) - 1, 0, 2, m.tall ? h : h * 0.4);
  }
  const cx = X(cursor);
  ctx.fillStyle = 'rgba(11,11,10,0.55)';
  ctx.fillRect(cx, 0, w - cx, h);
  ctx.fillStyle = css('--brand');
  ctx.fillRect(Math.round(cx) - 1, 0, 2, h);
  ctx.beginPath();
  ctx.arc(cx, h / 2, 5, 0, Math.PI * 2);
  ctx.fill();
}

export function compact(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e4) return (n / 1e3).toFixed(0) + 'k';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}

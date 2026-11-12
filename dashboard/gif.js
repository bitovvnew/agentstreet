// Minimal animated-GIF encoder (GIF89a, LZW, global palette, looping).
// Works in the browser and in Node (pure JS, no DOM). Frames are RGBA buffers;
// colours are mapped to a fixed 256-colour palette built for the terminal theme,
// which keeps encoding fast and the output small.

/** 6x7x6 colour cube (252) + 4 theme greys = 256 colours. */
export function terminalPalette() {
  const p = [];
  const R = [0, 51, 102, 153, 204, 255];
  const G = [0, 43, 85, 128, 170, 213, 255];
  const B = [0, 51, 102, 153, 204, 255];
  for (const r of R) for (const g of G) for (const b of B) p.push([r, g, b]);
  p.push([11, 11, 10], [18, 18, 17], [38, 38, 36], [240, 239, 236]);
  return p;
}

function nearestIndexer(palette) {
  const cache = new Map();
  return (r, g, b) => {
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const c = palette[i];
      const dr = c[0] - r, dg = c[1] - g, db = c[2] - b;
      const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
      if (d < bd) (bd = d), (best = i);
    }
    cache.set(key, best);
    return best;
  };
}

class Bytes {
  constructor() {
    this.chunks = [];
    this.buf = new Uint8Array(1 << 16);
    this.len = 0;
  }
  byte(b) {
    if (this.len === this.buf.length) this.flush();
    this.buf[this.len++] = b & 0xff;
  }
  word(w) {
    this.byte(w & 0xff);
    this.byte(w >> 8);
  }
  str(s) {
    for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i));
  }
  flush() {
    this.chunks.push(this.buf.slice(0, this.len));
    this.len = 0;
  }
  bytes() {
    this.flush();
    const total = this.chunks.reduce((a, c) => a + c.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of this.chunks) out.set(c, o), (o += c.length);
    return out;
  }
}

function lzw(out, indices, minCode) {
  const clear = 1 << minCode;
  const eoi = clear + 1;
  let codeSize = minCode + 1;
  let next = eoi + 1;
  let dictMap = new Map();
  let bitBuf = 0, bitCount = 0;
  const block = [];
  const emitByte = (b) => {
    block.push(b);
    if (block.length === 255) {
      out.byte(255);
      for (const x of block) out.byte(x);
      block.length = 0;
    }
  };
  const emit = (code) => {
    bitBuf |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      emitByte(bitBuf & 0xff);
      bitBuf >>>= 8;
      bitCount -= 8;
    }
  };
  out.byte(minCode);
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prefix * 256 + k;
    const found = dictMap.get(key);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    emit(prefix);
    if (next < 4096) {
      dictMap.set(key, next++);
      if (next > 1 << codeSize && codeSize < 12) codeSize++;
    } else {
      emit(clear);
      dictMap = new Map();
      codeSize = minCode + 1;
      next = eoi + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (bitCount > 0) emitByte(bitBuf & 0xff);
  if (block.length) {
    out.byte(block.length);
    for (const x of block) out.byte(x);
  }
  out.byte(0);
}

export class GifEncoder {
  constructor(width, height, { palette = terminalPalette(), delayMs = 80, loop = 0 } = {}) {
    this.w = width;
    this.h = height;
    this.palette = palette;
    this.delay = Math.max(2, Math.round(delayMs / 10));
    this.index = nearestIndexer(palette);
    this.out = new Bytes();
    const o = this.out;
    o.str('GIF89a');
    o.word(width);
    o.word(height);
    o.byte(0xf7); // global colour table, 8 bits, 256 entries
    o.byte(0);
    o.byte(0);
    for (let i = 0; i < 256; i++) {
      const c = palette[i] || [0, 0, 0];
      o.byte(c[0]), o.byte(c[1]), o.byte(c[2]);
    }
    // NETSCAPE looping extension
    o.byte(0x21), o.byte(0xff), o.byte(11), o.str('NETSCAPE2.0'), o.byte(3), o.byte(1), o.word(loop), o.byte(0);
  }

  /** rgba: Uint8ClampedArray / Uint8Array of width*height*4 */
  addFrame(rgba, delayMs) {
    const n = this.w * this.h;
    const idx = new Uint8Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) idx[i] = this.index(rgba[j], rgba[j + 1], rgba[j + 2]);
    const o = this.out;
    o.byte(0x21), o.byte(0xf9), o.byte(4), o.byte(0);
    o.word(delayMs ? Math.max(2, Math.round(delayMs / 10)) : this.delay);
    o.byte(0), o.byte(0);
    o.byte(0x2c), o.word(0), o.word(0), o.word(this.w), o.word(this.h), o.byte(0);
    lzw(o, idx, 8);
  }

  finish() {
    this.out.byte(0x3b);
    return this.out.bytes();
  }
}

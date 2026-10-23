// THE NOMAD: Hollow map (task O, Milestone 3). Act IV, "Inside the Cloud": Paradise is a lie.
//
// Run from the project root:
//   node tools/assets/hollow.mjs                 build hollow.png + hollow.json, verify, write previews
//   node tools/assets/hollow.mjs --check         verify the existing hollow.json / hollow.png only
//   node tools/assets/hollow.mjs --debug DIR     also write debug layers (masks, reach map) into DIR
//
// What it does:
//   1. ART. Turns raw-assets/wasteland-map.png (the Act III ruined city) into the dead city:
//      mirror -> new props painted in daylight colours -> night grade (darker, desaturated,
//      blue-black shadows) -> corruption boosted + black tendrils creeping -> smoke banks, ash
//      drifts and ash speckle -> the fires and lamps composited back with a soft glow.
//   2. DATA. Builds src/data/maps/hollow.json from wasteland.json: colliders and hazards mirrored
//      (x' = 1448 - x - w), building sides padded, new prop colliders, smoke hazards, spawn on the
//      west edge, checkpoints, pickups, inspectables, crawler groups and the `hollow` marker.
//   3. VERIFY. Flood-fills the player's 16x10 feet body (the wasteland-check pattern) and prints a
//      PASS/FAIL list: reachability, a corrupt/fire-free route to the hatch, sealed edges,
//      clearances, crawler distances and chokes. Exits non-zero on failure.
//   4. PREVIEWS. tools/previews/hollow-small.png (700 px wide) and tools/previews/hollow-overlay.png.

import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_PNG = path.join(ROOT, 'raw-assets', 'wasteland-map.png');
const SRC_JSON = path.join(ROOT, 'src', 'data', 'maps', 'wasteland.json');
const HATCH_CARD = path.join(ROOT, 'public', 'assets', 'props', 'hatch.png');
const SIGNPOST_CARD = path.join(ROOT, 'public', 'assets', 'props', 'signpost.png');
const DRONE_SHEET = path.join(ROOT, 'public', 'assets', 'creatures', 'drone.png');
const OUT_PNG = path.join(ROOT, 'public', 'assets', 'maps', 'hollow.png');
const OUT_JSON = path.join(ROOT, 'src', 'data', 'maps', 'hollow.json');
const PREVIEW_SMALL = path.join(ROOT, 'tools', 'previews', 'hollow-small.png');
const PREVIEW_OVERLAY = path.join(ROOT, 'tools', 'previews', 'hollow-overlay.png');

const W = 1448;
const H = 1086;

// ---------------------------------------------------------------------------
// Small helpers.

const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
const mix = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, v) => { const t = clamp((v - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

/** Seeded random numbers, so every run paints exactly the same map. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth value noise in 0..1 and a few octaves of it (fbm). */
function hash2(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function valueNoise(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return mix(mix(a, b, sx), mix(c, d, sx), sy);
}
function fbm(x, y, seed, octaves = 4) {
  let sum = 0, amp = 0.5, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x, y, seed + o * 101);
    norm += amp;
    x *= 2.03; y *= 2.03; amp *= 0.5;
  }
  return sum / norm;
}

/** Gaussian-ish blur of one float channel (three box passes each way; radius ~ sigma). */
function blur(src, w, h, radius) {
  const r = Math.max(1, Math.round(radius));
  let a = Float32Array.from(src);
  let b = new Float32Array(src.length);
  const pass = (from, to, horizontal) => {
    const len = horizontal ? w : h, lines = horizontal ? h : w;
    const at = horizontal ? (line, i) => line * w + i : (line, i) => i * w + line;
    const norm = 1 / (2 * r + 1);
    for (let line = 0; line < lines; line++) {
      let sum = 0;
      for (let i = -r; i <= r; i++) sum += from[at(line, clamp(i, 0, len - 1))];
      for (let i = 0; i < len; i++) {
        to[at(line, i)] = sum * norm;
        sum += from[at(line, Math.min(len - 1, i + r + 1))] - from[at(line, Math.max(0, i - r))];
      }
    }
  };
  for (let k = 0; k < 3; k++) {
    pass(a, b, true); [a, b] = [b, a];
    pass(a, b, false); [a, b] = [b, a];
  }
  return a;
}

// ---------------------------------------------------------------------------
// A float RGB canvas (0..1 per channel) with alpha blending, used for the whole map.

class Canvas {
  constructor(w, h, data = null) {
    this.w = w; this.h = h;
    this.data = data || new Float32Array(w * h * 3);
  }
  static async load(file, { flop = false } = {}) {
    let img = sharp(file).removeAlpha();
    if (flop) img = img.flop(); // flop = mirror left <-> right
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
    const c = new Canvas(info.width, info.height);
    for (let i = 0; i < data.length; i++) c.data[i] = data[i] / 255;
    return c;
  }
  /** Blend colour [r, g, b] over pixel (x, y) with opacity a. */
  blend(x, y, col, a = 1) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return;
    const i = (y * this.w + x) * 3, t = Math.min(1, a);
    this.data[i] += (col[0] - this.data[i]) * t;
    this.data[i + 1] += (col[1] - this.data[i + 1]) * t;
    this.data[i + 2] += (col[2] - this.data[i + 2]) * t;
  }
  /** Multiply pixel (x, y) toward black by `amount` (0..1): used for contact shadows. */
  darken(x, y, amount) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3, k = 1 - clamp(amount);
    this.data[i] *= k; this.data[i + 1] *= k; this.data[i + 2] *= k;
  }
  /** Add light (additive blend), used for glows. */
  add(x, y, col, a = 1) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3;
    this.data[i] += col[0] * a; this.data[i + 1] += col[1] * a; this.data[i + 2] += col[2] * a;
  }
  toBuffer() {
    const out = Buffer.alloc(this.w * this.h * 3);
    for (let i = 0; i < out.length; i++) out[i] = Math.round(clamp(this.data[i]) * 255);
    return out;
  }
  async save(file) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await sharp(this.toBuffer(), { raw: { width: this.w, height: this.h, channels: 3 } })
      .png({ compressionLevel: 9 }).toFile(file);
  }
}

/** A float single-channel mask the size of the map. */
const newMask = () => new Float32Array(W * H);

/** Paints a soft elliptical contact shadow centred on (cx, cy). */
function contactShadow(img, cx, cy, rx, ry, strength = 0.55) {
  for (let y = Math.floor(cy - ry); y <= cy + ry; y++) {
    for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
      const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
      if (d < 1) img.darken(x, y, strength * (1 - smoothstep(0.35, 1, d)));
    }
  }
}

// ---------------------------------------------------------------------------
// ART 1. Masks read from the mirrored daylight picture, before anything is painted on it.
//   fire     bright orange/yellow pixels (fires, lamp heads): these keep burning in the dark
//   pool     the warm light those fires throw on the ground around them (a wide blur of `fire`)
//   toxic    the green sludge; it stays green so the hazard still reads
//   magenta  the corruption veins
//   corrupt  the black corrupted ground (dark pixels near the veins or inside a corrupt hazard)

function analyse(base, corruptRects, deadLamps) {
  const fire = newMask(), dead = newMask(), toxic = newMask(), magenta = newMask(), dark = newMask(), region = newMask();
  for (let p = 0; p < W * H; p++) {
    const r = base.data[p * 3], g = base.data[p * 3 + 1], b = base.data[p * 3 + 2];
    fire[p] = smoothstep(0.85, 0.95, r) * smoothstep(0.42, 0.6, g) * smoothstep(0.25, 0.45, r - b);
    toxic[p] = smoothstep(0.08, 0.25, g - Math.max(r, b)) * smoothstep(0.35, 0.55, g);
    magenta[p] = smoothstep(0.12, 0.32, Math.min(r, b) - g) * smoothstep(0.42, 0.7, Math.max(r, b));
    dark[p] = 1 - smoothstep(0.1, 0.3, lum(r, g, b));
  }
  for (const c of corruptRects) {
    for (let y = c.y; y < c.y + c.h; y++) for (let x = c.x; x < c.x + c.w; x++) region[y * W + x] = 1;
  }
  // Dead lamps: their bright pixels stop glowing and are remembered in `dead` (painted as dark glass).
  for (const l of deadLamps) {
    for (let y = l.y; y < l.y + l.h; y++) {
      for (let x = l.x; x < l.x + l.w; x++) { const p = y * W + x; dead[p] = fire[p]; fire[p] = 0; }
    }
  }
  const pool = blur(fire, W, H, 26);
  const deadPool = blur(dead, W, H, 22); // the painted lamp-light on the ground around a dead lamp
  const veinsNear = blur(magenta, W, H, 16);
  const regionSoft = blur(region, W, H, 10);
  const corrupt = newMask();
  for (let p = 0; p < W * H; p++) {
    pool[p] = smoothstep(0.002, 0.04, pool[p]);
    deadPool[p] = smoothstep(0.002, 0.04, deadPool[p]);
    corrupt[p] = Math.max(smoothstep(0.002, 0.03, veinsNear[p]), regionSoft[p]) * dark[p];
  }
  return { fire, dead, deadPool, pool, toxic, magenta, corrupt };
}

// ---------------------------------------------------------------------------
// ART 2. Night grade: darker (about 55 %), mostly grey, shadows pushed toward blue-black.
// Warm light pools near fires and the toxic sludge keep more of their colour and brightness.

const GRADE = {
  darkness: 0.5,      // overall brightness multiplier
  curve: 1.1,         // > 1 deepens the shadows a little more than the highlights
  saturation: 0.34,   // 0 = grey, 1 = original colour
};

function nightGrade(img, masks) {
  const d = img.data;
  for (let p = 0; p < W * H; p++) {
    const i = p * 3;
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const L = lum(r, g, b);
    const pool = masks.pool[p], tox = masks.toxic[p];
    // 1. desaturate (less near fires and on the sludge)
    const sat = mix(GRADE.saturation, 0.9, Math.max(pool, tox));
    let r1 = L + (r - L) * sat, g1 = L + (g - L) * sat, b1 = L + (b - L) * sat;
    // 2. darken with a gentle curve
    let k = mix(GRADE.darkness, 0.8, pool * 0.85);
    k = mix(k, 0.72, tox);
    r1 = Math.pow(clamp(r1), GRADE.curve) * k;
    g1 = Math.pow(clamp(g1), GRADE.curve) * k;
    b1 = Math.pow(clamp(b1), GRADE.curve) * k;
    // 3. cool the shadows toward blue-black (not inside warm light)
    const w = (1 - smoothstep(0, 0.45, L)) * (1 - pool) * (1 - tox);
    r1 *= mix(0.95, 0.8, w);
    g1 *= mix(0.98, 0.9, w);
    b1 = b1 * mix(1.05, 1.32, w) + 0.012 * w;
    // 4. a dead lamp's glass goes dull
    const dg = (1 - 0.6 * masks.dead[p]) * (1 - 0.3 * masks.deadPool[p]);
    d[i] = r1 * dg; d[i + 1] = g1 * dg; d[i + 2] = b1 * dg;
  }
}

/** Corruption: vivid magenta veins, deeper black corrupted ground. */
function intensifyCorruption(img, base, masks) {
  const d = img.data;
  for (let p = 0; p < W * H; p++) {
    const i = p * 3;
    const m = masks.magenta[p], c = masks.corrupt[p];
    if (c > 0) {
      d[i] = d[i] * (1 - 0.6 * c) + 0.012 * c;
      d[i + 1] = d[i + 1] * (1 - 0.65 * c);
      d[i + 2] = d[i + 2] * (1 - 0.5 * c) + 0.024 * c;
    }
    if (m > 0) {
      const bright = 0.55 + 0.6 * Math.max(base.data[i], base.data[i + 2]);
      d[i] = mix(d[i], 1.0 * bright, m);
      d[i + 1] = mix(d[i + 1], 0.2 * bright, m);
      d[i + 2] = mix(d[i + 2], 0.86 * bright, m);
    }
  }
}

/** Puts the original fire/lamp pixels back and adds a soft additive glow around them. */
function compositeEmissive(img, base, masks, smoke) {
  const d = img.data;
  const ch = (k) => { const m = newMask(); for (let p = 0; p < W * H; p++) m[p] = masks.fire[p] * base.data[p * 3 + k]; return m; };
  const small = [0, 1, 2].map((k) => blur(ch(k), W, H, 3));
  const large = [0, 1, 2].map((k) => blur(ch(k), W, H, 14));
  const veinGlow = blur(masks.magenta, W, H, 5);
  const toxGlow = blur(masks.toxic, W, H, 8);
  for (let p = 0; p < W * H; p++) {
    const i = p * 3;
    const veil = 1 - 0.55 * (smoke ? smoke[p] : 0); // thick smoke swallows some of the glow
    const e = Math.pow(masks.fire[p], 0.8) * (smoke ? 1 - 0.35 * smoke[p] : 1);
    for (let k = 0; k < 3; k++) {
      d[i + k] = mix(d[i + k], base.data[i + k], e);
      d[i + k] += (small[k][p] * 0.6 + large[k][p] * 1.05) * veil;
    }
    const v = veinGlow[p] * 0.45 * veil;
    d[i] += v; d[i + 1] += v * 0.15; d[i + 2] += v * 0.8;
    const t = toxGlow[p] * 0.14 * veil;
    d[i] += t * 0.35; d[i + 1] += t * 0.9; d[i + 2] += t * 0.2;
  }
}


// ---------------------------------------------------------------------------
// ART 3. Small RGBA sprites, pixel fonts and drawing helpers for the new props.

class Sprite {
  constructor(w, h) { this.w = w; this.h = h; this.px = new Float32Array(w * h * 4); }
  static async load(file, { crop = null, width = null, height = null, kernel = 'nearest' } = {}) {
    let img = sharp(file).ensureAlpha();
    if (crop) img = img.extract({ left: crop.x, top: crop.y, width: crop.w, height: crop.h });
    if (width) img = img.resize(width, height, { kernel, fit: 'fill' });
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
    const s = new Sprite(info.width, info.height);
    for (let i = 0; i < data.length; i++) s.px[i] = data[i] / 255;
    return s;
  }
  get(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return [0, 0, 0, 0];
    const i = (y * this.w + x) * 4;
    return [this.px[i], this.px[i + 1], this.px[i + 2], this.px[i + 3]];
  }
  put(x, y, col, a = 1) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.px.set([col[0], col[1], col[2], a], (y * this.w + x) * 4);
  }
  /** Straight-alpha "over": paints col with opacity a on top of what's there. */
  set(x, y, col, a = 1) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return;
    const i = (y * this.w + x) * 4;
    const da = this.px[i + 3], oa = a + da * (1 - a);
    for (let k = 0; k < 3; k++) this.px[i + k] = (col[k] * a + this.px[i + k] * da * (1 - a)) / oa;
    this.px[i + 3] = oa;
  }
  rect(x, y, w, h, col, a = 1) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.set(xx, yy, col, a);
  }
  text(str, x, y, col, a = 1, font = FONT5) {
    for (const ch of str) {
      const glyph = font[ch];
      if (glyph) glyph.forEach((row, gy) => [...row].forEach((c, gx) => { if (c === '1') this.set(x + gx, y + gy, col, a); }));
      x += (glyph ? glyph[0].length : 3) + 1;
    }
  }
}

// 5x7 capitals for the sign, 3x5 digits for the hatch stencil.
const FONT5 = {
  A: ['.111.', '1...1', '1...1', '11111', '1...1', '1...1', '1...1'],
  D: ['1111.', '1...1', '1...1', '1...1', '1...1', '1...1', '1111.'],
  E: ['11111', '1....', '1....', '1111.', '1....', '1....', '11111'],
  I: ['.111.', '..1..', '..1..', '..1..', '..1..', '..1..', '.111.'],
  P: ['1111.', '1...1', '1...1', '1111.', '1....', '1....', '1....'],
  R: ['1111.', '1...1', '1...1', '1111.', '1.1..', '1..1.', '1...1'],
  S: ['.1111', '1....', '1....', '.111.', '....1', '....1', '1111.'],
  T: ['11111', '..1..', '..1..', '..1..', '..1..', '..1..', '..1..'],
};
const STENCIL3 = {
  0: ['111', '1.1', '1.1', '1.1', '111'],
  1: ['.1.', '11.', '.1.', '.1.', '111'],
};

/**
 * Draws a sprite onto the map, centred on (cx, cy), rotated by `angle` radians and scaled.
 * Nearest-neighbour sampling keeps the pixel look. Coverage is written into `cover`
 * (so the fire/corruption masks can ignore pixels the props now hide).
 */
function drawSprite(img, cover, spr, cx, cy, { angle = 0, scale = 1, alpha = 1 } = {}) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const half = Math.hypot(spr.w, spr.h) * scale / 2 + 1;
  for (let y = Math.floor(cy - half); y <= cy + half; y++) {
    for (let x = Math.floor(cx - half); x <= cx + half; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const u = Math.floor((cos * dx + sin * dy) / scale + spr.w / 2);
      const v = Math.floor((-sin * dx + cos * dy) / scale + spr.h / 2);
      const [r, g, b, a] = spr.get(u, v);
      if (a < 0.04) continue;
      img.blend(x, y, [r, g, b], a * alpha);
      if (cover && x >= 0 && y >= 0 && x < W && y < H) cover[y * W + x] = Math.max(cover[y * W + x], a * alpha);
    }
  }
}

/** Little rounded stone (used for rubble, the cairn and the shrine ring). */
function stone(spr, cx, cy, rx, ry, col, rand) {
  for (let y = Math.floor(cy - ry); y <= cy + ry; y++) {
    for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
      const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
      if (d > 1) continue;
      // light from the top-left, dark rim at the bottom-right
      const shade = 1 + 0.22 * ((cx - x) / rx + (cy - y) / ry) * 0.5 - (d > 0.8 ? 0.25 : 0) + (rand() - 0.5) * 0.08;
      spr.set(x, y, col.map((c) => clamp(c * shade)));
    }
  }
}

// ---------------------------------------------------------------------------
// ART 4. The props. Each painter draws inside (or around) its footprint from PROPS.

/** A cracked concrete pad (flat ground, walkable) around the hatch. */
function paintConcretePad(img, cover, r, rand) {
  const slab = new Sprite(r.w, r.h + 3);
  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      // chipped, irregular edges
      const edge = Math.min(x, y, r.w - 1 - x, r.h - 1 - y);
      if (edge < 6 * fbm(x / 4, y / 4, 71) - 1.5) continue;
      const n = fbm(x / 7, y / 7, 72);
      let c = (0.37 + 0.1 * n + (rand() - 0.5) * 0.05) * (0.72 + 0.32 * fbm(x / 11, y / 11, 73));
      if (fbm(x / 6, y / 6, 74) > 0.74 && edge > 1) { slab.put(x, y, [0.27, 0.23, 0.19], 1); continue; } // broken-out chunk
      if (edge < 1) c *= 0.7;                                   // dark outline
      else if (y < 2 || x < 2) c *= 1.12;                        // top-left lip catches light
      if ((x === Math.floor(r.w / 2) || y === Math.floor(r.h / 2)) && edge > 2) c *= 0.82; // expansion joints
      slab.put(x, y, [c, c * 0.98, c * 0.93], 1);
    }
  }
  // the slab's thickness: a darker south face
  for (let x = 2; x < r.w - 2; x++) for (let k = 0; k < 3; k++) {
    if (slab.get(x, r.h - 1)[3] > 0) slab.put(x, r.h + k, [0.26, 0.25, 0.24], 1);
  }
  // cracks: thin dark random walks with a pale lip
  for (let k = 0; k < 11; k++) {
    let x = rand() * r.w, y = rand() * r.h, ang = rand() * Math.PI * 2;
    const len = 10 + rand() * 24;
    for (let s = 0; s < len; s++) {
      ang += (rand() - 0.5) * 0.9;
      x += Math.cos(ang); y += Math.sin(ang) * 0.8;
      if (slab.get(Math.round(x), Math.round(y))[3] === 0) break;
      slab.put(Math.round(x), Math.round(y), [0.12, 0.11, 0.1], 1);
      if (slab.get(Math.round(x), Math.round(y) + 1)[3] > 0) slab.set(Math.round(x), Math.round(y) + 1, [0.55, 0.54, 0.5], 0.45);
    }
  }
  // soot stains
  for (let k = 0; k < 5; k++) {
    const sx = rand() * r.w, sy = rand() * r.h, sr = 3 + rand() * 6;
    for (let y = -sr; y <= sr; y++) for (let x = -sr; x <= sr; x++) {
      const d = Math.hypot(x, y) / sr;
      if (d < 1 && slab.get(Math.round(sx + x), Math.round(sy + y))[3] > 0) slab.set(Math.round(sx + x), Math.round(sy + y), [0.12, 0.11, 0.1], 0.3 * (1 - d));
    }
  }
  contactShadow(img, r.x + r.w / 2, r.y + r.h + 2, r.w / 2 + 3, 5, 0.45);
  drawSprite(img, cover, slab, r.x + r.w / 2, r.y + (r.h + 3) / 2);
}

async function paintHatch(img, cover) {
  const f = PROPS.hatch.foot;
  const rand = rng(101);
  paintConcretePad(img, cover, { x: f.x - 16, y: f.y - 12, w: f.w + 32, h: f.h + 24 }, rand);

  // The hatch.png card (a striped door with a ladder), squashed to lie flat in the 3/4 view.
  const lidH = f.h - 4;
  const card = await Sprite.load(HATCH_CARD, { crop: { x: 2, y: 2, w: 138, h: 165 }, width: f.w, height: lidH, kernel: 'lanczos3' });
  // Close it: a riveted steel lid over the dark ladder opening (it stays shut without the keycard).
  const lx0 = Math.round(f.w * 0.2), lx1 = Math.round(f.w * 0.8), ly0 = Math.round(lidH * 0.2), ly1 = Math.round(lidH * 0.84);
  for (let y = ly0; y < ly1; y++) {
    for (let x = lx0; x < lx1; x++) {
      const border = x === lx0 || y === ly0 || x === lx1 - 1 || y === ly1 - 1;
      const plate = ((x + y) % 4 === 0) || ((x - y + 400) % 4 === 0) ? 0.6 : 0.47; // diamond tread
      const c = border ? 0.2 : plate + (y - ly0 < 2 ? 0.06 : 0);
      card.put(x, y, [c * 0.95, c, c * 1.06], 1);
    }
  }
  const mx = Math.floor((lx0 + lx1) / 2), my = Math.floor((ly0 + ly1) / 2);
  for (let x = mx - 6; x <= mx + 6; x++) { card.put(x, my, [0.66, 0.67, 0.7], 1); card.put(x, my + 1, [0.16, 0.16, 0.18], 1); } // lever
  for (const [rx, ry] of [[lx0 + 2, ly0 + 2], [lx1 - 3, ly0 + 2], [lx0 + 2, ly1 - 3], [lx1 - 3, ly1 - 3]]) {
    card.put(rx, ry, [0.72, 0.72, 0.74], 1); card.put(rx + 1, ry + 1, [0.15, 0.15, 0.17], 1); // rivets
  }
  // Faint "01" stencil, a few worn pixels of yellow paint on the lid.
  const stencil = [0.86, 0.74, 0.32];
  let sx = mx - 3;
  for (const ch of '01') {
    STENCIL3[ch].forEach((row, gy) => [...row].forEach((c, gx) => {
      if (c === '1' && (gx + gy * 3 + ch.charCodeAt(0)) % 5 !== 0) card.set(sx + gx, my - 7 + gy, stencil, 0.8);
    }));
    sx += 4;
  }
  // a cracked keycard reader on the rim
  card.rect(f.w - 8, lidH - 7, 5, 4, [0.12, 0.12, 0.13]);
  card.put(f.w - 7, lidH - 6, [0.5, 0.08, 0.06], 1);

  // Thickness of the frame: a dark south face, then a contact shadow on the pad.
  contactShadow(img, f.x + f.w / 2 + 2, f.y + f.h - 1, f.w / 2 + 4, 6, 0.6);
  for (let x = f.x + 1; x < f.x + f.w - 1; x++) {
    for (let k = 0; k < 4; k++) img.blend(x, f.y + lidH + k, [0.14, 0.13, 0.12], 1);
    img.blend(x, f.y + lidH, [0.62, 0.48, 0.12], 0.5); // worn stripe paint on the lip
  }
  drawSprite(img, cover, card, f.x + f.w / 2, f.y + lidH / 2);
  for (let y = f.y; y < f.y + f.h; y++) for (let x = f.x; x < f.x + f.w; x++) cover[y * W + x] = 1;
}

async function paintEstates(img, cover) {
  const f = PROPS.estates.foot;
  const rand = rng(202);
  const ox = f.x, oy = f.y;

  // 1. A broken stretch of the estate's boundary wall (back, left).
  const wall = new Sprite(64, 26);
  for (let x = 0; x < 64; x++) {
    const top = Math.round(4 + 7 * fbm(x / 9, 3, 211) + (x > 44 ? (x - 44) * 0.6 : 0)); // jagged, crumbling to the right
    for (let y = top; y < 26; y++) {
      const face = y - top < 3;                                // top surface of the wall
      const brickRow = Math.floor((y - top) / 4), brickCol = Math.floor((x + (brickRow % 2) * 4) / 8);
      const mortar = !face && ((y - top) % 4 === 3 || (x + (brickRow % 2) * 4) % 8 === 0);
      const v = (hash2(brickCol, brickRow, 9) - 0.5) * 0.08;
      const col = face ? [0.66, 0.6, 0.55] : mortar ? [0.3, 0.27, 0.25] : [0.55 + v, 0.42 + v, 0.36 + v];
      wall.put(x, y, col.map((c) => c * (y > 22 ? 0.8 : 1)), 1);
    }
  }
  contactShadow(img, ox + 34, oy + 26, 36, 5, 0.5);
  drawSprite(img, cover, wall, ox + 34, oy + 13);

  // 2. The signpost prop, snapped off and lying on its side (wood keyed out of the grass card).
  const card = await Sprite.load(SIGNPOST_CARD);
  const post = new Sprite(90, 130);
  for (let y = 0; y < 130; y++) {
    for (let x = 0; x < 90; x++) {
      const cx = x + 28, cy = y + 22;
      const inBoards = cy < 88, inPost = cx >= 56 && cx < 90;
      if (!inBoards && !inPost) continue;
      const [r, g, b, a] = card.get(cx, cy);
      const wood = r > g && g >= b * 0.85 && r - b > 0.1 && !(r > 0.7 && b > 0.5);
      const outline = r + g + b < 0.6 && !(g > r + 0.02 && g > b);
      if (a > 0.5 && (wood || outline)) post.put(x, y, [r, g, b], 1);
    }
  }
  contactShadow(img, ox + 84, oy + 26, 26, 7, 0.45);
  drawSprite(img, cover, post, ox + 82, oy + 19, { angle: -1.42, scale: 0.42 });

  // 3. The sign itself, cracked in two: "PARAD|ISE" over "ESTAT|ES".
  const ink = [0.15, 0.29, 0.31], cream = [0.86, 0.81, 0.68], trim = [0.24, 0.47, 0.47], gold = [0.8, 0.64, 0.3];
  const panel = (w, h, line1, line2, x1, x2, breakLeft, breakRight) => {
    const p = new Sprite(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // jagged broken edges
        if (breakRight && x > w - 1 - Math.round(2 * hash2(y, 1, 5) + (y % 5 === 0 ? 1 : 0))) continue;
        if (breakLeft && x < Math.round(2 * hash2(y, 2, 6) + (y % 4 === 0 ? 1 : 0))) continue;
        const border = y === 0 || y === h - 1 || (!breakLeft && x === 0) || (!breakRight && x === w - 1);
        const inner = y === 1 || y === h - 2 || (!breakLeft && x === 1) || (!breakRight && x === w - 2);
        const grime = 0.9 + 0.12 * fbm(x / 4, y / 4, 230);
        p.put(x, y, border ? trim : inner ? gold : cream.map((c) => c * grime), 1);
      }
    }
    p.text(line1, x1, 3, ink);
    p.text(line2, x2, 12, ink);
    // soot and scratches
    for (let k = 0; k < 18; k++) p.set(Math.floor(rand() * w), Math.floor(rand() * h), [0.2, 0.18, 0.16], 0.5);
    return p;
  };
  // Rubble from the wall first, so the sign pieces lie on top of it.
  const rubble = new Sprite(f.w, f.h);
  for (let k = 0; k < 16; k++) {
    const g = 0.42 + rand() * 0.2;
    stone(rubble, 4 + rand() * (f.w - 8), 18 + rand() * (f.h - 20), 1.5 + rand() * 2.5, 1.2 + rand() * 1.6, [g * 1.1, g * 0.9, g * 0.8], rand);
  }
  drawSprite(img, cover, rubble, ox + f.w / 2, oy + f.h / 2);
  const left = panel(36, 22, 'PARAD', 'ESTAT', 3, 3, false, true);
  const right = panel(24, 22, 'ISE', 'ES', 1, 1, true, false);
  contactShadow(img, ox + 40, oy + 36, 34, 6, 0.5);
  drawSprite(img, cover, left, ox + 22, oy + 30, { angle: 0.05 });
  drawSprite(img, cover, right, ox + 55, oy + 31, { angle: 0.2 });
  // a chunk of the wall that fell across the crack, and a stray letter tile in the ash
  const chunk = new Sprite(6, 5);
  stone(chunk, 3, 2.5, 3, 2.2, [0.6, 0.5, 0.44], rand);
  drawSprite(img, cover, chunk, ox + 41, oy + 40);
  const tile = new Sprite(8, 9);
  tile.rect(0, 0, 8, 9, cream);
  tile.text('E', 2, 1, ink);
  drawSprite(img, cover, tile, ox + 98, oy + 36, { angle: -0.5 });
}

function paintShrine(img, cover) {
  const f = PROPS.shrine.foot;
  const rand = rng(303);
  const s = new Sprite(f.w, f.h + 14); // extra headroom for the ribbon stick
  const top = 14;                        // sprite row that sits on the footprint's top edge
  // ring of small stones laid by pilgrims
  for (let k = 0; k < 14; k++) {
    if (rand() < 0.2) continue;                     // a few have been kicked away
    const a = (k / 14) * Math.PI * 2 + (rand() - 0.5) * 0.4;
    const g = 0.4 + rand() * 0.12, rr = 0.9 + rand() * 0.6;
    stone(s, 16 + Math.cos(a) * (13 + rand() * 3), top + 14 + Math.sin(a) * (7 + rand() * 2), 1.4 * rr, 1.1 * rr, [g, g * 0.97, g * 0.92], rand);
  }
  // the cairn: big stones at the base, smaller on top
  const cairn = [[10, 19, 5, 3.4], [21, 19, 5, 3.4], [15.5, 15, 4.6, 3], [12, 11.5, 3.4, 2.4], [19, 11.8, 3.2, 2.3], [15.5, 8, 3, 2.2], [15.5, 5, 2.2, 1.6]];
  for (const [x, y, rx, ry] of cairn) {
    const g = 0.46 + rand() * 0.14;
    stone(s, x, top + y - 6, rx, ry, [g * 1.02, g, g * 0.95], rand);
  }
  // a stick in the cairn with faded ribbons tied to it
  for (let y = 0; y < top + 2; y++) s.put(16 + (y < 4 ? 1 : 0), y, [0.36, 0.25, 0.16], 1);
  // offerings: a tin can, a bottle, a dead flower bundle, two candle stubs
  s.rect(4, top + 6, 2, 3, [0.62, 0.62, 0.6]); s.put(4, top + 6, [0.8, 0.8, 0.78], 1);
  s.rect(27, top + 4, 2, 4, [0.3, 0.46, 0.34]); s.put(27, top + 3, [0.42, 0.56, 0.44], 1);
  for (const [x, y] of [[6, top + 10], [7, top + 9], [8, top + 10], [7, top + 11]]) s.put(x, y, [0.44, 0.32, 0.26], 1);
  s.put(24, top + 10, [0.84, 0.8, 0.68], 1); s.put(24, top + 11, [0.84, 0.8, 0.68], 1);
  s.put(10, top + 12, [0.84, 0.8, 0.68], 1);
  // the dim lamp: a small iron lantern (its light is added after the grade)
  const lx = 33, ly = top + 3;
  s.rect(lx, ly, 5, 7, [0.14, 0.13, 0.12]);
  s.rect(lx + 1, ly + 1, 3, 4, [0.62, 0.46, 0.24]);
  s.put(lx + 2, ly - 1, [0.2, 0.19, 0.17], 1);
  s.rect(lx - 1, ly + 7, 7, 1, [0.12, 0.11, 0.1]);

  contactShadow(img, f.x + 17, f.y + 18, 20, 7, 0.55);
  contactShadow(img, f.x + lx + 3, f.y + 11, 5, 2.5, 0.5);
  drawSprite(img, cover, s, f.x + f.w / 2, f.y - top + (f.h + 14) / 2);
}

async function paintDroneHusk(img, cover) {
  const f = PROPS['drone-husk'].foot;
  const rand = rng(404);
  const cx = f.x + f.w / 2, cy = f.y + f.h / 2 + 2;

  // 1. The crash scar: a scorched gouge where it skidded in from the north.
  for (let t = 0; t <= 1; t += 0.012) {
    const x = cx + 5 - t * 5 + Math.sin(t * 9) * 1.5, y = cy - 44 + t * 36, half = 1.5 + t * 5;
    for (let k = -half - 2; k <= half + 2; k++) {
      if (rand() < 0.22) continue;                               // broken, gritty edges
      const edge = Math.abs(k) > half;
      const burnt = 0.4 + 0.5 * fbm((x + k) / 3, y / 3, 405);
      img.blend(x + k, y, edge ? [0.46, 0.42, 0.38] : [0.1, 0.09, 0.09], edge ? 0.3 : burnt * (0.35 + 0.4 * t));
    }
  }
  // asphalt chunks thrown aside
  const debris = new Sprite(90, 90);
  for (let k = 0; k < 16; k++) {
    const a = rand() * Math.PI * 2, d = 26 + rand() * 16;
    const g = 0.3 + rand() * 0.15;
    stone(debris, 45 + Math.cos(a) * d, 45 + Math.sin(a) * d * 0.7, 1 + rand() * 1.8, 0.8 + rand() * 1.2, [g, g, g * 1.04], rand);
  }
  // white shell shards
  for (let k = 0; k < 12; k++) {
    const a = rand() * Math.PI * 2, d = 20 + rand() * 18;
    debris.put(Math.round(45 + Math.cos(a) * d), Math.round(45 + Math.sin(a) * d * 0.7), [0.82, 0.84, 0.86], 1);
  }
  drawSprite(img, cover, debris, cx, cy);

  // 2. Frame 0 of the Warden drone, 2x, dead: no hover glow, dark cracked lens, soot.
  const frame = await Sprite.load(DRONE_SHEET, { crop: { x: 0, y: 0, w: 32, h: 26 } });
  const husk = new Sprite(64, 52);
  for (let y = 0; y < 52; y++) {
    for (let x = 0; x < 64; x++) {
      let [r, g, b, a] = frame.get(x >> 1, y >> 1);
      if (a < 0.4) continue;
      const cyan = b > r + 0.15 && g > r + 0.08;
      const inLens = x >= 22 && x < 42 && y >= 24 && y < 42;
      if (cyan && inLens) { r = 0.07; g = 0.08; b = 0.09; }          // the lens is dark
      else if (cyan) { r = 0.3; g = 0.34; b = 0.36; }                  // dead indicator lights
      else {
        const L = lum(r, g, b);
        const soot = 0.42 + 0.34 * fbm(x / 5, y / 5, 410);
        r = mix(L, r, 0.5) * soot; g = mix(L, g, 0.5) * soot; b = mix(L, b, 0.5) * soot;
      }
      husk.put(x, y, [r, g, b], 1);
    }
  }
  // cracks across the lens from an impact point
  for (let k = 0; k < 6; k++) {
    let x = 30, y = 31, ang = (k / 6) * Math.PI * 2 + rand() * 0.5;
    for (let s = 0; s < 9; s++) {
      x += Math.cos(ang); y += Math.sin(ang); ang += (rand() - 0.5) * 0.6;
      const [, , , a] = husk.get(Math.round(x), Math.round(y));
      if (a > 0) husk.put(Math.round(x), Math.round(y), [0.42, 0.44, 0.46], 1);
    }
  }
  // snap off the tip of the right wing and drop it beside the body
  const wingBit = new Sprite(10, 8);
  for (let y = 16; y < 30; y++) for (let x = 56; x < 64; x++) {
    const p = husk.get(x, y);
    if (p[3] > 0) { wingBit.put(x - 56, Math.floor((y - 16) / 2), p.slice(0, 3), 1); husk.put(x, y, [0, 0, 0], 0); }
  }
  contactShadow(img, cx + 2, cy + 10, 30, 11, 0.7);
  drawSprite(img, cover, husk, cx, cy - 2, { angle: -0.45 });
  drawSprite(img, cover, wingBit, cx + 23, cy + 19, { angle: 1.1 }); // inside the footprint
  for (let y = f.y; y < f.y + f.h; y++) for (let x = f.x; x < f.x + f.w; x++) cover[y * W + x] = Math.max(cover[y * W + x], 0.5);
}

/** Painted after the grade: the hatch reader's red LED and the shrine lamp's dim glow. */
function paintPropLights(img) {
  const glow = (x, y, radius, col, strength) => {
    for (let yy = Math.floor(y - radius); yy <= y + radius; yy++) {
      for (let xx = Math.floor(x - radius); xx <= x + radius; xx++) {
        const d = Math.hypot(xx - x, yy - y) / radius;
        if (d < 1) img.add(xx, yy, col, strength * (1 - d) * (1 - d));
      }
    }
  };
  const f = PROPS.hatch.foot;
  const ledX = f.x + f.w - 7, ledY = f.y + f.h - 4 - 6;
  img.blend(ledX, ledY, [1, 0.2, 0.14], 1);
  glow(ledX + 0.5, ledY + 0.5, 6, [1, 0.15, 0.1], 0.35);
  const s = PROPS.shrine.foot;
  // faded ribbons tied to the cairn's stick (night colours: the grade would turn them grey)
  const ribbons = [[0.5, 0.13, 0.12], [0.52, 0.5, 0.44], [0.16, 0.36, 0.36], [0.5, 0.36, 0.14]];
  ribbons.forEach((col, k) => {
    const len = 7 + k * 2, dir = k % 2 === 0 ? 1 : -1;
    for (let t = 0; t < len; t++) {
      const x = s.x + 17 + dir * (t * 0.75) + Math.sin(t * 0.9 + k) * 0.8;
      const y = s.y - 13 + k * 2 + t * 0.5;
      img.blend(x, y, col, 0.95 - t / (len * 1.8));
    }
  });
  const lx = s.x + 33 + 2, ly = s.y + 3 + 2;
  img.blend(lx, ly, [1, 0.74, 0.4], 0.9); img.blend(lx, ly + 1, [0.95, 0.62, 0.3], 0.8);
  glow(lx + 0.5, ly + 1, 16, [1, 0.6, 0.25], 0.26);
}

// ---------------------------------------------------------------------------
// ART 5. Black tendrils creeping out of the corrupted ground (painted after the grade).

function paintTendrils(img, masks, avoid) {
  const rand = rng(505);
  const solid = newMask();
  for (let p = 0; p < W * H; p++) solid[p] = masks.corrupt[p] > 0.45 ? 1 : 0;
  const soft = blur(solid, W, H, 12);
  const seeds = [];
  for (let tries = 0; tries < 400000 && seeds.length < 70; tries++) {
    const x = Math.floor(rand() * W), y = Math.floor(rand() * H), p = y * W + x;
    if (!solid[p] || soft[p] > 0.55 || soft[p] < 0.3) continue;      // on the rim of the corruption
    if (avoid.some((a) => Math.hypot(x - a.x, y - a.y) < a.r)) continue;
    seeds.push({ x, y });
  }
  const grad = (x, y) => {
    const i = Math.round(y) * W + Math.round(x);
    if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) return [0, 0];
    return [soft[i - 1] - soft[i + 1], soft[i - W] - soft[i + W]]; // points away from the corruption
  };
  const black = [0.018, 0.008, 0.026], vein = [0.9, 0.16, 0.78];
  const grow = (x, y, ang, len, thick, veined, depth) => {
    for (let s = 0; s < len; s++) {
      const [gx, gy] = grad(x, y);
      const out = Math.atan2(gy, gx);
      if (gx || gy) ang += Math.sin(out - ang) * 0.08;               // keep heading outward
      ang += (rand() - 0.5) * 0.35;
      x += Math.cos(ang); y += Math.sin(ang);
      if (avoid.some((a) => Math.hypot(x - a.x, y - a.y) < a.r)) return;
      const t = thick * (1 - s / len) + 0.6;
      for (let yy = -t; yy <= t; yy++) for (let xx = -t; xx <= t; xx++) {
        if (xx * xx + yy * yy <= t * t * 0.55) img.blend(x + xx, y + yy, black, 0.9);
      }
      if (veined && s < len * 0.6 && t > 1.3) img.blend(x, y, vein, 0.55 * (1 - s / (len * 0.6)));
      if (depth < 2 && rand() < 0.035) grow(x, y, ang + (rand() < 0.5 ? -0.7 : 0.7), (len - s) * 0.6, t * 0.7, false, depth + 1);
    }
  };
  for (const sd of seeds) {
    const [gx, gy] = grad(sd.x, sd.y);
    grow(sd.x, sd.y, Math.atan2(gy, gx) + (rand() - 0.5), 18 + rand() * 46, 1.4 + rand() * 1.4, rand() < 0.35, 0);
  }
}

/** Black nanite residue clinging to the crashed drone: the swarm brought it down. */
function paintNaniteResidue(img, r) {
  const rand = rng(909);
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2 + 4;
  for (let k = 0; k < 9; k++) {
    let ang = (k / 9) * Math.PI * 2 + (rand() - 0.5) * 0.5;
    let x = cx + Math.cos(ang) * r.w * 0.36, y = cy + Math.sin(ang) * r.h * 0.34;
    const len = 8 + rand() * 16;
    for (let s = 0; s < len; s++) {
      ang += (rand() - 0.5) * 0.5;
      x += Math.cos(ang); y += Math.sin(ang) * 0.8;
      const t = 1.6 * (1 - s / len) + 0.5;
      for (let yy = -t; yy <= t; yy++) for (let xx = -t; xx <= t; xx++) {
        if (xx * xx + yy * yy <= t * t * 0.55) img.blend(x + xx, y + yy, [0.02, 0.008, 0.026], 0.85);
      }
    }
  }
  for (let k = 0; k < 10; k++) {
    const a = rand() * Math.PI * 2, d = 0.25 + rand() * 0.3;
    img.blend(cx + Math.cos(a) * r.w * d, cy + Math.sin(a) * r.h * d, [0.85, 0.16, 0.75], 0.5 + rand() * 0.3);
  }
}

// ---------------------------------------------------------------------------
// ART 6. Smoke banks, ash drifts along walls and a fine ash speckle (painted after the grade).

/**
 * Each bank is a cluster of soft round puffs (lit on their top side, dark underneath), denser over
 * the hazard rect and thinning out over `spread` px around it, with a little noise for wisps.
 * Returns the smoke density mask (0..1) so the fire glow can be veiled under thick smoke.
 */
function paintSmoke(img) {
  const density = newMask(), light = newMask();
  SMOKE_BANKS.forEach((bank, k) => {
    const rand = rng(800 + k);
    const R = bank.hazard;
    const [fx, fy] = bank.spread;
    const outside = (x, y) => Math.hypot(Math.max(R.x - x, 0, x - (R.x + R.w)) / fx, Math.max(R.y - y, 0, y - (R.y + R.h)) / fy);
    const puffs = Math.round(((R.w + fx * 2) * (R.h + fy * 2)) / 260);
    for (let i = 0; i < puffs; i++) {
      // pick a centre; puffs far outside the rect are rarer
      const px = R.x - fx + rand() * (R.w + fx * 2), py = R.y - fy + rand() * (R.h + fy * 2);
      const o = outside(px, py);
      if (rand() < o * 1.1) continue;
      const r = (7 + rand() * 13) * (1 - 0.4 * o), rx = r * 1.25;
      const strength = 0.55 * (1 - 0.6 * o);
      for (let y = Math.floor(py - r); y <= py + r; y++) {
        for (let x = Math.floor(px - rx); x <= px + rx; x++) {
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          const d2 = ((x - px) / rx) ** 2 + ((y - py) / r) ** 2;
          if (d2 >= 1) continue;
          const f = Math.pow(1 - d2, 1.5) * strength;
          const p = y * W + x;
          const lit = clamp(0.5 + 0.7 * (py - y) / r - 0.2 * (x - px) / rx);  // light from above-left
          // later puffs sit on top: blend their light over what's below
          light[p] = mix(light[p], lit, f / Math.max(f, density[p] + f) );
          density[p] = Math.min(1, density[p] + f);
        }
      }
    }
  });
  const dark = [0.04, 0.04, 0.048], grey = [0.36, 0.36, 0.38];
  for (let p = 0; p < W * H; p++) {
    const x = p % W, y = Math.floor(p / W);
    // a faint ash haze drifts over the whole city, thicker in patches
    const haze = 0.1 * smoothstep(0.45, 0.8, fbm(x / 130, y / 80, 650, 3));
    if (haze > 0) img.blend(x, y, [0.2, 0.2, 0.22], haze);
    if (density[p] <= 0) continue;
    const bank = SMOKE_BANKS.find((b) => pointRectDistance(x, y, b.hazard) < 200);
    const wisp = 0.75 + 0.35 * fbm(x / 7, y / 5, 660, 3);
    density[p] = clamp(density[p] * wisp) * (bank ? bank.opacity : 0.7);
    img.blend(x, y, [0, 1, 2].map((c) => mix(dark[c], grey[c], light[p])), density[p]);
  }
  return density;
}

function paintAsh(img, wallRects, solidRects) {
  const rand = rng(707);
  const solid = new Uint8Array(W * H);
  for (const r of solidRects) for (let y = r.y; y < r.y + r.h; y++) solid.fill(1, y * W + r.x, y * W + r.x + r.w);
  const ash = (x, y, a) => {
    if (x < 0 || y < 0 || x >= W || y >= H || solid[y * W + x]) return;  // drifts lie on open ground only
    const g = 0.37 + (rand() - 0.5) * 0.06;
    img.blend(x, y, [g, g, g * 1.06], a);
  };
  wallRects.forEach((r, k) => {
    const yb = r.y + r.h;
    for (let x = r.x; x < r.x + r.w; x++) {
      const n = fbm(x / 15, k * 3.1, 710);
      if (n < 0.38) continue;                       // drifts come in patches
      const t = Math.round(3 + 10 * Math.pow(smoothstep(0.38, 0.85, n), 1.2));
      for (let k2 = 0; k2 < t; k2++) ash(x, yb + k2, 0.8 * Math.pow(1 - k2 / t, 1.2));
    }
    for (let y = r.y + 4; y < yb; y++) {
      for (const side of [-1, 1]) {
        const n = fbm(y / 12, k * 2.3 + side, 720);
        if (n < 0.5) continue;
        const t = Math.round(1 + 5 * smoothstep(0.5, 0.85, n));
        const xe = side < 0 ? r.x - 1 : r.x + r.w;
        for (let k2 = 0; k2 < t; k2++) ash(xe + side * k2, y, 0.65 * (1 - k2 / t));
      }
    }
  });
  // fine speckle everywhere: mostly pale ash, some soot
  for (let p = 0; p < W * H; p++) {
    const v = rand();
    if (v > 0.0055) continue;
    const x = p % W, y = (p - x) / W;
    const soot = v < 0.0012;
    const g = soot ? 0.03 : 0.45 + rand() * 0.3;
    const a = soot ? 0.6 : 0.25 + rand() * 0.4;
    img.blend(x, y, [g, g, g * 1.05], a);
    if (v < 0.0007) img.blend(x + 1, y, [g, g, g * 1.05], a * 0.6);
  }
}

// ---------------------------------------------------------------------------
// LAYOUT. Everything placed by hand lives here; both the art and the data read it.
// All coordinates are in the MIRRORED map (Hollow pixels).

const mirrorRect = (r) => ({ ...r, x: W - r.x - r.w });

/** Collider notes come from wasteland.json; after mirroring, east and west swap. */
const SWAP = { NW: 'NE', NE: 'NW', SW: 'SE', SE: 'SW', W: 'E', E: 'W', west: 'east', east: 'west' };
const mirrorNote = (note) => (note || '').replace(/\b(NW|NE|SW|SE|W|E|west|east)\b/g, (m) => SWAP[m]);

// Wasteland's exit (east edge, y 688-716) mirrored onto the west edge: the party walks in from the cloud.
const SPAWN = { x: 32, y: 708, facing: 'right' };

// New props. `foot` is the solid footprint, used as both the collider and the inspectable rect.
const PROPS = {
  // the way down: in the cul-de-sac at the far east end of the street, lit by a burning barrel
  hatch: { foot: { x: 1233, y: 333, w: 46, h: 38 } },
  // the toppled welcome sign, the first thing you see after the arrival corridor
  estates: { foot: { x: 190, y: 558, w: 108, h: 42 } },
  // pilgrims' offerings at the foot of the dead tree, on the central square
  shrine: { foot: { x: 704, y: 530, w: 40, h: 26 } },
  // a Warden drone, crashed in the street north of the square
  'drone-husk': { foot: { x: 840, y: 468, w: 60, h: 54 } },
};

// Lamps that died with the city: their glow is removed (the four fires and two lamps keep burning).
const DEAD_LAMPS = [
  { x: 1385, y: 468, w: 63, h: 77, note: 'hanging lamp, east edge' },
  { x: 405, y: 724, w: 90, h: 140, note: 'lamp post + lit rubble, south-west' },
  { x: 505, y: 440, w: 120, h: 115, note: 'lamp post, centre-west' },
  { x: 425, y: 135, w: 130, h: 120, note: 'lamp post by the toxic drums' },
  { x: 785, y: 250, w: 65, h: 120, note: 'lamp post by the red car' },
  { x: 1062, y: 140, w: 60, h: 125, note: 'courtyard lamp (the fire pile next to it still burns)' },
];

// Smoke banks drifting across streets. `hazard` is the toxic rect (the densest part of the bank);
// the drawn smoke fades out over `spread` px (x, y) around it. `grain` sets the billow size (x, y).
const SMOKE_BANKS = [
  { note: 'across the east street, before the hatch', hazard: { x: 1030, y: 312, w: 70, h: 120 }, spread: [34, 70], grain: [30, 48], opacity: 0.8 },
  { note: 'across the south road', hazard: { x: 874, y: 776, w: 108, h: 58 }, spread: [80, 30], grain: [52, 24], opacity: 0.78 },
  { note: 'across the mouth of the north-west street', hazard: { x: 476, y: 240, w: 72, h: 56 }, spread: [30, 64], grain: [26, 44], opacity: 0.76 },
];

const PICKUPS = [
  { id: 'hl-water-1', item: 'water', x: 836, y: 572, dialogue: null },   // square, before the first smoke
  { id: 'hl-water-2', item: 'water', x: 928, y: 742, dialogue: null },   // south road, before its smoke
  { id: 'hl-medkit-1', item: 'medkit', x: 430, y: 256, dialogue: null }, // behind the north-west smoke
];

const CHECKPOINTS = [
  { id: 'hl-cp-1', x: 8, y: 690, w: 72, h: 26, respawn: { x: SPAWN.x, y: SPAWN.y } },
  { id: 'hl-cp-2', x: 690, y: 580, w: 100, h: 70, respawn: { x: 740, y: 620 } },
];

const CRAWLERS = [
  { id: 'hc1', x: 940, y: 880, count: 3, radius: 60 },   // south road
  { id: 'hc2', x: 800, y: 150, count: 2, radius: 55 },   // dead-end street to the north
  { id: 'hc3', x: 176, y: 172, count: 2, radius: 55 },   // in the toxic sludge, north-west
  { id: 'hc4', x: 236, y: 984, count: 2, radius: 55 },   // inside the corruption, south-west
  { id: 'hc5', x: 808, y: 398, count: 3, radius: 50 },   // the swarm that brought the drone down
];

// Where the `hollow` marker (and the Guide trail) points: the hatch's west side, facing the street.
const HATCH_MARKER = { x: 1216, y: 358 };

// Colliders whose notes match this are buildings: their sides get padded so bodies don't clip walls.
const BUILDING_NOTE = /^(NE brick building|NW ruined building|W ruined building|ruin |south ruin)/; // mirrored notes
const BUILDING_PAD = 6;

// ---------------------------------------------------------------------------
// DATA. hollow.json, built from wasteland.json + the layout above.

async function readWasteland() {
  return JSON.parse(await fs.readFile(SRC_JSON, 'utf8'));
}

function padBuilding(c) {
  if (!BUILDING_NOTE.test(c.note || '')) return c;
  const x0 = Math.max(0, c.x - BUILDING_PAD), x1 = Math.min(W, c.x + c.w + BUILDING_PAD);
  return { ...c, x: x0, w: x1 - x0, note: `${c.note} (sides +${BUILDING_PAD})` };
}

function buildData(ws) {
  const edges = [
    { x: 0, y: 0, w: W, h: 8, note: 'edge north' },
    { x: 0, y: H - 8, w: W, h: 8, note: 'edge south' },
    { x: 0, y: 0, w: 8, h: H, note: 'edge west (sealed: the cloud is behind you)' },
    { x: W - 8, y: 0, w: 8, h: H, note: 'edge east' },
  ];
  const mirrored = ws.colliders
    .filter((c) => !/^edge /.test(c.note || ''))
    .map((c) => ({ ...mirrorRect(c), note: mirrorNote(c.note) }))
    .map(padBuilding);
  const props = Object.entries(PROPS).map(([id, p]) => ({ ...p.foot, note: `${id} (new prop)` }));
  const hazards = [
    ...ws.hazards.map(mirrorRect),
    ...SMOKE_BANKS.map((s) => ({ type: 'toxic', ...s.hazard, note: `smoke bank ${s.note}` })),
  ];
  return {
    image: 'map-hollow',
    width: W,
    height: H,
    area: 'Inside the Cloud',
    spawn: { ...SPAWN },
    colliders: [...edges, ...mirrored, ...props],
    occluders: [],
    npcs: [],
    pickups: PICKUPS,
    inspectables: Object.entries(PROPS).map(([id, p]) => ({ id, ...p.foot, dialogue: `inspect-${id}` })),
    zones: [],
    hazards,
    checkpoints: CHECKPOINTS,
    crawlers: CRAWLERS,
    markers: { hollow: { ...HATCH_MARKER } },
  };
}

/** JSON in the house style: one top-level key per line, one array entry per line. */
function formatMapJson(map) {
  const inline = (v) => {
    if (Array.isArray(v)) return `[${v.map(inline).join(', ')}]`;
    if (v && typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')}}`;
    return JSON.stringify(v);
  };
  const lines = Object.entries(map).map(([k, v]) => {
    if (Array.isArray(v) && v.length > 0) return `  ${JSON.stringify(k)}: [\n${v.map((e) => `    ${inline(e)}`).join(',\n')}\n  ]`;
    if (k === 'markers') return `  "markers": {\n${Object.entries(v).map(([s, m]) => `    ${JSON.stringify(s)}: ${inline(m)}`).join(',\n')}\n  }`;
    return `  ${JSON.stringify(k)}: ${inline(v)}`;
  });
  return `{\n${lines.join(',\n')}\n}\n`;
}

// ---------------------------------------------------------------------------
// VERIFY. The reachability pattern of tools/assets/wasteland-check.mjs, adapted to the Hollow.

// Player physics body: 16 wide x 10 tall, bottom-centred on the feet position (contract §8).
const BODY_W = 16;
const BODY_H = 10;
const GRID = 2;               // flood-fill step in world pixels
const INTERACT_RADIUS = 28;   // feet-to-feet for pickups, nearest edge for inspectables
const CLEAR_COLLIDER = 20;    // pickup feet at least this far from any collider (M2 §0)
const CLEAR_EDGE = 40;        // ... and this far from the map edge
const CRAWLER_SAFE = 160;     // crawler groups at least this far from the spawn, the hatch and checkpoints
const HATCH_MIN_DIST = 500;   // the hatch sits at least this far from the spawn
const EDGE_MARGIN = 6;        // "touching the map edge" = the body is this close to it
const MAX_CLEARANCE = 40;     // clearance is measured up to this many px
const HAZARD_TYPES = ['toxic', 'corrupt', 'fire'];
const REQUIRED_PICKUPS = { 'hl-water-1': 'water', 'hl-water-2': 'water', 'hl-medkit-1': 'medkit' };
const REQUIRED_INSPECTABLES = ['hatch', 'estates', 'shrine', 'drone-husk'];

const right = (r) => r.x + r.w;
const bottom = (r) => r.y + r.h;
const inside = (px, py, r) => px >= r.x && px < right(r) && py >= r.y && py < bottom(r);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const fmtPt = (p) => `(${p.x}, ${p.y})`;
const centre = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/** Distance from point (px, py) to the nearest point of rect r (0 if inside). */
function pointRectDistance(px, py, r) {
  const dx = Math.max(r.x - px, 0, px - right(r));
  const dy = Math.max(r.y - py, 0, py - bottom(r));
  return Math.hypot(dx, dy);
}

function bodyAt(fx, fy) {
  return { x: fx - BODY_W / 2, y: fy - BODY_H, w: BODY_W, h: BODY_H };
}

function check(name, pass, detail = '') {
  return { name, pass: Boolean(pass), detail };
}

function isRect(r) {
  return ['x', 'y', 'w', 'h'].every((k) => Number.isInteger(r[k])) && r.w > 0 && r.h > 0 &&
    r.x >= 0 && r.y >= 0 && right(r) <= W && bottom(r) <= H;
}

async function otherPickupIds() {
  const dir = path.join(ROOT, 'src', 'data', 'maps');
  const ids = new Set();
  for (const f of await fs.readdir(dir)) {
    if (!f.endsWith('.json') || f === 'hollow.json') continue;
    try {
      const m = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
      (m.pickups || []).forEach((p) => ids.add(p.id));
    } catch { /* another task may be mid-write; skip that file */ }
  }
  return ids;
}

function validateSchema(map, ws, foreignIds) {
  const out = [];
  out.push(check('image / width / height / area',
    map.image === 'map-hollow' && map.width === W && map.height === H && map.area === 'Inside the Cloud'));
  out.push(check('spawn on the west edge, facing "right"',
    Number.isFinite(map.spawn?.x) && map.spawn.x <= 48 && map.spawn?.facing === 'right', fmtPt(map.spawn)));
  out.push(check('occluders is [], npcs is []', Array.isArray(map.occluders) && map.occluders.length === 0 &&
    Array.isArray(map.npcs) && map.npcs.length === 0));

  const badRects = [];
  for (const key of ['colliders', 'inspectables', 'zones', 'hazards', 'checkpoints']) {
    (map[key] || []).forEach((r, i) => { if (!isRect(r)) badRects.push(`${key}[${i}]`); });
  }
  out.push(check('every rect is integer, non-empty and inside the map', badRects.length === 0, badRects.join(' ')));

  const pickupProblems = [];
  for (const [id, item] of Object.entries(REQUIRED_PICKUPS)) {
    const p = (map.pickups || []).find((e) => e.id === id);
    if (!p) pickupProblems.push(`${id} missing`);
    else if (p.item !== item || p.dialogue !== null) pickupProblems.push(`${id} fields`);
  }
  out.push(check('pickups hl-water-1 / hl-water-2 / hl-medkit-1 (dialogue null)',
    pickupProblems.length === 0 && map.pickups.length === 3, pickupProblems.join(', ')));
  const clash = map.pickups.filter((p) => foreignIds.has(p.id)).map((p) => p.id);
  out.push(check('pickup ids are globally unique', clash.length === 0, clash.join(', ')));

  const inspectProblems = REQUIRED_INSPECTABLES.filter((id) => {
    const r = (map.inspectables || []).find((e) => e.id === id);
    return !r || r.dialogue !== `inspect-${id}`;
  });
  out.push(check('inspectables hatch / estates / shrine / drone-husk (dialogue inspect-<id>)',
    inspectProblems.length === 0, inspectProblems.join(', ')));

  const badHazards = (map.hazards || []).filter((h) => !HAZARD_TYPES.includes(h.type));
  out.push(check('hazards: only toxic / corrupt / fire', badHazards.length === 0));
  const extraToxic = map.hazards.length - ws.hazards.length;
  out.push(check('hazards: wasteland mirrored + 2-4 extra toxic smoke zones',
    extraToxic >= 2 && extraToxic <= 4 && map.hazards.slice(ws.hazards.length).every((h) => h.type === 'toxic'),
    `${extraToxic} extra`));

  const cpIds = (map.checkpoints || []).map((c) => c.id);
  out.push(check('checkpoints hl-cp-1 / hl-cp-2 with respawn points',
    cpIds.join() === 'hl-cp-1,hl-cp-2' && map.checkpoints.every((c) => Number.isFinite(c.respawn?.x) && Number.isFinite(c.respawn?.y)),
    cpIds.join(', ')));

  const groups = map.crawlers || [];
  const badGroups = groups.filter((g) => !(g.count >= 2 && g.count <= 3 && g.radius >= 50 && g.radius <= 80));
  out.push(check('4-5 crawler groups, count 2-3, radius 50-80',
    groups.length >= 4 && groups.length <= 5 && badGroups.length === 0, `${groups.length} groups`));

  out.push(check('markers.hollow is a point', Number.isFinite(map.markers?.hollow?.x) && Number.isFinite(map.markers?.hollow?.y)));
  return out;
}

const GW = Math.floor(W / GRID) + 1;
const GH = Math.floor(H / GRID) + 1;
const node = (gx, gy) => gy * GW + gx;
const nodeXY = (n) => ({ x: (n % GW) * GRID, y: Math.floor(n / GW) * GRID });

/** Per-pixel blocked mask + summed-area table, so "is this rect free?" is O(1). */
function buildBlocker(rects) {
  const mask = new Uint8Array(W * H);
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor(r.x)), x1 = Math.min(W, Math.ceil(right(r)));
    const y0 = Math.max(0, Math.floor(r.y)), y1 = Math.min(H, Math.ceil(bottom(r)));
    for (let y = y0; y < y1; y++) mask.fill(1, y * W + x0, y * W + x1);
  }
  const W1 = W + 1;
  const sat = new Int32Array(W1 * (H + 1));
  for (let y = 0; y < H; y++) {
    let rowSum = 0;
    for (let x = 0; x < W; x++) {
      rowSum += mask[y * W + x];
      sat[(y + 1) * W1 + (x + 1)] = sat[y * W1 + (x + 1)] + rowSum;
    }
  }
  function rectFree(x0, y0, x1, y1) {
    if (x0 < 0 || y0 < 0 || x1 > W || y1 > H) return false;
    return sat[y1 * W1 + x1] - sat[y0 * W1 + x1] - sat[y1 * W1 + x0] + sat[y0 * W1 + x0] === 0;
  }
  return {
    rectFree,
    bodyFree: (fx, fy) => rectFree(fx - BODY_W / 2, fy - BODY_H, fx + BODY_W / 2, fy),
    clearance(fx, fy) {
      let lo = 0, hi = MAX_CLEARANCE;
      while (lo < hi) {
        const k = Math.ceil((lo + hi) / 2);
        if (rectFree(fx - BODY_W / 2 - k, fy - BODY_H - k, fx + BODY_W / 2 + k, fy + k)) lo = k; else hi = k - 1;
      }
      return lo;
    },
  };
}

/** 4-neighbour flood fill of feet positions; `extraBlocked(fx, fy)` can refuse more nodes. Keeps parents for routes. */
function floodFill(blocker, start, extraBlocked = () => false) {
  const reached = new Uint8Array(GW * GH);
  const parent = new Int32Array(GW * GH).fill(-1);
  const sx = Math.round(start.x / GRID), sy = Math.round(start.y / GRID);
  const ok = (gx, gy) => blocker.bodyFree(gx * GRID, gy * GRID) && !extraBlocked(gx * GRID, gy * GRID);
  if (!ok(sx, sy)) return { reached, parent, startFree: false, count: 0 };
  const queue = new Int32Array(GW * GH);
  let head = 0, tail = 0;
  reached[node(sx, sy)] = 1;
  queue[tail++] = node(sx, sy);
  while (head < tail) {
    const idx = queue[head++];
    const gx = idx % GW, gy = (idx - gx) / GW;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = gx + dx, ny = gy + dy;
      if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
      const n = node(nx, ny);
      if (reached[n] || !ok(nx, ny)) continue;
      reached[n] = 1;
      parent[n] = idx;
      queue[tail++] = n;
    }
  }
  return { reached, parent, startFree: true, count: tail };
}

/** The BFS route (list of feet points) from the fill's start to node n. */
function routeTo(fill, n) {
  const pts = [];
  for (let k = n; k !== -1; k = fill.parent[k]) pts.push(nodeXY(k));
  return pts.reverse();
}

function someReached(reached, box, fn) {
  const gx0 = Math.max(0, Math.floor(box.x / GRID)), gx1 = Math.min(GW - 1, Math.ceil(right(box) / GRID));
  const gy0 = Math.max(0, Math.floor(box.y / GRID)), gy1 = Math.min(GH - 1, Math.ceil(bottom(box) / GRID));
  for (let gy = gy0; gy <= gy1; gy++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      const n = node(gx, gy);
      if (reached[n] && fn(gx * GRID, gy * GRID, n)) return true;
    }
  }
  return false;
}

function nearestReachedNode(reached, px, py, maxDist) {
  let best = null, bestD = Infinity;
  someReached(reached, { x: px - maxDist, y: py - maxDist, w: maxDist * 2, h: maxDist * 2 }, (fx, fy, n) => {
    const d = Math.hypot(fx - px, fy - py);
    if (d <= maxDist && d < bestD) { bestD = d; best = n; }
    return false;
  });
  return best;
}

function nearestReachedToRect(reached, r, maxDist) {
  let best = null, bestD = Infinity;
  someReached(reached, { x: r.x - maxDist, y: r.y - maxDist, w: r.w + maxDist * 2, h: r.h + maxDist * 2 }, (fx, fy, n) => {
    const d = pointRectDistance(fx, fy, r);
    if (d <= maxDist && d < bestD) { bestD = d; best = n; }
    return false;
  });
  return best;
}

/** Which sides (N/S/W/E) of rect r have a reached feet position within `radius` of that side. */
function reachableSides(reached, r, radius) {
  const sides = [];
  const box = { x: r.x - radius, y: r.y - radius, w: r.w + radius * 2, h: r.h + radius * 2 };
  const test = (pred) => someReached(reached, box, (fx, fy) => pointRectDistance(fx, fy, r) <= radius && pred(fx, fy));
  if (test((fx, fy) => fy <= r.y)) sides.push('N');
  if (test((fx, fy) => fy >= bottom(r))) sides.push('S');
  if (test((fx) => fx <= r.x)) sides.push('W');
  if (test((fx) => fx >= right(r))) sides.push('E');
  return sides;
}

function edgeTouches(reached) {
  const hits = [];
  for (let n = 0; n < reached.length; n++) {
    if (!reached[n]) continue;
    const p = nodeXY(n);
    const b = bodyAt(p.x, p.y);
    if (b.x < EDGE_MARGIN || b.y < EDGE_MARGIN || right(b) > W - EDGE_MARGIN || bottom(b) > H - EDGE_MARGIN) hits.push(p);
  }
  return hits;
}

class MinHeap {
  constructor() { this.items = []; }
  get size() { return this.items.length; }
  push(priority, value) {
    const a = this.items;
    a.push([priority, value]);
    for (let i = a.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.items;
    const top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * The narrowest choke of the best route between two reached nodes (see wasteland-check.mjs):
 * the widest-path value first, then the cheapest wall-avoiding route at least that wide.
 * Returns { width, choke: {x, y} | null, route: [{x, y}] }.
 */
function legChoke(reached, clr, from, to) {
  const a = nodeXY(from), b = nodeXY(to);
  const eff = (n) => {
    const p = nodeXY(n);
    return dist(p, a) <= INTERACT_RADIUS || dist(p, b) <= INTERACT_RADIUS ? MAX_CLEARANCE : clr[n];
  };
  const neighbours = (n) => {
    const gx = n % GW, gy = (n - gx) / GW, list = [];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = gx + dx, ny = gy + dy;
      if (nx >= 0 && ny >= 0 && nx < GW && ny < GH && reached[node(nx, ny)]) list.push(node(nx, ny));
    }
    return list;
  };
  const best = new Int16Array(GW * GH).fill(-1);
  const buckets = Array.from({ length: MAX_CLEARANCE + 1 }, () => []);
  best[from] = eff(from);
  buckets[best[from]].push(from);
  for (let level = best[from]; level >= 0;) {
    if (buckets[level].length === 0) { level--; continue; }
    const cur = buckets[level].pop();
    if (best[cur] !== level) continue;
    if (cur === to) break;
    for (const n of neighbours(cur)) {
      const cand = Math.min(level, eff(n));
      if (cand > best[n]) { best[n] = cand; buckets[cand].push(n); }
    }
  }
  const width = best[to];
  if (width < 0) return null;
  const cost = new Float64Array(GW * GH).fill(Infinity);
  const parent = new Int32Array(GW * GH).fill(-1);
  const heap = new MinHeap();
  cost[from] = 0;
  heap.push(0, from);
  while (heap.size) {
    const [c, cur] = heap.pop();
    if (c > cost[cur]) continue;
    if (cur === to) break;
    for (const n of neighbours(cur)) {
      const e = eff(n);
      if (e < width) continue;
      const nc = c + 1 + 8 / (1 + e);
      if (nc < cost[n]) { cost[n] = nc; parent[n] = cur; heap.push(nc, n); }
    }
  }
  let choke = null;
  const route = [];
  for (let n = to; n !== -1; n = parent[n]) {
    route.push(nodeXY(n));
    if (eff(n) < MAX_CLEARANCE && (choke === null || eff(n) < eff(choke))) choke = n;
    if (n === from) break;
  }
  return { width, choke: choke === null ? null : nodeXY(choke), route: route.reverse() };
}

function mapChecks(map) {
  const out = [];
  const hazards = map.hazards || [];
  const deadly = hazards.filter((h) => h.type !== 'toxic');
  const inAnyHazard = (fx, fy) => hazards.some((h) => inside(fx, fy, h));
  const inDeadly = (fx, fy) => deadly.some((h) => inside(fx, fy, h));
  const insp = (id) => map.inspectables.find((r) => r.id === id);
  const hatch = insp('hatch');

  const walls = buildBlocker(map.colliders);
  const open = floodFill(walls, map.spawn);                 // colliders only
  const safe = floodFill(walls, map.spawn, inDeadly);       // never steps in corrupt / fire (toxic smoke allowed)
  const clean = floodFill(walls, map.spawn, inAnyHazard);   // never steps in any hazard
  out.push(check('spawn: body is free and not in a hazard', safe.startFree && !inAnyHazard(map.spawn.x, map.spawn.y), fmtPt(map.spawn)));

  // The hatch ------------------------------------------------------------------------------
  const hatchDist = Math.round(dist(map.spawn, centre(hatch)));
  out.push(check(`hatch: at least ${HATCH_MIN_DIST} px from the spawn`, hatchDist >= HATCH_MIN_DIST, `${hatchDist} px`));
  const hatchNode = nearestReachedToRect(safe.reached, hatch, INTERACT_RADIUS);
  out.push(check('route spawn -> hatch avoiding corrupt and fire (toxic smoke allowed)', hatchNode !== null,
    hatchNode !== null ? `${routeTo(safe, hatchNode).length * GRID} px walk` : 'none'));
  const cleanHatch = nearestReachedToRect(clean.reached, hatch, INTERACT_RADIUS);
  out.push(check('info: a route to the hatch through no hazard at all', true, cleanHatch !== null ? 'exists' : 'none (smoke must be crossed: carry water)'));
  const m = map.markers.hollow;
  const markerNode = nearestReachedNode(safe.reached, m.x, m.y, GRID * 2);
  out.push(check('marker hollow: on free, safely reachable ground within interaction range of the hatch',
    walls.bodyFree(m.x, m.y) && markerNode !== null && pointRectDistance(m.x, m.y, hatch) <= INTERACT_RADIUS - 4,
    `${fmtPt(m)}, ${pointRectDistance(m.x, m.y, hatch).toFixed(1)} px from the hatch`));

  // Inspectables, pickups, checkpoints ----------------------------------------------------
  for (const r of map.inspectables) {
    const sides = reachableSides(open.reached, r, INTERACT_RADIUS);
    const safeSides = reachableSides(safe.reached, r, INTERACT_RADIUS);
    out.push(check(`inspectable ${r.id} has a reachable side (avoiding corrupt/fire)`, safeSides.length > 0,
      `sides ${sides.join('') || '-'}, safe ${safeSides.join('') || '-'}`));
  }
  for (const p of map.pickups) {
    const hit = nearestReachedNode(safe.reached, p.x, p.y, INTERACT_RADIUS);
    const cleanHit = nearestReachedNode(clean.reached, p.x, p.y, INTERACT_RADIUS);
    out.push(check(`pickup ${p.id} reachable (avoiding corrupt/fire)`, hit !== null, `${fmtPt(p)}${cleanHit !== null ? ', hazard-free' : ', through smoke'}`));
  }
  for (const cp of map.checkpoints) {
    const r = cp.respawn;
    let entered = false;
    someReached(safe.reached, cp, (fx, fy) => (entered = inside(fx, fy, cp)));
    const respawnOk = walls.bodyFree(r.x, r.y) && !inAnyHazard(r.x, r.y) && nearestReachedNode(safe.reached, r.x, r.y, GRID * 2) !== null;
    out.push(check(`checkpoint ${cp.id}: enterable and respawn point free`, entered && respawnOk, fmtPt(r)));
  }
  const cp1 = map.checkpoints[0], cp2 = map.checkpoints[1];
  out.push(check('hl-cp-1 is at the spawn', inside(map.spawn.x, map.spawn.y, cp1)));
  let midpoint = null;
  if (hatchNode !== null) {
    const route = routeTo(safe, hatchNode);
    midpoint = route[Math.floor(route.length / 2)];
    const d = Math.round(pointRectDistance(midpoint.x, midpoint.y, cp2));
    out.push(check('hl-cp-2 is near the midpoint of the spawn -> hatch route (<= 120 px)', d <= 120, `midpoint ${fmtPt(midpoint)}, ${d} px`));
  }

  // Edges ------------------------------------------------------------------------------------
  const leaks = edgeTouches(open.reached);
  out.push(check('edges: sealed all round (the hatch is the only way on)', leaks.length === 0, leaks.slice(0, 5).map(fmtPt).join(' ')));

  // Clearances -------------------------------------------------------------------------------
  const clearanceOf = (p) => Math.min(...map.colliders.map((c) => pointRectDistance(p.x, p.y, c)));
  const edgeOf = (p) => Math.min(p.x, p.y, W - p.x, H - p.y);
  for (const p of map.pickups) {
    const c = clearanceOf(p), e = edgeOf(p);
    out.push(check(`clearance: ${p.id} >= ${CLEAR_COLLIDER} px from colliders, >= ${CLEAR_EDGE} px from edges, not in a hazard`,
      c >= CLEAR_COLLIDER && e >= CLEAR_EDGE && !inAnyHazard(p.x, p.y), `collider ${c.toFixed(1)}, edge ${e}`));
  }
  const spawnClr = walls.clearance(map.spawn.x, map.spawn.y);
  out.push(check('clearance: spawn body has room to move (>= 4 px spare)', spawnClr >= 4, `${spawnClr} px`));

  // Required legs: spawn -> every target. Their narrowest chokes must stay free of crawlers ----
  const clr = new Int16Array(GW * GH);
  for (let n = 0; n < clr.length; n++) {
    if (!safe.reached[n]) continue;
    const p = nodeXY(n);
    let hz = MAX_CLEARANCE;
    for (const h of deadly) hz = Math.min(hz, pointRectDistance(p.x, p.y, h));
    clr[n] = Math.min(walls.clearance(p.x, p.y), Math.floor(hz), MAX_CLEARANCE);
  }
  const spawnNode = node(Math.round(map.spawn.x / GRID), Math.round(map.spawn.y / GRID));
  const targets = [
    { name: 'hatch', node: markerNode },
    ...map.inspectables.filter((r) => r.id !== 'hatch').map((r) => ({ name: r.id, node: nearestReachedToRect(safe.reached, r, INTERACT_RADIUS) })),
    ...map.pickups.map((p) => ({ name: p.id, node: nearestReachedNode(safe.reached, p.x, p.y, INTERACT_RADIUS) })),
    { name: 'hl-cp-2', node: nearestReachedNode(safe.reached, cp2.respawn.x, cp2.respawn.y, GRID * 2) },
  ];
  const chokes = [];
  let mainRoute = [];
  for (const t of targets) {
    const label = `leg spawn -> ${t.name}`;
    if (t.node === null) { out.push(check(label, false, 'endpoint unreachable')); continue; }
    const res = legChoke(safe.reached, clr, spawnNode, t.node);
    if (!res) { out.push(check(label, false, 'no corrupt/fire-free route')); continue; }
    if (t.name === 'hatch') mainRoute = res.route;
    if (!res.choke) { out.push(check(`${label}: no choke narrower than ${MAX_CLEARANCE} px`, true)); continue; }
    chokes.push({ leg: label, ...res });
    const blockers = map.crawlers.filter((g) => dist(g, res.choke) <= g.radius + 8);
    out.push(check(`${label}: narrowest choke is free of crawler groups`, blockers.length === 0,
      `choke ${fmtPt(res.choke)}, ${res.width} px spare${blockers.length ? `, inside ${blockers.map((g) => g.id).join(',')}` : ''}`));
  }

  // Crawler groups ---------------------------------------------------------------------------
  const keepAway = [
    { id: 'spawn', rect: { x: map.spawn.x, y: map.spawn.y, w: 0, h: 0 } },
    { id: 'hatch', rect: hatch },
    ...map.checkpoints.map((c) => ({ id: c.id, rect: c })),
  ];
  for (const g of map.crawlers) {
    const near = keepAway.map((k) => ({ id: k.id, d: pointRectDistance(g.x, g.y, k.rect) })).sort((a, b) => a.d - b.d)[0];
    out.push(check(`crawlers ${g.id}: >= ${CRAWLER_SAFE} px from the spawn, the hatch and every checkpoint`, near.d >= CRAWLER_SAFE,
      `${Math.round(near.d)} px from ${near.id}`));
    const centreOk = walls.bodyFree(g.x, g.y) && nearestReachedNode(open.reached, g.x, g.y, GRID * 2) !== null;
    out.push(check(`crawlers ${g.id}: centre on open, reachable ground`, centreOk, fmtPt(g)));
  }

  return { checks: out, open, safe, chokes, mainRoute, midpoint };
}

// ---------------------------------------------------------------------------
// PREVIEWS.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function label(x, y, text, color, size = 10) {
  return `<text x="${x}" y="${y}" font-family="Menlo, monospace" font-size="${size}" fill="${color}" ` +
    `stroke="#000" stroke-width="2.5" paint-order="stroke">${esc(text)}</text>`;
}

const HAZARD_COLORS = { toxic: '#30ff40', corrupt: '#b040ff', fire: '#ff8a00' };

function overlaySvg(map, result, { indices = false } = {}) {
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`];
  map.colliders.forEach((c, i) => {
    parts.push(`<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" fill="#ff2020" fill-opacity="0.3" stroke="#ff2020" stroke-opacity="0.9" stroke-width="1"/>`);
    if (indices) parts.push(label(c.x + 1, c.y + 8, i, '#ffd0d0', 8));
  });
  for (const h of map.hazards) {
    const col = HAZARD_COLORS[h.type];
    parts.push(`<rect x="${h.x}" y="${h.y}" width="${h.w}" height="${h.h}" fill="${col}" fill-opacity="0.22" stroke="${col}" stroke-width="1.5" stroke-dasharray="4 2"/>`);
  }
  for (const cp of map.checkpoints) {
    parts.push(`<rect x="${cp.x + 0.5}" y="${cp.y + 0.5}" width="${cp.w - 1}" height="${cp.h - 1}" fill="none" stroke="#ffffff" stroke-width="1.5" stroke-dasharray="5 3"/>`);
    parts.push(`<circle cx="${cp.respawn.x}" cy="${cp.respawn.y}" r="3" fill="#ffffff"/>`);
    parts.push(label(cp.x + 2, bottom(cp) + 11, cp.id, '#ffffff'));
  }
  if (result.mainRoute.length) {
    const pts = result.mainRoute.filter((_, i) => i % 6 === 0).map((p) => `${p.x},${p.y}`).join(' ');
    parts.push(`<polyline points="${pts}" fill="none" stroke="#f0c060" stroke-width="2" stroke-dasharray="2 4" stroke-opacity="0.9"/>`);
  }
  for (const r of map.inspectables) {
    parts.push(`<rect x="${r.x + 0.5}" y="${r.y + 0.5}" width="${r.w - 1}" height="${r.h - 1}" fill="none" stroke="#3ad4e8" stroke-width="2"/>`);
    parts.push(label(r.x + 2, bottom(r) + 11, `inspect:${r.id}`, '#8ff0ff'));
  }
  for (const g of map.crawlers) {
    parts.push(`<circle cx="${g.x}" cy="${g.y}" r="${g.radius}" fill="#ff0000" fill-opacity="0.08" stroke="#ff3030" stroke-width="2"/>`);
    parts.push(`<circle cx="${g.x}" cy="${g.y}" r="3" fill="#ff3030"/>`);
    parts.push(label(g.x + 5, g.y - 4, `${g.id} x${g.count}`, '#ff8080'));
  }
  for (const p of map.pickups) {
    parts.push(`<circle cx="${p.x}" cy="${p.y}" r="5" fill="#ff9a1a" stroke="#000" stroke-width="1"/>`);
    parts.push(label(p.x + 7, p.y + 4, p.id, '#ffb050'));
  }
  for (const c of result.chokes) {
    parts.push(`<path d="M${c.choke.x - 4},${c.choke.y - 4} L${c.choke.x + 4},${c.choke.y + 4} M${c.choke.x - 4},${c.choke.y + 4} L${c.choke.x + 4},${c.choke.y - 4}" stroke="#00ffff" stroke-width="2"/>`);
  }
  if (result.midpoint) parts.push(`<circle cx="${result.midpoint.x}" cy="${result.midpoint.y}" r="4" fill="none" stroke="#f0c060" stroke-width="2"/>`);
  const s = map.spawn;
  parts.push(`<circle cx="${s.x}" cy="${s.y}" r="5" fill="#ffffff" stroke="#000" stroke-width="1"/>`);
  parts.push(label(s.x + 7, s.y - 8, `spawn (${s.facing})`, '#ffffff'));
  for (const [stage, m] of Object.entries(map.markers || {})) {
    parts.push(`<path d="M${m.x},${m.y - 5} L${m.x + 5},${m.y} L${m.x},${m.y + 5} L${m.x - 5},${m.y} Z" fill="#ffff00" stroke="#000" stroke-width="1"/>`);
    parts.push(label(m.x - 30, m.y - 9, `marker:${stage}`, '#ffff80', 9));
  }
  parts.push('</svg>');
  return parts.join('\n');
}

async function renderOverlay(map, result, file, extraLayers = [], opts = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const layers = [...extraLayers, { input: Buffer.from(overlaySvg(map, result, opts)) }];
  await sharp(OUT_PNG).composite(layers).png({ compressionLevel: 9 }).toFile(file);
}

/** RGBA layer that tints reached feet positions (debug only). */
function reachLayer(reached, rgba) {
  const buf = Buffer.alloc(W * H * 4);
  for (let n = 0; n < reached.length; n++) {
    if (!reached[n]) continue;
    const p = nodeXY(n);
    for (let y = p.y; y < Math.min(H, p.y + GRID); y++) {
      for (let x = p.x; x < Math.min(W, p.x + GRID); x++) {
        const i = (y * W + x) * 4;
        buf[i] = rgba[0]; buf[i + 1] = rgba[1]; buf[i + 2] = rgba[2]; buf[i + 3] = rgba[3];
      }
    }
  }
  return { input: buf, raw: { width: W, height: H, channels: 4 } };
}

// ---------------------------------------------------------------------------

async function buildArt(ws, debugDir) {
  // 1. The Act III city, mirrored, and the masks read from it while it is still daylight.
  const base = await Canvas.load(SRC_PNG, { flop: true });
  const corruptRects = ws.hazards.filter((h) => h.type === 'corrupt').map(mirrorRect);
  const masks = analyse(base, corruptRects, DEAD_LAMPS);
  const img = new Canvas(W, H, Float32Array.from(base.data));

  // 2. New props in daylight colours, so the grade below treats them exactly like the map.
  const cover = newMask();
  await paintHatch(img, cover);
  await paintEstates(img, cover);
  paintShrine(img, cover);
  await paintDroneHusk(img, cover);
  for (const k of ['fire', 'toxic', 'magenta', 'corrupt']) {
    for (let p = 0; p < W * H; p++) masks[k][p] *= 1 - cover[p]; // props hide what was under them
  }

  // 3. Night, corruption, smoke, ash, then the fires burning through it all.
  nightGrade(img, masks);
  intensifyCorruption(img, base, masks);
  const keepClear = [
    { x: SPAWN.x, y: SPAWN.y, r: 46 },
    ...Object.values(PROPS).map((p) => ({ x: p.foot.x + p.foot.w / 2, y: p.foot.y + p.foot.h / 2, r: Math.max(p.foot.w, p.foot.h) / 2 + 8 })),
  ];
  paintTendrils(img, masks, keepClear);
  paintNaniteResidue(img, PROPS['drone-husk'].foot);
  const smoke = paintSmoke(img);
  const solids = ws.colliders.filter((c) => !/^edge /.test(c.note || '')).map(mirrorRect);
  const walls = solids.filter((c) => /building|ruin|wall|fence/.test(c.note || ''));
  paintAsh(img, walls, [...solids, ...Object.values(PROPS).map((p) => p.foot)]);
  compositeEmissive(img, base, masks, smoke);
  paintPropLights(img);

  if (debugDir) {
    await fs.mkdir(debugDir, { recursive: true });
    for (const k of ['fire', 'dead', 'pool', 'toxic', 'magenta', 'corrupt']) {
      const buf = Buffer.alloc(W * H);
      for (let p = 0; p < W * H; p++) buf[p] = Math.round(clamp(masks[k][p]) * 255);
      await sharp(buf, { raw: { width: W, height: H, channels: 1 } }).png().toFile(path.join(debugDir, `mask-${k}.png`));
    }
  }
  return img;
}

function printResults(title, results) {
  console.log(`\n${title}`);
  for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  [${r.detail}]` : ''}`);
}

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const debugDir = args.includes('--debug') ? args[args.indexOf('--debug') + 1] : null;
  const ws = await readWasteland();

  if (!checkOnly) {
    const img = await buildArt(ws, debugDir);
    await img.save(OUT_PNG);
    console.log(`Map written to ${path.relative(ROOT, OUT_PNG)}`);
    await fs.writeFile(OUT_JSON, formatMapJson(buildData(ws)));
    console.log(`Data written to ${path.relative(ROOT, OUT_JSON)}`);
  }

  const all = [];
  const meta = await sharp(OUT_PNG).metadata();
  const sizeOk = check(`hollow.png is ${W}x${H}`, meta.width === W && meta.height === H, `${meta.width}x${meta.height}`);
  printResults('Map image', [sizeOk]);
  all.push(sizeOk);

  const map = JSON.parse(await fs.readFile(OUT_JSON, 'utf8'));
  const schema = validateSchema(map, ws, await otherPickupIds());
  printResults('hollow.json schema', schema);
  all.push(...schema);

  const result = mapChecks(map);
  printResults('Reachability, hazards, clearances, crawlers (player body 16x10, grid 2 px)', result.checks);
  all.push(...result.checks);

  console.log('\nCounts');
  console.log(`  colliders ${map.colliders.length} (${Object.keys(PROPS).length} new props), hazards ${map.hazards.length} (` +
    HAZARD_TYPES.map((t) => `${t} ${map.hazards.filter((h) => h.type === t).length}`).join(', ') +
    `), pickups ${map.pickups.length}, inspectables ${map.inspectables.length}, checkpoints ${map.checkpoints.length}, ` +
    `crawler groups ${map.crawlers.length} (${map.crawlers.reduce((a, g) => a + g.count, 0)} crawlers)`);

  await sharp(OUT_PNG).resize(700).png({ compressionLevel: 9 }).toFile(PREVIEW_SMALL);
  await renderOverlay(map, result, PREVIEW_OVERLAY);
  console.log(`\nPreviews written to ${path.relative(ROOT, PREVIEW_SMALL)} and ${path.relative(ROOT, PREVIEW_OVERLAY)}`);
  if (debugDir) {
    await fs.mkdir(debugDir, { recursive: true });
    const file = path.join(debugDir, 'hollow-reach.png');
    await renderOverlay(map, result, file, [reachLayer(result.open.reached, [255, 140, 0, 80]), reachLayer(result.safe.reached, [0, 255, 255, 60])], { indices: true });
    console.log(`Debug reach map written to ${file} (orange = walkable, cyan = corrupt/fire-free)`);
  }

  const failed = all.filter((r) => !r.pass);
  console.log(`\n${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`} (${all.length} checks)`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

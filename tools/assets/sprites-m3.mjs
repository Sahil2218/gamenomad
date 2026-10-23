// tools/assets/sprites-m3.mjs
//
// Milestone 3 sprites and effect textures:
//   public/assets/characters/scientist.png  128x144  the silo scientist, 4x3 frames of 32x48
//   public/assets/portraits/scientist.png   96x96    her/his dialogue portrait
//   public/assets/creatures/relay.png       96x40    relay pylon, 4 frames of 24x40 (core pulses on 1-2)
//   public/assets/fx/fx-silver.png          3x3      silver-white nanite fleck
//   public/assets/fx/fx-ash.png             3x3      soft grey ash flake
//   public/assets/fx/fx-memory.png          16x4     soft white streak (for additive blending)
// plus a visual check sheet at tools/previews/m3-sprites.png.
//
// Run from the project root:   node tools/assets/sprites-m3.mjs
//
// The scientist is NOT drawn from scratch. It is the mayor's sheet and portrait, recoloured pixel by
// pixel: the red robe becomes a pale lab coat, the gold trim becomes coat edges, the gold on the vest
// becomes a plain slate shirt, then we add round glasses and a small cyan ID badge. Hair, beard, face
// and hands are left untouched, so every frame animates exactly like the mayor's.
// The relay and the FX are drawn procedurally, in the same style as tools/assets/creatures.mjs.

import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';

const MAYOR_SHEET = 'public/assets/characters/mayor.png';
const MAYOR_PORTRAIT = 'public/assets/portraits/mayor.png';
const OUT = {
  sheet: 'public/assets/characters/scientist.png',
  portrait: 'public/assets/portraits/scientist.png',
  relay: 'public/assets/creatures/relay.png',
  fx: 'public/assets/fx',
  preview: 'tools/previews/m3-sprites.png',
};
const PREVIEW_BG = '#1a1d27';

// ---------------------------------------------------------------------------
// Colour + canvas helpers
// ---------------------------------------------------------------------------

/** '#rrggbb' -> [r, g, b, a]. Arrays are passed through unchanged. */
function rgba(color, alpha = 255) {
  if (Array.isArray(color)) return color;
  const n = parseInt(color.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, alpha];
}

/** [r, g, b] (0-255) -> { h: 0-360, s: 0-1, v: 0-1 }. */
function hsv([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (t) => Math.min(1, Math.max(0, t));

/**
 * A colour ramp: `stops` is a list of [position, '#hex'] sorted by position.
 * ramp(stops, t) interpolates between the two stops around t.
 */
function ramp(stops, t) {
  if (t <= stops[0][0]) return rgba(stops[0][1]);
  for (let i = 1; i < stops.length; i++) {
    const [p1, c1] = stops[i];
    if (t <= p1) {
      const [p0, c0] = stops[i - 1];
      const k = (t - p0) / (p1 - p0);
      const a = rgba(c0);
      const b = rgba(c1);
      return [0, 1, 2].map((j) => Math.round(lerp(a[j], b[j], k))).concat(255);
    }
  }
  return rgba(stops[stops.length - 1][1]);
}

/** A small RGBA pixel buffer with just the drawing operations the art below needs. */
class Canvas {
  constructor(w, h, data) {
    this.w = w;
    this.h = h;
    this.data = data ? new Uint8ClampedArray(data) : new Uint8ClampedArray(w * h * 4);
  }

  has(x, y) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  get(x, y) {
    if (!this.has(x, y)) return [0, 0, 0, 0];
    const i = (y * this.w + x) * 4;
    return [this.data[i], this.data[i + 1], this.data[i + 2], this.data[i + 3]];
  }

  alpha(x, y) {
    return this.has(x, y) ? this.data[(y * this.w + x) * 4 + 3] : 0;
  }

  /** Overwrite one pixel. */
  set(x, y, color) {
    x = Math.round(x);
    y = Math.round(y);
    if (!this.has(x, y)) return;
    this.data.set(rgba(color), (y * this.w + x) * 4);
  }

  /** Paint a (possibly translucent) colour over a pixel, "normal" alpha blending. */
  blend(x, y, color) {
    if (!this.has(x, y)) return;
    const [r, g, b, a] = rgba(color);
    if (a === 0) return;
    const i = (y * this.w + x) * 4;
    const d = this.data;
    const sa = a / 255;
    const da = d[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    [r, g, b].forEach((s, k) => {
      d[i + k] = Math.round((s * sa + d[i + k] * da * (1 - sa)) / oa);
    });
    d[i + 3] = Math.round(oa * 255);
  }

  /** Paint another canvas over this one with its top-left at (ox, oy). */
  paste(src, ox = 0, oy = 0) {
    for (let y = 0; y < src.h; y++) {
      for (let x = 0; x < src.w; x++) this.blend(x + ox, y + oy, src.get(x, y));
    }
    return this;
  }

  /** A copy of the rectangle (x0, y0, w, h). */
  crop(x0, y0, w, h) {
    const out = new Canvas(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.set(x, y, this.get(x0 + x, y0 + y));
    return out;
  }
}

/**
 * Stamp a hand-drawn pixel map. `rows` are strings, one character per pixel;
 * `legend` maps characters to colours, and '.' (or any unmapped character) is left untouched.
 */
function stamp(c, rows, legend, ox, oy) {
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (legend[ch]) c.set(ox + x, oy + y, legend[ch]);
    });
  });
}

/** A copy of `c` with a 1 px outline around every opaque pixel (4-neighbour, like the other art). */
function outlined(c, color) {
  const out = new Canvas(c.w, c.h).paste(c);
  for (let y = 0; y < c.h; y++) {
    for (let x = 0; x < c.w; x++) {
      if (c.alpha(x, y) > 0) continue;
      const touches = c.alpha(x - 1, y) > 127 || c.alpha(x + 1, y) > 127 ||
        c.alpha(x, y - 1) > 127 || c.alpha(x, y + 1) > 127;
      if (touches) out.set(x, y, color);
    }
  }
  return out;
}

/** Sheet canvas made of frames laid out left to right. */
function sheet(frames) {
  const out = new Canvas(frames[0].w * frames.length, frames[0].h);
  frames.forEach((f, i) => out.paste(f, i * f.w, 0));
  return out;
}

async function readPng(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return new Canvas(info.width, info.height, data);
}

/** Canvas -> sharp instance. */
const toSharp = (c) => sharp(Buffer.from(c.data), { raw: { width: c.w, height: c.h, channels: 4 } });

async function writePng(c, file) {
  await toSharp(c).png().toFile(file);
  console.log(`  ${file}  ${c.w}x${c.h}`);
}

// ---------------------------------------------------------------------------
// Scientist: recolour the mayor
// ---------------------------------------------------------------------------

// Lab coat: pale grey-white with cool shadows. Positions are the HSV value of the mayor's red.
const COAT = [
  [0.10, '#1b1d24'],
  [0.20, '#3b404c'],
  [0.31, '#6b7280'],
  [0.42, '#9aa1ad'],
  [0.54, '#c9cdd4'],
  [0.70, '#e1e4e9'],
];
// The gold trim turns into the coat's lit edges (lapels, hem, cuffs): one step lighter than the cloth.
const COAT_EDGE = [
  [0.25, '#6b7280'],
  [0.45, '#9aa1ad'],
  [0.62, '#c9cdd4'],
  [0.80, '#dde0e5'],
  [0.95, '#eceef2'],
];
// Gold on the mayor's vest becomes a plain slate shirt under the open coat.
const SHIRT = [
  [0.25, '#252a35'],
  [0.50, '#353c4b'],
  [0.75, '#4a5366'],
  [0.95, '#5e687d'],
];
const SMOOTH_R = 2; // median window radius for the up frames (2 = 5x5; 1 = 3x3 leaves a faint emblem)
const BADGE = { cyan: '#3ad4e8', light: '#bff4fb', dark: '#1b6f80', clip: '#e9edf2' };
const LENS = { rim: '#23252d', glint: '#e8f7ff', arm: '#4a4650' };

// What a mayor pixel is, judging only by its colour.
function classify(c) {
  if (c[3] === 0) return 'clear';
  const { h, s, v } = hsv(c);
  if (v < 0.2) return (h >= 300 || h < 25) && s > 0.45 ? 'darkred' : 'outline';
  if (s < 0.22) return 'grey';                         // hair, beard, cuffs, dark vest
  if (h >= 330 || h < 13) return s >= 0.4 ? 'red' : 'dull'; // robe / greyish-red (robe edge or vest)
  if (h >= 260 && h < 330) return s >= 0.3 ? 'purple' : 'other'; // robe lining in shadow
  if (h < 60) {
    if (h < 21 && s >= 0.55) return 'red';             // orange-lit folds of the robe
    if (h >= 40) return 'olive';                       // the vest's embroidery
    if (s >= 0.53 || h >= 31) return 'gold';           // trim and clasps
    if (v >= 0.7) return 'skin';
    return 'brown';                                    // shaded gold or shaded skin
  }
  return 'other';
}

/**
 * The head: hair + face pixels connected to the top of the hair, widened to the full row span so
 * eyes, mouth and ears inside it are protected too. Recolouring skips everything inside it.
 */
function headMask(frame) {
  const kinds = [];
  for (let y = 0; y < frame.h; y++) for (let x = 0; x < frame.w; x++) kinds.push(classify(frame.get(x, y)));
  const kind = (x, y) => (frame.has(x, y) ? kinds[y * frame.w + x] : 'clear');
  const isHead = (x, y) => kind(x, y) === 'grey' || kind(x, y) === 'skin';

  // Seed: the first light-grey pixel from the top (the crown of the hair).
  let seed = null;
  for (let i = 0; i < kinds.length && !seed; i++) if (kinds[i] === 'grey') seed = [i % frame.w, Math.floor(i / frame.w)];
  const inComp = new Set();
  const stack = [seed];
  while (stack.length) {
    const [x, y] = stack.pop();
    const key = y * frame.w + x;
    if (inComp.has(key) || !isHead(x, y)) continue;
    inComp.add(key);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) stack.push([x + dx, y + dy]);
  }
  // Fill each row between its leftmost and rightmost head pixel, then each column the same way,
  // so the shaded cheek edges and the mouth (which are reddish) end up inside the mask too.
  const mask = new Uint8Array(frame.w * frame.h);
  for (const key of inComp) mask[key] = 1;
  const fillSpans = (outer, inner, index) => {
    for (let a = 0; a < outer; a++) {
      let lo = Infinity;
      let hi = -1;
      for (let b = 0; b < inner; b++) if (mask[index(a, b)]) { lo = Math.min(lo, b); hi = Math.max(hi, b); }
      for (let b = lo; b <= hi; b++) mask[index(a, b)] = 1;
    }
  };
  fillSpans(frame.h, frame.w, (y, x) => y * frame.w + x);
  fillSpans(frame.w, frame.h, (x, y) => y * frame.w + x);
  return { mask, kind };
}

/**
 * Recolour one mayor frame (or the portrait) into the scientist.
 *   reach      how far (px) gold may be from the red cloth and still count as coat trim
 *   minRobe    red blobs smaller than this (px) are vest shading, not robe
 *   keep       extra rectangles [x0, y0, x1, y1] to leave untouched (the portrait's ears)
 *   clasps     ellipses [cx, cy, rx, ry, xMin, xMax] where the mayor's round clasps are painted over
 *   smooth     rectangle [x0, y0, x1, y1] where the cloth shading is median-smoothed (see below)
 *   skinIsGold treat warm skin-like pixels outside the head as pale gold (the portrait has no hands)
 */
function recolourFrame(frame, { reach, minRobe, keep = [], clasps = [], smooth = null, skinIsGold = false }) {
  const { mask, kind: rawKind } = headMask(frame);
  const masked = (x, y) => mask[y * frame.w + x] === 1;
  for (const [x0, y0, x1, y1] of keep) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) mask[y * frame.w + x] = 1;
  }

  const kinds = new Map();
  const kind = (x, y) => kinds.get(y * frame.w + x) ?? rawKind(x, y);
  const setKind = (x, y, k) => kinds.set(y * frame.w + x, k);
  const robeKinds = ['red', 'darkred', 'purple', 'cloth', 'clasp'];
  const isRobe = (x, y) => robeKinds.includes(kind(x, y));

  // Small specks of red away from the robe are shading on the vest, not cloth: they join the shirt.
  const seen = new Set();
  for (let y = 0; y < frame.h; y++) {
    for (let x = 0; x < frame.w; x++) {
      if (seen.has(y * frame.w + x) || !isRobe(x, y) || masked(x, y)) continue;
      const blob = [];
      const stack = [[x, y]];
      while (stack.length) {
        const [px, py] = stack.pop();
        const key = py * frame.w + px;
        if (seen.has(key) || !frame.has(px, py) || !isRobe(px, py) || masked(px, py)) continue;
        seen.add(key);
        blob.push([px, py]);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) stack.push([px + dx, py + dy]);
      }
      if (blob.length < minRobe) blob.forEach(([bx, by]) => setKind(bx, by, 'olive'));
    }
  }

  if (skinIsGold) {
    for (let y = 0; y < frame.h; y++) for (let x = 0; x < frame.w; x++) if (kind(x, y) === 'skin' && !masked(x, y)) setKind(x, y, 'gold');
  }
  for (const [cx, cy, rx, ry, xMin, xMax] of clasps) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.max(xMin, Math.floor(cx - rx)); x <= Math.min(xMax, Math.ceil(cx + rx)); x++) {
        if (((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 < 1 && !masked(x, y)) setKind(x, y, 'clasp');
      }
    }
  }

  // Gold drawn *inside* the cloth (the emblem on the mayor's back) and greyish-red pixels along the
  // robe should vanish into the coat rather than become edges. Such a pixel with 5+ robe neighbours
  // counts as cloth; repeat a few times so thick emblem strokes dissolve from the outside in.
  for (let pass = 0; pass < 3; pass++) {
    const changes = [];
    for (let y = 0; y < frame.h; y++) {
      for (let x = 0; x < frame.w; x++) {
        if (!['gold', 'brown', 'dull'].includes(kind(x, y)) || masked(x, y)) continue;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && isRobe(x + dx, y + dy)) n++;
        if (n >= 5) changes.push([x, y]);
      }
    }
    changes.forEach(([x, y]) => setKind(x, y, 'cloth'));
  }

  const nearRobe = (x, y) => {
    for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) if (isRobe(x + dx, y + dy)) return true;
    return false;
  };
  // Brightness of the red cloth around (x, y), nearer pixels weigh more. Used to paint over
  // emblems and clasps so they disappear into the coat.
  const clothValue = (x, y, radius) => {
    let sum = 0;
    let weight = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (rawKind(x + dx, y + dy) !== 'red' || kind(x + dx, y + dy) === 'clasp') continue;
        const w = 1 / (dx * dx + dy * dy);
        sum += hsv(frame.get(x + dx, y + dy)).v * w;
        weight += w;
      }
    }
    return weight ? sum / weight : null;
  };

  // Inside `smooth` (the back of the up frames), take the median cloth brightness of a 5x5
  // window: wide folds survive, but the thin lines of the mayor's back emblem are wiped out.
  const coatValue = (x, y) => {
    if (kind(x, y) === 'red') return hsv(frame.get(x, y)).v;
    if (kind(x, y) === 'cloth') return clothValue(x, y, 2);
    return null;
  };
  const smoothed = (x, y) => {
    if (!smooth) return null;
    const [x0, y0, x1, y1] = smooth;
    if (x < x0 || x > x1 || y < y0 || y > y1) return null;
    const values = [];
    for (let dy = -SMOOTH_R; dy <= SMOOTH_R; dy++) {
      for (let dx = -SMOOTH_R; dx <= SMOOTH_R; dx++) {
        const cv = coatValue(x + dx, y + dy);
        if (cv !== null) values.push(cv);
      }
    }
    values.sort((a, b) => a - b);
    return values.length ? values[values.length >> 1] : null;
  };

  const out = new Canvas(frame.w, frame.h, frame.data);
  for (let y = 0; y < frame.h; y++) {
    for (let x = 0; x < frame.w; x++) {
      if (masked(x, y)) continue;
      const { v } = hsv(frame.get(x, y));
      switch (kind(x, y)) {
        case 'red':
          out.set(x, y, ramp(COAT, smoothed(x, y) ?? v));
          break;
        case 'purple':
          out.set(x, y, ramp(COAT, v * 0.85));
          break;
        case 'darkred':
          out.set(x, y, ramp(COAT, Math.max(0.08, v * 0.9)));
          break;
        case 'cloth':
          out.set(x, y, ramp(COAT, smoothed(x, y) ?? clothValue(x, y, 2) ?? v));
          break;
        case 'clasp':
          out.set(x, y, ramp(COAT, clothValue(x, y, 10) ?? 0.5));
          break;
        case 'gold':
        case 'brown':
          out.set(x, y, nearRobe(x, y) ? ramp(COAT_EDGE, v) : ramp(SHIRT, v));
          break;
        case 'olive':
          out.set(x, y, ramp(SHIRT, v));
          break;
        default:
          break; // hair, skin, outline, dark vest: unchanged
      }
    }
  }
  return out;
}

// Round glasses. Each lens is three dark rim pixels around a 1 px glint where the pupil was,
// which is how glasses read at this size. Pupil positions were measured on the mayor's frames
// (the head shifts by a pixel while walking, so each frame has its own).
const GLASSES_DOWN = [ // frames 0-3: [left pupil, right pupil] as [x, y] inside the 32x48 frame
  [[13, 15], [18, 15]],
  [[12, 15], [17, 15]],
  [[13, 15], [18, 15]],
  [[12, 15], [18, 15]],
];
const GLASSES_LEFT = [[11, 15], [11, 15], [10, 15], [10, 15]]; // frames 4-7: the one visible pupil

function drawGlassesDown(c, [[lx, ly], [rx, ry]]) {
  for (const [px, py] of [[lx, ly], [rx, ry]]) {
    c.set(px - 1, py, LENS.rim);
    c.set(px + 1, py, LENS.rim);
    c.set(px, py + 1, LENS.rim);
    c.set(px, py, LENS.glint);
  }
  for (let x = lx + 2; x <= rx - 2; x++) c.set(x, ly, LENS.rim); // the bridge over the nose
}

function drawGlassesLeft(c, [px, py]) {
  c.set(px - 1, py, LENS.rim);  // front of the lens
  c.set(px, py, LENS.glint);
  c.set(px, py + 1, LENS.rim);
  c.set(px + 1, py, LENS.rim);
  for (let x = px + 2; x <= px + 4; x++) c.set(x, py, LENS.arm); // the arm back to the ear
}

/**
 * Where the ID badge goes: the spot nearest `target` inside `box` whose whole w x h footprint is
 * red robe cloth on the mayor's frame, so the badge always sits on the coat.
 */
function findCloth(frame, [x0, y0, x1, y1], w, h, [tx, ty]) {
  let best = null;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let ok = true;
      for (let dy = 0; dy < h && ok; dy++) {
        for (let dx = 0; dx < w && ok; dx++) ok = ['red', 'dull', 'darkred'].includes(classify(frame.get(x + dx, y + dy)));
      }
      const d = (x - tx) ** 2 + (y - ty) ** 2;
      if (ok && (!best || d < best.d)) best = { x, y, d };
    }
  }
  return best;
}

// A thin clip-on ID tag: light clip on top, cyan card, a darker line of "text".
const BADGE_SMALL = ['c', 'C', 'd'];
const BADGE_LEGEND = { c: BADGE.light, C: BADGE.cyan, d: BADGE.dark };

async function drawScientistSheet() {
  const mayor = await readPng(MAYOR_SHEET);
  const out = new Canvas(mayor.w, mayor.h);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      const src = mayor.crop(col * 32, row * 48, 32, 48);
      // On the up row, smooth the back of the coat (local rows 19-38) to erase the mayor's emblem.
      const smooth = row === 2 ? [4, 19, 27, 38] : null;
      const frame = recolourFrame(src, { reach: 2, minRobe: 6, smooth });
      if (row === 0) {
        drawGlassesDown(frame, GLASSES_DOWN[col]);
        const spot = findCloth(src, [20, 24, 25, 24], 1, 3, [22, 24]); // the coat's left breast
        if (spot) stamp(frame, BADGE_SMALL, BADGE_LEGEND, spot.x, spot.y);
      }
      if (row === 1) {
        drawGlassesLeft(frame, GLASSES_LEFT[col]);
        const spot = findCloth(src, [4, 26, 11, 26], 1, 3, [7, 26]); // the front of the coat
        if (spot) stamp(frame, BADGE_SMALL, BADGE_LEGEND, spot.x, spot.y);
      }
      out.paste(frame, col * 32, row * 48);
    }
  }
  return out;
}

/** Visit every pixel whose centre lies inside the ellipse. fn(x, y, nx, ny) gets offsets in -1..1. */
function eachInEllipse(cx, cy, rx, ry, fn) {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const nx = (x + 0.5 - cx) / rx;
      const ny = (y + 0.5 - cy) / ry;
      if (nx * nx + ny * ny < 1) fn(x, y, nx, ny);
    }
  }
}

/** A 1 px elliptical ring: inside (rx, ry) but not inside (rx - 1, ry - 1). */
function eachOnRing(cx, cy, rx, ry, fn) {
  eachInEllipse(cx, cy, rx, ry, (x, y, nx, ny) => {
    const ix = (x + 0.5 - cx) / (rx - 1);
    const iy = (y + 0.5 - cy) / (ry - 1);
    if (ix * ix + iy * iy >= 1) fn(x, y, nx, ny);
  });
}

// Portrait glasses: two round wire rims over the eyes, a bridge, arms back to the ears.
const PORTRAIT_LENSES = [[41, 56.5], [60.5, 56.5]];
const PORTRAIT_LENS_R = [6.5, 6];
const PORTRAIT_BADGE = [
  '..kk..',
  '.kWWk.',
  'kCCCCk',
  'kCLLCk',
  'kCLLCk',
  'kCCCCk',
  'kCddCk',
  'kCCCCk',
  '.kkkk.',
];

function drawPortraitExtras(c) {
  const [rx, ry] = PORTRAIT_LENS_R;
  for (const [cx, cy] of PORTRAIT_LENSES) {
    eachInEllipse(cx, cy, rx - 1, ry - 1, (x, y) => c.blend(x, y, rgba(BADGE.light, 40))); // faint glass tint
    eachOnRing(cx, cy, rx, ry, (x, y) => c.set(x, y, LENS.rim));
    // Glint on the upper left of each lens, a smaller one lower right.
    const gx = Math.round(cx - rx * 0.45);
    const gy = Math.round(cy - ry * 0.45);
    c.set(gx, gy, LENS.glint);
    c.set(gx + 1, gy - 1, LENS.glint);
    c.blend(gx, gy + 1, rgba(LENS.glint, 150));
    c.blend(Math.round(cx + rx * 0.45), Math.round(cy + ry * 0.4), rgba(LENS.glint, 170));
  }
  const [[lx, ly], [rxc]] = PORTRAIT_LENSES;
  for (let x = Math.round(lx + rx) - 1; x <= Math.round(rxc - rx); x++) c.set(x, Math.round(ly) - 2, LENS.rim); // bridge
  for (let x = 31; x < Math.round(lx - rx) + 1; x++) c.set(x, Math.round(ly) - 2, LENS.arm);              // left arm
  for (let x = Math.round(rxc + rx); x <= 70; x++) c.set(x, Math.round(ly) - 2, LENS.arm);              // right arm
  stamp(c, PORTRAIT_BADGE, { k: '#1b1d24', W: BADGE.clip, C: BADGE.cyan, L: BADGE.light, d: BADGE.dark }, 74, 85);
}

async function drawScientistPortrait() {
  const mayor = await readPng(MAYOR_PORTRAIT);
  const out = recolourFrame(mayor, {
    reach: 3,
    minRobe: 25,
    keep: [[22, 48, 32, 60], [70, 48, 78, 60]],                            // the ears
    clasps: [[29.5, 80, 7.5, 6.5, 0, 34], [68.5, 78.5, 7.5, 6.5, 65, 95]], // the round collar clasps
    skinIsGold: true,
  });
  drawPortraitExtras(out);
  return out;
}

// ---------------------------------------------------------------------------
// Relay pylon: 4 frames of 24x40, standing on the floor (feet = bottom centre)
// ---------------------------------------------------------------------------

const RELAY_W = 24;
const RELAY_H = 40;
const RELAY_PULSE = [0, 2, 3, 1];      // core brightness per frame: brighter on frames 1-2
const RELAY_RING_BOB = [0, -1, -1, 0]; // the floating ring drifts up a pixel while the core is bright
const RELAY = {
  outline: '#161922',                                // same outline as the Warden drone
  white: ['#4f5a6e', '#8794a8', '#c0c9d6', '#e6ebf2'], // white shell, dark -> light
  spec: '#fbfdff',
  steel: ['#2f3747', '#4e5a6f', '#76839a', '#9ca8bb'], // silver base, dark -> light
  core: [                                            // per pulse level: edge, body, hot
    ['#145565', '#1b8ea3', '#4fd2e6'],
    ['#1b7286', '#2fbfd6', '#7ee6f3'],
    ['#27a0b6', '#4fdcef', '#b5f5fc'],
    ['#3ad4e8', '#8ff0fa', '#effeff'],
  ],
  glow: '#3ad4e8',
  glowCore: '#a8f2fb',
};

/** Shade a symmetric metal part: the left half is lit, the right half falls into shadow. */
function metalTone(x, x0, x1, tones) {
  const t = (x - x0) / Math.max(1, x1 - x0); // 0 = left edge, 1 = right edge
  if (t < 0.2) return tones[3];
  if (t < 0.55) return tones[2];
  if (t < 0.85) return tones[1];
  return tones[0];
}

function drawRelay(frame) {
  const pulse = RELAY_PULSE[frame];
  const [coreEdge, coreBody, coreHot] = RELAY.core[pulse];
  const body = new Canvas(RELAY_W, RELAY_H);
  const fillRow = (y, x0, x1, tones) => {
    for (let x = x0; x <= x1; x++) body.set(x, y, metalTone(x, x0, x1, tones));
  };

  // Base: a wide silver foot plate (rows 36-38) under a white plinth (rows 32-35).
  for (let y = 36; y <= 38; y++) fillRow(y, 4, 19, RELAY.steel);
  for (let x = 5; x <= 18; x++) body.set(x, 36, x < 12 ? RELAY.steel[3] : RELAY.steel[2]); // lit top edge
  for (let y = 32; y <= 35; y++) fillRow(y, 6, 17, RELAY.white);
  for (let x = 7; x <= 15; x++) body.set(x, 32, RELAY.spec);                               // lit top edge
  for (let x = 9; x <= 14; x++) body.set(x, 34, x === 9 || x === 14 ? coreEdge : coreBody); // glowing slit

  // Column: two white rails with the glowing core between them (rows 10-31).
  for (let y = 10; y <= 31; y++) {
    body.set(8, y, RELAY.white[3]);
    body.set(9, y, RELAY.white[2]);
    body.set(14, y, RELAY.white[1]);
    body.set(15, y, RELAY.white[0]);
    body.set(10, y, coreBody);
    body.set(11, y, coreHot);
    body.set(12, y, coreHot);
    body.set(13, y, coreEdge);
  }
  // Collars hold the rails together.
  for (const y of [17, 25]) {
    fillRow(y, 7, 16, RELAY.white);
    fillRow(y + 1, 7, 16, RELAY.steel);
  }

  // Head: a tapered emitter with a hot tip that feeds the floating ring.
  fillRow(9, 7, 16, RELAY.white);
  fillRow(8, 8, 15, RELAY.white);
  fillRow(7, 9, 14, RELAY.steel);
  body.set(10, 6, RELAY.steel[2]);
  body.set(11, 6, coreHot);
  body.set(12, 6, coreHot);
  body.set(13, 6, RELAY.steel[1]);
  body.set(8, 8, RELAY.spec);

  const out = new Canvas(RELAY_W, RELAY_H);

  // Soft cyan pool of light on the floor around the foot (no outline).
  eachInEllipse(11.5 + 0.5, 38.5, 11.5, 2.4, (x, y, nx, ny) => {
    const d = Math.sqrt(nx * nx + ny * ny);
    const a = Math.pow(1 - d * d, 1.3) * (0.28 + 0.07 * pulse);
    out.blend(x, y, rgba(d < 0.45 ? RELAY.glowCore : RELAY.glow, Math.round(255 * a)));
  });
  out.paste(outlined(body, RELAY.outline));

  // Faint beam from the tip up to the ring.
  const ringY = 2.5 + RELAY_RING_BOB[frame];
  for (let y = Math.ceil(ringY) + 1; y <= 5; y++) {
    out.blend(11, y, rgba(RELAY.glowCore, 70 + 35 * pulse));
    out.blend(12, y, rgba(RELAY.glowCore, 70 + 35 * pulse));
  }

  // The floating ring: a flat ellipse, back half dim, front half bright, with a soft halo.
  eachInEllipse(12, ringY, 6.5, 2.6, (x, y) => out.blend(x, y, rgba(RELAY.glow, 22 + 10 * pulse)));
  eachOnRing(12, ringY, 5, 1.8, (x, y, nx, ny) => {
    const front = ny > 0;
    const lit = nx < -0.2;
    const color = front ? (lit ? coreHot : RELAY.core[Math.min(3, pulse + 1)][1]) : coreEdge;
    out.set(x, y, color);
  });

  return out;
}

// ---------------------------------------------------------------------------
// FX textures
// ---------------------------------------------------------------------------

function fxSilver() {
  const c = new Canvas(3, 3);
  stamp(c, ['oOo', 'OWO', 'oOo'], { W: '#ffffff', O: '#d6dde8', o: rgba('#8f9aad', 140) }, 0, 0);
  return c;
}

function fxAsh() {
  const c = new Canvas(3, 3);
  // Slightly lopsided so a cloud of them doesn't look stamped.
  stamp(c, ['ab.', 'bAb', '.ba'], { A: rgba('#8b8a8f', 235), b: rgba('#6f6e74', 170), a: rgba('#5c5b61', 80) }, 0, 0);
  return c;
}

function fxMemory() {
  const c = new Canvas(16, 4);
  const rowAlpha = [0.3, 1, 1, 0.3];
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 16; x++) {
      const along = Math.pow(Math.sin(Math.PI * (x + 0.5) / 16), 1.6); // fades at both ends
      c.set(x, y, rgba('#ffffff', Math.round(235 * along * rowAlpha[y])));
    }
  }
  return c;
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/** Nearest-neighbour upscale to a PNG buffer. */
const zoomed = (c, z) => toSharp(c).resize(c.w * z, c.h * z, { kernel: 'nearest' }).png().toBuffer();

function label(text, width = 1000) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="22">
    <text x="0" y="16" font-family="Menlo, monospace" font-size="15" fill="#9a8f7c">${text}</text></svg>`;
  return Buffer.from(svg);
}

/** Thin frame separators drawn over a zoomed sheet. */
function frameGrid(frameW, frameH, cols, rows, z) {
  const w = frameW * cols * z;
  const h = frameH * rows * z;
  let lines = '';
  for (let i = 1; i < cols; i++) lines += `<line x1="${i * frameW * z + 0.5}" y1="0" x2="${i * frameW * z + 0.5}" y2="${h}" stroke="#3a3f52"/>`;
  for (let j = 1; j < rows; j++) lines += `<line x1="0" y1="${j * frameH * z + 0.5}" x2="${w}" y2="${j * frameH * z + 0.5}" stroke="#3a3f52"/>`;
  lines += `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" fill="none" stroke="#3a3f52"/>`;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${lines}</svg>`);
}

async function writePreview({ sci, por, relay, fx }) {
  const mayor = await readPng(MAYOR_SHEET);
  const mayorPortrait = await readPng(MAYOR_PORTRAIT);
  const parts = [];
  const pad = 16;
  let y = pad;
  const add = async (c, z, left, top) => parts.push({ input: await zoomed(c, z), left, top });

  // 1. Sheets at 4x: mayor (source) and scientist (result).
  parts.push({ input: label('mayor.png (source)  4x'), left: pad, top: y });
  parts.push({ input: label('scientist.png  128x144  rows: down / left / up  4x'), left: pad + 512 + pad, top: y });
  y += 26;
  await add(mayor, 4, pad, y);
  parts.push({ input: frameGrid(32, 48, 4, 3, 4), left: pad, top: y });
  await add(sci, 4, pad * 2 + 512, y);
  parts.push({ input: frameGrid(32, 48, 4, 3, 4), left: pad * 2 + 512, top: y });
  y += 576 + 20;

  // 2. Portraits at 3x, plus the scientist portrait at 1x (dialogue size check).
  parts.push({ input: label('portraits 3x: mayor / scientist, and scientist at 1x'), left: pad, top: y });
  y += 26;
  await add(mayorPortrait, 3, pad, y);
  await add(por, 3, pad * 2 + 288, y);
  await add(por, 1, pad * 3 + 576, y);
  // Game scale (2x) check next to the portraits: scientist, mayor, relay, a few particles.
  const mock = new Canvas(150, 96);
  const floor = await readPng('public/assets/props/metal-floor.png').catch(() => null);
  for (let fy = 0; fy < mock.h; fy++) {
    for (let fx0 = 0; fx0 < mock.w; fx0++) mock.set(fx0, fy, floor ? floor.get(fx0 % floor.w, fy % floor.h) : '#2a2e3a');
  }
  mock.paste(sci.crop(0, 0, 32, 48), 8, 30);
  mock.paste(sci.crop(32, 48, 32, 48), 42, 30);
  mock.paste(mayor.crop(0, 0, 32, 48), 76, 30);
  mock.paste(relay.crop(48, 0, 24, 40), 116, 40);
  mock.paste(fx[0], 120, 20).paste(fx[0], 128, 30).paste(fx[1], 100, 14).paste(fx[1], 108, 24);
  parts.push({ input: label('game scale 2x'), left: pad * 4 + 672, top: y - 26 });
  await add(mock, 2, pad * 4 + 672, y);
  y += 288 + 20;

  // 3. Relay frames at 6x and FX at 8x.
  parts.push({ input: label('relay.png  96x40  4 frames  6x (core pulse 0/2/3/1, ring bob)'), left: pad, top: y });
  parts.push({ input: label('fx 8x: silver 3x3, ash 3x3, memory 16x4'), left: pad * 3 + 576, top: y });
  y += 26;
  await add(relay, 6, pad, y);
  parts.push({ input: frameGrid(24, 40, 4, 1, 6), left: pad, top: y });
  let x = pad * 3 + 576;
  for (const c of fx) {
    await add(c, 8, x, y);
    x += c.w * 8 + 24;
  }
  y += 240 + pad;

  const width = pad * 3 + 1024;
  await sharp({ create: { width, height: y, channels: 4, background: PREVIEW_BG } })
    .composite(parts).png().toFile(OUT.preview);
  console.log(`  ${OUT.preview}  ${width}x${y}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await mkdir('public/assets/characters', { recursive: true });
  await mkdir('public/assets/portraits', { recursive: true });
  await mkdir('public/assets/creatures', { recursive: true });
  await mkdir(OUT.fx, { recursive: true });
  await mkdir('tools/previews', { recursive: true });

  const sci = await drawScientistSheet();
  const por = await drawScientistPortrait();
  const relay = sheet([0, 1, 2, 3].map(drawRelay));
  const fx = { 'fx-silver': fxSilver(), 'fx-ash': fxAsh(), 'fx-memory': fxMemory() };

  await writePng(sci, OUT.sheet);
  await writePng(por, OUT.portrait);
  await writePng(relay, OUT.relay);
  for (const [name, c] of Object.entries(fx)) await writePng(c, `${OUT.fx}/${name}.png`);
  await writePreview({ sci, por, relay, fx: Object.values(fx) });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

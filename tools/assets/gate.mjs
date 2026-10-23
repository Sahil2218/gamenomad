// THE NOMAD: Paradise Gate map generator (task N, Milestone 3, Act IV "The White Cloud").
//
// Run from the project root:   node tools/assets/gate.mjs
// Optional scratch output:      node tools/assets/gate.mjs --debug /tmp/nomad-n
//
// What it does:
//   1. Paints public/assets/maps/gate.png (1448 x 1500).
//      South: the arrival road (cracked wasteland asphalt) fading into dirt and ash.
//      Middle: a dead grey ash plain with dunes, a broken old highway, rubble belts at the sides
//      and three abandoned pilgrim camps (tents, packs, dead fires, bleached bones, wrecks).
//      North (top ~38%): a colossal wall of white cloud, painted procedurally from hundreds of
//      shaded "lobes", posterised to a small palette with an ordered dither so it reads as pixel
//      art. The stone arch from the portal prop card stands at its foot, half swallowed, glowing
//      white, with mist tendrils and a bloom of pearly light on the ground in front of it.
//      Ground is "patch quilted" from real regions of the wasteland map (as in outskirts.mjs).
//   2. Writes src/data/maps/gate.json straight from the same placement data, so every
//      collider rectangle is exactly where its prop (or the cloud) was drawn.
//   3. Verifies the layout (reachability, the approach band, sealing, hazard-free route,
//      clearances) and prints a PASS/FAIL list. Exits non-zero on failure.
//   4. Writes tools/previews/gate-small.png and tools/previews/gate-overlay.png.
//
// Everything is seeded, so a re-run produces the same map.
// Helpers marked "from outskirts.mjs" are copies of the ones in tools/assets/outskirts.mjs.

import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RAW = (name) => path.join(ROOT, 'raw-assets', name);
const CARD = (name) => path.join(ROOT, 'public', 'assets', 'props', `${name}.png`);
const OUT_PNG = path.join(ROOT, 'public', 'assets', 'maps', 'gate.png');
const OUT_JSON = path.join(ROOT, 'src', 'data', 'maps', 'gate.json');
const PREVIEW_SMALL = path.join(ROOT, 'tools', 'previews', 'gate-small.png');
const PREVIEW_OVERLAY = path.join(ROOT, 'tools', 'previews', 'gate-overlay.png');

// ---------------------------------------------------------------------------
// Map geometry

const W = 1448;
const H = 1500;
const SEED = 4404;

// The arch: the portal card scaled 2x, centred on x, with its threshold (the bottom of the
// glowing opening, i.e. the top of the steps) at y = T.
const ARCH_SCALE = 2;
const ARCH = { x: 724, T: 580 };
// Card-pixel geometry of public/assets/props/portal.png (143 x 168), measured once.
const CARD_OPENING = { x0: 44, x1: 98, y0: 40, y1: 121 }; // the glowing interior
const CARD_THRESHOLD_Y = 122;                            // top step = bottom of the opening
const CARD_PLATFORM_BOTTOM = 153;                         // bottom step's front edge

// Player body (contract §8): 16 x 10 at the feet.
const BODY_W = 16;
const BODY_H = 10;
const GRID = 2;
const INTERACT_RADIUS = 28;
const CLEARANCE = 20;
const EDGE_CLEARANCE = 40;
const EDGE_MARGIN = 6;

// Procedural art (cloud, mist, glow, tents) is computed on blocks of ART px, so it has the same
// chunky "art pixel" size as the hand-made maps instead of looking airbrushed.
const ART = 3;

// ---------------------------------------------------------------------------
// Small math helpers (from outskirts.mjs)

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Seeded random numbers (mulberry32). */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer lattice hash in [0, 1). */
function hash2(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1]. */
function valueNoise(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
}

/** Multi-octave value noise, roughly centred on 0.5. */
function fbm(x, y, seed, octaves = 4) {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x * freq, y * freq, seed + i * 101);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

function rgbToHsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, mx > 0 ? d / mx : 0, mx / 255];
}

function hsvToRgb(h, s, v, out) {
  h = ((h % 360) + 360) % 360;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  out[0] = (r + m) * 255; out[1] = (g + m) * 255; out[2] = (b + m) * 255;
  return out;
}

/** Colour shift: rotate hue, scale saturation and value. k = 0 leaves it, k = 1 is the full shift. */
function shiftColor(c, k, { dh = 0, ks = 1, kv = 1 }) {
  if (k <= 0) return c;
  const [h, s, v] = rgbToHsv(c[0], c[1], c[2]);
  return hsvToRgb(h + dh * k, s * lerp(1, ks, k), Math.min(1, v * lerp(1, kv, k)), c);
}

/** 4x4 ordered (Bayer) dither threshold in [0, 1) for an art-pixel cell. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const bayer = (cx, cy) => (BAYER[(cy & 3) * 4 + (cx & 3)] + 0.5) / 16;

/** Posterises v (0..1) into `levels` steps with an ordered dither of `amount` steps. */
function posterize(v, levels, cx, cy, amount = 0.6) {
  const q = Math.floor(clamp(v, 0, 1) * (levels - 1) + 0.5 + (bayer(cx, cy) - 0.5) * amount);
  return clamp(q, 0, levels - 1);
}

// Colour shifts used on the props and the ground.
const ASH = { dh: 6, ks: 0.32, kv: 0.9 };            // wasteland dirt -> grey-brown ash
const ASH_PLAIN = { dh: 10, ks: 0.16, kv: 1.04 };    // -> the pale grey of the dead plain
const PALE_ASH = { dh: 30, ks: 0.1, kv: 1.08 };      // -> wind-swept light ash
const ROCK_GREY = { dh: 6, ks: 0.36, kv: 0.8 };      // the orange rock-pile card -> grey rubble
const DUSTED = { dh: 4, ks: 0.55, kv: 0.92 };        // wasteland crops, dusted with ash
const BONE = { dh: 10, ks: 0.2, kv: 1.26 };         // rock-pile card -> bleached bones
const DEAD_WOOD = { dh: 0, ks: 0.5, kv: 0.86 };       // dead trees, greyed by the ash

// ---------------------------------------------------------------------------
// Image IO

async function loadRaw(file, channels = 3) {
  const img = sharp(file);
  const pipeline = channels === 3 ? img.removeAlpha() : img.ensureAlpha();
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height, ch: info.channels };
}

// ---------------------------------------------------------------------------
// Texture sources (top-left corners of hand-checked windows, from outskirts.mjs).

const SOURCES = {
  // Wasteland bare dirt (64 x 64) and road asphalt (72 x 72).
  dirt: { size: 64, at: [[1048, 232], [360, 904], [1048, 584], [1296, 704], [920, 248], [504, 0], [1168, 816], [1072, 760], [784, 680], [1304, 944]] },
  asphalt: { size: 72, at: [[708, 564], [1368, 504], [576, 540], [432, 804], [624, 156], [696, 240], [372, 360], [492, 768], [456, 888], [600, 0], [648, 528]] },
  // The sludge palette for the toxic patches is sampled inside this wasteland region.
  toxic: { search: { x: 1090, y: 0, w: 358, h: 400 } },
};

/** Lime-green sludge pixels (used to find toxic source windows). */
const isSludge = (h, s, v) => h >= 62 && h <= 112 && s >= 0.5 && v >= 0.42;

/** From outskirts.mjs: finds source windows whose pixels mostly pass `test`. */
function findWindows(img, region, size, test, minFrac, step = 6) {
  const found = [];
  for (let y = region.y; y + size <= region.y + region.h && y + size <= img.h; y += step) {
    for (let x = region.x; x + size <= region.x + region.w && x + size <= img.w; x += step) {
      let n = 0, hit = 0;
      for (let yy = y; yy < y + size; yy += 2) {
        for (let xx = x; xx < x + size; xx += 2) {
          const i = (yy * img.w + xx) * img.ch;
          const [h, s, v] = rgbToHsv(img.data[i], img.data[i + 1], img.data[i + 2]);
          n++;
          if (test(h, s, v)) hit++;
        }
      }
      if (hit / n >= minFrac) found.push([x, y, hit / n]);
    }
  }
  found.sort((a, b) => b[2] - a[2]);
  const keep = [];
  for (const f of found) {
    if (keep.every((k) => Math.abs(k[0] - f[0]) >= size * 0.6 || Math.abs(k[1] - f[1]) >= size * 0.6)) keep.push(f);
  }
  return keep.slice(0, 16).map(([x, y]) => [x, y]);
}

/**
 * Patch quilting sampler (from outskirts.mjs).
 * The plane is split into jittered cells (Worley cells, warped by noise so their borders are
 * organic). Each cell shows a piece of one randomly chosen source window, optionally mirrored,
 * at its natural pixel scale. Neighbouring cells cross-fade over a couple of pixels.
 */
function makeQuilt(img, src, { cell, jitter = 0.36, warp = 5, feather = 2.2, seed }) {
  const half = src.size / 2;
  const centers = src.at.map(([x, y]) => [x + half, y + half]);
  const cache = new Map();
  const ch = img.ch;

  function cellInfo(gx, gy) {
    const key = gx * 65536 + gy;
    let info = cache.get(key);
    if (!info) {
      info = {
        px: (gx + 0.5 + (hash2(gx, gy, seed) - 0.5) * 2 * jitter) * cell,
        py: (gy + 0.5 + (hash2(gx, gy, seed + 1) - 0.5) * 2 * jitter) * cell,
        c: centers[Math.floor(hash2(gx, gy, seed + 2) * centers.length)],
        flip: hash2(gx, gy, seed + 3) < 0.5,
        ox: Math.floor((hash2(gx, gy, seed + 4) - 0.5) * half * 0.6),
        oy: Math.floor((hash2(gx, gy, seed + 5) - 0.5) * half * 0.6),
      };
      cache.set(key, info);
    }
    return info;
  }

  const lim = half - 1;
  const reflect = (o) => {
    const a = Math.abs(o);
    if (a <= lim) return o;
    const r = 2 * lim - a;
    return Math.sign(o) * Math.max(-lim, r);
  };

  function fetch(info, x, y, out) {
    let ox = x - info.px + info.ox;
    const oy = y - info.py + info.oy;
    if (info.flip) ox = -ox;
    const sx = Math.round(info.c[0] + reflect(ox));
    const sy = Math.round(info.c[1] + reflect(oy));
    const i = (sy * img.w + sx) * ch;
    out[0] = img.data[i]; out[1] = img.data[i + 1]; out[2] = img.data[i + 2];
    return out;
  }

  const a = [0, 0, 0], b = [0, 0, 0];
  return function sample(x, y, out) {
    const wx = x + (valueNoise(x / 11, y / 11, seed + 7) - 0.5) * 2 * warp;
    const wy = y + (valueNoise(x / 11, y / 11, seed + 8) - 0.5) * 2 * warp;
    const gx = Math.floor(wx / cell), gy = Math.floor(wy / cell);
    let d1 = Infinity, d2 = Infinity, c1 = null, c2 = null;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const info = cellInfo(gx + dx, gy + dy);
        const d = (wx - info.px) ** 2 + (wy - info.py) ** 2;
        if (d < d1) { d2 = d1; c2 = c1; d1 = d; c1 = info; } else if (d < d2) { d2 = d; c2 = info; }
      }
    }
    fetch(c1, x, y, a);
    const edge = Math.sqrt(d2) - Math.sqrt(d1);
    if (edge < feather && c2) {
      fetch(c2, x, y, b);
      const t = 0.5 * (1 - edge / feather);
      out[0] = lerp(a[0], b[0], t); out[1] = lerp(a[1], b[1], t); out[2] = lerp(a[2], b[2], t);
    } else {
      out[0] = a[0]; out[1] = a[1]; out[2] = a[2];
    }
    return out;
  };
}

// ---------------------------------------------------------------------------
// Layout curves (from outskirts.mjs)

/** Catmull-Rom spline through points [[x, y], ...], returned as a dense polyline. */
function spline(points, steps = 24) {
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)], p1 = points[i], p2 = points[i + 1], p3 = points[Math.min(points.length - 1, i + 2)];
    for (let s = 0; s < steps; s++) {
      const t = s / steps, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

/** Piecewise smooth interpolation of [[y, value], ...] keyed by y. */
function curveY(keys) {
  return (y) => {
    if (y <= keys[0][0]) return keys[0][1];
    for (let i = 0; i < keys.length - 1; i++) {
      const [y0, v0] = keys[i], [y1, v1] = keys[i + 1];
      if (y <= y1) return lerp(v0, v1, smoothstep(y0, y1, y));
    }
    return keys[keys.length - 1][1];
  };
}

// The road: from the south edge, cracked asphalt -> the broken old highway -> worn flagstones
// -> the arch steps. Listed south to north.
const ROAD_POINTS = [
  [690, 1540], [692, 1440], [704, 1360], [734, 1262], [756, 1164], [752, 1064], [738, 966],
  [728, 870], [724, 780], [724, 700], [724, 640],
];
const ROAD_POLY = spline(ROAD_POINTS).reverse(); // north -> south, so y increases along it
const roadHalfWidth = curveY([[640, 52], [700, 44], [860, 44], [930, 70], [1000, 76], [1240, 74], [1310, 56], [1500, 54]]);

// Road sections by y: 0 = flagstones, 1 = highway, 2 = arrival road.
const STONE_END = 905;   // flagstones north of this
const HIGHWAY_END = 1300; // highway between STONE_END and this; arrival road south of it

/** x of the road centre at row y. */
function roadX(y) {
  for (let i = 0; i < ROAD_POLY.length - 1; i++) {
    const [x0, y0] = ROAD_POLY[i], [x1, y1] = ROAD_POLY[i + 1];
    if (y >= y0 && y <= y1) return lerp(x0, x1, (y - y0) / Math.max(1e-6, y1 - y0));
  }
  return y < ROAD_POLY[0][1] ? ROAD_POLY[0][0] : ROAD_POLY[ROAD_POLY.length - 1][0];
}

/** Distance from (x, y) to the road centre line. */
function roadDistance(x, y) {
  let best = Infinity;
  for (let i = 0; i < ROAD_POLY.length - 1; i++) {
    const [x0, y0] = ROAD_POLY[i], [x1, y1] = ROAD_POLY[i + 1];
    if (Math.min(y0, y1) > y + 140 || Math.max(y0, y1) < y - 140) continue;
    const dx = x1 - x0, dy = y1 - y0;
    const t = clamp(((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy || 1), 0, 1);
    const d = Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy));
    if (d < best) best = d;
  }
  return best;
}

// Inner edges of the impassable side belts (rubble, dunes, ruins).
const beltLeft = curveY([[560, 330], [700, 318], [820, 300], [960, 284], [1100, 300], [1220, 360], [1330, 440], [1420, 470], [1500, 478]]);
const beltRight = curveY([[560, 1116], [700, 1124], [840, 1146], [980, 1170], [1120, 1150], [1230, 1080], [1330, 1000], [1420, 966], [1500, 960]]);

/**
 * Target line for the foot of the cloud wall (the painted lobes are fitted to it; the real
 * collider edge is measured from the painted cloud afterwards).
 */
function cloudBase(x) {
  let y = 546 + (fbm(x / 210, 2.3, SEED + 11, 3) - 0.5) * 84;
  // The cloud comes down over the side belts, wrapping the play space.
  y += 150 * smoothstep(420, 120, x) + 150 * smoothstep(1030, 1330, x);
  // Close to the arch it hugs the pillars down to the level of the threshold.
  const ax = Math.abs(x - ARCH.x);
  y = lerp(y, ARCH.T - 4, smoothstep(250, 150, ax));
  return y;
}

/** 0 = wasteland dirt (south), 1 = dead ash plain (north). Organic, noise-wobbled boundary. */
function ashAt(x, y) {
  const base = (1470 - y) / 420;
  const big = (fbm(x / 220, y / 180, SEED + 1, 4) - 0.5) * 0.8;
  const small = (fbm(x / 46, y / 46, SEED + 2, 3) - 0.5) * 0.16;
  return clamp(base + big + small, 0, 1.4);
}

// ---------------------------------------------------------------------------
// Gameplay layout (all coordinates are map pixels).

const SPAWN = { x: 692, y: 1438, facing: 'up' };
const CHECKPOINTS = [
  { id: 'gt-cp-1', x: 640, y: 1396, w: 104, h: 70, respawn: { x: SPAWN.x, y: SPAWN.y } },
];

// Arch-relative positions (T = threshold y).
const T = ARCH.T;
const PASSAGE = { x0: ARCH.x - 51, x1: ARCH.x + 51 };   // walkable gap between the pillars
const ENTER_ZONE = { id: 'enter', x: PASSAGE.x0 + 6, y: T - 26, w: PASSAGE.x1 - PASSAGE.x0 - 12, h: 28 };
const ENTER_CENTRE = { x: ENTER_ZONE.x + ENTER_ZONE.w / 2, y: ENTER_ZONE.y + ENTER_ZONE.h / 2 };
const APPROACH_Y0 = T + 206, APPROACH_Y1 = T + 250;
const POINTS = {
  'party-halt': { x: ARCH.x, y: T + 170 },
  'eli-enter': { x: Math.round(ENTER_CENTRE.x), y: Math.round(ENTER_CENTRE.y) },
  'eli-collapse': { x: ARCH.x, y: T + 72 },
};

// Toxic patches (small, well off the road). The hazard is the blob's core.
const POOLS = [
  { id: 'poolW', cx: 404, cy: 1196, rx: 36, ry: 22, p: 2.4 },
  { id: 'poolE', cx: 924, cy: 1368, rx: 30, ry: 18, p: 2.4 },
];

// The camps. A is the largest (inspectable "pilgrims").
const CAMP_A = { x: 470, y: 1000 };
const CAMP_B = { x: 1000, y: 892 };
const CAMP_C = { x: 556, y: 1262 };

const WATER_1 = { id: 'gt-water-1', item: 'water', x: 526, y: 1086, dialogue: null };
const RATION_1 = { id: 'gt-ration-1', item: 'ration', x: 968, y: 972, dialogue: null };

const CRAWLERS = [{ id: 'gt-c1', x: 1064, y: 1136, count: 2, radius: 46 }];

// ---------------------------------------------------------------------------
// Prop definitions.
//
// Cards (public/assets/props), crops of the wasteland map ([left, top, width, height]) and a few
// small procedural sprites (tents, packs, banners, cairns) painted at the art-pixel size.

const ELLIPSE = (rx = 0.46, ry = 0.46, extra = {}) => ({ cx: 0.5, cy: 0.5, rx, ry, p: 2.3, feather: 0.16, wobble: 0.06, ...extra });

const PROP_DEFS = {
  rockpile: { card: 'rock-pile', mask: ELLIPSE(0.47, 0.45, { feather: 0.2 }), solid: true, shadow: 0.6 },
  bones:    { card: 'rock-pile', mask: ELLIPSE(0.42, 0.4, { feather: 0.3, wobble: 0.1 }), solid: true, shadow: 0.35 },
  deadfire: { card: 'burning-debris', mask: ELLIPSE(0.44, 0.42, { feather: 0.28, wobble: 0.1 }), solid: true, shadow: 0.3, recolor: 'embers' },
  deadcard: { card: 'dead-tree', cutCrop: true, solid: true, shadow: 0.6 },
  deadA:    { crop: [684, 318, 100, 150], cutCrop: true, solid: true, shadow: 0.6 },
  deadB:    { crop: [1112, 800, 100, 132], cutCrop: true, solid: true, shadow: 0.6 },
  deadC:    { crop: [10, 785, 112, 160], cutCrop: true, solid: true, shadow: 0.6 },
  deadE:    { crop: [995, 32, 80, 132], cutCrop: true, solid: true, shadow: 0.6 },
  deadS:    { crop: [532, 595, 52, 95], cutCrop: true, solid: true, shadow: 0.5 },
  carBrown: { crop: [716, 133, 172, 105], mask: ELLIPSE(0.48, 0.46, { p: 3, feather: 0.14 }), solid: true, shadow: 0.8 },
  carRed:   { crop: [418, 244, 162, 104], mask: ELLIPSE(0.48, 0.46, { p: 3, feather: 0.14 }), solid: true, shadow: 0.8 },
  carDark:  { crop: [1104, 626, 150, 100], mask: ELLIPSE(0.48, 0.46, { p: 3, feather: 0.14 }), solid: true, shadow: 0.8 },
  van:      { crop: [190, 778, 172, 118], mask: ELLIPSE(0.48, 0.46, { p: 3, feather: 0.14 }), solid: true, shadow: 0.8 },
  vanGrey:  { crop: [985, 391, 202, 159], mask: ELLIPSE(0.48, 0.47, { p: 3, feather: 0.14 }), solid: true, shadow: 0.8 },
  wall1:    { crop: [950, 878, 140, 85], mask: ELLIPSE(0.49, 0.48, { p: 3.5, feather: 0.12 }), solid: true, shadow: 0.5 },
  wall2:    { crop: [1115, 170, 120, 80], mask: ELLIPSE(0.49, 0.48, { p: 3.5, feather: 0.12 }), solid: true, shadow: 0.5 },
  barricade:{ crop: [480, 370, 100, 55], mask: ELLIPSE(0.49, 0.47, { p: 3.5, feather: 0.14 }), solid: true, shadow: 0.5 },
  crates:   { crop: [222, 688, 76, 82], mask: ELLIPSE(0.48, 0.48, { p: 3, feather: 0.16 }), solid: true, shadow: 0.6 },
  barrels:  { crop: [855, 108, 66, 64], mask: ELLIPSE(0.48, 0.47, { p: 3, feather: 0.18 }), solid: true, shadow: 0.6 },
  rubbleL:  { crop: [0, 262, 92, 120], mask: ELLIPSE(0.48, 0.47, { feather: 0.24, cx: 0.52 }), solid: true, shadow: 0.4 },
  rubbleE:  { crop: [1346, 696, 100, 112], mask: ELLIPSE(0.47, 0.47, { feather: 0.24 }), solid: true, shadow: 0.4 },
  tent:     { proc: 'tent', solid: true, shadow: 0.7 },
  tentSmall:{ proc: 'tentSmall', solid: true, shadow: 0.7 },
  tentTorn: { proc: 'tentTorn', solid: true, shadow: 0.7 },
  pack:     { proc: 'pack', solid: true, shadow: 0.5 },
  bedroll:  { proc: 'bedroll', solid: true, shadow: 0.5 },
  banner:   { proc: 'banner', solid: true, shadow: 0.4 },
  cairn:    { proc: 'cairn', solid: true, shadow: 0.5 },
};

// ---------------------------------------------------------------------------
// Prop sprite preparation (masks and cut-outs from outskirts.mjs)

/** Soft, noise-wobbled superellipse alpha mask, written into an RGBA buffer in place. */
function applyMask(rgba, w, h, m, seed) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = (x + 0.5) / w - m.cx, ny = (y + 0.5) / h - m.cy;
      const r = (Math.abs(nx / m.rx) ** m.p + Math.abs(ny / m.ry) ** m.p) ** (1 / m.p);
      const wob = (valueNoise(x / 7, y / 7, seed) - 0.5) * 2 * m.wobble;
      const a = smoothstep(1, 1 - m.feather, r + wob);
      const i = (y * w + x) * 4 + 3;
      rgba[i] = Math.round(rgba[i] * a);
    }
  }
}

/**
 * Cut-out for map crops (dead trees): flood-fill the crop's own ground away from its border,
 * keep a soft core around the trunk base so the roots stay planted, and fade the far corners.
 */
function cutOutCrop(rgba, w, h, seed, tol = 26, grad = 36) {
  const N = w * h;
  const ring = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < 3 || y < 3 || x >= w - 3 || y >= h - 3) ring.push(y * w + x);
  const counts = new Map();
  const key = (i) => ((rgba[i * 4] >> 3) << 10) | ((rgba[i * 4 + 1] >> 3) << 5) | (rgba[i * 4 + 2] >> 3);
  for (const i of ring) counts.set(key(i), (counts.get(key(i)) || 0) + 1);
  const palette = [...counts.entries()].filter(([, c]) => c / ring.length > 0.004)
    .map(([k]) => [((k >> 10) & 31) * 8 + 4, ((k >> 5) & 31) * 8 + 4, (k & 31) * 8 + 4])
    .filter((c) => Math.max(...c) > 70);
  const nearBg = (i) => Math.max(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]) > 60 &&
    palette.some((p) => Math.abs(rgba[i * 4] - p[0]) + Math.abs(rgba[i * 4 + 1] - p[1]) + Math.abs(rgba[i * 4 + 2] - p[2]) < tol);
  const diff = (a, b) => Math.abs(rgba[a * 4] - rgba[b * 4]) + Math.abs(rgba[a * 4 + 1] - rgba[b * 4 + 1]) + Math.abs(rgba[a * 4 + 2] - rgba[b * 4 + 2]);
  const bg = new Uint8Array(N);
  const stack = [];
  for (const i of ring) if (nearBg(i)) { bg[i] = 1; stack.push(i); }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w, y = (i - x) / w;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (!bg[n] && nearBg(n) && diff(i, n) < grad) { bg[n] = 1; stack.push(n); }
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const nx = (x + 0.5) / w - 0.5, ny = (y + 0.5) / h;
      const core = smoothstep(1, 0.4, Math.hypot(nx / 0.26, (ny - 0.86) / 0.13));
      const broad = smoothstep(1, 0.86, Math.hypot(nx / 0.5, (ny - 0.5) / 0.5) + (valueNoise(x / 6, y / 6, seed) - 0.5) * 0.1);
      let a = bg[i] ? 0 : 1;
      if (a && x > 0 && y > 0 && x < w - 1 && y < h - 1) {
        const holes = bg[i - 1] + bg[i + 1] + bg[i - w] + bg[i + w];
        if (holes) a = holes >= 2 ? 0.5 : 0.75;
      }
      rgba[i * 4 + 3] = Math.round(255 * Math.max(a, core) * broad);
    }
  }
}

/** Dims a burning-debris card into a dead fire: flames become charcoal with a few dull embers. */
function recolorEmbers(rgba, w, h, seed) {
  const c = [0, 0, 0];
  for (let i = 0; i < w * h; i++) {
    const [hh, s, v] = rgbToHsv(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    c[0] = rgba[i * 4]; c[1] = rgba[i * 4 + 1]; c[2] = rgba[i * 4 + 2];
    if (hh <= 55 && s > 0.42 && v > 0.45) {
      const x = i % w, y = (i - x) / w;
      const ember = hash2(x >> 1, y >> 1, seed) < 0.05 && v > 0.7;
      if (ember) hsvToRgb(12, 0.75, 0.55, c);
      else hsvToRgb(20, s * 0.35, 0.16 + v * 0.18, c);
    } else {
      hsvToRgb(hh, s * 0.6, v * 0.82, c);
    }
    rgba[i * 4] = c[0]; rgba[i * 4 + 1] = c[1]; rgba[i * 4 + 2] = c[2];
  }
}

// --- Procedural sprites: painted on a small grid of art pixels, then scaled up ART x. ---

const OUTLINE = [44, 33, 28];

/** A tiny art-pixel canvas with helpers. */
function artCanvas(aw, ah) {
  const px = new Float32Array(aw * ah * 4);
  return {
    aw, ah, px,
    set(x, y, c, a = 1) {
      x = Math.round(x); y = Math.round(y);
      if (x < 0 || y < 0 || x >= aw || y >= ah) return;
      const i = (y * aw + x) * 4;
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = a;
    },
    alpha(x, y) { return x < 0 || y < 0 || x >= aw || y >= ah ? 0 : px[(y * aw + x) * 4 + 3]; },
    /** Darkens the outer silhouette pixels into a 1 art-pixel outline (like the hand-drawn props). */
    outline(color = OUTLINE) {
      const edge = [];
      for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) {
        if (!this.alpha(x, y)) continue;
        if (!this.alpha(x - 1, y) || !this.alpha(x + 1, y) || !this.alpha(x, y - 1) || !this.alpha(x, y + 1)) edge.push([x, y]);
      }
      for (const [x, y] of edge) {
        const i = (y * aw + x) * 4;
        px[i] = lerp(px[i], color[0], 0.75); px[i + 1] = lerp(px[i + 1], color[1], 0.75); px[i + 2] = lerp(px[i + 2], color[2], 0.75);
      }
    },
    /** Scales up ART x (nearest) into an RGBA byte buffer. */
    toSprite() {
      const w = aw * ART, h = ah * ART;
      const rgba = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const s = ((Math.floor(y / ART)) * aw + Math.floor(x / ART)) * 4, d = (y * w + x) * 4;
        rgba[d] = px[s]; rgba[d + 1] = px[s + 1]; rgba[d + 2] = px[s + 2]; rgba[d + 3] = Math.round(px[s + 3] * 255);
      }
      return { rgba, w, h };
    },
  };
}

const scaleC = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

/** A ridge tent seen from the south: front triangle with a dark doorway, two roof slopes behind. */
function procTent(rng, { hw, fh, depth, cloth, torn = false, lean = 0 }) {
  const aw = hw * 2 + 5, ah = fh + depth + 3;
  const cv = artCanvas(aw, ah);
  const cx = aw / 2 + lean * 0.5, by = ah - 1.5, ay = by - fh;
  const patch = [cloth[0] * 0.8 + 20, cloth[1] * 0.78 + 10, cloth[2] * 0.7];
  for (let y = 0; y < ah; y++) {
    for (let x = 0; x < aw; x++) {
      const px = x + 0.5, py = y + 0.5;
      const dx = px - cx;
      // Front edge line of each roof slope: y grows from the apex to the base corners.
      const t = Math.abs(dx) / hw;
      if (t > 1) continue;
      const edgeY = ay + t * fh;
      const apexShift = lean * (1 - t); // a leaning (half collapsed) tent
      let col = null;
      if (py >= edgeY - depth + apexShift * 0.3 && py <= edgeY) {
        // Roof slope (left lit by the low southern sun, right in shade), with seams.
        const left = dx < 0;
        col = scaleC(cloth, left ? 0.92 : 0.7);
        if (Math.floor(Math.abs(dx)) % 3 === 2) col = scaleC(col, 0.9);
        if (Math.abs(dx) < 0.8) col = scaleC(cloth, 1.08); // ridge
        if (hash2(Math.floor(px / 3), Math.floor(py / 2), 77 + hw) < 0.12) col = scaleC(patch, left ? 0.95 : 0.74);
      }
      // The front triangle (nearest to the viewer) is drawn over the slopes.
      const frontHalf = ((py - ay) / fh) * hw;
      if (py >= ay && py <= by + 0.5 && Math.abs(dx) <= frontHalf) {
        col = scaleC(cloth, 1.0 - 0.12 * ((py - ay) / fh));
        const door = ((py - (by - fh * 0.62)) / (fh * 0.62)) * hw * 0.42;
        if (py >= by - fh * 0.62 && Math.abs(dx) <= door) col = [38, 30, 28];
      }
      if (col) {
        // Torn tents show a dark hole in one slope.
        if (torn && dx > hw * 0.25 && dx < hw * 0.62 && py > edgeY - depth * 0.7 && py < edgeY - depth * 0.25) col = [46, 38, 34];
        const n = (hash2(x, y, 13 + hw) - 0.5) * 0.08;
        cv.set(x, y, scaleC(col, 1 + n));
      }
    }
  }
  cv.outline();
  // Guy lines to small pegs.
  for (const s of [-1, 1]) {
    const x0 = cx + s * (hw + 1.5), y0 = by;
    cv.set(x0, y0, OUTLINE, 0.9);
  }
  return cv.toSprite();
}

function procPack(rng) {
  const cv = artCanvas(6, 6);
  const colors = [[104, 106, 74], [132, 84, 60], [86, 96, 118], [148, 126, 96]];
  const c = colors[Math.floor(rng() * colors.length)];
  for (let y = 1; y < 6; y++) for (let x = 1; x < 5; x++) {
    if ((y === 1 || y === 5) && (x === 1 || x === 4)) continue;
    cv.set(x, y, scaleC(c, y < 3 ? 1.12 : x === 4 ? 0.76 : 0.92));
  }
  cv.set(2, 3, scaleC(c, 0.62)); cv.set(3, 3, scaleC(c, 0.62)); // flap
  cv.outline();
  return cv.toSprite();
}

function procBedroll(rng) {
  const cv = artCanvas(9, 5);
  const colors = [[120, 92, 70], [96, 100, 84], [140, 120, 98], [110, 70, 64]];
  const c = colors[Math.floor(rng() * colors.length)];
  for (let y = 1; y < 4; y++) for (let x = 1; x < 8; x++) cv.set(x, y, scaleC(c, y === 1 ? 1.15 : y === 3 ? 0.74 : 0.95));
  for (const x of [3, 6]) for (let y = 1; y < 4; y++) cv.set(x, y, [70, 52, 40]); // straps
  cv.outline();
  return cv.toSprite();
}

/** A pilgrim banner: a thin pole with a faded, tattered cloth. */
function procBanner(rng) {
  const cv = artCanvas(7, 17);
  const cloths = [[156, 72, 62], [176, 146, 86], [206, 200, 184], [96, 106, 138]];
  const c = cloths[Math.floor(rng() * cloths.length)];
  for (let y = 1; y < 17; y++) cv.set(1, y, y < 3 ? [92, 70, 52] : [70, 52, 40]);
  for (let x = 0; x < 6; x++) cv.set(x, 2, [80, 60, 46]); // crossbar
  for (let x = 2; x < 6; x++) {
    const len = 6 + Math.floor(rng() * 4);
    for (let y = 3; y < 3 + len; y++) cv.set(x, y, scaleC(c, x === 5 ? 0.74 : y < 5 ? 1.08 : 0.94));
  }
  cv.outline();
  return cv.toSprite();
}

/** A cairn: a small stack of grey stones left by pilgrims. */
function procCairn(rng) {
  const cv = artCanvas(9, 10);
  const stones = [[4.5, 8.2, 3.8, 1.6], [4.3, 6.1, 3.0, 1.3], [4.7, 4.2, 2.2, 1.1], [4.4, 2.6, 1.4, 0.9]];
  for (const [sx, sy, rx, ry] of stones) {
    const g = 120 + rng() * 30;
    for (let y = 0; y < 10; y++) for (let x = 0; x < 9; x++) {
      const d = ((x + 0.5 - sx) / rx) ** 2 + ((y + 0.5 - sy) / ry) ** 2;
      if (d <= 1) cv.set(x, y, scaleC([g, g * 0.98, g * 0.95], y + 0.5 < sy ? 1.15 : 0.82));
    }
  }
  cv.outline();
  return cv.toSprite();
}

function procSprite(kind, seed) {
  const rng = makeRng(seed);
  if (kind === 'tent') return procTent(rng, { hw: 12, fh: 11, depth: 9, cloth: [176, 156, 124] });
  if (kind === 'tentSmall') return procTent(rng, { hw: 8, fh: 8, depth: 7, cloth: [150, 112, 92] });
  if (kind === 'tentTorn') return procTent(rng, { hw: 10, fh: 8, depth: 8, cloth: [128, 132, 120], torn: true, lean: 2 });
  if (kind === 'pack') return procPack(rng);
  if (kind === 'bedroll') return procBedroll(rng);
  if (kind === 'banner') return procBanner(rng);
  return procCairn(rng);
}

/** Loads a prop's base RGBA (masked or cut out) at its natural size. */
async function loadPropBase(name, def, variant) {
  if (def.proc) return procSprite(def.proc, SEED + name.length * 31 + variant * 977);
  let buf;
  if (def.card) {
    buf = await sharp(CARD(def.card)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  } else {
    const [left, top, width, height] = def.crop;
    buf = await sharp(RAW('wasteland-map.png')).extract({ left, top, width, height }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  }
  const rgba = new Uint8ClampedArray(buf.data);
  const { width: w, height: h } = buf.info;
  if (def.cutCrop) cutOutCrop(rgba, w, h, SEED + name.length * 13);
  else applyMask(rgba, w, h, def.mask, SEED + name.length * 13);
  if (def.recolor === 'embers') recolorEmbers(rgba, w, h, SEED + 5);
  return { rgba, w, h };
}

/** Scaled + mirrored sprite (cached), plus its opaque bounding box ("footprint"). */
async function getSprite(cache, base, key, scale, flip) {
  const ck = `${key}|${scale.toFixed(2)}|${flip ? 1 : 0}`;
  if (cache.has(ck)) return cache.get(ck);
  const w = Math.max(4, Math.round(base.w * scale)), h = Math.max(4, Math.round(base.h * scale));
  let img = sharp(Buffer.from(base.rgba.buffer), { raw: { width: base.w, height: base.h, channels: 4 } });
  if (w !== base.w || h !== base.h) img = img.resize(w, h, { kernel: 'lanczos3' });
  if (flip) img = img.flop();
  const data = new Uint8ClampedArray(await img.raw().toBuffer());
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 150) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  const sprite = { data, w, h, foot: x1 >= 0 ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : { x: 0, y: 0, w, h } };
  cache.set(ck, sprite);
  return sprite;
}

// ---------------------------------------------------------------------------
// Canvas (float RGB, so blending stays smooth until the final write)

function makeCanvas() {
  return new Float32Array(W * H * 3);
}

function blendPixel(cv, x, y, c, a) {
  const i = (y * W + x) * 3;
  cv[i] += (c[0] - cv[i]) * a;
  cv[i + 1] += (c[1] - cv[i + 1]) * a;
  cv[i + 2] += (c[2] - cv[i + 2]) * a;
}

function shadePixel(cv, x, y, k) {
  const i = (y * W + x) * 3;
  cv[i] *= k; cv[i + 1] *= k; cv[i + 2] *= k;
}

// ---------------------------------------------------------------------------
// 1. Ground: quilted dirt -> ash, dunes, the road.

/**
 * Dune height field: long, wind-combed ridges running roughly east-west with an asymmetric
 * profile (gentle rise, sharp crest), patchy across the plain and taller in the side belts.
 */
function duneHeight(x, y) {
  const warp = (fbm(x / 260, y / 220, SEED + 21, 3) - 0.5) * 110 + (fbm(x / 70, y / 70, SEED + 22, 2) - 0.5) * 26;
  const phase = (y + warp + x * 0.12) / (96 * (0.75 + 0.5 * fbm(x / 400, y / 300, SEED + 24, 2)));
  const p = phase - Math.floor(phase);
  const profile = p < 0.64 ? (p / 0.64) ** 1.2 : ((1 - p) / 0.36) ** 1.1;
  return profile * duneField(x, y) * 9;
}

/** Where the dunes are (0..1): patchy on the plain, everywhere and taller in the side belts. */
function duneField(x, y) {
  const field = smoothstep(0.44, 0.64, fbm(x / 300, y / 190, SEED + 23, 3));
  const depth = Math.max(beltLeft(y) - x, x - beltRight(y));
  const belt = smoothstep(-40, 120, depth);
  return field * 0.85 + belt * 1.2;
}

function paintGround(cv, samplers) {
  const { dirt, asphalt } = samplers;
  const c = [0, 0, 0];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const A = ashAt(x, y);
      const rag = (valueNoise(x / 4.5, y / 4.5, SEED + 3) - 0.5) * 0.05;
      const d = A + rag;
      const e = 0.012;
      dirt(x, y, c);
      const base = [c[0], c[1], c[2]];
      // Layered shifts of the same quilted dirt: brown -> grey-brown -> pale grey ash.
      const layers = [
        { a: smoothstep(0.28 - e, 0.28 + e, d), shift: ASH, k: 0.7, rim: 0.18 },
        { a: smoothstep(0.52 - e, 0.52 + e, d), shift: ASH_PLAIN, k: 1, rim: 0.12 },
        {
          a: smoothstep(0.8 - e, 0.8 + e, d) * smoothstep(0.5, 0.56, fbm(x / 90, y / 60, SEED + 6, 3) + rag),
          shift: PALE_ASH, k: 1, rim: 0.1,
        },
      ];
      let r = base[0], g = base[1], b = base[2];
      for (const L of layers) {
        if (L.a <= 0.001) continue;
        c[0] = base[0]; c[1] = base[1]; c[2] = base[2];
        shiftColor(c, L.k, L.shift);
        const rim = 1 - L.rim * 4 * L.a * (1 - L.a);
        r = lerp(r, c[0], L.a) * rim; g = lerp(g, c[1], L.a) * rim; b = lerp(b, c[2], L.a) * rim;
      }
      // Wind-blown ash is smooth: pull the quilted texture towards a flat, softly varying ash
      // tone (more so on the dunes), which removes the salt-and-pepper speckle of the pebbles.
      const flat = smoothstep(0.45, 0.85, A) * (0.42 + 0.3 * duneField(x, y));
      if (flat > 0) {
        const tone = 0.9 + 0.2 * fbm(x / 170, y / 150, SEED + 7, 3);
        r = lerp(r, 150 * tone, flat); g = lerp(g, 146 * tone, flat); b = lerp(b, 140 * tone, flat);
      }
      // Old asphalt patches (a car park, a slip road) near the south, like the wasteland.
      const pa = smoothstep(0.64, 0.68, (1 - A) + (fbm(x / 70, y / 70, SEED + 5, 3) - 0.5) * 0.9) * smoothstep(1120, 1260, y) *
        smoothstep(roadHalfWidth(y) + 30, roadHalfWidth(y) + 70, Math.abs(x - roadX(y)));
      if (pa > 0.001) {
        asphalt(x, y, c);
        shiftColor(c, clamp(A, 0, 1) * 0.6, ASH);
        const rim = 1 - 0.22 * 4 * pa * (1 - pa);
        r = lerp(r, c[0], pa) * rim; g = lerp(g, c[1], pa) * rim; b = lerp(b, c[2], pa) * rim;
      }
      const i = (y * W + x) * 3;
      cv[i] = r; cv[i + 1] = g; cv[i + 2] = b;
    }
  }
}

/**
 * Dune shading: the low dusk sun is in the south, so slopes facing south are lit warm and
 * slopes facing north fall into shade. Posterised into 5 bands with an ordered dither on art
 * pixels, so the dunes read as painted bands rather than an airbrushed gradient.
 */
function shadeDunes(cv) {
  const cw = Math.ceil(W / ART), ch = Math.ceil(H / ART);
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      const x = cx * ART + 1.5, y = cy * ART + 1.5;
      const A = clamp(ashAt(x, y), 0, 1);
      const slope = (duneHeight(x, y + 2) - duneHeight(x, y - 2)) / 4; // dh/dy
      const sx = (duneHeight(x + 2, y) - duneHeight(x - 2, y)) / 4;
      // Rising towards the south (slope > 0) faces the sun.
      const s = clamp(0.5 + slope * 1.2 - sx * 0.25, 0, 1);
      const q = posterize(s, 5, cx, cy, 0.45);
      const k = 1 + (q - 2) * 0.07 * (0.35 + 0.65 * smoothstep(0.3, 0.8, A));
      // Sunlit faces are a touch warmer in the dusk light, shaded ones a touch cooler.
      const warm = (q - 2) * 0.02;
      for (let yy = cy * ART; yy < Math.min(H, cy * ART + ART); yy++) {
        for (let xx = cx * ART; xx < Math.min(W, cx * ART + ART); xx++) {
          const i = (yy * W + xx) * 3;
          cv[i] *= k * (1 + warm); cv[i + 1] *= k; cv[i + 2] *= k * (1 - warm);
        }
      }
    }
  }
}

/** The road: flagstones (north), the broken highway (middle), cracked asphalt (south). */
function paintRoad(cv, samplers) {
  const { asphalt, stone } = samplers;
  const c = [0, 0, 0], s = [0, 0, 0];
  const LANE = [206, 196, 168];
  for (let y = 600; y < H; y++) {
    const hw = roadHalfWidth(y);
    const rx = roadX(y);
    for (let x = Math.max(0, Math.floor(rx - hw - 40)); x < Math.min(W, rx + hw + 40); x++) {
      const dist = roadDistance(x, y);
      const n1 = valueNoise(x / 6, y / 6, SEED + 9), n2 = valueNoise(x / 28, y / 28, SEED + 10);
      const wob = (n1 - 0.5) * 8 + (n2 - 0.5) * 14;
      // Section weights, blended with noise so the changes are ragged.
      const yn = y + (valueNoise(x / 18, y / 18, SEED + 12) - 0.5) * 56;
      const wStone = 1 - smoothstep(STONE_END - 20, STONE_END + 20, yn);
      const wSouth = smoothstep(HIGHWAY_END - 30, HIGHWAY_END + 30, yn);
      let a = smoothstep(hw + 1.6, hw - 1.6, dist + wob * (wStone > 0.5 ? 0.45 : 1));
      if (a <= 0) continue;
      // Asphalt is broken up: chunks missing (ash shows through), drifts of ash across it.
      const holes = fbm(x / 26, y / 26, SEED + 14, 3);
      const drift = smoothstep(0.6, 0.74, fbm(x / 120, y / 34, SEED + 15, 3));
      let asphaltA = 1 - smoothstep(0.64, 0.68, holes) - drift * 0.7;
      asphaltA *= 1 - 0.55 * wSouth * smoothstep(0.5, 0.62, fbm(x / 16, y / 16, SEED + 16, 2)); // the arrival road frays
      asphaltA = clamp(asphaltA, 0, 1);
      asphalt(x, y, c);
      shiftColor(c, 0.35 * (1 - wSouth), ASH);
      // Faded lane paint on the highway: a dashed centre line and two edge lines.
      const off = x - rx;
      if (wStone < 0.5 && wSouth < 0.5) {
        const dash = ((y + 4) % 50) < 26 && Math.abs(off) < 3;
        const edge = Math.abs(Math.abs(off) - (hw - 11)) < 1.8 && valueNoise(x / 9, y / 9, SEED + 17) > 0.3;
        const worn = valueNoise(x / 5, y / 5, SEED + 18) > 0.3;
        if ((dash || edge) && worn) { c[0] = lerp(c[0], LANE[0], 0.8); c[1] = lerp(c[1], LANE[1], 0.8); c[2] = lerp(c[2], LANE[2], 0.8); }
      }
      // Cracks: thin dark lines where a noise field crosses its mid value.
      const crackN = fbm(x / 34, y / 34, SEED + 19, 3);
      if (Math.abs(crackN - 0.5) < 0.012) { c[0] *= 0.6; c[1] *= 0.6; c[2] *= 0.6; }
      let r = c[0], g = c[1], b = c[2];
      const i = (y * W + x) * 3;
      // Asphalt over the existing ground (so holes show the ash underneath).
      r = lerp(cv[i], r, asphaltA); g = lerp(cv[i + 1], g, asphaltA); b = lerp(cv[i + 2], b, asphaltA);
      if (wStone > 0) {
        stone(x, y, s);
        // Ash settles in the joints and over worn stones.
        const dust = smoothstep(0.52, 0.66, fbm(x / 22, y / 22, SEED + 20, 3)) * 0.65;
        s[0] = lerp(s[0], cv[i], dust); s[1] = lerp(s[1], cv[i + 1], dust); s[2] = lerp(s[2], cv[i + 2], dust);
        r = lerp(r, s[0], wStone); g = lerp(g, s[1], wStone); b = lerp(b, s[2], wStone);
      }
      const rim = 1 - 0.24 * 4 * a * (1 - a);
      cv[i] = lerp(cv[i], r, a) * rim; cv[i + 1] = lerp(cv[i + 1], g, a) * rim; cv[i + 2] = lerp(cv[i + 2], b, a) * rim;
    }
  }
}

function poolMask(pool, x, y) {
  const nx = (x - pool.cx) / pool.rx, ny = (y - pool.cy) / pool.ry;
  const r = (Math.abs(nx) ** pool.p + Math.abs(ny) ** pool.p) ** (1 / pool.p);
  const wob = (fbm(x / 9, y / 9, SEED + 41, 2) - 0.5) * 0.2 + (fbm(x / 26, y / 26, SEED + 42, 2) - 0.5) * 0.3;
  return r + wob;
}

/** From outskirts.mjs: sludge palette (dark -> bright) sampled from the wasteland's own pools. */
function sludgePalette(waste) {
  const r = SOURCES.toxic.search;
  const lum = [];
  for (let y = r.y; y < r.y + r.h; y += 2) {
    for (let x = r.x; x < r.x + r.w; x += 2) {
      const i = (y * waste.w + x) * 3;
      const [h, s, v] = rgbToHsv(waste.data[i], waste.data[i + 1], waste.data[i + 2]);
      if (isSludge(h, s, v)) lum.push([v, waste.data[i], waste.data[i + 1], waste.data[i + 2]]);
    }
  }
  lum.sort((a, b) => a[0] - b[0]);
  const at = (q) => {
    const a = Math.floor(q * (lum.length - 1)), n = Math.max(1, Math.floor(lum.length * 0.02));
    const sum = [0, 0, 0];
    for (let k = 0; k < n; k++) { const c = lum[Math.min(lum.length - 1, a + k)]; sum[0] += c[1]; sum[1] += c[2]; sum[2] += c[3]; }
    return sum.map((v) => v / n);
  };
  const deep = at(0.04).map((v, i) => v * [0.45, 0.52, 0.5][i]);
  return [deep, at(0.04), at(0.3), at(0.62), at(0.94)];
}

/** From outskirts.mjs: banded toxic liquid, ring bubbles, a wet dark shore. */
function paintPools(cv, palette) {
  const rng = makeRng(SEED + 91);
  for (const pool of POOLS) {
    const x0 = Math.floor(pool.cx - pool.rx - 18), x1 = Math.ceil(pool.cx + pool.rx + 18);
    const y0 = Math.floor(pool.cy - pool.ry - 18), y1 = Math.ceil(pool.cy + pool.ry + 18);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const m = poolMask(pool, x, y);
        if (m >= 1.3) continue;
        if (m >= 1) {
          const k = smoothstep(1.3, 1.0, m);
          const i = (y * W + x) * 3;
          cv[i] *= 1 - 0.42 * k; cv[i + 1] *= 1 - 0.25 * k; cv[i + 2] *= 1 - 0.48 * k;
          continue;
        }
        const swirl = fbm(x / 30, y / 16, SEED + 93, 2);
        const mm = m + (swirl - 0.5) * 0.3;
        let idx;
        if (m > 0.965) idx = 0;
        else if (m > 0.915) idx = 4;
        else if (mm > 0.74) idx = 2;
        else idx = swirl > 0.6 ? 2 : 3;
        blendPixel(cv, x, y, palette[idx], smoothstep(1.0, 0.985, m));
      }
    }
    const count = Math.round((pool.rx * pool.ry) / 420);
    for (let k = 0; k < count; k++) {
      const bx = pool.cx + (rng() - 0.5) * pool.rx * 1.4, by = pool.cy + (rng() - 0.5) * pool.ry * 1.4;
      if (poolMask(pool, bx, by) > 0.72) continue;
      const rad = 2.5 + rng() * 3;
      for (let y = Math.floor(by - rad - 1); y <= by + rad + 1; y++) {
        for (let x = Math.floor(bx - rad - 1); x <= bx + rad + 1; x++) {
          const d = Math.hypot(x - bx, (y - by) * 1.25);
          if (Math.abs(d - rad) < 0.8) blendPixel(cv, x, y, palette[4], 0.95);
          else if (d < rad - 0.8) blendPixel(cv, x, y, palette[2], 0.8);
        }
      }
    }
  }
}

/** Belts read as impassable: their floor is shaded darker away from the corridor. */
function shadeBelts(cv) {
  for (let y = 0; y < H; y++) {
    const L = beltLeft(y), R = beltRight(y);
    for (let x = 0; x < W; x++) {
      const depth = Math.max(L - x, x - R) + (valueNoise(x / 40, y / 40, SEED + 61) - 0.5) * 40;
      if (depth <= -10) continue;
      const k = (1 - 0.24 * smoothstep(-10, 90, depth)) * (1 - 0.22 * smoothstep(90, 320, depth));
      shadePixel(cv, x, y, k);
    }
  }
}

/** Soft scorch marks on the ground around the dead camp fires. */
function scorch(cv, cx, cy, rx, ry) {
  for (let y = Math.floor(cy - ry); y <= cy + ry; y++) {
    for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const d = Math.hypot((x - cx) / rx, (y - cy) / ry) + (valueNoise(x / 5, y / 5, SEED + 71) - 0.5) * 0.35;
      if (d >= 1) continue;
      shadePixel(cv, x, y, 1 - 0.45 * smoothstep(1, 0.3, d));
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Props

/** Draws a soft contact shadow ellipse. */
function drawShadow(cv, cx, cy, rx, ry, strength) {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    if (y < 0 || y >= H) continue;
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      if (x < 0 || x >= W) continue;
      const r2 = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      if (r2 >= 1) continue;
      shadePixel(cv, x, y, 1 - strength * (1 - r2) ** 1.4);
    }
  }
}

/** Composites one sprite with its bottom-centre at (x, y). Returns the drawn footprint rect. */
function drawSprite(cv, sprite, x, y, inst) {
  const left = Math.round(x - sprite.w / 2), top = Math.round(y - sprite.h);
  const c = [0, 0, 0];
  for (let sy = 0; sy < sprite.h; sy++) {
    const my = top + sy;
    if (my < 0 || my >= H) continue;
    for (let sx = 0; sx < sprite.w; sx++) {
      const mx = left + sx;
      if (mx < 0 || mx >= W) continue;
      const i = (sy * sprite.w + sx) * 4;
      const a = sprite.data[i + 3] / 255;
      if (a <= 0.003) continue;
      c[0] = sprite.data[i] * inst.tint[0]; c[1] = sprite.data[i + 1] * inst.tint[1]; c[2] = sprite.data[i + 2] * inst.tint[2];
      if (inst.shift) shiftColor(c, inst.shiftK, inst.shift);
      blendPixel(cv, mx, my, c, a);
    }
  }
  const f = sprite.foot;
  return { x: left + f.x, y: top + f.y, w: f.w, h: f.h };
}

/** Builds the list of prop instances: belts (procedural) + hand-placed camps and road props. */
function planProps() {
  const rng = makeRng(SEED + 77);
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const props = [];
  const add = (kind, x, y, scale, opts = {}) => {
    const A = clamp(ashAt(x, y), 0, 1);
    const isCrop = Boolean(PROP_DEFS[kind].crop) || kind === 'deadfire';
    const inst = {
      kind, x, y, scale,
      flip: opts.flip ?? rng() < 0.5,
      tint: opts.tint ?? [0.94 + rng() * 0.1, 0.94 + rng() * 0.1, 0.94 + rng() * 0.1],
      shift: opts.shift ?? (kind === 'bones' ? BONE : kind === 'rockpile' ? ROCK_GREY : isCrop ? DUSTED : null),
      shiftK: opts.shiftK ?? (kind === 'bones' || kind === 'rockpile' ? 1 : isCrop ? 0.25 + 0.75 * A : 0),
      solid: opts.solid ?? PROP_DEFS[kind].solid,
      note: opts.note ?? kind,
      belt: opts.belt ?? false,
      id: opts.id ?? null,
      camp: opts.camp ?? null,
      variant: opts.variant ?? 0,
    };
    props.push(inst);
    return inst;
  };

  // Gameplay spots the belt props must keep clear of.
  const keepOut = [
    { x: WATER_1.x, y: WATER_1.y, r: 50 }, { x: RATION_1.x, y: RATION_1.y, r: 50 },
    { x: CRAWLERS[0].x, y: CRAWLERS[0].y, r: 60 },
    ...POOLS.map((pl) => ({ x: pl.cx, y: pl.cy, r: Math.max(pl.rx, pl.ry) + 16 })),
  ];
  const blockedSpot = (x, y, rad) => keepOut.some((k) => Math.hypot(x - k.x, y - k.y) < k.r + rad);

  // Belts: rows of rubble, rocks, ruins and the odd dead tree on and behind the corridor edges.
  const beltKinds = ['rubbleL', 'rubbleE', 'deadC', 'rubbleL', 'rubbleE', 'deadS', 'rubbleL', 'rubbleE', 'deadE', 'rubbleL', 'carDark', 'rubbleE', 'deadA', 'deadB', 'rubbleL', 'deadcard'];
  for (const side of ['L', 'R']) {
    for (let y = 620; y < H + 60; y += 34 + rng() * 22) {
      const edge = side === 'L' ? beltLeft(y) : beltRight(y);
      const maxDepth = side === 'L' ? edge + 60 : W - edge + 60;
      for (let depth = -8 + rng() * 14, row = 0; depth < maxDepth; depth += 48 + rng() * 40, row++) {
        const jy = y + (rng() - 0.5) * 24;
        const x = side === 'L' ? edge - depth + (rng() - 0.5) * 18 : edge + depth + (rng() - 0.5) * 18;
        if (x < -40 || x > W + 40) continue;
        if (jy < cloudBase(x) + 40) continue; // swallowed by the cloud anyway
        const kind = pick(beltKinds);
        const scale = (kind === 'carDark' ? 0.5 : kind === 'rockpile' ? 0.38 : kind.startsWith('dead') ? 0.44 : 0.56) + rng() * 0.26;
        if (row < 2 && blockedSpot(x, jy, 50 * scale)) continue;
        if (row >= 2 && rng() < 0.72) continue; // deep belt: let the dark dunes show
        add(kind, x, jy + 46 * scale, scale, {
          belt: true,
          shiftK: kind.startsWith('rubble') ? 0.7 : kind.startsWith('dead') ? 0.85 : undefined,
          shift: kind.startsWith('rubble') ? ROCK_GREY : kind.startsWith('dead') ? DEAD_WOOD : undefined,
          note: `${side === 'L' ? 'west' : 'east'} belt ${kind}`,
        });
      }
    }
  }

  // The broken highway: wrecks on the shoulders, concrete barriers, the old checkpoint.
  add('carDark', 868, 1206, 0.62, { flip: true, note: 'wreck on the highway shoulder' });
  add('carBrown', 616, 1112, 0.6, { note: 'wreck on the highway shoulder' });
  add('wall1', 862, 1044, 0.46, { flip: false, note: 'highway barrier' });
  add('wall1', 628, 960, 0.42, { flip: true, note: 'highway barrier' });
  add('barricade', 626, 1312, 0.5, { note: 'old checkpoint barricade' });
  add('barricade', 822, 1330, 0.46, { note: 'old checkpoint barricade' });
  add('van', 876, 1452, 0.56, { note: 'abandoned van' });

  // Pilgrim markers along the flagstone way: banners and cairns.
  for (const [x, y, k] of [[650, 892, 'banner'], [800, 880, 'banner'], [656, 712, 'cairn'], [794, 726, 'cairn'], [640, 800, 'banner'], [808, 806, 'banner']]) {
    add(k, x, y, 1, { flip: x > 724, note: `pilgrim ${k}`, variant: x });
  }

  // Camp A (the largest): two tents, a dead fire, packs, crates, bones, banners.
  const A = CAMP_A;
  add('tent', A.x - 26, A.y - 8, 1, { flip: false, camp: 'A', note: 'pilgrim tent' });
  add('tentTorn', A.x + 74, A.y - 42, 1, { flip: true, camp: 'A', note: 'collapsed pilgrim tent' });
  add('deadfire', A.x + 30, A.y + 40, 0.34, { camp: 'A', note: 'burnt-out camp fire' });
  add('crates', A.x - 100, A.y + 26, 0.5, { camp: 'A', note: 'pilgrim crates' });
  add('bedroll', A.x - 20, A.y + 46, 1, { camp: 'A', note: 'bedroll', variant: 1 });
  add('pack', A.x + 68, A.y + 22, 1, { camp: 'A', note: 'abandoned pack', variant: 2 });
  add('pack', A.x - 58, A.y + 60, 1, { camp: 'A', note: 'abandoned pack', variant: 3 });
  add('bones', A.x + 104, A.y + 50, 0.3, { camp: 'A', note: 'bleached bones' });
  add('banner', A.x + 124, A.y - 20, 1, { camp: 'A', note: 'camp banner', variant: 4 });
  add('barrels', A.x - 92, A.y - 34, 0.52, { camp: 'A', note: 'water barrels' });

  // Camp B: by a wrecked bus-van on the east side.
  const B = CAMP_B;
  add('vanGrey', B.x + 60, B.y - 14, 0.5, { flip: true, camp: 'B', note: 'pilgrim van wreck' });
  add('tentSmall', B.x - 40, B.y - 20, 1, { flip: false, camp: 'B', note: 'pilgrim tent' });
  add('deadfire', B.x - 2, B.y + 34, 0.3, { camp: 'B', note: 'burnt-out camp fire' });
  add('pack', B.x - 64, B.y + 30, 1, { camp: 'B', note: 'abandoned pack', variant: 5 });
  add('bedroll', B.x + 30, B.y + 62, 1, { camp: 'B', note: 'bedroll', variant: 6 });
  add('bones', B.x + 96, B.y + 58, 0.28, { camp: 'B', note: 'bleached bones' });
  add('crates', B.x + 124, B.y + 30, 0.44, { camp: 'B', note: 'pilgrim crates' });

  // Camp C: a small one beside the arrival road.
  const C = CAMP_C;
  add('carRed', C.x - 50, C.y + 4, 0.54, { camp: 'C', note: 'pilgrim car wreck' });
  add('tentSmall', C.x + 52, C.y - 18, 1, { flip: true, camp: 'C', note: 'pilgrim tent', variant: 7 });
  add('deadfire', C.x + 36, C.y + 34, 0.28, { camp: 'C', note: 'burnt-out camp fire' });
  add('pack', C.x - 6, C.y + 50, 1, { camp: 'C', note: 'abandoned pack', variant: 8 });
  add('bones', C.x - 80, C.y + 52, 0.26, { camp: 'C', note: 'bleached bones' });

  // Scattered on the plain.
  add('bones', 940, 1110, 0.26, { note: 'bleached bones' });
  add('rockpile', 452, 1366, 0.4, { note: 'rocks' });
  add('deadS', 1006, 1300, 0.7, { note: 'dead sapling' });
  add('deadS', 432, 860, 0.66, { note: 'dead sapling' });
  add('cairn', 1046, 760, 1, { note: 'pilgrim cairn', variant: 9 });
  add('rockpile', 452, 732, 0.42, { note: 'rocks' });
  add('bones', 560, 760, 0.24, { note: 'bleached bones' });
  // Pilgrim debris on the last stretch before the arch.
  add('tentTorn', 930, 690, 1, { flip: false, note: 'collapsed pilgrim tent', variant: 10 });
  add('pack', 966, 716, 1, { note: 'abandoned pack', variant: 11 });
  add('cairn', 520, 672, 1, { note: 'pilgrim cairn', variant: 12 });
  add('cairn', 586, 700, 1, { note: 'pilgrim cairn', variant: 13 });
  add('bedroll', 452, 790, 1, { note: 'bedroll', variant: 14 });
  add('banner', 878, 760, 1, { note: 'fallen pilgrim banner', variant: 15 });
  add('bones', 1000, 820, 0.22, { note: 'bleached bones' });
  add('carBrown', 404, 690, 0.48, { flip: true, note: 'pilgrim car wreck' });
  return props;
}

async function paintProps(cv, props) {
  const bases = {};
  const cache = new Map();
  const order = [...props].sort((a, b) => a.y - b.y);
  for (const inst of order) {
    const def = PROP_DEFS[inst.kind];
    const bkey = def.proc ? `${inst.kind}#${inst.variant}` : inst.kind;
    if (!bases[bkey]) bases[bkey] = await loadPropBase(inst.kind, def, inst.variant);
    const sprite = await getSprite(cache, bases[bkey], bkey, Math.round(inst.scale * 20) / 20, inst.flip);
    const left = Math.round(inst.x - sprite.w / 2), top = Math.round(inst.y - sprite.h);
    if (def.shadow > 0) {
      const f = sprite.foot;
      // Long-ish dusk shadows fall north, away from the low southern sun.
      drawShadow(cv, left + f.x + f.w / 2, top + f.y + f.h - 6, f.w * 0.52, Math.max(6, f.h * 0.2), 0.3 * def.shadow);
    }
    if (inst.kind === 'deadfire') scorch(cv, inst.x, inst.y - sprite.h * 0.35, sprite.w * 0.62, sprite.h * 0.42);
    inst.foot = drawSprite(cv, sprite, inst.x, inst.y, inst);
  }
}

// ---------------------------------------------------------------------------
// 3. The arch (portal card): cut out, opening recoloured to white light, scaled 2x.

async function buildArch() {
  const { data, info } = await sharp(CARD('portal')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, N = w * h;
  const rgba = new Uint8ClampedArray(data);
  const hsvAt = (i) => rgbToHsv(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
  const inOpening = (x, y) => x >= CARD_OPENING.x0 && x <= CARD_OPENING.x1 && y >= CARD_OPENING.y0 && y <= CARD_OPENING.y1;
  // Night sky of the card: saturated dark blues (and its stars, removed as small specks below).
  const isSky = (i, strict) => {
    if (rgba[i * 4 + 3] < 128) return true;
    const [hh, s, v] = hsvAt(i);
    return (hh >= 188 && hh <= 256 && s > (strict ? 0.34 : 0.2) && v < 0.8) || v < 0.13;
  };
  const bg = new Uint8Array(N);
  const stack = [];
  for (let i = 0; i < N; i++) {
    const x = i % w, y = (i - x) / w;
    if ((x === 0 || y === 0 || x === w - 1 || y === h - 1) && isSky(i, false)) { bg[i] = 1; stack.push(i); }
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w, y = (i - x) / w;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || inOpening(nx, ny)) continue;
      const n = ny * w + nx;
      if (!bg[n] && isSky(n, false)) { bg[n] = 1; stack.push(n); }
    }
  }
  // Remaining sky specks between the mossy stones (not connected to the border).
  for (let i = 0; i < N; i++) {
    const x = i % w, y = (i - x) / w;
    if (!bg[i] && !inOpening(x, y) && isSky(i, true)) bg[i] = 1;
  }
  // Drop small islands (the card's stars).
  const comp = new Int32Array(N).fill(-1);
  const sizes = [];
  for (let i = 0; i < N; i++) {
    if (bg[i] || comp[i] >= 0) continue;
    const id = sizes.length;
    let size = 0;
    const st = [i];
    comp[i] = id;
    while (st.length) {
      const j = st.pop();
      size++;
      const x = j % w, y = (j - x) / w;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = ny * w + nx;
        if (!bg[n] && comp[n] < 0) { comp[n] = id; st.push(n); }
      }
    }
    sizes.push(size);
  }
  const keep = (i) => !bg[i] && sizes[comp[i]] >= 90;

  // Pixel kinds: 0 gone, 1 opening, 2 halo (blue glow), 3 moss, 4 stone.
  const kind = new Uint8Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!keep(i)) continue;
    const [hh, s, v] = hsvAt(i);
    if (inOpening(x, y)) kind[i] = 1;
    else if (hh >= 70 && hh <= 165 && s > 0.22) kind[i] = 3;
    else if ((hh >= 185 && hh <= 260 && s > 0.12 && v > 0.55) || (s < 0.16 && v > 0.82)) kind[i] = 2;
    else kind[i] = 4;
  }
  const c = [0, 0, 0];
  const GLOW = [[160, 170, 220], [184, 193, 234], [208, 215, 246], [232, 236, 252], [255, 255, 255]];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!keep(i)) { rgba[i * 4 + 3] = 0; continue; }
      const [hh, s, v] = hsvAt(i);
      c[0] = rgba[i * 4]; c[1] = rgba[i * 4 + 1]; c[2] = rgba[i * 4 + 2];
      if (inOpening(x, y)) {
        // The opening: pure white light, a little cooler towards the rim and the top.
        // Light pours from low in the doorway; faint cloud swirls drift inside.
        const lum = (0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]) / 255;
        const dx = (x - 71) / 34, dy = (y - 126) / 84;
        const core = 1 - Math.min(1, Math.hypot(dx, dy));
        const swirl = (fbm(x / 9, y / 13, SEED + 801, 3) - 0.5) * 0.34;
        const t = clamp(0.04 + core * 1.05 + swirl + (lum - 0.5) * 0.2, 0, 1);
        const g = GLOW[posterize(t, 5, x, y, 0.5)];
        c[0] = g[0]; c[1] = g[1]; c[2] = g[2];
      } else if (hh >= 70 && hh <= 165 && s > 0.22) {
        // Moss -> dead, ash-dusted lichen.
        hsvToRgb(38, s * 0.22, v * 0.78, c);
      } else if (hh >= 185 && hh <= 260 && s > 0.12 && v > 0.55) {
        // The card's blue halo -> pearly cloud light.
        const k = clamp((v - 0.55) / 0.4, 0, 1);
        c[0] = lerp(170, 238, k); c[1] = lerp(176, 240, k); c[2] = lerp(200, 250, k);
      }
      rgba[i * 4] = c[0]; rgba[i * 4 + 1] = c[1]; rgba[i * 4 + 2] = c[2];
      rgba[i * 4 + 3] = 255;
    }
  }
  // A dark outline around the stone, so the arch separates from the white cloud behind it.
  const isStoneAt = (x, y) => x >= 0 && y >= 50 && x < w && y < h && kind[y * w + x] >= 3;
  const outline = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (rgba[(y * w + x) * 4 + 3]) continue;
    if (isStoneAt(x - 1, y) || isStoneAt(x + 1, y) || isStoneAt(x, y - 1) || isStoneAt(x, y + 1)) outline.push(y * w + x);
  }
  for (let i = 0; i < N; i++) {
    const x = i % w, y = (i - x) / w;
    if (kind[i] !== 4) continue;
    rgba[i * 4] *= 0.92; rgba[i * 4 + 1] *= 0.93; rgba[i * 4 + 2] *= 0.97;
  }
  for (const i of outline) { rgba[i * 4] = 40; rgba[i * 4 + 1] = 42; rgba[i * 4 + 2] = 58; rgba[i * 4 + 3] = 255; }
  // Scale 2x with nearest neighbour: keeps the card's crisp pixel edges.
  const sw = w * ARCH_SCALE, shh = h * ARCH_SCALE;
  const out = new Uint8ClampedArray(sw * shh * 4);
  for (let y = 0; y < shh; y++) for (let x = 0; x < sw; x++) {
    const s = (Math.floor(y / ARCH_SCALE) * w + Math.floor(x / ARCH_SCALE)) * 4, d = (y * sw + x) * 4;
    out[d] = rgba[s]; out[d + 1] = rgba[s + 1]; out[d + 2] = rgba[s + 2]; out[d + 3] = rgba[s + 3];
  }
  const left = Math.round(ARCH.x - sw / 2);
  const top = T - CARD_THRESHOLD_Y * ARCH_SCALE;
  let x0 = sw, x1 = -1, y0 = shh, y1 = -1;
  for (let y = 0; y < shh; y++) for (let x = 0; x < sw; x++) {
    if (out[(y * sw + x) * 4 + 3] > 128) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  }
  return {
    data: out, w: sw, h: shh, left, top,
    foot: { x: left + x0, y: top + y0, w: x1 - x0 + 1, h: y1 - y0 + 1 },
    platformBottom: top + CARD_PLATFORM_BOTTOM * ARCH_SCALE,
    alphaAt(mx, my) {
      const x = mx - left, y = my - top;
      if (x < 0 || y < 0 || x >= sw || y >= shh) return 0;
      return out[(y * sw + x) * 4 + 3] / 255;
    },
  };
}

function drawArch(cv, arch) {
  for (let y = 0; y < arch.h; y++) {
    const my = arch.top + y;
    if (my < 0 || my >= H) continue;
    for (let x = 0; x < arch.w; x++) {
      const mx = arch.left + x;
      const i = (y * arch.w + x) * 4;
      const a = arch.data[i + 3] / 255;
      if (a > 0) blendPixel(cv, mx, my, [arch.data[i], arch.data[i + 1], arch.data[i + 2]], a);
    }
  }
}

// ---------------------------------------------------------------------------
// 4. The cloud wall: shaded lobes, posterised with a dither, on art-pixel blocks.

// Cloud ramp, deep shadow -> pearl highlight. Two hue families mixed by height.
const CLOUD_PEARL = [[96, 98, 132], [122, 122, 156], [150, 148, 180], [178, 176, 204], [204, 202, 224], [226, 224, 240], [242, 241, 250], [253, 252, 255]];
const CLOUD_COOL = [[70, 80, 104], [88, 100, 124], [110, 122, 146], [136, 148, 170], [164, 174, 194], [192, 200, 218], [220, 226, 238], [240, 244, 250]];
const RIM_PINK = [240, 180, 196];
const RIM_GOLD = [250, 226, 182];
const MIST = [226, 230, 242];

/**
 * Lobe list, back (top of the wall) to front (its foot), in five tiers of billows. Each billow
 * has smaller "satellite" puffs tucked behind its upper rim, so only their bumps show: that is
 * what gives the cauliflower silhouettes instead of a pile of separate balls.
 */
function planLobes() {
  const rng = makeRng(SEED + 301);
  const tiers = [
    { f: 0.04, r: [200, 260], gap: [0.9, 1.15] },
    { f: 0.34, r: [130, 180], gap: [0.95, 1.3] },
    { f: 0.6, r: [84, 124], gap: [0.95, 1.4] },
    { f: 0.82, r: [46, 92], gap: [0.8, 1.6] },
    { f: 0.93, r: [34, 50], gap: [1.1, 2.0], sparse: 0.45 },
  ];
  const lobes = [];
  tiers.forEach((tier, ti) => {
    const parents = [];
    let x = -tier.r[1] * 0.4 - rng() * 60;
    while (x < W + tier.r[1] * 0.4) {
      const r = lerp(tier.r[0], tier.r[1], rng());
      const base = cloudBase(x);
      const cy = lerp(-30, base - r * 0.86, tier.f) + (rng() - 0.5) * r * (ti >= 3 ? 0.5 : 0.32);
      if (!tier.sparse || rng() < tier.sparse) parents.push({ x, y: cy, r });
      x += r * lerp(tier.gap[0], tier.gap[1], rng());
    }
    const sats = [];
    if (ti > 0) {
      for (const p of parents) {
        const n = 3 + Math.floor(rng() * 3);
        for (let k = 0; k < n; k++) {
          const ang = (-172 + (k + 0.2 + rng() * 0.6) * (164 / n)) * Math.PI / 180;
          const sr = p.r * (0.26 + rng() * 0.16);
          const dist = p.r * (0.8 + rng() * 0.1);
          const sx = p.x + Math.cos(ang) * dist, sy = p.y + Math.sin(ang) * dist * 0.94;
          sats.push({ x: sx, y: sy, r: sr, order: 1 });
          if (rng() < 0.55) {
            const a2 = ang + (rng() - 0.5) * 0.9, tr = sr * (0.36 + rng() * 0.2);
            sats.push({ x: sx + Math.cos(a2) * sr * 0.82, y: sy + Math.sin(a2) * sr * 0.8, r: tr, order: 0 });
          }
        }
      }
    }
    sats.sort((a, b) => a.order - b.order);
    for (const s of sats) lobes.push({ ...s, tier: ti, sat: true, seed: Math.floor(rng() * 1e6) });
    for (const p of parents) lobes.push({ ...p, tier: ti, sat: false, seed: Math.floor(rng() * 1e6) });
  });
  return lobes;
}

/**
 * Renders the cloud layer on art-pixel cells. Returns { rgb, alpha } at full resolution
 * (alpha 1 inside the cloud) and `baseY[x]`, the lowest painted cloud row of each column.
 *
 * Shading per cell: a flattened sphere normal of the billow it belongs to (light from above,
 * a little west), minus a crease shadow where a billow in front sits just below, plus a bright
 * lip along each billow's top silhouette, a vertical gradient (pearl high up, cool blue-grey
 * at the foot), a glow around the arch, then posterised to 8 tones with an ordered dither.
 */
function paintCloud(lobes) {
  const CH = 760;
  const cw = Math.ceil(W / ART), ch = Math.ceil(CH / ART);
  const idx = new Int32Array(cw * ch).fill(-1);
  const edgeD = new Float32Array(cw * ch);
  lobes.forEach((lb, k) => {
    const r = lb.r * 1.2;
    const c0 = Math.max(0, Math.floor((lb.x - r) / ART)), c1 = Math.min(cw - 1, Math.ceil((lb.x + r) / ART));
    const r0 = Math.max(0, Math.floor((lb.y - r) / ART)), r1 = Math.min(ch - 1, Math.ceil((lb.y + r) / ART));
    for (let cy = r0; cy <= r1; cy++) {
      for (let cx = c0; cx <= c1; cx++) {
        const x = cx * ART + 1.5, y = cy * ART + 1.5;
        const d = Math.hypot(x - lb.x, y - lb.y) / lb.r;
        if (d > 1.25) continue;
        const wob = (valueNoise(x / 8, y / 8, lb.seed) - 0.5) * 0.1 + (fbm(x / 24, y / 24, lb.seed + 1, 2) - 0.5) * 0.16;
        const dw = d + wob;
        if (dw < 1) { idx[cy * cw + cx] = k; edgeD[cy * cw + cx] = dw; }
      }
    }
  });
  const at = (cx, cy) => (cx < 0 || cy < 0 || cx >= cw || cy >= ch ? -2 : idx[cy * cw + cx]);
  const tierOf = (k) => (k < 0 ? -1 : lobes[k].tier);

  // Light from above, a little west and towards the viewer.
  const LX = -0.3, LY = -0.72, LZ = 0.62;
  const archGlow = (x, y) => Math.exp(-(((x - ARCH.x) / 150) ** 2) - (((y - (T - 170)) / 120) ** 2));
  const rgbLo = new Float32Array(cw * ch * 3);
  const aLo = new Uint8Array(cw * ch);
  const AO_RANGE = 14; // cells (42 px)
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      const k = idx[cy * cw + cx];
      if (k < 0) continue;
      const lb = lobes[k];
      const x = cx * ART + 1.5, y = cy * ART + 1.5;
      let nx = (x - lb.x) / lb.r, ny = (y - lb.y) / lb.r;
      const rr = Math.min(1, nx * nx + ny * ny);
      let nz = Math.sqrt(1 - rr) + 0.55; // flattened: billows are soft, not glass balls
      const nl = Math.hypot(nx, ny, nz);
      nx /= nl; ny /= nl; nz /= nl;
      const diff = Math.max(0, nx * LX + ny * LY + nz * LZ);
      const yb = cloudBase(x);
      let L = 0.18 + 0.7 * diff;
      L += 0.18 * (1 - smoothstep(60, yb, y));                // the high wall catches the light
      L -= 0.35 * smoothstep(yb - 250, yb + 6, y);            // cool shadow at the foot
      L += (fbm(x / 30, y / 30, SEED + 310, 3) - 0.5) * 0.1;  // soft internal texture
      // Crease shadow: a billow of a nearer tier (or a nearer parent) sits just below.
      for (let j = 1; j <= AO_RANGE; j++) {
        const kk = at(cx, cy + j);
        if (kk === -2) break;
        if (kk > k && (tierOf(kk) > lb.tier || (!lobes[kk].sat && lb.sat))) {
          L -= 0.3 * ((1 - (j - 1) / AO_RANGE) ** 1.6);
          break;
        }
      }
      // A thin crease line where any nearer billow touches this one sideways.
      if (at(cx - 1, cy) > k || at(cx + 1, cy) > k) L -= 0.07;
      // Bright lip along the top silhouette (sky light grazing the top of each billow).
      const above = at(cx, cy - 1), above2 = at(cx, cy - 2);
      if ((above >= 0 && above < k) || (above2 >= 0 && above2 < k)) L += 0.14 * Math.max(0, -ny + 0.2);
      const glow = archGlow(x, y);
      L += 0.22 * glow;
      L = clamp(L, 0, 1);
      const q = posterize(L, 8, cx, cy, 0.3);
      const coolMix = smoothstep(yb - 320, yb - 60, y) * (1 - glow);
      const cp = CLOUD_PEARL[q], cc = CLOUD_COOL[q];
      let r = lerp(cp[0], cc[0], coolMix), g = lerp(cp[1], cc[1], coolMix), b = lerp(cp[2], cc[2], coolMix);
      // Faint pink / gold rim light on the sun-side (lower right) edges of the high billows.
      const ed = edgeD[cy * cw + cx];
      if (lb.tier <= 3 && !lb.sat) {
        const rim = smoothstep(0.82, 0.98, ed) * smoothstep(0.05, 0.6, ny * 0.7 + nx * 0.7) * (1 - glow) * smoothstep(0.3, 0.55, L);
        if (rim > 0.05) {
          const rc = lb.tier <= 1 ? RIM_PINK : hash2(lb.seed, 3, 9) < 0.5 ? RIM_GOLD : RIM_PINK;
          const t = (posterize(rim, 3, cx, cy, 0.5) / 2) * 0.62;
          r = lerp(r, rc[0], t); g = lerp(g, rc[1], t); b = lerp(b, rc[2], t);
        }
      }
      const o = (cy * cw + cx) * 3;
      rgbLo[o] = r; rgbLo[o + 1] = g; rgbLo[o + 2] = b;
      aLo[cy * cw + cx] = 1;
    }
  }

  // Up-sample to full resolution (nearest: hard art-pixel edges).
  const rgb = new Float32Array(W * H * 3);
  const alpha = new Float32Array(W * H);
  const baseY = new Float32Array(W).fill(0);
  for (let y = 0; y < CH; y++) {
    const cy = Math.floor(y / ART);
    for (let x = 0; x < W; x++) {
      const cx = Math.floor(x / ART), l = cy * cw + cx;
      if (!aLo[l]) continue;
      const o = (y * W + x) * 3;
      rgb[o] = rgbLo[l * 3]; rgb[o + 1] = rgbLo[l * 3 + 1]; rgb[o + 2] = rgbLo[l * 3 + 2];
      alpha[y * W + x] = 1;
      if (y + 1 > baseY[x]) baseY[x] = y + 1;
    }
  }
  return { rgb, alpha, baseY };
}

/** A few billows in front of the arch's shoulders: the cloud wraps around it. */
function planFrontLobes() {
  const rng = makeRng(SEED + 350);
  const out = [];
  for (const side of [-1, 1]) {
    const spec = [[150, 172, 58], [122, 226, 44], [182, 118, 40], [196, 196, 46], [104, 262, 34]];
    for (const [dx, dy, r] of spec) {
      out.push({ x: ARCH.x + side * (dx + (rng() - 0.5) * 16), y: T - dy + (rng() - 0.5) * 12, r: r * (0.9 + rng() * 0.2), tier: 3, sat: false, seed: Math.floor(rng() * 1e6) });
    }
  }
  // Bumps first (behind), the bigger billows last (in front).
  return out.sort((a, b) => a.r - b.r);
}

/** Mist tendrils: meandering fingers that leave the cloud's foot and creep south, thinning out. */
function planTendrils(baseY) {
  const rng = makeRng(SEED + 420);
  const list = [];
  let x = 40 + rng() * 40;
  while (x < W - 30) {
    if (Math.abs(x - ARCH.x) > 175) {
      let px = x, py = baseY[Math.round(x)] - 8;
      let ang = Math.PI / 2 + (rng() - 0.5) * 1.8;
      const len = 50 + rng() * 120, w0 = 26 + rng() * 20;
      const pts = [];
      for (let s = 0; s <= len; s += 5) {
        const t = s / len;
        pts.push({ x: px, y: py, w: w0 * (1 - 0.6 * t) * (0.8 + 0.4 * valueNoise(s / 30, Math.floor(x), 5)), a: 0.8 * (1 - t) ** 1.5 });
        ang = clamp(ang + (rng() - 0.5) * 0.5, 0.2, Math.PI - 0.2);
        px += Math.cos(ang) * 5; py += Math.sin(ang) * 5 * 0.55;
      }
      list.push(pts);
    }
    x += 70 + rng() * 90;
  }
  return list;
}

/**
 * Mist: a dense skirt over the cloud's foot (so the base dissolves), meandering tendrils and low
 * banks lying on the ground, all fading out. Alpha is posterised on art pixels.
 */
function paintMist(cv, baseY) {
  const cw = Math.ceil(W / ART), ch = Math.ceil(H / ART);
  // A smooth foot line under the scalloped billows (max over a window, then a blur), so the
  // skirt is one continuous bank instead of a curtain hanging from every billow.
  const maxed = new Float32Array(W), foot = new Float32Array(W);
  for (let x = 0; x < W; x++) { let m = 0; for (let k = -36; k <= 36; k++) m = Math.max(m, baseY[clamp(x + k, 0, W - 1)]); maxed[x] = m; }
  for (let x = 0; x < W; x++) { let sum = 0; for (let k = -30; k <= 30; k++) sum += maxed[clamp(x + k, 0, W - 1)]; foot[x] = sum / 61; }
  const tend = new Float32Array(cw * ch);
  for (const pts of planTendrils(baseY)) {
    for (const p of pts) {
      const R = p.w * 1.6;
      for (let cy = Math.max(0, Math.floor((p.y - R) / ART)); cy <= Math.min(ch - 1, (p.y + R) / ART); cy++) {
        for (let cx = Math.max(0, Math.floor((p.x - R) / ART)); cx <= Math.min(cw - 1, (p.x + R) / ART); cx++) {
          const d = Math.hypot(cx * ART + 1.5 - p.x, (cy * ART + 1.5 - p.y) * 1.25) / p.w;
          const v = p.a * Math.exp(-d * d * 1.4);
          if (v > tend[cy * cw + cx]) tend[cy * cw + cx] = v;
        }
      }
    }
  }
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      const x = cx * ART + 1.5, y = cy * ART + 1.5;
      const by = foot[Math.min(W - 1, Math.round(x))];
      const dy = y - by;
      if (dy < -70 || dy > 320) continue;
      const wisp = clamp(0.2 + 1.1 * (fbm(x / 22, y / 12, SEED + 405, 3) - 0.25), 0, 1);
      const skirtLen = 8 + 56 * fbm(x / 44, 7.1, SEED + 401, 3) + (valueNoise(x / 7, y / 7, SEED + 406) - 0.5) * 18;
      const skirt = smoothstep(-64, -18, dy) * (1 - smoothstep(-4, skirtLen, dy));
      const bank = smoothstep(0.55, 0.72, fbm(x / 150, y / 30, SEED + 404, 3)) * (1 - smoothstep(6, 170, dy)) * smoothstep(-10, 10, dy);
      const haze = (1 - smoothstep(0, 120, dy)) * smoothstep(-20, 0, dy);
      let a = Math.max(skirt * 0.86 * (0.75 + 0.25 * wisp), tend[cy * cw + cx] * 0.9 * Math.max(wisp, 0.45), bank * 0.42 * wisp, haze * 0.3 * wisp);
      // Keep the steps and the road in front of the arch readable.
      const nearPath = smoothstep(90, 40, Math.abs(x - ARCH.x)) * smoothstep(T - 40, T + 10, y);
      const nearArch = smoothstep(190, 130, Math.abs(x - ARCH.x)) * smoothstep(T - 140, T - 100, y);
      a *= (1 - 0.7 * nearPath) * (1 - 0.6 * nearArch);
      if (a <= 0.02) continue;
      const q = posterize(a, 6, cx, cy, 0.4) / 5;
      if (q <= 0) continue;
      const glow = Math.exp(-(((x - ARCH.x) / 260) ** 2) - (((y - T) / 160) ** 2));
      const col = [lerp(MIST[0], 248, glow), lerp(MIST[1], 247, glow), lerp(MIST[2], 250, glow)];
      for (let yy = cy * ART; yy < Math.min(H, cy * ART + ART); yy++) {
        for (let xx = cx * ART; xx < Math.min(W, cx * ART + ART); xx++) blendPixel(cv, xx, yy, col, q * 0.84);
      }
    }
  }
}

/** Pearly light on the ground in front of the arch: posterised rings, faint rays. */
function paintBloom(cv) {
  const cw = Math.ceil(W / ART), ch = Math.ceil(H / ART);
  for (let cy = Math.floor((T - 80) / ART); cy < Math.ceil((T + 420) / ART); cy++) {
    for (let cx = Math.floor((ARCH.x - 360) / ART); cx < Math.ceil((ARCH.x + 360) / ART); cx++) {
      if (cx < 0 || cx >= cw || cy < 0 || cy >= ch) continue;
      const x = cx * ART + 1.5, y = cy * ART + 1.5;
      const dx = (x - ARCH.x) / 230, dy = (y - (T + 24)) / 130;
      let g = Math.exp(-(dx * dx + dy * dy) * 1.6);
      const ang = Math.atan2(y - (T - 30), x - ARCH.x);
      g *= 0.86 + 0.14 * Math.cos(ang * 15 + fbm(x / 80, y / 80, SEED + 501, 2) * 3);
      g += 0.5 * Math.exp(-(((x - ARCH.x) / 74) ** 2) - (((y - (T + 6)) / 34) ** 2));
      if (y > T) g += 0.3 * Math.exp(-(((x - ARCH.x) / 64) ** 2)) * Math.exp(-(y - T) / 200);
      if (y < T - 4) g *= smoothstep(T - 80, T - 4, y) * 0.5;
      const q = posterize(g * 0.9, 6, cx, cy, 0.4) / 5;
      if (q <= 0) continue;
      for (let yy = cy * ART; yy < Math.min(H, cy * ART + ART); yy++) {
        for (let xx = cx * ART; xx < Math.min(W, cx * ART + ART); xx++) {
          const i = (yy * W + xx) * 3;
          // Screen-like lighten towards a warm pearl white.
          cv[i] += (252 - cv[i]) * q * 0.5;
          cv[i + 1] += (250 - cv[i + 1]) * q * 0.5;
          cv[i + 2] += (246 - cv[i + 2]) * q * 0.5;
        }
      }
    }
  }
}

/**
 * The doorway's aura: posterised rings of white light around the opening, spilling over the
 * cloud and (more faintly) over the arch's own stone.
 */
function paintAura(cv, arch) {
  const ox0 = ARCH.x - 54, ox1 = ARCH.x + 54, oy0 = T - 168, oy1 = T;
  for (let cy = Math.floor((oy0 - 120) / ART); cy < Math.ceil((oy1 + 10) / ART); cy++) {
    for (let cx = Math.floor((ox0 - 140) / ART); cx < Math.ceil((ox1 + 140) / ART); cx++) {
      const x = cx * ART + 1.5, y = cy * ART + 1.5;
      const dx = Math.max(ox0 - x, 0, x - ox1), dy = Math.max(oy0 + 40 - y, 0, y - oy1);
      const d = Math.hypot(dx, dy);
      if (d <= 0) continue;
      let g = Math.exp(-d / 46) * 0.62;
      const onStone = arch.alphaAt(Math.round(x), Math.round(y)) > 0;
      if (onStone) g *= 0.45;
      const q = posterize(g, 5, cx, cy, 0.4) / 4;
      if (q <= 0) continue;
      for (let yy = cy * ART; yy < cy * ART + ART; yy++) {
        for (let xx = cx * ART; xx < cx * ART + ART; xx++) {
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const i = (yy * W + xx) * 3;
          cv[i] += (255 - cv[i]) * q * 0.55; cv[i + 1] += (253 - cv[i + 1]) * q * 0.55; cv[i + 2] += (250 - cv[i + 2]) * q * 0.55;
        }
      }
    }
  }
}

/** Little four-point sparkles in the light around the arch (like the portal card's stars). */
function paintSparkles(cv) {
  const rng = makeRng(SEED + 601);
  for (let k = 0; k < 16; k++) {
    const x = Math.round(ARCH.x + (rng() - 0.5) * 360), y = Math.round(T - 60 - rng() * 230);
    const big = rng() < 0.35;
    const arm = big ? 4 : 2;
    blendPixel(cv, x, y, [255, 255, 255], 1);
    for (let a = 1; a <= arm; a++) {
      const t = 1 - (a - 1) / arm;
      for (const [dx, dy] of [[a, 0], [-a, 0], [0, a], [0, -a]]) {
        if (x + dx >= 0 && x + dx < W && y + dy >= 0 && y + dy < H) blendPixel(cv, x + dx, y + dy, [255, 255, 255], 0.85 * t);
      }
    }
  }
}

/** Composites the cloud over the scene. Over the arch the cloud thins out towards its foot. */
function compositeCloud(cv, cloud, arch) {
  for (let y = 0; y < 760; y++) {
    for (let x = 0; x < W; x++) {
      const a0 = cloud.alpha[y * W + x];
      if (a0 <= 0) continue;
      let a = a0;
      const archA = arch.alphaAt(x, y);
      if (archA > 0) {
        // The arch is half swallowed: solid cloud over its crown, clear over its lower half.
        const n = (fbm(x / 20, y / 20, SEED + 701, 2) - 0.5) * 50;
        const swallow = smoothstep(T - 215, T - 262, y + n) * 0.8;
        const q = Math.floor(swallow * 4 + bayer(x / ART | 0, y / ART | 0) * 0.99) / 4;
        a = lerp(a, a * q, archA);
      }
      if (a <= 0) continue;
      const o = (y * W + x) * 3;
      blendPixel(cv, x, y, [cloud.rgb[o], cloud.rgb[o + 1], cloud.rgb[o + 2]], a);
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Colour grade + vignette

/** Warm dusk light on the south half, cold pearl light near the cloud (ground only). */
function gradeGround(cv) {
  for (let y = 0; y < H; y++) {
    const dusk = smoothstep(720, 1500, y);
    const cold = 1 - smoothstep(560, 960, y);
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      let r = cv[i], g = cv[i + 1], b = cv[i + 2];
      const lum = 0.3 * r + 0.59 * g + 0.11 * b;
      // Dusk: amber tint, slightly darker.
      r = lerp(r, lum, 0.2 * dusk); g = lerp(g, lum, 0.2 * dusk); b = lerp(b, lum, 0.2 * dusk);
      r *= 1 + 0.08 * dusk; g *= 1 - 0.02 * dusk; b *= 1 - 0.13 * dusk;
      const dk = 1 - 0.17 * dusk;
      r *= dk; g *= dk; b *= dk;
      // Cold pearl: desaturate, cool, lift towards the cloud's light.
      const near = cold * (0.75 + 0.25 * Math.exp(-(((x - ARCH.x) / 300) ** 2)));
      r = lerp(r, lum, 0.3 * near); g = lerp(g, lum, 0.3 * near); b = lerp(b, lum, 0.3 * near);
      r = lerp(r * (1 - 0.04 * near), 214, 0.12 * near);
      g = lerp(g, 220, 0.12 * near);
      b = lerp(b * (1 + 0.08 * near), 236, 0.12 * near);
      cv[i] = r; cv[i + 1] = g; cv[i + 2] = b;
    }
  }
}

function vignette(cv) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const vx = Math.abs(x - W / 2) / (W / 2);
      const side = 0.2 * smoothstep(0.6, 1.0, vx) * (0.45 + 0.55 * smoothstep(300, 800, y));
      const bottom = 0.14 * smoothstep(1260, 1500, y) * smoothstep(0.1, 0.9, vx);
      const k = 1 - side - bottom;
      shadePixel(cv, x, y, k);
    }
  }
}

// ---------------------------------------------------------------------------
// 6. Map data

const rectInt = (r) => {
  const x0 = clamp(Math.floor(r.x), 0, W), y0 = clamp(Math.floor(r.y), 0, H);
  const x1 = clamp(Math.ceil(r.x + r.w), 0, W), y1 = clamp(Math.ceil(r.y + r.h), 0, H);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

function buildColliders(props, arch, cloud) {
  const out = [];
  // The cloud wall: 12 px columns down to the lowest painted cloud pixel, except the passage
  // between the pillars (its own blocker stops at the threshold).
  const COL = 12;
  for (let x0 = 0; x0 < W; x0 += COL) {
    const x1 = Math.min(W, x0 + COL);
    const segs = [[x0, Math.min(x1, PASSAGE.x0)], [Math.max(x0, PASSAGE.x1), x1]].filter(([a, b]) => b > a);
    for (const [a, b] of segs) {
      let maxBase = 0;
      for (let x = a; x < b; x++) maxBase = Math.max(maxBase, cloud.baseY[x]);
      out.push({ x: a, y: 0, w: b - a, h: Math.ceil(maxBase) + 2, note: 'the cloud wall' });
    }
  }
  // The arch: two solid pillars (with their side blocks and steps), and the cloud inside it.
  const f = arch.foot;
  out.push({ x: f.x, y: f.y, w: PASSAGE.x0 - f.x, h: arch.platformBottom + 2 - f.y, note: 'arch west pillar' });
  out.push({ x: PASSAGE.x1, y: f.y, w: f.x + f.w - PASSAGE.x1, h: arch.platformBottom + 2 - f.y, note: 'arch east pillar' });
  out.push({ x: PASSAGE.x0, y: 0, w: PASSAGE.x1 - PASSAGE.x0, h: ENTER_ZONE.y + 2, note: 'inside the arch: only the enter zone leads on' });
  // Side belts: horizontal strips from the map edge to the belt's inner edge line.
  const STRIP = 24;
  for (let y = 0; y < H; y += STRIP) {
    const h = Math.min(STRIP, H - y);
    let L = Infinity, R = -Infinity;
    for (let yy = y; yy <= y + h; yy += 4) { L = Math.min(L, beltLeft(yy)); R = Math.max(R, beltRight(yy)); }
    out.push({ x: 0, y, w: Math.round(L), h, note: 'west belt (rubble and ash dunes)' });
    out.push({ x: Math.round(R), y, w: W - Math.round(R), h, note: 'east belt (rubble and ash dunes)' });
  }
  // South edge: the road back to the city is behind you.
  out.push({ x: 0, y: H - 14, w: W, h: 14, note: 'south edge (the road back)' });
  // Every solid prop's drawn footprint, unless a belt strip already covers it.
  for (const p of props) {
    if (!p.solid || !p.foot) continue;
    const r = p.foot;
    const insideLeft = r.x + r.w <= beltLeft(r.y) - 2 && r.x + r.w <= beltLeft(r.y + r.h) - 2;
    const insideRight = r.x >= beltRight(r.y) + 2 && r.x >= beltRight(r.y + r.h) + 2;
    if (insideLeft || insideRight) continue;
    out.push({ ...r, note: p.note });
  }
  return out.map((r) => ({ ...rectInt(r), note: r.note })).filter((r) => r.w > 0 && r.h > 0);
}

function buildMapData(props, arch, cloud) {
  const colliders = buildColliders(props, arch, cloud);
  // The approach band spans the whole corridor (into both belts), so it cannot be walked around.
  let aL = Infinity, aR = -Infinity;
  for (let y = APPROACH_Y0; y <= APPROACH_Y1; y += 2) { aL = Math.min(aL, beltLeft(y)); aR = Math.max(aR, beltRight(y)); }
  const approach = { id: 'approach', ...rectInt({ x: aL - 30, y: APPROACH_Y0, w: aR - aL + 60, h: APPROACH_Y1 - APPROACH_Y0 }) };

  // Inspectables.
  const f = arch.foot;
  const archRect = { id: 'arch', ...rectInt({ x: f.x + 8, y: T - 96, w: f.w - 16, h: arch.platformBottom - (T - 96) }), dialogue: 'inspect-arch' };
  // Cloudwall: where a tendril of mist meets the ground, east of the arch.
  const cwX = 988;
  let cwBase = 0;
  for (let x = cwX; x < cwX + 72; x++) cwBase = Math.max(cwBase, cloud.baseY[x]);
  const cloudRect = { id: 'cloudwall', ...rectInt({ x: cwX, y: cwBase - 26, w: 72, h: 30 }), dialogue: 'inspect-cloudwall' };
  // Pilgrims: the heart of camp A (its two tents and the fire).
  const campA = props.filter((p) => p.camp === 'A' && ['tent', 'tentTorn', 'deadfire'].includes(p.kind));
  const bx0 = Math.min(...campA.map((p) => p.foot.x)), by0 = Math.min(...campA.map((p) => p.foot.y));
  const bx1 = Math.max(...campA.map((p) => p.foot.x + p.foot.w)), by1 = Math.max(...campA.map((p) => p.foot.y + p.foot.h));
  const pilgrimRect = { id: 'pilgrims', ...rectInt({ x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 }), dialogue: 'inspect-pilgrims' };

  const hazards = POOLS.map((pool) => {
    const kx = 0.8, ky = 0.76;
    return { type: 'toxic', ...rectInt({ x: pool.cx - pool.rx * kx, y: pool.cy - pool.ry * ky, w: pool.rx * kx * 2, h: pool.ry * ky * 2 }) };
  });
  const enterCentre = { x: Math.round(ENTER_CENTRE.x), y: Math.round(ENTER_CENTRE.y) };
  return {
    image: 'map-gate',
    width: W,
    height: H,
    area: 'Paradise Gate',
    spawn: SPAWN,
    colliders,
    occluders: [],
    npcs: [],
    pickups: [WATER_1, RATION_1],
    inspectables: [archRect, cloudRect, pilgrimRect],
    zones: [approach, ENTER_ZONE],
    hazards,
    checkpoints: CHECKPOINTS,
    drones: [],
    crawlers: CRAWLERS,
    points: POINTS,
    markers: {
      gate: enterCentre,
      eli_falls: enterCentre,
    },
  };
}

// ---------------------------------------------------------------------------
// 7. Verification (flood-fill pattern from outskirts.mjs / maps.mjs)

const right = (r) => r.x + r.w;
const bottom = (r) => r.y + r.h;
const check = (name, pass, detail = '') => ({ name, pass: Boolean(pass), detail });

function pointRectDistance(px, py, r) {
  const dx = Math.max(r.x - px, 0, px - right(r));
  const dy = Math.max(r.y - py, 0, py - bottom(r));
  return Math.hypot(dx, dy);
}
const rectsOverlap = (a, b) => a.x < right(b) && right(a) > b.x && a.y < bottom(b) && bottom(a) > b.y;
const bodyAt = (fx, fy) => ({ x: fx - BODY_W / 2, y: fy - BODY_H, w: BODY_W, h: BODY_H });
const pointIn = (px, py, r) => px >= r.x && px < right(r) && py >= r.y && py < bottom(r);

function buildBlocked(rects) {
  const mask = new Uint8Array(W * H);
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor(r.x)), x1 = Math.min(W, Math.ceil(right(r)));
    const y0 = Math.max(0, Math.floor(r.y)), y1 = Math.min(H, Math.ceil(bottom(r)));
    for (let y = y0; y < y1; y++) mask.fill(1, y * W + x0, y * W + x1);
  }
  return mask;
}

function buildBodyFree(rects) {
  const mask = buildBlocked(rects);
  const W1 = W + 1;
  const sat = new Int32Array(W1 * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += mask[y * W + x];
      sat[(y + 1) * W1 + (x + 1)] = sat[y * W1 + (x + 1)] + row;
    }
  }
  return (fx, fy) => {
    const x0 = fx - BODY_W / 2, x1 = fx + BODY_W / 2, y0 = fy - BODY_H, y1 = fy;
    if (x0 < 0 || y0 < 0 || x1 > W || y1 > H) return false;
    return sat[y1 * W1 + x1] - sat[y0 * W1 + x1] - sat[y1 * W1 + x0] + sat[y0 * W1 + x0] === 0;
  };
}

const GW = Math.floor(W / GRID) + 1;
const GH = Math.floor(H / GRID) + 1;

/**
 * Flood fill of feet positions on a 2 px grid. `rects` block the 16x10 body; `feetBlock`
 * (optional) are trigger zones the feet point may not enter (how the engine tests zones).
 */
function floodFill(rects, start, feetBlock = []) {
  const bodyFree = buildBodyFree(rects);
  const ok = (fx, fy) => bodyFree(fx, fy) && !feetBlock.some((z) => pointIn(fx, fy, z));
  const reached = new Uint8Array(GW * GH);
  const sx = Math.round(start.x / GRID), sy = Math.round(start.y / GRID);
  if (!ok(sx * GRID, sy * GRID)) return { reached, startFree: false, count: 0 };
  const queue = new Int32Array(GW * GH);
  let head = 0, tail = 0;
  reached[sy * GW + sx] = 1;
  queue[tail++] = sy * GW + sx;
  while (head < tail) {
    const idx = queue[head++];
    const gx = idx % GW, gy = (idx - gx) / GW;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = gx + dx, ny = gy + dy;
      if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
      const n = ny * GW + nx;
      if (reached[n] || !ok(nx * GRID, ny * GRID)) continue;
      reached[n] = 1;
      queue[tail++] = n;
    }
  }
  return { reached, startFree: true, count: tail };
}

function someReached(reached, box, fn) {
  const gx0 = Math.max(0, Math.floor(box.x / GRID)), gx1 = Math.min(GW - 1, Math.ceil(right(box) / GRID));
  const gy0 = Math.max(0, Math.floor(box.y / GRID)), gy1 = Math.min(GH - 1, Math.ceil(bottom(box) / GRID));
  for (let gy = gy0; gy <= gy1; gy++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      if (reached[gy * GW + gx] && fn(gx * GRID, gy * GRID)) return true;
    }
  }
  return false;
}

function nearestReached(reached, px, py, maxDist) {
  let best = Infinity;
  someReached(reached, { x: px - maxDist, y: py - maxDist, w: maxDist * 2, h: maxDist * 2 }, (fx, fy) => {
    best = Math.min(best, Math.hypot(fx - px, fy - py));
    return false;
  });
  return best;
}

function reachableSides(reached, r, radius) {
  const sides = [];
  const box = { x: r.x - radius, y: r.y - radius, w: r.w + radius * 2, h: r.h + radius * 2 };
  const test = (pred) => someReached(reached, box, (fx, fy) => pointRectDistance(fx, fy, r) <= radius && pred(fx, fy));
  if (test((fx, fy) => fy <= r.y)) sides.push('N');
  if (test((fx, fy) => fy >= bottom(r))) sides.push('S');
  if (test((fx) => fx <= r.x)) sides.push('W');
  if (test((fx) => fx >= right(r))) sides.push('E');
  if (test((fx, fy) => pointIn(fx, fy, r))) sides.push('in');
  return sides;
}

function edgeTouches(reached) {
  const hits = [];
  for (let gy = 0; gy < GH; gy++) {
    for (let gx = 0; gx < GW; gx++) {
      if (!reached[gy * GW + gx]) continue;
      const b = bodyAt(gx * GRID, gy * GRID);
      if (b.x < EDGE_MARGIN || b.y < EDGE_MARGIN || right(b) > W - EDGE_MARGIN || bottom(b) > H - EDGE_MARGIN) hits.push({ x: gx * GRID, y: gy * GRID });
    }
  }
  return hits;
}

function verify(map) {
  const out = [];
  const approach = map.zones.find((z) => z.id === 'approach');
  const enter = map.zones.find((z) => z.id === 'enter');
  const colliders = map.colliders;

  // Schema basics.
  const isRect = (r) => ['x', 'y', 'w', 'h'].every((k) => Number.isInteger(r[k])) && r.w > 0 && r.h > 0 && r.x >= 0 && r.y >= 0 && right(r) <= W && bottom(r) <= H;
  const bad = [];
  for (const key of ['colliders', 'inspectables', 'zones', 'hazards', 'checkpoints']) map[key].forEach((r, i) => { if (!isRect(r)) bad.push(`${key}[${i}]`); });
  out.push(check('all rects are positive integers inside the map', bad.length === 0, bad.slice(0, 6).join(', ')));
  out.push(check('occluders list is empty', map.occluders.length === 0));
  out.push(check('size: width 1448, height 1400-1700', W === 1448 && H >= 1400 && H <= 1700, `${W}x${H}`));
  out.push(check('area is "Paradise Gate", image map-gate', map.area === 'Paradise Gate' && map.image === 'map-gate'));
  out.push(check('spawn faces up', map.spawn.facing === 'up'));
  out.push(check('pickups gt-water-1 (water) and gt-ration-1 (ration), dialogue null',
    map.pickups.some((p) => p.id === 'gt-water-1' && p.item === 'water' && p.dialogue === null) &&
    map.pickups.some((p) => p.id === 'gt-ration-1' && p.item === 'ration' && p.dialogue === null) && map.pickups.length === 2));
  out.push(check('inspectables arch / cloudwall / pilgrims', ['arch', 'cloudwall', 'pilgrims'].every((id) => map.inspectables.some((r) => r.id === id && r.dialogue === `inspect-${id}`))));
  out.push(check('zones approach / enter', Boolean(approach && enter)));
  out.push(check('points party-halt / eli-enter / eli-collapse', ['party-halt', 'eli-enter', 'eli-collapse'].every((k) => map.points[k])));
  const ec = { x: enter.x + enter.w / 2, y: enter.y + enter.h / 2 };
  const near = (m) => m && Math.abs(m.x - ec.x) <= 1 && Math.abs(m.y - ec.y) <= 1;
  out.push(check('markers gate and eli_falls = centre of enter', near(map.markers.gate) && near(map.markers.eli_falls), `(${ec.x}, ${ec.y})`));
  out.push(check('eli-enter = centre of enter', near(map.points['eli-enter'])));
  out.push(check('checkpoint gt-cp-1 contains the spawn', map.checkpoints[0].id === 'gt-cp-1' && pointIn(map.spawn.x, map.spawn.y, map.checkpoints[0])));

  // Distances south of the arch threshold (T = bottom of the enter zone).
  const Ty = bottom(enter);
  const ph = map.points['party-halt'], col = map.points['eli-collapse'];
  out.push(check('party-halt ~170 px south of the arch, on the road', Math.abs(ph.y - Ty - 170) <= 15 && roadDistance(ph.x, ph.y) < roadHalfWidth(ph.y), `${ph.y - Ty} px`));
  out.push(check('eli-collapse 60-80 px south of the arch', col.y - Ty >= 60 && col.y - Ty <= 80, `${col.y - Ty} px`));
  out.push(check('approach band 200-260 px south of the arch', approach.y - Ty >= 200 && bottom(approach) - Ty <= 260, `${approach.y - Ty}..${bottom(approach) - Ty} px`));
  out.push(check('approach band crosses the road', approach.x < roadX(approach.y) - roadHalfWidth(approach.y) && right(approach) > roadX(approach.y) + roadHalfWidth(approach.y)));

  const free = floodFill(colliders, map.spawn);                                        // walking anywhere
  const noApproach = floodFill(colliders, map.spawn, [approach]);                       // never stepping into approach
  const safe = floodFill([...colliders, ...map.hazards], map.spawn);                    // never stepping in sludge
  out.push(check('spawn is on free ground', free.startFree, `(${map.spawn.x}, ${map.spawn.y})`));
  out.push(check('reachable area', free.count > 0, `${Math.round((free.count * GRID * GRID) / 1000)}k px^2`));

  // Clearances for pickups (and NPCs, none here).
  for (const a of map.pickups) {
    const nearest = colliders.reduce((best, c) => (pointRectDistance(a.x, a.y, c) < pointRectDistance(a.x, a.y, best) ? c : best));
    const clear = pointRectDistance(a.x, a.y, nearest);
    const edge = Math.min(a.x, a.y, W - a.x, H - a.y);
    out.push(check(`${a.id}: ${CLEARANCE}+ px from colliders, ${EDGE_CLEARANCE}+ px from edges`, clear >= CLEARANCE && edge >= EDGE_CLEARANCE,
      `${clear.toFixed(1)} px (${nearest.note}) / edge ${edge} px`));
    const d = nearestReached(free.reached, a.x, a.y, INTERACT_RADIUS + 4);
    out.push(check(`${a.id}: reachable from spawn (within ${INTERACT_RADIUS} px)`, d <= INTERACT_RADIUS, `${d.toFixed(1)} px`));
    out.push(check(`${a.id}: hazard-free route, not in a hazard`, nearestReached(safe.reached, a.x, a.y, INTERACT_RADIUS + 4) <= INTERACT_RADIUS &&
      !map.hazards.some((h) => pointRectDistance(a.x, a.y, h) < 12)));
  }
  for (const r of map.inspectables) {
    const sides = reachableSides(free.reached, r, INTERACT_RADIUS - 4);
    out.push(check(`inspectable ${r.id}: a side is reachable`, sides.length > 0, `sides ${sides.join(' ') || 'none'}`));
  }
  const archI = map.inspectables.find((r) => r.id === 'arch');
  out.push(check('inspectable arch: reachable from the front (south)', reachableSides(free.reached, archI, INTERACT_RADIUS - 4).includes('S')));
  const cwI = map.inspectables.find((r) => r.id === 'cloudwall');
  out.push(check('inspectable cloudwall: touches the cloud wall (mist meets ground)', colliders.some((c) => c.note === 'the cloud wall' && rectsOverlap(c, cwI))));

  // Points: the body fits there and it is reachable.
  const bodyFree = buildBodyFree(colliders);
  for (const [k, p] of Object.entries(map.points)) {
    const ok = bodyFree(p.x, p.y) && nearestReached(free.reached, p.x, p.y, 4) <= 2;
    out.push(check(`point ${k}: walkable and reachable`, ok, `(${p.x}, ${p.y})`));
  }
  const cp = map.checkpoints[0];
  out.push(check('checkpoint gt-cp-1: respawn on walkable ground', bodyFree(cp.respawn.x, cp.respawn.y)));

  // Zones: the feet can get inside.
  const touchesZone = (fill, z) => someReached(fill.reached, z, (fx, fy) => pointIn(fx, fy, z));
  out.push(check('zone enter: reachable (feet inside)', touchesZone(free, enter)));
  out.push(check('zone approach: reachable (feet inside)', touchesZone(free, approach)));

  // The approach band cannot be bypassed.
  const beyond = someReached(noApproach.reached, { x: 0, y: 0, w: W, h: approach.y }, () => true);
  out.push(check('approach cannot be bypassed (nothing north of it without crossing)', !beyond && !touchesZone(noApproach, enter)));

  // Sealing: no map edge can be reached, and inside the arch nothing lies beyond the enter zone.
  const edges = edgeTouches(free.reached);
  out.push(check('sealed: no map edge is reachable', edges.length === 0, edges.slice(0, 4).map((p) => `${p.x},${p.y}`).join(' ')));
  const pastEnter = someReached(free.reached, { x: PASSAGE.x0 - 40, y: 0, w: PASSAGE.x1 - PASSAGE.x0 + 80, h: enter.y }, () => true);
  out.push(check('sealed: the cloud is only entered through the enter zone', !pastEnter));
  const cloudCols = colliders.filter((c) => c.note === 'the cloud wall');
  const inCloud = someReached(free.reached, { x: 0, y: 0, w: W, h: 760 }, (fx, fy) => cloudCols.some((c) => pointIn(fx, fy - 1, c)));
  out.push(check('sealed: no feet position inside the cloud wall', !inCloud));

  // Hazard-free route to the arch.
  out.push(check('hazard-free route: spawn -> enter', touchesZone(safe, enter)));
  out.push(check('hazards are off the road', map.hazards.every((h) => roadDistance(h.x + h.w / 2, h.y + h.h / 2) - roadHalfWidth(h.y) > 60)));

  // Crawlers: well off the road and away from the spawn, on walkable ground.
  for (const c of map.crawlers) {
    const dRoad = roadDistance(c.x, c.y) - roadHalfWidth(c.y);
    const dSpawn = Math.hypot(c.x - map.spawn.x, c.y - map.spawn.y);
    out.push(check(`crawlers ${c.id}: count <= 2, 200+ px from the road edge and spawn`, c.count <= 2 && dRoad >= 200 && dSpawn >= 200, `road ${dRoad.toFixed(0)} px, spawn ${dSpawn.toFixed(0)} px`));
    out.push(check(`crawlers ${c.id}: on reachable ground`, nearestReached(free.reached, c.x, c.y, 4) <= 2));
  }
  return { checks: out, free, safe, noApproach };
}

// ---------------------------------------------------------------------------
// 8. Previews

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const label = (x, y, text, color, size = 11) =>
  `<text x="${x}" y="${y}" font-family="Menlo, monospace" font-size="${size}" fill="${color}" stroke="#000" stroke-width="2.5" paint-order="stroke">${esc(text)}</text>`;

/** Overlay: colliders red, zones magenta, points white, inspectables orange, pickups yellow. */
function overlaySvg(map) {
  const p = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`];
  for (const c of map.colliders) p.push(`<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" fill="#ff2020" fill-opacity="0.3" stroke="#ff2020" stroke-opacity="0.85" stroke-width="1"/>`);
  for (const h of map.hazards) p.push(`<rect x="${h.x}" y="${h.y}" width="${h.w}" height="${h.h}" fill="#30ff40" fill-opacity="0.35" stroke="#30ff40" stroke-width="2"/>`);
  for (const z of map.zones) {
    p.push(`<rect x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" fill="#ff00ff" fill-opacity="0.35" stroke="#ff00ff" stroke-width="2"/>`);
    p.push(label(z.x + 34, z.y + z.h / 2 + 4, z.id, '#ff80ff'));
  }
  for (const cp of map.checkpoints) {
    p.push(`<rect x="${cp.x}" y="${cp.y}" width="${cp.w}" height="${cp.h}" fill="none" stroke="#ffffff" stroke-width="2" stroke-dasharray="5 3"/>`);
    p.push(label(cp.x + 2, cp.y - 4, cp.id, '#ffffff'));
  }
  for (const r of map.inspectables) {
    p.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="none" stroke="#ff9a1a" stroke-width="2.5" stroke-dasharray="4 2"/>`);
    p.push(label(r.x, r.y - 4, `inspect:${r.id}`, '#ffb050'));
  }
  for (const c of map.crawlers) {
    p.push(`<circle cx="${c.x}" cy="${c.y}" r="${c.radius}" fill="none" stroke="#c040ff" stroke-width="2" stroke-dasharray="4 3"/>`);
    p.push(label(c.x - 30, c.y + 4, `crawlers x${c.count}`, '#d080ff'));
  }
  for (const q of map.pickups) {
    p.push(`<circle cx="${q.x}" cy="${q.y}" r="6" fill="#ffe030" stroke="#000" stroke-width="1.5"/>`);
    p.push(label(q.x + 8, q.y + 4, q.id, '#ffe860'));
  }
  for (const [k, pt] of Object.entries(map.points)) {
    p.push(`<circle cx="${pt.x}" cy="${pt.y}" r="5" fill="#ffffff" stroke="#000" stroke-width="1.5"/>`);
    p.push(label(pt.x + 8, pt.y + 4, k, '#ffffff'));
  }
  p.push(`<circle cx="${map.spawn.x}" cy="${map.spawn.y}" r="6" fill="#ffffff" stroke="#000"/>`);
  p.push(label(map.spawn.x + 8, map.spawn.y + 4, 'spawn', '#ffffff'));
  for (const [k, m] of Object.entries(map.markers)) {
    p.push(`<path d="M${m.x},${m.y - 7} L${m.x + 7},${m.y} L${m.x},${m.y + 7} L${m.x - 7},${m.y} Z" fill="none" stroke="#fff200" stroke-width="2"/>`);
    p.push(label(m.x - 150, m.y + (k === 'gate' ? -6 : 10), `marker:${k}`, '#fff200', 10));
  }
  p.push('</svg>');
  return p.join('\n');
}

function reachLayer(reached, rgba) {
  const buf = Buffer.alloc(W * H * 4);
  for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
    if (!reached[gy * GW + gx]) continue;
    for (let y = gy * GRID; y < Math.min(H, gy * GRID + GRID); y++) for (let x = gx * GRID; x < Math.min(W, gx * GRID + GRID); x++) {
      const i = (y * W + x) * 4;
      buf[i] = rgba[0]; buf[i + 1] = rgba[1]; buf[i + 2] = rgba[2]; buf[i + 3] = rgba[3];
    }
  }
  return { input: buf, raw: { width: W, height: H, channels: 4 } };
}

// ---------------------------------------------------------------------------

function printResults(title, results) {
  console.log(`\n${title}`);
  for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  [${r.detail}]` : ''}`);
}

/** Finds 40 x 40 windows of the stone-path card with almost no grass (for the flagstones). */
function stoneSource(card) {
  const isStone = (h, s) => !(h >= 60 && h <= 170 && s > 0.25);
  const at = findWindows(card, { x: 8, y: 8, w: card.w - 16, h: card.h - 16 }, 40, isStone, 0.97, 4);
  return { size: 40, at };
}

async function main() {
  const args = process.argv.slice(2);
  const debugDir = args.includes('--debug') ? args[args.indexOf('--debug') + 1] : null;
  const t0 = Date.now();

  const waste = await loadRaw(RAW('wasteland-map.png'));
  const stoneCard = await loadRaw(CARD('stone-path'));

  // Texture samplers.
  const dirt = makeQuilt(waste, SOURCES.dirt, { cell: 27, seed: SEED + 300 });
  const asphalt = makeQuilt(waste, SOURCES.asphalt, { cell: 30, seed: SEED + 400 });
  const stoneSrc = stoneSource(stoneCard);
  const stoneRaw = makeQuilt(stoneCard, stoneSrc, { cell: 22, warp: 2, seed: SEED + 500 });
  // Flagstones: the card's grey slabs, made a little cooler and paler (old, ash-dusted stone).
  const stone = (x, y, out) => {
    stoneRaw(x, y, out);
    const [h, s, v] = rgbToHsv(out[0], out[1], out[2]);
    return hsvToRgb(h, s * 0.5, v * 0.92, out);
  };

  const cv = makeCanvas();
  paintGround(cv, { dirt, asphalt });
  shadeDunes(cv);
  paintRoad(cv, { asphalt, stone });
  paintPools(cv, sludgePalette(waste));
  const props = planProps();
  await paintProps(cv, props);
  shadeBelts(cv);
  gradeGround(cv);

  const arch = await buildArch();
  const lobes = planLobes();
  const cloud = paintCloud(lobes);
  // Back cloud first, then the arch in front of it, then the cloud again over the arch's crown.
  compositeCloud(cv, cloud, { alphaAt: () => 0 });
  drawArch(cv, arch);
  compositeCloud(cv, cloud, arch);
  const front = paintCloud(planFrontLobes());
  compositeCloud(cv, front, { alphaAt: () => 0 });
  paintMist(cv, cloud.baseY);
  paintBloom(cv);
  paintAura(cv, arch);
  paintSparkles(cv);
  vignette(cv);
  console.log(`Painted ${W}x${H}: ${props.length} props, ${lobes.length} cloud lobes, ${stoneSrc.at.length} stone windows in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  const rgb = Buffer.alloc(W * H * 3);
  for (let i = 0; i < rgb.length; i++) rgb[i] = clamp(Math.round(cv[i]), 0, 255);
  await fs.mkdir(path.dirname(OUT_PNG), { recursive: true });
  await sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).png({ compressionLevel: 9 }).toFile(OUT_PNG);

  // Data.
  const map = buildMapData(props, arch, cloud);
  await fs.mkdir(path.dirname(OUT_JSON), { recursive: true });
  await fs.writeFile(OUT_JSON, `${JSON.stringify(map, null, 2)}\n`);
  console.log(`Wrote ${path.relative(ROOT, OUT_PNG)} and ${path.relative(ROOT, OUT_JSON)} (${map.colliders.length} colliders)`);

  // Checks.
  const { checks, free, safe } = verify(map);
  printResults('Gate checks (player body 16x10, grid 2 px)', checks);

  // Previews.
  await fs.mkdir(path.dirname(PREVIEW_SMALL), { recursive: true });
  await sharp(OUT_PNG).resize({ height: 700 }).png().toFile(PREVIEW_SMALL);
  await sharp(OUT_PNG).composite([{ input: Buffer.from(overlaySvg(map)) }]).png({ compressionLevel: 9 }).toFile(PREVIEW_OVERLAY);
  console.log(`\nPreviews: ${path.relative(ROOT, PREVIEW_SMALL)}, ${path.relative(ROOT, PREVIEW_OVERLAY)}`);

  if (debugDir) {
    await fs.mkdir(debugDir, { recursive: true });
    const reach = await sharp(OUT_PNG)
      .composite([reachLayer(free.reached, [0, 230, 255, 90]), reachLayer(safe.reached, [255, 140, 0, 50])])
      .png().toBuffer();
    await sharp(reach).resize({ height: 900 }).png().toFile(path.join(debugDir, 'gate-reach.png'));
    console.log(`Debug reach map written to ${debugDir}`);
  }

  const failed = checks.filter((r) => !r.pass);
  console.log(`\n${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`} (${checks.length} checks)`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

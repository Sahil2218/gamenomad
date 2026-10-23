// THE NOMAD: Outskirts map generator (task G, Milestone 2, Act II).
//
// Run from the project root:   node tools/assets/outskirts.mjs
// Optional scratch output:      node tools/assets/outskirts.mjs --debug /tmp/nomad-g
//
// What it does:
//   1. Paints public/assets/maps/outskirts.png (1448 x 1640). The top 306 rows are the exact
//      south edge of the village map (fence, gate towers, river, bridge). Below it a meadow
//      slowly dies: lush grass -> dry grass -> dirt and ash -> cracked asphalt, and the bottom
//      210 rows blend into the top of the wasteland map so the road runs on into the city.
//      Ground is "patch quilted" from real regions of the two source maps, props are cut
//      from the prop cards and from the wasteland map, then everything gets one colour grade.
//   2. Writes src/data/maps/outskirts.json straight from the same placement data, so every
//      collider rectangle is exactly where its prop was drawn.
//   3. Verifies the layout (reachability, sealing, the gate, hazard-free routes, drone stealth)
//      and prints a PASS/FAIL list. Exits non-zero on failure.
//   4. Writes tools/previews/outskirts-small.png and tools/previews/outskirts-overlay.png.
//
// Everything is seeded, so a re-run produces the same map.

import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RAW = (name) => path.join(ROOT, 'raw-assets', name);
const CARD = (name) => path.join(ROOT, 'public', 'assets', 'props', `${name}.png`);
const OUT_PNG = path.join(ROOT, 'public', 'assets', 'maps', 'outskirts.png');
const OUT_JSON = path.join(ROOT, 'src', 'data', 'maps', 'outskirts.json');
const PREVIEW_SMALL = path.join(ROOT, 'tools', 'previews', 'outskirts-small.png');
const PREVIEW_OVERLAY = path.join(ROOT, 'tools', 'previews', 'outskirts-overlay.png');

// ---------------------------------------------------------------------------
// Map geometry

const W = 1448;
const H = 1640;
const VILLAGE_OY = 780;          // village row copied to our row 0
const TOP_H = 1086 - VILLAGE_OY; // 306 rows of exact village pixels
const BOT_H = 210;               // wasteland rows 0..209 become our last 210 rows
const BOT_Y = H - BOT_H;         // 1430
const SEED = 2207;

// Player body (contract §8): 16 x 10 at the feet. Drones: ~95 px cone (M2 §5).
const BODY_W = 16;
const BODY_H = 10;
const GRID = 2;
const INTERACT_RADIUS = 28;
const CLEARANCE = 20;
const EDGE_CLEARANCE = 40;
const EDGE_MARGIN = 6;

// ---------------------------------------------------------------------------
// Small math helpers

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

/**
 * Colour shift used for "decay": rotate hue, scale saturation and value.
 * k = 0 leaves the colour alone, k = 1 applies the full shift.
 */
function shiftColor(c, k, { dh = 0, ks = 1, kv = 1 }) {
  if (k <= 0) return c;
  const [h, s, v] = rgbToHsv(c[0], c[1], c[2]);
  return hsvToRgb(h + dh * k, s * lerp(1, ks, k), Math.min(1, v * lerp(1, kv, k)), c);
}

// Colour shifts for the decaying ground and foliage.
const DRY_GRASS = { dh: -30, ks: 0.55, kv: 0.9 };   // green lawn -> straw-olive
const ASH = { dh: 4, ks: 0.32, kv: 0.88 };          // wasteland dirt -> grey ash
const DUSTY_PATH = { dh: -6, ks: 0.42, kv: 0.7 };   // village path -> dusty trail
const DYING_LEAVES = { dh: -34, ks: 0.62, kv: 0.88 };
const ROCK_GREY = { dh: 6, ks: 0.42, kv: 0.78 };      // the orange rock-pile card -> grey-brown rubble
const PALE_ROCK = { dh: 12, ks: 1.6, kv: 0.7 };       // pale concrete boulders -> dimmer, warmer stone

// ---------------------------------------------------------------------------
// Image IO

async function loadRaw(file, channels = 3) {
  const img = sharp(file);
  const pipeline = channels === 3 ? img.removeAlpha() : img.ensureAlpha();
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height, ch: info.channels };
}

// ---------------------------------------------------------------------------
// Texture sources (top-left corners of hand-checked windows in the source maps).

const SOURCES = {
  // Village open lawn, plain and with flowers (56 x 56 windows).
  lawn: { map: 'village', size: 56, at: [[456, 736], [528, 472], [1184, 208], [1032, 512], [480, 576], [232, 784], [352, 0]] },
  flowerLawn: {
    map: 'village', size: 56,
    at: [[712, 320], [1224, 528], [552, 168], [1024, 416], [1272, 552], [496, 912], [1024, 464], [432, 304], [568, 912], [296, 152], [1320, 544], [936, 760], [408, 648]],
  },
  // Village dirt path (40 x 40).
  path: { map: 'village', size: 40, at: [[812, 1044], [832, 880], [468, 452], [1052, 248], [472, 384], [284, 780], [472, 420], [288, 456], [1052, 216]] },
  // Wasteland bare dirt (64 x 64) and road asphalt (72 x 72).
  dirt: { map: 'wasteland', size: 64, at: [[1048, 232], [360, 904], [1048, 584], [1296, 704], [920, 248], [504, 0], [1168, 816], [1072, 760], [784, 680], [1304, 944]] },
  asphalt: { map: 'wasteland', size: 72, at: [[708, 564], [1368, 504], [576, 540], [432, 804], [624, 156], [696, 240], [372, 360], [492, 768], [456, 888], [600, 0], [648, 528]] },
  // Toxic sludge windows are found automatically inside this wasteland region.
  toxic: { map: 'wasteland', size: 36, search: { x: 1090, y: 0, w: 358, h: 400 } },
};

/** Lime-green sludge pixels (used to find toxic source windows). */
const isSludge = (h, s, v) => h >= 62 && h <= 112 && s >= 0.5 && v >= 0.42;

function findWindows(img, region, size, test, minFrac, step = 6) {
  const found = [];
  for (let y = region.y; y + size <= region.y + region.h && y + size <= img.h; y += step) {
    for (let x = region.x; x + size <= region.x + region.w && x + size <= img.w; x += step) {
      let n = 0, hit = 0;
      for (let yy = y; yy < y + size; yy += 2) {
        for (let xx = x; xx < x + size; xx += 2) {
          const i = (yy * img.w + xx) * 3;
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
 * Patch quilting sampler.
 * The plane is split into jittered cells (Worley cells, warped by noise so their borders are
 * organic). Each cell shows a piece of one randomly chosen source window, optionally mirrored,
 * at its natural pixel scale. Neighbouring cells cross-fade over a couple of pixels.
 */
function makeQuilt(img, src, { cell, jitter = 0.36, warp = 5, feather = 2.2, seed }) {
  const half = src.size / 2;
  const centers = src.at.map(([x, y]) => [x + half, y + half]);
  const cache = new Map();

  function cellInfo(gx, gy) {
    const key = gx * 65536 + gy;
    let info = cache.get(key);
    if (!info) {
      info = {
        px: (gx + 0.5 + (hash2(gx, gy, seed) - 0.5) * 2 * jitter) * cell,
        py: (gy + 0.5 + (hash2(gx, gy, seed + 1) - 0.5) * 2 * jitter) * cell,
        c: centers[Math.floor(hash2(gx, gy, seed + 2) * centers.length)],
        flip: hash2(gx, gy, seed + 3) < 0.5,
        // Pick a random sub-offset so the same window does not line up the same way twice.
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
    const i = (sy * img.w + sx) * 3;
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
// Layout curves

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

// The trail: off the bridge, winding south, becoming the road into the city.
const PATH_POINTS = [
  [841, 286], [842, 360], [814, 450], [748, 540], [704, 628], [716, 716], [780, 800],
  [832, 880], [826, 958], [784, 1040], [728, 1120], [688, 1208], [664, 1300], [656, 1400], [656, 1500], [656, 1660],
];
const PATH_POLY = spline(PATH_POINTS);
const pathHalfWidth = curveY([[306, 44], [400, 32], [560, 27], [900, 24], [1040, 30], [1150, 52], [1380, 64], [1430, 68], [1640, 68]]);

/** x of the trail centre at row y. */
function pathX(y) {
  for (let i = 0; i < PATH_POLY.length - 1; i++) {
    const [x0, y0] = PATH_POLY[i], [x1, y1] = PATH_POLY[i + 1];
    if (y >= y0 && y <= y1) return lerp(x0, x1, (y - y0) / Math.max(1e-6, y1 - y0));
  }
  return y < PATH_POLY[0][1] ? PATH_POLY[0][0] : PATH_POLY[PATH_POLY.length - 1][0];
}

/** Distance from (x, y) to the trail polyline. */
function pathDistance(x, y) {
  let best = Infinity;
  for (let i = 0; i < PATH_POLY.length - 1; i++) {
    const [x0, y0] = PATH_POLY[i], [x1, y1] = PATH_POLY[i + 1];
    if (Math.min(y0, y1) > y + 120 || Math.max(y0, y1) < y - 120) continue;
    const dx = x1 - x0, dy = y1 - y0;
    const t = clamp(((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy || 1), 0, 1);
    const d = Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy));
    if (d < best) best = d;
  }
  return best;
}

// Inner edges of the impassable belts: the line where the edge props stand.
const beltLeft = curveY([[306, 560], [380, 520], [500, 470], [620, 452], [760, 470], [880, 470], [980, 440], [1100, 430], [1200, 440], [1320, 500], [1430, 560]]);
const beltRight = curveY([[306, 1140], [380, 1180], [500, 1170], [620, 1130], [760, 1120], [880, 1160], [980, 1170], [1100, 1150], [1200, 1030], [1320, 880], [1430, 752]]);

/** South river bank line below the village band. */
const bankY = (x) => TOP_H + 15 + (fbm(x / 46, 3.7, SEED + 31, 3) - 0.5) * 16;

/**
 * "Decay" field: 0 = lush village lawn, 1 = dead city ground.
 * Mostly driven by y, wobbled by large and small noise so the boundaries are organic.
 */
function decayAt(x, y) {
  const base = (y - 340) / 1060;
  const big = (fbm(x / 230, y / 170, SEED + 1, 4) - 0.5) * 0.62;
  const small = (fbm(x / 46, y / 46, SEED + 2, 3) - 0.5) * 0.14;
  return base + big + small;
}

// ---------------------------------------------------------------------------
// Gameplay layout (all coordinates are map pixels).

const SPAWN = { x: 841, y: 222, facing: 'down' };
const GATE_ZONE = { id: 'gate', x: 789, y: 150, w: 104, h: 16 };
const EXIT_ZONE = { id: 'exit', x: 590, y: 1604, w: 134, h: 36 };

// Toxic pools: superellipse blobs painted with wasteland sludge. The hazard is the blob's core.
const POOLS = [
  { id: 'poolA', cx: 548, cy: 912, rx: 84, ry: 52, p: 2.6 },  // the satchel pool, against the west belt
  { id: 'poolB', cx: 1062, cy: 842, rx: 56, ry: 36, p: 2.4 },
  { id: 'poolC', cx: 918, cy: 1214, rx: 52, ry: 32, p: 2.4 },
];

const MIRA = { id: 'mira', sprite: 'mira', name: 'Mira', x: 990, y: 1096, facing: 'down', dialogue: 'mira', wander: 0, tint: null };
const SATCHEL = { id: 'os-satchel', item: 'crystal', x: 518, y: 912, dialogue: 'pickup-satchel', requires: { quest: 'satchel' } };
const WATER_1 = { id: 'os-water-1', item: 'water', x: 1010, y: 526, dialogue: null };
const WATER_2 = { id: 'os-water-2', item: 'water', x: 600, y: 1150, dialogue: null };

const DRONES = [
  { id: 'd1', speed: 40, loop: false, path: [{ x: 560, y: 746 }, { x: 1050, y: 746 }] },
  { id: 'd2', speed: 40, loop: false, path: [{ x: 604, y: 990 }, { x: 870, y: 990 }] },
  { id: 'd3', speed: 42, loop: false, path: [{ x: 500, y: 1296 }, { x: 860, y: 1296 }] },
];

const CHECKPOINTS = [
  { id: 'os-cp-1', x: 795, y: 186, w: 92, h: 64, respawn: { x: SPAWN.x, y: SPAWN.y } },
  { id: 'os-cp-2', x: 812, y: 1100, w: 110, h: 56, respawn: { x: 868, y: 1132 } },
];

// Colliders of the copied village band (village.json rects moved up by VILLAGE_OY).
const BAND_COLLIDERS = [
  { x: 0, y: 0, w: W, h: 46, note: 'village interior (behind the fence)' },
  { x: 0, y: 0, w: 128, h: 132, note: 'SW gate tower' },
  { x: 125, y: 46, w: 547, h: 80, note: 'south fence (west)' },
  { x: 668, y: 30, w: 75, h: 132, note: 'south gate tower W' },
  { x: 940, y: 30, w: 73, h: 132, note: 'south gate tower E' },
  { x: 743, y: 46, w: 197, h: 90, note: 'village gate, sealed behind you' },
  { x: 1010, y: 86, w: 312, h: 72, note: 'south fence (east)' },
  { x: 1318, y: 30, w: 82, h: 146, note: 'SE gate tower' },
  { x: 1395, y: 32, w: 53, h: 123, note: 'south fence (far east)' },
  { x: 0, y: 124, w: 789, h: TOP_H - 124, note: 'cliff + river west of bridge (incl. left rail)' },
  { x: 893, y: 134, w: W - 893, h: TOP_H - 134, note: 'cliff + river east of bridge (incl. right rail)' },
];

// The wasteland rows at the bottom: everything but the road is ruins.
const BOTTOM_COLLIDERS = [
  { x: 0, y: BOT_Y, w: 590, h: BOT_H, note: 'city ruins west of the road' },
  { x: 724, y: BOT_Y, w: W - 724, h: BOT_H, note: 'city ruins east of the road' },
];

// ---------------------------------------------------------------------------
// Prop definitions.
//
// Cards (public/assets/props) and crops of the wasteland map. Most use a soft, noise-edged
// superellipse mask that keeps a little of their own ground, so they are only placed on
// matching ground. A few clean cards are cut out by a colour-key flood fill from the edges.

const ELLIPSE = (rx = 0.46, ry = 0.46, extra = {}) => ({ cx: 0.5, cy: 0.5, rx, ry, p: 2.3, feather: 0.16, wobble: 0.06, ...extra });

const PROP_DEFS = {
  tree:     { card: 'tree', mask: ELLIPSE(0.48, 0.47, { cy: 0.49 }), solid: true, shadow: 0.8 },
  bigtree:  { card: 'big-tree', mask: ELLIPSE(0.48, 0.47), solid: true, shadow: 0.8 },
  bush:     { card: 'bush', mask: ELLIPSE(0.44, 0.42, { cy: 0.53 }), solid: true, shadow: 0.7 },
  flowers:  { card: 'flowers', mask: ELLIPSE(0.4, 0.38, { feather: 0.35, wobble: 0.12 }), solid: false, shadow: 0 },
  deadcard: { card: 'dead-tree', cutCrop: true, solid: true, shadow: 0.6 },
  rockpile: { card: 'rock-pile', mask: ELLIPSE(0.47, 0.45, { feather: 0.2 }), solid: true, shadow: 0.6 },
  carcard:  { card: 'wrecked-car', mask: ELLIPSE(0.47, 0.44, { feather: 0.2, p: 3 }), solid: true, shadow: 0.8 },
  debris:   { card: 'burning-debris', mask: ELLIPSE(0.46, 0.44, { feather: 0.24 }), solid: true, shadow: 0.5 },
  signpost: { card: 'signpost', cut: true, solid: true, shadow: 0.5 },
  beacon:   { card: 'beacon', cut: true, solid: true, shadow: 0.5 },
  // Wasteland crops: [left, top, width, height] in raw-assets/wasteland-map.png.
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
  rubbleL:  { crop: [0, 262, 92, 120], mask: ELLIPSE(0.48, 0.47, { feather: 0.24, cx: 0.52 }), solid: true, shadow: 0.4 },
  rubbleE:  { crop: [1346, 696, 100, 112], mask: ELLIPSE(0.47, 0.47, { feather: 0.24 }), solid: true, shadow: 0.4 },
  rubbleS:  { crop: [930, 292, 110, 70], mask: ELLIPSE(0.48, 0.46, { feather: 0.24 }), solid: true, shadow: 0.4 },
};

// ---------------------------------------------------------------------------
// Prop sprite preparation

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

/** Colour-key flood fill from the card edges: removes the card's ground around a clean object. */
function cutOutCard(rgba, w, h, tol = 34) {
  const N = w * h;
  const counts = new Map();
  let total = 0;
  const key = (i) => ((rgba[i * 4] >> 4) << 8) | ((rgba[i * 4 + 1] >> 4) << 4) | (rgba[i * 4 + 2] >> 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x > 5 && x < w - 6 && y > 5 && y < h - 6) continue;
      const i = y * w + x;
      if (rgba[i * 4 + 3] < 128) continue;
      counts.set(key(i), (counts.get(key(i)) || 0) + 1);
      total++;
    }
  }
  const palette = [...counts.entries()].filter(([, c]) => c / total > 0.012)
    .map(([k]) => [((k >> 8) & 15) * 16 + 8, ((k >> 4) & 15) * 16 + 8, (k & 15) * 16 + 8]);
  const nearBg = (i) => palette.some((p) => Math.abs(rgba[i * 4] - p[0]) + Math.abs(rgba[i * 4 + 1] - p[1]) + Math.abs(rgba[i * 4 + 2] - p[2]) < tol);

  const bg = new Uint8Array(N);
  const stack = [];
  for (let i = 0; i < N; i++) {
    const x = i % w, y = (i - x) / w;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || rgba[i * 4 + 3] < 128) { bg[i] = 1; stack.push(i); }
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w, y = (i - x) / w;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (!bg[n] && (rgba[n * 4 + 3] < 128 || nearBg(n))) { bg[n] = 1; stack.push(n); }
    }
  }
  // Keep only the larger foreground pieces (drops stray grass tufts).
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
  const biggest = Math.max(...sizes);
  const alpha = new Uint8Array(N);
  for (let i = 0; i < N; i++) alpha[i] = !bg[i] && sizes[comp[i]] >= Math.max(60, biggest * 0.04) ? 255 : 0;
  // Soften the silhouette by one pixel.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let a = alpha[i];
      if (a && x > 0 && y > 0 && x < w - 1 && y < h - 1) {
        const holes = [i - 1, i + 1, i - w, i + w].filter((n) => !alpha[n]).length;
        if (holes) a = holes >= 2 ? 120 : 190;
      }
      rgba[i * 4 + 3] = Math.min(rgba[i * 4 + 3], a);
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
    .filter((c) => Math.max(...c) > 70); // dark outline colours never count as ground
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
      // Count opaque neighbours for a 1 px soft edge.
      let a = bg[i] ? 0 : 1;
      if (a && x > 0 && y > 0 && x < w - 1 && y < h - 1) {
        const holes = bg[i - 1] + bg[i + 1] + bg[i - w] + bg[i + w];
        if (holes) a = holes >= 2 ? 0.5 : 0.75;
      }
      rgba[i * 4 + 3] = Math.round(255 * Math.max(a, core) * broad);
    }
  }
}

/** Loads a prop's base RGBA (masked or cut out) at its natural size. */
async function loadPropBase(name, def) {
  let buf;
  if (def.card) {
    buf = await sharp(CARD(def.card)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  } else {
    const [left, top, width, height] = def.crop;
    buf = await sharp(RAW('wasteland-map.png')).extract({ left, top, width, height }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  }
  const rgba = new Uint8ClampedArray(buf.data);
  const { width: w, height: h } = buf.info;
  if (def.cut) cutOutCard(rgba, w, h);
  else if (def.cutCrop) cutOutCrop(rgba, w, h, SEED + name.length * 13);
  else applyMask(rgba, w, h, def.mask, SEED + name.length * 13);
  return { rgba, w, h };
}

/** Scaled + mirrored sprite (cached), plus its opaque bounding box ("footprint"). */
async function getSprite(cache, bases, name, scale, flip) {
  const key = `${name}|${scale.toFixed(2)}|${flip ? 1 : 0}`;
  if (cache.has(key)) return cache.get(key);
  const base = bases[name];
  const w = Math.max(4, Math.round(base.w * scale)), h = Math.max(4, Math.round(base.h * scale));
  let img = sharp(Buffer.from(base.rgba.buffer), { raw: { width: base.w, height: base.h, channels: 4 } }).resize(w, h, { kernel: 'lanczos3' });
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
  cache.set(key, sprite);
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
// 1. Ground

function poolMask(pool, x, y) {
  const nx = (x - pool.cx) / pool.rx, ny = (y - pool.cy) / pool.ry;
  const r = (Math.abs(nx) ** pool.p + Math.abs(ny) ** pool.p) ** (1 / pool.p);
  const wob = (fbm(x / 9, y / 9, SEED + 41, 2) - 0.5) * 0.2 + (fbm(x / 26, y / 26, SEED + 42, 2) - 0.5) * 0.3;
  return r + wob; // < 1 is inside
}

function paintGround(cv, maps, samplers, decay) {
  const { lawn, flowerLawn, dirt, asphalt, pathTex } = samplers;
  void maps;
  const c = [0, 0, 0], tmp = [0, 0, 0];

  for (let y = TOP_H - 4; y < H; y++) {
    const hw = pathHalfWidth(y);
    const px = pathX(y);
    for (let x = 0; x < W; x++) {
      const D = decay[y * W + x];
      const rag = (valueNoise(x / 4.5, y / 4.5, SEED + 3) - 0.5) * 0.05; // pixel-scale raggedness
      const d = D + rag;

      // Ground layers, each crossfaded in over a narrow band of the decay value.
      const e = 0.01;
      const layers = [
        { a: 1, s: flowerLawn },
        { a: smoothstep(0.05 - e, 0.05 + e, d), s: lawn },
        { a: smoothstep(0.2 - e, 0.2 + e, d), s: lawn, shift: DRY_GRASS, k: 0.5 },
        { a: smoothstep(0.3 - e, 0.3 + e, d), s: lawn, shift: DRY_GRASS, k: 1 },
        { a: smoothstep(0.4 - e, 0.4 + e, d), s: dirt, rim: 0.3 },
        { a: smoothstep(0.6 - e, 0.6 + e, d), s: dirt, shift: ASH, k: 0.85, rim: 0.12 },
        {
          a: smoothstep(0.84 - e, 0.84 + e, d) * smoothstep(0.46, 0.52, fbm(x / 70, y / 70, SEED + 5, 3) + rag),
          s: asphalt, rim: 0.2,
        },
      ];
      let start = 0;
      for (let i = layers.length - 1; i >= 0; i--) if (layers[i].a >= 0.999) { start = i; break; }
      let r = 0, g = 0, b = 0;
      for (let i = start; i < layers.length; i++) {
        const L = layers[i];
        if (L.a <= 0.001) continue;
        L.s(x, y, c);
        if (L.shift) shiftColor(c, L.k, L.shift);
        if (i === start) { r = c[0]; g = c[1]; b = c[2]; continue; }
        // A darker seam where one ground type meets another (like the hand-drawn outlines).
        const rim = L.rim ? 1 - L.rim * 4 * L.a * (1 - L.a) : 1;
        r = lerp(r, c[0], L.a) * rim; g = lerp(g, c[1], L.a) * rim; b = lerp(b, c[2], L.a) * rim;
      }

      // The trail.
      if (Math.abs(x - px) < hw + 40) {
        const dist = pathDistance(x, y);
        const wob = (valueNoise(x / 6, y / 6, SEED + 9) - 0.5) * 8 + (valueNoise(x / 28, y / 28, SEED + 10) - 0.5) * 14;
        // In the dead zone the trail is trodden dust: the ground shows through it.
        const opacity = 1 - 0.38 * smoothstep(620, 900, y) * (1 - smoothstep(1030, 1110, y));
        const pa = smoothstep(hw + 1.6, hw - 1.6, dist + wob) * opacity;
        if (pa > 0) {
          pathTex(x, y, tmp, D);
          const rim = 1 - 0.26 * 4 * pa * (1 - pa);
          r = lerp(r, tmp[0], pa) * rim; g = lerp(g, tmp[1], pa) * rim; b = lerp(b, tmp[2], pa) * rim;
        }
      }

      const i = (y * W + x) * 3;
      cv[i] = r; cv[i + 1] = g; cv[i + 2] = b;
    }
  }
}

/**
 * Sludge palette (dark -> bright) sampled from the wasteland's own toxic pools, so the new
 * pools use exactly the same greens.
 */
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
    // Average a small slice around the quantile for a stable colour.
    const a = Math.floor(q * (lum.length - 1)), n = Math.max(1, Math.floor(lum.length * 0.02));
    const sum = [0, 0, 0];
    for (let k = 0; k < n; k++) { const c = lum[Math.min(lum.length - 1, a + k)]; sum[0] += c[1]; sum[1] += c[2]; sum[2] += c[3]; }
    return sum.map((v) => v / n);
  };
  const deep = at(0.04).map((v, i) => v * [0.45, 0.52, 0.5][i]);
  return [deep, at(0.04), at(0.3), at(0.62), at(0.94)];
}

/** Toxic pools: banded liquid in the wasteland's sludge greens, ring bubbles, a wet dark shore. */
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
          // Wet, stained ground around the pool.
          const k = smoothstep(1.3, 1.0, m);
          const i = (y * W + x) * 3;
          cv[i] *= 1 - 0.42 * k; cv[i + 1] *= 1 - 0.25 * k; cv[i + 2] *= 1 - 0.48 * k;
          continue;
        }
        // Smooth liquid bands: dark wet edge, thin lime lip, a darker shallow ring, a bright
        // surface with a few slow darker swirls.
        const swirl = fbm(x / 30, y / 16, SEED + 93, 2);
        const mm = m + (swirl - 0.5) * 0.3;
        let idx;
        if (m > 0.965) idx = 0;
        else if (m > 0.915) idx = 4;
        else if (mm > 0.74) idx = 2;
        else idx = swirl > 0.6 ? 2 : 3;
        const a = smoothstep(1.0, 0.985, m);
        blendPixel(cv, x, y, palette[idx], a);
      }
    }
    // Short horizontal glints on the surface.
    for (let k = 0; k < Math.round(pool.rx / 6); k++) {
      const gx = pool.cx + (rng() - 0.5) * pool.rx * 1.3, gy = Math.round(pool.cy + (rng() - 0.5) * pool.ry * 1.2);
      if (poolMask(pool, gx, gy) > 0.7) continue;
      const len = 3 + Math.floor(rng() * 6);
      for (let i = 0; i < len; i++) blendPixel(cv, Math.round(gx) + i, gy, palette[4], i === 0 || i === len - 1 ? 0.5 : 0.9);
    }
    // Ring bubbles, like the ones in the wasteland's sludge.
    const count = Math.round((pool.rx * pool.ry) / 520);
    for (let k = 0; k < count; k++) {
      const bx = pool.cx + (rng() - 0.5) * pool.rx * 1.4, by = pool.cy + (rng() - 0.5) * pool.ry * 1.4;
      if (poolMask(pool, bx, by) > 0.72) continue;
      const rad = 2.5 + rng() * 4;
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
  for (let y = TOP_H; y < BOT_Y + 20; y++) {
    const L = beltLeft(y), R = beltRight(y);
    for (let x = 0; x < W; x++) {
      const depth = Math.max(L - x, x - R) + (valueNoise(x / 40, y / 40, SEED + 61) - 0.5) * 40;
      if (depth <= -10) continue;
      const fadeIn = smoothstep(TOP_H, TOP_H + 180, y); // no step under the copied village band
      const k = 1 - fadeIn * (1 - (1 - 0.26 * smoothstep(-10, 90, depth)) * (1 - 0.2 * smoothstep(90, 320, depth)));
      shadePixel(cv, x, y, k);
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Bands: the exact village edge at the top, the wasteland's first rows at the bottom.

function isWater(r, g, b) {
  const [h, s, v] = rgbToHsv(r, g, b);
  return h >= 175 && h <= 235 && s >= 0.3 && v >= 0.3;
}

function paintTopBand(cv, village) {
  const src = (x, vy) => (vy * village.w + x) * 3;
  // Mirror the band's last rows downward so the river runs on, then cut a wavy south bank.
  for (let x = 0; x < W; x++) {
    const by = bankY(x);
    for (let y = TOP_H; y < TOP_H + 40; y++) {
      const vy = 1085 - (y - TOP_H);
      const i = src(x, vy);
      const c = [village.data[i], village.data[i + 1], village.data[i + 2]];
      const a = smoothstep(by + 1.5, by - 1.5, y);
      if (a <= 0) continue;
      const water = isWater(c[0], c[1], c[2]);
      if (water && y > by - 3) { c[0] = lerp(c[0], 230, 0.35); c[1] = lerp(c[1], 245, 0.35); c[2] = lerp(c[2], 255, 0.35); }
      blendPixel(cv, x, y, c, a);
    }
    // A dark lip where the land meets the water.
    const wi = src(x, 1085 - Math.max(0, Math.floor(by - 2 - TOP_H)));
    if (isWater(village.data[wi], village.data[wi + 1], village.data[wi + 2])) {
      for (let k = 0; k < 4; k++) {
        const y = Math.ceil(by) + k;
        if (y < H) shadePixel(cv, x, y, lerp(0.55, 1, k / 4));
      }
    }
  }
  // Exact village pixels.
  for (let y = 0; y < TOP_H; y++) {
    for (let x = 0; x < W; x++) {
      const i = src(x, y + VILLAGE_OY), o = (y * W + x) * 3;
      cv[o] = village.data[i]; cv[o + 1] = village.data[i + 1]; cv[o + 2] = village.data[i + 2];
    }
  }
}

const seamY = (x) => BOT_Y + 8 + (fbm(x / 38, 9.1, SEED + 51, 3) - 0.5) * 18;

function paintBottomBand(cv, waste) {
  for (let y = BOT_Y - 12; y < H; y++) {
    const wy = y - BOT_Y;
    for (let x = 0; x < W; x++) {
      const a = smoothstep(seamY(x) - 3, seamY(x) + 3, y);
      if (a <= 0 || wy < 0) continue;
      const i = (wy * waste.w + x) * 3;
      blendPixel(cv, x, y, [waste.data[i], waste.data[i + 1], waste.data[i + 2]], a);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Props

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

/** Builds the list of prop instances: belts (procedural) + hand-placed gameplay props. */
function planProps(decay) {
  const rng = makeRng(SEED + 77);
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const props = [];
  const add = (kind, x, y, scale, opts = {}) => {
    const inst = {
      kind, x, y, scale,
      flip: opts.flip ?? rng() < 0.5,
      tint: opts.tint ?? [0.94 + rng() * 0.1, 0.94 + rng() * 0.1, 0.94 + rng() * 0.1],
      shift: opts.shift ?? (kind === 'rubbleS' ? PALE_ROCK : null), shiftK: opts.shift ? (opts.shiftK ?? 0) : kind === 'rubbleS' ? 1 : (opts.shiftK ?? 0),
      solid: opts.solid ?? PROP_DEFS[kind].solid,
      note: opts.note ?? kind,
      belt: opts.belt ?? false,
      id: opts.id ?? null,
    };
    props.push(inst);
    return inst;
  };

  /** Chooses a belt prop for the local decay value. */
  function beltKind(D) {
    if (D < 0.26) return pick(['tree', 'tree', 'bigtree', 'bush', 'tree', 'bigtree']);
    if (D < 0.4) return pick(['tree', 'bigtree', 'bush', 'deadcard', 'deadA', 'tree', 'deadE']);
    if (D < 0.62) return pick(['deadA', 'deadB', 'deadC', 'deadE', 'deadcard', 'deadB', 'deadS', 'deadC', 'rubbleS', 'rockpile']);
    if (rng() < 0.03) return 'debris';
    return pick(['rubbleL', 'rubbleE', 'deadC', 'deadA', 'deadB', 'rubbleL', 'deadE', 'deadB', 'rubbleE', 'deadC', 'deadA', 'rubbleS', 'wall2', 'carDark']);
  }
  // Keep the belt edge props off the gameplay spots (pickups, Mira, respawns, the satchel pool).
  const keepOut = [
    { x: SATCHEL.x, y: SATCHEL.y, r: 64 }, { x: MIRA.x, y: MIRA.y, r: 70 },
    { x: WATER_1.x, y: WATER_1.y, r: 60 }, { x: WATER_2.x, y: WATER_2.y, r: 60 },
    ...CHECKPOINTS.map((cp) => ({ x: cp.respawn.x, y: cp.respawn.y, r: 50 })),
    ...POOLS.map((pl) => ({ x: pl.cx, y: pl.cy, r: Math.max(pl.rx, pl.ry) + 20 })),
  ];
  const blockedSpot = (x, y, rad) => keepOut.some((k) => Math.hypot(x - k.x, y - k.y) < k.r + rad);

  // Belts: rows of props standing on and behind the corridor edges.
  for (const side of ['L', 'R']) {
    for (let y = TOP_H + 40; y < BOT_Y + 60; y += 40) {
      const edge = side === 'L' ? beltLeft(y) : beltRight(y);
      const maxDepth = side === 'L' ? edge + 60 : W - edge + 60;
      for (let depth = -6, row = 0; depth < maxDepth; depth += 56 + rng() * 14, row++) {
        const jy = y + (rng() - 0.5) * 26;
        const x = side === 'L' ? edge - depth + (rng() - 0.5) * 18 : edge + depth + (rng() - 0.5) * 18;
        if (x < -40 || x > W + 40) continue;
        const D = decay[clamp(Math.round(jy), 0, H - 1) * W + clamp(Math.round(x), 0, W - 1)];
        const kind = beltKind(D);
        const big = ['vanGrey', 'van', 'carDark'].includes(kind);
        const scale = (big ? 0.6 : 0.7) + rng() * 0.28;
        if (row < 2 && blockedSpot(x, jy, 55 * scale)) continue;
        if (row >= 3 && D > 0.4 && rng() < 0.35) continue; // deep belt: let the dark floor show a little
        const leafy = ['tree', 'bigtree', 'bush'].includes(kind);
        add(kind, x, jy + 50 * scale, scale, {
          belt: true,
          shift: leafy ? DYING_LEAVES : kind === 'rubbleS' ? PALE_ROCK : kind === 'rockpile' || kind.startsWith('rubble') ? ROCK_GREY : null,
          shiftK: leafy ? smoothstep(0.12, 0.4, D) : kind === 'rockpile' || kind === 'rubbleS' ? 1 : kind.startsWith('rubble') ? 0.45 : 0,
          note: `${side === 'L' ? 'west' : 'east'} belt ${kind}`,
        });
      }
    }
  }

  // Bank shrubs that hide the seam between the copied river and the generated meadow.
  for (const [x, y, k, s] of [[612, 352, 'bush', 0.6], [700, 346, 'bush', 0.55], [962, 348, 'bush', 0.58], [1056, 344, 'bush', 0.62], [1110, 352, 'tree', 0.66]]) {
    add(k, x, y, s, { note: 'river bank shrub' });
  }

  // Hand-placed gameplay props ------------------------------------------------
  // Near the bridge: the old milestone sign.
  add('signpost', 934, 410, 0.5, { id: 'milestone', flip: false, note: 'milestone sign' });
  // Lush meadow: a few trees and bushes to break up the open lawn.
  add('tree', 628, 500, 0.78, { note: 'meadow tree' });
  add('bigtree', 1078, 452, 0.72, { note: 'meadow tree' });
  add('bush', 592, 610, 0.58, { note: 'meadow bush' });
  add('tree', 984, 668, 0.7, { shift: DYING_LEAVES, shiftK: 0.75, note: 'yellowing tree' });
  // Where the green ends: the first dead tree.
  add('deadB', 812, 694, 0.82, { id: 'deadtree', flip: false, note: 'first dead tree' });
  // Cover around drone d1 (y 746).
  add('rockpile', 636, 812, 0.5, { shift: ROCK_GREY, shiftK: 0.8, note: 'cover rocks' });
  add('deadS', 648, 680, 0.9, { note: 'cover sapling' });
  add('rockpile', 948, 818, 0.46, { shift: ROCK_GREY, shiftK: 0.8, note: 'cover rocks' });
  add('deadA', 1060, 700, 0.66, { note: 'cover dead tree' });
  // Ash flats around the pools and drone d2 (y 990).
  add('deadC', 680, 926, 0.6, { note: 'dead tree' });
  add('rockpile', 950, 924, 0.44, { shift: ROCK_GREY, shiftK: 0.9, note: 'rocks' });
  add('rubbleS', 700, 1068, 0.62, { note: 'cover rubble' });
  add('deadE', 560, 1040, 0.68, { note: 'dead tree' });
  // Mira's field station.
  add('wall1', 962, 1040, 0.9, { id: 'outpost', flip: false, note: 'field station wall (plaque)' });
  add('wall2', 1080, 1026, 0.82, { flip: true, note: 'field station wall' });
  add('crates', 900, 1052, 0.62, { note: 'field station crates' });
  add('beacon', 1080, 1092, 0.5, { flip: false, note: 'field station beacon' });
  // The road: wrecks, a barricade and fire.
  add('carRed', 548, 1252, 0.8, { id: 'wreck', flip: false, note: 'wrecked car' });
  add('carDark', 800, 1252, 0.7, { note: 'wreck' });
  add('barricade', 760, 1352, 0.62, { note: 'barricade' });
  add('van', 548, 1376, 0.66, { note: 'wrecked van' });
  add('debris', 856, 1372, 0.5, { note: 'burning debris' });
  // Rubble hiding the seam where the wasteland's buildings are cut off.
  for (let x = 10 + rng() * 20; x < W; x += 38 + rng() * 34) {
    if (x > 540 && x < 780) continue;
    if (rng() < 0.4) add(pick(['deadA', 'deadC', 'deadE', 'deadB']), x + (rng() - 0.5) * 20, BOT_Y - 6 + rng() * 22, 0.6 + rng() * 0.3, { belt: true, note: 'seam dead tree' });
    add(pick(['rubbleL', 'rubbleE', 'rubbleS', 'rubbleL', 'deadC', 'rockpile']), x + (rng() - 0.5) * 16, BOT_Y + 22 + rng() * 34, 0.56 + rng() * 0.32, { belt: true, shift: ROCK_GREY, shiftK: 0.4, note: 'seam rubble' });
  }
  for (const [x, s] of [[560, 0.6], [770, 0.58]]) add('rubbleS', x, BOT_Y + 30, s, { note: 'rubble by the road' });

  // Flat decals (no collider): flowers in the lush meadow.
  for (let i = 0; i < 34; i++) {
    const y = TOP_H + 60 + rng() * 300;
    const x = beltLeft(y) + 40 + rng() * (beltRight(y) - beltLeft(y) - 80);
    if (decay[Math.round(y) * W + Math.round(x)] > 0.16) continue;
    if (pathDistance(x, y) < pathHalfWidth(y) + 10) continue;
    add('flowers', x, y, 0.3 + rng() * 0.18, { solid: false, note: 'flowers' });
  }
  return props;
}

async function paintProps(cv, props) {
  const bases = {};
  for (const name of new Set(props.map((p) => p.kind))) bases[name] = await loadPropBase(name, PROP_DEFS[name]);
  const cache = new Map();
  // Decals first, then everything else from back (north) to front (south).
  const order = [...props].sort((a, b) => (a.solid === b.solid ? a.y - b.y : a.solid ? 1 : -1));
  for (const inst of order) {
    const def = PROP_DEFS[inst.kind];
    const sprite = await getSprite(cache, bases, inst.kind, Math.round(inst.scale * 20) / 20, inst.flip);
    const left = Math.round(inst.x - sprite.w / 2), top = Math.round(inst.y - sprite.h);
    if (def.shadow > 0) {
      const f = sprite.foot;
      drawShadow(cv, left + f.x + f.w / 2, top + f.y + f.h - 4, f.w * 0.5, Math.max(6, f.h * 0.16), 0.32 * def.shadow);
    }
    inst.foot = drawSprite(cv, sprite, inst.x, inst.y, inst);
  }
}

// ---------------------------------------------------------------------------
// 4. Colour grade + vignette (leaves the copied village band untouched)

function gradeAndVignette(cv) {
  for (let y = TOP_H; y < H; y++) {
    const t = smoothstep(TOP_H + 30, BOT_Y + 40, y);
    const fadeIn = smoothstep(TOP_H, TOP_H + 120, y);
    const desat = 0.2 * t;
    const tint = [1 + 0.03 * t, 1 - 0.015 * t, 1 - 0.07 * t];
    const dark = 1 - 0.05 * t;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      let r = cv[i], g = cv[i + 1], b = cv[i + 2];
      const lum = 0.3 * r + 0.59 * g + 0.11 * b;
      r = lerp(r, lum, desat) * tint[0] * dark;
      g = lerp(g, lum, desat) * tint[1] * dark;
      b = lerp(b, lum, desat) * tint[2] * dark;
      const vx = Math.abs(x - W / 2) / (W / 2);
      const v = 1 - 0.2 * smoothstep(0.6, 1.0, vx) * fadeIn;
      // Blend the grade in gently below the band so there is no visible step.
      cv[i] = lerp(cv[i], r * v, fadeIn);
      cv[i + 1] = lerp(cv[i + 1], g * v, fadeIn);
      cv[i + 2] = lerp(cv[i + 2], b * v, fadeIn);
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Map data

const rectInt = (r) => {
  const x0 = clamp(Math.floor(r.x), 0, W), y0 = clamp(Math.floor(r.y), 0, H);
  const x1 = clamp(Math.ceil(r.x + r.w), 0, W), y1 = clamp(Math.ceil(r.y + r.h), 0, H);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

function buildColliders(props) {
  const out = [...BAND_COLLIDERS];

  // River south of the band: from the band's bottom row down to the bank (+ a little lip),
  // in 48 px columns, leaving the trail off the bridge (x 789-893) open.
  for (let x0 = 0; x0 < W; x0 += 48) {
    const x1 = Math.min(W, x0 + 48);
    const segs = [[x0, Math.min(x1, 789)], [Math.max(x0, 893), x1]].filter(([a, b]) => b > a);
    for (const [a, b] of segs) {
      let maxBank = 0;
      for (let x = a; x < b; x++) maxBank = Math.max(maxBank, bankY(x));
      out.push({ x: a, y: TOP_H, w: b - a, h: Math.ceil(maxBank + 3 - TOP_H), note: 'river (south part)' });
    }
  }

  // Belts: horizontal strips from the map edge to the belt's inner edge line.
  const STRIP = 24;
  for (let y = TOP_H; y < BOT_Y; y += STRIP) {
    const h = Math.min(STRIP, BOT_Y - y);
    let L = Infinity, R = -Infinity;
    for (let yy = y; yy <= y + h; yy += 4) { L = Math.min(L, beltLeft(yy)); R = Math.max(R, beltRight(yy)); }
    out.push({ x: 0, y, w: Math.round(L), h, note: 'west belt (dead forest / rubble)' });
    out.push({ x: Math.round(R), y, w: W - Math.round(R), h, note: 'east belt (dead forest / rubble)' });
  }

  out.push(...BOTTOM_COLLIDERS);

  // Every solid prop's drawn footprint, unless a belt strip already covers it.
  for (const p of props) {
    if (!p.solid || !p.foot) continue;
    const f = p.foot;
    const insideLeft = f.x + f.w <= beltLeft(f.y) - 2 && f.x + f.w <= beltLeft(f.y + f.h) - 2;
    const insideRight = f.x >= beltRight(f.y) + 2 && f.x >= beltRight(f.y + f.h) + 2;
    const insideBottom = f.y >= BOT_Y && (f.x + f.w <= 590 || f.x >= 724);
    const insideTop = f.y + f.h <= TOP_H;
    if (insideLeft || insideRight || insideBottom || insideTop) continue;
    out.push({ ...f, note: p.note });
  }
  return out.map((r) => ({ ...rectInt(r), note: r.note })).filter((r) => r.w > 0 && r.h > 0);
}

function buildMapData(props) {
  const colliders = buildColliders(props);
  const insp = (id, dialogue) => {
    const p = props.find((q) => q.id === id);
    const f = p.foot;
    return { id, ...rectInt(f), dialogue };
  };
  const hazards = POOLS.map((pool) => {
    // The hazard is the blob's solid core (a little inside the drawn edge).
    const kx = 0.82, ky = 0.8; // corners stay on the sludge, not on dry ground
    return { type: 'toxic', ...rectInt({ x: pool.cx - pool.rx * kx, y: pool.cy - pool.ry * ky, w: pool.rx * kx * 2, h: pool.ry * ky * 2 }) };
  });
  const exitCentre = { x: EXIT_ZONE.x + EXIT_ZONE.w / 2, y: EXIT_ZONE.y + EXIT_ZONE.h / 2 };
  return {
    image: 'map-outskirts',
    width: W,
    height: H,
    area: 'The Outskirts',
    spawn: SPAWN,
    colliders,
    occluders: [],
    npcs: [MIRA],
    pickups: [SATCHEL, WATER_1, WATER_2],
    inspectables: [
      insp('milestone', 'inspect-milestone'),
      insp('deadtree', 'inspect-deadtree'),
      insp('outpost', 'inspect-outpost'),
      insp('wreck', 'inspect-wreck'),
    ],
    zones: [GATE_ZONE, EXIT_ZONE],
    hazards,
    checkpoints: CHECKPOINTS,
    drones: DRONES,
    crawlers: [],
    markers: {
      outskirts: { x: MIRA.x, y: MIRA.y },
      satchel: { x: SATCHEL.x, y: SATCHEL.y },
      to_city: exitCentre,
    },
  };
}

// ---------------------------------------------------------------------------
// 6. Verification (same flood-fill pattern as tools/assets/maps.mjs)

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

function floodFill(rects, start) {
  const bodyFree = buildBodyFree(rects);
  const reached = new Uint8Array(GW * GH);
  const sx = Math.round(start.x / GRID), sy = Math.round(start.y / GRID);
  if (!bodyFree(sx * GRID, sy * GRID)) return { reached, startFree: false, count: 0 };
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
      if (reached[n] || !bodyFree(nx * GRID, ny * GRID)) continue;
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

/** Drone position and heading at time t (ping-pong unless loop). */
function droneState(drone, t) {
  const pts = drone.loop ? [...drone.path, drone.path[0]] : drone.path;
  const segs = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const len = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    segs.push({ a: pts[i], b: pts[i + 1], len });
    total += len;
  }
  let s = (t * drone.speed) % (drone.loop ? total : total * 2);
  let dir = 1;
  if (!drone.loop && s > total) { s = total * 2 - s; dir = -1; }
  for (const seg of segs) {
    if (s <= seg.len || seg === segs[segs.length - 1]) {
      const k = clamp(s / seg.len, 0, 1);
      const x = lerp(seg.a.x, seg.b.x, k), y = lerp(seg.a.y, seg.b.y, k);
      const hx = (seg.b.x - seg.a.x) / seg.len * dir, hy = (seg.b.y - seg.a.y) / seg.len * dir;
      return { x, y, hx, hy, period: drone.loop ? total / drone.speed : (2 * total) / drone.speed };
    }
    s -= seg.len;
  }
  return null;
}

/**
 * Stealth check for one drone: a space-time search on a 6 px grid. The player (90 px/s) starts
 * anywhere north of the drone's patrol band and must reach the band south of it without ever
 * standing in the cone. The cone is modelled generously (100 px, +-40 deg, colliders block sight).
 */
function stealthCheck(drone, rects, blocked) {
  const CELL = 6, SPEED = 90, DT = CELL / SPEED, RANGE = 100, HALF = (40 * Math.PI) / 180;
  const ys = drone.path.map((p) => p.y), xs = drone.path.map((p) => p.x);
  const y0 = Math.min(...ys) - RANGE - 40, y1 = Math.max(...ys) + RANGE + 40;
  const x0 = Math.max(0, Math.min(...xs) - 260), x1 = Math.min(W, Math.max(...xs) + 260);
  const cw = Math.ceil((x1 - x0) / CELL), ch = Math.ceil((y1 - y0) / CELL);
  const bodyFree = buildBodyFree(rects);
  const free = new Uint8Array(cw * ch);
  for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) free[j * cw + i] = bodyFree(Math.round(x0 + i * CELL), Math.round(y0 + j * CELL)) ? 1 : 0;

  const los = (ax, ay, bx, by) => {
    const n = Math.ceil(Math.hypot(bx - ax, by - ay) / 3);
    for (let k = 1; k < n; k++) {
      const x = Math.round(lerp(ax, bx, k / n)), y = Math.round(lerp(ay, by, k / n));
      if (x >= 0 && y >= 0 && x < W && y < H && blocked[y * W + x]) return false;
    }
    return true;
  };
  const seen = (fx, fy, st) => {
    const px = fx, py = fy - 5;
    const dx = px - st.x, dy = py - st.y, d = Math.hypot(dx, dy);
    if (d > RANGE) return false;
    if (d > 1 && Math.acos(clamp((dx * st.hx + dy * st.hy) / d, -1, 1)) > HALF) return false;
    return los(st.x, st.y, px, py);
  };

  const period = droneState(drone, 0).period;
  const steps = Math.ceil((period * 2.2) / DT);
  // Each time step the player moves at most one cell (CELL px in DT seconds = 90 px/s) or waits.
  let cur = new Uint8Array(cw * ch);
  // Start: free cells in the northern strip that are not seen at t = 0.
  const st0 = droneState(drone, 0);
  for (let j = 0; j < 6; j++) for (let i = 0; i < cw; i++) {
    const idx = j * cw + i;
    if (free[idx] && !seen(x0 + i * CELL, y0 + j * CELL, st0)) cur[idx] = 1;
  }
  const isGoal = (j) => j >= ch - 6;
  let exposureFree = false;
  let crossedAt = -1;
  for (let s = 1; s <= steps && !exposureFree; s++) {
    const st = droneState(drone, s * DT);
    const next = new Uint8Array(cw * ch);
    for (let j = 0; j < ch; j++) {
      for (let i = 0; i < cw; i++) {
        if (!cur[j * cw + i]) continue;
        for (const [di, dj] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ni = i + di, nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= cw || nj >= ch) continue;
          const n = nj * cw + ni;
          if (next[n] || !free[n]) continue;
          if (seen(x0 + ni * CELL, y0 + nj * CELL, st)) continue;
          next[n] = 1;
          if (isGoal(nj)) { exposureFree = true; crossedAt = s * DT; }
        }
      }
    }
    // Waiting in the safe northern strip is always allowed (the player can time the approach).
    for (let j = 0; j < 6; j++) for (let i = 0; i < cw; i++) {
      const idx = j * cw + i;
      if (free[idx] && !seen(x0 + i * CELL, y0 + j * CELL, st)) next[idx] = 1;
    }
    cur = next;
  }
  return { pass: exposureFree, detail: exposureFree ? `unseen crossing found (${crossedAt.toFixed(1)} s into a ${period.toFixed(1)} s patrol)` : 'no unseen crossing' };
}

function verify(map) {
  const out = [];
  const gate = map.zones.find((z) => z.id === 'gate');
  const exit = map.zones.find((z) => z.id === 'exit');
  const colliders = map.colliders;

  // Schema basics.
  const isRect = (r) => ['x', 'y', 'w', 'h'].every((k) => Number.isInteger(r[k])) && r.w > 0 && r.h > 0 && r.x >= 0 && r.y >= 0 && right(r) <= W && bottom(r) <= H;
  const bad = [];
  for (const key of ['colliders', 'inspectables', 'zones', 'hazards', 'checkpoints']) map[key].forEach((r, i) => { if (!isRect(r)) bad.push(`${key}[${i}]`); });
  out.push(check('all rects are positive integers inside the map', bad.length === 0, bad.slice(0, 6).join(', ')));
  out.push(check('occluders list is empty', map.occluders.length === 0));
  out.push(check('map height is 1400-2000', H >= 1400 && H <= 2000, `${W}x${H}`));
  out.push(check('ids: npc mira, pickups os-satchel/os-water-1/os-water-2',
    map.npcs.some((n) => n.id === 'mira' && n.sprite === 'mira' && n.name === 'Mira' && n.dialogue === 'mira' && n.facing === 'down') &&
    ['os-satchel', 'os-water-1', 'os-water-2'].every((id) => map.pickups.some((p) => p.id === id))));
  out.push(check('inspectables milestone/deadtree/outpost/wreck', ['milestone', 'deadtree', 'outpost', 'wreck'].every((id) => map.inspectables.some((r) => r.id === id && r.dialogue === `inspect-${id}`))));
  out.push(check('2-3 toxic hazards', map.hazards.length >= 2 && map.hazards.length <= 3 && map.hazards.every((h) => h.type === 'toxic'), `${map.hazards.length}`));
  out.push(check('2-3 drones', map.drones.length >= 2 && map.drones.length <= 3, `${map.drones.length}`));
  out.push(check('markers outskirts/satchel/to_city', ['outskirts', 'satchel', 'to_city'].every((k) => map.markers[k])));

  const solid = floodFill([...colliders, gate], map.spawn);           // normal play: the gate pushes you back
  const noGate = floodFill(colliders, map.spawn);                       // even if the gate trigger failed
  const safe = floodFill([...colliders, gate, ...map.hazards], map.spawn); // never stepping in sludge
  out.push(check('spawn is on free ground', solid.startFree, `(${map.spawn.x}, ${map.spawn.y})`));
  out.push(check('reachable area', solid.count > 0, `${Math.round((solid.count * GRID * GRID) / 1000)}k px^2`));

  // Clearances for NPCs and pickups.
  for (const a of [...map.npcs, ...map.pickups]) {
    const nearest = colliders.reduce((best, c) => (pointRectDistance(a.x, a.y, c) < pointRectDistance(a.x, a.y, best) ? c : best));
    const clear = pointRectDistance(a.x, a.y, nearest);
    const edge = Math.min(a.x, a.y, W - a.x, H - a.y);
    out.push(check(`${a.id}: ${CLEARANCE}+ px from colliders, ${EDGE_CLEARANCE}+ px from edges`, clear >= CLEARANCE && edge >= EDGE_CLEARANCE,
      `${clear.toFixed(1)} px (${nearest.note}) / edge ${edge} px`));
    const d = nearestReached(solid.reached, a.x, a.y, INTERACT_RADIUS + 4);
    out.push(check(`${a.id}: reachable from spawn (within ${INTERACT_RADIUS} px)`, d <= INTERACT_RADIUS, `${d.toFixed(1)} px`));
  }
  for (const r of map.inspectables) {
    const sides = reachableSides(solid.reached, r, INTERACT_RADIUS - 4);
    out.push(check(`inspectable ${r.id}: a side is reachable`, sides.length > 0, `sides ${sides.join('') || 'none'}`));
  }
  for (const cp of map.checkpoints) {
    const inside = someReached(solid.reached, cp, (fx, fy) => rectsOverlap(bodyAt(fx, fy), cp));
    const respawnOk = nearestReached(solid.reached, cp.respawn.x, cp.respawn.y, 3) <= 2;
    const rb = bodyAt(cp.respawn.x, cp.respawn.y);
    const hit = colliders.find((c) => rectsOverlap(c, rb));
    out.push(check(`checkpoint ${cp.id}: reachable, respawn on walkable ground`, inside && respawnOk, hit ? `respawn inside ${hit.note}` : ''));
  }
  out.push(check('checkpoint os-cp-1 contains the spawn', map.spawn.x >= map.checkpoints[0].x && map.spawn.x <= right(map.checkpoints[0]) && map.spawn.y >= map.checkpoints[0].y && map.spawn.y <= bottom(map.checkpoints[0])));

  // Exit and gate.
  const touches = (zone) => (fx, fy) => rectsOverlap(bodyAt(fx, fy), zone);
  const grow = (z, m) => ({ x: z.x - m, y: z.y - m, w: z.w + 2 * m, h: z.h + 2 * m });
  out.push(check('exit: reachable from spawn', someReached(solid.reached, grow(exit, 20), touches(exit))));
  out.push(check('exit: on the bottom edge', bottom(exit) === H));
  out.push(check('gate: player can walk up to it from the bridge', someReached(solid.reached, grow(gate, 12), (fx, fy) => fy >= bottom(gate) + BODY_H && fy <= bottom(gate) + BODY_H + 4 && fx > gate.x && fx < right(gate))));
  const north = (r) => someReached(r.reached, { x: 0, y: 0, w: W, h: gate.y }, () => true);
  out.push(check('gate: blocks the way north (nothing north of it is reachable)', !north(solid)));
  out.push(check('gate: village stays sealed even without the gate trigger', !someReached(noGate.reached, { x: 0, y: 0, w: W, h: 60 }, () => true)));

  // Sealing.
  for (const [name, fill] of [['gate solid', solid], ['gate open', noGate]]) {
    const edges = edgeTouches(fill.reached).filter((p) => !(p.y >= exit.y && p.x >= exit.x && p.x <= right(exit)));
    out.push(check(`sealed (${name}): only the exit reaches a map edge`, edges.length === 0, edges.slice(0, 4).map((p) => `${p.x},${p.y}`).join(' ')));
  }

  // Hazard-free routes.
  out.push(check('hazard-free route: spawn -> Mira', nearestReached(safe.reached, map.npcs[0].x, map.npcs[0].y, INTERACT_RADIUS + 4) <= INTERACT_RADIUS));
  out.push(check('hazard-free route: spawn -> exit', someReached(safe.reached, grow(exit, 20), touches(exit))));
  for (const p of map.pickups) {
    if (p.id === 'os-satchel') continue;
    out.push(check(`hazard-free route: spawn -> ${p.id}`, nearestReached(safe.reached, p.x, p.y, INTERACT_RADIUS + 4) <= INTERACT_RADIUS));
  }
  const sat = map.pickups.find((p) => p.id === 'os-satchel');
  const satSafe = nearestReached(safe.reached, sat.x, sat.y, INTERACT_RADIUS + 4);
  const inPool = map.hazards.some((h) => pointRectDistance(sat.x, sat.y, h) === 0);
  out.push(check('satchel: only reachable by wading into a toxic pool', satSafe > INTERACT_RADIUS && inPool, `nearest dry ground ${satSafe === Infinity ? '> 32' : satSafe.toFixed(1)} px`));
  for (const r of map.inspectables) {
    const sides = reachableSides(safe.reached, r, INTERACT_RADIUS - 4);
    out.push(check(`hazard-free route: spawn -> inspectable ${r.id}`, sides.length > 0));
  }

  // Drones: safe respawns and a readable way past each one.
  const blocked = buildBlocked(colliders);
  for (const d of map.drones) {
    const minD = Math.min(...map.checkpoints.map((cp) => {
      let best = Infinity;
      for (let t = 0; t < droneState(d, 0).period; t += 0.25) {
        const s = droneState(d, t);
        best = Math.min(best, Math.hypot(s.x - cp.respawn.x, s.y - cp.respawn.y));
      }
      return best;
    }));
    out.push(check(`drone ${d.id}: never within 130 px of a respawn point`, minD >= 130, `${minD.toFixed(0)} px`));
    const npcD = Math.min(...map.npcs.map((n) => Math.min(...d.path.map((p) => Math.hypot(p.x - n.x, p.y - n.y)))));
    out.push(check(`drone ${d.id}: patrol keeps 120+ px from Mira`, npcD >= 120, `${npcD.toFixed(0)} px`));
    const s = stealthCheck(d, colliders, blocked);
    out.push(check(`drone ${d.id}: can be passed unseen by timing/cover`, s.pass, s.detail));
  }
  return { checks: out, solid, safe };
}

// ---------------------------------------------------------------------------
// 7. Previews

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const label = (x, y, text, color, size = 11) =>
  `<text x="${x}" y="${y}" font-family="Menlo, monospace" font-size="${size}" fill="${color}" stroke="#000" stroke-width="2.5" paint-order="stroke">${esc(text)}</text>`;

function overlaySvg(map) {
  const p = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`];
  for (const c of map.colliders) p.push(`<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" fill="#ff2020" fill-opacity="0.32" stroke="#ff2020" stroke-opacity="0.85" stroke-width="1"/>`);
  for (const h of map.hazards) p.push(`<rect x="${h.x}" y="${h.y}" width="${h.w}" height="${h.h}" fill="#30ff40" fill-opacity="0.35" stroke="#30ff40" stroke-width="2"/>`);
  for (const z of map.zones) {
    p.push(`<rect x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" fill="#ff00ff" fill-opacity="0.35" stroke="#ff00ff" stroke-width="2"/>`);
    p.push(label(z.x + 3, z.y + z.h / 2 + 4, z.id, '#ff80ff'));
  }
  for (const cp of map.checkpoints) {
    p.push(`<rect x="${cp.x}" y="${cp.y}" width="${cp.w}" height="${cp.h}" fill="none" stroke="#ffffff" stroke-width="2" stroke-dasharray="5 3"/>`);
    p.push(`<circle cx="${cp.respawn.x}" cy="${cp.respawn.y}" r="4" fill="#ffffff" stroke="#000"/>`);
    p.push(label(cp.x + 2, cp.y - 4, cp.id, '#ffffff'));
  }
  for (const r of map.inspectables) {
    p.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="none" stroke="#ffe030" stroke-width="2" stroke-dasharray="3 2"/>`);
    p.push(label(r.x, r.y - 4, `inspect:${r.id}`, '#ffe860'));
  }
  for (const d of map.drones) {
    const pts = d.path.map((q) => `${q.x},${q.y}`).join(' ');
    p.push(`<polyline points="${pts}${d.loop ? ` ${d.path[0].x},${d.path[0].y}` : ''}" fill="none" stroke="#3ad4e8" stroke-width="3"/>`);
    // Cones at both ends of each leg, facing along it.
    for (let i = 0; i < d.path.length - 1 + (d.loop ? 1 : 0); i++) {
      const a = d.path[i], b = d.path[(i + 1) % d.path.length];
      for (const [o, t] of [[a, b], [b, a]]) {
        const ang = Math.atan2(t.y - o.y, t.x - o.x), half = (25 * Math.PI) / 180, R = 95;
        const p1 = [o.x + Math.cos(ang - half) * R, o.y + Math.sin(ang - half) * R];
        const p2 = [o.x + Math.cos(ang + half) * R, o.y + Math.sin(ang + half) * R];
        p.push(`<path d="M${o.x},${o.y} L${p1[0]},${p1[1]} A${R},${R} 0 0 1 ${p2[0]},${p2[1]} Z" fill="#3ad4e8" fill-opacity="0.22" stroke="#3ad4e8" stroke-width="1"/>`);
      }
    }
    p.push(label(d.path[0].x - 10, d.path[0].y - 8, d.id, '#3ad4e8'));
  }
  for (const n of map.npcs) {
    p.push(`<circle cx="${n.x}" cy="${n.y}" r="6" fill="#ffe030" stroke="#000" stroke-width="1.5"/>`);
    p.push(label(n.x + 8, n.y - 6, n.name, '#ffe860'));
  }
  for (const q of map.pickups) {
    p.push(`<circle cx="${q.x}" cy="${q.y}" r="6" fill="#ff9a1a" stroke="#000" stroke-width="1.5"/>`);
    p.push(label(q.x + 8, q.y + 4, q.id, '#ffb050'));
  }
  p.push(`<circle cx="${map.spawn.x}" cy="${map.spawn.y}" r="6" fill="#ffffff" stroke="#000"/>`);
  p.push(label(map.spawn.x + 8, map.spawn.y + 4, 'spawn', '#ffffff'));
  for (const [k, m] of Object.entries(map.markers)) {
    p.push(`<path d="M${m.x},${m.y - 7} L${m.x + 7},${m.y} L${m.x},${m.y + 7} L${m.x - 7},${m.y} Z" fill="none" stroke="#fff200" stroke-width="2"/>`);
    p.push(label(m.x - 20, m.y + 20, `marker:${k}`, '#fff200', 10));
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

async function main() {
  const args = process.argv.slice(2);
  const debugDir = args.includes('--debug') ? args[args.indexOf('--debug') + 1] : null;
  const t0 = Date.now();

  const village = await loadRaw(RAW('village-map.png'));
  const waste = await loadRaw(RAW('wasteland-map.png'));
  const maps = { village, wasteland: waste };

  // Texture samplers.
  const toxicSrc = { ...SOURCES.toxic, at: findWindows(waste, SOURCES.toxic.search, SOURCES.toxic.size, isSludge, 0.3) };
  const q = (name, src, opts) => makeQuilt(maps[src.map], src, opts);
  const lawn = q('lawn', SOURCES.lawn, { cell: 24, seed: SEED + 100 });
  const flowerLawn = q('flowerLawn', SOURCES.flowerLawn, { cell: 24, seed: SEED + 200 });
  const dirt = q('dirt', SOURCES.dirt, { cell: 27, seed: SEED + 300 });
  const asphalt = q('asphalt', SOURCES.asphalt, { cell: 30, seed: SEED + 400 });
  const villagePath = q('path', SOURCES.path, { cell: 16, warp: 3, seed: SEED + 500 });
  const toxic = q('toxic', toxicSrc, { cell: 15, warp: 3, seed: SEED + 600 });
  const tmp = [0, 0, 0];
  /** Trail texture: village dirt, getting dusty, then road asphalt. */
  const pathTex = (x, y, out) => {
    const toRoad = smoothstep(1030, 1110, y + (valueNoise(x / 20, y / 20, SEED + 12) - 0.5) * 50);
    villagePath(x, y, out);
    shiftColor(out, smoothstep(430, 960, y), DUSTY_PATH);
    if (toRoad > 0) {
      asphalt(x, y, tmp);
      out[0] = lerp(out[0], tmp[0], toRoad); out[1] = lerp(out[1], tmp[1], toRoad); out[2] = lerp(out[2], tmp[2], toRoad);
    }
    return out;
  };

  // Decay field.
  const decay = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) decay[y * W + x] = decayAt(x, y);

  const cv = makeCanvas();
  paintGround(cv, maps, { lawn, flowerLawn, dirt, asphalt, pathTex, toxic }, decay);
  paintPools(cv, sludgePalette(waste));
  paintBottomBand(cv, waste);
  paintTopBand(cv, village);
  const props = planProps(decay);
  await paintProps(cv, props);
  shadeBelts(cv);
  gradeAndVignette(cv);
  console.log(`Painted ${W}x${H} with ${props.length} props in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  const rgb = Buffer.alloc(W * H * 3);
  for (let i = 0; i < rgb.length; i++) rgb[i] = clamp(Math.round(cv[i]), 0, 255);
  await fs.mkdir(path.dirname(OUT_PNG), { recursive: true });
  await sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).png({ compressionLevel: 9 }).toFile(OUT_PNG);

  // Data.
  const map = buildMapData(props);
  await fs.mkdir(path.dirname(OUT_JSON), { recursive: true });
  await fs.writeFile(OUT_JSON, `${JSON.stringify(map, null, 2)}\n`);
  console.log(`Wrote ${path.relative(ROOT, OUT_PNG)} and ${path.relative(ROOT, OUT_JSON)} (${map.colliders.length} colliders)`);

  // Checks.
  const { checks, solid, safe } = verify(map);
  printResults('Outskirts checks (player body 16x10, grid 2 px)', checks);

  // Previews.
  await fs.mkdir(path.dirname(PREVIEW_SMALL), { recursive: true });
  await sharp(OUT_PNG).resize({ height: 700 }).png().toFile(PREVIEW_SMALL);
  await sharp(OUT_PNG).composite([{ input: Buffer.from(overlaySvg(map)) }]).png({ compressionLevel: 9 }).toFile(PREVIEW_OVERLAY);
  console.log(`\nPreviews: ${path.relative(ROOT, PREVIEW_SMALL)}, ${path.relative(ROOT, PREVIEW_OVERLAY)}`);

  if (debugDir) {
    await fs.mkdir(debugDir, { recursive: true });
    await sharp(OUT_PNG)
      .composite([reachLayer(solid.reached, [0, 230, 255, 110]), reachLayer(safe.reached, [255, 140, 0, 60])])
      .png().toFile(path.join(debugDir, 'outskirts-reach.png'));
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

// tools/assets/creatures.mjs
//
// Draws the Milestone 2 creatures and effect textures procedurally, pixel by pixel:
//   public/assets/creatures/drone.png     128x32  Warden drone, 4 frames of 32x32 (hover bob + eye pulse)
//   public/assets/creatures/crawler.png   192x24  nanite crawler, 6 frames of 32x24 (0-3 scuttle, 4-5 hurt)
//   public/assets/fx/fx-*.png             small particle, slash, glow and cone textures
// plus a visual check sheet at tools/previews/creatures.png.
//
// Run from the project root:   node tools/assets/creatures.mjs
// Nothing is read from raw-assets/. The preview only reads a map crop and nomad.png for scale.
//
// Style rules (matching the character sheets): 1 px dark outline, 3-4 tone shading lit from
// the top-left, muted base colours with glowing accents (cyan for the Warden, magenta for nanites).

import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';

const CREATURES_DIR = 'public/assets/creatures';
const FX_DIR = 'public/assets/fx';
const PREVIEW_FILE = 'tools/previews/creatures.png';
const PREVIEW_BG = '#1a1d27';
const ZOOM = 6;

// ---------------------------------------------------------------------------
// Colour + canvas helpers
// ---------------------------------------------------------------------------

/** '#rrggbb' -> [r, g, b, a]. Arrays are passed through unchanged. */
function rgba(color, alpha = 255) {
  if (Array.isArray(color)) return color;
  const n = parseInt(color.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, alpha];
}

/** A small RGBA pixel buffer with just the drawing operations the art below needs. */
class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.data = new Uint8ClampedArray(w * h * 4);
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
    const c = rgba(color);
    this.data.set(c, (y * this.w + x) * 4);
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
    for (let k = 0; k < 3; k++) {
      const s = [r, g, b][k];
      d[i + k] = Math.round((s * sa + d[i + k] * da * (1 - sa)) / oa);
    }
    d[i + 3] = Math.round(oa * 255);
  }

  /** Paint another canvas over this one with its top-left at (ox, oy). */
  paste(src, ox = 0, oy = 0) {
    for (let y = 0; y < src.h; y++) {
      for (let x = 0; x < src.w; x++) this.blend(x + ox, y + oy, src.get(x, y));
    }
    return this;
  }

  /** A copy flipped left <-> right. */
  mirrored() {
    const out = new Canvas(this.w, this.h);
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) out.set(this.w - 1 - x, y, this.get(x, y));
    }
    return out;
  }

  /** A copy where every pixel is replaced by fn(rgba, x, y). */
  map(fn) {
    const out = new Canvas(this.w, this.h);
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) out.set(x, y, fn(this.get(x, y), x, y));
    }
    return out;
  }
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

/** 1 px Bresenham line between two pixel positions. */
function line(c, x0, y0, x1, y1, color) {
  [x0, y0, x1, y1] = [x0, y0, x1, y1].map(Math.round);
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    c.set(x0, y0, color);
    if (x0 === x1 && y0 === y1) return;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
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

/** A copy of `c` with a 1 px outline around every opaque pixel (4-neighbour, like the character art). */
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

// Small vector maths for the shading.
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const normalize = (v) => {
  const len = Math.hypot(...v);
  return v.map((k) => k / len);
};
const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

// One light for everything: from the top-left, slightly toward the viewer.
const LIGHT = normalize([-0.55, -0.75, 0.65]);

/** Pick a palette tone from a brightness value using ascending thresholds. */
function tone(value, thresholds, tones) {
  let i = 0;
  while (i < thresholds.length && value > thresholds[i]) i++;
  return tones[i];
}

/** Sheet canvas made of frames laid out left to right. */
function sheet(frames) {
  const out = new Canvas(frames[0].w * frames.length, frames[0].h);
  frames.forEach((f, i) => out.paste(f, i * f.w, 0));
  return out;
}

// ---------------------------------------------------------------------------
// Warden drone: 4 frames of 32x32
// ---------------------------------------------------------------------------

const DRONE_SIZE = 32;
const DRONE_BOB = [0, -1, -2, -1];   // hover offset per frame (px)
const DRONE_PULSE = [0, 1, 2, 0];    // eye brightness level per frame

const DRONE = {
  outline: '#161922',
  cap: ['#4f5a6e', '#8794a8', '#c0c9d6', '#e6ebf2'],   // white upper shell, dark -> light
  capSpec: '#fbfdff',
  belly: ['#2f3747', '#4e5a6f', '#76839a', '#9ca8bb'], // silver lower shell, dark -> light
  bellyRim: '#3f8fa2',                                 // cyan bounce light from the under-glow
  seam: '#262c3a',
  socket: ['#10131b', '#123a46', '#1a5c6c'],           // lens rim, per pulse level
  lens: [                                             // per pulse level: edge, body, core
    ['#1b7286', '#3ad4e8', '#8ce8f4'],
    ['#27a0b6', '#62e2f2', '#c2f7fc'],
    ['#3ad4e8', '#93f1fa', '#effeff'],
  ],
  glint: '#ffffff',
  sigil: '#a6c4d6',
  sigilCore: '#86d6e8',
  glow: '#3ad4e8',
  glowCore: '#a8f2fb',
};

// The drone's own "up" axis leans toward the camera (top-down 3/4 view), and the lens looks
// forward and a little down. Both are unit vectors in view space (x right, y down, z to viewer).
const DRONE_UP = normalize([0, -0.77, 0.64]);
const DRONE_LENS_DIR = normalize([0, 0.42, 0.91]);
const LENS_RADIUS = 0.47;   // lens angular radius (radians), about 9 px across
const SOCKET_WIDTH = 0.17;  // dark rim around the lens
const SEAM_LEVEL = 0.2;     // shell parting line: dot(normal, up) above this is the white cap

// Six-petal Warden sigil (the snowflake-flower of the village banners), foreshortened on the cap.
const SIGIL = [
  '...ss...',
  '.s.ss.s.',
  '..sccs..',
  '.s.ss.s.',
  '...ss...',
];

// Left side fin (the right one is its mirror). Column 6 tucks under the orb.
// Swept up and outward, lit on top, with a small cyan running light near the tip.
const FIN = [
  'aa.....',
  'abbbb..',
  '.kbbccc',
  '..ccddd',
  '...dd..',
];

/** Soft cyan pool of light on the ground under the hovering drone (no outline). */
function drawUnderGlow(c, cx, cy, pulse, lift) {
  const rx = 8.6 - lift * 0.4;
  const ry = 2.7;
  eachInEllipse(cx, cy, rx, ry, (x, y, nx, ny) => {
    const d = Math.sqrt(nx * nx + ny * ny);
    const a = Math.pow(1 - d * d, 1.4) * (0.48 + 0.06 * pulse - 0.03 * lift);
    c.blend(x, y, rgba(d < 0.4 ? DRONE.glowCore : DRONE.glow, Math.round(255 * a)));
  });
}

function drawDrone(frame) {
  const lift = -DRONE_BOB[frame];
  const pulse = DRONE_PULSE[frame];
  const cx = 16;
  const cy = 13 - lift;
  const r = 9.6;

  // Layer 1: the ground glow stays put while the body bobs.
  const glow = new Canvas(DRONE_SIZE, DRONE_SIZE);
  drawUnderGlow(glow, 16, 28.5, pulse, lift);

  // Layer 2: side fins, behind the orb.
  const fins = new Canvas(DRONE_SIZE, DRONE_SIZE);
  const finLegend = { a: DRONE.cap[3], b: DRONE.cap[2], c: DRONE.cap[1], d: DRONE.cap[0], k: DRONE.lens[pulse][1] };
  stamp(fins, FIN, finLegend, 1, Math.round(cy) - 3);
  const finsBoth = new Canvas(DRONE_SIZE, DRONE_SIZE).paste(fins).paste(fins.mirrored());

  // Layer 3: the orb. Each pixel gets a surface normal, then a region and a shade.
  const orb = new Canvas(DRONE_SIZE, DRONE_SIZE);
  const region = new Map(); // "x,y" -> 'cap' | 'belly' | 'lens' | 'socket'
  eachInEllipse(cx, cy, r, r, (x, y, nx, ny) => {
    const n = [nx, ny, Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny))];
    const light = dot(n, LIGHT);
    const fromLens = Math.acos(Math.min(1, dot(n, DRONE_LENS_DIR))) / LENS_RADIUS;
    let kind;
    let color;
    if (fromLens < 1) {
      kind = 'lens';
      const [edge, body, core] = DRONE.lens[pulse];
      color = fromLens < 0.38 ? core : fromLens < 0.78 ? body : edge;
    } else if (fromLens < 1 + SOCKET_WIDTH / LENS_RADIUS) {
      kind = 'socket';
      color = DRONE.socket[pulse];
    } else if (dot(n, DRONE_UP) > SEAM_LEVEL) {
      kind = 'cap';
      color = light > 0.93 ? DRONE.capSpec : tone(light, [-0.2, 0.2, 0.55], DRONE.cap);
    } else {
      kind = 'belly';
      color = tone(light, [-0.35, 0.0, 0.35], DRONE.belly);
      if (ny > 0.84 && ny < 0.95 && Math.abs(nx) < 0.45) color = DRONE.bellyRim; // under-glow bouncing back up
    }
    region.set(`${x},${y}`, kind);
    orb.set(x, y, color);
  });

  // The shell's parting line: cap pixels that touch the belly.
  for (const [key, kind] of region) {
    if (kind !== 'cap') continue;
    const [x, y] = key.split(',').map(Number);
    if (region.get(`${x},${y + 1}`) === 'belly' || region.get(`${x - 1},${y}`) === 'belly' ||
      region.get(`${x + 1},${y}`) === 'belly') {
      orb.set(x, y, DRONE.seam);
    }
  }

  // Faint sigil on the top of the shell.
  stamp(orb, SIGIL, { s: DRONE.sigil, c: DRONE.sigilCore }, 12, Math.round(cy) - 8);

  // White glint on the upper-left of the lens.
  const lensY = Math.round(cy + DRONE_LENS_DIR[1] * r);
  orb.set(13, lensY - 2, DRONE.glint);
  orb.set(14, lensY - 2, DRONE.glint);
  orb.set(13, lensY - 1, DRONE.glint);

  // Compose back to front. Each part carries its own outline so the orb's rim
  // draws a line across the fin roots.
  const out = new Canvas(DRONE_SIZE, DRONE_SIZE);
  out.paste(glow);
  out.paste(outlined(finsBoth, DRONE.outline));
  out.paste(outlined(orb, DRONE.outline));
  return out;
}

// ---------------------------------------------------------------------------
// Nanite crawler: 6 frames of 32x24, facing down
// ---------------------------------------------------------------------------

const CRAWLER_W = 32;
const CRAWLER_H = 24;

const CRAWLER = {
  outline: '#0e0f14',
  shell: ['#171920', '#22252e', '#2e323e', '#3c4150'], // dark -> highlight
  shellSpec: '#535a6b',
  legHi: '#3c4150',
  legLo: '#2a2e39',
  joint: '#4c5263',
  veinRib: '#c42aa6',
  veinHalo: '#4a1a46',
  vein: '#ff3bd4',
  veinCore: '#ffb3f0',
  veinHot: '#ffffff',
  flash: '#ffffff',
};

// Legs on the crawler's left side (screen left); the right side mirrors them.
// a = attach point (moves with the body), k = knee, f = foot (planted on the ground),
// stride = how far the foot travels between the forward and back poses.
const LEGS = [
  { name: 'front', a: [11, 13], k: [7, 15], f: [5, 19], stride: 2 },
  { name: 'mid', a: [10, 10], k: [6, 10], f: [2, 12], stride: 2 },
  { name: 'rear', a: [11, 7], k: [7, 5], f: [5, 3], stride: 1.5 },
];

// Tripod gait: front-left, mid-right and rear-left step together, then the other three.
// phase: +1 = foot forward (down the screen), -1 = back. lifted = leg is swinging through the air.
const TRIPOD_A = [['L', 'front'], ['R', 'mid'], ['L', 'rear']];
const isTripodA = (side, name) => TRIPOD_A.some(([s, n]) => s === side && n === name);

const SCUTTLE = [
  { bob: 0, phaseA: 1, phaseB: -1, lifted: null },
  { bob: -1, phaseA: 0, phaseB: 0, lifted: 'B' },
  { bob: 0, phaseA: -1, phaseB: 1, lifted: null },
  { bob: -1, phaseA: 0, phaseB: 0, lifted: 'A' },
];

/** Draw one leg into a scratch canvas (left-side coordinates). */
function drawLeg(c, leg, bob, phase, lifted, recoil) {
  let a = [leg.a[0], leg.a[1] + bob];
  let k = [leg.k[0], leg.k[1] + bob + phase];
  let f = [leg.f[0] + (lifted ? 1 : 0), leg.f[1] + phase * leg.stride];
  if (recoil) {
    // Legs snap inward: knee closer to the body, foot folded up under the knee.
    k = [a[0] + (k[0] - a[0]) * 0.75, a[1] + (k[1] - a[1]) * 0.75 - 1];
    f = [k[0] + (leg.f[0] - leg.k[0]) * 0.5, k[1] + (leg.f[1] - leg.k[1]) * 0.5];
  }
  line(c, a[0], a[1], k[0], k[1], CRAWLER.legHi);
  line(c, k[0], k[1], f[0], f[1], CRAWLER.legLo);
  c.set(k[0], k[1], CRAWLER.joint);
}

/**
 * Build one crawler pose and return its layers.
 * pose: { bob, phaseA, phaseB, lifted, recoil, bright }
 */
function crawlerLayers(pose) {
  const { bob, recoil = false, bright = false } = pose;

  // Legs (behind the body).
  const legs = new Canvas(CRAWLER_W, CRAWLER_H);
  for (const side of ['L', 'R']) {
    for (const leg of LEGS) {
      const tripod = isTripodA(side, leg.name) ? 'A' : 'B';
      const phase = recoil ? 0 : tripod === 'A' ? pose.phaseA : pose.phaseB;
      const one = new Canvas(CRAWLER_W, CRAWLER_H);
      drawLeg(one, leg, bob, phase, pose.lifted === tripod, recoil);
      legs.paste(side === 'L' ? one : one.mirrored());
    }
  }

  // Carapace: a low, flattened dome.
  const body = new Canvas(CRAWLER_W, CRAWLER_H);
  eachInEllipse(16, 10 + bob, 7.2, 5.8, (x, y, nx, ny) => {
    const n = normalize([nx, ny, Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny)) * 1.4]);
    const light = dot(n, LIGHT);
    const c = light > 0.93 ? CRAWLER.shellSpec : tone(light, [0.12, 0.45, 0.74], CRAWLER.shell);
    body.set(x, y, c);
  });

  // Glowing veins: a midrib down the shell with ribs sweeping back like a leaf
  // (left half drawn, then mirrored). Hurt frames run every vein one step hotter.
  const veinMain = bright ? CRAWLER.veinCore : CRAWLER.vein;
  const veinRib = bright ? CRAWLER.vein : CRAWLER.veinRib;
  const veinNode = bright ? CRAWLER.veinHot : CRAWLER.veinCore;
  const veins = new Canvas(CRAWLER_W, CRAWLER_H);
  for (let y = 6; y <= 13; y++) veins.set(15, y + bob, veinMain);
  line(veins, 14, 8 + bob, 12, 6 + bob, veinRib);
  line(veins, 14, 11 + bob, 11, 9 + bob, veinRib);
  veins.set(15, 8 + bob, veinNode);
  veins.set(15, 11 + bob, veinNode);
  const allVeins = new Canvas(CRAWLER_W, CRAWLER_H).paste(veins).paste(veins.mirrored());
  if (bright) {
    // Hot veins bleed a dark magenta haze into the shell around them.
    for (let y = 0; y < CRAWLER_H; y++) {
      for (let x = 0; x < CRAWLER_W; x++) {
        const nearVein = allVeins.alpha(x - 1, y) || allVeins.alpha(x + 1, y) || allVeins.alpha(x, y - 1) || allVeins.alpha(x, y + 1);
        if (body.alpha(x, y) && !allVeins.alpha(x, y) && nearVein) body.set(x, y, CRAWLER.veinHalo);
      }
    }
  }
  body.paste(allVeins);

  // Head with eyes and mandibles.
  const head = new Canvas(CRAWLER_W, CRAWLER_H);
  eachInEllipse(16, 16.5 + bob, 4.4, 2.8, (x, y, nx, ny) => {
    const n = normalize([nx, ny, Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny)) * 1.2]);
    head.set(x, y, tone(dot(n, LIGHT), [0.3, 0.6, 0.85], CRAWLER.shell));
  });
  const halfHead = new Canvas(CRAWLER_W, CRAWLER_H);
  halfHead.set(13, 16 + bob, bright ? CRAWLER.veinCore : CRAWLER.vein);
  halfHead.set(14, 16 + bob, bright ? CRAWLER.veinHot : CRAWLER.veinCore);
  halfHead.set(14, 17 + bob, CRAWLER.veinRib);
  // Mandibles: flared outward when hurt.
  const jawTip = recoil ? [12, 20 + bob] : [13, 20 + bob];
  line(halfHead, 14, 19 + bob, jawTip[0], jawTip[1], CRAWLER.legHi);
  head.paste(halfHead).paste(halfHead.mirrored());

  return { legs, body, head };
}

/** Compose layers back to front, each with its own outline. */
function composeCrawler({ legs, body, head }) {
  const out = new Canvas(CRAWLER_W, CRAWLER_H);
  out.paste(outlined(legs, CRAWLER.outline));
  out.paste(outlined(body, CRAWLER.outline));
  out.paste(outlined(head, CRAWLER.outline));
  return out;
}

function drawCrawlerFrames() {
  const frames = SCUTTLE.map((pose) => composeCrawler(crawlerLayers(pose)));

  // Hurt: recoiled pose (body knocked back 1 px, legs tucked, veins flaring).
  const hurtPose = { bob: -1, recoil: true, bright: true };
  const hurtLayers = crawlerLayers(hurtPose);

  // Frame 4: plain white silhouette of the hurt pose, outer outline only.
  const union = new Canvas(CRAWLER_W, CRAWLER_H).paste(hurtLayers.legs).paste(hurtLayers.body).paste(hurtLayers.head);
  const flash = outlined(union.map((c) => (c[3] > 0 ? rgba(CRAWLER.flash) : c)), CRAWLER.outline);

  // Frame 5: the recoil itself, with a few nanites shaken loose.
  const recoil = composeCrawler(hurtLayers);
  recoil.set(6, 6, CRAWLER.vein);
  recoil.set(26, 4, CRAWLER.veinCore);
  recoil.set(24, 1, CRAWLER.vein);

  return [...frames, flash, recoil];
}

// ---------------------------------------------------------------------------
// FX textures
// ---------------------------------------------------------------------------

function fxSpark() {
  const c = new Canvas(4, 4);
  stamp(c, ['.yy.', 'yWWy', 'yWWy', '.yy.'], { y: '#ffe27a', W: '#ffffff' }, 0, 0);
  for (const [x, y] of [[0, 0], [3, 0], [0, 3], [3, 3]]) c.set(x, y, rgba('#ffd24a', 70));
  return c;
}

function fxBubble() {
  const c = new Canvas(6, 6);
  // Translucent toxic fill first, then the ring and its highlight.
  eachInEllipse(3, 3, 3, 3, (x, y) => c.set(x, y, rgba('#9be33a', 60)));
  stamp(c, [
    '.gGGg.',
    'gHh..G',
    'Gh...G',
    'G....d',
    'g...dg',
    '.gddg.',
  ], {
    G: '#9be33a', g: rgba('#9be33a', 170), d: '#5d9a22', H: '#f4ffde', h: '#cdf59a',
  }, 0, 0);
  return c;
}

function fxEmber() {
  const c = new Canvas(3, 3);
  stamp(c, ['oOo', 'OYO', 'oOo'], { Y: '#ffe08a', O: '#ff8a1e', o: rgba('#c8401a', 150) }, 0, 0);
  return c;
}

function fxNanite() {
  const c = new Canvas(2, 2);
  stamp(c, ['PM', 'Mm'], { P: '#ffb3f0', M: '#ff3bd4', m: '#c42aa6' }, 0, 0);
  return c;
}

/**
 * White crescent for an upward swing: bulges toward the top of the texture and thins
 * to nothing at both tips. Alpha is stepped so it stays crisp next to the pixel art.
 */
function fxSlash() {
  const size = 28;
  const c = new Canvas(size, size);
  const outer = { x: 14, y: 19, r: 12.4 };
  const inner = { x: 14, y: 22.6, r: 11.6 };
  const SS = 4; // supersamples per axis for smooth coverage
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cover = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          const inOuter = Math.hypot(px - outer.x, py - outer.y) < outer.r;
          const inInner = Math.hypot(px - inner.x, py - inner.y) < inner.r;
          if (inOuter && !inInner) cover++;
        }
      }
      if (cover === 0) continue;
      // Fade toward the tips: angle from straight up, 0 at the top, ~1.6 rad at the tips.
      const angle = Math.abs(Math.atan2(x + 0.5 - outer.x, -(y + 0.5 - outer.y)));
      const tipFade = 1 - smoothstep(0.55, 1.6, angle);
      // Leading (outer) edge is brightest.
      const depth = outer.r - Math.hypot(x + 0.5 - outer.x, y + 0.5 - outer.y);
      const edge = depth < 1.2 ? 1 : 0.84;
      const a = (cover / (SS * SS)) * tipFade * edge;
      const stepped = Math.round(a * 4) / 4; // 0, 64, 128, 191, 255
      if (stepped <= 0) continue;
      c.set(x, y, rgba(depth < 1.2 ? '#ffffff' : '#e4f6ff', Math.round(stepped * 255)));
    }
  }
  return c;
}

/** Soft radial white for additive glows: alpha 255 in the centre, smoothly down to 0 at the rim. */
function fxGlow() {
  const size = 32;
  const c = new Canvas(size, size);
  const half = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = Math.min(1, Math.hypot(x + 0.5 - half, y + 0.5 - half) / half);
      // (1 - t^2)^2.5 has a zero slope at the rim (no hard edge) and a bright core.
      const a = Math.min(1, Math.pow(1 - t * t, 2.5) * 1.01);
      // RGB stays white even where alpha is 0, so filtering never pulls in dark fringes.
      c.set(x, y, [255, 255, 255, Math.round(a * 255)]);
    }
  }
  return c;
}

/**
 * Optional vision-cone wedge: apex at the left middle (0, 32), pointing +x (Phaser angle 0),
 * 50 degrees wide, 64 px long. Use setOrigin(0, 0.5) and rotate to the drone's facing.
 */
function fxCone() {
  const size = 64;
  const c = new Canvas(size, size);
  const halfAngle = (25 * Math.PI) / 180;
  const inner = rgba('#e6fcff');
  const outer = rgba('#3ad4e8');
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5;
      const dy = y + 0.5 - size / 2;
      const dist = Math.hypot(dx, dy) / size;
      const angle = Math.abs(Math.atan2(dy, dx)) / halfAngle;
      if (dist >= 1 || angle >= 1) continue;
      const sideFade = 1 - smoothstep(0.6, 1, angle);
      const farFade = 1 - smoothstep(0.7, 1, dist);
      const nearFade = smoothstep(0, 0.06, dist);
      const a = sideFade * farFade * nearFade * (0.55 + 0.45 * (1 - dist));
      if (a <= 0) continue;
      const col = inner.map((v, i) => Math.round(v + (outer[i] - v) * Math.min(1, dist * 1.3)));
      c.set(x, y, [col[0], col[1], col[2], Math.round(a * 255)]);
    }
  }
  return c;
}

// ---------------------------------------------------------------------------
// Output + preview
// ---------------------------------------------------------------------------

/** Canvas -> sharp instance. */
const toSharp = (c) => sharp(Buffer.from(c.data), { raw: { width: c.w, height: c.h, channels: 4 } });

async function writePng(c, file) {
  await toSharp(c).png().toFile(file);
  console.log(`  ${file}  ${c.w}x${c.h}`);
}

/** Nearest-neighbour upscale to a PNG buffer. */
const zoomed = (c, z) => toSharp(c).resize(c.w * z, c.h * z, { kernel: 'nearest' }).png().toBuffer();

/** One crop of a canvas as its own canvas. */
function crop(c, x0, y0, w, h) {
  const out = new Canvas(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.set(x, y, c.get(x0 + x, y0 + y));
  return out;
}

function label(text, width = 900) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="22">
    <text x="0" y="16" font-family="Menlo, monospace" font-size="15" fill="#9a8f7c">${text}</text></svg>`;
  return Buffer.from(svg);
}

/** Thin frame separators drawn over a zoomed sheet. */
function frameGrid(frameW, frameH, count, z) {
  const w = frameW * count * z;
  const h = frameH * z;
  let lines = '';
  for (let i = 0; i <= count; i++) {
    const x = Math.min(w - 1, i * frameW * z);
    lines += `<line x1="${x + 0.5}" y1="0" x2="${x + 0.5}" y2="${h}" stroke="#3a3f52" stroke-width="1"/>`;
  }
  lines += `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" fill="none" stroke="#3a3f52"/>`;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${lines}</svg>`);
}

async function writePreview(drone, crawler, fx) {
  const parts = [];
  const pad = 24;
  let y = pad;

  // Sprite sheets at 6x with frame separators.
  for (const [name, sh, fw, fh, n] of [
    ['drone.png  128x32  4 frames  (hover bob 0/-1/-2/-1, eye pulse on 1-2)', drone, 32, 32, 4],
    ['crawler.png  192x24  6 frames  (0-3 scuttle, 4 flash, 5 recoil)', crawler, 32, 24, 6],
  ]) {
    parts.push({ input: label(name), left: pad, top: y });
    y += 26;
    parts.push({ input: await zoomed(sh, ZOOM), left: pad, top: y });
    parts.push({ input: frameGrid(fw, fh, n, ZOOM), left: pad, top: y });
    y += fh * ZOOM + 20;
  }

  // FX at 6x in one row.
  parts.push({ input: label('fx: spark 4  bubble 6  ember 3  nanite 2  slash 28  glow 32  cone 64'), left: pad, top: y });
  y += 26;
  let x = pad;
  let rowH = 0;
  for (const c of fx) {
    parts.push({ input: await zoomed(c, ZOOM), left: x, top: y });
    x += c.w * ZOOM + 24;
    rowH = Math.max(rowH, c.h * ZOOM);
  }
  const fxRight = x;
  y += rowH + 20;

  // In-context mock at game scale (2x) over a crop of the wasteland map, with the nomad for scale.
  const MOCK = { x: 1000, y: 700, w: 320, h: 180 };
  const mockZ = 2;
  parts.push({ input: label('game scale (2x) over wasteland.png crop, with nomad for scale'), left: pad, top: y });
  y += 26;
  const mapCrop = await sharp('public/assets/maps/wasteland.png')
    .extract({ left: MOCK.x, top: MOCK.y, width: MOCK.w, height: MOCK.h })
    .resize(MOCK.w * mockZ, MOCK.h * mockZ, { kernel: 'nearest' }).png().toBuffer();
  parts.push({ input: mapCrop, left: pad, top: y });
  const nomad = await sharp('public/assets/characters/nomad.png')
    .extract({ left: 0, top: 0, width: 32, height: 48 })
    .resize(64, 96, { kernel: 'nearest' }).png().toBuffer();
  const place = async (c, fx0, fy0) => ({ input: await zoomed(c, mockZ), left: pad + fx0 * mockZ, top: y + fy0 * mockZ });
  parts.push(await place(crop(drone, 0, 0, 32, 32), 40, 20));
  parts.push(await place(crop(drone, 64, 0, 32, 32), 230, 40));
  parts.push(await place(crop(crawler, 0, 0, 32, 24), 120, 110));
  parts.push(await place(crop(crawler, 64, 0, 32, 24), 175, 135));
  parts.push(await place(crop(crawler, 160, 0, 32, 24), 270, 120));
  parts.push({ input: nomad, left: pad + 80 * mockZ, top: y + 60 * mockZ });
  y += MOCK.h * mockZ + pad;

  const width = Math.max(pad * 2 + crawler.w * ZOOM, fxRight + pad, pad * 2 + MOCK.w * mockZ);
  await sharp({ create: { width, height: y, channels: 4, background: PREVIEW_BG } })
    .composite(parts).png().toFile(PREVIEW_FILE);
  console.log(`  ${PREVIEW_FILE}  ${width}x${y}`);
}

async function main() {
  await mkdir(CREATURES_DIR, { recursive: true });
  await mkdir(FX_DIR, { recursive: true });

  const drone = sheet([0, 1, 2, 3].map(drawDrone));
  const crawler = sheet(drawCrawlerFrames());
  await writePng(drone, `${CREATURES_DIR}/drone.png`);
  await writePng(crawler, `${CREATURES_DIR}/crawler.png`);

  const fx = {
    'fx-spark': fxSpark(),
    'fx-bubble': fxBubble(),
    'fx-ember': fxEmber(),
    'fx-nanite': fxNanite(),
    'fx-slash': fxSlash(),
    'fx-glow': fxGlow(),
    'fx-cone': fxCone(),
  };
  for (const [name, c] of Object.entries(fx)) await writePng(c, `${FX_DIR}/${name}.png`);

  await writePreview(drone, crawler, Object.values(fx));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

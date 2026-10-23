// UI asset pipeline for THE NOMAD (task B).
//
//   node tools/assets/ui.mjs        (run from the project root)
//
// Reads raw-assets/ui-sheet.png (never modified) and writes:
//   public/assets/ui/*.png   text-free UI textures, pre-scaled to the exact size
//                            they are displayed at (the game uses nearest filtering)
//   tools/previews/ui.png    1280×720 mock of the HUD layout (rendered in Chrome via
//                            Playwright when available, otherwise composited with sharp)
//
// All source coordinates below were measured on the 1448×1086 sheet.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import * as L from '../../src/ui/uiLayout.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHEET = path.join(ROOT, 'raw-assets/ui-sheet.png');
const OUT_DIR = path.join(ROOT, 'public/assets/ui');
const PREVIEW = path.join(ROOT, 'tools/previews/ui.png');

// ---------------------------------------------------------------------------
// Raw RGBA image helpers. An "image" is { width, height, data: Buffer(RGBA) }.

async function loadImage(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

function blankImage(width, height) {
  return { width, height, data: Buffer.alloc(width * height * 4) };
}

function cropImage(img, x, y, w, h) {
  const out = blankImage(w, h);
  for (let row = 0; row < h; row++) {
    const sy = y + row;
    if (sy < 0 || sy >= img.height) continue;
    for (let col = 0; col < w; col++) {
      const sx = x + col;
      if (sx < 0 || sx >= img.width) continue;
      img.data.copy(out.data, (row * w + col) * 4, (sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4);
    }
  }
  return out;
}

function getPixel(img, x, y) {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

function setPixel(img, x, y, rgba) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  for (let k = 0; k < 4; k++) img.data[i + k] = Math.max(0, Math.min(255, Math.round(rgba[k])));
}

const luminance = ([r, g, b]) => 0.3 * r + 0.59 * g + 0.11 * b;

function hexToRgba(hex, alpha = 255) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, alpha];
}

// Quality downscale (lanczos3; sharp premultiplies alpha so edges don't go dark).
async function resizeImage(img, width, height, kernel = 'lanczos3') {
  const { data, info } = await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } })
    .resize(width, height, { kernel, fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

function toPng(img) {
  return sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } }).png({ compressionLevel: 9 });
}

const written = [];
async function saveTexture(img, key) {
  const file = path.join(OUT_DIR, `${key}.png`);
  await toPng(img).toFile(file);
  written.push({ key, file, width: img.width, height: img.height });
  return img;
}

// Small deterministic PRNG so re-runs produce identical files.
function makeRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Median of each channel over a sliding window: removes thin bright/dark
// spikes (e.g. a silhouette outline touching the edge) from a boundary strip.
function medianFilter(samples, radius) {
  return samples.map((_, i) => {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(samples.length - 1, i + radius);
    const pick = [];
    for (let j = lo; j <= hi; j++) pick.push(samples[j]);
    return [0, 1, 2, 3].map((k) => {
      const values = pick.map((p) => p[k]).sort((a, b) => a - b);
      return values[values.length >> 1];
    });
  });
}

function averagePixels(img, coords) {
  const sum = [0, 0, 0, 0];
  for (const [x, y] of coords) {
    const p = getPixel(img, x, y);
    for (let k = 0; k < 4; k++) sum[k] += p[k];
  }
  return sum.map((v) => v / coords.length);
}

// Paint out a rectangle by blending the pixels that surround it (a Coons patch:
// each pixel is interpolated from the strips just above, below, left and right).
// `band` px of surroundings are averaged; `median` smooths spikes along a strip;
// a little noise keeps the result from looking flatter than the panel around it.
function inpaintRect(img, rx, ry, rw, rh, { band = 2, median = 4, noise = 1.2, seed = 1 } = {}) {
  const strip = (count, pointsFor) => medianFilter(Array.from({ length: count }, (_, i) => averagePixels(img, pointsFor(i))), median);
  const range = (n, f) => Array.from({ length: n }, (_, k) => f(k));
  const top = strip(rw, (i) => range(band, (k) => [rx + i, ry - 1 - k]));
  const bottom = strip(rw, (i) => range(band, (k) => [rx + i, ry + rh + k]));
  const left = strip(rh, (j) => range(band, (k) => [rx - 1 - k, ry + j]));
  const right = strip(rh, (j) => range(band, (k) => [rx + rw + k, ry + j]));
  const mix = (a, b) => a.map((v, k) => (v + b[k]) / 2);
  const tl = mix(top[0], left[0]);
  const tr = mix(top[rw - 1], right[0]);
  const bl = mix(bottom[0], left[rh - 1]);
  const br = mix(bottom[rw - 1], right[rh - 1]);
  const random = makeRandom(seed);
  for (let j = 0; j < rh; j++) {
    const v = (j + 0.5) / rh;
    for (let i = 0; i < rw; i++) {
      const u = (i + 0.5) / rw;
      const grain = (random() - 0.5) * 2 * noise;
      const px = [0, 1, 2, 3].map((k) => {
        const edges = (1 - v) * top[i][k] + v * bottom[i][k] + (1 - u) * left[j][k] + u * right[j][k];
        const corners = (1 - u) * (1 - v) * tl[k] + u * (1 - v) * tr[k] + (1 - u) * v * bl[k] + u * v * br[k];
        return edges - corners + (k < 3 ? grain : 0);
      });
      setPixel(img, rx + i, ry + j, px);
    }
  }
}

// Copy a w×h block inside the same image (used to rebuild frame behind the name plate).
function copyBlock(img, sx, sy, w, h, dx, dy) {
  const block = cropImage(img, sx, sy, w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(img, dx + x, dy + y, getPixel(block, x, y));
}

function clearBlock(img, x, y, w, h) {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) setPixel(img, x + i, y + j, [0, 0, 0, 0]);
}

// ---------------------------------------------------------------------------
// Texture builders

// Bars block: four rows (heart, fork, drop, empty ring). Rows are 90 px tall on
// the sheet; the 4th row (empty bar) starts at y=336. Other rows are offset by
// these amounts so their icon boxes line up exactly with the 4th row's box.
const BAR_CROP = { x: 44, y: 336, w: 556, h: 90 };
const ICON_BOX_W = 96; // icon box width on the sheet (incl. outline)
const ROW_OFFSET = { heart: -269, food: -177, water: -89, ring: 0 };
const BAR_SCALE = 0.5;
// Inside of the 4th row's icon box, where the dashed ring sits (sheet coords).
const RING_RECT = { x: 66, y: 352, w: 58, h: 59 };

async function buildBars(sheet) {
  // Frame: 4th row with the dashed ring painted out, so it's an empty box + empty bar.
  const frame = cropImage(sheet, BAR_CROP.x, BAR_CROP.y, BAR_CROP.w, BAR_CROP.h);
  inpaintRect(frame, RING_RECT.x - BAR_CROP.x, RING_RECT.y - BAR_CROP.y, RING_RECT.w, RING_RECT.h, { band: 2, median: 6, noise: 0.8, seed: 7 });
  await saveTexture(await resizeImage(frame, L.BAR.width, L.BAR.height), 'ui-bar-frame');

  // Icon boxes (same top-left as the frame, so they drop straight on top of it).
  for (const [name, dy] of [['heart', ROW_OFFSET.heart], ['food', ROW_OFFSET.food], ['water', ROW_OFFSET.water]]) {
    const box = cropImage(sheet, BAR_CROP.x, BAR_CROP.y + dy, ICON_BOX_W, BAR_CROP.h);
    await saveTexture(await resizeImage(box, L.BAR.iconWidth, L.BAR.iconHeight), `ui-icon-${name}`);
  }

  // Ring: only the dashed ring, recoloured white so UIScene can tint it (toxicity green).
  // It is drawn over the frame's empty box, so the box itself isn't part of this texture.
  const ring = blankImage(ICON_BOX_W, BAR_CROP.h);
  for (let y = RING_RECT.y; y < RING_RECT.y + RING_RECT.h; y++) {
    for (let x = RING_RECT.x - 4; x < RING_RECT.x + RING_RECT.w; x++) {
      const lum = luminance(getPixel(sheet, x, y));
      const alpha = Math.max(0, Math.min(1, (lum - 40) / 150));
      if (alpha > 0) setPixel(ring, x - BAR_CROP.x, y - BAR_CROP.y, [255, 255, 255, alpha * 255]);
    }
  }
  await saveTexture(await resizeImage(ring, L.BAR.iconWidth, L.BAR.iconHeight), 'ui-icon-ring');
}

// Inventory slots: a plain slot (2nd slot, bottom row of the first block) and the
// selected slot (top-left, orange corner brackets). Both cropped 138×138, centred.
async function buildSlots(sheet) {
  const plain = cropImage(sheet, 774, 221, 138, 138);
  await saveTexture(await resizeImage(plain, L.SLOT.size, L.SLOT.size), 'ui-slot');
  const selected = cropImage(sheet, 632, 77, 138, 138);
  await saveTexture(await resizeImage(selected, L.SLOT.size, L.SLOT.size), 'ui-slot-selected');
}

// "E" key prompt. The sheet's key body is 112×114 at (1266, 91) with a cyan glow.
// Downscaling turns the letter to mush, so the letter is painted out and redrawn
// as a crisp pixel glyph at the target size.
const KEY_CROP = { x: 1260, y: 86, w: 124, h: 124 };
const KEY_LETTER = { x: 1304, y: 123, w: 34, h: 48 }; // E glyph + its dark outline (sheet coords)

function drawPixelE(img, { x, y, width, height, stem, bar, midWidth, color, shadow }) {
  const rows = [];
  const gap = (height - 3 * bar) / 2;
  for (let j = 0; j < height; j++) {
    const inTop = j < bar;
    const inMid = j >= bar + gap && j < 2 * bar + gap;
    const inBottom = j >= height - bar;
    rows.push(inTop || inBottom ? width : inMid ? midWidth : stem);
  }
  // Shadow first (1 px down-right), then the letter. Top rows are a touch lighter.
  for (const [ox, oy, rgba] of [[1, 1, shadow], [0, 0, null]]) {
    rows.forEach((len, j) => {
      for (let i = 0; i < len; i++) {
        const c = rgba || (j < height / 2 ? color[0] : color[1]);
        setPixel(img, x + i + ox, y + j + oy, c);
      }
    });
  }
}

async function buildKeyE(sheet) {
  const key = cropImage(sheet, KEY_CROP.x, KEY_CROP.y, KEY_CROP.w, KEY_CROP.h);
  inpaintRect(key, KEY_LETTER.x - KEY_CROP.x, KEY_LETTER.y - KEY_CROP.y, KEY_LETTER.w, KEY_LETTER.h, { band: 3, median: 3, noise: 0.6, seed: 3 });
  const light = hexToRgba('#f4e4c4');
  const dark = hexToRgba('#e2c99e');
  const shadow = hexToRgba('#05070c');

  const small = await resizeImage(key, L.KEY_E.size, L.KEY_E.size);
  drawPixelE(small, { x: 10, y: 8, width: 5, height: 7, stem: 2, bar: 1, midWidth: 4, color: [light, dark], shadow });
  await saveTexture(small, 'ui-key-e');

  const large = await resizeImage(key, L.KEY_E.largeSize, L.KEY_E.largeSize);
  drawPixelE(large, { x: 19, y: 16, width: 10, height: 15, stem: 3, bar: 3, midWidth: 8, color: [light, dark], shadow });
  await saveTexture(large, 'ui-key-e-lg');
}

// Dialogue box. Crop includes the lantern and the cables below it.
const DIALOGUE_CROP = { x: 32, y: 446, w: 940, h: 270 };
// Baked-in content to paint out (sheet coords).
const DIALOGUE_PAINT = {
  name: { x: 146, y: 463, w: 55, h: 29 }, // "???"
  body: { x: 262, y: 508, w: 632, h: 145 }, // two text lines, sparkle and ▼
  portrait: { x: 89, y: 514, w: 145, h: 143 }, // blue silhouette: whole recess inside the frame line
};
// Name plate removal for the narration variant: the plate covers the top frame
// strip between x=113 and x=289; an identical stretch of strip is copied from the right.
const PLATE = { x: 113, y: 446, w: 176, h: 56, clearW: 182, stripTop: 474, stripCopyFromX: 345 };

function paintOutDialogue(box) {
  const ox = DIALOGUE_CROP.x;
  const oy = DIALOGUE_CROP.y;
  const r = DIALOGUE_PAINT;
  inpaintRect(box, r.name.x - ox, r.name.y - oy, r.name.w, r.name.h, { band: 2, median: 8, noise: 0.8, seed: 11 });
  inpaintRect(box, r.body.x - ox, r.body.y - oy, r.body.w, r.body.h, { band: 3, median: 16, noise: 0.9, seed: 12 });
  fillPortraitRecess(box, r.portrait.x - ox, r.portrait.y - oy, r.portrait.w, r.portrait.h);
}

// The silhouette touches the recess edges, so blending from the sides leaves seams.
// Instead: a vertical gradient from the recess's own top colour to a darker navy,
// with a faint glow behind where the portrait's head sits.
function fillPortraitRecess(img, rx, ry, rw, rh) {
  const topStrip = medianFilter(Array.from({ length: rw }, (_, i) => getPixel(img, rx + i, ry + 2)), 20);
  const top = topStrip[rw >> 1];
  const bottom = top.map((v, k) => (k < 3 ? v * 0.55 : v));
  const random = makeRandom(13);
  for (let j = 0; j < rh; j++) {
    const v = j / (rh - 1);
    for (let i = 0; i < rw; i++) {
      const dx = (i - rw / 2) / (rw / 2);
      const dy = (j - rh * 0.42) / (rh / 2);
      const glow = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy)) * 0.35;
      const grain = (random() - 0.5) * 1.6;
      const px = top.map((t, k) => {
        if (k === 3) return t;
        const base = t + (bottom[k] - t) * v;
        return base * (1 + glow) + grain;
      });
      setPixel(img, rx + i, ry + j, px);
    }
  }
}

function removeNamePlate(box) {
  const ox = DIALOGUE_CROP.x;
  const oy = DIALOGUE_CROP.y;
  const stripH = PLATE.y + PLATE.h - PLATE.stripTop;
  // Above the strip: transparent. Strip: copied from further right where it's plain.
  clearBlock(box, PLATE.x - ox, PLATE.y - oy, PLATE.clearW, PLATE.stripTop - PLATE.y);
  copyBlock(box, PLATE.stripCopyFromX - ox, PLATE.stripTop - oy, PLATE.w, stripH, PLATE.x - ox, PLATE.stripTop - oy);
}

// Narration / no-portrait variants: the empty portrait recess (frame line included)
// is blended away into the surrounding panel.
const RECESS = { x: 84, y: 510, w: 156, h: 151 };

function removePortraitRecess(box) {
  inpaintRect(box, RECESS.x - DIALOGUE_CROP.x, RECESS.y - DIALOGUE_CROP.y, RECESS.w, RECESS.h, { band: 2, median: 12, noise: 0.9, seed: 14 });
}

function cloneImage(img) {
  return { width: img.width, height: img.height, data: Buffer.from(img.data) };
}

// Four variants so UIScene can show or hide the name plate and the portrait recess:
//   ui-dialogue (plate + portrait), ui-dialogue-noplate (portrait only),
//   ui-dialogue-noportrait (plate only), ui-dialogue-narration (neither).
async function buildDialogue(sheet) {
  const full = cropImage(sheet, DIALOGUE_CROP.x, DIALOGUE_CROP.y, DIALOGUE_CROP.w, DIALOGUE_CROP.h);
  paintOutDialogue(full);
  const save = async (img, key) => saveTexture(await resizeImage(img, L.DIALOGUE.width, L.DIALOGUE.height), key);

  const noPortrait = cloneImage(full);
  removePortraitRecess(noPortrait);
  const noPlate = cloneImage(full);
  removeNamePlate(noPlate);
  const narration = cloneImage(noPlate);
  removePortraitRecess(narration);

  await save(full, 'ui-dialogue');
  await save(noPlate, 'ui-dialogue-noplate');
  await save(noPortrait, 'ui-dialogue-noportrait');
  await save(narration, 'ui-dialogue-narration');
}

// Small slot (44×44) for the supply counters and the party row: same crop as `ui-slot`.
async function buildSmallSlot(sheet) {
  const plain = cropImage(sheet, 774, 221, 138, 138);
  await saveTexture(await resizeImage(plain, L.SLOT_SMALL.size, L.SLOT_SMALL.size), 'ui-slot-sm');
}

// Circular compass minimap frame (rusty ring + N/E/S/W plates + the two orange gems).
// The centre and radii were measured with a least-squares circle fit on the ring's
// inner edge (sheet coords): the dashed line sits at r≈157, a dark rim at 159–170,
// the brown ring at 170–183 and the outer outline ends at ≈192 (plates reach ≈200).
// Everything inside the dark rim (the painted map) is made transparent so the live
// map can show through; only the four small orange cardinal ticks are kept.
const MINIMAP_SRC = {
  cx: 1209, // continuous coords of the circle centre
  cy: 566,
  half: 203, // square crop of 406×406 centred on the circle
  holeR: 159, // transparent inside this radius (start of the dark rim)
  keepR: 206, // nothing is kept beyond this radius
  bounds: { x0: 1006, y0: 368, x1: 1413, y1: 763 }, // excludes the quest panel just below
  ticks: [
    [0, -138],
    [0, 135],
    [-142, 0],
    [141, 0],
  ], // inward-pointing orange triangles (offsets from the centre)
  tickHalf: 9,
};

async function buildMinimapFrame(sheet) {
  const s = MINIMAP_SRC;
  const x0 = s.cx - s.half;
  const y0 = s.cy - s.half;
  const size = s.half * 2;
  const frame = cropImage(sheet, x0, y0, size, size);

  const inTick = (dx, dy) => s.ticks.some(([tx, ty]) => Math.abs(dx - tx) <= s.tickHalf && Math.abs(dy - ty) <= s.tickHalf);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - s.half;
      const dy = y + 0.5 - s.half;
      const d = Math.sqrt(dx * dx + dy * dy);
      const sx = x0 + x;
      const sy = y0 + y;
      const p = getPixel(frame, x, y);
      let keep = 1;
      if (d > s.keepR || sx < s.bounds.x0 || sx >= s.bounds.x1 || sy < s.bounds.y0 || sy >= s.bounds.y1) keep = 0;
      else if (d < s.holeR + 0.5) {
        // Inside the hole: anti-aliased edge, plus the orange cardinal ticks.
        keep = Math.max(0, Math.min(1, d - (s.holeR - 0.5)));
        if (inTick(dx, dy)) {
          const orange = Math.max(0, Math.min(1, (p[0] - p[2] - 70) / 90)) * (p[0] > 150 ? 1 : 0);
          keep = Math.max(keep, orange);
        }
      }
      if (keep < 1) setPixel(frame, x, y, [p[0], p[1], p[2], p[3] * keep]);
    }
  }
  await saveTexture(await resizeImage(frame, L.MINIMAP.size, L.MINIMAP.size), 'ui-minimap-frame');
}

async function buildDividers(sheet) {
  const orange = cropImage(sheet, 44, 976, 488, 76);
  await saveTexture(await resizeImage(orange, L.DIVIDER.orange.w, L.DIVIDER.orange.h), 'ui-divider-orange');
  const cyan = cropImage(sheet, 556, 976, 366, 72);
  await saveTexture(await resizeImage(cyan, L.DIVIDER.cyan.w, L.DIVIDER.cyan.h), 'ui-divider-cyan');
}

// ---------------------------------------------------------------------------
// Preview: a 1280×720 mock of the HUD with every texture at its real screen
// position (from uiLayout.js) and sample text in the real fonts. It's an HTML
// page screenshotted in Chrome; panels mirror drawPanel() in src/ui/uiStyle.js.

const dataUrl = (file, mime = 'image/png') => `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
const uiUrl = (key) => dataUrl(path.join(OUT_DIR, `${key}.png`));
const optionalUrl = (rel) => {
  const file = path.join(ROOT, 'public/assets', rel);
  return fs.existsSync(file) ? dataUrl(file) : null;
};

function img(src, x, y, extra = '') {
  return src ? `<img src="${src}" style="left:${x}px;top:${y}px;${extra}">` : '';
}

function text(str, x, y, { font = L.FONTS.body, size = 24, color = L.CSS.cream, width = null, align = 'left', extra = '' } = {}) {
  const w = width ? `width:${width}px;white-space:normal;` : '';
  return `<div class="t" style="left:${x}px;top:${y}px;font-family:'${font}';font-size:${size}px;line-height:${size + 2}px;color:${color};text-align:${align};${w}${extra}">${str}</div>`;
}

// Chamfered panel (same shape as drawPanel in src/ui/uiStyle.js).
function panel(x, y, w, h, { border = L.CSS.rust, alpha = 0.94 } = {}) {
  const c = 4;
  const pts = (inset) => {
    const a = inset;
    const k = c + inset * 0.4;
    return [[a + k, a], [w - a - k, a], [w - a, a + k], [w - a, h - a - k], [w - a - k, h - a], [a + k, h - a], [a, h - a - k], [a, a + k]]
      .map((p) => p.join(',')).join(' ');
  };
  return `<svg style="position:absolute;left:${x}px;top:${y}px" width="${w}" height="${h}" shape-rendering="crispEdges">
    <polygon points="${pts(0)}" fill="#05060a"/>
    <polygon points="${pts(1)}" fill="${border}"/>
    <polygon points="${pts(3)}" fill="${L.CSS.panelLight}"/>
    <polygon points="${pts(4)}" fill="${L.CSS.panel}" fill-opacity="${alpha}"/>
  </svg>`;
}

function statBar(y, iconSrc, ratio, color, tintRing = false) {
  const f = L.BAR.fill;
  const fillW = Math.round(f.w * ratio);
  const icon = tintRing
    ? `<div style="position:absolute;left:${L.HUD.x}px;top:${y}px;width:${L.BAR.iconWidth}px;height:${L.BAR.iconHeight}px;background:${color};-webkit-mask-image:url(${iconSrc});mask-image:url(${iconSrc})"></div>`
    : img(iconSrc, L.HUD.x, y);
  return [
    img(uiUrl('ui-bar-frame'), L.HUD.x, y),
    `<div style="position:absolute;left:${L.HUD.x + f.x}px;top:${y + f.y}px;width:${fillW}px;height:${f.h}px;background:${color};box-shadow:inset 0 2px 0 rgba(255,255,255,0.35), inset 0 -2px 0 rgba(0,0,0,0.3)"></div>`,
    icon,
  ].join('');
}

function diamond(x, y, s, color) {
  return `<svg style="position:absolute;left:${x}px;top:${y}px" width="${s}" height="${s}" shape-rendering="crispEdges">
    <polygon points="${s / 2},0 ${s},${s / 2} ${s / 2},${s} 0,${s / 2}" fill="${color}"/>
    <polygon points="${s / 2},3 ${s - 3},${s / 2} ${s / 2},${s - 3} 3,${s / 2}" fill="${L.CSS.panel}"/>
    <polygon points="${s / 2},5 ${s - 5},${s / 2} ${s / 2},${s - 5} 5,${s / 2}" fill="${color}"/>
  </svg>`;
}

function buildPreviewHtml() {
  const parts = [];
  // Faint world stand-in so panel edges are readable against "something".
  parts.push('<div style="position:absolute;inset:0;background:radial-gradient(ellipse at 50% 40%, #1c2a1e 0%, #0b0d12 70%)"></div>');

  // HUD bars
  const healthY = L.HUD.y;
  const toxY = L.HUD.y + L.BAR.spacing;
  parts.push(statBar(healthY, uiUrl('ui-icon-heart'), 0.72, L.CSS.health));
  parts.push(statBar(toxY, uiUrl('ui-icon-ring'), 0.35, L.CSS.toxicity, true));

  // Quest tracker
  const q = L.QUEST_TRACKER;
  const qy = toxY + L.BAR.height + q.gapBelowBars;
  const qh = q.padY * 2 + q.titleSize + 6 + q.objectiveSize * 2 + 2;
  parts.push(panel(q.x, qy, q.width, qh));
  parts.push(diamond(q.x + q.padX, qy + q.padY + 1, q.iconSize, L.CSS.orange));
  parts.push(text("ACT I · TOBIN'S TRAIL", q.x + q.padX + q.iconSize + 8, qy + q.padY - 1, { font: L.FONTS.title, size: q.titleSize, color: L.CSS.orange }));
  parts.push(text('Find what Tobin left behind (1/3)', q.x + q.padX, qy + q.padY + q.titleSize + 6, { size: q.objectiveSize, width: q.width - q.padX * 2 }));

  // Inventory row
  const held = ['journal', 'map', 'shard'];
  for (let i = 0; i < L.SLOT.count; i++) {
    const x = L.INVENTORY.x + i * (L.SLOT.size + L.SLOT.gap);
    parts.push(img(uiUrl(i === 0 ? 'ui-slot-selected' : 'ui-slot'), x, L.INVENTORY.y));
    const icon = held[i] && optionalUrl(`items/${held[i]}.png`);
    if (icon) {
      const s = Math.round(64 * L.INVENTORY.iconScale);
      const o = (L.SLOT.size - s) / 2;
      parts.push(img(icon, x + o, L.INVENTORY.y + o, `width:${s}px;height:${s}px;image-rendering:auto`));
    }
  }

  // M2: supply counters (ui-slot-sm + 24×24 icons) and the minimap frame over a
  // circle-clipped piece of the village map. (The live versions are in-game; see
  // tools/previews/ui-m2-*.png, captured from the real UIScene.)
  L.SUPPLIES.order.forEach(({ id, key }, i) => {
    const x = L.SUPPLIES.x + i * (L.SLOT_SMALL.size + L.SUPPLIES.gap);
    parts.push(img(uiUrl('ui-slot-sm'), x, L.SUPPLIES.y));
    parts.push(img(optionalUrl(`items/${id}-sm.png`), x + 10, L.SUPPLIES.y + 7));
    parts.push(text(String(2 - i), x + 30, L.SUPPLIES.y + 20, { size: 22, extra: 'text-shadow:0 0 3px #000' }));
    parts.push(text(key, x + 7, L.SUPPLIES.y + 31, { font: L.FONTS.title, size: 8, color: L.CSS.cyan }));
  });
  const mm = L.MINIMAP;
  const map = optionalUrl('maps/village.png');
  if (map) {
    const s = mm.mapScale;
    const r = mm.maskRadius;
    parts.push(`<div style="position:absolute;left:${mm.x + mm.centerX - r}px;top:${mm.y + mm.centerY - r}px;width:${r * 2}px;height:${r * 2}px;border-radius:50%;overflow:hidden;background:#0a1219">
      <img src="${map}" style="position:absolute;left:${r - 700 * s}px;top:${r - 560 * s}px;width:${1448 * s}px;height:${1086 * s}px;image-rendering:auto"></div>`);
  }
  parts.push(img(uiUrl('ui-minimap-frame'), mm.x, mm.y));

  // Toast (item kind, with icon)
  const t = L.TOAST;
  const toastW = 330;
  const tx = t.centerX - toastW / 2;
  parts.push(panel(tx, t.y, toastW, t.height, { border: L.CSS.orange }));
  parts.push(img(optionalUrl('items/journal-sm.png'), tx + t.padX, t.y + (t.height - 24) / 2));
  parts.push(text("Obtained: Tobin's Journal", tx + t.padX + 32, t.y + 8, { size: t.textSize, color: L.CSS.orange }));

  // Title card (with the soft dark band TitleCard draws behind it)
  const tc = L.TITLE_CARD;
  parts.push(`<div style="position:absolute;left:${tc.centerX - 380}px;top:${tc.centerY + 14 - 85}px;width:760px;height:170px;background:linear-gradient(90deg, transparent, rgba(5,6,10,0.7) 25%, rgba(5,6,10,0.7) 75%, transparent);-webkit-mask-image:linear-gradient(transparent, #000 30%, #000 70%, transparent)"></div>`);
  parts.push(text('ACT I', 0, tc.centerY - 44, { font: L.FONTS.title, size: tc.titleSize, width: 1280, align: 'center', extra: 'text-shadow:0 3px 0 #000' }));
  parts.push(img(uiUrl('ui-divider-orange'), tc.centerX - L.DIVIDER.orange.w / 2, tc.centerY + 2));
  parts.push(text('THE FORBIDDEN BOUNDARY', 0, tc.centerY + 42, { size: tc.subtitleSize, color: L.CSS.cream, width: 1280, align: 'center', extra: 'text-shadow:0 2px 0 #000' }));

  // World-space "E" prompt: shown at camera zoom 2 in the world scenes (so 48 px on screen).
  parts.push(img(uiUrl('ui-key-e'), 300, 360, 'width:48px;height:48px'));
  parts.push(text('ui-key-e ×2', 282, 410, { size: 20, color: L.CSS.muted }));
  parts.push(img(uiUrl('ui-key-e-lg'), 440, 360));
  parts.push(text('ui-key-e-lg', 420, 410, { size: 20, color: L.CSS.muted }));

  // Choices (above the dialogue box)
  const c = L.CHOICES;
  const choices = ["I'm going to find Paradise.", "You're right. I'll burn them."];
  const ch = c.padY * 2 + choices.length * c.rowHeight;
  const cx = c.right - c.width;
  const cy = c.bottom - ch;
  parts.push(panel(cx, cy, c.width, ch));
  choices.forEach((label, i) => {
    const ry = cy + c.padY + i * c.rowHeight;
    if (i === 0) parts.push(`<div style="position:absolute;left:${cx + 6}px;top:${ry + 2}px;width:${c.width - 12}px;height:${c.rowHeight - 4}px;background:rgba(240,160,48,0.16)"></div>`);
    if (i === 0) parts.push(text('▶', cx + c.padX - 2, ry + 3, { size: c.textSize, color: L.CSS.orange }));
    parts.push(text(`${i + 1}. ${label}`, cx + c.padX + 20, ry + 3, { size: c.textSize, color: i === 0 ? L.CSS.orange : L.CSS.cream }));
  });

  // Dialogue box with speaker, portrait, text and ▼
  const d = L.DIALOGUE;
  parts.push(img(uiUrl('ui-dialogue'), d.x, d.y));
  const np = d.namePlate;
  parts.push(text('MAYOR ORRIN', d.x + np.x, d.y + np.y + (np.h - d.nameSize) / 2 - 1, { font: L.FONTS.title, size: d.nameSize, color: L.CSS.orange, width: np.w, align: 'center' }));
  const portrait = optionalUrl('portraits/mayor.png');
  if (portrait) {
    const s = Math.round(96 * d.portraitScale);
    const p = d.portrait;
    parts.push(img(portrait, d.x + p.x + (p.w - s) / 2, d.y + p.y + p.h - s, `width:${s}px;height:${s}px`));
  }
  const tr = d.textWithPortrait;
  parts.push(text('The Warden watches over all of us. It always has. Why would anyone ever want to leave Village 07?', d.x + tr.x, d.y + tr.y, { size: d.textSize, width: tr.w, extra: `line-height:${d.textSize + d.lineSpacing}px` }));
  const a = d.arrow;
  parts.push(`<svg style="position:absolute;left:${d.x + a.x - a.w / 2}px;top:${d.y + a.y - a.h / 2}px" width="${a.w}" height="${a.h}" shape-rendering="crispEdges"><polygon points="0,0 ${a.w},0 ${a.w / 2},${a.h}" fill="${L.CSS.cream}"/></svg>`);

  const font = (pkg, file) => dataUrl(path.join(ROOT, 'node_modules/@fontsource', pkg, 'files', file), 'font/woff2');
  return `<!doctype html><html><head><style>
    @font-face { font-family: 'VT323'; src: url(${font('vt323', 'vt323-latin-400-normal.woff2')}) format('woff2'); }
    @font-face { font-family: 'Silkscreen'; src: url(${font('silkscreen', 'silkscreen-latin-400-normal.woff2')}) format('woff2'); }
    html, body { margin: 0; width: ${L.SCREEN.width}px; height: ${L.SCREEN.height}px; background: #0b0d12; overflow: hidden; }
    body { position: relative; }
    img { position: absolute; image-rendering: pixelated; }
    .t { position: absolute; white-space: pre; -webkit-font-smoothing: none; }
  </style></head><body>${parts.join('\n')}</body></html>`;
}

async function renderPreviewInChrome(html) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: L.SCREEN.width, height: L.SCREEN.height }, deviceScaleFactor: 1 });
    await page.setContent(html);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: PREVIEW });
  } finally {
    await browser.close();
  }
}

// Fallback without Chrome: textures only, no text.
async function renderPreviewWithSharp() {
  const at = (key, left, top) => ({ input: path.join(OUT_DIR, `${key}.png`), left, top });
  const slots = Array.from({ length: L.SLOT.count }, (_, i) => at(i === 0 ? 'ui-slot-selected' : 'ui-slot', L.INVENTORY.x + i * (L.SLOT.size + L.SLOT.gap), L.INVENTORY.y));
  await sharp({ create: { width: L.SCREEN.width, height: L.SCREEN.height, channels: 4, background: '#0b0d12' } })
    .composite([
      at('ui-bar-frame', L.HUD.x, L.HUD.y), at('ui-icon-heart', L.HUD.x, L.HUD.y),
      at('ui-bar-frame', L.HUD.x, L.HUD.y + L.BAR.spacing), at('ui-icon-ring', L.HUD.x, L.HUD.y + L.BAR.spacing),
      ...slots,
      at('ui-dialogue', L.DIALOGUE.x, L.DIALOGUE.y),
      at('ui-divider-orange', L.TITLE_CARD.centerX - L.DIVIDER.orange.w / 2, L.TITLE_CARD.centerY),
    ])
    .png()
    .toFile(PREVIEW);
}

async function buildPreview() {
  try {
    await renderPreviewInChrome(buildPreviewHtml());
    return 'chrome';
  } catch (err) {
    console.warn(`  (Chrome preview unavailable: ${err.message.split('\n')[0]}; using sharp fallback without text)`);
    await renderPreviewWithSharp();
    return 'sharp';
  }
}

// ---------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(PREVIEW), { recursive: true });
  const sheet = await loadImage(SHEET);

  await buildBars(sheet);
  await buildSlots(sheet);
  await buildKeyE(sheet);
  await buildDialogue(sheet);
  await buildDividers(sheet);
  await buildSmallSlot(sheet);
  await buildMinimapFrame(sheet);

  for (const t of written) console.log(`  ${t.key.padEnd(22)} ${t.width}×${t.height}  ${path.relative(ROOT, t.file)}`);
  const how = await buildPreview();
  console.log(`  preview (${how})${' '.repeat(10)} ${path.relative(ROOT, PREVIEW)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

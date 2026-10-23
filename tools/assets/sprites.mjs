// tools/assets/sprites.mjs
//
// Builds every sprite asset for THE NOMAD from the AI-generated sheets in raw-assets/:
//   public/assets/characters/<key>.png   128x144 walk sheets (32x48 frames: row0 down, row1 left, row2 up)
//   public/assets/portraits/<key>.png    96x96 head-and-shoulders portraits
//   public/assets/items/<id>.png         64x64 inventory icons
//   public/assets/items/<id>-sm.png      24x24 world pickups
//   public/assets/props/<name>.png       trimmed tile-sheet cards at native resolution
// plus visual-check previews in tools/previews/{characters,items,props}.png.
//
// Run from the project root:   node tools/assets/sprites.mjs
// The raw sheets are only read, never modified. Re-running overwrites all outputs.

import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const RAW = 'raw-assets';
const OUT = 'public/assets';
const PREVIEWS = 'tools/previews';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const ALPHA_CUTOFF = 110;      // source pixels below this alpha are background-removal leftovers
const MIN_SPECK_PX = 30;       // detached source blobs smaller than this are dropped
const OUTPUT_SPECK_PX = 3;     // detached blobs this small are dropped from downscaled frames

const FRAME_W = 32;
const FRAME_H = 48;
const FEET_Y = 46;             // lowest opaque row of every character frame
const TARGET_MEDIAN_H = 45;    // global scale makes the median frame this tall
const MAX_CHAR_W = 30;         // a character's widest frame may not exceed this
const MAX_HALF_W = 15.5;       // nothing may stick out further than this from the body centre

const PORTRAIT_SIZE = 96;
const PORTRAIT_FRACTION = 0.58; // top part of the first down frame used for the portrait
const PORTRAIT_MARGIN = 2;      // free pixels above / beside the portrait (bottom is flush)

const PREVIEW_BG = '#1a1d27';

// ---------------------------------------------------------------------------
// Sheet layouts (measured from the raw sheets)
// ---------------------------------------------------------------------------

// Characters sheet: each character is a column group holding 2 frames side by side.
const CHARACTERS = [
  { key: 'nomad', x0: 62, x1: 216 },
  { key: 'mira', x0: 236, x1: 394 },
  { key: 'kael', x0: 409, x1: 567 },
  { key: 'nova', x0: 579, x1: 734 },
  { key: 'ryn', x0: 752, x1: 912 },
  { key: 'eli', x0: 919, x1: 1076 },
  { key: 'mayor', x0: 1092, x1: 1262 },
  { key: 'villager', x0: 1279, x1: 1422 },
];
const CHAR_ROWS = [[108, 243], [245, 381], [397, 530], [536, 671], [688, 828], [845, 991]];
const LABEL_TOP = 100;  // text labels live above this y ...
const LABEL_LEFT = 62;  // ... and left of this x

// Which sheet rows make up each output row. The printed row labels are wrong:
// r1+r2 face the camera, r3+r4 are side views, r5+r6 are backs.
const DIRECTIONS = [
  { name: 'down', rows: [0, 1] },
  { name: 'left', rows: [2, 3] },
  { name: 'up', rows: [4, 5] },
];
// Side-view frames that face RIGHT in the source and get mirrored to face left, checked by eye.
// Row r3 faces left for everyone. Row r4 faces right for everyone except mira, whose r4 is a
// rear three-quarter view that already faces left.
const MIRRORED_ROWS = {
  nomad: [3], mira: [], kael: [3], nova: [3], ryn: [3], eli: [3], mayor: [3], villager: [3],
};

// Items sheet: 4x3 grid. Detached bits are assigned to the cell holding their centre.
const ITEM_IDS = [
  ['shard', 'map', 'medkit', 'water'],
  ['ration', 'core', 'journal', 'radio'],
  ['keycard', 'toolkit', 'crystal', 'medallion'],
];
const ITEM_SPLIT_X = [362, 760, 1120];
const ITEM_SPLIT_Y = [380, 722];
// At 24x24 the source's thick black outline blurs away, so world pickups get a fresh
// 1 px dark outline (drawn inside the 2 px padding) to stand out on the map.
const ITEM_SIZES = [
  { size: 64, suffix: '', outline: false },
  { size: 24, suffix: '-sm', outline: true },
];
const ITEM_PADDING = 2;
const OUTLINE_RGB = [20, 16, 18];

// Tiles sheet: 8 cols x 4 rows of cards. Cell bounds sit in the empty gutters between cards.
const PROP_NAMES = [
  'grass', 'dirt', 'stone-path', 'fence', 'flowers', 'tree', 'big-tree', 'bush',
  'signpost', 'lamp', 'market-stall', 'roof', 'wall', 'wall-window', 'wall-door', 'well',
  'asphalt', 'road', 'burning-debris', 'ruined-wall', 'wrecked-car', 'toxic-sludge', 'corrupted-ground', 'dead-tree',
  'rock-pile', 'beacon', 'portal', 'pink-cloud', 'metal-floor', 'terminal', 'hatch', 'pipe-wall',
];
const PROP_COL_STARTS = [16, 170, 323, 479, 634, 788, 943, 1098];
const PROP_CARD_W = 145;
const PROP_ROW_BANDS = [[314, 463], [481, 651], [670, 839], [860, 1027]];

// ---------------------------------------------------------------------------
// Image helpers. An "Img" is { w, h, data } with data = RGBA bytes.
// ---------------------------------------------------------------------------

function newImg(w, h) {
  return { w, h, data: Buffer.alloc(w * h * 4) };
}

async function loadImg(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { w: info.width, h: info.height, data };
}

async function savePng(img, file) {
  await mkdir(path.dirname(file), { recursive: true });
  await sharp(img.data, { raw: { width: img.w, height: img.h, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toFile(file);
}

function alphaAt(img, x, y) {
  if (x < 0 || y < 0 || x >= img.w || y >= img.h) return 0;
  return img.data[(y * img.w + x) * 4 + 3];
}

// Copy a rectangle out of an image. Parts outside the source come out transparent.
function cropImg(img, x, y, w, h) {
  const out = newImg(w, h);
  for (let row = 0; row < h; row++) {
    const sy = y + row;
    if (sy < 0 || sy >= img.h) continue;
    for (let col = 0; col < w; col++) {
      const sx = x + col;
      if (sx < 0 || sx >= img.w) continue;
      img.data.copy(out.data, (row * w + col) * 4, (sy * img.w + sx) * 4, (sy * img.w + sx) * 4 + 4);
    }
  }
  return out;
}

function flipX(img) {
  const out = newImg(img.w, img.h);
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      img.data.copy(out.data, (y * img.w + (img.w - 1 - x)) * 4, (y * img.w + x) * 4, (y * img.w + x) * 4 + 4);
    }
  }
  return out;
}

// Bounding box of all pixels with alpha > 0, or null for an empty image.
function alphaBBox(img) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if (img.data[(y * img.w + x) * 4 + 3] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function trimImg(img) {
  const box = alphaBBox(img);
  return box ? cropImg(img, box.x, box.y, box.w, box.h) : img;
}

// Resize with a quality kernel (sharp premultiplies alpha, so edges don't pick up dark fringes).
async function resizeImg(img, w, h, kernel = 'lanczos3') {
  const data = await sharp(img.data, { raw: { width: img.w, height: img.h, channels: 4 } })
    .resize(w, h, { kernel, fit: 'fill' })
    .raw()
    .toBuffer();
  return { w, h, data };
}

// Copy src onto dst at (dx, dy). Our images have binary alpha, so opaque pixels simply replace.
function blit(dst, src, dx, dy) {
  for (let y = 0; y < src.h; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= dst.h) continue;
    for (let x = 0; x < src.w; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= dst.w) continue;
      const si = (y * src.w + x) * 4;
      if (src.data[si + 3] === 0) continue;
      src.data.copy(dst.data, (ty * dst.w + tx) * 4, si, si + 4);
    }
  }
}

// Shift image content by whole pixels (used to pin feet to FEET_Y).
function shiftImg(img, dx, dy) {
  const out = newImg(img.w, img.h);
  blit(out, img, dx, dy);
  return out;
}

// Make alpha fully on or off; cleared pixels also get black RGB so PNGs compress well.
function binarizeAlpha(img, cutoff = 128) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] >= cutoff) d[i + 3] = 255;
    else d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0;
  }
  return img;
}

function clearPixel(img, p) {
  img.data.fill(0, p * 4, p * 4 + 4);
}

// ---------------------------------------------------------------------------
// Connected components (8-connected, over pixels with alpha > 0)
// ---------------------------------------------------------------------------

function findComponents(img) {
  const { w, h, data } = img;
  const labels = new Int32Array(w * h).fill(-1);
  const stack = new Int32Array(w * h);
  const comps = [];
  for (let start = 0; start < w * h; start++) {
    if (labels[start] >= 0 || data[start * 4 + 3] === 0) continue;
    const id = comps.length;
    const comp = { id, size: 0, x0: Infinity, y0: Infinity, x1: -1, y1: -1, sumX: 0, sumY: 0 };
    let top = 0;
    stack[top++] = start;
    labels[start] = id;
    while (top > 0) {
      const p = stack[--top];
      const x = p % w;
      const y = (p - x) / w;
      comp.size++;
      comp.sumX += x;
      comp.sumY += y;
      if (x < comp.x0) comp.x0 = x;
      if (x > comp.x1) comp.x1 = x;
      if (y < comp.y0) comp.y0 = y;
      if (y > comp.y1) comp.y1 = y;
      for (let ny = y - 1; ny <= y + 1; ny++) {
        if (ny < 0 || ny >= h) continue;
        for (let nx = x - 1; nx <= x + 1; nx++) {
          if (nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (labels[q] < 0 && data[q * 4 + 3] !== 0) {
            labels[q] = id;
            stack[top++] = q;
          }
        }
      }
    }
    comp.cx = comp.sumX / comp.size;
    comp.cy = comp.sumY / comp.size;
    comps.push(comp);
  }
  return { labels, comps };
}

// Clear every pixel whose component fails keep(comp).
function filterComponents(img, keep) {
  const { labels, comps } = findComponents(img);
  const drop = comps.map((c) => !keep(c));
  let dropped = 0;
  for (let p = 0; p < labels.length; p++) {
    if (labels[p] >= 0 && drop[labels[p]]) {
      clearPixel(img, p);
      dropped++;
    }
  }
  return dropped;
}

function removeSpecks(img, minSize) {
  return filterComponents(img, (c) => c.size >= minSize);
}

// ---------------------------------------------------------------------------
// Alpha clean-up for the AI sheets
// ---------------------------------------------------------------------------

function isHaloColour(r, g, b) {
  // Strongly saturated, bright red / orange / yellow (hue 340..65 degrees).
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max < 128 || max - min < 0.6 * max) return false;
  let hue;
  if (max === r) hue = (60 * ((g - b) / (max - min)) + 360) % 360;
  else if (max === g) hue = 60 * ((b - r) / (max - min)) + 120;
  else hue = 60 * ((r - g) / (max - min)) + 240;
  return hue >= 340 || hue <= 65;
}

// 1. Drop faint pixels (alpha < ALPHA_CUTOFF).
// 2. Two passes over the outer rim: knock out red/yellow halo pixels. Real sprite edges are dark
//    outlines and fully opaque, so we only remove saturated warm pixels that were also
//    semi-transparent in the source (the signature of background-removal fringe).
// 3. Make alpha binary.
// 4. Drop specks smaller than minSpeck pixels.
function cleanAlpha(img, { minSpeck = MIN_SPECK_PX } = {}) {
  const { w, h, data } = img;
  const stats = { faint: 0, halo: 0, specks: 0 };
  for (let p = 0; p < w * h; p++) {
    const a = data[p * 4 + 3];
    if (a > 0 && a < ALPHA_CUTOFF) {
      clearPixel(img, p);
      stats.faint++;
    }
  }
  for (let pass = 0; pass < 2; pass++) {
    const rim = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (data[i + 3] === 0 || data[i + 3] === 255) continue;
        const onRim = alphaAt(img, x - 1, y) === 0 || alphaAt(img, x + 1, y) === 0 ||
          alphaAt(img, x, y - 1) === 0 || alphaAt(img, x, y + 1) === 0;
        if (onRim && isHaloColour(data[i], data[i + 1], data[i + 2])) rim.push(y * w + x);
      }
    }
    for (const p of rim) clearPixel(img, p);
    stats.halo += rim.length;
  }
  binarizeAlpha(img, 1);
  stats.specks = removeSpecks(img, minSpeck);
  return stats;
}

// ---------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------

// Alpha-weighted x centre of the head + torso band (10%..60% of the figure height).
// Legs and swinging hands are left out so frames don't jitter sideways.
function bodyCentreX(img) {
  const yA = Math.floor(img.h * 0.1);
  const yB = Math.ceil(img.h * 0.6);
  let sum = 0, n = 0;
  for (let y = yA; y < yB; y++) {
    for (let x = 0; x < img.w; x++) {
      if (img.data[(y * img.w + x) * 4 + 3]) {
        sum += x;
        n++;
      }
    }
  }
  return n ? (sum + n * 0.5) / n : img.w / 2; // +0.5 => centre of the pixel
}

// Column (absolute x) with the fewest opaque pixels in the middle of a group, inside one row band.
function findSplitColumn(sheet, x0, x1, y0, y1) {
  const width = x1 - x0 + 1;
  const lo = x0 + Math.floor(width * 0.35);
  const hi = x0 + Math.ceil(width * 0.65);
  const mid = (x0 + x1) / 2;
  let best = lo, bestCount = Infinity;
  for (let x = lo; x <= hi; x++) {
    let count = 0;
    for (let y = y0; y <= y1; y++) if (alphaAt(sheet, x, y)) count++;
    // Fewest pixels wins; ties go to the column closest to the middle.
    if (count < bestCount || (count === bestCount && Math.abs(x - mid) < Math.abs(best - mid))) {
      best = x;
      bestCount = count;
    }
  }
  return best;
}

// Cut all 48 source frames out of the cleaned characters sheet.
function extractCharacterFrames(sheet) {
  // Cell edges sit halfway across the empty gutters between groups / rows.
  const groupEdges = [0];
  for (let i = 1; i < CHARACTERS.length; i++) {
    groupEdges.push(Math.round((CHARACTERS[i - 1].x1 + CHARACTERS[i].x0) / 2));
  }
  groupEdges.push(sheet.w);
  const rowEdges = [LABEL_TOP];
  for (let i = 1; i < CHAR_ROWS.length; i++) rowEdges.push(Math.round((CHAR_ROWS[i - 1][1] + CHAR_ROWS[i][0]) / 2));
  rowEdges.push(sheet.h);

  const result = {};
  CHARACTERS.forEach((ch, gi) => {
    const rows = CHAR_ROWS.map((band, ri) => {
      const cy0 = rowEdges[ri];
      const cy1 = rowEdges[ri + 1] - 1;
      const split = findSplitColumn(sheet, ch.x0, ch.x1, band[0], band[1]);
      const cells = [[groupEdges[gi], split - 1], [split + 1, groupEdges[gi + 1] - 1]];
      return cells.map(([cx0, cx1]) => {
        const img = cropImg(sheet, cx0, cy0, cx1 - cx0 + 1, cy1 - cy0 + 1);
        removeSpecks(img, MIN_SPECK_PX); // slivers left by a straight cut between touching frames
        return trimImg(img);
      });
    });
    result[ch.key] = rows;
  });
  return result;
}

// Render one source frame into a 32x48 cell: body centre at x=16, feet on FEET_Y.
async function renderFrame(src, scale) {
  const k = 1 / scale; // source pixels per output pixel
  const anchorX = bodyCentreX(src);
  const winW = Math.round(FRAME_W * k);
  const winH = Math.round(FRAME_H * k);
  const left = Math.round(anchorX - (FRAME_W / 2) * k);
  const top = Math.round(src.h - (FEET_Y + 1) * k);
  const window = cropImg(src, left, top, winW, winH);
  const frame = binarizeAlpha(await resizeImg(window, FRAME_W, FRAME_H, 'lanczos3'));
  removeSpecks(frame, OUTPUT_SPECK_PX);
  // Pin the lowest opaque row exactly on FEET_Y.
  const box = alphaBBox(frame);
  const dy = FEET_Y - (box.y + box.h - 1);
  return dy ? shiftImg(frame, 0, dy) : frame;
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function buildCharacters() {
  const sheet = await loadImg(path.join(RAW, 'characters-sheet.png'));
  const stats = cleanAlpha(sheet);
  // Drop the printed labels (components that live entirely in the label margins).
  filterComponents(sheet, (c) => !(c.y1 < LABEL_TOP || c.x1 < LABEL_LEFT));
  console.log(`characters: removed ${stats.faint} faint, ${stats.halo} halo, ${stats.specks} speck pixels`);

  const frames = extractCharacterFrames(sheet);

  // Assemble each direction's 4 source frames (a, b of the first row, then a, b of the second),
  // mirroring the right-facing side rows so every "left" frame faces left.
  const perChar = {};
  for (const ch of CHARACTERS) {
    const mirrored = MIRRORED_ROWS[ch.key];
    perChar[ch.key] = DIRECTIONS.map((dir) =>
      dir.rows.flatMap((ri) => frames[ch.key][ri].map((img) => (mirrored.includes(ri) ? flipX(img) : img))));
  }

  // One global scale from the median frame height keeps relative character heights.
  const allHeights = Object.values(perChar).flat(2).map((img) => img.h);
  const globalScale = TARGET_MEDIAN_H / median(allHeights);
  console.log(`characters: median source height ${median(allHeights)}, global scale ${globalScale.toFixed(4)}`);

  const report = {};
  const sheets = {};
  for (const ch of CHARACTERS) {
    const dirs = perChar[ch.key];
    const all = dirs.flat();
    // The source draws some rows a few pixels taller than others (back views especially).
    // Every frame is normalised to this character's median height, so the head stays on
    // the same row in every frame and the character doesn't change size when turning.
    const charH = median(all.map((img) => img.h));
    const stretch = (img) => charH / img.h;
    // Shrink this character if its widest frame (or any part, measured from the body
    // centre) would not fit, or if it would be too tall for the frame.
    const maxW = Math.max(...all.map((img) => img.w * stretch(img)));
    const maxHalf = Math.max(...all.map((img) => {
      const cx = bodyCentreX(img);
      return Math.max(cx, img.w - cx) * stretch(img);
    }));
    const scale = Math.min(globalScale, MAX_CHAR_W / maxW, MAX_HALF_W / maxHalf, FEET_Y / charH);

    const out = newImg(FRAME_W * 4, FRAME_H * 3);
    const rowInfo = [];
    for (let d = 0; d < dirs.length; d++) {
      const tops = [];
      for (let f = 0; f < 4; f++) {
        const src = dirs[d][f];
        const frame = await renderFrame(src, scale * stretch(src));
        blit(out, frame, f * FRAME_W, d * FRAME_H);
        const box = alphaBBox(frame);
        tops.push(box.y);
        // Anything touching the frame edge was probably clipped by the 32x48 window.
        if (box.x === 0 || box.x + box.w === FRAME_W || box.y === 0) {
          console.warn(`  WARNING ${ch.key} ${DIRECTIONS[d].name} frame ${f} touches the frame edge`);
        }
      }
      rowInfo.push(`${DIRECTIONS[d].name}: tops ${tops.join('/')}`);
    }
    sheets[ch.key] = out;
    const limit = scale === globalScale ? 'global' : 'shrunk to fit width';
    report[ch.key] = { scale: `${scale.toFixed(4)} (${limit})`, rows: rowInfo.join(', ') };
    await savePng(out, path.join(OUT, 'characters', `${ch.key}.png`));

    await savePng(await buildPortrait(frames[ch.key][0][0]), path.join(OUT, 'portraits', `${ch.key}.png`));
  }
  for (const [key, r] of Object.entries(report)) console.log(`  ${key.padEnd(9)} scale ${r.scale}  ${r.rows}`);
  return sheets;
}

// Head and shoulders from the first down frame at source resolution, fitted into 96x96.
async function buildPortrait(frame) {
  const bust = trimImg(cropImg(frame, 0, 0, frame.w, Math.round(frame.h * PORTRAIT_FRACTION)));
  const room = PORTRAIT_SIZE - PORTRAIT_MARGIN;
  const fit = Math.min((PORTRAIT_SIZE - 2 * PORTRAIT_MARGIN) / bust.w, room / bust.h);
  const w = Math.round(bust.w * fit);
  const h = Math.round(bust.h * fit);
  const scaled = binarizeAlpha(await resizeImg(bust, w, h, 'lanczos3'));
  const out = newImg(PORTRAIT_SIZE, PORTRAIT_SIZE);
  blit(out, scaled, Math.round((PORTRAIT_SIZE - w) / 2), PORTRAIT_SIZE - h); // bottom-aligned
  return out;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

// Fit an image inside size x size (minus padding), centred, with crisp alpha.
async function containInSquare(img, size, padding) {
  const room = size - 2 * padding;
  const fit = Math.min(room / img.w, room / img.h);
  const w = Math.max(1, Math.round(img.w * fit));
  const h = Math.max(1, Math.round(img.h * fit));
  const scaled = binarizeAlpha(await resizeImg(img, w, h, 'lanczos3'));
  const out = newImg(size, size);
  blit(out, scaled, Math.floor((size - w) / 2), Math.floor((size - h) / 2));
  return out;
}

// Paint every transparent pixel that touches the silhouette (4-neighbour) in a dark colour.
function addOutline(img, [r, g, b]) {
  const out = { w: img.w, h: img.h, data: Buffer.from(img.data) };
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if (alphaAt(img, x, y)) continue;
      const touches = alphaAt(img, x - 1, y) || alphaAt(img, x + 1, y) || alphaAt(img, x, y - 1) || alphaAt(img, x, y + 1);
      if (!touches) continue;
      const i = (y * img.w + x) * 4;
      out.data[i] = r;
      out.data[i + 1] = g;
      out.data[i + 2] = b;
      out.data[i + 3] = 255;
    }
  }
  return out;
}

// Split a cleaned sheet into grid cells: each blob goes to the cell containing its centre,
// so floating chips and sparkles stay with their item even if they cross a split line.
function splitByCells(sheet, xEdges, yEdges) {
  const { labels, comps } = findComponents(sheet);
  const cellOf = (v, edges) => edges.filter((e) => v >= e).length;
  const cols = xEdges.length + 1;
  const cells = Array.from({ length: cols * (yEdges.length + 1) }, () => []);
  for (const c of comps) cells[cellOf(c.cy, yEdges) * cols + cellOf(c.cx, xEdges)].push(c.id);
  return cells.map((ids) => {
    const keep = new Set(ids);
    const img = newImg(sheet.w, sheet.h);
    for (let p = 0; p < labels.length; p++) {
      if (keep.has(labels[p])) sheet.data.copy(img.data, p * 4, p * 4, p * 4 + 4);
    }
    return trimImg(img);
  });
}

async function buildItems() {
  const sheet = await loadImg(path.join(RAW, 'items-sheet.png'));
  const stats = cleanAlpha(sheet);
  console.log(`items: removed ${stats.faint} faint, ${stats.halo} halo, ${stats.specks} speck pixels`);
  const cells = splitByCells(sheet, ITEM_SPLIT_X, ITEM_SPLIT_Y);
  const ids = ITEM_IDS.flat();
  const result = {};
  for (let i = 0; i < ids.length; i++) {
    result[ids[i]] = {};
    for (const { size, suffix, outline } of ITEM_SIZES) {
      let icon = await containInSquare(cells[i], size, ITEM_PADDING);
      if (outline) icon = addOutline(icon, OUTLINE_RGB);
      result[ids[i]][size] = icon;
      await savePng(icon, path.join(OUT, 'items', `${ids[i]}${suffix}.png`));
    }
  }
  console.log(`items: wrote ${ids.length * ITEM_SIZES.length} icons`);
  return result;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

async function buildProps() {
  const sheet = await loadImg(path.join(RAW, 'tiles-sheet.png'));
  const stats = cleanAlpha(sheet);
  console.log(`props: removed ${stats.faint} faint, ${stats.halo} halo, ${stats.specks} speck pixels`);
  // Cell edges halfway between neighbouring cards (the roof card pokes above its row,
  // which the half-gutter row edge still contains).
  const xEdges = PROP_COL_STARTS.slice(1).map((s, i) => Math.round((PROP_COL_STARTS[i] + PROP_CARD_W + s) / 2));
  const yEdges = PROP_ROW_BANDS.slice(1).map((band, i) => Math.round((PROP_ROW_BANDS[i][1] + band[0]) / 2));
  const cells = splitByCells(sheet, xEdges, yEdges);
  const result = {};
  for (let i = 0; i < PROP_NAMES.length; i++) {
    result[PROP_NAMES[i]] = cells[i];
    await savePng(cells[i], path.join(OUT, 'props', `${PROP_NAMES[i]}.png`));
  }
  console.log(`props: wrote ${PROP_NAMES.length} props`);
  return result;
}

// ---------------------------------------------------------------------------
// Previews (for visual checks only; not loaded by the game)
// ---------------------------------------------------------------------------

function escapeXml(s) {
  return s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
}

function svgText(x, y, text, size = 14, fill = '#efe6d2') {
  return `<text x="${x}" y="${y}" font-family="Menlo, monospace" font-size="${size}" fill="${fill}">${escapeXml(text)}</text>`;
}

async function pngBuffer(img, scale = 1) {
  return sharp(img.data, { raw: { width: img.w, height: img.h, channels: 4 } })
    .resize(img.w * scale, img.h * scale, { kernel: 'nearest' })
    .png()
    .toBuffer();
}

async function writePreview(file, width, height, layers, svgParts) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${svgParts.join('')}</svg>`;
  await mkdir(path.dirname(file), { recursive: true });
  await sharp({ create: { width, height, channels: 4, background: PREVIEW_BG } })
    .composite([...layers, { input: Buffer.from(svg), left: 0, top: 0 }])
    .png()
    .toFile(file);
}

// Every character sheet at 4x with the 32x48 grid, the feet line and row labels.
async function previewCharacters(sheets) {
  const S = 4;
  const sheetW = FRAME_W * 4 * S;
  const sheetH = FRAME_H * 3 * S;
  const labelW = 56;
  const cellW = labelW + sheetW + 24;
  const cellH = sheetH + 40;
  const cols = 4;
  const keys = Object.keys(sheets);
  const width = cols * cellW;
  const height = Math.ceil(keys.length / cols) * cellH;
  const layers = [];
  const svg = [];
  for (let i = 0; i < keys.length; i++) {
    const ox = (i % cols) * cellW + labelW;
    const oy = Math.floor(i / cols) * cellH + 30;
    layers.push({ input: await pngBuffer(sheets[keys[i]], S), left: ox, top: oy });
    svg.push(svgText(ox, oy - 10, keys[i], 18));
    for (let r = 0; r < 3; r++) {
      svg.push(svgText(ox - labelW + 4, oy + r * FRAME_H * S + FRAME_H * S / 2, DIRECTIONS[r].name, 14, '#f0a030'));
      const feet = oy + r * FRAME_H * S + (FEET_Y + 1) * S;
      svg.push(`<line x1="${ox}" y1="${feet}" x2="${ox + sheetW}" y2="${feet}" stroke="#3ad4e8" stroke-opacity="0.5" stroke-width="1"/>`);
    }
    for (let c = 0; c <= 4; c++) {
      const x = ox + c * FRAME_W * S;
      svg.push(`<line x1="${x}" y1="${oy}" x2="${x}" y2="${oy + sheetH}" stroke="#6b4a33" stroke-width="1"/>`);
    }
    for (let r = 0; r <= 3; r++) {
      const y = oy + r * FRAME_H * S;
      svg.push(`<line x1="${ox}" y1="${y}" x2="${ox + sheetW}" y2="${y}" stroke="#6b4a33" stroke-width="1"/>`);
    }
  }
  await writePreview(path.join(PREVIEWS, 'characters.png'), width, height, layers, svg);
}

// Both icon sizes of every item: 64x64 at 2x and 1x, 24x24 at 4x and 1x.
async function previewItems(items) {
  const cellW = 330;
  const cellH = 170;
  const cols = 4;
  const ids = Object.keys(items);
  const layers = [];
  const svg = [];
  for (let i = 0; i < ids.length; i++) {
    const ox = (i % cols) * cellW + 10;
    const oy = Math.floor(i / cols) * cellH + 24;
    svg.push(svgText(ox, oy - 8, `${ids[i]}  (64 @2x | 24 @4x | 1x)`, 13));
    svg.push(`<rect x="${ox - 0.5}" y="${oy - 0.5}" width="129" height="129" fill="none" stroke="#6b4a33"/>`);
    layers.push({ input: await pngBuffer(items[ids[i]][64], 2), left: ox, top: oy });
    svg.push(`<rect x="${ox + 139.5}" y="${oy - 0.5}" width="97" height="97" fill="none" stroke="#6b4a33"/>`);
    layers.push({ input: await pngBuffer(items[ids[i]][24], 4), left: ox + 140, top: oy });
    layers.push({ input: await pngBuffer(items[ids[i]][64], 1), left: ox + 248, top: oy });
    layers.push({ input: await pngBuffer(items[ids[i]][24], 1), left: ox + 248, top: oy + 74 });
  }
  await writePreview(path.join(PREVIEWS, 'items.png'), cols * cellW, Math.ceil(ids.length / cols) * cellH, layers, svg);
}

// Every prop at native size with its name and dimensions.
async function previewProps(props) {
  const cellW = 170;
  const cellH = 220;
  const cols = 8;
  const names = Object.keys(props);
  const layers = [];
  const svg = [];
  for (let i = 0; i < names.length; i++) {
    const img = props[names[i]];
    const ox = (i % cols) * cellW + 8;
    const oy = Math.floor(i / cols) * cellH + 8;
    svg.push(svgText(ox, oy + 12, names[i], 12));
    svg.push(svgText(ox, oy + 26, `${img.w}x${img.h}`, 11, '#9a8f7c'));
    layers.push({ input: await pngBuffer(img, 1), left: ox, top: oy + 32 });
  }
  await writePreview(path.join(PREVIEWS, 'props.png'), cols * cellW, Math.ceil(names.length / cols) * cellH, layers, svg);
}

// ---------------------------------------------------------------------------

async function main() {
  const sheets = await buildCharacters();
  await previewCharacters(sheets);
  const items = await buildItems();
  await previewItems(items);
  const props = await buildProps();
  await previewProps(props);
  console.log('sprites: done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

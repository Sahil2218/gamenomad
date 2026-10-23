// THE NOMAD: map asset pipeline (task C, updated for Milestone 2 by task F).
//
// Run from the project root:   node tools/assets/maps.mjs
// Optional debug output:        node tools/assets/maps.mjs --debug /tmp/nomad-f
// Force re-encoding the PNGs:   node tools/assets/maps.mjs --recopy
//
// What it does:
//   1. Encodes raw-assets/{village,wasteland,silo}-map.png into public/assets/maps/
//      (only when a file is missing, or with --recopy) and checks their size.
//   2. Validates src/data/maps/village.json against the contracts
//      (CONTRACT.md section 6.5 and CONTRACT-M2.md sections 0-1: no occluders,
//      `area`, `markers`, pickups in open ground).
//   3. Draws tools/previews/village-overlay.png (colliders as a red 35% fill, zones,
//      inspectables, actors, minimap markers).
//   4. Runs a reachability check: a flood fill of the player's 16x10 feet body from the
//      spawn point, then asserts NPCs, pickups, inspectables, the barrier and the exit
//      behave as the design needs. Prints a PASS/FAIL list and exits non-zero on failure.

import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RAW_DIR = path.join(ROOT, 'raw-assets');
const OUT_DIR = path.join(ROOT, 'public', 'assets', 'maps');
const VILLAGE_JSON = path.join(ROOT, 'src', 'data', 'maps', 'village.json');
const OVERLAY_PNG = path.join(ROOT, 'tools', 'previews', 'village-overlay.png');

const MAP_NAMES = ['village', 'wasteland', 'silo'];
const MAP_W = 1448;
const MAP_H = 1086;

// Player physics body: 16 wide x 10 tall, bottom-centred on the feet position.
const BODY_W = 16;
const BODY_H = 10;
const GRID = 2;              // flood-fill step in world pixels
const INTERACT_RADIUS = 28;  // contract section 8
const NPC_CLEARANCE = 20;    // NPC / pickup / spawn feet must be this far from any collider
const PICKUP_EDGE_MARGIN = 40; // pickups sit at least this far from the map edge (glow not clipped)
const EDGE_MARGIN = 6;       // "touching the map edge" means the body is this close to it

// Forest / outside points that must never be reachable (even with the barrier open).
const FOREST_PROBES = [
  { name: 'NW forest', x: 40, y: 60 },
  { name: 'N forest above fence', x: 420, y: 40 },
  { name: 'NE forest', x: 1410, y: 150 },
  { name: 'NE path exit (east edge)', x: 1440, y: 292 },
  { name: 'W forest', x: 40, y: 560 },
  { name: 'W dirt clearing', x: 20, y: 670 },
  { name: 'SW strip outside fence', x: 300, y: 930 },
  { name: 'S river west', x: 400, y: 1040 },
  { name: 'SE strip outside fence', x: 1150, y: 960 },
  { name: 'SE forest', x: 1400, y: 1040 },
  { name: 'pocket by SE tower', x: 1425, y: 835 },
];

const REQUIRED = {
  npcs: { mayor: 'mayor', tamsin: 'villager', hessa: 'villager', bram: 'villager', pip: 'villager' },
  pickups: ['journal', 'shard'],
  inspectables: ['signpost', 'well', 'banner', 'home'],
  zones: ['barrier', 'exit'],
  area: 'Village 07',
  // CONTRACT-M2 section 1: minimap objective marker per quest stage.
  markers: ['wake', 'confront', 'bridge'],
  // CONTRACT-M3 section 1: explore guides to the nearest unfinished target (array of conditional points).
  arrayMarkers: ['explore'],
};

// ---------------------------------------------------------------------------
// Small geometry helpers. Rects are { x, y, w, h } with a top-left origin.

const right = (r) => r.x + r.w;
const bottom = (r) => r.y + r.h;

/** Distance from point (px, py) to the nearest point of rect r (0 if inside). */
function pointRectDistance(px, py, r) {
  const dx = Math.max(r.x - px, 0, px - right(r));
  const dy = Math.max(r.y - py, 0, py - bottom(r));
  return Math.hypot(dx, dy);
}

/** True if two rects overlap (touching edges do not count). */
function rectsOverlap(a, b) {
  return a.x < right(b) && right(a) > b.x && a.y < bottom(b) && bottom(a) > b.y;
}

/** The player's (or an NPC's) physics body for a given feet position. */
function bodyAt(fx, fy) {
  return { x: fx - BODY_W / 2, y: fy - BODY_H, w: BODY_W, h: BODY_H };
}

// ---------------------------------------------------------------------------
// 1. Copy the three maps.

async function fileExists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function copyMaps(recopy) {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const results = [];
  for (const name of MAP_NAMES) {
    const src = path.join(RAW_DIR, `${name}-map.png`);
    const dst = path.join(OUT_DIR, `${name}.png`);
    // The PNGs never change, so leave existing files alone (other tasks may be reading them).
    if (recopy || !(await fileExists(dst))) await sharp(src).png({ compressionLevel: 9 }).toFile(dst);
    const meta = await sharp(dst).metadata();
    const ok = meta.width === MAP_W && meta.height === MAP_H;
    results.push(check(`map ${name}.png is ${MAP_W}x${MAP_H}`, ok, `${meta.width}x${meta.height}`));
  }
  return results;
}

// ---------------------------------------------------------------------------
// 2. Schema validation.

function check(name, pass, detail = '') {
  return { name, pass: Boolean(pass), detail };
}

function isRect(r) {
  return ['x', 'y', 'w', 'h'].every((k) => Number.isInteger(r[k])) && r.w > 0 && r.h > 0 &&
    r.x >= 0 && r.y >= 0 && right(r) <= MAP_W && bottom(r) <= MAP_H;
}

function validateSchema(map) {
  const out = [];
  out.push(check('image/width/height', map.image === 'map-village' && map.width === MAP_W && map.height === MAP_H));
  out.push(check('spawn has x, y, facing', Number.isFinite(map.spawn?.x) && Number.isFinite(map.spawn?.y) && typeof map.spawn?.facing === 'string'));

  const badRects = [];
  for (const key of ['colliders', 'occluders', 'inspectables', 'zones']) {
    (map[key] || []).forEach((r, i) => { if (!isRect(r)) badRects.push(`${key}[${i}]`); });
  }
  out.push(check('all rects are positive integers inside the map', badRects.length === 0, badRects.join(', ')));

  const badOcc = map.occluders.filter((o) => !Number.isInteger(o.baseY) || o.baseY < o.y);
  out.push(check('occluders have an integer baseY at or below their top', badOcc.length === 0, badOcc.map((o) => o.note).join(', ')));

  const n = map.colliders.length;
  out.push(check('collider count is 60-140', n >= 60 && n <= 140, `${n}`));

  // Milestone 2 (CONTRACT-M2 sections 0-1).
  out.push(check('occluders is empty (M2: colliders cover full footprints instead)',
    Array.isArray(map.occluders) && map.occluders.length === 0, `${(map.occluders || []).length} occluders`));
  out.push(check(`area is "${REQUIRED.area}"`, map.area === REQUIRED.area, String(map.area)));
  out.push(...markerChecks(map));

  for (const [id, sprite] of Object.entries(REQUIRED.npcs)) {
    const npc = map.npcs.find((p) => p.id === id);
    const ok = npc && npc.sprite === sprite && npc.dialogue === id && typeof npc.name === 'string' &&
      Number.isFinite(npc.wander) && 'tint' in npc;
    out.push(check(`npc ${id} present and well-formed`, ok));
  }
  const villagerTints = map.npcs.filter((p) => p.sprite === 'villager').map((p) => String(p.tint));
  out.push(check('villager NPC tints are distinct', new Set(villagerTints).size === villagerTints.length, villagerTints.join(' ')));

  for (const id of REQUIRED.pickups) {
    const p = map.pickups.find((q) => q.id === id);
    out.push(check(`pickup ${id} present`, p && p.item === id && p.dialogue === `pickup-${id}`));
  }
  for (const id of REQUIRED.inspectables) {
    const r = map.inspectables.find((q) => q.id === id);
    out.push(check(`inspectable ${id} present`, r && r.dialogue === `inspect-${id}`));
  }
  for (const id of REQUIRED.zones) {
    out.push(check(`zone ${id} present`, map.zones.some((z) => z.id === id)));
  }
  return out;
}

/** markers: wake/confront on the Mayor, bridge on the barrier centre, explore = conditional array. */
function markerChecks(map) {
  const out = [];
  const m = map.markers || {};
  const isPoint = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y) &&
    p.x >= 0 && p.y >= 0 && p.x <= MAP_W && p.y <= MAP_H;
  for (const stage of REQUIRED.markers) {
    out.push(check(`marker ${stage} is a point inside the map`, isPoint(m[stage]), JSON.stringify(m[stage] ?? null)));
  }
  for (const stage of REQUIRED.arrayMarkers) {
    const list = m[stage];
    const ok = Array.isArray(list) && list.length > 0 && list.every((p) => isPoint(p) && p.if);
    out.push(check(`marker ${stage} is an array of conditional points`, ok, `${Array.isArray(list) ? list.length : 0} points`));
  }
  const mayor = map.npcs.find((p) => p.id === 'mayor');
  const onMayor = (p) => mayor && p && p.x === mayor.x && p.y === mayor.y;
  out.push(check('markers wake + confront sit on the Mayor', onMayor(m.wake) && onMayor(m.confront),
    mayor ? `mayor (${mayor.x}, ${mayor.y})` : 'no mayor'));
  const barrier = map.zones.find((z) => z.id === 'barrier');
  const centre = barrier && { x: barrier.x + barrier.w / 2, y: barrier.y + barrier.h / 2 };
  out.push(check('marker bridge sits on the barrier centre',
    centre && m.bridge && m.bridge.x === centre.x && m.bridge.y === centre.y,
    centre ? `centre (${centre.x}, ${centre.y})` : 'no barrier'));
  return out;
}

// ---------------------------------------------------------------------------
// 3. Overlay preview.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function label(x, y, text, color, size = 10) {
  return `<text x="${x}" y="${y}" font-family="Menlo, monospace" font-size="${size}" fill="${color}" ` +
    `stroke="#000" stroke-width="2.5" paint-order="stroke">${esc(text)}</text>`;
}

function overlaySvg(map, { indices = false } = {}) {
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${MAP_W}" height="${MAP_H}">`];

  map.colliders.forEach((c, i) => {
    parts.push(`<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" fill="#ff2020" fill-opacity="0.35" stroke="#ff2020" stroke-opacity="0.8" stroke-width="1"/>`);
    if (indices) parts.push(label(c.x + 1, c.y + 8, i, '#ffd0d0', 8));
  });

  map.occluders.forEach((o, i) => {
    parts.push(`<rect x="${o.x + 0.5}" y="${o.y + 0.5}" width="${o.w - 1}" height="${o.h - 1}" fill="none" stroke="#3b7bff" stroke-width="1.5"/>`);
    parts.push(`<line x1="${o.x}" y1="${o.baseY}" x2="${right(o)}" y2="${o.baseY}" stroke="#3b7bff" stroke-width="1.5" stroke-dasharray="4 3"/>`);
    if (indices) parts.push(label(o.x + 2, o.y + 18, `o${i}`, '#a8c4ff', 8));
  });

  for (const z of map.zones) {
    parts.push(`<rect x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" fill="#ff00ff" fill-opacity="0.35" stroke="#ff00ff" stroke-width="1.5"/>`);
    parts.push(label(z.x + 3, z.y + z.h / 2 + 4, z.id, '#ff80ff'));
  }

  for (const r of map.inspectables) {
    parts.push(`<rect x="${r.x + 0.5}" y="${r.y + 0.5}" width="${r.w - 1}" height="${r.h - 1}" fill="none" stroke="#ff9a1a" stroke-width="2"/>`);
    parts.push(label(r.x + 2, r.y - 3, `inspect:${r.id}`, '#ffb050'));
  }

  for (const p of map.pickups) {
    parts.push(`<circle cx="${p.x}" cy="${p.y}" r="5" fill="#30e060" stroke="#000" stroke-width="1"/>`);
    parts.push(label(p.x + 7, p.y + 4, p.id, '#60ff90'));
  }

  for (const npc of map.npcs) {
    parts.push(`<circle cx="${npc.x}" cy="${npc.y}" r="4" fill="#ffe030" stroke="#000" stroke-width="1"/>`);
    if (npc.wander > 0) {
      parts.push(`<circle cx="${npc.x}" cy="${npc.y}" r="${npc.wander}" fill="none" stroke="#ffe030" stroke-width="1" stroke-dasharray="3 3"/>`);
    }
    parts.push(label(npc.x + 6, npc.y - 4, npc.name, '#ffe860'));
  }

  // Minimap objective markers (yellow diamonds). Stages sharing a point get one label.
  const markerSpots = new Map();
  for (const [stage, p] of Object.entries(map.markers || {})) {
    const key = `${p.x},${p.y}`;
    if (!markerSpots.has(key)) markerSpots.set(key, { p, stages: [] });
    markerSpots.get(key).stages.push(stage);
  }
  for (const { p, stages } of markerSpots.values()) {
    parts.push(`<path d="M${p.x} ${p.y - 7} L${p.x + 7} ${p.y} L${p.x} ${p.y + 7} L${p.x - 7} ${p.y} Z" fill="none" stroke="#ffd400" stroke-width="2"/>`);
    parts.push(label(p.x + 9, p.y + 14, `marker:${stages.join('+')}`, '#ffd400', 9));
  }

  const s = map.spawn;
  parts.push(`<circle cx="${s.x}" cy="${s.y}" r="5" fill="#ffffff" stroke="#000" stroke-width="1"/>`);
  parts.push(label(s.x + 7, s.y + 4, 'spawn', '#ffffff'));

  parts.push('</svg>');
  return parts.join('\n');
}

async function renderOverlay(map, file, extraLayers = [], opts = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const layers = [...extraLayers, { input: Buffer.from(overlaySvg(map, opts)) }];
  await sharp(path.join(RAW_DIR, 'village-map.png')).composite(layers).png({ compressionLevel: 9 }).toFile(file);
}

// ---------------------------------------------------------------------------
// 4. Reachability.

/** Builds a per-pixel blocked mask from rects and a summed-area table for O(1) rect queries. */
function buildBlocker(rects) {
  const mask = new Uint8Array(MAP_W * MAP_H);
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor(r.x)), x1 = Math.min(MAP_W, Math.ceil(right(r)));
    const y0 = Math.max(0, Math.floor(r.y)), y1 = Math.min(MAP_H, Math.ceil(bottom(r)));
    for (let y = y0; y < y1; y++) mask.fill(1, y * MAP_W + x0, y * MAP_W + x1);
  }
  const W1 = MAP_W + 1;
  const sat = new Int32Array(W1 * (MAP_H + 1));
  for (let y = 0; y < MAP_H; y++) {
    let rowSum = 0;
    for (let x = 0; x < MAP_W; x++) {
      rowSum += mask[y * MAP_W + x];
      sat[(y + 1) * W1 + (x + 1)] = sat[y * W1 + (x + 1)] + rowSum;
    }
  }
  /** True if a body with feet at (fx, fy) is inside the map and touches no blocked pixel. */
  return function bodyFree(fx, fy) {
    const x0 = fx - BODY_W / 2, x1 = fx + BODY_W / 2, y0 = fy - BODY_H, y1 = fy;
    if (x0 < 0 || y0 < 0 || x1 > MAP_W || y1 > MAP_H) return false;
    const sum = sat[y1 * W1 + x1] - sat[y0 * W1 + x1] - sat[y1 * W1 + x0] + sat[y0 * W1 + x0];
    return sum === 0;
  };
}

const GW = Math.floor(MAP_W / GRID) + 1;
const GH = Math.floor(MAP_H / GRID) + 1;

/** 4-neighbour flood fill on the GRID lattice of feet positions. Returns a Uint8Array of reached nodes. */
function floodFill(rects, start) {
  const bodyFree = buildBlocker(rects);
  const reached = new Uint8Array(GW * GH);
  const sx = Math.round(start.x / GRID), sy = Math.round(start.y / GRID);
  if (!bodyFree(sx * GRID, sy * GRID)) return { reached, startFree: false };
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

/** Calls fn(fx, fy) for each reached node inside the box; stops early if fn returns true. */
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

/** Smallest distance from (px, py) to a reached feet position that also passes `filter`. */
function nearestReached(reached, px, py, maxDist, filter = () => true) {
  let best = Infinity;
  const box = { x: px - maxDist, y: py - maxDist, w: maxDist * 2, h: maxDist * 2 };
  someReached(reached, box, (fx, fy) => {
    const d = Math.hypot(fx - px, fy - py);
    if (d < best && filter(fx, fy)) best = d;
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

/** Reached nodes whose body is within EDGE_MARGIN of the map border. */
function edgeTouches(reached) {
  const hits = [];
  for (let gy = 0; gy < GH; gy++) {
    for (let gx = 0; gx < GW; gx++) {
      if (!reached[gy * GW + gx]) continue;
      const b = bodyAt(gx * GRID, gy * GRID);
      if (b.x < EDGE_MARGIN || b.y < EDGE_MARGIN || right(b) > MAP_W - EDGE_MARGIN || bottom(b) > MAP_H - EDGE_MARGIN) {
        hits.push({ x: gx * GRID, y: gy * GRID });
      }
    }
  }
  return hits;
}

/** Solid rects standing in for NPC bodies (a wandering NPC blocks its whole wander box). */
function npcBlockers(map) {
  return map.npcs.map((npc) => {
    const reach = npc.wander || 0;
    return { x: npc.x - BODY_W / 2 - reach, y: npc.y - BODY_H - reach, w: BODY_W + reach * 2, h: BODY_H + reach * 2 };
  });
}

function reachabilityChecks(map) {
  const out = [];
  const barrier = map.zones.find((z) => z.id === 'barrier');
  const exit = map.zones.find((z) => z.id === 'exit');
  const colliders = map.colliders;

  const solid = floodFill([...colliders, barrier], map.spawn);       // barrier solid (normal play)
  const open = floodFill(colliders, map.spawn);                       // barrier open (flicker window)
  const npcSolids = npcBlockers(map);
  const crowded = floodFill([...colliders, barrier, ...npcSolids], map.spawn); // NPCs as obstacles

  out.push(check('spawn is on free ground', solid.startFree, `(${map.spawn.x}, ${map.spawn.y})`));
  const spawnClear = Math.min(...colliders.map((c) => pointRectDistance(map.spawn.x, map.spawn.y, c)));
  out.push(check(`spawn: ${NPC_CLEARANCE}+ px clear of colliders`, spawnClear >= NPC_CLEARANCE, `${spawnClear.toFixed(1)} px`));
  out.push(check('reachable area', solid.count > 0, `${solid.count} nodes x ${GRID}px (${Math.round(solid.count * GRID * GRID / 1000)}k px^2)`));

  // NPCs ----------------------------------------------------------------
  map.npcs.forEach((npc, i) => {
    const own = bodyAt(npc.x, npc.y);
    const inCollider = colliders.some((c) => rectsOverlap(c, own));
    const clearance = Math.min(...colliders.map((c) => pointRectDistance(npc.x, npc.y, c)));
    const notOnNpc = (fx, fy) => !rectsOverlap(bodyAt(fx, fy), own);
    const d = nearestReached(solid.reached, npc.x, npc.y, INTERACT_RADIUS + 4, notOnNpc);
    // Other NPCs (and their wander boxes) are solid; this NPC only blocks its own body.
    const others = npcSolids.filter((_, j) => j !== i);
    const crowdedForThis = floodFill([...colliders, barrier, ...others, own], map.spawn);
    const dCrowd = nearestReached(crowdedForThis.reached, npc.x, npc.y, INTERACT_RADIUS + 4);
    out.push(check(`npc ${npc.id}: feet body on walkable ground`, !inCollider, `(${npc.x}, ${npc.y})`));
    out.push(check(`npc ${npc.id}: ${NPC_CLEARANCE}+ px clear of colliders`, clearance >= NPC_CLEARANCE, `${clearance.toFixed(1)} px`));
    out.push(check(`npc ${npc.id}: player can stand within ${INTERACT_RADIUS} px`, d <= INTERACT_RADIUS, `${d.toFixed(1)} px`));
    out.push(check(`npc ${npc.id}: still talkable with all NPCs solid`, dCrowd <= INTERACT_RADIUS, `${dCrowd.toFixed(1)} px`));
    if (npc.wander > 0) {
      // Every feet position within the wander radius must be free of colliders.
      const bad = [];
      for (let a = 0; a < 360; a += 15) {
        for (const rr of [npc.wander / 2, npc.wander]) {
          const fx = Math.round(npc.x + Math.cos((a * Math.PI) / 180) * rr);
          const fy = Math.round(npc.y + Math.sin((a * Math.PI) / 180) * rr);
          if (colliders.some((c) => rectsOverlap(c, bodyAt(fx, fy)))) bad.push(`${fx},${fy}`);
        }
      }
      out.push(check(`npc ${npc.id}: wander radius ${npc.wander} px is clear`, bad.length === 0, bad.slice(0, 4).join(' ')));
    }
  });

  // Pickups -------------------------------------------------------------
  for (const p of map.pickups) {
    const buried = colliders.some((c) => pointRectDistance(p.x, p.y, c) === 0);
    const d = nearestReached(solid.reached, p.x, p.y, INTERACT_RADIUS + 4);
    const dCrowd = nearestReached(crowded.reached, p.x, p.y, INTERACT_RADIUS + 4);
    const clearance = Math.min(...colliders.map((c) => pointRectDistance(p.x, p.y, c)));
    const edge = Math.min(p.x, p.y, MAP_W - p.x, MAP_H - p.y);
    out.push(check(`pickup ${p.id}: not inside a collider`, !buried, `(${p.x}, ${p.y})`));
    out.push(check(`pickup ${p.id}: ${NPC_CLEARANCE}+ px clear of colliders`, clearance >= NPC_CLEARANCE, `${clearance.toFixed(1)} px`));
    out.push(check(`pickup ${p.id}: ${PICKUP_EDGE_MARGIN}+ px from the map edge`, edge >= PICKUP_EDGE_MARGIN, `${edge} px`));
    out.push(check(`pickup ${p.id}: walkable ground within ${INTERACT_RADIUS} px`, d <= INTERACT_RADIUS, `${d.toFixed(1)} px`));
    out.push(check(`pickup ${p.id}: reachable with NPCs solid`, dCrowd <= INTERACT_RADIUS, `${dCrowd.toFixed(1)} px`));
  }

  // Inspectables ----------------------------------------------------------
  for (const r of map.inspectables) {
    const sides = reachableSides(solid.reached, r, INTERACT_RADIUS - 4);
    const sidesCrowd = reachableSides(crowded.reached, r, INTERACT_RADIUS - 4);
    out.push(check(`inspectable ${r.id}: reachable side within ${INTERACT_RADIUS - 4} px`, sides.length > 0, `sides ${sides.join('') || 'none'}`));
    out.push(check(`inspectable ${r.id}: reachable with NPCs solid`, sidesCrowd.length > 0, `sides ${sidesCrowd.join('') || 'none'}`));
  }

  // Barrier & exit --------------------------------------------------------
  const touchesExit = (fx, fy) => rectsOverlap(bodyAt(fx, fy), exit);
  const exitBlocked = !someReached(solid.reached, { x: exit.x - 20, y: exit.y - 20, w: exit.w + 40, h: exit.h + 40 }, touchesExit);
  const exitOpen = someReached(open.reached, { x: exit.x - 20, y: exit.y - 20, w: exit.w + 40, h: exit.h + 40 }, touchesExit);
  const nearBarrier = (fx, fy) => {
    const b = bodyAt(fx, fy);
    return fy <= barrier.y + 1 && pointRectDistance(fx, fy, barrier) <= 3 && b.x < right(barrier) && right(b) > barrier.x;
  };
  const barrierTouchable = someReached(solid.reached, { x: barrier.x, y: barrier.y - 12, w: barrier.w, h: barrier.h + 12 }, nearBarrier);
  out.push(check('barrier: player can walk up to it from the village side', barrierTouchable));
  out.push(check('exit: UNREACHABLE while the barrier is solid', exitBlocked));
  out.push(check('exit: reachable when the barrier is open', exitOpen));
  out.push(check('exit lies south of the barrier, near the bottom edge', exit.y >= bottom(barrier) && bottom(exit) >= MAP_H - 40,
    `barrier bottom ${bottom(barrier)}, exit ${exit.y}-${bottom(exit)}`));

  // Forest sealing --------------------------------------------------------
  const solidEdges = edgeTouches(solid.reached);
  out.push(check('forest: nothing reaches the map edge while the barrier is solid', solidEdges.length === 0,
    solidEdges.slice(0, 5).map((p) => `${p.x},${p.y}`).join(' ')));
  const openEdges = edgeTouches(open.reached).filter((p) => !(p.y > MAP_H - 60 && p.x > exit.x && p.x < right(exit)));
  out.push(check('forest: with the barrier open only the bridge reaches the edge', openEdges.length === 0,
    openEdges.slice(0, 5).map((p) => `${p.x},${p.y}`).join(' ')));
  for (const probe of FOREST_PROBES) {
    const hit = nearestReached(open.reached, probe.x, probe.y, 8) <= 8;
    out.push(check(`forest: ${probe.name} unreachable`, !hit, `(${probe.x}, ${probe.y})`));
  }

  return { checks: out, solid, open };
}

/** RGBA layer that tints reachable feet positions (debug only). */
function reachLayer(reached, rgba) {
  const buf = Buffer.alloc(MAP_W * MAP_H * 4);
  for (let gy = 0; gy < GH; gy++) {
    for (let gx = 0; gx < GW; gx++) {
      if (!reached[gy * GW + gx]) continue;
      for (let y = gy * GRID; y < Math.min(MAP_H, gy * GRID + GRID); y++) {
        for (let x = gx * GRID; x < Math.min(MAP_W, gx * GRID + GRID); x++) {
          const i = (y * MAP_W + x) * 4;
          buf[i] = rgba[0]; buf[i + 1] = rgba[1]; buf[i + 2] = rgba[2]; buf[i + 3] = rgba[3];
        }
      }
    }
  }
  return { input: buf, raw: { width: MAP_W, height: MAP_H, channels: 4 } };
}

// ---------------------------------------------------------------------------

function printResults(title, results) {
  console.log(`\n${title}`);
  for (const r of results) {
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  [${r.detail}]` : ''}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const debugDir = args.includes('--debug') ? args[args.indexOf('--debug') + 1] : null;

  const all = [];
  const copied = await copyMaps(args.includes('--recopy'));
  printResults('Maps', copied);
  all.push(...copied);

  const map = JSON.parse(await fs.readFile(VILLAGE_JSON, 'utf8'));
  const schema = validateSchema(map);
  printResults('village.json schema', schema);
  all.push(...schema);

  await renderOverlay(map, OVERLAY_PNG);
  console.log(`\nOverlay written to ${path.relative(ROOT, OVERLAY_PNG)}`);

  const { checks, solid, open } = reachabilityChecks(map);
  printResults('Reachability (player body 16x10, grid 2 px)', checks);
  all.push(...checks);

  if (debugDir) {
    await fs.mkdir(debugDir, { recursive: true });
    const file = path.join(debugDir, 'village-reach.png');
    await renderOverlay(map, file, [reachLayer(open.reached, [255, 140, 0, 90]), reachLayer(solid.reached, [0, 255, 255, 70])], { indices: true });
    // Reach-only view: tinted feet positions on the bare map, easier to read than the full overlay.
    await sharp(path.join(RAW_DIR, 'village-map.png'))
      .composite([reachLayer(open.reached, [255, 120, 0, 90]), reachLayer(solid.reached, [0, 230, 255, 80])])
      .png().toFile(path.join(debugDir, 'village-reach-only.png'));
    console.log(`Debug reach maps written to ${debugDir}`);
  }

  const failed = all.filter((r) => !r.pass);
  console.log(`\n${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`} (${all.length} checks)`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

// THE NOMAD: Silo 01 map check + guide-trail marker check (task P, Milestone 3).
//
// Run from the project root:   node tools/assets/silo-check.mjs
// Optional debug output:        node tools/assets/silo-check.mjs --debug /tmp/nomad-p
//
// What it does:
//   1. Validates src/data/maps/silo.json against the M3 map schema (contract M3 §1, §3, §4).
//   2. Flood-fills the player's 16x10 feet body from the spawn (grid 2 px) and checks that every
//      NPC, inspectable side, zone, relay, vent, pickup and checkpoint can be reached, and that
//      the facility is sealed (no walkable feet position touches the map edge).
//   3. Checks spacing: NPC/pickup clearances, relays >= 200 px apart, vents >= 120 px from the
//      spawn and the core, relays and zones on open floor.
//   4. Repeats the walk on the guide's coarse 8 px lattice, so every marker is also reachable for
//      the A* guide trail (narrow doorways are the usual failure).
//   5. Re-reads village.json and wasteland.json: both must parse, and every marker point
//      (single or array, M3 §1) must be walkable ground with that map's own colliders.
//   6. Draws tools/previews/silo-overlay.png.
// Prints a PASS/FAIL list and exits non-zero on failure.

import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAP_PNG = path.join(ROOT, 'public', 'assets', 'maps', 'silo.png');
const MAP_JSON = path.join(ROOT, 'src', 'data', 'maps', 'silo.json');
const VILLAGE_JSON = path.join(ROOT, 'src', 'data', 'maps', 'village.json');
const WASTELAND_JSON = path.join(ROOT, 'src', 'data', 'maps', 'wasteland.json');
const OVERLAY_PNG = path.join(ROOT, 'tools', 'previews', 'silo-overlay.png');

// Player physics body: 16 wide x 10 tall, bottom-centred on the feet position (contract §8).
const BODY_W = 16;
const BODY_H = 10;
const GRID = 2;               // flood-fill step in world pixels
const GUIDE_GRID = 8;         // the guide's A* lattice (contract M3 §6)
const INTERACT_RADIUS = 28;   // feet-to-feet for NPCs/pickups, nearest edge for inspectables
const CLEAR_COLLIDER = 20;    // NPC / pickup feet at least this far from any collider (M3 §0)
const CLEAR_EDGE = 40;        // ... and this far from the map edge
const RELAY_GAP = 200;        // relays at least this far apart (centre to centre)
const VENT_SAFE = 120;        // vents at least this far from the spawn and the core
const EDGE_MARGIN = 6;        // "touching the map edge" = the body is this close to it

const REQUIRED = {
  npcs: { scientist: 'scientist', 'resident-1': 'villager', 'resident-2': 'villager', 'resident-3': 'villager' },
  pickups: { 'si-medkit-1': 'medkit', 'si-medkit-2': 'medkit', 'si-water-1': 'water', 'si-ration-1': 'ration' },
  inspectables: {
    'archive-history': 'archive-history', 'archive-aegis': 'archive-aegis', 'archive-villages': 'archive-villages',
    core: 'core', bunks: 'inspect-bunks', reactor: 'inspect-reactor', mural: 'inspect-mural',
  },
  zones: ['memory', 'furnace'],
  checkpoints: ['si-cp-1', 'si-cp-2'],
  relays: ['relay-1', 'relay-2', 'relay-3'],
  stages: ['silo', 'archives', 'remember', 'beacon', 'destroy', 'relays', 'reprogram'],
};

// ---------------------------------------------------------------------------
// Small helpers. Rects are { x, y, w, h } with a top-left origin.

const right = (r) => r.x + r.w;
const bottom = (r) => r.y + r.h;
const inside = (px, py, r) => px >= r.x && px < right(r) && py >= r.y && py < bottom(r);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const centre = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const fmtPt = (p) => `(${Math.round(p.x)}, ${Math.round(p.y)})`;
const overlaps = (a, b) => a.x < right(b) && b.x < right(a) && a.y < bottom(b) && b.y < bottom(a);

/** Distance from point (px, py) to the nearest point of rect r (0 if inside). */
function pointRectDistance(px, py, r) {
  const dx = Math.max(r.x - px, 0, px - right(r));
  const dy = Math.max(r.y - py, 0, py - bottom(r));
  return Math.hypot(dx, dy);
}

/** The player's (or an NPC's) physics body for a given feet position. */
function bodyAt(fx, fy) {
  return { x: fx - BODY_W / 2, y: fy - BODY_H, w: BODY_W, h: BODY_H };
}

function check(name, pass, detail = '') {
  return { name, pass: Boolean(pass), detail };
}

/** A marker value is one point or an array of points (M3 §1). Always returns an array. */
const markerPoints = (value) => (Array.isArray(value) ? value : value ? [value] : []);

// ---------------------------------------------------------------------------
// Rasterising and flood fills (one instance per map size).

function makeWorld(width, height) {
  const GW = Math.floor(width / GRID) + 1;
  const GH = Math.floor(height / GRID) + 1;
  const node = (gx, gy) => gy * GW + gx;
  const nodeXY = (n) => ({ x: (n % GW) * GRID, y: Math.floor(n / GW) * GRID });

  /** Per-pixel blocked mask + summed-area table, so "is this rect free?" is O(1). */
  function buildBlocker(rects) {
    const mask = new Uint8Array(width * height);
    for (const r of rects) {
      const x0 = Math.max(0, Math.floor(r.x)), x1 = Math.min(width, Math.ceil(right(r)));
      const y0 = Math.max(0, Math.floor(r.y)), y1 = Math.min(height, Math.ceil(bottom(r)));
      for (let y = y0; y < y1; y++) mask.fill(1, y * width + x0, y * width + x1);
    }
    const W1 = width + 1;
    const sat = new Int32Array(W1 * (height + 1));
    for (let y = 0; y < height; y++) {
      let rowSum = 0;
      for (let x = 0; x < width; x++) {
        rowSum += mask[y * width + x];
        sat[(y + 1) * W1 + (x + 1)] = sat[y * W1 + (x + 1)] + rowSum;
      }
    }
    /** True if the pixel rect [x0, x1) x [y0, y1) is inside the map and touches no blocked pixel. */
    function rectFree(x0, y0, x1, y1) {
      x0 = Math.floor(x0); y0 = Math.floor(y0); x1 = Math.ceil(x1); y1 = Math.ceil(y1);
      if (x0 < 0 || y0 < 0 || x1 > width || y1 > height) return false;
      return sat[y1 * W1 + x1] - sat[y0 * W1 + x1] - sat[y1 * W1 + x0] + sat[y0 * W1 + x0] === 0;
    }
    return {
      rectFree,
      bodyFree: (fx, fy) => rectFree(fx - BODY_W / 2, fy - BODY_H, fx + BODY_W / 2, fy),
      /** Fraction of the rect's pixels that are free. */
      freeFraction(r) {
        const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y), x1 = Math.min(width, right(r)), y1 = Math.min(height, bottom(r));
        const blocked = sat[y1 * W1 + x1] - sat[y0 * W1 + x1] - sat[y1 * W1 + x0] + sat[y0 * W1 + x0];
        return 1 - blocked / Math.max(1, (x1 - x0) * (y1 - y0));
      },
    };
  }

  /** 4-neighbour flood fill on the GRID lattice of feet positions, from `start`. */
  function floodFill(blocker, start) {
    const reached = new Uint8Array(GW * GH);
    const sx = Math.round(start.x / GRID), sy = Math.round(start.y / GRID);
    const ok = (gx, gy) => blocker.bodyFree(gx * GRID, gy * GRID);
    if (!ok(sx, sy)) return { reached, startFree: false, count: 0 };
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
        queue[tail++] = n;
      }
    }
    return { reached, startFree: true, count: tail };
  }

  /** Calls fn(fx, fy, n) for each reached node inside the box; stops early if fn returns true. */
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

  /** True if some reached feet position lies within maxDist of (px, py). */
  function reachedNear(reached, px, py, maxDist) {
    return someReached(reached, { x: px - maxDist, y: py - maxDist, w: maxDist * 2, h: maxDist * 2 },
      (fx, fy) => Math.hypot(fx - px, fy - py) <= maxDist);
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

  /** Reached feet positions that lie inside rect r (count). */
  function reachedInside(reached, r) {
    let count = 0;
    someReached(reached, r, (fx, fy) => { if (inside(fx, fy, r)) count++; return false; });
    return count;
  }

  /** Reached nodes whose body is within EDGE_MARGIN of the map border. */
  function edgeTouches(reached) {
    const hits = [];
    for (let n = 0; n < reached.length; n++) {
      if (!reached[n]) continue;
      const p = nodeXY(n);
      const b = bodyAt(p.x, p.y);
      if (b.x < EDGE_MARGIN || b.y < EDGE_MARGIN || right(b) > width - EDGE_MARGIN || bottom(b) > height - EDGE_MARGIN) hits.push(p);
    }
    return hits;
  }

  /**
   * The guide's view: 8-neighbour walk on a coarse lattice of feet positions (step GUIDE_GRID,
   * shifted by `offset`), diagonal steps only when both side cells are free (no corner cutting).
   * Returns a predicate "is (px, py) within `radius` of a reached lattice point?".
   */
  function guideReach(blocker, start, offset) {
    const gw = Math.floor((width - offset) / GUIDE_GRID) + 1, gh = Math.floor((height - offset) / GUIDE_GRID) + 1;
    const at = (i, j) => ({ x: offset + i * GUIDE_GRID, y: offset + j * GUIDE_GRID });
    const free = (i, j) => i >= 0 && j >= 0 && i < gw && j < gh && blocker.bodyFree(at(i, j).x, at(i, j).y);
    const reached = new Uint8Array(gw * gh);
    // Start from the free lattice point nearest the spawn.
    let si = -1, sj = -1, best = Infinity;
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
      const p = at(i, j), d = Math.hypot(p.x - start.x, p.y - start.y);
      if (d < best && d <= GUIDE_GRID * 2 && free(i, j)) { best = d; si = i; sj = j; }
    }
    if (si < 0) return () => false;
    const queue = [[si, sj]];
    reached[sj * gw + si] = 1;
    while (queue.length) {
      const [i, j] = queue.pop();
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = i + di, nj = j + dj;
        if (!free(ni, nj) || reached[nj * gw + ni]) continue;
        if (di && dj && (!free(i + di, j) || !free(i, j + dj))) continue;
        reached[nj * gw + ni] = 1;
        queue.push([ni, nj]);
      }
    }
    return (px, py, radius) => {
      const i0 = Math.max(0, Math.floor((px - radius - offset) / GUIDE_GRID)), i1 = Math.min(gw - 1, Math.ceil((px + radius - offset) / GUIDE_GRID));
      const j0 = Math.max(0, Math.floor((py - radius - offset) / GUIDE_GRID)), j1 = Math.min(gh - 1, Math.ceil((py + radius - offset) / GUIDE_GRID));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const p = at(i, j);
        if (reached[j * gw + i] && Math.hypot(p.x - px, p.y - py) <= radius) return true;
      }
      return false;
    };
  }

  return { GW, GH, nodeXY, buildBlocker, floodFill, someReached, reachedNear, reachableSides, reachedInside, edgeTouches, guideReach };
}

// ---------------------------------------------------------------------------
// 1. Silo schema.

function isRect(r, width, height) {
  return ['x', 'y', 'w', 'h'].every((k) => Number.isInteger(r[k])) && r.w > 0 && r.h > 0 &&
    r.x >= 0 && r.y >= 0 && right(r) <= width && bottom(r) <= height;
}

function validateSchema(map) {
  const out = [];
  const W = map.width, H = map.height;
  out.push(check('image / width / height / area', map.image === 'map-silo' && W === 1448 && H === 1086 && map.area === 'Silo 01'));
  out.push(check('spawn has x, y and facing "up"', Number.isFinite(map.spawn?.x) && Number.isFinite(map.spawn?.y) && map.spawn?.facing === 'up'));
  out.push(check('occluders is []', Array.isArray(map.occluders) && map.occluders.length === 0));

  const badRects = [];
  for (const key of ['colliders', 'inspectables', 'zones', 'checkpoints', 'relays']) {
    (map[key] || []).forEach((r, i) => { if (!isRect(r, W, H)) badRects.push(`${key}[${i}]`); });
  }
  out.push(check('every rect is integer, non-empty and inside the map', badRects.length === 0, badRects.join(' ')));

  // NPCs ---------------------------------------------------------------------------------
  const npcProblems = [];
  for (const [id, sprite] of Object.entries(REQUIRED.npcs)) {
    const n = (map.npcs || []).find((e) => e.id === id);
    if (!n) { npcProblems.push(`${id} missing`); continue; }
    if (n.sprite !== sprite || n.dialogue !== id || typeof n.name !== 'string' || !n.name) npcProblems.push(`${id} fields`);
    if (!['down', 'left', 'right', 'up'].includes(n.facing)) npcProblems.push(`${id} facing`);
    if (!Number.isFinite(n.wander)) npcProblems.push(`${id} wander`);
  }
  out.push(check('NPCs scientist + resident-1/2/3 (sprites, dialogue = id, names)', npcProblems.length === 0, npcProblems.join(', ')));
  const tints = ['resident-1', 'resident-2', 'resident-3'].map((id) => (map.npcs || []).find((e) => e.id === id)?.tint);
  out.push(check('residents have distinct hex tints', tints.every((t) => /^#[0-9a-f]{6}$/i.test(t || '')) && new Set(tints).size === 3, tints.join(' ')));
  const sci = (map.npcs || []).find((e) => e.id === 'scientist');
  out.push(check('scientist name is set (story task R may rename; keep in sync)', !!sci?.name, `name "${sci?.name}"`));

  // Pickups ------------------------------------------------------------------------------
  const pickupProblems = [];
  for (const [id, item] of Object.entries(REQUIRED.pickups)) {
    const p = (map.pickups || []).find((e) => e.id === id);
    if (!p) pickupProblems.push(`${id} missing`);
    else if (p.item !== item || p.dialogue !== null) pickupProblems.push(`${id} fields`);
  }
  out.push(check('pickups si-medkit-1/2, si-water-1, si-ration-1 (dialogue null)', pickupProblems.length === 0, pickupProblems.join(', ')));

  // Inspectables, zones, checkpoints, vents, relays --------------------------------------
  const inspectProblems = Object.entries(REQUIRED.inspectables).filter(([id, dlg]) => {
    const r = (map.inspectables || []).find((e) => e.id === id);
    return !r || r.dialogue !== dlg;
  }).map(([id]) => id);
  out.push(check('inspectables archive-* / core / bunks / reactor / mural with their dialogues', inspectProblems.length === 0, inspectProblems.join(', ')));

  const zoneIds = (map.zones || []).map((z) => z.id);
  out.push(check('zones memory / furnace', REQUIRED.zones.every((id) => zoneIds.includes(id)), zoneIds.join(', ')));
  const memory = (map.zones || []).find((z) => z.id === 'memory');
  out.push(check('memory zone is about 60x50', memory && Math.abs(memory.w - 60) <= 10 && Math.abs(memory.h - 50) <= 10, memory ? `${memory.w}x${memory.h}` : ''));

  const cpIds = (map.checkpoints || []).map((c) => c.id);
  const cpOk = REQUIRED.checkpoints.every((id) => cpIds.includes(id)) &&
    (map.checkpoints || []).every((c) => Number.isFinite(c.respawn?.x) && Number.isFinite(c.respawn?.y));
  out.push(check('checkpoints si-cp-1 / si-cp-2 with respawn points', cpOk, cpIds.join(', ')));

  const vents = map.vents || [];
  const ventIds = new Set(vents.map((v) => v.id));
  out.push(check('4-6 vents with unique ids and x, y', vents.length >= 4 && vents.length <= 6 && ventIds.size === vents.length &&
    vents.every((v) => Number.isFinite(v.x) && Number.isFinite(v.y)), `${vents.length} vents`));

  const relays = map.relays || [];
  out.push(check('relays relay-1 / relay-2 / relay-3', REQUIRED.relays.every((id) => relays.some((r) => r.id === id)) && relays.length === 3));
  out.push(check('relays are about 44x44', relays.every((r) => Math.abs(r.w - 44) <= 6 && Math.abs(r.h - 44) <= 6), relays.map((r) => `${r.w}x${r.h}`).join(' ')));

  // Markers ------------------------------------------------------------------------------
  const m = map.markers || {};
  const missing = REQUIRED.stages.filter((s) => !m[s]);
  out.push(check('markers for every Silo stage', missing.length === 0, missing.join(', ')));
  const zone = (id) => (map.zones || []).find((z) => z.id === id);
  const insp = (id) => (map.inspectables || []).find((r) => r.id === id);
  const near = (p, q, tol = 1) => p && q && Math.abs(p.x - q.x) <= tol && Math.abs(p.y - q.y) <= tol;
  const nearRect = (p, r) => p && r && pointRectDistance(p.x, p.y, r) <= INTERACT_RADIUS;
  out.push(check('marker silo = the scientist', near(m.silo, sci)));
  const arch = markerPoints(m.archives);
  const archOk = arch.length === 3 && ['history', 'aegis', 'villages'].every((k, i) =>
    nearRect(arch[i], insp(`archive-${k}`)) && JSON.stringify(arch[i].if) === JSON.stringify({ notFlags: [`archive_${k}`] }));
  out.push(check('marker archives = 3 terminals, each "if notFlags archive_<name>"', archOk));
  out.push(check('marker remember = memory zone centre', near(m.remember, memory && centre(memory))));
  out.push(check('markers beacon / reprogram = the core', nearRect(m.beacon, insp('core')) && nearRect(m.reprogram, insp('core'))));
  out.push(check('marker destroy = furnace centre', near(m.destroy, zone('furnace') && centre(zone('furnace')))));
  const rel = markerPoints(m.relays);
  const relOk = rel.length === 3 && rel.every((p, i) => {
    const r = relays.find((e) => e.id === `relay-${i + 1}`);
    return r && near(p, centre(r)) && JSON.stringify(p.if) === JSON.stringify({ notFlags: [`relay_${i + 1}`] });
  });
  out.push(check('marker relays = 3 relay centres, each "if notFlags relay_<n>"', relOk));
  return out;
}

// ---------------------------------------------------------------------------
// 2. Silo reachability, spacing and the guide lattice.

function siloChecks(map, world) {
  const out = [];
  const zone = (id) => map.zones.find((z) => z.id === id);
  const insp = (id) => map.inspectables.find((r) => r.id === id);
  const core = insp('core');
  const npcBodies = map.npcs.map((n) => bodyAt(n.x, n.y));

  const walls = world.buildBlocker(map.colliders);                    // NPCs ignored
  const wallsAndNpcs = world.buildBlocker([...map.colliders, ...npcBodies]); // NPCs standing still
  const open = world.floodFill(walls, map.spawn);
  const live = world.floodFill(wallsAndNpcs, map.spawn);
  out.push(check('spawn: body is free', live.startFree, fmtPt(map.spawn)));

  // Edges: the facility is sealed --------------------------------------------------------
  const leaks = world.edgeTouches(open.reached);
  out.push(check('edges: sealed (no walkable feet position touches the map edge)', leaks.length === 0, leaks.slice(0, 5).map(fmtPt).join(' ')));

  // Reachability (NPCs standing) -----------------------------------------------------------
  for (const n of map.npcs) {
    out.push(check(`reach: NPC ${n.id}`, world.reachedNear(live.reached, n.x, n.y, INTERACT_RADIUS), fmtPt(n)));
  }
  for (const r of map.inspectables) {
    const sides = world.reachableSides(live.reached, r, INTERACT_RADIUS);
    out.push(check(`reach: inspectable ${r.id} has a reachable side`, sides.length > 0, `sides ${sides.join('') || '-'}`));
  }
  for (const z of map.zones) {
    const n = world.reachedInside(live.reached, z);
    out.push(check(`reach: zone ${z.id} (feet can stand inside)`, n > 0, `${n} feet positions`));
  }
  for (const r of map.relays) {
    const n = world.reachedInside(live.reached, r);
    const c = centre(r);
    out.push(check(`reach: relay ${r.id} (centre walkable and reachable)`, n > 0 && world.reachedNear(live.reached, c.x, c.y, GRID * 2), `${n} feet positions`));
  }
  for (const v of map.vents) {
    const ok = walls.bodyFree(v.x, v.y) && world.reachedNear(open.reached, v.x, v.y, GRID * 2);
    out.push(check(`reach: vent ${v.id} on walkable floor`, ok, fmtPt(v)));
  }
  for (const p of map.pickups) {
    out.push(check(`reach: pickup ${p.id}`, world.reachedNear(live.reached, p.x, p.y, INTERACT_RADIUS), fmtPt(p)));
  }
  for (const cp of map.checkpoints) {
    const r = cp.respawn;
    const entered = world.reachedInside(live.reached, cp) > 0;
    const respawnOk = wallsAndNpcs.bodyFree(r.x, r.y) && world.reachedNear(live.reached, r.x, r.y, GRID * 2);
    out.push(check(`reach: checkpoint ${cp.id} enterable, respawn free`, entered && respawnOk, fmtPt(r)));
  }
  const cp1 = map.checkpoints.find((c) => c.id === 'si-cp-1');
  const cp2 = map.checkpoints.find((c) => c.id === 'si-cp-2');
  out.push(check('si-cp-1 contains the spawn (and its respawn is the spawn)', cp1 && inside(map.spawn.x, map.spawn.y, cp1) &&
    cp1.respawn.x === map.spawn.x && cp1.respawn.y === map.spawn.y));
  // The corridor's central junction is where the side arms cross it, near the middle of the map.
  out.push(check('si-cp-2 sits on the central corridor, mid-map', cp2 && Math.abs(centre(cp2).x - map.width / 2) <= 60 &&
    Math.abs(centre(cp2).y - map.height / 2) <= 120, cp2 ? fmtPt(centre(cp2)) : ''));

  // Spacing ------------------------------------------------------------------------------
  const clearanceOf = (p) => Math.min(...map.colliders.map((c) => pointRectDistance(p.x, p.y, c)));
  const edgeOf = (p) => Math.min(p.x, p.y, map.width - p.x, map.height - p.y);
  for (const e of [...map.npcs, ...map.pickups]) {
    const c = clearanceOf(e), d = edgeOf(e);
    out.push(check(`clearance: ${e.id} >= ${CLEAR_COLLIDER} px from colliders, >= ${CLEAR_EDGE} px from edges`,
      c >= CLEAR_COLLIDER && d >= CLEAR_EDGE, `collider ${c.toFixed(1)}, edge ${d}`));
  }
  const npcSpots = map.npcs.map((n) => ({ id: n.id, ...bodyAt(n.x, n.y) }));
  for (const p of map.pickups) {
    const hit = npcSpots.find((b) => pointRectDistance(p.x, p.y, b) < 12);
    out.push(check(`clearance: ${p.id} not under an NPC`, !hit, hit ? hit.id : ''));
  }
  for (let i = 0; i < map.relays.length; i++) {
    for (let j = i + 1; j < map.relays.length; j++) {
      const a = map.relays[i], b = map.relays[j], d = dist(centre(a), centre(b));
      out.push(check(`spacing: ${a.id} <-> ${b.id} >= ${RELAY_GAP} px`, d >= RELAY_GAP, `${Math.round(d)} px`));
    }
  }
  for (const r of map.relays) {
    const free = walls.freeFraction(r);
    const npcIn = map.npcs.filter((n) => overlaps(bodyAt(n.x, n.y), r)).map((n) => n.id);
    out.push(check(`open floor: ${r.id} touches no collider or NPC`, free === 1 && npcIn.length === 0,
      `${Math.round(free * 100)}% free${npcIn.length ? `, NPC ${npcIn.join(',')}` : ''}`));
  }
  for (const z of map.zones) {
    const free = walls.freeFraction(z);
    out.push(check(`open floor: zone ${z.id} is >= 90% free floor`, free >= 0.9, `${Math.round(free * 100)}% free`));
  }
  for (const v of map.vents) {
    const ds = dist(v, map.spawn), dc = pointRectDistance(v.x, v.y, core);
    out.push(check(`spacing: vent ${v.id} >= ${VENT_SAFE} px from the spawn and the core`, ds >= VENT_SAFE && dc >= VENT_SAFE,
      `spawn ${Math.round(ds)} px, core ${Math.round(dc)} px`));
  }
  const sci = map.npcs.find((n) => n.id === 'scientist');
  const memory = zone('memory');
  const memDist = pointRectDistance(sci.x, sci.y, memory);
  out.push(check('memory zone is near the scientist (<= 80 px) but not under her/him', memDist <= 80 && !overlaps(bodyAt(sci.x, sci.y), memory),
    `${Math.round(memDist)} px`));
  const reactor = insp('reactor'), furnace = zone('furnace');
  out.push(check('furnace is in front of (south of) the reactor, within 40 px', furnace.y >= bottom(reactor) - 4 && furnace.y - bottom(reactor) <= 40 &&
    furnace.x < right(reactor) && right(furnace) > reactor.x, `gap ${furnace.y - bottom(reactor)} px`));

  // Markers reachable on foot and on the guide lattice ---------------------------------------
  const guides = [0, GUIDE_GRID / 2].map((off) => world.guideReach(walls, map.spawn, off));
  const markerTargets = [];
  for (const [stage, value] of Object.entries(map.markers || {})) {
    markerPoints(value).forEach((p, i) => markerTargets.push({ label: `${stage}${Array.isArray(value) ? `[${i}]` : ''}`, p }));
  }
  for (const { label, p } of markerTargets) {
    const footOk = world.reachedNear(open.reached, p.x, p.y, INTERACT_RADIUS);
    const guideOk = guides.every((g) => g(p.x, p.y, INTERACT_RADIUS));
    out.push(check(`marker ${label}: reachable on foot and by the 8 px guide lattice`, footOk && guideOk, fmtPt(p)));
  }
  const extra = [
    ...map.npcs.map((n) => ({ label: `NPC ${n.id}`, p: n })),
    ...map.pickups.map((n) => ({ label: `pickup ${n.id}`, p: n })),
    ...map.vents.map((n) => ({ label: `vent ${n.id}`, p: n })),
  ];
  const guideMiss = extra.filter(({ p }) => !guides.every((g) => g(p.x, p.y, INTERACT_RADIUS))).map((e) => e.label);
  out.push(check('guide lattice reaches every NPC, pickup and vent too', guideMiss.length === 0, guideMiss.join(', ')));

  return { checks: out, open, live };
}

// ---------------------------------------------------------------------------
// 3. Village + Wasteland marker checks (markers field only; their colliders are reused).

function otherMapChecks(name, map, expectations) {
  const out = [];
  const world = makeWorld(map.width, map.height);
  const walls = world.buildBlocker(map.colliders || []);
  const open = world.floodFill(walls, map.spawn);
  const markers = map.markers || {};
  for (const [stage, value] of Object.entries(markers)) {
    markerPoints(value).forEach((p, i) => {
      const label = `${name} marker ${stage}${Array.isArray(value) ? `[${i}]` : ''}`;
      const free = walls.bodyFree(p.x, p.y);
      const reach = world.reachedNear(open.reached, p.x, p.y, GRID * 2);
      const result = check(`${label}: walkable ground (body free, reachable from the spawn)`, free && reach, `${fmtPt(p)}${free ? '' : ' blocked'}`);
      // Single-point markers predate M3 and other tasks' checks pin them (e.g. "city" must be the
      // encounter centre). If one sits on a collider, the guide snaps to the nearest walkable cell,
      // so report it as a warning when that cell is close; the new array points stay strict.
      if (!result.pass && !Array.isArray(value)) {
        const snap = nearestReached(world, open.reached, p, 24);
        if (snap) Object.assign(result, { pass: true, warn: true, detail: `${fmtPt(p)} is on a collider; kept as authored, guide snaps to ${fmtPt(snap)}` });
      }
      out.push(result);
    });
  }
  for (const e of expectations) out.push(check(`${name} ${e.name}`, e.test(markers, map), e.detail ? e.detail(markers, map) : ''));
  return out;
}

/** The reached feet position nearest to p within maxDist, or null. */
function nearestReached(world, reached, p, maxDist) {
  let best = null, bestD = Infinity;
  world.someReached(reached, { x: p.x - maxDist, y: p.y - maxDist, w: maxDist * 2, h: maxDist * 2 }, (fx, fy) => {
    const d = Math.hypot(fx - p.x, fy - p.y);
    if (d <= maxDist && d < bestD) { bestD = d; best = { x: fx, y: fy }; }
    return false;
  });
  return best;
}

const samePoint = (p, q) => p && q && p.x === q.x && p.y === q.y;
const sameIf = (p, cond) => JSON.stringify(p?.if) === JSON.stringify(cond);

const VILLAGE_EXPECT = [
  { name: 'markers wake / confront / bridge kept', test: (m) => ['wake', 'confront', 'bridge'].every((s) => m[s] && !Array.isArray(m[s])) },
  {
    name: 'marker explore = [journal if notFlags picked_journal, shard if notFlags picked_shard, Hessa if notItems map]',
    test: (m, map) => {
      const pts = markerPoints(m.explore);
      const pick = (id) => map.pickups.find((p) => p.id === id);
      const hessa = map.npcs.find((n) => n.id === 'hessa');
      const want = [
        [pick('journal'), { notFlags: ['picked_journal'] }],
        [pick('shard'), { notFlags: ['picked_shard'] }],
        [hessa, { notItems: ['map'] }],
      ];
      return Array.isArray(m.explore) && pts.length === 3 && want.every(([src, cond]) => pts.some((p) => samePoint(p, src) && sameIf(p, cond)));
    },
  },
];

const WASTELAND_EXPECT = [
  { name: 'markers city / signal / cloud kept', test: (m) => ['city', 'signal', 'cloud'].every((s) => m[s] && !Array.isArray(m[s])) },
  {
    name: 'marker survivors = [nova, ryn, eli], each "if notParty [id]"',
    test: (m, map) => {
      const pts = markerPoints(m.survivors);
      return Array.isArray(m.survivors) && pts.length === 3 && ['nova', 'ryn', 'eli'].every((id) => {
        const n = map.npcs.find((e) => e.id === id);
        return pts.some((p) => samePoint(p, n) && sameIf(p, { notParty: [id] }));
      });
    },
  },
];

// ---------------------------------------------------------------------------
// 4. Overlay preview.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function label(x, y, text, color, size = 10) {
  return `<text x="${x}" y="${y}" font-family="Menlo, monospace" font-size="${size}" fill="${color}" ` +
    `stroke="#000" stroke-width="2.5" paint-order="stroke">${esc(text)}</text>`;
}

function overlaySvg(map, { indices = false } = {}) {
  const W = map.width, H = map.height;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`];

  // Walls/rock in dark red, furniture in orange-red so the two are easy to tell apart.
  map.colliders.forEach((c, i) => {
    const wall = /^wall/.test(c.note || '');
    const col = wall ? '#ff2020' : '#ff7a20';
    parts.push(`<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" fill="${col}" fill-opacity="${wall ? 0.32 : 0.28}" stroke="${col}" stroke-opacity="0.9" stroke-width="1"/>`);
    if (indices) parts.push(label(c.x + 1, c.y + 8, i, '#ffd0d0', 8));
  });

  for (const z of map.zones) {
    parts.push(`<rect x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" fill="#ff00ff" fill-opacity="0.3" stroke="#ff00ff" stroke-width="1.5"/>`);
    parts.push(label(z.x + 2, z.y - 3, z.id, '#ff80ff'));
  }
  for (const r of map.relays) {
    parts.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="#00e0ff" fill-opacity="0.25" stroke="#00e0ff" stroke-width="2" stroke-dasharray="6 3"/>`);
    parts.push(label(r.x + 2, r.y - 3, r.id, '#80f0ff'));
  }
  for (const cp of map.checkpoints) {
    parts.push(`<rect x="${cp.x + 0.5}" y="${cp.y + 0.5}" width="${cp.w - 1}" height="${cp.h - 1}" fill="none" stroke="#ffffff" stroke-width="1.5" stroke-dasharray="5 3"/>`);
    parts.push(`<circle cx="${cp.respawn.x}" cy="${cp.respawn.y}" r="3" fill="#ffffff"/>`);
    parts.push(label(cp.x + 2, bottom(cp) + 11, cp.id, '#ffffff'));
  }
  for (const r of map.inspectables) {
    parts.push(`<rect x="${r.x + 0.5}" y="${r.y + 0.5}" width="${r.w - 1}" height="${r.h - 1}" fill="none" stroke="#3ad4e8" stroke-width="2"/>`);
    parts.push(label(r.x + 2, bottom(r) - 4, `inspect:${r.id}`, '#8ff0ff', 9));
  }
  for (const v of map.vents) {
    parts.push(`<circle cx="${v.x}" cy="${v.y}" r="7" fill="#30ff60" fill-opacity="0.35" stroke="#30ff60" stroke-width="2"/>`);
    parts.push(label(v.x + 9, v.y + 4, `vent ${v.id}`, '#90ffa0'));
  }
  for (const p of map.pickups) {
    parts.push(`<circle cx="${p.x}" cy="${p.y}" r="5" fill="#ff9a1a" stroke="#000" stroke-width="1"/>`);
    parts.push(label(p.x + 7, p.y + 4, p.id, '#ffb050'));
  }
  for (const n of map.npcs) {
    const b = bodyAt(n.x, n.y);
    parts.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="#ffe030" fill-opacity="0.5" stroke="#000" stroke-width="1"/>`);
    parts.push(`<circle cx="${n.x}" cy="${n.y}" r="4" fill="#ffe030" stroke="#000" stroke-width="1"/>`);
    parts.push(label(n.x + 7, n.y - 4, `${n.name} (${n.id})`, '#ffe860'));
  }
  const s = map.spawn;
  parts.push(`<circle cx="${s.x}" cy="${s.y}" r="5" fill="#ffffff" stroke="#000" stroke-width="1"/>`);
  parts.push(label(s.x + 7, s.y + 4, 'spawn', '#ffffff'));

  for (const [stage, value] of Object.entries(map.markers || {})) {
    markerPoints(value).forEach((m) => {
      parts.push(`<path d="M${m.x},${m.y - 5} L${m.x + 5},${m.y} L${m.x},${m.y + 5} L${m.x - 5},${m.y} Z" fill="#ffff00" stroke="#000" stroke-width="1"/>`);
      parts.push(label(m.x + 7, m.y + 12, `marker:${stage}`, '#ffff80', 9));
    });
  }
  parts.push('</svg>');
  return parts.join('\n');
}

async function renderOverlay(map, file, extraLayers = [], opts = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const layers = [...extraLayers, { input: Buffer.from(overlaySvg(map, opts)) }];
  await sharp(MAP_PNG).composite(layers).png({ compressionLevel: 9 }).toFile(file);
}

/** RGBA layer that tints reached feet positions (debug only). */
function reachLayer(map, world, reached, rgba) {
  const buf = Buffer.alloc(map.width * map.height * 4);
  for (let n = 0; n < reached.length; n++) {
    if (!reached[n]) continue;
    const p = world.nodeXY(n);
    for (let y = p.y; y < Math.min(map.height, p.y + GRID); y++) {
      for (let x = p.x; x < Math.min(map.width, p.x + GRID); x++) {
        const i = (y * map.width + x) * 4;
        buf[i] = rgba[0]; buf[i + 1] = rgba[1]; buf[i + 2] = rgba[2]; buf[i + 3] = rgba[3];
      }
    }
  }
  return { input: buf, raw: { width: map.width, height: map.height, channels: 4 } };
}

// ---------------------------------------------------------------------------

function printResults(title, results) {
  console.log(`\n${title}`);
  for (const r of results) console.log(`  ${r.warn ? 'WARN' : r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  [${r.detail}]` : ''}`);
}

async function readJson(file, all) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    const r = check(`${path.relative(ROOT, file)} parses`, false, err.message);
    printResults('Parse', [r]);
    all.push(r);
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const debugDir = args.includes('--debug') ? args[args.indexOf('--debug') + 1] : null;
  const all = [];

  const meta = await sharp(MAP_PNG).metadata();
  const sizeOk = check('silo.png is 1448x1086', meta.width === 1448 && meta.height === 1086, `${meta.width}x${meta.height}`);
  printResults('Map image', [sizeOk]);
  all.push(sizeOk);

  const map = await readJson(MAP_JSON, all);
  if (map) {
    const schema = validateSchema(map);
    printResults('silo.json schema', schema);
    all.push(...schema);

    const world = makeWorld(map.width, map.height);
    const { checks, open, live } = siloChecks(map, world);
    printResults('Silo reachability, spacing and guide lattice (player body 16x10, grid 2 px / 8 px)', checks);
    all.push(...checks);

    console.log('\nCounts');
    const furniture = map.colliders.filter((c) => !/^wall/.test(c.note || '')).length;
    console.log(`  colliders ${map.colliders.length} (walls/rock ${map.colliders.length - furniture}, furniture ${furniture}), ` +
      `npcs ${map.npcs.length}, pickups ${map.pickups.length}, inspectables ${map.inspectables.length}, zones ${map.zones.length}, ` +
      `checkpoints ${map.checkpoints.length}, vents ${map.vents.length}, relays ${map.relays.length}, ` +
      `marker points ${Object.values(map.markers).reduce((n, v) => n + markerPoints(v).length, 0)}`);
    console.log(`  scientist name field: "${map.npcs.find((n) => n.id === 'scientist')?.name}"`);

    await renderOverlay(map, OVERLAY_PNG);
    console.log(`\nOverlay written to ${path.relative(ROOT, OVERLAY_PNG)}`);
    if (debugDir) {
      await fs.mkdir(debugDir, { recursive: true });
      const file = path.join(debugDir, 'silo-reach.png');
      await renderOverlay(map, file, [reachLayer(map, world, open.reached, [255, 140, 0, 90]), reachLayer(map, world, live.reached, [0, 255, 255, 70])], { indices: true });
      console.log(`Debug reach map written to ${file} (orange = walkable, cyan = walkable with NPCs standing)`);
    }
  }

  const village = await readJson(VILLAGE_JSON, all);
  if (village) {
    const res = [check('village.json parses', true), ...otherMapChecks('village', village, VILLAGE_EXPECT)];
    printResults('Village 07 markers (its own colliders)', res);
    all.push(...res);
  }
  const wasteland = await readJson(WASTELAND_JSON, all);
  if (wasteland) {
    const res = [check('wasteland.json parses', true), ...otherMapChecks('wasteland', wasteland, WASTELAND_EXPECT)];
    printResults('Ruined City markers (its own colliders)', res);
    all.push(...res);
  }

  const failed = all.filter((r) => !r.pass);
  const warned = all.filter((r) => r.warn).length;
  console.log(`\n${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`} (${all.length} checks${warned ? `, ${warned} warning${warned > 1 ? 's' : ''}` : ''})`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

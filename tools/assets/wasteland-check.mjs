// THE NOMAD: Wasteland map check (task H).
//
// Run from the project root:   node tools/assets/wasteland-check.mjs
// Optional debug output:        node tools/assets/wasteland-check.mjs --debug /tmp/nomad-h
//
// What it does:
//   1. Validates src/data/maps/wasteland.json against the M2 map schema (contract M2 §1, §3).
//   2. Flood-fills the player's 16x10 feet body from the spawn (grid 2 px), twice:
//        - "walkable":     colliders only
//        - "hazard-free":  also refuses any feet position inside a toxic/corrupt/fire rect
//      and checks that every NPC, the rig and the exit can be reached without touching a hazard,
//      that the encounter band can't be walked around, and that the edges are sealed except the exit.
//   3. Checks clearances (NPCs, pickups, crawler groups) and finds the narrowest choke of each
//      required leg (spawn -> Kael -> Nova -> Ryn -> Eli -> rig -> exit) so crawler groups stay off it.
//   4. Draws tools/previews/wasteland-overlay.png.
// Prints a PASS/FAIL list and exits non-zero on failure.

import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAP_PNG = path.join(ROOT, 'public', 'assets', 'maps', 'wasteland.png');
const MAP_JSON = path.join(ROOT, 'src', 'data', 'maps', 'wasteland.json');
const OVERLAY_PNG = path.join(ROOT, 'tools', 'previews', 'wasteland-overlay.png');

const MAP_W = 1448;
const MAP_H = 1086;

// Player physics body: 16 wide x 10 tall, bottom-centred on the feet position (contract §8).
const BODY_W = 16;
const BODY_H = 10;
const GRID = 2;               // flood-fill step in world pixels
const INTERACT_RADIUS = 28;   // feet-to-feet for NPCs/pickups, nearest edge for inspectables
const CLEAR_COLLIDER = 20;    // NPC / pickup feet at least this far from any collider (M2 §0)
const CLEAR_EDGE = 40;        // ... and this far from the map edge
const CRAWLER_SAFE = 160;     // crawler groups at least this far from the spawn and every NPC (M2 §8)
const EDGE_MARGIN = 6;        // "touching the map edge" = the body is this close to it
const MAX_CLEARANCE = 40;     // clearance is measured up to this many px

const REQUIRED = {
  npcs: { kael: 'Kael', nova: 'Nova', ryn: 'Ryn', eli: 'Eli' },
  pickups: { 'ws-medkit-1': 'medkit', 'ws-ration-1': 'ration', 'ws-water-1': 'water' },
  inspectables: ['bus', 'sinkhole', 'billboard', 'barrels'],
  zones: ['encounter', 'rig', 'exit'],
  checkpoints: ['ws-cp-1', 'ws-cp-2'],
  markers: { city: 'encounter', signal: 'rig', cloud: 'exit' },
};
const HAZARD_TYPES = ['toxic', 'corrupt', 'fire'];

// ---------------------------------------------------------------------------
// Small helpers. Rects are { x, y, w, h } with a top-left origin.

const right = (r) => r.x + r.w;
const bottom = (r) => r.y + r.h;
const inside = (px, py, r) => px >= r.x && px < right(r) && py >= r.y && py < bottom(r);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const fmtPt = (p) => `(${p.x}, ${p.y})`;

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

// ---------------------------------------------------------------------------
// 1. Schema.

function isRect(r) {
  return ['x', 'y', 'w', 'h'].every((k) => Number.isInteger(r[k])) && r.w > 0 && r.h > 0 &&
    r.x >= 0 && r.y >= 0 && right(r) <= MAP_W && bottom(r) <= MAP_H;
}

function validateSchema(map) {
  const out = [];
  out.push(check('image / width / height / area',
    map.image === 'map-wasteland' && map.width === MAP_W && map.height === MAP_H && map.area === 'The Ruined City'));
  out.push(check('spawn has x, y and facing "down"',
    Number.isFinite(map.spawn?.x) && Number.isFinite(map.spawn?.y) && map.spawn?.facing === 'down'));
  out.push(check('occluders is []', Array.isArray(map.occluders) && map.occluders.length === 0));

  const badRects = [];
  for (const key of ['colliders', 'inspectables', 'zones', 'hazards', 'checkpoints']) {
    (map[key] || []).forEach((r, i) => { if (!isRect(r)) badRects.push(`${key}[${i}]`); });
  }
  out.push(check('every rect is integer, non-empty and inside the map', badRects.length === 0, badRects.join(' ')));

  const npcProblems = [];
  for (const [id, name] of Object.entries(REQUIRED.npcs)) {
    const n = (map.npcs || []).find((e) => e.id === id);
    if (!n) { npcProblems.push(`${id} missing`); continue; }
    if (n.sprite !== id || n.name !== name || n.dialogue !== id || n.wander !== 0 || n.tint !== null) npcProblems.push(`${id} fields`);
    if (!['down', 'left', 'right', 'up'].includes(n.facing)) npcProblems.push(`${id} facing`);
  }
  out.push(check('NPCs kael/nova/ryn/eli (sprite = dialogue = id, wander 0, tint null)', npcProblems.length === 0, npcProblems.join(', ')));

  const pickupProblems = [];
  for (const [id, item] of Object.entries(REQUIRED.pickups)) {
    const p = (map.pickups || []).find((e) => e.id === id);
    if (!p) pickupProblems.push(`${id} missing`);
    else if (p.item !== item || p.dialogue !== null) pickupProblems.push(`${id} fields`);
  }
  out.push(check('pickups ws-medkit-1 / ws-ration-1 / ws-water-1 (dialogue null)', pickupProblems.length === 0, pickupProblems.join(', ')));

  const inspectProblems = REQUIRED.inspectables.filter((id) => {
    const r = (map.inspectables || []).find((e) => e.id === id);
    return !r || r.dialogue !== `inspect-${id}`;
  });
  out.push(check('inspectables bus / sinkhole / billboard / barrels', inspectProblems.length === 0, inspectProblems.join(', ')));

  const zoneIds = (map.zones || []).map((z) => z.id);
  out.push(check('zones encounter / rig / exit', REQUIRED.zones.every((id) => zoneIds.includes(id)), zoneIds.join(', ')));

  const badHazards = (map.hazards || []).filter((h) => !HAZARD_TYPES.includes(h.type));
  const hazardTypes = new Set((map.hazards || []).map((h) => h.type));
  out.push(check('hazards: toxic, corrupt and fire all present, no other types',
    badHazards.length === 0 && HAZARD_TYPES.every((t) => hazardTypes.has(t))));

  const cpIds = (map.checkpoints || []).map((c) => c.id);
  const cpOk = REQUIRED.checkpoints.every((id) => cpIds.includes(id)) &&
    (map.checkpoints || []).every((c) => Number.isFinite(c.respawn?.x) && Number.isFinite(c.respawn?.y));
  out.push(check('checkpoints ws-cp-1 / ws-cp-2 with respawn points', cpOk, cpIds.join(', ')));

  const groups = map.crawlers || [];
  const badGroups = groups.filter((g) => !(g.count >= 2 && g.count <= 3 && g.radius >= 50 && g.radius <= 80));
  out.push(check('2-3 crawler groups, count 2-3, radius 50-80',
    groups.length >= 2 && groups.length <= 3 && badGroups.length === 0, `${groups.length} groups`));

  const markerProblems = [];
  for (const [stage, zoneId] of Object.entries(REQUIRED.markers)) {
    const m = map.markers?.[stage];
    const z = (map.zones || []).find((e) => e.id === zoneId);
    if (!m || !z) { markerProblems.push(`${stage} missing`); continue; }
    if (Math.abs(m.x - (z.x + z.w / 2)) > 1 || Math.abs(m.y - (z.y + z.h / 2)) > 1) markerProblems.push(`${stage} not at ${zoneId} centre`);
  }
  out.push(check('markers city / signal / cloud at the encounter / rig / exit centres', markerProblems.length === 0, markerProblems.join(', ')));
  return out;
}

// ---------------------------------------------------------------------------
// 2. Rasterising and flood fills.

const GW = Math.floor(MAP_W / GRID) + 1;
const GH = Math.floor(MAP_H / GRID) + 1;
const node = (gx, gy) => gy * GW + gx;
const nodeXY = (n) => ({ x: (n % GW) * GRID, y: Math.floor(n / GW) * GRID });

/** Per-pixel blocked mask + summed-area table, so "is this rect free?" is O(1). */
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
  /** True if the pixel rect [x0, x1) x [y0, y1) is inside the map and touches no blocked pixel. */
  function rectFree(x0, y0, x1, y1) {
    if (x0 < 0 || y0 < 0 || x1 > MAP_W || y1 > MAP_H) return false;
    return sat[y1 * W1 + x1] - sat[y0 * W1 + x1] - sat[y1 * W1 + x0] + sat[y0 * W1 + x0] === 0;
  }
  return {
    rectFree,
    bodyFree: (fx, fy) => rectFree(fx - BODY_W / 2, fy - BODY_H, fx + BODY_W / 2, fy),
    /** How many px the body at (fx, fy) could grow on every side before touching a collider. */
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

/** Distance from a feet point to the nearest hazard rect (0 inside one). */
function hazardDistance(hazards, fx, fy) {
  let best = Infinity;
  for (const h of hazards) best = Math.min(best, pointRectDistance(fx, fy, h));
  return best;
}

/**
 * 4-neighbour flood fill on the GRID lattice of feet positions.
 * `extraBlocked(fx, fy)` can refuse more nodes (hazards, the encounter band).
 */
function floodFill(blocker, start, extraBlocked = () => false) {
  const reached = new Uint8Array(GW * GH);
  const sx = Math.round(start.x / GRID), sy = Math.round(start.y / GRID);
  const ok = (gx, gy) => blocker.bodyFree(gx * GRID, gy * GRID) && !extraBlocked(gx * GRID, gy * GRID);
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

/** The reached node closest to (px, py) within maxDist, or null. */
function nearestReachedNode(reached, px, py, maxDist) {
  let best = null, bestD = Infinity;
  someReached(reached, { x: px - maxDist, y: py - maxDist, w: maxDist * 2, h: maxDist * 2 }, (fx, fy, n) => {
    const d = Math.hypot(fx - px, fy - py);
    if (d <= maxDist && d < bestD) { bestD = d; best = n; }
    return false;
  });
  return best;
}

/** The reached node closest to rect r (nearest-edge distance <= maxDist, outside r), or null. */
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

/** Reached nodes whose body is within EDGE_MARGIN of the map border. */
function edgeTouches(reached) {
  const hits = [];
  for (let n = 0; n < reached.length; n++) {
    if (!reached[n]) continue;
    const p = nodeXY(n);
    const b = bodyAt(p.x, p.y);
    if (b.x < EDGE_MARGIN || b.y < EDGE_MARGIN || right(b) > MAP_W - EDGE_MARGIN || bottom(b) > MAP_H - EDGE_MARGIN) hits.push(p);
  }
  return hits;
}

/** Solid rects standing in for the NPC bodies (they all stand still). */
function npcBlockers(map) {
  return map.npcs.map((npc) => ({ x: npc.x - BODY_W / 2, y: npc.y - BODY_H, w: BODY_W, h: BODY_H }));
}

/** Tiny binary min-heap of [priority, value] pairs. */
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
 * The narrowest choke of the best route between two reached nodes.
 *   1. Widest path (bucket-queue Dijkstra): the route whose smallest clearance is as large as
 *      possible. Nodes within INTERACT_RADIUS of either end count as wide open, because that's
 *      the NPC's own spot, not a choke on the way.
 *   2. Shortest route among those that are at least that wide (BFS), so the reported choke sits
 *      on the path a player would actually walk.
 * Returns { width, choke: {x, y} | null } (choke is null when nothing on the way is narrower
 * than MAX_CLEARANCE).
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

  // 1. Widest path value.
  const best = new Int16Array(GW * GH).fill(-1);
  const buckets = Array.from({ length: MAX_CLEARANCE + 1 }, () => []);
  best[from] = eff(from);
  buckets[best[from]].push(from);
  for (let level = best[from]; level >= 0;) {
    if (buckets[level].length === 0) { level--; continue; }
    const cur = buckets[level].pop();
    if (best[cur] !== level) continue; // stale entry
    if (cur === to) break;
    for (const n of neighbours(cur)) {
      const cand = Math.min(level, eff(n));
      if (cand > best[n]) { best[n] = cand; buckets[cand].push(n); }
    }
  }
  const width = best[to];
  if (width < 0) return null;

  // 2. Among routes at least that wide, the cheapest one where hugging walls costs extra
  //    (step cost 1 + 8 / (1 + clearance)), so it runs down the middle of streets and its
  //    narrowest node is the real bottleneck rather than a wall it brushed past.
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
  for (let n = to; n !== -1; n = parent[n]) {
    if (eff(n) < MAX_CLEARANCE && (choke === null || eff(n) < eff(choke))) choke = n;
    if (n === from) break;
  }
  return { width, choke: choke === null ? null : nodeXY(choke) };
}

// ---------------------------------------------------------------------------
// 3. Reachability, clearances and crawlers.

function mapChecks(map) {
  const out = [];
  const zone = (id) => map.zones.find((z) => z.id === id);
  const npc = (id) => map.npcs.find((n) => n.id === id);
  const hazards = map.hazards || [];
  const inHazard = (fx, fy) => hazards.some((h) => inside(fx, fy, h));
  const encounter = zone('encounter'), rig = zone('rig'), exit = zone('exit');

  const walls = buildBlocker(map.colliders);                               // NPCs gone (all joined)
  const wallsAndNpcs = buildBlocker([...map.colliders, ...npcBlockers(map)]); // NPCs standing

  const open = floodFill(walls, map.spawn);
  const safe = floodFill(wallsAndNpcs, map.spawn, inHazard);
  const any = floodFill(wallsAndNpcs, map.spawn);
  out.push(check('spawn: body is free and not in a hazard', safe.startFree, fmtPt(map.spawn)));
  out.push(check('spawn: near the top edge', map.spawn.y <= 80, `y ${map.spawn.y}`));

  // Required targets: hazard-free from the spawn ------------------------------------------
  const targets = [];
  for (const id of Object.keys(REQUIRED.npcs)) {
    const n = npc(id);
    const hit = nearestReachedNode(safe.reached, n.x, n.y, INTERACT_RADIUS);
    targets.push({ name: id, node: hit });
    out.push(check(`hazard-free route: spawn -> ${id}`, hit !== null, fmtPt(n)));
  }
  const rigNode = nearestReachedToRect(safe.reached, rig, INTERACT_RADIUS);
  targets.push({ name: 'rig', node: rigNode });
  out.push(check('hazard-free route: spawn -> rig (within interaction range)', rigNode !== null));
  let exitNode = null;
  someReached(safe.reached, exit, (fx, fy, n) => { if (inside(fx, fy, exit)) { exitNode = n; return true; } return false; });
  targets.push({ name: 'exit', node: exitNode });
  out.push(check('hazard-free route: spawn -> exit (feet inside the exit zone)', exitNode !== null));
  out.push(check('exit sits on the east edge', right(exit) === MAP_W, `x ${exit.x}-${right(exit)}`));

  // The encounter band ------------------------------------------------------------------
  let encounterHit = false;
  someReached(safe.reached, encounter, (fx, fy) => (encounterHit = inside(fx, fy, encounter)));
  out.push(check('encounter: reachable hazard-free (feet inside)', encounterHit));
  out.push(check('encounter: spawn is outside the band', !inside(map.spawn.x, map.spawn.y, encounter)));
  const bypass = floodFill(walls, map.spawn, (fx, fy) => inside(fx, fy, encounter));
  const leaked = ['kael', 'nova', 'ryn', 'eli'].filter((id) => {
    const n = npc(id);
    return nearestReachedNode(bypass.reached, n.x, n.y, INTERACT_RADIUS + 20) !== null;
  });
  let exitLeak = false;
  someReached(bypass.reached, exit, (fx, fy) => (exitLeak = inside(fx, fy, exit)));
  out.push(check('encounter: it spans the road (no way to Kael, the others or the exit without crossing it)',
    leaked.length === 0 && !exitLeak, leaked.join(', ')));
  const kaelDist = pointRectDistance(npc('kael').x, npc('kael').y, encounter);
  out.push(check('encounter: between the spawn and Kael', encounter.y > map.spawn.y && encounter.y < npc('kael').y,
    `band y ${encounter.y}-${bottom(encounter)}, Kael ${Math.round(kaelDist)} px away`));

  // Optional targets: reachable at all (hazards allowed) -----------------------------------
  for (const p of map.pickups) {
    const hit = nearestReachedNode(any.reached, p.x, p.y, INTERACT_RADIUS);
    const safeHit = nearestReachedNode(safe.reached, p.x, p.y, INTERACT_RADIUS);
    out.push(check(`pickup ${p.id} reachable`, hit !== null, `${fmtPt(p)}${safeHit !== null ? ', hazard-free' : ', only through a hazard'}`));
  }
  for (const r of map.inspectables) {
    const sides = reachableSides(any.reached, r, INTERACT_RADIUS);
    const safeSides = reachableSides(safe.reached, r, INTERACT_RADIUS);
    out.push(check(`inspectable ${r.id} has a reachable side`, sides.length > 0, `sides ${sides.join('') || '-'}, hazard-free ${safeSides.join('') || '-'}`));
  }
  for (const cp of map.checkpoints) {
    const r = cp.respawn;
    let entered = false;
    someReached(safe.reached, cp, (fx, fy) => (entered = inside(fx, fy, cp)));
    const respawnOk = wallsAndNpcs.bodyFree(r.x, r.y) && !inHazard(r.x, r.y) &&
      nearestReachedNode(safe.reached, r.x, r.y, GRID * 2) !== null;
    out.push(check(`checkpoint ${cp.id}: enterable and respawn point free`, entered && respawnOk, fmtPt(r)));
  }
  const cp1 = map.checkpoints.find((c) => c.id === 'ws-cp-1');
  const cp2 = map.checkpoints.find((c) => c.id === 'ws-cp-2');
  out.push(check('ws-cp-1 is at the spawn', cp1 && inside(map.spawn.x, map.spawn.y, cp1)));
  const novaToCp2 = cp2 ? pointRectDistance(npc('nova').x, npc('nova').y, cp2) : Infinity;
  out.push(check('ws-cp-2 is near Nova (<= 80 px)', novaToCp2 <= 80, `${Math.round(novaToCp2)} px`));

  // Edges --------------------------------------------------------------------------------
  const exitPad = { x: exit.x - EDGE_MARGIN, y: exit.y - EDGE_MARGIN, w: exit.w + EDGE_MARGIN * 2, h: exit.h + EDGE_MARGIN * 2 };
  const leaks = edgeTouches(open.reached).filter((p) => !inside(p.x, p.y, exitPad));
  out.push(check('edges: sealed everywhere except the exit', leaks.length === 0, leaks.slice(0, 5).map(fmtPt).join(' ')));
  const exitEdge = edgeTouches(open.reached).some((p) => inside(p.x, p.y, exitPad));
  out.push(check('edges: the exit reaches the east edge', exitEdge));

  // Clearances ---------------------------------------------------------------------------
  const clearanceOf = (p) => Math.min(...map.colliders.map((c) => pointRectDistance(p.x, p.y, c)));
  const edgeOf = (p) => Math.min(p.x, p.y, MAP_W - p.x, MAP_H - p.y);
  for (const n of map.npcs) {
    const c = clearanceOf(n), e = edgeOf(n);
    out.push(check(`clearance: ${n.id} >= ${CLEAR_COLLIDER} px from colliders, >= ${CLEAR_EDGE} px from edges, not in a hazard`,
      c >= CLEAR_COLLIDER && e >= CLEAR_EDGE && !inHazard(n.x, n.y), `collider ${c.toFixed(1)}, edge ${e}`));
  }
  for (const p of map.pickups) {
    const c = clearanceOf(p), e = edgeOf(p);
    out.push(check(`clearance: ${p.id} >= ${CLEAR_COLLIDER} px from colliders, >= ${CLEAR_EDGE} px from edges, not in a hazard`,
      c >= CLEAR_COLLIDER && e >= CLEAR_EDGE && !inHazard(p.x, p.y), `collider ${c.toFixed(1)}, edge ${e}`));
  }

  // Crawler groups -----------------------------------------------------------------------
  const keepAway = [{ id: 'spawn', ...map.spawn }, ...map.npcs];
  for (const g of map.crawlers) {
    const nearest = keepAway.reduce((a, b) => (dist(g, a) <= dist(g, b) ? a : b));
    out.push(check(`crawlers ${g.id}: >= ${CRAWLER_SAFE} px from the spawn and every NPC`, dist(g, nearest) >= CRAWLER_SAFE,
      `${Math.round(dist(g, nearest))} px from ${nearest.id}`));
    const centreOk = walls.bodyFree(g.x, g.y) && nearestReachedNode(open.reached, g.x, g.y, GRID * 2) !== null;
    out.push(check(`crawlers ${g.id}: centre on open, reachable ground`, centreOk, fmtPt(g)));
    // Kael hands over the rebar in the encounter, so no group may be met before it.
    const beforeEncounter = nearestReachedNode(bypass.reached, g.x, g.y, g.radius) !== null;
    out.push(check(`crawlers ${g.id}: behind the encounter band (you have a weapon by then)`, !beforeEncounter));
  }

  // Required legs: narrowest chokes, kept clear of crawler groups ---------------------------
  const clr = new Int16Array(GW * GH);
  for (let n = 0; n < clr.length; n++) {
    if (!safe.reached[n]) continue;
    const p = nodeXY(n);
    // Standing NPCs aren't chokes (they join the party), so clearance counts walls and hazards only.
    clr[n] = Math.min(walls.clearance(p.x, p.y), Math.floor(hazardDistance(hazards, p.x, p.y)), MAX_CLEARANCE);
  }
  const spawnNode = node(Math.round(map.spawn.x / GRID), Math.round(map.spawn.y / GRID));
  const legs = [{ name: 'spawn', node: spawnNode }, ...targets];
  const chokes = [];
  for (let i = 1; i < legs.length; i++) {
    const a = legs[i - 1], b = legs[i];
    const label = `leg ${a.name} -> ${b.name}`;
    if (a.node === null || b.node === null) { out.push(check(label, false, 'endpoint unreachable')); continue; }
    const res = legChoke(safe.reached, clr, a.node, b.node);
    if (!res) { out.push(check(label, false, 'no hazard-free route')); continue; }
    if (!res.choke) { out.push(check(`${label}: no choke narrower than ${MAX_CLEARANCE} px`, true)); continue; }
    chokes.push({ leg: label, ...res });
    const blockers = map.crawlers.filter((g) => dist(g, res.choke) <= g.radius + 8);
    out.push(check(`${label}: narrowest choke is free of crawler groups`, blockers.length === 0,
      `choke ${fmtPt(res.choke)}, ${res.width} px spare on each side of the body` +
      `${blockers.length ? `, inside ${blockers.map((g) => g.id).join(',')}` : ''}`));
  }

  return { checks: out, open, safe, chokes };
}

// ---------------------------------------------------------------------------
// 4. Overlay preview.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function label(x, y, text, color, size = 10) {
  return `<text x="${x}" y="${y}" font-family="Menlo, monospace" font-size="${size}" fill="${color}" ` +
    `stroke="#000" stroke-width="2.5" paint-order="stroke">${esc(text)}</text>`;
}

const HAZARD_COLORS = { toxic: '#30ff40', corrupt: '#b040ff', fire: '#ff8a00' };

function overlaySvg(map, chokes, { indices = false } = {}) {
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${MAP_W}" height="${MAP_H}">`];

  map.colliders.forEach((c, i) => {
    parts.push(`<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" fill="#ff2020" fill-opacity="0.35" stroke="#ff2020" stroke-opacity="0.9" stroke-width="1"/>`);
    if (indices) parts.push(label(c.x + 1, c.y + 8, i, '#ffd0d0', 8));
  });

  for (const h of map.hazards) {
    const col = HAZARD_COLORS[h.type];
    parts.push(`<rect x="${h.x}" y="${h.y}" width="${h.w}" height="${h.h}" fill="${col}" fill-opacity="0.3" stroke="${col}" stroke-width="1.5" stroke-dasharray="4 2"/>`);
  }

  for (const z of map.zones) {
    parts.push(`<rect x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" fill="#ff00ff" fill-opacity="0.3" stroke="#ff00ff" stroke-width="1.5"/>`);
    parts.push(label(z.x + 2, z.y - 3, z.id, '#ff80ff'));
  }

  for (const cp of map.checkpoints) {
    parts.push(`<rect x="${cp.x + 0.5}" y="${cp.y + 0.5}" width="${cp.w - 1}" height="${cp.h - 1}" fill="none" stroke="#ffffff" stroke-width="1.5" stroke-dasharray="5 3"/>`);
    parts.push(`<circle cx="${cp.respawn.x}" cy="${cp.respawn.y}" r="3" fill="#ffffff"/>`);
    parts.push(label(cp.x + 2, bottom(cp) + 11, cp.id, '#ffffff'));
  }

  for (const r of map.inspectables) {
    parts.push(`<rect x="${r.x + 0.5}" y="${r.y + 0.5}" width="${r.w - 1}" height="${r.h - 1}" fill="none" stroke="#3ad4e8" stroke-width="2"/>`);
    parts.push(label(r.x + 2, bottom(r) - 4, `inspect:${r.id}`, '#8ff0ff'));
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

  for (const n of map.npcs) {
    const b = bodyAt(n.x, n.y);
    parts.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="#ffe030" fill-opacity="0.5" stroke="#000" stroke-width="1"/>`);
    parts.push(`<circle cx="${n.x}" cy="${n.y}" r="4" fill="#ffe030" stroke="#000" stroke-width="1"/>`);
    parts.push(label(n.x + 7, n.y - 4, `${n.name} (${n.facing})`, '#ffe860'));
  }

  for (const c of chokes) {
    parts.push(`<path d="M${c.choke.x - 4},${c.choke.y - 4} L${c.choke.x + 4},${c.choke.y + 4} M${c.choke.x - 4},${c.choke.y + 4} L${c.choke.x + 4},${c.choke.y - 4}" stroke="#00ffff" stroke-width="2"/>`);
  }

  const s = map.spawn;
  parts.push(`<circle cx="${s.x}" cy="${s.y}" r="5" fill="#ffffff" stroke="#000" stroke-width="1"/>`);
  parts.push(label(s.x + 7, s.y + 4, 'spawn', '#ffffff'));

  for (const [stage, m] of Object.entries(map.markers || {})) {
    parts.push(`<path d="M${m.x},${m.y - 5} L${m.x + 5},${m.y} L${m.x},${m.y + 5} L${m.x - 5},${m.y} Z" fill="#ffff00" stroke="#000" stroke-width="1"/>`);
    parts.push(label(m.x + 7, m.y + 12, `marker:${stage}`, '#ffff80', 9));
  }

  parts.push('</svg>');
  return parts.join('\n');
}

async function renderOverlay(map, chokes, file, extraLayers = [], opts = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const layers = [...extraLayers, { input: Buffer.from(overlaySvg(map, chokes, opts)) }];
  await sharp(MAP_PNG).composite(layers).png({ compressionLevel: 9 }).toFile(file);
}

/** RGBA layer that tints reached feet positions (debug only). */
function reachLayer(reached, rgba) {
  const buf = Buffer.alloc(MAP_W * MAP_H * 4);
  for (let n = 0; n < reached.length; n++) {
    if (!reached[n]) continue;
    const p = nodeXY(n);
    for (let y = p.y; y < Math.min(MAP_H, p.y + GRID); y++) {
      for (let x = p.x; x < Math.min(MAP_W, p.x + GRID); x++) {
        const i = (y * MAP_W + x) * 4;
        buf[i] = rgba[0]; buf[i + 1] = rgba[1]; buf[i + 2] = rgba[2]; buf[i + 3] = rgba[3];
      }
    }
  }
  return { input: buf, raw: { width: MAP_W, height: MAP_H, channels: 4 } };
}

// ---------------------------------------------------------------------------

function printResults(title, results) {
  console.log(`\n${title}`);
  for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  [${r.detail}]` : ''}`);
}

async function main() {
  const args = process.argv.slice(2);
  const debugDir = args.includes('--debug') ? args[args.indexOf('--debug') + 1] : null;
  const all = [];

  const meta = await sharp(MAP_PNG).metadata();
  const sizeOk = check(`wasteland.png is ${MAP_W}x${MAP_H}`, meta.width === MAP_W && meta.height === MAP_H, `${meta.width}x${meta.height}`);
  printResults('Map image', [sizeOk]);
  all.push(sizeOk);

  const map = JSON.parse(await fs.readFile(MAP_JSON, 'utf8'));
  const schema = validateSchema(map);
  printResults('wasteland.json schema', schema);
  all.push(...schema);

  const { checks, open, safe, chokes } = mapChecks(map);
  printResults('Reachability, hazards, clearances, crawlers (player body 16x10, grid 2 px)', checks);
  all.push(...checks);

  console.log('\nCounts');
  console.log(`  colliders ${map.colliders.length}, hazards ${map.hazards.length} (` +
    HAZARD_TYPES.map((t) => `${t} ${map.hazards.filter((h) => h.type === t).length}`).join(', ') +
    `), npcs ${map.npcs.length}, pickups ${map.pickups.length}, inspectables ${map.inspectables.length}, ` +
    `zones ${map.zones.length}, checkpoints ${map.checkpoints.length}, crawler groups ${map.crawlers.length}`);

  await renderOverlay(map, chokes, OVERLAY_PNG);
  console.log(`\nOverlay written to ${path.relative(ROOT, OVERLAY_PNG)}`);

  if (debugDir) {
    await fs.mkdir(debugDir, { recursive: true });
    const file = path.join(debugDir, 'wasteland-reach.png');
    await renderOverlay(map, chokes, file, [reachLayer(open.reached, [255, 140, 0, 90]), reachLayer(safe.reached, [0, 255, 255, 70])], { indices: true });
    console.log(`Debug reach map written to ${file} (orange = walkable, cyan = hazard-free)`);
  }

  const failed = all.filter((r) => !r.pass);
  console.log(`\n${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`} (${all.length} checks)`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

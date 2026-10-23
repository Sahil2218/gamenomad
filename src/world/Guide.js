import Phaser from 'phaser';
import tuning from '../data/tuning.json';
import { GameState } from '../systems/GameState.js';

const T = tuning.guide;

// The player's physics body is 16×10 with its bottom-centre at the feet (entities/Character.js):
// it reaches 8 px left and right of the feet point, 10 px up, and 0 px down.
const PLAYER_BODY = { left: 8, right: 8, up: 10, down: 0 };
// If no route exists for the real body, we try once more with a slightly smaller 12×8 one,
// in case a passage is only just wide enough and rounding sealed it.
const TIGHT_BODY = { left: 6, right: 6, up: 8, down: 0 };

// The 8 neighbours of a grid cell. Straight steps cost 1, diagonal steps √2 (Pythagoras).
const STEP_X = [1, -1, 0, 0, 1, 1, -1, -1];
const STEP_Y = [0, 0, 1, -1, 1, -1, 1, -1];
const STEP_COST = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

// Cell states in WalkGrid.walkable.
const BLOCKED = 0;
const OPEN = 1; // the cell's centre is a valid spot
const EDGE = 2; // the centre isn't, but some other spot in the cell is (narrow gaps, wall edges)
const SUBSAMPLES = 4; // edge cells are probed on a 4×4 sub-grid (every 2 px for 8 px cells)
const EDGE_PENALTY = 0.4; // extra A* cost for edge cells, so routes keep off walls when there's room

const CRUMB_FALLBACK = 'guide-crumb'; // drawn once if fx-glow is missing
const DIAMOND_TEXTURE = 'guide-diamond';
const GLOW_SIZE = 32; // fx-glow is 32×32

/**
 * The gold guide trail: glowing breadcrumbs on the ground that lead the player to the
 * current objective (GameState.objectiveMarker()) along a route they can actually walk.
 *
 *   const guide = new Guide(scene, player, map.colliderRects, map.width, map.height);
 *   guide.update(time);   // every frame
 *
 * How it works:
 *   1. Once, at the start, the map is cut into 8 px cells and every cell is marked walkable or
 *      blocked (WalkGrid below).
 *   2. Every ~400 ms (sooner if the target changes or the player has moved), A* search finds the
 *      shortest chain of cells from the player to the target.
 *   3. "String pulling" removes every cell that isn't a corner, which leaves a few straight lines.
 *      No route at all? We retry with a slightly smaller body (12×8); if that fails too, no trail.
 *   4. Each frame, crumbs are placed every ~14 px along those lines, from just ahead of the
 *      player to ~420 px out, with a brightness wave "marching" toward the target.
 *
 * The route is also written to GameState.guidePath, so the minimap can draw it.
 */
export default class Guide {
  /** colliderRects: Phaser.Geom.Rectangles (map.colliderRects) or plain { x, y, w, h } objects. */
  constructor(scene, player, colliderRects, width, height) {
    this.scene = scene;
    this.player = player;
    this.colliderRects = colliderRects || [];
    this.mapSize = { width, height };
    this.grid = new WalkGrid(this.colliderRects, width, height, {
      cell: T.cellPx,
      body: PLAYER_BODY,
      pad: T.padPx,
    });
    this.tightGrid = null; // the 12×8 fallback grid, built the first time it's needed

    this.path = []; // [{ x, y }] from the player to the target (corners only)
    this.lengths = []; // scratch: length of each path segment, refilled every frame
    this.reachesTarget = false; // false if the route stops short (unreachable / search budget hit)
    this.target = null; // the objective point we routed to last time
    this.computedAt = -Infinity; // scene time of the last search
    this.computedFrom = null; // where the player stood for that search
    this.mustRecompute = true;
    this.wasEnabled = null;
    this.visibility = 0; // 0..1: eases in and out, so the trail never pops on or off
    this.lastTime = null;
    this.lastSearch = null; // { ms, expanded, reached } of the latest search (handy for tuning)
    this.destroyed = false;

    this.color = Phaser.Display.Color.HexStringToColor(T.color).color;
    this.coreColor = Phaser.Display.Color.HexStringToColor(T.coreColor).color;
    this.createSprites();

    GameState.guidePath = [];
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, this.destroy, this);
  }

  /** Force a new search on the next update (e.g. after a teleport or a scripted change). */
  refresh() {
    this.mustRecompute = true;
  }

  /** Removes the trail's sprites and clears GameState.guidePath. Safe to call twice. */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.scene.events.off(Phaser.Scenes.Events.SHUTDOWN, this.destroy, this);
    this.crumbs.forEach((crumb) => crumb.destroy());
    this.cores.forEach((core) => core.destroy());
    this.shadows.forEach((shadow) => shadow.destroy());
    this.crumbs = [];
    this.cores = [];
    this.shadows = [];
    this.diamond.destroy();
    this.diamondGlow.destroy();
    GameState.guidePath = [];
  }

  /** Call once per frame from the scene's update(time). */
  update(time) {
    if (this.destroyed) return;
    const dt = this.frameSeconds(time);

    // guideEnabled is a player setting (G key). Treat "not there yet" as on.
    const enabled = GameState.guideEnabled !== false;
    if (enabled !== this.wasEnabled) this.mustRecompute = true; // switched back on: route at once
    this.wasEnabled = enabled;

    const target = enabled ? GameState.objectiveMarker() : null;
    if (!target) this.clearPath();
    else if (this.needsRecompute(time, target)) this.recompute(time, target);
    else this.followPlayer();

    // We keep routing during dialogue (the quest may change), but only draw when the player can walk.
    const show = this.path.length >= 2 && !GameState.inputLocked;
    const fadeStep = dt * T.fadePerSec;
    this.visibility = Phaser.Math.Clamp(this.visibility + (show ? fadeStep : -fadeStep), 0, 1);

    this.render(time);
  }

  // ---------- routing ----------

  needsRecompute(time, target) {
    if (this.mustRecompute || !this.target) return true;
    if (Phaser.Math.Distance.BetweenPoints(target, this.target) > 1) return true; // a new objective
    const moved = Phaser.Math.Distance.BetweenPoints(this.player, this.computedFrom);
    if (moved > T.moveThresholdPx) return true;
    // The map never changes, so if the player hasn't moved either, the answer would be identical.
    return time - this.computedAt >= T.recomputeMs && moved >= 1;
  }

  recompute(time, target) {
    const started = performance.now();
    const options = { maxNodes: T.maxNodes, snapRadius: T.snapRadiusCells, reachPx: T.reachPx };
    const { x, y } = this.player;

    let grid = 'body';
    let result = this.grid.findPath(x, y, target.x, target.y, options);
    if (!result) {
      grid = 'tight';
      result = this.tightWalkGrid().findPath(x, y, target.x, target.y, options);
    }

    if (result) {
      this.path = result.points;
      this.reachesTarget = result.reached;
    } else {
      // Not even the smaller body gets there: better no trail than one that walks into a wall.
      grid = 'none';
      this.path = [];
      this.reachesTarget = false;
    }

    this.lastSearch = {
      ms: performance.now() - started,
      expanded: result ? result.expanded : 0,
      reached: this.reachesTarget,
      grid, // 'body' (16×10), 'tight' (12×8 fallback) or 'none'
    };
    this.target = { x: target.x, y: target.y };
    this.computedAt = time;
    this.computedFrom = { x: this.player.x, y: this.player.y };
    this.mustRecompute = false;
    this.publishPath();
  }

  /**
   * Between searches, start the route at the player's feet, and drop the next corner
   * once the one after it is already in plain view (the player cut the corner).
   */
  followPlayer() {
    if (this.path.length < 2) return;
    this.path[0].x = this.player.x; // path points are our own objects, so we can move them in place
    this.path[0].y = this.player.y;

    let trimmed = false;
    while (this.path.length > 2 && this.grid.lineWalkable(this.path[0], this.path[2])) {
      this.path.splice(1, 1);
      trimmed = true;
    }
    if (trimmed) this.publishPath();
  }

  clearPath() {
    if (this.path.length === 0 && this.target === null) return;
    this.path = [];
    this.target = null;
    this.reachesTarget = false;
    GameState.guidePath = [];
  }

  /** The 12×8 fallback grid. Most maps never need it, so it's only built on first use. */
  tightWalkGrid() {
    if (!this.tightGrid) {
      const { width, height } = this.mapSize;
      this.tightGrid = new WalkGrid(this.colliderRects, width, height, { cell: T.cellPx, body: TIGHT_BODY, pad: 0 });
    }
    return this.tightGrid;
  }

  /** The minimap reads this: a fresh array of whole-pixel points. */
  publishPath() {
    GameState.guidePath = this.path.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
  }

  // ---------- drawing ----------

  createSprites() {
    const scene = this.scene;
    const hasGlow = scene.textures.exists('fx-glow');
    const crumbKey = hasGlow ? 'fx-glow' : makeCrumbTexture(scene);
    // Whatever texture we use, make a crumb the same size on screen (32 px × T.scale).
    const crumbSize = scene.textures.get(crumbKey).getSourceImage().width || GLOW_SIZE;
    this.crumbScale = (T.scale * GLOW_SIZE) / crumbSize;

    // A pool: every crumb we could ever need is made now, then just moved and shown or hidden.
    // Each crumb is two images: a soft gold halo and a small bright core on top of it.
    // ADD blending adds the colour to what is underneath, so they look like light on the ground.
    const poolSize = Math.ceil((T.maxPx - T.startPx) / T.spacingPx) + 2;
    this.crumbs = []; // halos
    this.cores = [];
    this.shadows = []; // dark blobs under each crumb, for contrast on bright ground
    for (let i = 0; i < poolSize; i += 1) {
      // Normal blend + black tint turns the soft glow texture into a soft shadow.
      const shadow = scene.add.image(0, 0, crumbKey).setTint(0x000000).setDepth(T.depth - 0.01).setVisible(false);
      this.shadows.push(shadow);
      const crumb = scene.add.image(0, 0, crumbKey);
      crumb.setTint(this.color).setBlendMode(Phaser.BlendModes.ADD).setDepth(T.depth).setVisible(false);
      this.crumbs.push(crumb);
      const core = scene.add.image(0, 0, crumbKey);
      core.setTint(this.coreColor).setBlendMode(Phaser.BlendModes.ADD).setDepth(T.depth).setVisible(false);
      this.cores.push(core);
    }

    // The target marker: a flat diamond on the floor with a soft glow underneath.
    makeDiamondTexture(scene);
    this.diamondGlow = scene.add.image(0, 0, crumbKey).setTint(this.color).setBlendMode(Phaser.BlendModes.ADD);
    this.diamondGlow.setDepth(T.depth).setVisible(false);
    this.diamond = scene.add.image(0, 0, DIAMOND_TEXTURE).setTint(this.color).setBlendMode(Phaser.BlendModes.ADD);
    this.diamond.setDepth(T.depth + 0.01).setVisible(false);
  }

  render(time) {
    if (this.visibility <= 0 || this.path.length < 2) {
      this.hideAll();
      return;
    }

    const lengths = segmentLengths(this.path, this.lengths);
    const total = lengths.reduce((sum, l) => sum + l, 0);
    const used = this.placeCrumbs(time, lengths, total);
    for (let i = used; i < this.crumbs.length; i += 1) {
      this.crumbs[i].setVisible(false);
      this.cores[i].setVisible(false);
      this.shadows[i].setVisible(false);
    }
    this.placeDiamond(time, total);
  }

  /**
   * Crumbs are spaced from the TARGET end of the route (total − k × spacing), so they stay put on
   * the ground while the player walks toward them, instead of sliding along with the player.
   * Returns how many crumbs were used.
   */
  placeCrumbs(time, lengths, total) {
    const spacing = T.spacingPx;
    // k = 0 is the target itself (the diamond sits there when the route reaches it).
    const firstK = Math.max(this.reachesTarget ? 1 : 0, Math.ceil((total - T.maxPx) / spacing));
    const lastK = Math.floor((total - T.startPx) / spacing);

    // Walk the route once from the player outward: distances grow as k shrinks.
    let used = 0;
    let segment = 0;
    let segmentStart = 0; // distance along the route where `segment` begins
    for (let k = lastK; k >= firstK && used < this.crumbs.length; k -= 1) {
      const distance = total - k * spacing;
      while (segment < lengths.length - 1 && distance > segmentStart + lengths[segment]) {
        segmentStart += lengths[segment];
        segment += 1;
      }
      const t = lengths[segment] > 0 ? (distance - segmentStart) / lengths[segment] : 0;
      const a = this.path[segment];
      const b = this.path[segment + 1];

      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      const wave = marchingWave(distance, time);
      const fade = this.visibility * distanceFade(distance);
      const brightness = 1 - T.waveBoost + T.waveBoost * wave;

      const crumb = this.crumbs[used];
      const haloAlpha = fade * T.alpha * brightness;
      crumb.setPosition(x, y).setScale(this.crumbScale * (1 + T.waveScale * wave));
      crumb.setAlpha(haloAlpha).setVisible(haloAlpha > 0.01);

      const shadow = this.shadows[used];
      const shadowAlpha = fade * (T.shadowAlpha ?? 0.5);
      shadow.setPosition(x, y + 1).setScale(this.crumbScale * ((T.shadowScale ?? 0.17) / T.scale));
      shadow.setAlpha(shadowAlpha).setVisible(shadowAlpha > 0.01);

      const core = this.cores[used];
      const coreAlpha = fade * T.coreAlpha * (0.55 + 0.45 * brightness);
      core.setPosition(x, y).setScale(this.crumbScale * (T.coreScale / T.scale) * (1 + 0.5 * T.waveScale * wave));
      core.setAlpha(coreAlpha).setVisible(coreAlpha > 0.01);
      used += 1;
    }
    return used;
  }

  /** A pulsing diamond at the end of the route, once the end is within the trail's reach. */
  placeDiamond(time, total) {
    // Fades in over the last 40 px before it comes into range, rather than popping.
    const inRange = Phaser.Math.Clamp((T.maxPx + 20 - total) / 40, 0, 1);
    const alpha = this.reachesTarget ? this.visibility * inRange : 0;
    if (alpha <= 0.01) {
      this.diamond.setVisible(false);
      this.diamondGlow.setVisible(false);
      return;
    }

    const end = this.path[this.path.length - 1];
    const pulse = 0.5 + 0.5 * Math.sin((time / T.diamondPulseMs) * Math.PI * 2);
    // Squashed vertically, so it reads as lying flat on the ground.
    this.diamond.setPosition(end.x, end.y).setScale(1 + 0.25 * pulse, (1 + 0.25 * pulse) * 0.6);
    this.diamond.setAlpha(alpha * (0.65 + 0.35 * pulse)).setVisible(true);
    this.diamondGlow.setPosition(end.x, end.y).setScale(this.crumbScale * (2.2 + 0.8 * pulse));
    this.diamondGlow.setAlpha(alpha * (0.35 + 0.25 * pulse)).setVisible(true);
  }

  hideAll() {
    this.crumbs.forEach((crumb) => crumb.setVisible(false));
    this.cores.forEach((core) => core.setVisible(false));
    this.shadows.forEach((shadow) => shadow.setVisible(false));
    this.diamond.setVisible(false);
    this.diamondGlow.setVisible(false);
  }

  /** Seconds since the previous update (clamped, so a tab switch doesn't jump the fade). */
  frameSeconds(time) {
    const ms = this.lastTime === null ? 0 : time - this.lastTime;
    this.lastTime = time;
    return Phaser.Math.Clamp(ms / 1000, 0, 0.1);
  }
}

// ---------- crumb look ----------

/**
 * Brightness 0..1 at `distance` px along the route. The peaks move outward over time,
 * so the light seems to march from the player toward the target.
 */
function marchingWave(distance, time) {
  const phase = (distance - (time / 1000) * T.waveSpeedPx) / T.waveLengthPx;
  return 0.5 + 0.5 * Math.cos(phase * Math.PI * 2);
}

/** Alpha multiplier: fade in just ahead of the player, dim with distance, fade out at the far end. */
function distanceFade(distance) {
  const nearIn = Phaser.Math.Clamp((distance - T.startPx) / T.nearFadePx, 0, 1);
  const along = Phaser.Math.Clamp((distance - T.startPx) / (T.maxPx - T.startPx), 0, 1);
  const dimming = 1 - (1 - T.farAlpha) * along;
  const farOut = Phaser.Math.Clamp((T.maxPx - distance) / T.farFadePx, 0, 1);
  return nearIn * dimming * farOut;
}

/** Length of each segment of a polyline, written into `out` (reused every frame). */
function segmentLengths(points, out) {
  out.length = points.length - 1;
  for (let i = 1; i < points.length; i += 1) {
    out[i - 1] = Phaser.Math.Distance.BetweenPoints(points[i - 1], points[i]);
  }
  return out;
}

/** A soft white dot, for when fx-glow didn't load. Drawn once and kept as a texture. */
function makeCrumbTexture(scene) {
  if (!scene.textures.exists(CRUMB_FALLBACK)) {
    const g = scene.make.graphics({ x: 0, y: 0 }, false); // false = not added to the scene
    g.fillStyle(0xffffff, 0.2).fillCircle(8, 8, 8);
    g.fillStyle(0xffffff, 0.45).fillCircle(8, 8, 5);
    g.fillStyle(0xffffff, 1).fillCircle(8, 8, 2.5);
    g.generateTexture(CRUMB_FALLBACK, 16, 16);
    g.destroy();
  }
  return CRUMB_FALLBACK;
}

/** A small white diamond (outline plus a bright centre), tinted gold when used. */
function makeDiamondTexture(scene) {
  if (scene.textures.exists(DIAMOND_TEXTURE)) return;
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  const outer = [
    { x: 7, y: 0 },
    { x: 14, y: 7 },
    { x: 7, y: 14 },
    { x: 0, y: 7 },
  ];
  g.fillStyle(0xffffff, 0.35).fillPoints(outer, true);
  g.lineStyle(1, 0xffffff, 1).strokePoints(outer, true);
  g.fillStyle(0xffffff, 1).fillPoints(
    [
      { x: 7, y: 4 },
      { x: 10, y: 7 },
      { x: 7, y: 10 },
      { x: 4, y: 7 },
    ],
    true,
  );
  g.generateTexture(DIAMOND_TEXTURE, 15, 15);
  g.destroy();
}

// =====================================================================================
// WalkGrid: a coarse "can I stand here?" map, plus A* search on it.
// Exported so other systems (e.g. Waves steering crawlers) can reuse it.
// =====================================================================================

/**
 * The map cut into square cells. A cell is OPEN if a body whose reference point is at the cell's
 * centre would not overlap any collider and would stay inside the map. A cell whose centre fails
 * but which still has a valid spot somewhere inside is an EDGE cell: still walkable, and that spot
 * (not the centre) is where routes pass through it. Without edge cells, a gap only a little wider
 * than the body could fall between two cell centres and look like a wall.
 *
 * The test is exact: a body standing at (x, y) overlaps a collider exactly when (x, y) lies strictly
 * inside that collider "inflated" by the body's size (see blockRect). So instead of testing a body
 * rectangle against every wall for every cell, we grow each wall once and test single points.
 *
 *   findPath(ax, ay, bx, by)          A* → string-pulled polyline in world pixels
 *   lineWalkable(a, b)                is the straight line between two points clear of walls?
 *   nearestWalkable(cx, cy, region)   the closest walkable cell (optionally in a given area)
 *   distanceField(x, y)               steps from every cell to (x, y) (for steering crawlers)
 *
 * body: how far the body reaches from the reference point { left, right, up, down } in px.
 * pad:  extra px of clearance around every collider.
 */
export class WalkGrid {
  constructor(rects, width, height, { cell = 8, body = PLAYER_BODY, pad = 0 } = {}) {
    this.cell = cell;
    this.width = width;
    this.height = height;
    this.cols = Math.ceil(width / cell);
    this.rows = Math.ceil(height / cell);

    const size = this.cols * this.rows;
    this.walkable = new Uint8Array(size); // BLOCKED, OPEN or EDGE
    this.points = new Float32Array(size * 2); // where a route passes through each cell (x, y)
    this.region = new Int32Array(size); // which connected area a cell belongs to (0 = blocked)

    this.markInsideMap(body);
    rects.forEach((rect) => this.blockRect(rect, body, pad));
    this.buildFineGrid(rects, body, pad);
    this.findEdgeCells();
    this.labelRegions();

    // Scratch memory for A*, reused by every search so we never allocate per frame.
    // "seen"/"closed" hold the number of the search that last touched a cell, so we don't
    // have to wipe these arrays clean before each search.
    this.g = new Float64Array(size); // cost of the best known route from the start
    this.parent = new Int32Array(size); // the cell we came from on that route
    this.seen = new Uint32Array(size);
    this.closed = new Uint32Array(size);
    this.searchId = 0;
    this.open = new MinHeap(1024);
    this.field = null; // distanceField() output, allocated on first use
  }

  // ---------- cells ----------

  index(cx, cy) {
    return cy * this.cols + cx;
  }

  cellOf(px) {
    return Math.floor(px / this.cell);
  }

  /** World position of a cell's centre. */
  centre(c) {
    return c * this.cell + this.cell / 2;
  }

  /** OPEN or EDGE: you can stand somewhere in this cell. */
  isWalkable(cx, cy) {
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return false;
    return this.walkable[cy * this.cols + cx] !== BLOCKED;
  }

  /** Arcade physics stops bodies at the map edges, so the body must fit inside the map. */
  markInsideMap(body) {
    for (let cy = 0; cy < this.rows; cy += 1) {
      const y = this.centre(cy);
      const yOk = y - body.up >= 0 && y + body.down <= this.height;
      for (let cx = 0; cx < this.cols; cx += 1) {
        const x = this.centre(cx);
        const xOk = x - body.left >= 0 && x + body.right <= this.width;
        const c = this.index(cx, cy);
        this.walkable[c] = xOk && yOk ? OPEN : BLOCKED;
        this.points[c * 2] = x;
        this.points[c * 2 + 1] = y;
      }
    }
  }

  /**
   * Blocks every cell whose centre would put the body inside this collider.
   * The player's body at feet (x, y) is the rectangle (x − 8, y − 10, 16, 10). It overlaps the
   * collider (rx, ry, rw, rh) exactly when
   *     rx − 8 < x < rx + rw + 8   and   ry < y < ry + rh + 10
   * (the usual "two rectangles overlap" test, rearranged for x and y). That range is the
   * inflated wall below. Touching edges don't count, just like in Arcade physics.
   */
  blockRect(rect, body, pad) {
    const w = rect.width ?? rect.w;
    const h = rect.height ?? rect.h;
    // The inflated wall: reference points strictly inside this area make the body overlap it.
    const left = rect.x - body.right - pad;
    const right = rect.x + w + body.left + pad;
    const top = rect.y - body.down - pad;
    const bottom = rect.y + h + body.up + pad;

    const cx0 = Math.max(0, this.cellOf(left));
    const cx1 = Math.min(this.cols - 1, this.cellOf(right));
    const cy0 = Math.max(0, this.cellOf(top));
    const cy1 = Math.min(this.rows - 1, this.cellOf(bottom));
    for (let cy = cy0; cy <= cy1; cy += 1) {
      const y = this.centre(cy);
      if (y <= top || y >= bottom) continue;
      for (let cx = cx0; cx <= cx1; cx += 1) {
        const x = this.centre(cx);
        if (x > left && x < right) this.walkable[this.index(cx, cy)] = BLOCKED;
      }
    }
  }

  /**
   * The same valid/blocked test on a finer grid of spots (every 2 px for 8 px cells).
   * It finds the EDGE cells (findEdgeCells) and makes straight-line checks exact (lineWalkable).
   */
  buildFineGrid(rects, body, pad) {
    const step = this.cell / SUBSAMPLES;
    const fineCols = this.cols * SUBSAMPLES;
    const fineRows = this.rows * SUBSAMPLES;
    const fine = new Uint8Array(fineCols * fineRows).fill(1); // 1 = a valid spot
    const at = (i) => (i + 0.5) * step; // world position of fine sample i
    this.fine = fine;
    this.fineStep = step;
    this.fineCols = fineCols;
    this.fineRows = fineRows;

    // Samples too close to the map edge for the body: a few whole rows and columns at the borders.
    const edgeColumns = [];
    for (let fx = 0; fx < fineCols; fx += 1) {
      if (at(fx) - body.left < 0 || at(fx) + body.right > this.width) edgeColumns.push(fx);
    }
    for (let fy = 0; fy < fineRows; fy += 1) {
      const rowStart = fy * fineCols;
      if (at(fy) - body.up < 0 || at(fy) + body.down > this.height) fine.fill(0, rowStart, rowStart + fineCols);
      else edgeColumns.forEach((fx) => (fine[rowStart + fx] = 0));
    }
    // Samples inside an inflated collider.
    rects.forEach((rect) => {
      const w = rect.width ?? rect.w;
      const h = rect.height ?? rect.h;
      const left = rect.x - body.right - pad;
      const right = rect.x + w + body.left + pad;
      const top = rect.y - body.down - pad;
      const bottom = rect.y + h + body.up + pad;
      const fx0 = Math.max(0, Math.floor(left / step));
      const fx1 = Math.min(fineCols - 1, Math.floor(right / step));
      const fy0 = Math.max(0, Math.floor(top / step));
      const fy1 = Math.min(fineRows - 1, Math.floor(bottom / step));
      for (let fy = fy0; fy <= fy1; fy += 1) {
        const y = at(fy);
        if (y <= top || y >= bottom) continue;
        for (let fx = fx0; fx <= fx1; fx += 1) {
          const x = at(fx);
          if (x > left && x < right) fine[fy * fineCols + fx] = 0;
        }
      }
    });
  }

  /**
   * Looks again at every blocked cell on the fine grid. If any of its spots is valid, the cell
   * becomes an EDGE cell and routes go through the valid spot nearest its centre.
   */
  findEdgeCells() {
    const { fine, fineCols, fineStep: step } = this;
    const at = (i) => (i + 0.5) * step;
    // Each blocked cell: the first valid sample, trying those nearest the centre first.
    const order = sampleOrder();
    for (let c = 0; c < this.walkable.length; c += 1) {
      if (this.walkable[c] !== BLOCKED) continue;
      const cx = c % this.cols;
      const cy = (c - cx) / this.cols;
      for (let k = 0; k < order.length; k += 1) {
        const fx = cx * SUBSAMPLES + order[k].sx;
        const fy = cy * SUBSAMPLES + order[k].sy;
        if (!fine[fy * fineCols + fx]) continue;
        this.walkable[c] = EDGE;
        this.points[c * 2] = at(fx);
        this.points[c * 2 + 1] = at(fy);
        break;
      }
    }
  }

  /**
   * Flood-fills each connected walkable area with its own number. Two cells with different
   * numbers can never reach each other, so we can spot an unreachable target instantly.
   * (Diagonal moves need both side cells free, so "connected" only needs the 4 straight neighbours.)
   */
  labelRegions() {
    const queue = new Int32Array(this.cols * this.rows);
    let next = 0;
    for (let start = 0; start < this.walkable.length; start += 1) {
      if (!this.walkable[start] || this.region[start]) continue;
      next += 1;
      this.region[start] = next;
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      while (head < tail) {
        const node = queue[head++];
        const cx = node % this.cols;
        const cy = (node - cx) / this.cols;
        for (let i = 0; i < 4; i += 1) {
          const nx = cx + STEP_X[i];
          const ny = cy + STEP_Y[i];
          if (!this.isWalkable(nx, ny)) continue;
          const n = this.index(nx, ny);
          if (this.region[n]) continue;
          this.region[n] = next;
          queue[tail++] = n;
        }
      }
    }
    this.regionCount = next;
  }

  /** Region number at a world point (0 if blocked or off the map). */
  regionAt(px, py) {
    const cx = this.cellOf(px);
    const cy = this.cellOf(py);
    return this.isWalkable(cx, cy) ? this.region[this.index(cx, cy)] : 0;
  }

  /**
   * The walkable cell closest to (cx, cy), searching outward ring by ring up to maxRadius cells.
   * With region > 0, only cells in that connected area count. Returns a cell index or -1.
   */
  nearestWalkable(cx, cy, region = 0, maxRadius = 30) {
    let best = -1;
    let bestDistance = Infinity;
    for (let r = 0; r <= maxRadius; r += 1) {
      if (r > bestDistance) break; // nothing on a further ring can be closer
      for (let dy = -r; dy <= r; dy += 1) {
        // On the top and bottom rows of the ring take every cell; on the others only both ends.
        const xStep = dy === -r || dy === r ? 1 : 2 * r;
        for (let dx = -r; dx <= r; dx += xStep || 1) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (!this.isWalkable(nx, ny)) continue;
          const n = this.index(nx, ny);
          if (region && this.region[n] !== region) continue;
          const distance = Math.hypot(dx, dy);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = n;
          }
        }
      }
    }
    return best;
  }

  // ---------- A* search ----------

  /**
   * A walkable route from (ax, ay) to (bx, by), in world pixels.
   * Returns { points, reached, expanded } or null when there is no route.
   *   points    the string-pulled polyline: the exact start, then corners, then the end
   *   reached   false when the search budget ran out and the route stops at the closest point found
   *   expanded  how many cells A* looked at (for tuning)
   * A target inside a wall (an inspectable, a terminal…) is moved to the nearest free spot within
   * `snapRadius` cells. If that spot is in an area we can't reach, a spot of ours within `reachPx`
   * (close enough to interact) will do; otherwise there is no route (null).
   */
  findPath(ax, ay, bx, by, { maxNodes = 30000, snapRadius = 30, reachPx = 28 } = {}) {
    let start = this.cellIndexAt(ax, ay);
    const startSnapped = start === -1;
    if (startSnapped) start = this.nearestWalkable(this.cellOf(ax), this.cellOf(ay), 0, 4);
    if (start === -1) return null;
    const region = this.region[start];

    const gx = this.cellOf(bx);
    const gy = this.cellOf(by);
    let goal = this.cellIndexAt(bx, by);
    let goalSnapped = goal === -1;
    if (goalSnapped) goal = this.nearestWalkable(gx, gy, 0, snapRadius); // the target is inside a wall
    if (goal === -1) return null;
    if (this.region[goal] !== region) {
      // The target is in an area we can't walk to. Settle for a spot of ours in interaction range.
      goal = this.nearestWalkable(gx, gy, region, Math.ceil(reachPx / this.cell));
      goalSnapped = true;
      if (goal === -1 || this.distanceToCell(bx, by, goal) > reachPx) return null;
    }

    const search = this.search(start, goal, maxNodes);
    const cells = this.walkBack(search.end);

    // Cell points, but with the exact start and target where those are usable.
    const raw = cells.map((c) => this.cellPoint(c));
    if (raw.length === 1) raw.push({ ...raw[0] }); // start and goal share a cell: still two points
    if (startSnapped) raw.unshift({ x: ax, y: ay });
    else raw[0] = { x: ax, y: ay };
    if (search.reached && !goalSnapped) raw[raw.length - 1] = { x: bx, y: by };

    return { points: this.stringPull(raw), reached: search.reached, expanded: search.expanded };
  }

  /** Distance in px from a world point to where routes pass through cell c. */
  distanceToCell(px, py, c) {
    return Math.hypot(this.points[c * 2] - px, this.points[c * 2 + 1] - py);
  }

  /** Cell index under a world point, or -1 if that cell is blocked. */
  cellIndexAt(px, py) {
    const cx = this.cellOf(px);
    const cy = this.cellOf(py);
    return this.isWalkable(cx, cy) ? this.index(cx, cy) : -1;
  }

  /** Where routes pass through cell c: its centre, or for an edge cell its valid spot. */
  cellPoint(c) {
    return { x: this.points[c * 2], y: this.points[c * 2 + 1] };
  }

  /**
   * A* search: always expand the open cell with the lowest (cost so far + estimated cost to go).
   * The open set is a binary heap, so picking that cell is cheap. If the budget of maxNodes cells
   * runs out, the search stops and we use the explored cell that got closest to the goal.
   */
  search(start, goal, maxNodes) {
    const { cols, g, parent, seen, closed, open } = this;
    const id = (this.searchId += 1);
    const gx = goal % cols;
    const gy = (goal - gx) / cols;

    // Octile distance: the exact cost on an empty 8-direction grid. The tiny ×1.001 breaks ties
    // between equally good cells in favour of the one nearer the goal, which saves a lot of work.
    const estimate = (node) => {
      const x = node % cols;
      const dx = Math.abs(x - gx);
      const dy = Math.abs((node - x) / cols - gy);
      return (dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy)) * 1.001;
    };

    open.clear();
    g[start] = 0;
    parent[start] = -1;
    seen[start] = id;
    open.push(start, estimate(start));

    let expanded = 0;
    let closest = start;
    let closestEstimate = estimate(start);

    while (open.size > 0) {
      const node = open.pop();
      if (closed[node] === id) continue; // an old, worse copy of a cell we already finished
      closed[node] = id;
      if (node === goal) return { end: goal, reached: true, expanded };

      expanded += 1;
      const h = estimate(node);
      if (h < closestEstimate) {
        closestEstimate = h;
        closest = node;
      }
      if (expanded >= maxNodes) break; // budget spent: never stall a frame

      const cx = node % cols;
      const cy = (node - cx) / cols;
      for (let i = 0; i < 8; i += 1) {
        const nx = cx + STEP_X[i];
        const ny = cy + STEP_Y[i];
        if (!this.isWalkable(nx, ny)) continue;
        // No corner cutting: a diagonal step needs both cells beside it free too.
        if (i >= 4 && (!this.isWalkable(nx, cy) || !this.isWalkable(cx, ny))) continue;

        const next = ny * cols + nx;
        if (closed[next] === id) continue;
        const cost = g[node] + STEP_COST[i] + (this.walkable[next] === EDGE ? EDGE_PENALTY : 0);
        if (seen[next] === id && cost >= g[next]) continue; // already know a route at least as good

        seen[next] = id;
        g[next] = cost;
        parent[next] = node;
        open.push(next, cost + estimate(next));
      }
    }
    return { end: closest, reached: false, expanded };
  }

  /** Follows the parent links back from `end` to the start; returns cells start → end. */
  walkBack(end) {
    const cells = [];
    for (let node = end; node !== -1; node = this.parent[node]) cells.push(node);
    return cells.reverse();
  }

  /**
   * String pulling: from each corner, skip ahead to the furthest point we can still see in a
   * straight, walkable line. A staircase of grid cells becomes a few clean diagonal lines.
   */
  stringPull(points) {
    if (points.length <= 2) return points;
    const out = [points[0]];
    let anchor = 0;
    while (anchor < points.length - 1) {
      let next = anchor + 1;
      while (next + 1 < points.length && this.lineWalkable(points[anchor], points[next + 1])) next += 1;
      out.push(points[next]);
      anchor = next;
    }
    return out;
  }

  /**
   * True if the straight line a → b is clear: both ends are in walkable cells and every fine
   * (2 px) spot the line crosses on the way is valid, so the body never clips a wall corner.
   * This steps from spot to spot along the line (a "grid traversal"), so it never skips one.
   * Where the line passes exactly through a corner, both spots beside it must be valid.
   */
  lineWalkable(a, b) {
    if (!this.isWalkable(this.cellOf(a.x), this.cellOf(a.y))) return false;
    if (!this.isWalkable(this.cellOf(b.x), this.cellOf(b.y))) return false;

    const size = this.fineStep;
    const x0 = a.x / size;
    const y0 = a.y / size;
    const x1 = b.x / size;
    const y1 = b.y / size;
    let cx = Math.floor(x0);
    let cy = Math.floor(y0);
    const endX = Math.floor(x1);
    const endY = Math.floor(y1);

    const dx = x1 - x0;
    const dy = y1 - y0;
    const stepX = Math.sign(dx);
    const stepY = Math.sign(dy);
    // How far along the line (0..1) we travel to cross one whole cell in x / in y,
    // and how far until we cross the next vertical / horizontal grid line.
    const deltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const deltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    let nextX = dx > 0 ? (cx + 1 - x0) * deltaX : dx < 0 ? (x0 - cx) * deltaX : Infinity;
    let nextY = dy > 0 ? (cy + 1 - y0) * deltaY : dy < 0 ? (y0 - cy) * deltaY : Infinity;

    // The spots right at the two ends are skipped: the ends are exact positions (the player's feet,
    // a cell's route point) that are valid even when the middle of their 2 px spot isn't.
    let steps = Math.abs(endX - cx) + Math.abs(endY - cy);
    while (steps > 0) {
      if (Math.abs(nextX - nextY) < 1e-9) {
        // Exactly through a corner: don't squeeze between two blocked spots.
        if (!this.fineValid(cx + stepX, cy) || !this.fineValid(cx, cy + stepY)) return false;
        cx += stepX;
        cy += stepY;
        nextX += deltaX;
        nextY += deltaY;
        steps -= 2;
      } else if (nextX < nextY) {
        cx += stepX;
        nextX += deltaX;
        steps -= 1;
      } else {
        cy += stepY;
        nextY += deltaY;
        steps -= 1;
      }
      if (steps > 0 && !this.fineValid(cx, cy)) return false;
    }
    return true;
  }

  /** Is fine spot (fx, fy) a valid place for the body? Off the map counts as blocked. */
  fineValid(fx, fy) {
    if (fx < 0 || fy < 0 || fx >= this.fineCols || fy >= this.fineRows) return false;
    return this.fine[fy * this.fineCols + fx] === 1;
  }

  // ---------- distance field (for steering many chasers at one target) ----------

  /**
   * Breadth-first search outward from the cell at (px, py): afterwards field[cell] is the number
   * of steps from that cell to the target (-1 = can't get there). One search serves every chaser.
   */
  distanceField(px, py) {
    const size = this.cols * this.rows;
    if (!this.field) {
      this.field = new Int32Array(size);
      this.fieldQueue = new Int32Array(size);
    }
    const field = this.field;
    const queue = this.fieldQueue;
    field.fill(-1);

    let start = this.cellIndexAt(px, py);
    if (start === -1) start = this.nearestWalkable(this.cellOf(px), this.cellOf(py), 0, 4);
    if (start === -1) return field;

    let head = 0;
    let tail = 0;
    field[start] = 0;
    queue[tail++] = start;
    while (head < tail) {
      const node = queue[head++];
      const cx = node % this.cols;
      const cy = (node - cx) / this.cols;
      for (let i = 0; i < 8; i += 1) {
        const nx = cx + STEP_X[i];
        const ny = cy + STEP_Y[i];
        if (!this.isWalkable(nx, ny)) continue;
        if (i >= 4 && (!this.isWalkable(nx, cy) || !this.isWalkable(cx, ny))) continue;
        const n = this.index(nx, ny);
        if (field[n] !== -1) continue;
        field[n] = field[node] + 1;
        queue[tail++] = n;
      }
    }
    return field;
  }

  /**
   * From world point (px, py), follow the distance field downhill up to `lookahead` cells and
   * return the furthest of those cells still in a straight walkable line: a point to steer at.
   * Returns null if (px, py) isn't connected to the field's target, or is already in the target's
   * cell (then just head straight for the target).
   */
  steerAlongField(px, py, lookahead = 6) {
    const field = this.field;
    if (!field) return null;
    let node = this.cellIndexAt(px, py);
    if (node === -1) node = this.nearestWalkable(this.cellOf(px), this.cellOf(py), 0, 2);
    if (node === -1 || field[node] <= 0) return null;

    const from = { x: px, y: py };
    let best = this.cellPoint(node);
    for (let step = 0; step < lookahead && field[node] > 0; step += 1) {
      const cx = node % this.cols;
      const cy = (node - cx) / this.cols;
      let downhill = -1;
      for (let i = 0; i < 8; i += 1) {
        const nx = cx + STEP_X[i];
        const ny = cy + STEP_Y[i];
        if (!this.isWalkable(nx, ny)) continue;
        if (i >= 4 && (!this.isWalkable(nx, cy) || !this.isWalkable(cx, ny))) continue;
        const n = this.index(nx, ny);
        if (field[n] >= 0 && field[n] < field[node] && (downhill === -1 || field[n] < field[downhill])) downhill = n;
      }
      if (downhill === -1) break;
      node = downhill;
      const point = this.cellPoint(node);
      if (step > 0 && !this.lineWalkable(from, point)) break;
      best = point;
    }
    return best;
  }
}

/** The sub-sample offsets of one cell, sorted nearest-to-centre first (computed once). */
let cachedOrder = null;
function sampleOrder() {
  if (!cachedOrder) {
    const middle = (SUBSAMPLES - 1) / 2;
    cachedOrder = [];
    for (let sy = 0; sy < SUBSAMPLES; sy += 1) {
      for (let sx = 0; sx < SUBSAMPLES; sx += 1) cachedOrder.push({ sx, sy, d: Math.hypot(sx - middle, sy - middle) });
    }
    cachedOrder.sort((a, b) => a.d - b.d);
  }
  return cachedOrder;
}

/**
 * A binary min-heap of cell indices: push(item, key) and pop() → the item with the smallest key,
 * both in O(log n). It's stored as a flat array where the children of slot i are 2i+1 and 2i+2.
 * When a cell's cost improves we simply push it again; the stale copy is skipped when popped.
 */
class MinHeap {
  constructor(capacity) {
    this.items = new Int32Array(capacity);
    this.keys = new Float64Array(capacity);
    this.size = 0;
  }

  clear() {
    this.size = 0;
  }

  push(item, key) {
    if (this.size === this.items.length) this.grow();
    // Sift up: move parents down until the new key's slot is found.
    let i = this.size;
    this.size += 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= key) break;
      this.items[i] = this.items[parent];
      this.keys[i] = this.keys[parent];
      i = parent;
    }
    this.items[i] = item;
    this.keys[i] = key;
  }

  pop() {
    const top = this.items[0];
    this.size -= 1;
    const n = this.size;
    if (n === 0) return top;

    // Sift down: take the last entry and move it down from the root to where it belongs.
    const item = this.items[n];
    const key = this.keys[n];
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= n) break;
      if (child + 1 < n && this.keys[child + 1] < this.keys[child]) child += 1;
      if (this.keys[child] >= key) break;
      this.items[i] = this.items[child];
      this.keys[i] = this.keys[child];
      i = child;
    }
    this.items[i] = item;
    this.keys[i] = key;
    return top;
  }

  grow() {
    const items = new Int32Array(this.items.length * 2);
    const keys = new Float64Array(this.keys.length * 2);
    items.set(this.items);
    keys.set(this.keys);
    this.items = items;
    this.keys = keys;
  }
}

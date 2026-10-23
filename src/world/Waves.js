import Phaser from 'phaser';
import tuning from '../data/tuning.json';
import { GameState } from '../systems/GameState.js';
import { WalkGrid } from './Guide.js';

const T = tuning.waves;

// A crawler's body is 16×14 and centred on (x, y) (entities/Crawler.js).
const CRAWLER_BODY = { left: 8, right: 8, up: 7, down: 7 };

/**
 * The finale's swarm: every few seconds a wave of crawlers climbs out of the vents.
 *
 *   const waves = new Waves(scene, crawlers, map.vents);
 *   waves.start({ interval: 6000, perWave: 3, maxAlive: 9 });
 *   waves.update(time);   // every frame
 *   waves.stop();
 *
 * - Vents the camera can't see are preferred, so crawlers don't pop into existence in view.
 * - Never more than `maxAlive` wave crawlers at once: a full wave is postponed, not skipped.
 * - Each wave emits GameState 'wave' ({ n }) for the UI.
 * - The timer pauses while input is locked (dialogue, cutscene), like everything else.
 *
 * Wave crawlers are "hunters": they chase within a big `aggro` radius and never give up.
 * A straight-line chase gets stuck on walls, so we also steer them: one breadth-first search
 * from the player (a "distance field") tells every hunter which way is downhill toward them.
 */
export default class Waves {
  /** vents: map JSON `vents`, [{ id, x, y }]. */
  constructor(scene, crawlers, vents) {
    this.scene = scene;
    this.crawlers = crawlers;
    this.vents = (vents || []).map(({ id, x, y }) => ({ id, x, y }));
    if (this.vents.length === 0) console.warn('Waves: this map has no vents, so no waves will spawn');

    this.running = false;
    this.n = 0; // waves spawned so far
    this.clock = 0; // ms of unlocked time since start()
    this.nextWaveAt = 0; // on `clock`
    this.lastTime = null;
    this.nextFieldAt = 0;
    this.options = { interval: T.interval, perWave: T.perWave, maxAlive: T.maxAlive, aggro: T.aggro, tag: T.tag };
    this.grid = null; // see walkGrid(): built once, from the same walls the crawlers collide with
  }

  /** How many waves have spawned. */
  get wave() {
    return this.n;
  }

  get isRunning() {
    return this.running;
  }

  /** Starts (or retunes) the waves. The first wave comes after a short warning pause. */
  start({ interval = T.interval, perWave = T.perWave, maxAlive = T.maxAlive, aggro = T.aggro, tag = T.tag } = {}) {
    this.options = { interval, perWave, maxAlive, aggro, tag };
    this.walkGrid(); // build it now rather than in the middle of the first wave
    if (this.running) return this;

    this.running = true;
    this.clock = 0;
    this.nextWaveAt = T.firstDelayMs;
    return this;
  }

  /** No more waves. With clear = true the wave crawlers still alive burst too (e.g. at an ending). */
  stop(clear = false) {
    this.running = false;
    if (clear) this.hunters().forEach((crawler) => crawler.die());
    return this;
  }

  /** Call once per frame from the scene's update(time). */
  update(time) {
    const ms = this.lastTime === null ? 0 : Math.min(time - this.lastTime, 100);
    this.lastTime = time;

    this.steerHunters(time); // crawlers already out keep hunting even after stop()

    if (!this.running || GameState.inputLocked || this.vents.length === 0) return;
    this.clock += ms;
    if (this.clock >= this.nextWaveAt) this.spawnWave();
  }

  // ---------- spawning ----------

  spawnWave() {
    const { interval, perWave, maxAlive, tag } = this.options;
    const count = Math.min(perWave, maxAlive - this.crawlers.count(tag));
    if (count <= 0) {
      this.nextWaveAt = this.clock + T.retryMs; // the room is full: try again soon
      return;
    }

    this.n += 1;
    const vents = this.chooseVents();
    for (let i = 0; i < count; i += 1) this.spawnAt(vents[i % vents.length]);
    GameState.emit('wave', { n: this.n });
    this.nextWaveAt = this.clock + interval;
  }

  /** Off-screen vents in random order; if every vent is on screen, the furthest from the player first. */
  chooseVents() {
    const view = Phaser.Geom.Rectangle.Clone(this.scene.cameras.main.worldView);
    Phaser.Geom.Rectangle.Inflate(view, T.offscreenPadPx, T.offscreenPadPx);

    const hidden = this.vents.filter((vent) => !view.contains(vent.x, vent.y));
    if (hidden.length > 0) return Phaser.Utils.Array.Shuffle(hidden);

    const player = this.crawlers.player;
    const distance = (vent) => Phaser.Math.Distance.BetweenPoints(vent, player);
    return [...this.vents].sort((a, b) => distance(b) - distance(a));
  }

  spawnAt(vent) {
    const { aggro, tag } = this.options;
    const { x, y } = this.crawlers.freeSpotNear(vent.x, vent.y, T.ventJitterPx);
    const crawler = this.crawlers.spawn(x, y, { tag, radius: T.wanderRadius, aggro, hunter: true });

    // Fade in out of a little magenta puff, instead of just appearing.
    crawler.setAlpha(0);
    this.scene.tweens.add({ targets: crawler, alpha: 1, duration: T.spawnFadeMs });
    if (this.scene.textures.exists('fx-glow')) {
      const puff = this.scene.add.image(x, y, 'fx-glow').setTint(0xff3df0).setBlendMode(Phaser.BlendModes.ADD);
      puff.setDepth(y - 1).setScale(0.2).setAlpha(0.8);
      this.scene.tweens.add({ targets: puff, scale: 0.9, alpha: 0, duration: 360, onComplete: () => puff.destroy() });
    }
    return crawler;
  }

  // ---------- steering ----------

  hunters() {
    return this.crawlers.alive(this.options.tag).filter((crawler) => crawler.hunter);
  }

  /**
   * Hunters that can see the player run straight at them (waypoint = null). The others follow
   * the distance field around the walls. The field is rebuilt a few times a second, not every frame.
   */
  steerHunters(time) {
    const hunters = this.hunters();
    if (hunters.length === 0) return;
    const grid = this.walkGrid();

    const player = this.crawlers.player;
    let fieldReady = time < this.nextFieldAt;
    hunters.forEach((crawler) => {
      if (grid.lineWalkable(crawler, player)) {
        crawler.waypoint = null;
        return;
      }
      if (!fieldReady) {
        grid.distanceField(player.x, player.y);
        this.nextFieldAt = time + T.fieldEveryMs;
        fieldReady = true;
      }
      crawler.waypoint = grid.steerAlongField(crawler.x, crawler.y, T.lookaheadCells);
    });
  }

  /** The crawler-sized walk grid, built the first time it's needed (the walls never change). */
  walkGrid() {
    if (!this.grid) {
      const { width, height } = this.scene.physics.world.bounds;
      // padPx keeps steering points a hair off the walls, so a crawler never snags on a corner.
      const options = { cell: T.cellPx, body: CRAWLER_BODY, pad: T.padPx };
      this.grid = new WalkGrid(this.crawlers.rects || [], width, height, options);
    }
    return this.grid;
  }
}

import Phaser from 'phaser';
import tuning from '../data/tuning.json';
import { GameState } from '../systems/GameState.js';
import Crawler from '../entities/Crawler.js';

const T = tuning.crawler;
const SPAWN_TRIES = 10;

/**
 * Every crawler in the scene.
 *
 *   crawlers.spawn(x, y, { tag, radius, aggro, hunter })  one crawler (Kael's fight tags them 'kael')
 *   crawlers.spawnGroups(map.crawlers)            the map's roaming groups
 *   crawlers.hitArea(rect, damage, fromX, fromY)  a strike: returns how many were hit
 *   crawlers.count(tag)                           how many are alive
 *   crawlers.events.on('killed', (crawler, tag) => …)
 *
 * Contact with the player hurts through survival.hurt(), which also handles i-frames.
 */
export default class Crawlers {
  /** colliders: the map's static physics group (or an array of { x, y, w, h } rects). */
  constructor(scene, player, colliders, survival) {
    this.scene = scene;
    this.player = player;
    this.survival = survival;
    this.events = new Phaser.Events.EventEmitter();

    // A physics group: its config is applied to every crawler added to it.
    this.group = scene.physics.add.group({ collideWorldBounds: true });

    this.blockers = collisionTarget(scene, colliders);
    this.rects = collisionRects(colliders);
    if (this.blockers) scene.physics.add.collider(this.group, this.blockers); // walls stop them
    scene.physics.add.collider(this.group, this.group); // and they don't stack on each other

    // Drop the scene's 'killed' listeners when it shuts down, so a restarted scene starts clean.
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.events.removeAllListeners());
  }

  // ---------- spawning ----------

  /**
   * One crawler whose home is (x, y), or `home` if given (used by groups).
   * hunter: true for wave crawlers, which chase without a leash (see entities/Crawler.js).
   */
  spawn(x, y, { tag = null, radius = T.groupRadius, aggro = T.aggroRadius, home = null, hunter = false } = {}) {
    const crawler = new Crawler(this.scene, x, y, { tag, radius, aggro, home, hunter });
    this.group.add(crawler);
    return crawler;
  }

  /**
   * mapCrawlers: [{ id, x, y, count, radius, tag?, aggro? }]. Each entry is a group of `count`
   * crawlers scattered around (x, y) that all wander within `radius` of it. Returns the new crawlers.
   */
  spawnGroups(mapCrawlers = []) {
    const spawned = [];
    (mapCrawlers || []).forEach((entry) => {
      const radius = entry.radius ?? T.groupRadius;
      const home = { x: entry.x, y: entry.y };
      for (let i = 0; i < (entry.count ?? 1); i += 1) {
        const { x, y } = this.freeSpotNear(entry.x, entry.y, radius * T.spawnSpread);
        spawned.push(this.spawn(x, y, { tag: entry.tag ?? null, radius, aggro: entry.aggro ?? T.aggroRadius, home }));
      }
    });
    return spawned;
  }

  /** A random point within `spread` of (x, y) where the body isn't inside a wall (or the centre if none found). */
  freeSpotNear(x, y, spread) {
    const bounds = this.scene.physics.world.bounds;
    for (let i = 0; i < SPAWN_TRIES; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const distance = Math.sqrt(Math.random()) * spread;
      const px = x + Math.cos(angle) * distance;
      const py = y + Math.sin(angle) * distance;
      const body = new Phaser.Geom.Rectangle(px - 8, py - 7, 16, 14); // the crawler's (centred) body
      const inWall = this.rects.some((rect) => Phaser.Geom.Intersects.RectangleToRectangle(body, rect));
      if (!inWall && bounds.contains(px, py)) return { x: px, y: py };
    }
    return { x, y };
  }

  // ---------- queries ----------

  /** Living crawlers, optionally only those with `tag`. */
  alive(tag) {
    return this.group.getChildren().filter((c) => !c.dead && (tag === undefined || c.tag === tag));
  }

  /** How many are alive: all of them if `tag` is omitted. */
  count(tag) {
    return this.alive(tag).length;
  }

  // ---------- combat ----------

  /**
   * Hits every crawler touching `rect` ({ x, y, w|width, h|height }). The knockback pushes away from
   * (fromX, fromY), defaulting to the rect's centre. `tag` (optional) limits it to one group, e.g. 'kael'.
   * Returns how many were hit.
   */
  hitArea(rect, damage = 1, fromX, fromY, tag) {
    const area = toRectangle(rect);
    const originX = fromX ?? area.centerX;
    const originY = fromY ?? area.centerY;

    let hits = 0;
    this.alive(tag).forEach((crawler) => {
      if (!Phaser.Geom.Intersects.RectangleToRectangle(area, crawler.hurtbox())) return;
      hits += 1;
      const crawlerTag = crawler.tag;
      const killed = crawler.takeHit(damage, originX, originY);
      if (killed) this.events.emit('killed', crawler, crawlerTag);
    });
    return hits;
  }

  // ---------- per frame ----------

  /** Call once per frame from the scene's update(time, delta). */
  update(time, delta) {
    const locked = GameState.inputLocked;
    const dt = Math.min((delta ?? this.scene.game.loop.delta) / 1000, 0.1); // delta in ms

    // slice(): a crawler may be destroyed during the loop, which changes the group's list.
    this.group.getChildren().slice().forEach((crawler) => crawler.update(time, dt, this.player, locked));

    // physics.overlap() checks right now (no lasting collider), so it simply doesn't run while locked.
    if (!locked && this.survival) {
      this.scene.physics.overlap(this.player, this.group, (player, crawler) => this.onContact(crawler, time));
    }
  }

  /** A crawler touched the player: bite (if the player isn't in i-frames), then back off. */
  onContact(crawler, time) {
    if (crawler.dead || crawler.isStunned(time)) return; // a knocked-back crawler can't bite
    const bit = this.survival.hurt(T.contactDamage, crawler.x, crawler.y);
    if (bit) crawler.recoil(this.player.x, this.player.y);
  }
}

// ---------- collider helpers ----------

/** Accepts { x, y, w, h }, { x, y, width, height } or a Phaser.Geom.Rectangle. */
function toRectangle(r) {
  if (r instanceof Phaser.Geom.Rectangle) return r;
  return new Phaser.Geom.Rectangle(r.x, r.y, r.w ?? r.width, r.h ?? r.height);
}

/** Something physics.add.collider() accepts: the static group as-is, or a new one built from plain rects. */
function collisionTarget(scene, colliders) {
  if (!colliders) return null;
  const isPlainRects = Array.isArray(colliders) && colliders.length > 0 && !colliders[0].body;
  if (!isPlainRects) return colliders;

  const group = scene.physics.add.staticGroup();
  colliders.forEach((r) => {
    const rect = toRectangle(r);
    group.add(scene.add.zone(rect.x, rect.y, rect.width, rect.height).setOrigin(0));
  });
  return group;
}

/** The colliders as Phaser.Geom.Rectangles (for picking spawn points outside walls). */
function collisionRects(colliders) {
  if (!colliders) return [];
  const list = Array.isArray(colliders) ? colliders : colliders.getChildren?.() || [];
  return list.map((item) => {
    const body = item.body;
    if (body) return new Phaser.Geom.Rectangle(body.x, body.y, body.width, body.height);
    return toRectangle(item);
  });
}

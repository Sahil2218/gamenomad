import Phaser from 'phaser';
import { DEV } from '../systems/devFlags.js';

const CAMERA_ZOOM = 2;

/**
 * Builds a world from a map JSON (contract §6.5, schema v2 in M2 §1):
 * the background picture, invisible walls, zones, hazards, checkpoints and the camera.
 *
 * There are no "walk behind" overlays any more: every solid object's collider
 * covers its whole drawn footprint, so characters are never drawn inside map art.
 *
 * Returns { width, height, colliders, colliderRects, zones, hazards, checkpoints, markers,
 *           points, vents, relays } where
 *   colliders     is a static physics group (collide the player, NPCs and crawlers against it)
 *   colliderRects is the same walls as Phaser.Geom.Rectangle (handy for line-of-sight checks)
 *   zones         is { [id]: Phaser.Geom.Rectangle }
 *   hazards       is the raw `hazards` array (the Hazards module reads it)
 *   checkpoints   is [{ id, rect, respawn: { x, y } }]
 *   markers       is { [questStage]: point or [points] } for the minimap and the guide trail
 *   points        is { [name]: { x, y } }, scripted spots for cutscenes (M3)
 *   vents         is [{ id, x, y }], where swarm waves crawl out (M3, Silo)
 *   relays        is [{ id, rect }], the hold zones of the finale (M3, Silo)
 */
export function buildMap(scene, map) {
  const { width, height } = map;

  // Depth -1 keeps the picture behind every actor.
  scene.add.image(0, 0, map.image).setOrigin(0).setDepth(-1);

  // Physics "world bounds" stop bodies at the map edges.
  scene.physics.world.setBounds(0, 0, width, height);

  const colliderRects = (map.colliders || []).map(toRect);
  const colliders = createColliders(scene, colliderRects);

  setupCamera(scene, width, height);
  if (DEV.debug) drawDebugOutlines(scene, map);

  return {
    width,
    height,
    colliders,
    colliderRects,
    zones: createZones(map.zones || []),
    hazards: map.hazards || [],
    checkpoints: createCheckpoints(map.checkpoints || []),
    markers: map.markers || {},
    points: map.points || {},
    vents: map.vents || [],
    relays: (map.relays || []).map((relay) => ({ id: relay.id, rect: toRect(relay) })),
  };
}

function toRect({ x, y, w, h }) {
  return new Phaser.Geom.Rectangle(x, y, w, h);
}

/**
 * Static bodies never move. They are cheap and perfect for walls, houses and trees.
 * A Zone is an invisible game object, used here just to carry a body.
 */
function createColliders(scene, rects) {
  const group = scene.physics.add.staticGroup();
  rects.forEach(({ x, y, width, height }) => {
    const zone = scene.add.zone(x, y, width, height).setOrigin(0);
    group.add(zone); // the static group gives it a static body
  });
  return group;
}

function createZones(list) {
  const zones = {};
  list.forEach((zone) => {
    zones[zone.id] = toRect(zone);
  });
  return zones;
}

/** A checkpoint is a rectangle you walk into, plus the spot you come back to. */
function createCheckpoints(list) {
  return list.map((cp) => ({
    id: cp.id,
    rect: toRect(cp),
    // Without an explicit respawn point, use the middle of the rectangle.
    respawn: cp.respawn || { x: cp.x + cp.w / 2, y: cp.y + cp.h / 2 },
  }));
}

function setupCamera(scene, width, height) {
  const camera = scene.cameras.main;
  camera.setBounds(0, 0, width, height); // never show anything outside the map
  camera.setZoom(CAMERA_ZOOM); // each map pixel becomes 2×2 screen pixels
  camera.setRoundPixels(true);
}

/**
 * ?debug=1: colliders green, zones magenta, inspectables yellow,
 * hazards orange, checkpoints white (with a dot on the respawn point), drone paths cyan,
 * relays gold, vents red dots, cutscene points blue dots.
 */
function drawDebugOutlines(scene, map) {
  const g = scene.add.graphics().setDepth(99999);

  const outline = (rects, color) => {
    g.lineStyle(1, color, 1);
    rects.forEach(({ x, y, w, h }) => g.strokeRect(x, y, w, h));
  };

  outline(map.colliders || [], 0x00ff00);
  outline(map.zones || [], 0xff00ff);
  outline(map.inspectables || [], 0xffff00);
  outline(map.hazards || [], 0xff8800);
  outline(map.checkpoints || [], 0xffffff);
  outline(map.relays || [], 0xf0c060);

  g.fillStyle(0xff3b3b, 1);
  (map.vents || []).forEach(({ x, y }) => g.fillCircle(x, y, 3));
  g.fillStyle(0x4a7dff, 1);
  Object.values(map.points || {}).forEach(({ x, y }) => g.fillCircle(x, y, 3));

  g.fillStyle(0xffffff, 1);
  createCheckpoints(map.checkpoints || []).forEach(({ respawn }) => g.fillCircle(respawn.x, respawn.y, 2));

  // Drone patrol paths: a line through the waypoints, closed when the drone loops.
  g.lineStyle(1, 0x3ad4e8, 1);
  (map.drones || []).forEach(({ path = [], loop }) => {
    if (path.length < 2) return;
    g.strokePoints(path, loop !== false);
  });
}

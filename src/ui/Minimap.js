// Circular minimap in the bottom-left corner (contract M2 §7).
//
// Inside the compass frame it shows the current map, scaled down and centred on
// the player, plus the player arrow, NPC/companion/pickup dots and a pulsing
// objective diamond (clamped to the rim when it's out of range), and (M3) the
// guide route as a dotted gold line plus a "[G] GUIDE" hint (see MinimapGuide.js).
//
// Everything inside the circle lives in one Container clipped by a circular
// GeometryMask: a Graphics shape used as a stencil, which works in WebGL and Canvas.
// UIScene feeds it data; this file doesn't touch GameState.

import Phaser from 'phaser';
import { COLORS, MINIMAP } from './uiLayout.js';
import { DEPTH } from './uiStyle.js';
import { GEN, ensureMinimapTextures, ensureScaledCopy } from './uiTextures.js';
import { GuideHint, MinimapGuideLine } from './MinimapGuide.js';

// Angle (degrees, clockwise from north) for each facing the world scenes write.
const FACING_ANGLE = {
  up: 0,
  'up-right': 45,
  right: 90,
  'down-right': 135,
  down: 180,
  'down-left': 225,
  left: 270,
  'up-left': 315,
};
const TURN_SPEED = 0.9; // degrees per ms the arrow turns towards its facing

function facingAngle(facing, fallback) {
  if (typeof facing === 'number') return facing; // already an angle
  return facing in FACING_ANGLE ? FACING_ANGLE[facing] : fallback;
}

// Move angle `from` towards `to` by at most `step` degrees, the short way round.
function approachAngle(from, to, step) {
  const diff = Phaser.Math.Angle.ShortestBetween(from, to);
  if (Math.abs(diff) <= step) return to;
  return from + Math.sign(diff) * step;
}

export class Minimap {
  // hintText: the strings.json 'guide-hint' text ("[G] Guide").
  constructor(scene, hintText) {
    const m = MINIMAP;
    this.scene = scene;
    this.cx = m.x + m.centerX; // circle centre in screen pixels
    this.cy = m.y + m.centerY;
    this.world = null;
    this.scale = m.mapScale;
    this.angle = 180;
    this.objective = null;
    ensureMinimapTextures(scene, { innerRadius: m.innerRadius });

    // The mask shape is never drawn itself (add: false); it only clips the container.
    this.maskShape = scene.make.graphics({ x: 0, y: 0 }, false);
    this.maskShape.fillStyle(0xffffff, 1);
    this.maskShape.fillCircle(this.cx, this.cy, m.maskRadius);
    this.inside = scene.add.container(0, 0).setDepth(DEPTH.minimap);
    this.inside.setMask(this.maskShape.createGeometryMask());

    // Off-map backdrop: dark navy with a faint grid, so map edges read as "nothing here".
    this.backdrop = scene.add.graphics();
    this.drawBackdrop();
    this.map = scene.add.image(0, 0, '__DEFAULT').setOrigin(0).setVisible(false);
    this.guideLine = new MinimapGuideLine(scene); // on the map, under the dots
    this.shade = scene.add.image(this.cx, this.cy, GEN.mmShade);
    this.sweep = scene.add.image(this.cx, this.cy, GEN.mmSweep).setBlendMode(Phaser.BlendModes.ADD).setAlpha(0.55);
    this.playerGlow = scene.add.image(this.cx, this.cy, GEN.glow).setBlendMode(Phaser.BlendModes.ADD).setScale(0.42).setAlpha(0.7);
    this.arrow = scene.add.image(this.cx, this.cy, GEN.mmArrow);
    this.inside.add([this.backdrop, this.map, this.guideLine.graphics, this.shade, this.sweep, this.playerGlow, this.arrow]);
    this.dots = []; // pooled dot images, inserted just below the shade

    // Frame on top, then the objective marker (so a rim-clamped marker is never hidden).
    this.frame = scene.add.image(m.x, m.y, 'ui-minimap-frame').setOrigin(0).setDepth(DEPTH.minimap);
    this.marker = scene.add.image(this.cx, this.cy, GEN.mmDiamond).setDepth(DEPTH.minimap).setVisible(false);
    this.markerPulse = scene.tweens.add({ targets: this.marker, scale: { from: 0.85, to: 1.2 }, duration: 520, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    this.hint = new GuideHint(scene, hintText);

    this.setVisible(false);
  }

  drawBackdrop() {
    const g = this.backdrop;
    const r = MINIMAP.maskRadius;
    g.clear();
    g.fillStyle(0x0a1219, 1);
    g.fillCircle(this.cx, this.cy, r);
    g.lineStyle(1, COLORS.cyan, 0.07);
    for (let d = -r; d <= r; d += 12) {
      g.lineBetween(this.cx + d, this.cy - r, this.cx + d, this.cy + r);
      g.lineBetween(this.cx - r, this.cy + d, this.cx + r, this.cy + d);
    }
  }

  setVisible(visible) {
    this.inside.setVisible(visible);
    this.frame.setVisible(visible);
    this.hint.setVisible(visible);
    if (!visible) this.marker.setVisible(false);
  }

  // GameState.guideEnabled: shows or hides the route and dims the hint.
  setGuideEnabled(enabled, animate = false) {
    this.guideLine.enabled = Boolean(enabled);
    this.guideLine.invalidate();
    this.hint.setEnabled(enabled, animate);
  }

  // world: GameState.world ({ scene, mapKey, width, height, area }) or null (menu).
  setWorld(world) {
    this.world = world && world.mapKey ? world : null;
    this.setVisible(Boolean(this.world));
    this.objective = null;
    this.guideLine.invalidate(); // the old area's route must not flash on the new map
    if (!this.world) return;

    // A smooth pre-scaled copy of the map: scaling the real map texture down with
    // nearest filtering would shimmer, and its filter is shared with the world scene.
    const src = this.scene.textures.exists(this.world.mapKey) ? this.scene.textures.get(this.world.mapKey).getSourceImage() : null;
    const worldW = this.world.width || (src && src.width) || 1;
    const worldH = this.world.height || (src && src.height) || 1;
    const w = Math.round(worldW * MINIMAP.mapScale);
    const h = Math.round(worldH * MINIMAP.mapScale);
    const key = ensureScaledCopy(this.scene, this.world.mapKey, `ui-gen-minimap-${this.world.mapKey}-${w}x${h}`, w, h);
    this.scale = w / worldW;
    if (key) this.map.setTexture(key).setVisible(true);
    else this.map.setVisible(false);

    // Quick fade-in so a new area doesn't just pop.
    this.scene.tweens.killTweensOf(this.inside);
    this.inside.setAlpha(0);
    this.scene.tweens.add({ targets: this.inside, alpha: 1, duration: 320, ease: 'Sine.easeOut' });
  }

  // objective: { x, y } in world px, or null.
  setObjective(objective) {
    this.objective = objective && Number.isFinite(objective.x) && Number.isFinite(objective.y) ? objective : null;
  }

  // Called every frame by UIScene with GameState.playerPos, GameState.minimapPoints
  // and GameState.guidePath.
  update(time, delta, playerPos, points, guidePath) {
    if (!this.world || !playerPos) return;
    const s = this.scale;
    const px = playerPos.x || 0;
    const py = playerPos.y || 0;
    this.map.setPosition(Math.round(this.cx - px * s), Math.round(this.cy - py * s));
    this.guideLine.update(time, delta, guidePath, this.map.x, this.map.y, s, px, py);

    this.angle = approachAngle(this.angle, facingAngle(playerPos.facing, this.angle), TURN_SPEED * delta);
    this.arrow.setAngle(this.angle);
    this.sweep.rotation += delta * 0.0011;
    this.playerGlow.setAlpha(0.55 + 0.2 * Math.sin(time / 300));

    this.placeDots(points, px, py);
    this.placeMarker(px, py);
  }

  placeDots(points, px, py) {
    const list = Array.isArray(points) ? points : [];
    const s = this.scale;
    const limit = MINIMAP.innerRadius + 2;
    let used = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p) continue;
      const dx = (p.x - px) * s;
      const dy = (p.y - py) * s;
      if (dx * dx + dy * dy > limit * limit) continue; // out of range: not shown
      const dot = this.dotAt(used++);
      dot.setPosition(Math.round(this.cx + dx), Math.round(this.cy + dy));
      const kind = GEN.mmDot[p.kind] ? p.kind : 'npc';
      if (dot.kind !== kind) {
        dot.kind = kind;
        dot.setTexture(GEN.mmDot[kind]);
      }
      dot.setVisible(true);
    }
    for (let i = used; i < this.dots.length; i++) this.dots[i].setVisible(false);
  }

  // Reuse pooled dots; only create a new one when more points are on screen than ever before.
  dotAt(index) {
    if (!this.dots[index]) {
      const dot = this.scene.add.image(0, 0, GEN.mmDot.npc);
      dot.kind = 'npc';
      this.inside.addAt(dot, this.inside.getIndex(this.shade));
      this.dots[index] = dot;
    }
    return this.dots[index];
  }

  placeMarker(px, py) {
    if (!this.objective) {
      this.marker.setVisible(false);
      return;
    }
    let dx = (this.objective.x - px) * this.scale;
    let dy = (this.objective.y - py) * this.scale;
    const max = MINIMAP.innerRadius - MINIMAP.markerInset;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const clamped = dist > max;
    if (clamped) {
      dx = (dx / dist) * max;
      dy = (dy / dist) * max;
    }
    this.marker.setPosition(Math.round(this.cx + dx), Math.round(this.cy + dy));
    this.marker.setAlpha(clamped ? 0.85 : 1);
    this.marker.setVisible(true);
  }

  destroy() {
    this.markerPulse.remove();
    this.inside.clearMask(true);
    this.maskShape.destroy();
  }
}

// The guide trail on the minimap (contract M3 §7):
//   - MinimapGuideLine: GameState.guidePath drawn as a dotted gold line that
//     drifts towards the objective. It lives inside the minimap's masked
//     container, so the circle clips it.
//   - GuideHint: the small "[G] GUIDE" tag next to the minimap, dimmed while the
//     guide is switched off.
//
// Cheap by design: the dots are drawn into ONE Graphics object in map-local
// minimap pixels, and redrawn only ~10× a second. Every frame the Graphics
// object is simply moved along with the scrolling minimap image.

import { COLORS, CSS, GUIDE_GOLD, GUIDE_HINT, MINIMAP, MINIMAP_GUIDE } from './uiLayout.js';
import { DEPTH, drawPanel, fillChamferRect, titleStyle } from './uiStyle.js';

// Closest point to `p` on the polyline `pts`: { index of the segment start, point }.
function nearestOnPath(pts, p) {
  let best = { index: 0, point: pts[0], d2: Infinity };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2)) : 0;
    const x = a.x + abx * t;
    const y = a.y + aby * t;
    const d2 = (x - p.x) ** 2 + (y - p.y) ** 2;
    if (d2 < best.d2) best = { index: i, point: { x, y }, d2 };
  }
  return best;
}

export class MinimapGuideLine {
  constructor(scene) {
    this.scene = scene;
    this.graphics = scene.add.graphics();
    this.enabled = true;
    this.timer = 0;
  }

  // Redraw on the next update (e.g. the guide was toggled or the area changed).
  invalidate() {
    this.timer = 0;
    this.graphics.clear();
  }

  // Every frame. (mapX, mapY): the minimap image's top-left on screen; scale:
  // world px → minimap px; (px, py): the player in world px; path: GameState.guidePath.
  update(time, delta, path, mapX, mapY, scale, px, py) {
    this.graphics.setPosition(mapX, mapY);
    this.timer -= delta;
    if (this.timer > 0) return;
    this.timer = MINIMAP_GUIDE.redrawMs;
    this.redraw(time, path, scale, px, py);
  }

  redraw(time, path, scale, px, py) {
    const g = this.graphics;
    g.clear();
    if (!this.enabled || !Array.isArray(path) || path.length < 2) return;

    const pts = [];
    for (const p of path) {
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) pts.push({ x: p.x * scale, y: p.y * scale });
    }
    if (pts.length < 2) return;

    // The route is recomputed only every ~400 ms while the player keeps walking,
    // so start it from the point on the route closest to the player right now.
    const me = { x: px * scale, y: py * scale };
    const start = nearestOnPath(pts, me);
    const route = [start.point, ...pts.slice(start.index + 1)];
    const cum = [0]; // distance from the route's start to each point
    for (let i = 1; i < route.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(route[i].x - route[i - 1].x, route[i].y - route[i - 1].y));
    }
    const total = cum[cum.length - 1];
    if (total < MINIMAP_GUIDE.startGap) return;

    // Dots are spaced from the TARGET end, so they stay put on the map as the
    // player walks, and the phase makes them march slowly towards the target.
    const { spacing, marchSpeed, startGap } = MINIMAP_GUIDE;
    const phase = ((time / 1000) * marchSpeed) % spacing;
    const limit = (MINIMAP.maskRadius + 3) ** 2;
    let seg = route.length - 2; // walk the segments backwards as the dots move away from the target
    for (let fromEnd = spacing - phase; fromEnd <= total - startGap; fromEnd += spacing) {
      const d = total - fromEnd;
      while (seg > 0 && cum[seg] > d) seg--;
      const a = route[seg];
      const b = route[seg + 1];
      const len = cum[seg + 1] - cum[seg] || 1;
      const t = (d - cum[seg]) / len;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      if ((x - me.x) ** 2 + (y - me.y) ** 2 > limit) continue; // outside the circle anyway
      const rx = Math.round(x);
      const ry = Math.round(y);
      g.fillStyle(COLORS.black, 0.7);
      g.fillRect(rx - 2, ry - 2, 4, 4);
      g.fillStyle(GUIDE_GOLD.color, 1);
      g.fillRect(rx - 1, ry - 1, 2, 2);
      g.fillStyle(0xfff0c0, 1); // a bright pixel, so the dots glint on busy map art
      g.fillRect(rx - 1, ry - 1, 1, 1);
    }
  }
}

// "[G] Guide" (strings 'guide-hint') → { key: 'G', label: 'GUIDE' }.
function parseHint(text) {
  const match = /^\s*\[(\w+)\]\s*(.*)$/.exec(String(text || ''));
  if (match) return { key: match[1].toUpperCase(), label: (match[2] || 'Guide').toUpperCase() };
  return { key: 'G', label: String(text || 'Guide').toUpperCase() };
}

export class GuideHint {
  constructor(scene, hintText) {
    const { key, label } = parseHint(hintText);
    const h = GUIDE_HINT.height;
    this.scene = scene;
    this.enabled = true;

    this.label = scene.add.text(0, Math.round(h / 2), label, titleStyle(8, GUIDE_GOLD.css)).setOrigin(0, 0.5);
    const capX = 4;
    const capY = Math.round((h - 13) / 2);
    this.label.x = capX + 13 + 5;
    const width = Math.ceil(this.label.x + this.label.width + 6);

    const bg = scene.add.graphics();
    drawPanel(bg, 0, 0, width, h);
    // Keycap, same style as the supply key hints.
    this.keycap = scene.add.graphics();
    fillChamferRect(this.keycap, capX, capY, 13, 13, COLORS.black, 1, 2);
    fillChamferRect(this.keycap, capX + 1, capY + 1, 11, 11, GUIDE_GOLD.color, 0.9, 2);
    fillChamferRect(this.keycap, capX + 2, capY + 2, 9, 9, COLORS.panel, 1, 1);
    this.keyText = scene.add.text(capX + 7, capY + 7, key, titleStyle(8, CSS.cream)).setOrigin(0.5);

    this.container = scene.add
      .container(GUIDE_HINT.right - width, GUIDE_HINT.bottom - h, [bg, this.keycap, this.keyText, this.label])
      .setDepth(DEPTH.minimap);
  }

  setVisible(visible) {
    this.container.setVisible(visible);
  }

  // On: gold label. Off: muted and dimmed. `animate` gives the toggle a small pop.
  setEnabled(enabled, animate = false) {
    this.enabled = Boolean(enabled);
    this.label.setColor(this.enabled ? GUIDE_GOLD.css : CSS.muted);
    this.container.setAlpha(this.enabled ? 1 : 0.5);
    if (!animate) return;
    const tweens = this.scene.tweens;
    tweens.killTweensOf(this.label);
    this.label.setScale(1.25);
    tweens.add({ targets: this.label, scale: 1, duration: 260, ease: 'Back.easeOut' });
  }
}

// Party row under the quest tracker (contract M2 §7): a small head portrait for
// each joined companion, in join order. Newcomers pop in.

import { COLORS, PARTY_ROW, SLOT_SMALL } from './uiLayout.js';
import { DEPTH } from './uiStyle.js';
import { ensureScaledCopy } from './uiTextures.js';

// Head crop of a 96×96 `portrait-<id>` (head and shoulders), shown at headSize.
const HEAD_CROP = { x: 12, y: 2, w: 72, h: 72 };

// Returns a smooth head-only texture for the companion (or null if there's no portrait).
export function headTexture(scene, id) {
  const size = PARTY_ROW.headSize;
  return ensureScaledCopy(scene, `portrait-${id}`, `ui-gen-head-${id}-${size}`, size, size, HEAD_CROP);
}

export class PartyRow {
  constructor(scene) {
    this.scene = scene;
    this.ids = [];
    this.cells = [];
    this.container = scene.add.container(PARTY_ROW.x, 0).setDepth(DEPTH.hud);
  }

  get height() {
    return this.ids.length > 0 ? SLOT_SMALL.size : 0;
  }

  moveTo(y, animate) {
    const tweens = this.scene.tweens;
    tweens.killTweensOf(this.container);
    if (animate) tweens.add({ targets: this.container, y, duration: 220, ease: 'Cubic.easeOut' });
    else this.container.y = y;
  }

  // ids: GameState.party. `fresh` lists the ids that just joined (they pop in).
  setParty(ids, fresh = []) {
    this.ids = (ids || []).slice();
    this.cells.forEach((cell) => cell.destroy());
    this.cells = [];

    const size = SLOT_SMALL.size;
    this.ids.forEach((id, i) => {
      const x = i * (size + PARTY_ROW.gap);
      const cell = this.scene.add.container(x + size / 2, size / 2);
      const frame = this.scene.add.image(0, 0, 'ui-slot-sm');
      const key = headTexture(this.scene, id);
      const parts = [frame];
      if (key) parts.push(this.scene.add.image(0, 0, key));
      else console.warn(`[UI] missing portrait texture portrait-${id}`);
      cell.add(parts);
      this.container.add(cell);
      this.cells.push(cell);
      if (fresh.includes(id)) this.popIn(cell);
    });
  }

  popIn(cell) {
    const tweens = this.scene.tweens;
    cell.setScale(0.2).setAlpha(0);
    tweens.add({ targets: cell, scale: 1, alpha: 1, duration: 420, ease: 'Back.easeOut' });
    // A cyan ring that expands and fades around the newcomer.
    const ring = this.scene.add.rectangle(0, 0, SLOT_SMALL.size - 4, SLOT_SMALL.size - 4).setStrokeStyle(2, COLORS.cyan, 1);
    cell.add(ring);
    tweens.add({ targets: ring, alpha: 0, scale: 1.35, duration: 700, delay: 150, ease: 'Quad.easeOut', onComplete: () => ring.destroy() });
  }
}

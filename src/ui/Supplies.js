// Supply counters next to the health bar (contract M2 §7): medkit [H],
// ration [R] and water [T], each in a small slot with its count and key hint.
// An empty supply is dimmed; a changed count pops.

import { COLORS, CSS, SLOT_SMALL, SUPPLIES } from './uiLayout.js';
import { DEPTH, bodyStyle, fillChamferRect, titleStyle } from './uiStyle.js';

const DIM_TINT = 0x6a6a72;

export class SupplyCounters {
  constructor(scene) {
    this.scene = scene;
    this.counts = {};
    this.container = scene.add.container(SUPPLIES.x, SUPPLIES.y).setDepth(DEPTH.hud);
    const size = SLOT_SMALL.size;

    this.cells = SUPPLIES.order.map(({ id, key }, i) => {
      const x = i * (size + SUPPLIES.gap);
      const frame = scene.add.image(x, 0, 'ui-slot-sm').setOrigin(0);
      const flash = scene.add.rectangle(x + size / 2, size / 2, size - 10, size - 10, 0xfff2d0).setAlpha(0);
      const iconKey = scene.textures.exists(`item-${id}-sm`) ? `item-${id}-sm` : `item-${id}`;
      const icon = scene.add.image(x + size / 2, 19, iconKey);
      if (icon.width > 24) icon.setScale(24 / icon.width);
      const baseScale = icon.scale;

      // Key hint: a tiny dark keycap in the bottom-left corner.
      const keycap = scene.add.graphics();
      fillChamferRect(keycap, x + 3, size - 16, 13, 13, COLORS.black, 1, 2);
      fillChamferRect(keycap, x + 4, size - 15, 11, 11, COLORS.cyan, 0.85, 2);
      fillChamferRect(keycap, x + 5, size - 14, 9, 9, COLORS.panel, 1, 1);
      const keyText = scene.add.text(x + 10, size - 9, key, titleStyle(8, CSS.cream)).setOrigin(0.5);

      const count = scene.add
        .text(x + size - 4, size - 1, '0', bodyStyle(22, CSS.cream, { stroke: '#05060a', strokeThickness: 4 }))
        .setOrigin(1, 1);

      this.container.add([frame, flash, icon, keycap, keyText, count]);
      return { id, icon, iconX: icon.x, baseScale, flash, count, keycap, keyText };
    });
  }

  // supplies: { medkit, ration, water } (payload of 'supplies:changed').
  setSupplies(supplies, animate = true) {
    const data = supplies || {};
    for (const cell of this.cells) {
      const value = Math.max(0, Math.floor(Number(data[cell.id]) || 0));
      const before = this.counts[cell.id];
      this.counts[cell.id] = value;
      cell.count.setText(String(value));

      const empty = value === 0;
      cell.count.setColor(empty ? CSS.muted : CSS.cream);
      cell.icon.setAlpha(empty ? 0.4 : 1);
      if (empty) cell.icon.setTint(DIM_TINT);
      else cell.icon.clearTint();
      cell.keycap.setAlpha(empty ? 0.5 : 1);
      cell.keyText.setAlpha(empty ? 0.5 : 1);

      if (animate && before !== undefined && value !== before) this.pop(cell, value > before);
    }
  }

  // The player pressed this supply's key with none left: red flash and a shake.
  // (The world scene shows the "none left" toast; this just points at the empty slot.)
  nudgeIfEmpty(id) {
    const cell = this.cells.find((c) => c.id === id);
    if (!cell || this.counts[id] > 0) return;
    const tweens = this.scene.tweens;
    tweens.killTweensOf([cell.icon, cell.flash]);
    cell.icon.x = cell.iconX;
    tweens.add({ targets: cell.icon, x: { from: cell.iconX - 3, to: cell.iconX + 3 }, duration: 45, yoyo: true, repeat: 2, onComplete: () => (cell.icon.x = cell.iconX) });
    cell.flash.setFillStyle(COLORS.warning, 1).setAlpha(0.45);
    tweens.add({ targets: cell.flash, alpha: 0, duration: 380, ease: 'Quad.easeOut' });
  }

  // Gained: bright flash and a bounce. Used: a quick squash.
  pop(cell, gained) {
    const tweens = this.scene.tweens;
    tweens.killTweensOf([cell.icon, cell.flash, cell.count]);
    cell.icon.setScale(cell.baseScale * (gained ? 1.5 : 0.7));
    tweens.add({ targets: cell.icon, scale: cell.baseScale, duration: 360, ease: 'Back.easeOut' });
    cell.count.setScale(1.4);
    tweens.add({ targets: cell.count, scale: 1, duration: 300, ease: 'Back.easeOut' });
    cell.flash.setFillStyle(gained ? 0xfff2d0 : COLORS.health, 1).setAlpha(gained ? 0.7 : 0.35);
    tweens.add({ targets: cell.flash, alpha: 0, duration: 420, ease: 'Quad.easeOut' });
  }
}

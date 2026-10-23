// Inventory: 8 slots in a row at the top-right, showing `item-<id>` icons.
// On a new item the slot flashes and briefly uses the "selected" frame.

import Phaser from 'phaser';
import { INVENTORY, SLOT } from './uiLayout.js';
import { DEPTH } from './uiStyle.js';

// The 64×64 item icons are drawn at a fractional scale, so they look better
// smoothed than with nearest filtering. Those textures are only used by the UI.
export function smoothItemTexture(scene, key) {
  if (!scene.textures.exists(key)) return false;
  scene.textures.get(key).setFilter(Phaser.Textures.FilterMode.LINEAR);
  return true;
}

export class InventoryBar {
  constructor(scene) {
    this.scene = scene;
    this.ids = [];
    this.container = scene.add.container(INVENTORY.x, INVENTORY.y).setDepth(DEPTH.inventory);
    this.slots = [];

    for (let i = 0; i < SLOT.count; i++) {
      const x = i * (SLOT.size + SLOT.gap);
      const frame = scene.add.image(x, 0, 'ui-slot').setOrigin(0);
      const icon = scene.add.image(x + SLOT.size / 2, SLOT.size / 2, '__DEFAULT').setVisible(false);
      const flash = scene.add.rectangle(x + SLOT.size / 2, SLOT.size / 2, SLOT.size - 12, SLOT.size - 12, 0xfff2d0).setAlpha(0);
      this.container.add([frame, icon, flash]);
      this.slots.push({ frame, icon, flash, resetTimer: null });
    }
  }

  // ids: GameState.inventory (pickup order). Only the first 8 fit in the bar.
  setItems(ids) {
    this.ids = (ids || []).slice(0, SLOT.count);
    this.slots.forEach((slot, i) => {
      const id = this.ids[i];
      const key = id ? `item-${id}` : null;
      if (key && smoothItemTexture(this.scene, key)) {
        slot.icon.setTexture(key).setScale(INVENTORY.iconScale).setVisible(true);
      } else {
        slot.icon.setVisible(false);
        if (key) console.warn(`[UI] missing texture ${key}`);
      }
    });
  }

  // Flash the slot holding `id` (the most recent copy of it).
  flash(id) {
    const index = this.ids.lastIndexOf(id);
    if (index < 0) return;
    const slot = this.slots[index];
    const tweens = this.scene.tweens;

    slot.frame.setTexture('ui-slot-selected');
    tweens.killTweensOf(slot.flash);
    slot.flash.setAlpha(0.75);
    tweens.add({ targets: slot.flash, alpha: 0, duration: 450, ease: 'Quad.easeOut' });

    tweens.killTweensOf(slot.icon);
    slot.icon.setScale(INVENTORY.iconScale * 1.4);
    tweens.add({ targets: slot.icon, scale: INVENTORY.iconScale, duration: 380, ease: 'Back.easeOut' });

    if (slot.resetTimer) slot.resetTimer.remove(false);
    slot.resetTimer = this.scene.time.delayedCall(1400, () => {
      slot.frame.setTexture('ui-slot');
      slot.resetTimer = null;
    });
  }
}

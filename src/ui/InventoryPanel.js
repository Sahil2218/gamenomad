// Optional inventory detail panel (I / TAB): lists held items with their
// name and description from items.json. Sits under the slot row.

import { COLORS, CSS, INVENTORY_PANEL, SCREEN } from './uiLayout.js';
import { DEPTH, bodyStyle, drawPanel, titleStyle } from './uiStyle.js';
import { smoothItemTexture } from './InventoryBar.js';

const ICON_SCALE = 0.75; // 64×64 icons shown at 48×48
const HEADER_H = 40;

export class InventoryPanel {
  constructor(scene, itemData) {
    this.scene = scene;
    this.itemData = itemData || {};
    this.isOpen = false;
    this.container = scene.add.container(INVENTORY_PANEL.x, INVENTORY_PANEL.y).setDepth(DEPTH.inventoryPanel).setVisible(false);
    this.bg = scene.add.graphics();
    this.header = scene.add.text(INVENTORY_PANEL.pad, 12, 'INVENTORY', titleStyle(16, CSS.cyan));
    this.divider = scene.add.image(INVENTORY_PANEL.width - INVENTORY_PANEL.pad, 20, 'ui-divider-cyan').setOrigin(1, 0.5);
    this.container.add([this.bg, this.header, this.divider]);
    this.rows = [];
  }

  toggle(ids) {
    if (this.isOpen) this.close();
    else this.open(ids);
  }

  open(ids) {
    this.isOpen = true;
    this.refresh(ids);
    const tweens = this.scene.tweens;
    tweens.killTweensOf(this.container);
    this.container.setVisible(true).setAlpha(0);
    this.container.y = INVENTORY_PANEL.y - 8;
    tweens.add({ targets: this.container, alpha: 1, y: INVENTORY_PANEL.y, duration: 160, ease: 'Cubic.easeOut' });
  }

  close() {
    this.isOpen = false;
    const tweens = this.scene.tweens;
    tweens.killTweensOf(this.container);
    tweens.add({ targets: this.container, alpha: 0, duration: 120, onComplete: () => this.container.setVisible(false) });
  }

  // Rebuild the rows (only while open; cheap, the list is short).
  refresh(ids) {
    if (!this.isOpen) return;
    this.rows.forEach((obj) => obj.destroy());
    this.rows = [];

    const p = INVENTORY_PANEL;
    const maxRows = Math.floor((SCREEN.height - p.y - HEADER_H - p.pad * 2 - 280) / p.rowHeight); // keep clear of the dialogue box
    const list = ids || [];
    const shown = list.slice(0, Math.max(1, maxRows));
    let y = HEADER_H;

    if (list.length === 0) {
      this.rows.push(this.scene.add.text(p.pad, y + 4, 'Nothing yet.', bodyStyle(24, CSS.muted)));
      y += 36;
    }

    for (const id of shown) {
      const data = this.itemData[id] || { name: id, description: '' };
      const key = `item-${id}`;
      if (smoothItemTexture(this.scene, key)) {
        this.rows.push(this.scene.add.image(p.pad + 24, y + 26, key).setScale(ICON_SCALE));
      }
      const textX = p.pad + 60;
      const nameColor = data.type === 'artifact' ? CSS.orange : CSS.cream;
      this.rows.push(this.scene.add.text(textX, y + 2, data.name.toUpperCase(), titleStyle(16, nameColor)));
      const desc = this.scene.add.text(textX, y + 22, data.description, bodyStyle(20, CSS.muted, { wordWrap: { width: p.width - textX - p.pad }, lineSpacing: -2 }));
      this.rows.push(desc);
      y += Math.max(p.rowHeight, 26 + desc.height + 8);
    }

    if (list.length > shown.length) {
      this.rows.push(this.scene.add.text(p.pad, y, `+${list.length - shown.length} more`, bodyStyle(22, CSS.muted)));
      y += 28;
    }

    this.container.add(this.rows);
    const height = y + p.pad - 6;
    this.bg.clear();
    drawPanel(this.bg, 0, 0, p.width, height, { border: COLORS.rust });
  }
}

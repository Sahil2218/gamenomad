// Vertical choice list shown above the dialogue box. The selected option gets
// an orange ▶ marker and a highlight bar. UIScene handles the keys.

import { CHOICES, COLORS, CSS } from './uiLayout.js';
import { DEPTH, bodyStyle, drawPanel } from './uiStyle.js';

const MAX_WIDTH = 620;
const MARKER_W = 20; // space for the ▶ marker before the text

export class ChoiceList {
  constructor(scene) {
    this.scene = scene;
    this.index = 0;
    this.rows = []; // { text, y, height }
    this.isVisible = false;
    this.container = scene.add.container(0, 0).setDepth(DEPTH.choices).setVisible(false);
    this.bg = scene.add.graphics();
    this.highlight = scene.add.graphics();
    this.marker = scene.add.graphics();
    this.container.add([this.bg, this.highlight, this.marker]);
  }

  get count() {
    return this.rows.length;
  }

  // labels: array of strings. Numbered 1..n so the 1–4 keys are discoverable.
  show(labels) {
    this.clearRows();
    const c = CHOICES;
    const textX = c.padX + MARKER_W;

    // Measure first so the panel can grow for long options (up to MAX_WIDTH, then wrap).
    const texts = labels.map((label, i) => this.scene.add.text(textX, 0, `${i + 1}. ${label}`, bodyStyle(c.textSize)));
    const widest = Math.max(...texts.map((t) => t.width), 0);
    const width = Math.min(MAX_WIDTH, Math.max(c.width, Math.ceil(widest) + textX + c.padX));
    texts.forEach((t) => t.setWordWrapWidth(width - textX - c.padX));

    let y = c.padY;
    this.rows = texts.map((text) => {
      const height = Math.max(c.rowHeight, Math.ceil(text.height) + 6);
      text.setY(y + Math.round((height - text.height) / 2));
      const row = { text, y, height };
      y += height;
      return row;
    });
    const height = y + c.padY;

    this.width = width;
    this.container.setPosition(c.right - width, c.bottom - height);
    this.container.add(texts);
    this.bg.clear();
    drawPanel(this.bg, 0, 0, width, height);

    this.isVisible = true;
    this.container.setVisible(true).setAlpha(0);
    this.scene.tweens.killTweensOf(this.container);
    this.scene.tweens.add({ targets: this.container, alpha: 1, duration: 140 });
    this.select(0);
  }

  hide() {
    if (!this.isVisible) return;
    this.isVisible = false;
    this.scene.tweens.killTweensOf(this.container);
    this.container.setVisible(false);
    this.clearRows();
  }

  clearRows() {
    this.rows.forEach((row) => row.text.destroy());
    this.rows = [];
  }

  move(step) {
    if (this.count === 0) return;
    this.select((this.index + step + this.count) % this.count);
  }

  select(index) {
    if (this.count === 0) return;
    this.index = Math.max(0, Math.min(this.count - 1, index));
    const row = this.rows[this.index];

    this.rows.forEach((r, i) => r.text.setColor(i === this.index ? CSS.orange : CSS.cream));

    this.highlight.clear();
    this.highlight.fillStyle(COLORS.orange, 0.16);
    this.highlight.fillRect(6, row.y + 2, this.width - 12, row.height - 4);
    this.highlight.fillStyle(COLORS.orange, 0.9);
    this.highlight.fillRect(6, row.y + 2, 2, row.height - 4);

    // ▶ drawn as a triangle (the pixel fonts have no arrow glyph).
    const cx = CHOICES.padX + 4;
    const cy = row.y + row.height / 2;
    this.marker.clear();
    this.marker.fillStyle(COLORS.orange, 1);
    this.marker.fillTriangle(cx - 4, cy - 7, cx - 4, cy + 7, cx + 6, cy);
  }
}

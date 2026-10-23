// Toasts: small panels at the top-centre, shown one at a time from a queue.
// Kinds: 'info' (cream), 'item' (orange, optional item icon), 'warning' (red),
// 'party' (cyan border, companion head icon).
// A toast may belong to a `group` (M3: the guide on/off feedback): a newer toast
// of the same group replaces the older one and jumps the queue.

import { COLORS, CSS, TOAST } from './uiLayout.js';
import { DEPTH, bodyStyle, drawPanel } from './uiStyle.js';

const KIND_STYLE = {
  info: { text: CSS.cream, border: COLORS.rust },
  item: { text: CSS.orange, border: COLORS.orange },
  warning: { text: CSS.warning, border: COLORS.warning },
  party: { text: CSS.cream, border: COLORS.cyan },
};
const MAX_QUEUE = 4;
const ICON_GAP = 10;

export class Toasts {
  constructor(scene) {
    this.scene = scene;
    this.queue = [];
    this.current = null; // { text, container }
  }

  // iconKey: optional texture key drawn left of the text. group: see above.
  push(text, kind = 'info', iconKey = null, group = null) {
    const message = String(text || '').trim();
    if (!message) return;
    const entry = { text: message, kind: KIND_STYLE[kind] ? kind : 'info', iconKey, group };
    if (group) {
      this.queue = this.queue.filter((t) => t.group !== group);
      if (this.current && this.current.group === group) {
        if (this.current.text === message) return;
        this.queue.unshift(entry);
        this.dismissCurrent(90);
        return;
      }
      this.queue.unshift(entry);
      if (!this.current) this.showNext();
      return;
    }
    // Skip exact repeats that are already showing or waiting (e.g. the barrier push hint).
    if ((this.current && this.current.text === message) || this.queue.some((t) => t.text === message)) return;
    if (this.queue.length >= MAX_QUEUE) this.queue.shift();
    this.queue.push(entry);
    if (!this.current) this.showNext();
  }

  // Fade the showing toast out (now, or when its time is up), then show the next one.
  dismissCurrent(duration = TOAST.fadeMs) {
    const current = this.current;
    if (!current || current.leaving) return;
    current.leaving = true;
    current.timer.remove(false);
    this.scene.tweens.killTweensOf(current.container);
    this.scene.tweens.add({
      targets: current.container,
      alpha: 0,
      y: TOAST.y - 8,
      duration,
      onComplete: () => {
        current.container.destroy();
        this.showNext();
      },
    });
  }

  showNext() {
    const next = this.queue.shift();
    if (!next) {
      this.current = null;
      return;
    }
    const scene = this.scene;
    const style = KIND_STYLE[next.kind];
    const hasIcon = Boolean(next.iconKey && scene.textures.exists(next.iconKey));
    const textX = TOAST.padX + (hasIcon ? TOAST.iconSize + ICON_GAP - 6 : 0);
    const maxTextW = TOAST.maxWidth - textX - TOAST.padX;

    const label = scene.add.text(textX, 0, next.text, bodyStyle(TOAST.textSize, style.text, { wordWrap: { width: maxTextW } }));
    const width = Math.round(Math.max(TOAST.minWidth, textX + label.width + TOAST.padX));
    const height = Math.round(Math.max(TOAST.height, label.height + 14));
    label.setY(Math.round((height - label.height) / 2));
    if (width === TOAST.minWidth) label.setX(Math.round((width - label.width + textX - TOAST.padX) / 2)); // centre short text

    const bg = scene.add.graphics();
    drawPanel(bg, 0, 0, width, height, { border: style.border });
    const parts = [bg, label];
    if (hasIcon) {
      // Item -sm icons are 24×24 (drawn 1:1); full 64×64 icons are halved.
      const icon = scene.add.image(TOAST.padX + TOAST.iconSize / 2 - 4, height / 2, next.iconKey);
      if (icon.width > TOAST.iconSize) icon.setScale(TOAST.iconSize / icon.width);
      parts.splice(1, 0, icon);
    }

    const x = Math.round(TOAST.centerX - width / 2);
    const container = scene.add.container(x, TOAST.y - 10, parts).setDepth(DEPTH.toasts).setAlpha(0);
    const timer = scene.time.delayedCall(TOAST.holdMs, () => this.dismissCurrent());
    this.current = { text: next.text, group: next.group, container, timer, leaving: false };

    scene.tweens.add({ targets: container, alpha: 1, y: TOAST.y, duration: TOAST.fadeMs, ease: 'Cubic.easeOut' });
  }
}

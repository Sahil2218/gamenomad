import Phaser from 'phaser';
import { GameState } from '../systems/GameState.js';

const GLOW_COLOR = 0xffd27a;

/**
 * An item lying in the world: a small floating icon with a soft pulsing glow.
 *
 * data: { id, item, x, y, dialogue, requires }, where (x, y) is the spot on the ground.
 *   dialogue  may be null (supplies): the UI's "Obtained" toast is enough.
 *   requires  optional dialogue-style condition; while it fails the pickup is hidden.
 */
export default class Pickup {
  constructor(scene, data) {
    this.scene = scene;
    this.id = data.id;
    this.item = data.item;
    this.dialogueId = data.dialogue || null;
    this.requires = data.requires || null;
    this.x = data.x;
    this.y = data.y;
    this.destroyed = false;

    // Glow: a few stacked translucent circles, blended additively so they brighten what's below.
    this.glow = scene.add.graphics({ x: data.x, y: data.y - 14 });
    [16, 11, 7].forEach((radius) => this.glow.fillStyle(GLOW_COLOR, 0.22).fillCircle(0, 0, radius));
    this.glow.setBlendMode(Phaser.BlendModes.ADD);

    // Floating icon, origin at its bottom so it hovers just above (x, y).
    this.sprite = scene.add.image(data.x, data.y - 4, `item-${data.item}-sm`).setOrigin(0.5, 1);

    // Depth sorting like the other actors: by the ground position.
    this.glow.setDepth(data.y - 0.5);
    this.sprite.setDepth(data.y);

    // Tweens animate a property over time. yoyo plays it back, repeat -1 loops forever.
    scene.tweens.add({
      targets: this.sprite,
      y: data.y - 8,
      duration: 900,
      ease: 'Sine.easeInOut',
      yoyo: true,
      repeat: -1,
    });
    scene.tweens.add({
      targets: this.glow,
      alpha: { from: 1, to: 0.45 },
      scale: { from: 1, to: 1.25 },
      duration: 900,
      ease: 'Sine.easeInOut',
      yoyo: true,
      repeat: -1,
    });

    this.refresh();
  }

  /** Can the player see and take it right now? */
  isAvailable() {
    return !this.destroyed && GameState.check(this.requires);
  }

  /** Shows or hides the pickup after the quest or flags changed. */
  refresh() {
    if (this.destroyed) return;
    const visible = this.isAvailable();
    this.sprite.setVisible(visible);
    this.glow.setVisible(visible);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.scene.tweens.killTweensOf([this.sprite, this.glow]);
    this.sprite.destroy();
    this.glow.destroy();
  }
}

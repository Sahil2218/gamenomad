import Phaser from 'phaser';

/**
 * Shared base for the player and NPCs: a sprite with an Arcade physics body
 * and 4-direction walk/idle animations.
 *
 * An Arcade body is an invisible rectangle that Phaser's physics engine moves
 * (from its velocity) and stops when it hits other bodies. We keep it small and
 * at the feet, so characters can walk "in front of" walls and only collide at ground level.
 */
export default class Character extends Phaser.Physics.Arcade.Sprite {
  constructor(scene, x, y, textureKey, facing = 'down') {
    super(scene, x, y, textureKey, 0);

    scene.add.existing(this); // draw it
    scene.physics.add.existing(this); // give it a physics body (this.body)

    // Origin (0.5, 1) = bottom-centre, so (x, y) is where the feet touch the ground.
    this.setOrigin(0.5, 1);

    // 16×10 body at the bottom of the 32×48 frame. Offsets are measured from the frame's top-left.
    this.body.setSize(16, 10, false);
    this.body.setOffset(8, 38);

    this.facing = facing;
    this.playIdle();
    this.updateDepth();
  }

  /** Plays "<texture>-walk-<dir>" or "<texture>-idle-<dir>". Right reuses left, mirrored. */
  playAnim(mode, facing = this.facing) {
    this.facing = facing;
    this.setFlipX(facing === 'right');

    const row = facing === 'right' ? 'left' : facing;
    const key = `${this.texture.key}-${mode}-${row}`;
    if (this.scene.anims.exists(key)) this.anims.play(key, true); // true = don't restart if already playing
  }

  playWalk(facing) {
    this.playAnim('walk', facing);
  }

  playIdle(facing) {
    this.playAnim('idle', facing);
  }

  stopMoving() {
    this.setVelocity(0, 0);
    this.playIdle();
  }

  /** Turns to look at a world point, e.g. the person we are talking to. */
  faceTowards(x, y) {
    const dx = x - this.x;
    const dy = y - this.y;
    let facing;
    if (Math.abs(dx) > Math.abs(dy)) facing = dx < 0 ? 'left' : 'right';
    else facing = dy < 0 ? 'up' : 'down';

    this.setVelocity(0, 0);
    this.playIdle(facing);
  }

  /**
   * Depth sorting: objects with a higher depth are drawn on top.
   * Using the feet y means whoever stands lower on screen is drawn in front.
   */
  updateDepth() {
    this.setDepth(this.y);
  }
}

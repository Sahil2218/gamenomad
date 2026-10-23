import Phaser from 'phaser';

/**
 * The Milestone 2 "Act IV coming next" stub is retired: the story now goes on to
 * Paradise Gate and ends in the 'Ending' scene. Anything that still starts 'End'
 * (an old link, ?scene=End) is simply forwarded there.
 */
export default class EndScene extends Phaser.Scene {
  constructor() {
    super('End');
  }

  create() {
    this.scene.start('Ending');
  }
}

import Phaser from 'phaser';

// The fonts are npm packages. Importing them adds their @font-face CSS to the page.
import '@fontsource/vt323';
import '@fontsource/silkscreen';

import { DEV } from './systems/devFlags.js';
import { GameState } from './systems/GameState.js';
import { Dialogue } from './systems/Dialogue.js';
import BootScene from './scenes/BootScene.js';
import MenuScene from './scenes/MenuScene.js';
import VillageScene from './scenes/VillageScene.js';
import OutskirtsScene from './scenes/OutskirtsScene.js';
import WastelandScene from './scenes/WastelandScene.js';
import GateScene from './scenes/GateScene.js';
import HollowScene from './scenes/HollowScene.js';
import SiloScene from './scenes/SiloScene.js';
import EndScene from './scenes/EndScene.js';
import EndingScene from './scenes/EndingScene.js';
import UIScene from './scenes/UIScene.js';
import SignalScene from './scenes/SignalScene.js';

// Phaser draws text onto a canvas once, when the text is created. If the font
// hasn't downloaded yet, the text is drawn in a fallback font, so we wait first.
async function loadFonts() {
  try {
    await Promise.all([document.fonts.load('24px VT323'), document.fonts.load('24px Silkscreen')]);
  } catch (error) {
    console.warn('Fonts failed to load; using fallback fonts.', error);
  }
}

function createGame() {
  return new Phaser.Game({
    type: Phaser.AUTO, // WebGL if available, otherwise Canvas
    parent: 'game',
    width: 1280,
    height: 720,
    backgroundColor: '#0b0d12',
    pixelArt: true, // no smoothing when sprites are scaled
    roundPixels: true, // snap to whole pixels to avoid shimmering
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    physics: {
      default: 'arcade',
      arcade: {
        gravity: { x: 0, y: 0 }, // top-down game: nothing falls
        debug: DEV.debug,
        debugStaticBodyColor: 0x00ff00, // match the green collider outlines from MapBuilder
      },
    },
    // A Scene is one "screen" of the game with its own objects, camera and update loop.
    // Phaser automatically starts the first one in this list (Boot).
    // The order also sets draw order: UI is drawn over the world scenes (and the Ending),
    // and the Signal mini-game (launched on top of the Wasteland or the Silo) over everything.
    // 'End' is the retired Milestone 2 stub; it just forwards to 'Ending'.
    scene: [
      BootScene,
      MenuScene,
      VillageScene,
      OutskirtsScene,
      WastelandScene,
      GateScene,
      HollowScene,
      SiloScene,
      EndScene,
      EndingScene,
      UIScene,
      SignalScene,
    ],
  });
}

loadFonts().then(() => {
  const game = createGame();
  // Handy for automated tests and for poking around in the browser console.
  window.__NOMAD = { game, GameState, Dialogue };
});

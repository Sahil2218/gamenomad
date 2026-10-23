import Phaser from 'phaser';
import { GameState } from '../systems/GameState.js';
import { str } from '../systems/strings.js';
import { startWorldScene, stopUI } from '../systems/sceneFlow.js';

const PAN_MS = 30000; // one slow sweep across the map
const KEYS = Phaser.Input.Keyboard.KeyCodes;
const CONFIRM_KEYS = [KEYS.E, KEYS.ENTER, KEYS.SPACE];
const UP_KEYS = [KEYS.W, KEYS.UP];
const DOWN_KEYS = [KEYS.S, KEYS.DOWN];

const SELECTED_COLOR = '#f0a030';
const IDLE_COLOR = '#9a8f7c';

/**
 * Title screen: the village drifting by in the dark and the title.
 * Without a save: "press any key" starts a new game.
 * With a save: CONTINUE / NEW GAME, chosen with W/S and confirmed with E/ENTER/SPACE.
 */
export default class MenuScene extends Phaser.Scene {
  constructor() {
    super('Menu');
  }

  create() {
    const { width, height } = this.scale;
    this.starting = false;

    // Coming back from the Ending: no HUD or minimap on the title screen.
    stopUI(this);
    GameState.setWorld(null);

    this.createBackground(width, height);
    this.createTitle(width, height);
    this.cameras.main.fadeIn(600, 0, 0, 0);

    if (GameState.hasSave()) this.createOptions(width, height);
    else this.createPressAnyKey(width, height);
  }

  createBackground(width, height) {
    const map = this.add.image(0, 0, 'map-village').setOrigin(0);

    // Slowly pan by moving the picture back and forth (yoyo) inside the screen.
    this.tweens.add({
      targets: map,
      x: Math.min(0, width - map.width),
      y: Math.min(0, height - map.height),
      duration: PAN_MS,
      ease: 'Sine.easeInOut',
      yoyo: true,
      repeat: -1,
    });

    // A translucent black rectangle on top darkens the map.
    this.add.rectangle(0, 0, width, height, 0x000000, 0.65).setOrigin(0);
  }

  createTitle(width, height) {
    this.add
      .text(width / 2, height * 0.38, str('menu-title'), {
        fontFamily: 'Silkscreen',
        fontSize: '40px',
        color: '#f0a030',
        stroke: '#12141c',
        strokeThickness: 6,
        align: 'center',
      })
      .setOrigin(0.5)
      .setLetterSpacing(4);

    this.add
      .text(width / 2, height * 0.38 + 52, str('menu-subtitle'), {
        fontFamily: 'Silkscreen',
        fontSize: '20px',
        color: '#3ad4e8',
        align: 'center',
      })
      .setOrigin(0.5)
      .setLetterSpacing(2);
  }

  // ---------- no save: press any key ----------

  createPressAnyKey(width, height) {
    const prompt = this.add
      .text(width / 2, height * 0.72, str('menu-prompt'), {
        fontFamily: 'VT323',
        fontSize: '30px',
        color: '#efe6d2',
      })
      .setOrigin(0.5);

    // Blink: fade the prompt out and back in forever.
    this.tweens.add({ targets: prompt, alpha: 0.15, duration: 700, yoyo: true, repeat: -1 });

    // Any key or click starts the game. Held-key repeats are ignored, so the key that
    // closed the End screen can't start a new game by itself.
    this.input.keyboard.on('keydown', (event) => {
      if (!event.repeat) this.newGame();
    });
    this.input.once('pointerdown', () => this.newGame());
  }

  // ---------- with a save: CONTINUE / NEW GAME ----------

  createOptions(width, height) {
    this.options = [
      { label: str('menu-continue'), action: () => this.continueGame() },
      { label: str('menu-new-game'), action: () => this.newGame() },
    ];
    this.selected = 0;

    this.optionTexts = this.options.map((option, index) =>
      this.add
        .text(width / 2, height * 0.68 + index * 44, option.label, {
          fontFamily: 'Silkscreen',
          fontSize: '24px',
          color: IDLE_COLOR,
        })
        .setOrigin(0.5)
        .setLetterSpacing(2)
        // setInteractive makes the text clickable; pointerover/pointerdown are mouse events.
        .setInteractive({ useHandCursor: true })
        .on('pointerover', () => this.select(index))
        .on('pointerdown', () => this.confirm()),
    );
    this.select(0);

    this.input.keyboard.on('keydown', this.onKeyDown, this);
  }

  onKeyDown(event) {
    if (UP_KEYS.includes(event.keyCode)) this.select(this.selected - 1);
    if (DOWN_KEYS.includes(event.keyCode)) this.select(this.selected + 1);
    if (CONFIRM_KEYS.includes(event.keyCode) && !event.repeat) this.confirm();
  }

  select(index) {
    // Wrap around: up from the first option goes to the last one.
    this.selected = Phaser.Math.Wrap(index, 0, this.options.length);
    this.optionTexts.forEach((text, i) => {
      const isSelected = i === this.selected;
      text.setColor(isSelected ? SELECTED_COLOR : IDLE_COLOR);
      text.setText(isSelected ? `> ${this.options[i].label} <` : this.options[i].label);
    });
  }

  confirm() {
    this.options[this.selected].action();
  }

  // ---------- starting ----------

  newGame() {
    this.fadeOutThen(() => {
      GameState.clearSave();
      GameState.reset();
      startWorldScene(this, 'Village');
    });
  }

  /** Loads the save and starts its scene; the world scene puts the player at the checkpoint. */
  continueGame() {
    this.fadeOutThen(() => {
      if (!GameState.loadSave()) {
        GameState.reset();
        startWorldScene(this, 'Village');
        return;
      }
      const checkpoint = GameState.checkpoint;
      startWorldScene(this, (checkpoint && checkpoint.scene) || 'Village');
    });
  }

  fadeOutThen(callback) {
    if (this.starting) return; // a key and a click in the same moment
    this.starting = true;

    this.cameras.main.fadeOut(400, 0, 0, 0);
    this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, callback);
  }
}

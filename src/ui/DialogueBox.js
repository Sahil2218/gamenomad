// Dialogue box at the bottom-centre: name plate, optional portrait, typewriter
// text and a blinking ▼ once the line is fully shown.

import { COLORS, CSS, DIALOGUE } from './uiLayout.js';
import { DEPTH, bodyStyle, titleStyle } from './uiStyle.js';

// Silkscreen is a pixel font: crisp at 16 px (2× its grid) and 8 px (1×).
const NAME_FALLBACK_SIZE = 8;

// Box texture for each combination of name plate / portrait recess.
function boxTexture(hasName, hasPortrait) {
  if (hasName && hasPortrait) return 'ui-dialogue';
  if (hasName) return 'ui-dialogue-noportrait';
  if (hasPortrait) return 'ui-dialogue-noplate';
  return 'ui-dialogue-narration';
}

export class DialogueBox {
  constructor(scene) {
    const d = DIALOGUE;
    this.scene = scene;
    this.isOpen = false;
    this.fullText = '';
    this.revealed = 0; // characters shown so far (fractional while typing)
    this.typing = false;
    this.hasLine = false;
    this.warnedPortraits = new Set();

    this.container = scene.add.container(d.x, d.y).setDepth(DEPTH.dialogue).setVisible(false).setAlpha(0);
    this.bg = scene.add.image(0, 0, 'ui-dialogue').setOrigin(0);

    const plate = d.namePlate;
    this.name = scene.add.text(plate.x + plate.w / 2, plate.y + plate.h / 2, '', titleStyle(d.nameSize)).setOrigin(0.5);

    // Portrait: bottom-centre aligned in the recess so the shoulders sit on its floor.
    const p = d.portrait;
    this.portrait = scene.add.image(p.x + p.w / 2, p.y + p.h - 1, '__DEFAULT').setOrigin(0.5, 1).setVisible(false);

    this.body = scene.add.text(d.textWithPortrait.x, d.textWithPortrait.y, '', bodyStyle(d.textSize, CSS.cream, { lineSpacing: d.lineSpacing }));

    this.arrow = scene.add.graphics().setVisible(false);
    const a = d.arrow;
    this.arrow.fillStyle(COLORS.black, 1);
    this.arrow.fillTriangle(-a.w / 2 + 1, -a.h / 2 + 2, a.w / 2 + 1, -a.h / 2 + 2, 1, a.h / 2 + 2); // drop shadow
    this.arrow.fillStyle(COLORS.cream, 1);
    this.arrow.fillTriangle(-a.w / 2, -a.h / 2, a.w / 2, -a.h / 2, 0, a.h / 2);
    this.arrow.setPosition(a.x, a.y);

    this.container.add([this.bg, this.name, this.portrait, this.body, this.arrow]);
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    const tweens = this.scene.tweens;
    tweens.killTweensOf(this.container);
    this.container.setVisible(true);
    this.container.y = DIALOGUE.y + DIALOGUE.slideDistance;
    tweens.add({ targets: this.container, y: DIALOGUE.y, alpha: 1, duration: 180, ease: 'Cubic.easeOut' });
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.typing = false;
    this.hasLine = false;
    const tweens = this.scene.tweens;
    tweens.killTweensOf(this.container);
    tweens.add({
      targets: this.container,
      y: DIALOGUE.y + DIALOGUE.slideDistance,
      alpha: 0,
      duration: 160,
      ease: 'Cubic.easeIn',
      onComplete: () => {
        this.container.setVisible(false);
        this.body.setText('');
        this.stopArrow();
      },
    });
  }

  // line: { speaker, portrait, text } from 'dialogue:line'.
  showLine({ speaker, portrait, text }) {
    this.open();
    const hasName = this.setSpeaker(speaker);
    const hasPortrait = this.setPortrait(portrait);
    this.bg.setTexture(boxTexture(hasName, hasPortrait));
    const rect = hasPortrait ? DIALOGUE.textWithPortrait : DIALOGUE.textFull;

    // Wrap the whole line once, then reveal it character by character. Revealing
    // pre-wrapped text stops words from jumping to the next line mid-typing.
    this.body.setPosition(rect.x, rect.y);
    this.body.setWordWrapWidth(rect.w);
    this.fullText = this.body.getWrappedText(String(text || '')).join('\n');
    this.body.setWordWrapWidth(null);
    this.body.setText('');
    this.revealed = 0;
    this.typing = true;
    this.hasLine = true;
    this.stopArrow();
  }

  // Returns true when a name is shown (an empty speaker means narration).
  setSpeaker(speaker) {
    const name = String(speaker || '').trim();
    this.name.setVisible(Boolean(name));
    if (!name) return false;

    // Long names that don't fit the plate at 16 px drop to the crisp 8 px size.
    this.name.setFontSize(DIALOGUE.nameSize).setText(name.toUpperCase());
    if (this.name.width > DIALOGUE.namePlate.w - 10) this.name.setFontSize(NAME_FALLBACK_SIZE);
    return true;
  }

  // Returns true when a portrait is shown.
  setPortrait(portrait) {
    const key = portrait ? `portrait-${portrait}` : null;
    if (!key || !this.scene.textures.exists(key)) {
      if (key && !this.warnedPortraits.has(key)) {
        this.warnedPortraits.add(key);
        console.warn(`[UI] missing portrait texture ${key}`);
      }
      this.portrait.setVisible(false);
      return false;
    }
    this.portrait.setTexture(key).setScale(DIALOGUE.portraitScale).setVisible(true);
    return true;
  }

  // Called every frame by UIScene.
  update(delta) {
    if (!this.typing) return;
    const before = Math.floor(this.revealed);
    this.revealed += (delta * DIALOGUE.charsPerSecond) / 1000;
    const now = Math.floor(this.revealed);
    if (now >= this.fullText.length) {
      this.finishLine();
    } else if (now !== before) {
      this.body.setText(this.fullText.slice(0, now));
    }
  }

  isTyping() {
    return this.typing;
  }

  // Show the rest of the line immediately and start the ▼ blinking.
  finishLine() {
    if (!this.hasLine) return;
    this.typing = false;
    this.revealed = this.fullText.length;
    this.body.setText(this.fullText);
    this.startArrow();
  }

  startArrow() {
    const tweens = this.scene.tweens;
    tweens.killTweensOf(this.arrow);
    const a = DIALOGUE.arrow;
    this.arrow.setVisible(true).setAlpha(1).setPosition(a.x, a.y);
    tweens.add({ targets: this.arrow, alpha: 0.25, y: a.y + 2, duration: 420, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
  }

  // Hide the ▼ (e.g. while choices are shown or a new line is typing).
  stopArrow() {
    this.scene.tweens.killTweensOf(this.arrow);
    this.arrow.setVisible(false);
  }
}

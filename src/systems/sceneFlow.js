// UIScene runs *in parallel* with the world scenes: it is drawn on top of them
// and keeps running when we switch from Village to Outskirts to Wasteland.
// It must be launched exactly once, so we check whether it is already running.

export function startWorldScene(fromScene, key) {
  // Launch the UI first, so it is already listening to GameState events
  // (title cards, toasts…) when the world scene's create() emits them.
  if (!fromScene.scene.isActive('UI')) {
    fromScene.scene.launch('UI');
  }
  // start() stops the current scene and starts the new one.
  fromScene.scene.start(key);
}

/** The menu has no HUD, so it stops the UI scene (startWorldScene launches it again). */
export function stopUI(fromScene) {
  if (fromScene.scene.isActive('UI') || fromScene.scene.isPaused('UI')) {
    fromScene.scene.stop('UI');
  }
}

// Developer switches read from the page URL, e.g.
//   http://localhost:5174/?scene=Wasteland&quest=survivors&party=mira,kael&give=medkit&god=1
//   http://localhost:5174/?scene=Silo&quest=beacon&clues=99
//   http://localhost:5174/?scene=Ending&ending=quiet
// They are read once when the game loads. BootScene applies the state ones (quest, party…).

const params = new URLSearchParams(window.location.search);

/** "a,b, c" → ['a', 'b', 'c'] (empty when the param is missing). */
function list(name) {
  return (params.get(name) || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/** A whole number from the URL, or null when the param is missing or not a number. */
function number(name) {
  const value = parseInt(params.get(name), 10);
  return Number.isNaN(value) ? null : value;
}

export const DEV = {
  // Scene key to jump straight into (skips the menu), or null.
  scene: params.get('scene'),
  // Skip act title cards and intro dialogues in every scene.
  skipIntro: params.get('skipIntro') === '1',
  // Draw physics bodies and map outlines.
  debug: params.get('debug') === '1',
  // Damage is ignored.
  god: params.get('god') === '1',
  // Starting state, applied by BootScene together with ?scene.
  quest: params.get('quest'),
  party: list('party'),
  flags: list('flags'),
  give: list('give'),
  // Was ?party / ?give in the URL at all? (`?party=` means "nobody", so the scene defaults don't apply.)
  hasParty: params.has('party'),
  hasGive: params.has('give'),
  // ?ending=dawn|quiet for ?scene=Ending.
  ending: params.get('ending'),
  // ?clues=N sets N fake evidence flags (clue_test_1 … clue_test_N), to test the core's choice.
  clues: number('clues'),
};

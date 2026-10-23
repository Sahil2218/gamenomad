import strings from '../data/strings.json';

/**
 * Look up a UI string by key. A missing key shows the key itself,
 * so a typo is visible on screen instead of crashing the game.
 *
 * `vars` fills in placeholders: str('end-evidence', { n: 3, total: 9 })
 * turns "Evidence: {n}/{total}" into "Evidence: 3/9".
 */
export function str(key, vars = null) {
  if (strings[key] === undefined) {
    console.warn(`strings.json has no key "${key}"`);
    return key;
  }
  if (!vars) return strings[key];
  return strings[key].replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}

/** True if strings.json has this key (for optional texts). */
export function hasStr(key) {
  return strings[key] !== undefined;
}

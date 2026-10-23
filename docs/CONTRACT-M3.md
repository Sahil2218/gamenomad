# THE NOMAD — Build Contract, Milestone 3 (Acts IV–VI + Guide Trail)

This file **extends** `docs/CONTRACT.md` (M1) and `docs/CONTRACT-M2.md` (M2). Read all three. Where they disagree, this file wins. Do not edit any contract.

Acts I–III are complete, playtested, and the user says they're "perfect". **Do not regress them.** Before you change any existing code you own, read it. Keep the house style: beginner-readable code, small modules, and short comments on Phaser concepts.

Never run `npm install` or edit `package.json`. Keep the rules from earlier contracts:
- No occluders.
- Colliders cover each object's full drawn footprint.
- Pickups and NPCs stay at least 20 px from colliders and at least 40 px from map edges.
- Ids are globally unique.

---

## 0. Scope

1. **Guide trail.** The user asked to "highlight the path".
   - Gold glowing breadcrumbs on the ground lead from the player to the current objective along a walkable A* route.
   - The minimap shows the same route as a dotted line.
   - **G** toggles the trail. It is on by default and saved.
2. **Acts IV–VI:**

| Act | Scene key(s) | Area | What happens |
|---|---|---|---|
| IV · The White Cloud | `Gate`, then `Hollow` | Paradise Gate / Inside the Cloud | Eli scouts, dies (silver blood, a Construct). The party enters a dead, ash-black city, and Eli's keycard 01 opens a hatch. |
| V · The Truth Beneath | `Silo` | Silo 01 | Residents, the scientist, 3 archive terminals, and the memory restore. |
| VI · The Final Choice | `Silo` (same scene; act switches at stage `beacon`) | Silo 01 | Beacon alarm and swarm waves, then a choice: **destroy** (quiet ending) or **reprogram** (hold 3 relays, then a hard Signal round; dawn ending). |

3. **Flow:** `Wasteland` (exit, quest `cloud`) → `Gate` → `Hollow` → `Silo` → `Ending` → Menu.
   - The M2 `End` stub is retired. `?scene=End` should map to `Ending`.

## 1. Map schema additions (all optional)

```json
"markers": {
  "explore": [
    { "x": 460, "y": 360, "if": { "notFlags": ["picked_journal"] } },
    { "x": 1340, "y": 572, "if": { "notFlags": ["picked_shard"] } }
  ],
  "gate": { "x": 0, "y": 0 }
},
"points": { "eli-enter": { "x": 0, "y": 0 }, "eli-collapse": { "x": 0, "y": 0 } },
"vents": [ { "id": "v1", "x": 0, "y": 0 } ],
"relays": [ { "id": "relay-1", "x": 0, "y": 0, "w": 0, "h": 0 } ]
```

- **`markers`:** a marker value may be one point or an **array** of points, each with an optional `if` condition. `objectiveMarker()` returns the **nearest passing** point, or `null` if none pass.
- **`points`:** named scripted positions, used by cutscenes.
- **`vents`:** wave spawn points.
- **`relays`:** hold zones for the finale.

## 2. Condition additions (`GameState.check`)

These are new condition fields:

| Field | Meaning |
|---|---|
| `party: [ids]` | All of these are in the party |
| `notParty: [ids]` | None of these are in the party |
| `clues: N` | At least N distinct `clue_*` flags are set |
| `notClues: N` | Fewer than N `clue_*` flags are set |

## 3. Quest stages (new; act in brackets)

Objectives may use **`{n:<prefix>/<total>}`**, which is replaced by `"<count of flags starting with prefix>/<total>"`. Example: `"Read the archives ({n:archive_/3})"`.

| Stage | Act | Meaning |
|---|---|---|
| `gate` | IV | Set on entering Gate. "Reach the white wall." |
| `eli_scouts` | IV | Set by the engine while Eli's cutscene runs. |
| `eli_falls` | IV | After Eli dies. "Enter the cloud anyway." The `enter` zone works only in this stage. |
| `hollow` | IV | Set on entering Hollow. Search the dead city and find a way down; the marker points to the hatch. |
| `silo` | V | Set on entering Silo. Find the scientist. |
| `archives` | V | Read the 3 archive terminals: `{n:archive_/3}`. |
| `remember` | V | Go to the memory chamber with the scientist. Entering the `memory` zone fires the memory restore. |
| `beacon` | VI | **The act switches to VI.** The swarm is coming; reach the AEGIS core. Waves run from now until the ending. |
| `destroy` | VI | Chosen at the core: carry the artifacts to the reactor furnace (`furnace` zone). |
| `relays` | VI | Chosen at the core (needs evidence): hold the 3 relays, `{n:relay_/3}`. |
| `reprogram` | VI | All relays held. Return to the core and rewrite the signal: Signal in `reprogram` mode, then the dawn ending. |

## 4. Shared ids

**New characters**
- `scientist`: sprite, portrait and NPC id. The story task names her or him; the `name` field in `silo.json` must match.
- `resident-1`, `resident-2`, `resident-3`: silo people using the `villager` sprite with tints.

**Dialogue ids**
- **Gate:** `gate-intro`, `eli-scout`, `eli-dying`, `eli-after`, `inspect-arch`, `inspect-cloudwall`, `inspect-pilgrims`
- **Hollow:** `hollow-intro`, `inspect-hatch`, `inspect-estates`, `inspect-shrine`, `inspect-drone-husk`
- **Silo:**
  - `silo-arrival`, `scientist`, `resident-1`, `resident-2`, `resident-3`
  - `archive-history`, `archive-aegis`, `archive-villages`
  - `memory`, `beacon-alarm`, `core`, `furnace`, `relay`, `reprogram-ready`
  - `inspect-bunks`, `inspect-reactor`, `inspect-mural`
- **Ending:** `ending-dawn`, `ending-quiet`
- **`party-<id>`:** extend these with variants for every new stage. Eli is gone after `eli_falls`.

**Inspectable ids**
- Gate: `arch`, `cloudwall`, `pilgrims`
- Hollow: `hatch`, `estates`, `shrine`, `drone-husk`
- Silo: `archive-history`, `archive-aegis`, `archive-villages`, `core`, `bunks`, `reactor`, `mural`
- Each inspectable's dialogue is `inspect-<id>`. **Exceptions:** the archive terminals use `archive-*`, and `core` uses `core`.

**Zone ids**
- Gate: `approach` (triggers Eli's scene in stage `gate`), `enter` (the arch threshold), plus `points` `eli-enter`, `eli-collapse`, `party-halt`
- Silo: `memory`, `furnace`, plus `vents` (4–6) and `relays` (`relay-1` to `relay-3`)

**Effects events (new)**
| Event | What the engine does |
|---|---|
| `eli-scout` | Starts the Eli cutscene |
| `eli-dies` | Silver dissolve, `leaveParty('eli')`, flag `eli_gone` |
| `enter-silo` | Fade, then `Silo` |
| `memory-restore` | Full-screen memory overlay; flag `memories_restored` |
| `beacon` | Alarm, act → VI, waves start, quest `beacon` |
| `choose-destroy` | Quest `destroy` |
| `choose-reprogram` | Quest `relays` |
| `start-reprogram` | Launches `Signal` with `{ mode: 'reprogram' }` |
| `ending-quiet` | Ending `quiet` |
| `ending-dawn` | Ending `dawn` |

**The core's choice gate**
- Inside dialogue `core`, the reprogram choice only exists in a variant with `"if": { "clues": E }`.
- `E` = `strings['evidence-threshold']`, a number written as a string (e.g. `"14"`). The story task picks it and repeats it literally in the `if` conditions.
- When evidence is short, a variant with `"notClues": E` explains why only "destroy" is offered.
- The Silo must contain enough **optional** evidence (8 or more `clue_*`) that a thorough player who rushed Acts I–III can still reach `E`.

**Strings (new keys)**
- **Act titles:** `act5-title`, `act5-sub`, `act6-title`, `act6-sub`, `hollow-title`, `hollow-sub`
- **Locks and labels:** `gate-cloud-refuses`, `hatch-locked`, `hold-label`, `wave-label`
- **Overlays:** `memory-title`, `memory-sub`, `beacon-title`, `beacon-sub`
- **Guide:** `guide-on`, `guide-off`, `guide-hint` ("[G] Guide")
- **Reprogram:** `reprogram-locked`, `evidence-threshold`, `signal-reprogram-title`, `signal-reprogram-help`
- **Endings:** `ending-dawn-title`, `ending-dawn-sub`, `ending-quiet-title`, `ending-quiet-sub`, `credits` (one string; use `\n` for lines), `press-any-key`
- **Updates:** `clue-total` must be updated to the new total.

## 5. GameState additions (task U; others consume exactly this)

```js
GameState.leaveParty(id)        // emits 'party:changed'
GameState.clueCount()           // distinct clue_* flags
GameState.ending                // 'dawn' | 'quiet' | null (saved)
GameState.setEnding(kind)
GameState.guideEnabled          // bool, default true, saved
GameState.setGuideEnabled(bool) // emits 'guide:changed' (bool)
GameState.guidePath             // [{x,y}] simplified route, written by Guide (plain field, no event); [] when none
GameState.objectiveMarker()     // now supports marker arrays (nearest passing point)
GameState.questInfo()           // now supports {n:prefix/total}
```

**New events**
| Event | Payload |
|---|---|
| `guide:changed` | `(bool)` |
| `hold` | `({ id, progress 0..1, active })` |
| `wave` | `({ n })` |
| `memory-restore` | `()` |
| `beacon` | `()` |
| `signal:solved` | `({ mode })` (the payload is new) |

## 6. Systems modules (task T)

```js
// src/world/Guide.js
new Guide(scene, player, colliderRects, width, height)
  .update(time)      // A* on an 8 px grid (colliders inflated by the player's 16×10 body)
                     // → string-pulled path to GameState.objectiveMarker().
                     // Recompute every ~400 ms, or when the target changes or the player moves > 24 px.
                     // Blocked target cell → nearest walkable cell.
                     // Render gold additive breadcrumbs (fx-glow, tint #f0c060) every ~14 px:
                     //   from ~20 px ahead of the player to ~420 px along the path,
                     //   fading with distance, with a gentle "marching" pulse toward the target,
                     //   at depth just above the ground (−0.4).
                     // Hidden when there's no target, when GameState.guideEnabled is false, or while inputLocked.
                     // Writes GameState.guidePath.
  .refresh()         // force a recompute
  .destroy()

// src/world/Waves.js
new Waves(scene, crawlers, vents)
  .start({ interval = 6000, perWave = 3, maxAlive = 9, aggro = 400, tag = 'wave' })
  .stop()
  .update(time)      // spawn at random vents (prefer vents off-screen); GameState.emit('wave', { n })

// src/world/HoldPoint.js
new HoldPoint(scene, player, rect, { id, duration = 12000, onComplete })
  .update(time, delta) // progress while the player is inside, slow decay outside;
                       // emits 'hold' events; a pulsing cyan ring + 'relay' sprite; onComplete once
  .done

// src/systems/Cutscene.js — promise-based helpers; keeps GameState.inputLocked true for the whole sequence
const cs = new Cutscene(scene)
await cs.wait(ms)
await cs.moveTo(actor, x, y, speed = 60)    // walks with anims, no physics
await cs.dialogue(id)                       // resolves on dialogue:end
await cs.pan(x, y, ms); cs.follow(target)
await cs.fade('out'|'in', ms, [r, g, b])
cs.shake(ms, intensity); cs.flash(ms, [r, g, b])
cs.end()                                    // releases the lock

// Party (extend your M2 file)
party.detach(id)   // → the Follower, removed from the trail (the caller now owns it)
party.remove(id)   // destroys it
```

`tuning.json` gets `guide`, `waves` and `hold` sections.

## 7. UI (task S)

- **Minimap:** draw `GameState.guidePath` as a dotted gold line clipped to the circle. Add a small `[G] Guide` hint by the minimap, dimmed when the guide is off. Toast `guide-on`/`guide-off` on `guide:changed`.
- **Hold meter:** on the `hold` event, show a gold "HOLDING RELAY" meter at top-centre. It must not overlap the scan meter.
- **Wave label:** show `wave` events as a small label.
- **Memory overlay:** on `memory-restore`, a white bloom fading in, drifting light fragments, `memory-title` and `memory-sub`, lasting ~4.5 s.
- **Beacon alert:** on `beacon`, a red alert using `beacon-title` and `beacon-sub`. Reuse the alert overlay.
- **`SignalScene` reprogram mode:** accept launch data `{ mode }`.
  - `reprogram` mode: title `signal-reprogram-title`, 3 rounds with **drifting** targets and tighter tolerance.
  - Emit `signal:solved` with `{ mode }`.
  - Default mode is unchanged.
- **`EndingScene`** (new, key `'Ending'`):
  - Read `GameState.ending`.
  - Graded background: `map-village` warm sunrise with light rays for `dawn`; `map-village` blue night for `quiet`.
  - Show the title and sub.
  - Play the `ending-<kind>` dialogue (UI keeps running).
  - Then show stats (evidence `clueCount()/clue-total`, party, and the Mayor choice), roll the credits, and show `press-any-key`.
  - Any key → `GameState.clearSave()` → Menu.

## 8. Engine (task U)

**Every world scene**
- Instantiate `Guide`. **G** toggles `setGuideEnabled`.
- `objectiveMarker()` handles marker arrays, using the current map's markers.

**Wasteland**
- The exit (quest `cloud`) now goes to `Gate`.

**Gate (act IV)**
- **On enter:**
  - Set quest `gate`.
  - Show the `act4-title`/`act4-sub` title card, then `gate-intro`.
  - Show toxicity.
- **Cutscene trigger:** entering `approach` in stage `gate` runs dialogue `eli-scout`, whose event `eli-scout` starts the cutscene:
  1. Lock input and set quest `eli_scouts`.
  2. `party.detach('eli')`. Eli walks to `eli-enter` and fades into the cloud.
  3. Pan the camera to the arch and wait ~3 s; the cloud flickers (shake plus a white flash).
  4. Eli staggers out to `eli-collapse` and collapses, tinted silver.
  5. Dialogue `eli-dying`, whose `eli-dies` event:
     - triggers a silver `fx-silver` particle burst and an alpha dissolve;
     - calls `leaveParty('eli')` and sets `eli_gone`.
  6. Dialogue `eli-after`, which sets quest `eli_falls`.
  7. End the cutscene.
- **Arch:** `enter` in `eli_falls` → white fade (`fadeOut(1200, 255, 255, 255)`) → `Hollow`. In any other stage, toast `gate-cloud-refuses` at most every 3 s and nudge the player.

**Hollow (act IV)**
- **On enter:** quest `hollow`, `hollow-title`/`hollow-sub` card, `hollow-intro`, a white fade-in.
- **Ambience:** persistent drifting ash particles (`fx-ash`) over the screen and a dim, dark grade, darker than the map art alone.
- **Hatch:** inspecting the `hatch` with the `keycard` plays `inspect-hatch`, whose `enter-silo` event → fade → `Silo`. Without the keycard, toast `hatch-locked`.

**Silo (acts V → VI)**
- **On enter:** act V, quest `silo`, `act5-title`/`act5-sub` card, `silo-arrival`.
- **Archives:** archive terminals set flags `archive_history`, `archive_aegis` and `archive_villages` (via the story data effects). When all 3 are set, the quest becomes `remember`; let the story data drive this where possible.
- **Memory:** `memory` zone in stage `remember` → dialogue `memory` → event `memory-restore` → then `beacon-alarm`, whose `beacon` event:
  - sets act VI;
  - emits `beacon`;
  - starts the waves (vents);
  - sets quest `beacon`.
- **Core:** interacting with `core` runs dialogue `core`, which carries the choices.
- **Destroy path:** `furnace` zone in `destroy` → dialogue `furnace` → `ending-quiet` → `setEnding('quiet')` → fade → `Ending`.
- **Reprogram path:**
  - Create 3 `HoldPoint`s at `relays` while in stage `relays`. Each completion sets `relay_<n>`.
  - All 3 → quest `reprogram`.
  - Then `core` → `start-reprogram` → `Signal` `{ mode: 'reprogram' }`.
  - `signal:solved` with `{ mode: 'reprogram' }` → `ending-dawn` → `setEnding('dawn')` → `Ending`.
- **Waves** stop on either ending.

**Assets and flow**
- **Boot:**
  - Load `map-gate` and `map-hollow` (sizes from their JSON), the `scientist` sheet and portrait, `fx-silver`, `fx-ash`, `fx-memory`, and `relay` (24×40 × 4 frames).
  - Create the animation `relay-pulse`.
- **Dev params:** `?scene=Gate|Hollow|Silo|Ending`, `?ending=dawn|quiet`, `?clues=N` (sets N fake `clue_test_*` flags).
- **Remove the End stub.** Delete `EndScene.js`, or make it forward to `Ending`.

## 9. Assets (new)

| Key | File | Owner |
|---|---|---|
| `map-gate` | `assets/maps/gate.png` (1448 wide; height 1300–1800) | N |
| `map-hollow` | `assets/maps/hollow.png` (1448×1086) | O |
| `scientist` | `assets/characters/scientist.png` (sheet like the others: 32×48, 4×3) + `assets/portraits/scientist.png` (96×96) | Q |
| `relay` | `assets/creatures/relay.png` (24×40 × 4 frames: a pulsing cyan pylon) | Q |
| `fx-silver` | `assets/fx/fx-silver.png` (3×3) | Q |
| `fx-ash` | `assets/fx/fx-ash.png` (3×3, grey) | Q |
| `fx-memory` | `assets/fx/fx-memory.png` (16×4, a soft white streak) | Q |

## 10. File ownership (M3): one owner per file

| Task | Owns |
|---|---|
| **N — Gate map** | `tools/assets/gate.mjs`, `public/assets/maps/gate.png`, `src/data/maps/gate.json`, `tools/previews/gate*.png` |
| **O — Hollow map** | `tools/assets/hollow.mjs`, `public/assets/maps/hollow.png`, `src/data/maps/hollow.json`, `tools/previews/hollow*.png` |
| **P — Silo data + marker arrays** | `src/data/maps/silo.json`, `tools/assets/silo-check.mjs`, `tools/previews/silo-overlay.png`, plus **only the `markers` field** of `src/data/maps/village.json` and `src/data/maps/wasteland.json` |
| **Q — Sprites/FX** | `tools/assets/sprites-m3.mjs`, `public/assets/characters/scientist.png`, `public/assets/portraits/scientist.png`, `public/assets/creatures/relay.png`, `public/assets/fx/{fx-silver,fx-ash,fx-memory}.png`, `tools/previews/m3-sprites.png` |
| **R — Story** | `src/data/{dialogue,quests,items,strings,acts}.json`, `docs/STORY.md` |
| **S — UI** | `tools/assets/ui.mjs`, `public/assets/ui/*`, `src/ui/*`, `src/scenes/{UIScene,SignalScene,EndingScene}.js` |
| **T — Systems** | `src/world/{Guide,Waves,HoldPoint,Hazards,Crawlers,Drones,Party}.js`, `src/systems/{Cutscene,Survival,Combat}.js`, `src/entities/{Crawler,WardenDrone,Follower}.js`, `src/data/tuning.json` |
| **U — Engine** | `index.html`, `src/main.js`, `src/scenes/{BootScene,MenuScene,WorldScene,VillageScene,OutskirtsScene,WastelandScene,GateScene,HollowScene,SiloScene,EndScene}.js`, `src/systems/{GameState,Dialogue,devFlags,strings,sceneFlow}.js`, `src/entities/{Character,Player,NPC,Pickup}.js`, `src/world/{MapBuilder,Interactions,Barrier}.js` |

**Shared rules**
- `raw-assets/` is read-only.
- Only task U runs the project dev server, on port **5174**.
- Harness servers for other tasks run outside the project root, on ports 5175–5179.
- Playwright: `chromium.launch({ channel: 'chrome' })`. Hold keys for about 50 ms, because `JustDown` misses instant presses.
- **Image budget:** at most 25 Reads per agent, each at most 1000 px on its longest side. An earlier agent crashed from context overflow.

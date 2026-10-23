# THE NOMAD — Build Contract, Milestone 2 (Acts II–III)

This **extends** `docs/CONTRACT.md` (Milestone 1). Read both. Where they conflict, this file wins.
Do not edit either contract.

The project is already working: Milestone 1 (Village 07) is fully playable. **Read the existing code you're extending before changing it**, and keep the existing style: beginner-readable, small modules, brief comments on Phaser concepts.

Never run `npm install` or edit `package.json`.

---

## 0. What changes and why

1. **No more occluders.**
   - The rectangular "walk behind" overlays cut characters and pickups with hard edges. That's the bug the user reported.
   - New rule: every solid object's collider covers its **whole drawn footprint** (roof, canopy, awning, lamp head, etc.).
   - Characters are never drawn inside or behind map art. Standing south of an object reads as "in front of" it; standing north, the body sits above it.
   - All maps ship with `"occluders": []`.
   - Pickups sit in open ground, at least 20 px from any collider and at least 40 px from the map edge.
2. **Six acts.** A new transitional act is inserted so the lush village blends into the ruined city:

| Act | Title | Area (scene key) |
|---|---|---|
| I | The Forbidden Boundary | Village 07 (`Village`) — done |
| II | The Outskirts | The Outskirts (`Outskirts`) — **new**: meadow decaying into ash, Warden drones, meet Mira |
| III | The Journey of Six | The Ruined City (`Wasteland`) — Kael's fight, Nova, Ryn, Eli, the signal puzzle |
| IV | The White Cloud | Paradise Gate — future |
| V | The Truth Beneath | Silo 01 — future |
| VI | The Final Choice | Silo 01 — future |

3. **Scene flow:** `Village` → `Outskirts` → `Wasteland` → `End` (a stub that reads "Act IV coming next").
4. **New HUD:** a bottom-left circular **minimap** plus an **act trail**, supply counters, the party row, damage and toxicity feedback, and a Warden scan meter.

## 1. Map JSON schema v2 (`src/data/maps/<area>.json`)

All M1 fields still apply. These fields are new; every one of them is optional.

```json
{
  "image": "map-outskirts", "width": 1448, "height": 1600,
  "area": "The Outskirts",
  "spawn": { "x": 0, "y": 0, "facing": "down" },
  "colliders": [ { "x": 0, "y": 0, "w": 0, "h": 0, "note": "" } ],
  "occluders": [],
  "npcs": [ { "id": "mira", "sprite": "mira", "name": "Mira", "x": 0, "y": 0, "facing": "down", "dialogue": "mira", "wander": 0, "tint": null } ],
  "pickups": [ { "id": "os-satchel", "item": "crystal", "x": 0, "y": 0, "dialogue": "pickup-satchel", "requires": { "quest": "satchel" } } ],
  "inspectables": [ { "id": "milestone", "x": 0, "y": 0, "w": 0, "h": 0, "dialogue": "inspect-milestone" } ],
  "zones": [ { "id": "exit", "x": 0, "y": 0, "w": 0, "h": 0 } ],
  "hazards": [ { "type": "toxic", "x": 0, "y": 0, "w": 0, "h": 0 } ],
  "checkpoints": [ { "id": "os-cp-1", "x": 0, "y": 0, "w": 0, "h": 0, "respawn": { "x": 0, "y": 0 } } ],
  "drones": [ { "id": "d1", "speed": 40, "loop": true, "path": [ { "x": 0, "y": 0 }, { "x": 0, "y": 0 } ] } ],
  "crawlers": [ { "id": "c1", "x": 0, "y": 0, "count": 2, "radius": 60 } ],
  "markers": { "outskirts": { "x": 0, "y": 0 }, "satchel": { "x": 0, "y": 0 } }
}
```

- **`hazards[].type`** is `toxic` (raises toxicity), `corrupt` (damage over time) or `fire` (fast damage).
- **`pickups[].requires`** is an optional dialogue-style condition (`GameState.check`). While it fails, the pickup is hidden and can't be interacted with, and it's re-checked whenever the quest or flags change.
- **Pickup ids are globally unique.** Use a prefix: Village `vl-`, Outskirts `os-`, Wasteland `ws-`. The existing Village ids `journal` and `shard` stay as they are.
- **`checkpoints`:** entering one sets the respawn point and saves the game. The scene's spawn is always the first checkpoint.
- **`markers`** maps a quest stage to the minimap objective marker for that stage. A stage that isn't listed shows no marker.
- **`drones`** appear in the Outskirts only. Each drone patrols its waypoint path; with `loop: false` it ping-pongs back and forth.
- **`crawlers`** appear in the Wasteland only. Each entry is a roaming group of `count` crawlers wandering within `radius`.

## 2. Quest stages (quests.json; `{party}` is replaced with `N/5`)

**Village** (unchanged): `wake`, `explore`, `confront`, `bridge`, `crossed`. Crossing at the bridge now leads to the `Outskirts` scene.

**Outskirts**
| Stage | Meaning |
|---|---|
| `outskirts` | Set on entering when the quest is `crossed`. Follow the hum south, avoid the drones, find who's at the field station. |
| `satchel` | Mira asks you to recover her satchel (the `crystal`) from the toxic pools. |
| `to_city` | Mira has joined. Head south to the ruined city. The exit only works in this stage. |

**Wasteland**
| Stage | Meaning |
|---|---|
| `city` | Set on entering. Someone is fighting in the ruins. |
| `fight` | Kael's encounter is running. "[SPACE] to strike". |
| `survivors` | Kael has joined. Find the others; the objective uses `{party}`. |
| `signal` | Set automatically when the party has all 5 companions. Bring everyone to Ryn's rig. |
| `cloud` | The signal is solved. Head east toward the white cloud. The exit only works in this stage. |

## 3. Ids the story, maps and engine share

**Companions** are `mira`, `kael`, `nova`, `ryn` and `eli`. Each is an NPC id, a sprite key and a party id.

**Companion artifacts**
| Companion | Item | How you get it |
|---|---|---|
| mira | `crystal` | World pickup `os-satchel` |
| kael | `medallion` | `giveItems` in his dialogue |
| nova | `radio` | `giveItems` in her dialogue |
| ryn | `core` | `giveItems` in his dialogue |
| eli | `keycard` | `giveItems` in his dialogue |

**Supplies (consumables).** The `medkit`, `ration` and `water` ids are counted, not unique. `GameState.addItem` routes them into `supplies`.

**Dialogue ids, Outskirts**
- `outskirts-intro`, `mira`, `pickup-satchel`
- `inspect-milestone`, `inspect-deadtree`, `inspect-outpost`, `inspect-wreck`

**Dialogue ids, Wasteland**
- `wasteland-intro`, `kael-meet`, `kael`, `nova`, `ryn`, `eli`, `signal-solved`
- `inspect-bus`, `inspect-sinkhole`, `inspect-billboard`, `inspect-barrels`

**Dialogue ids, shared**
- Party chatter: `party-mira`, `party-kael`, `party-nova`, `party-ryn`, `party-eli`
- `respawn`: optional narration after you fall
- `end`: narration in the End scene

**Pickup dialogue.** Supply pickups may set `dialogue: null`, which shows a toast only.

**Inspectable ids**
- Outskirts: `milestone`, `deadtree`, `outpost`, `wreck`
- Wasteland: `bus`, `sinkhole`, `billboard`, `barrels`

**Zone ids**
- Outskirts: `exit` at the bottom road, plus `gate`, a strip just south of the bridge's top end that stops you walking back into the village.
- Wasteland: `encounter` (entering it while the quest is `city` starts Kael's fight), `rig` (Ryn's workbench area), and `exit` toward the white cloud.

**Dialogue `effects.event` values the engine handles**
| Event | What it does |
|---|---|
| `join:<id>` | The NPC leaves the world and becomes a follower; calls `GameState.joinParty(id)` |
| `heal-full` | Health back to max and toxicity to 0 |
| `start-fight` | Spawns Kael's crawlers |
| `start-signal` | Launches the `Signal` scene |

**Flags**
| Flag | Set by | When |
|---|---|---|
| `has_weapon` | `kael-meet` | Kael hands you a length of rebar |
| `kael_fight_won` | Engine | Kael's crawlers are all destroyed |
| `signal_solved` | Engine | The Signal scene is solved |
| `met_<id>` | Story data | First talk with a companion |

Existing M1 flags (`told_mayor_truth`, `clue_*`, …) stay valid.

## 4. GameState v2 (owner: task M; others consume exactly this)

All M1 members stay. New members:

```js
// acts & world
GameState.act                       // 'I'..'VI'
GameState.setAct(id)                // emits 'act:changed' (id)
GameState.world                     // { scene, mapKey, width, height, area } | null
GameState.setWorld(info)            // emits 'world:changed' (info)
GameState.playerPos                 // { x, y, facing }: plain field the world scene writes every frame (no event)
GameState.minimapPoints             // [{ x, y, kind: 'npc'|'companion'|'pickup' }]: written ~4×/s by the world scene (no event)
GameState.objectiveMarker()         // { x, y } | null, from the current map's markers[quest]
// party
GameState.party                     // copy of joined companion ids, in join order
GameState.inParty(id)
GameState.joinParty(id)             // emits 'party:changed' (partyArray)
// supplies
GameState.supplies                  // copy { medkit, ration, water }
GameState.addSupply(id, n = 1)      // emits 'supplies:changed' (supplies)
GameState.useSupply(id)             // → bool; emits 'supplies:changed'
// addItem(id) for medkit/ration/water calls addSupply and still emits 'item:added' (id)
// damage / healing
GameState.godMode                   // true with ?god=1: damage() is ignored
GameState.damage(amount, source)    // lowers health; emits 'damage' ({ amount, source })
GameState.heal(amount)
// checkpoints & save (localStorage key 'nomad-save-v1')
GameState.checkpoint                // { scene, x, y } | null
GameState.setCheckpoint(scene, x, y) // also calls save()
GameState.save(); GameState.hasSave(); GameState.loadSave() /* → bool */; GameState.clearSave()
```

- `questInfo()` must also substitute `{party}` with `${party.length}/5`.
- `reset()` clears all of the above.
- `act`, `world`, `party`, `supplies`, flags, inventory, quest, health, toxicity, showToxicity and checkpoint are all saved.

**New events on GameState**
- `act:changed`, `world:changed`, `party:changed`, `supplies:changed`
- `damage` ({ amount, source })
- `detection` (level 0..1): Warden scan progress, emitted by the drones while it's above 0, and once with 0 when it clears
- `respawn`
- `signal:solved`, `signal:cancelled`

## 5. Gameplay modules (owner: task L; the scenes in task M instantiate them)

Tunable numbers live in `src/data/tuning.json`, which task L owns. Each module's API:

```js
// src/world/Hazards.js
new Hazards(scene, hazardsArray)
  .typesAt(x, y)            // → Set of 'toxic' | 'corrupt' | 'fire' under the point
  .update(time, delta)      // ambient particles (bubbles, sparks, embers); subtle, since the map art already shows them

// src/systems/Survival.js
new Survival(scene, player, hazards, { onDeath })
  .update(time, delta)      // hazard ticks on the player's feet, toxicity decay (faster with nova in the party),
                            // health drain at toxicity 100, onDeath() exactly once when health reaches 0
  .hurt(amount, fromX, fromY) // contact damage: knockback via player.pushBack, about 0.8 s of i-frames with flicker; → false while invulnerable
  .reset()                  // clears i-frames and the death latch (after a respawn)

// src/world/Crawlers.js  (+ src/entities/Crawler.js)
new Crawlers(scene, player, colliders, survival)
  .spawn(x, y, { tag = null, radius = 60, aggro = 110 })  // → Crawler
  .spawnGroups(mapCrawlers)
  .hitArea(rect, damage = 1, fromX, fromY)  // → number hit; crawlers have 2 HP, flash and knock back, die in a nanite burst
  .count(tag)               // alive count (all if tag is omitted)
  .events                   // Phaser EventEmitter: 'killed' (crawler, tag)
  .update(time, delta)      // wander → chase within aggro → contact damage via survival.hurt;
                            // frozen while GameState.inputLocked

// src/systems/Combat.js
new Combat(scene, player, crawlers)
  .update(time)             // SPACE = strike, only with the has_weapon flag and when not inputLocked:
                            // ~26×22 hitbox in the facing direction, ~450 ms cooldown,
                            // fx-slash arc plus a small lunge tween

// src/world/Drones.js  (+ src/entities/WardenDrone.js)
new Drones(scene, player, mapDrones, colliders, { onCaught })
  .update(time, delta)      // hover along the path, sweep a vision cone (~95 px, ~50°) drawn as translucent cyan;
                            // colliders block line of sight;
                            // inside the cone, detection fills over ~0.7 s (emit 'detection'),
                            // when full → onCaught() once
  .setEnabled(bool)         // off while inputLocked / after a catch

// src/world/Party.js  (+ src/entities/Follower.js, which extends entities/Character.js)
new Party(scene, player)    // spawns followers for GameState.party behind the player
  .add(id, x, y)            // a newly joined member appears at (x, y) and falls in line
  .members                  // follower sprites, each with .companionId (interactable: dialogue 'party-<id>')
  .update(time)             // trail the player's path history (~18 px apart), walk/idle anims, depth = y, no collisions
  .teleportToPlayer()
```

- The drones never damage the player. A catch is a "herd": the scene fades out and puts you back at the last checkpoint (AEGIS can't harm humans).
- Kael fights alongside you in the scene script (task M): every ~1.4 s he hits any `kael`-tagged crawler within ~44 px of him, using `crawlers.hitArea`.

## 6. Assets (new)

**Maps**
- `map-outskirts` → `assets/maps/outskirts.png`. Its size is given in `outskirts.json` (1448 wide; height 1400–2000). Task G.

**Creatures** (task I)
| Key | File | Frames | Animations |
|---|---|---|---|
| `drone` | `assets/creatures/drone.png` | 32×32, 4 (hover bob, eye pulse) | `drone-hover` |
| `crawler` | `assets/creatures/crawler.png` | 32×24, 6 (0–3 scuttle, 4–5 hurt) | `crawler-walk`, `crawler-hurt` |

Boot (task M) creates these animations.

**FX images** (task I), at `assets/fx/<name>.png`
| Key | Size | Notes |
|---|---|---|
| `fx-spark` | 4×4 | |
| `fx-bubble` | 6×6 | green |
| `fx-ember` | 3×3 | orange |
| `fx-nanite` | 2×2 | magenta |
| `fx-slash` | 28×28 | white arc |
| `fx-glow` | 32×32 | soft radial white, for additive glows |
| `fx-cone` | 64×64 | optional soft gradient wedge |

**UI** (task K): `ui-minimap-frame` (the circular compass frame cleaned from the UI sheet, interior transparent), plus anything else task K needs. Loaded via `preloadUI`.

## 7. UI behaviour (task K)

**Minimap**
- Bottom-left at about (16, 720−16−size), roughly 170 px, using `ui-minimap-frame`.
- Inside a circular mask, it shows the current `world.mapKey` texture scaled about 0.16–0.2 and centred on `GameState.playerPos`.
- It draws:
  - the player as a cyan arrow, rotated by facing
  - `objectiveMarker()` as a pulsing yellow diamond, clamped to the rim when it's off-range
  - `minimapPoints`: npc dots in cream, companion dots in green, pickup dots in orange
- It updates in `update()`, rebuilds on `world:changed`, and is hidden when `world` is null (menu).

**Act trail**
- Under or next to the minimap: six pips I–VI with connectors.
- Past acts are filled orange, the current act is glowing cyan, and future acts are dim.
- Add a label such as "ACT II · THE OUTSKIRTS".
- It reads `src/data/acts.json` (task J) and updates on `act:changed`.

**Supplies**: next to the health bar, three icons with counts and key hints: `[H]` medkit, `[R]` ration, `[T]` water.

**Party row**: under the quest tracker, small portraits (`portrait-<id>`) of joined companions in join order. On `party:changed`, play a pop-in and toast "<Name> joined the party".

**Feedback effects**
- `damage`: a red edge flash.
- Toxicity ≥ 60: a pulsing green vignette whose strength scales with toxicity.
- `detection` > 0: a cyan "WARDEN SCAN" meter at top-centre.
- `respawn`: a short fade/text if useful.

**`Signal` scene** (`src/scenes/SignalScene.js`, key `'Signal'`): a self-contained mini-game drawn above everything.
- An oscilloscope panel in the UI palette, with the 6 artifact icons around it (shard, crystal, medallion, radio, core, keycard).
- Three rounds. In each, a target waveform is shown and the player tunes their own wave with **A/D (frequency)** and **W/S (amplitude)**, then presses **E** to lock it when it's within tolerance. Two artifact icons light up per round.
- On success: `GameState.setFlag('signal_solved')`, emit `signal:solved`, then stop itself.
- **ESC** emits `signal:cancelled` and stops.
- While it's open, `GameState.inputLocked` stays true. The scene sets it on create and clears it on stop.

## 8. Engine rules (task M)

**World scenes share `src/scenes/WorldScene.js`.** `Village`, `Outskirts` and `Wasteland` all extend this base class. It provides:
- map, player, NPCs, pickups (with `requires`) and inspectables
- interactions, including party members
- party, hazards and survival
- H/R/T supply keys: medkit +50 health, ration +20 health, water −40 toxicity, with a toast if you have none
- combat (only once `has_weapon` is set)
- checkpoints, autosave, and death → respawn at the checkpoint with health 60 and toxicity 0
- `setAct` / `setWorld`, and writing `playerPos` / `minimapPoints`
- dialogue events (`join:<id>`, `heal-full`)
- clean shutdown, with every GameState listener removed

**Village**
- Same behaviour as before, minus occluders.
- The exit now starts `Outskirts`.
- Act `I`.

**Outskirts** (act `II`)
- On entering: if the quest is `crossed`, set it to `outskirts`. Show the `act2-title`/`act2-sub` title card, then the `outskirts-intro` dialogue. Call `setShowToxicity(true)`.
- Drones: a catch fades out, plays the `drone-caught` strings, and respawns you at the checkpoint. It's not a death.
- The `gate` zone pushes the player back south, with toast `gate-sealed`.
- The `exit` zone, while the quest is `to_city`: fade, then `Wasteland`. In any other stage, show the `exit-locked-outskirts` toast at most every 3 s and nudge the player back.

**Wasteland** (act `III`)
- On entering: set the quest to `city`, show the `act3-title`/`act3-sub` title card, then the `wasteland-intro` dialogue.
- Crawler groups spawn from the map data, but **not within 160 px of the spawn point or of any NPC**.
- **Kael's fight**
  1. Entering the `encounter` zone while the quest is `city` starts dialogue `kael-meet`. Its effects set `has_weapon` and fire `event start-fight`.
  2. `start-fight` sets the quest to `fight` and spawns 3 `kael`-tagged crawlers about 80 px from Kael. Kael helps (see §5).
  3. When the last of them dies, set `kael_fight_won` and start dialogue `kael`. Its effects fire `join:kael` and `giveItems medallion`, and set the quest to `survivors`.
- Nova, Ryn and Eli each join through their own dialogue.
- When `party.length === 5`, set the quest to `signal`.
- **The rig**: talking to Ryn's rig, or to Ryn himself (he's a follower by then), while the quest is `signal` starts dialogue `ryn`, whose variant fires `event start-signal`. On `signal:solved`, start dialogue `signal-solved`, whose effects set the quest to `cloud`.
- The `exit` while the quest is `cloud` leads to `End`. In any other stage, toast `exit-locked-wasteland`.

**End**
- Title `act4-title`/`act4-sub` plus "coming next".
- A summary: evidence found (count of `clue_*` flags /9), your party, and the truth/lie choice.
- Then the `end` dialogue.
- Any key returns to the Menu.

**Menu**
- If `GameState.hasSave()`, show **CONTINUE** and **NEW GAME**: W/S to select, E/ENTER/SPACE to confirm.
- Continue → `loadSave()`, then start the saved scene at the checkpoint.
- New game → `clearSave()` then `reset()`.

**Dev URL params**
- `?scene=Village|Outskirts|Wasteland|End`
- `?quest=<stage>`
- `?party=mira,kael`
- `?flags=a,b`
- `?give=crystal,medkit`
- `?god=1`
- `?skipIntro=1`, which skips title cards and intro dialogues in every scene
- `?debug=1`

With `?scene`, Boot calls `reset()`, then applies the params, then starts that scene.

## 9. File ownership (Milestone 2): one owner per file

| Task | Owns |
|---|---|
| **F — Village fix** | `src/data/maps/village.json`, `tools/assets/maps.mjs`, `tools/previews/village-overlay.png` |
| **G — Outskirts map** | `tools/assets/outskirts.mjs`, `public/assets/maps/outskirts.png`, `src/data/maps/outskirts.json`, `tools/previews/outskirts*.png` |
| **H — Wasteland data** | `src/data/maps/wasteland.json`, `tools/assets/wasteland-check.mjs`, `tools/previews/wasteland-overlay.png` |
| **I — Creatures & FX** | `tools/assets/creatures.mjs`, `public/assets/creatures/*`, `public/assets/fx/*`, `tools/previews/creatures.png` |
| **J — Story** | `src/data/{dialogue,quests,items,strings,acts}.json`, `docs/STORY.md` |
| **K — UI** | `tools/assets/ui.mjs`, `public/assets/ui/*`, `src/ui/*`, `src/scenes/UIScene.js`, `src/scenes/SignalScene.js`, `tools/previews/ui*.png` |
| **L — Gameplay systems** | `src/world/{Hazards,Crawlers,Drones,Party}.js`, `src/entities/{Crawler,WardenDrone,Follower}.js`, `src/systems/{Survival,Combat}.js`, `src/data/tuning.json` |
| **M — Engine & scenes** | `index.html`, `src/main.js`, `src/scenes/{BootScene,MenuScene,WorldScene,VillageScene,OutskirtsScene,WastelandScene,EndScene}.js`, `src/systems/{GameState,Dialogue,devFlags,strings,sceneFlow}.js`, `src/entities/{Character,Player,NPC,Pickup}.js`, `src/world/{MapBuilder,Interactions,Barrier}.js` |

- `raw-assets/` is read-only. Scripts use `sharp` and run with `node tools/assets/<name>.mjs` from the project root.
- Only task M runs a dev server, on port **5174**, and it kills the server when done.
- Playwright: `chromium.launch({ channel: 'chrome' })`.
- Map overlay previews and reachability checks follow the M1 task C pattern; read `tools/assets/maps.mjs` for a working example.

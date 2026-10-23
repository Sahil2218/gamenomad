# THE PARADISE SIGNAL — Story Bible

A post-apocalyptic mystery: the jailer is the guardian, and "Paradise" is the trap.

## The six acts

1. **The Forbidden Boundary (Village 07).** A gentle village with one rule: never cross the boundary. Tobin crossed last winter and vanished. The sleepless Nomad gathers Tobin's journal, his map (left with Hessa) and a humming shard, confronts the Mayor, and slips through the flickering barrier at the old bridge: ROGUE HUMAN DETECTED.
2. **The Outskirts.** The meadow goes on past the bridge, then wears thin into ash. White Warden drones sweep the grass; a catch carries you back, unhurt. **Mira** loses her satchel (the crystal) in the toxic pools, and joins once you recover it.
3. **The Journey of Six (the Ruined City).** **Kael** hands you rebar mid-fight, then joins with his medallion. **Nova** (radio, full heal), **Ryn** (core) and **Eli** (keycard 01) join in any order. Ryn's rig tunes the six artifacts into one chord: the heading points east, to a wall of white.
4. **The White Cloud (Paradise Gate → Inside the Cloud).** A glowing arch reads PARADISE. Eli scouts alone and staggers back bleeding silver: "There is no Paradise. Don't go inside. Please..." He dies, made, not born. Ryn blames the Wardens; Mira keeps his card. Inside: black sky, ash, a dead estate. Eli's card opens hatch 01.
5. **The Truth Beneath (Silo 01).** Ten thousand people underground for generations, one of 51 silos. Dr. Maren Hale opens the archives: the runaway swarm, Project AEGIS (the Wardens), and relocation with memory suppression. In the memory chamber the five remember they were born here.
6. **The Final Choice (Silo 01).** The memories wake the artifacts: dormant swarm code that lured them home and now beacons the silo. The swarm pours through the vents. At the AEGIS core: **Destroy** the artifacts, or **Reprogram** the signal (needs evidence).

**Naming:** Acts I–IV foreshadow and never name AEGIS, silos or nanites (the hatch may show "01"). Act V+ names them freely; the Warden's voice speaks as **AEGIS** from the alarm on. "NPC" is never used in-world.

## Acts II–III beats (built, validated)

- Drones herd, never harm. Companions join via their artifact (`join:<id>`); Ryn's rig fires `start-signal`; `signal-solved` → `cloud`. Inspectables and the first chatter variant yield clues.

## Act IV beats

- `gate-intro`: the ash plain, the breathing white, the arch. Inspects: `inspect-arch` (PARADISE, then empty bolt holes: letters that fell), `inspect-cloudwall` (motes turning in step, gentle as the blue wall: built), `inspect-pilgrims` (prints go in; only drone skids come out).
- `eli-scout` (`approach`, stage `gate`): "If it's safe, I'll call." → `eli-scout`. `eli-dying`: silver blood (callback to the bloodless cut), "I was made to walk with you... never by force", Nova finds no pulse → `eli-dies`. `eli-after`: silver dust drifts into the white; Mira: "Made, not born... Who?"; Ryn: "It's the Wardens. They'd say anything to keep us out."; Mira keeps card 01 → `eli_falls`.
- `hollow-intro`: "So this is Paradise." `inspect-estates` (PARADISE ESTATES, SAFE BELOW THE STORM, GATE 01), `inspect-shrine` (offerings; TOBIN · 07 · I MADE IT), `inspect-drone-husk` (a Warden torn open facing outward, arms wide: a guard, not a jailer). `inspect-hatch` with the keycard (Tamsin's "zero... one" if heard) → `enter-silo`.

## Act V beats

- `silo-arrival`: Tamsin's metal stairs, the sinkhole's bread smell, astonished residents, SILO 01 · POPULATION 10,000 · ONE OF 51.
- `scientist` (Dr. Maren Hale, Ward's last student): intro sets `met_scientist` and unlocks the terminals (`archives`). They read "LOCKED" before that. In `archives`/`remember`/`beacon` she offers side-questions: `scientist-eli` (a Construct, Unit 01, who walked with the relocated), `scientist-tobin` (carried out alive, now in Village 19 growing beans), `scientist-ward` (the no-harm law, and her guilt at signing each relocation). In `remember` she sends you to the memory chamber.
- Archives: `archive-history` (mending machines decided we were the damage), `archive-aegis` (Ward's counter-swarm converts nanites, reclaims land a step a year: the green line; the Wardens ARE AEGIS; never harm a human), `archive-villages` (chosen families carried up; memories quieted to spare grief and hide the way home). Each read sets `archive_*` and a clue. The third read sets `remember`. A second read shows an appendix (lost silos 14/33; the white wall blinds the swarm; your relocation roll, bunk 114).
- Residents (`resident-1..3`): Wren (child; school map of green dots), Odile (baker; her brother chosen at seven), Garrow (hatch watch; Kael's red scarf). Inspects: `inspect-bunks` (CHOSEN row; bunk 114's sky drawing, yours once you remember), `inspect-reactor` (seeds like Ryn's core; SEED 4 sent to Silo 14), `inspect-mural` (Dr. Ansel Ward: Ward → Wardens).
- `memory`: Mira (school wall map), Kael (medallion = security tag; he held hatch 01), Nova (the bedtime broadcast), Ryn (reactor seed), You (seven, carried up the stairs; the shard was never yours) → `memory-restore`. The engine then plays `beacon-alarm`.

## Act VI beats

- `beacon-alarm` (gated on `beacon_sounded`, so a replay is harmless): AEGIS traces the signal to the chamber. Hale: dormant swarm code planted in salvaged tech, woken by minds that remember home. Mira: "It never wanted us dead. It wanted us to walk home." → `beacon`.
- `core` (stage `beacon`): with clues ≥ E, Ryn can read how it was built: **Rewrite the signal** (`choose-reprogram`), **Destroy the artifacts** (`choose-destroy`), or **Not yet**. Below E, Ryn can't rewrite what he can't read: destroy or "Not yet" (optional Silo clues stay open during the alarm). In `reprogram` it briefs then fires `start-reprogram` (retry line after `reprogram_briefed`).
- `furnace` (stage `destroy`): crystal, medallion, radio, core, and the shard last → `ending-quiet`. `relay` explains the rings; `reprogram-ready` plays when all three hold.

## Endings (played by the Ending scene)

- **Quiet** ("THE QUIET / NOTHING BUT A HUM"). The beacon dies; the swarm turns away blind. AEGIS seals Silo 01 and quiets the five again; Hale holds your hand. Village 07, morning, twelve lanterns, the rule. No hum under the floorboards, only in your chest. Beyond the blue wall a grey-coated stranger waves... Eli? Orrin greets you (truth) or tips his hat, relieved (lie).
- **Dawn** ("DAWN / THE BRIDGE BETWEEN"). AEGIS rides the rewritten signal down every swarm thread; the swarm burns white, the cloud lifts, dawn crosses the villages and the blue walls open. Orrin crosses the bridge first (truth) or keeps the rule one more morning (lie). Silo and villages meet; Tamsin walks down her stairs; the five are the bridge. On Eli's cairn Mira leaves card 01, and a Warden drone lands beside it, gently, and stays.

## Cast

- **The Nomad** (player): terse, watchful. Born in Silo 01, bunk 114; relocated at seven.
- **Village 07**: Orrin, Tamsin (stairs, door 01), Bram, Hessa, Pip. Tobin, the hook, is alive in Village 19.
- **The Warden / AEGIS**: CAPS status lines, calm care, never threatens.
- **Mira** (Researcher, Village 12): precise, wry; charts the green line. Crystal = a floor plan of the silo.
- **Kael** (Fighter): terse, protective. Medallion = his security tag; he held hatch 01.
- **Nova** (Healer): gentle; her radio catches the silo's bedtime lullaby.
- **Ryn** (Engineer): fast-talking tinkerer; core = a reactor seed lost en route to Silo 14.
- **Eli** (Outsider): AEGIS's Construct, Unit 01, made to walk with the relocated and keep them safe without force. Bleeds silver; dies at the gate.
- **Dr. Maren Hale** (portrait `scientist`): gentle, tired, guilty; last student of **Dr. Ansel Ward**, who built AEGIS.

## Resolved logic

- **Memory erasure.** A silo-born mind holds the way home and the swarm can read what it catches, so AEGIS quiets it. Hence 1,207 "returned" and nobody remembers anyone coming back.
- **The Warden can't stop you.** The no-harm law lets it only warn, wall and carry.
- **The white cloud** is AEGIS at its densest, blinding the swarm to the old city above Silo 01.
- **The artifacts** are silo things (tags, seeds, radios) from lost silos and lost travellers, rewritten by the swarm and planted where silo-born would find them. They wake only for Silo 01 minds; once those minds remember, they beacon. Eli's keycard is clean: real silo tech.
- **Reprogram needs evidence:** Ryn can only turn what the party understands.

## Evidence

`clue-total` = **52** distinct `clue_*`: Act I 9, Act II 6, Act III 9, Gate 4, Hollow 4, Silo 20 (3 mandatory archive reads + **17 optional**). `evidence-threshold` **E = 23** (44%), literal in `core`. A rushed Acts I–III run (lie, nothing optional) has 3; the mandatory `clue_silver_blood` and `clue_hatch_01` make 5; the archives make 8. A thorough Silo then reaches 25. 16 of the 17 optional Silo clues stay open during the alarm.

## Flags

- Engine: `village_intro_done`, `picked_<id>`, `kael_fight_won`, `signal_solved`, `eli_gone`, `memories_restored`, `relay_1..3`.
- Story: `met_mayor`, `hessa_gave_map`, `told_mayor_truth`, `lied_to_mayor`, `met_<companion>`, `has_weapon`, `ryn_rig_briefed`, `met_scientist`, `archive_history/aegis/villages` (counted by `{n:archive_/3}`), `beacon_sounded`, `reprogram_briefed`.
- Clues IV–V: Gate `clue_silver_blood`, `clue_arch_letters`, `clue_white_motes`, `clue_pilgrim_tracks`; Hollow `clue_estates_sign`, `clue_shrine_names`, `clue_drone_guard`, `clue_hatch_01`; archives `clue_runaway_swarm`, `clue_aegis_directive`, `clue_chosen_families`; plus the 17 optional Silo clues (residents, inspects, `core`, Hale's questions, archive appendices, chatter).

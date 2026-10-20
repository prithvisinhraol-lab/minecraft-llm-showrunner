# Compact FlameFrags Base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a safe, functional 90-by-90-block replica of FlameFrags' circular industrial base in the local Minecraft Java 1.21.4 Overworld.

**Architecture:** A deterministic Node.js generator will describe the build as block-placement commands, divide them into bounded datapack functions, and install the generated pack in the active world. The running server will reload the pack, execute the staged build, verify representative blocks and navigation, then save the world.

**Tech Stack:** Node.js 22, `node:test`, vanilla Minecraft Java 1.21.4 datapacks and server-console commands.

## Global Constraints

- Minecraft Java Edition 1.21.4 Overworld build.
- Approximate footprint: 90 by 90 blocks.
- Include one dominant central circular tower, three smaller ring-shaped satellite towers, and elevated connecting bridges.
- Use deepslate, blackstone, stone, tuff, iron-like highlights, dark red, copper, lava, and concealed warm lighting.
- Include compact enchanting, brewing, storage/work, and farm/utility rooms.
- Preserve terrain outside the selected footprint and blend the foundation into the site.
- Build functions must be bounded to avoid server stalls.
- Save the world after construction and report arrival coordinates.
- Use build origin `1200 90 1200`; inspect the footprint and stop if it contains a player structure.

---

### Task 1: Deterministic Geometry Generator

**Files:**
- Create: `src/flamefrags-base.mjs`
- Create: `test/flamefrags-base.test.mjs`

**Interfaces:**
- Produces: `circlePoints(cx, cz, radius)`, `ringCommands(cx, y, cz, radius, block)`, `towerCommands(spec)`, and `createBaseCommands(origin)`.
- `createBaseCommands({x:number,y:number,z:number})` returns `{commands:string[], landmarks:Record<string,{x:number,y:number,z:number}>}`.

- [ ] **Step 1: Write failing geometry tests**

Test that circles are symmetric, contain all four cardinal points, contain no duplicates, and that `createBaseCommands({x:0,y:80,z:0})` stays within x/z `-45..45` while exposing landmarks named `arrival`, `central`, `enchanting`, `brewing`, and `utility`.

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `node --test test/flamefrags-base.test.mjs`

Expected: FAIL because `src/flamefrags-base.mjs` does not exist.

- [ ] **Step 3: Implement geometry primitives**

Use midpoint-distance rasterization for filled disks and derive rings by subtracting the disk at `radius - thickness`. Deduplicate commands by absolute coordinate, reject coordinates beyond the 90-by-90 envelope, and return stable lexicographic command ordering for reproducible output.

- [ ] **Step 4: Implement the base shell**

Define the central tower at `(0,0)` with radius 18 and three satellites at `(-30,-22)`, `(30,-22)`, and `(0,32)` with radius 12. Generate foundations, hollow walls, floors, stepped roof rings, vertical ribs, windows, cardinal entrances, and three five-block-wide elevated bridges at y offsets 9 through 12.

- [ ] **Step 5: Run geometry tests**

Run: `node --test test/flamefrags-base.test.mjs`

Expected: PASS with zero duplicate coordinate/block-stage records and all landmarks inside the footprint.

- [ ] **Step 6: Commit generator geometry**

Run: `git add src/flamefrags-base.mjs test/flamefrags-base.test.mjs && git commit -m "Add FlameFrags base geometry generator"`

### Task 2: Palette, Interiors, and Safe Details

**Files:**
- Modify: `src/flamefrags-base.mjs`
- Modify: `test/flamefrags-base.test.mjs`

**Interfaces:**
- Consumes: deterministic tower geometry from Task 1.
- Produces: complete shell and interior command stream with safe lighting and traversal.

- [ ] **Step 1: Add failing content tests**

Assert that the generated commands include deepslate tiles, polished blackstone bricks, tuff bricks, iron bars, red nether bricks, oxidized copper, shroomlights, an enchanting table with 15 bookshelves, brewing stands, barrels, crafting stations, farmland, water, and bridge guardrails. Assert that no command places fire, lava, powder snow, or an unguarded drop on any marked walking surface.

- [ ] **Step 2: Run tests and confirm the new assertions fail**

Run: `node --test test/flamefrags-base.test.mjs`

Expected: FAIL on missing interior and palette commands.

- [ ] **Step 3: Add exterior detailing**

Add layered deepslate/blackstone walls, tuff ribs, light-gray iron accents, narrow red-nether-brick bands, copper vents, recessed orange stained glass, chains, and concealed shroomlights. Use campfires only behind barriers and use orange glass over magma for safe molten accents.

- [ ] **Step 4: Add compact functional rooms**

Place storage and crafting in the central tower, a level-30 enchanting layout in the northwest satellite, brewing stands and ingredient storage in the northeast satellite, and an enclosed hydrated crop plot in the south satellite. Add doors, stairs, bridge guardrails, and light level coverage to every walkable route.

- [ ] **Step 5: Run complete generator tests**

Run: `node --test test/flamefrags-base.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit visual and interior details**

Run: `git add src/flamefrags-base.mjs test/flamefrags-base.test.mjs && git commit -m "Detail compact FlameFrags base"`

### Task 3: Datapack Writer

**Files:**
- Create: `scripts/generate-flamefrags-base.mjs`
- Modify: `package.json`
- Modify: `test/flamefrags-base.test.mjs`
- Create: `server/world-1.21.4/datapacks/codex_flamefrags_base/pack.mcmeta`
- Create: generated files under `server/world-1.21.4/datapacks/codex_flamefrags_base/data/codex_flamefrags/function/build/`

**Interfaces:**
- Consumes: `createBaseCommands(origin)` from Task 2 and CLI arguments `--x`, `--y`, and `--z`.
- Produces: `start.mcfunction`, sequential `part_NNN.mcfunction` files of at most 800 commands each, and `finish.mcfunction`.

- [ ] **Step 1: Add failing chunking tests**

Assert that every generated part contains at most 800 commands, every part schedules exactly the next part after 2 ticks, the start function force-loads the footprint and invokes part 000, and the finish function announces completion without removing the force-load needed for later inspection.

- [ ] **Step 2: Run tests and confirm failure**

Run: `node --test test/flamefrags-base.test.mjs`

Expected: FAIL because the datapack writer is absent.

- [ ] **Step 3: Implement and expose the writer**

Add package scripts `"test": "node --test"` and `"generate-flamefrags-base": "node scripts/generate-flamefrags-base.mjs"`. Write pack format 61 metadata, create the function directory, remove only stale generated `part_*.mcfunction` files inside this pack, and write the new staged functions using `apply_patch` for source changes and the Node generator for bulk generated output.

- [ ] **Step 4: Generate the pack at the selected origin**

Run: `npm run generate-flamefrags-base -- --x 1200 --y 90 --z 1200`

Expected: summary reports the chosen origin, command count, part count, and footprint bounds.

- [ ] **Step 5: Validate generated functions**

Run: `node --test test/flamefrags-base.test.mjs && rg -n '^schedule function codex_flamefrags:build/part_' server/world-1.21.4/datapacks/codex_flamefrags_base/data/codex_flamefrags/function/build`

Expected: tests pass and each nonfinal part schedules its successor once.

- [ ] **Step 6: Commit datapack tooling and generated pack**

Run: `git add package.json src/flamefrags-base.mjs scripts/generate-flamefrags-base.mjs test/flamefrags-base.test.mjs server/world-1.21.4/datapacks/codex_flamefrags_base && git commit -m "Generate compact FlameFrags base datapack"`

### Task 4: Site Scouting and Live Construction

**Files:**
- Modify: active `server/world-1.21.4` world through server-console commands.

**Interfaces:**
- Consumes: running server console and generated `codex_flamefrags` datapack.
- Produces: constructed base at the chosen clear Overworld site.

- [ ] **Step 1: Confirm server state**

Inspect the server terminal, confirm version 1.21.4 and that no save or datapack errors are active. Start the server only if it is not running.

- [ ] **Step 2: Inspect the selected remote site**

Inspect the 90-by-90 footprint centered at `1200 90 1200`. Confirm it contains no player structures; stop rather than overwrite the site if it is occupied. The generated foundation may replace terrain only inside x/z `1155..1245`.

- [ ] **Step 3: Regenerate for the selected origin and reload**

Run `npm run generate-flamefrags-base -- --x 1200 --y 90 --z 1200`, issue `reload`, then confirm `datapack list enabled` includes `file/codex_flamefrags_base`.

- [ ] **Step 4: Execute the staged build**

Run `function codex_flamefrags:build/start`, monitor the server log until the completion announcement appears, and stop on any unknown block, syntax, or command-chain error.

- [ ] **Step 5: Save the completed world**

Run `save-all flush` and wait for the server to report the save completed.

### Task 5: Verification and Handoff

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: completed live build and landmark coordinates.
- Produces: verified world, documented arrival command, and user handoff.

- [ ] **Step 1: Verify representative blocks**

Use `execute if block` checks at the central roof, each satellite floor, all three bridge midpoints, the enchanting table, brewing stands, utility water source, and concealed lights. Each check must announce a positive result.

- [ ] **Step 2: Verify access and safety**

Teleport a player or bot to `arrival`, traverse the central entrance and bridges, confirm guardrails and doors are present, and check the interior for obvious dark or exposed hazard areas.

- [ ] **Step 3: Document the build**

Add a README section named `Compact FlameFrags Base` containing the chosen coordinates, `/tp` arrival command, Minecraft version, datapack function name, and regeneration command.

- [ ] **Step 4: Run final verification**

Run: `npm test`

Expected: all repository tests pass.

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 5: Commit verification documentation**

Run: `git add README.md && git commit -m "Document compact FlameFrags base"`

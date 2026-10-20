# Survival Demo In-Game Start Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wait with no Mineflayer actor connected, then launch one verified survival actor in the clearing only when `VPNAJ` says exact lowercase `start` in Minecraft.

**Architecture:** A read-only server-log gate observes new public-chat records and owns the one-shot lifecycle. On the accepted trigger it composes a Mineflayer host from the existing secure provider, persistent runner, evidence adapter, a bounded macro executor, and a village observer. Exact `stop` cancels and disconnects the active actor.

**Tech Stack:** Node.js 22 ESM, Mineflayer 4.37, mineflayer-pathfinder 2.4, Codex CLI structured output, `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-30-survival-demo-ingame-start-design.md`

## Global Constraints

- Minecraft Java and server protocol version are `1.21.4` unless `MC_VERSION` explicitly overrides them.
- Only exact username `VPNAJ` and exact lowercase messages `start` and `stop` control the gate.
- The gate starts at end-of-file and never replays historical chat.
- No Mineflayer actor connects before accepted `start`.
- The actor starts in the existing natural clearing and receives no village coordinates, materials, `/give`, or `/locate` results.
- The final line is exactly `This is gonna be great!!!` and is unavailable until all earlier proof gates pass.
- Automated tests run with `/opt/homebrew/opt/node@22/bin/node --test test/*.test.mjs` or a narrower explicit file list; never invoke bare `node --test`.
- Preserve unrelated untracked `node_modules/` and `runtime/` content.

---

### Task 1: Exact new-log start and stop gate

**Files:**
- Create: `src/llm-agent/survival-demo-log-gate.mjs`
- Test: `test/llm-agent-survival-demo-log-gate.test.mjs`

**Interfaces:**
- Consumes: `logPath`, `launch(): Promise<{ stop(reason): Promise<void>, close(): Promise<void>, completion: Promise<object> }>`.
- Produces: `createSurvivalDemoLogGate(options)` with `start(): Promise<void>`, `close(): Promise<void>`, and `status(): object`.
- Parses only vanilla public-chat lines matching `[time] [thread/INFO]: <username> message`.
- Test-local helpers in the same test file: `temporaryLog(t, initial)`, `appendChat(username, message)`, `eventually(assertion)`, `deferred()`, `controlledRun()`, and `startedGate(options)`; each helper owns and cleans up its temporary resources with `t.after`.

- [ ] **Step 1: Write the failing exact-trigger test**

```js
test('ignores history and launches once only for exact VPNAJ start', async (t) => {
  const log = await temporaryLog(t, '[12:00:00] [Server thread/INFO]: <VPNAJ> start\n');
  const launches = [];
  const gate = createSurvivalDemoLogGate({ logPath: log.path, launch: async () => fakeRun(launches) });
  await gate.start();
  await log.append('<Other> start');
  await log.append('<VPNAJ> Start');
  await log.append('<VPNAJ> start ');
  assert.equal(launches.length, 0);
  await log.append('<VPNAJ> start');
  await eventually(() => assert.equal(launches.length, 1));
  await log.append('<VPNAJ> start');
  assert.equal(launches.length, 1);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/llm-agent-survival-demo-log-gate.test.mjs`

Expected: `ERR_MODULE_NOT_FOUND` for `survival-demo-log-gate.mjs`.

- [ ] **Step 3: Implement incremental UTF-8 line reading from the initial EOF offset**

Implement strict `parsePublicChat(line)`, retain an incomplete trailing line between reads, serialize file-watch callbacks, suppress duplicate starts, and expose immutable status values `waiting`, `launching`, `running`, `stopped`, `completed`, or `failed`. Use `fs.watch` only as a wake-up signal and read explicit byte ranges so duplicated filesystem notifications cannot duplicate lines.

- [ ] **Step 4: Add failing lifecycle tests**

```js
test('exact VPNAJ stop cancels and closes the active run', async () => {
  const active = controlledRun();
  const gate = await startedGate({ launch: async () => active.host });
  await appendChat('VPNAJ', 'start');
  await active.launched;
  await appendChat('VPNAJ', 'stop');
  await eventually(() => assert.deepEqual(active.calls, ['stop:operator requested stop', 'close']));
});

test('close during launch cannot leave a late actor running', async () => {
  const launch = deferred();
  const gate = await startedGate({ launch: () => launch.promise });
  await appendChat('VPNAJ', 'start');
  const closing = gate.close();
  launch.resolve(controlledRun().host);
  await closing;
  assert.equal(gate.status().state, 'stopped');
});
```

- [ ] **Step 5: Implement stop, close, rotation/truncation failure, and launch cleanup**

Unknown log replacement, truncation below the current offset, read failure, or malformed internal state must fail closed with a stable error code. Ordinary non-chat lines are ignored.

- [ ] **Step 6: Run focused tests and commit**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/llm-agent-survival-demo-log-gate.test.mjs`

Commit: `git commit -m "feat: gate survival demo on exact game chat"`

---

### Task 2: Bounded live village observer

**Files:**
- Create: `src/llm-agent/survival-demo-village-observer.mjs`
- Test: `test/llm-agent-survival-demo-village-observer.test.mjs`

**Interfaces:**
- Consumes: live Mineflayer `bot`, optional `signal`, maximum radius fixed at 48 blocks.
- Produces: `createSurvivalDemoVillageObserver({ maximumDistance = 48 })`, returning `observe({ bot, signal }) -> { bell, beds, villagers }`.

- [ ] **Step 1: Write failing evidence tests**

```js
test('requires a local bell, bed, and live villager in the same bounded observation', async () => {
  const observer = createSurvivalDemoVillageObserver();
  const bot = villageBot({ blocks: ['bell', 'white_bed'], villagers: 1 });
  assert.deepEqual(await observer({ bot }), { bell: true, beds: 1, villagers: 1 });
  bot.entities = {};
  assert.deepEqual(await observer({ bot }), { bell: true, beds: 1, villagers: 0 });
});

test('never counts beds, bells, or villagers outside 48 blocks', async () => {
  const observer = createSurvivalDemoVillageObserver();
  assert.deepEqual(await observer({ bot: distantVillageBot(49) }), { bell: false, beds: 0, villagers: 0 });
});
```

- [ ] **Step 2: Verify RED**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/llm-agent-survival-demo-village-observer.test.mjs`

- [ ] **Step 3: Implement registry-driven block and entity inspection**

Resolve all `*_bed` block IDs from `bot.registry.blocksByName`, query bounded positions with `bot.findBlocks`, check live `villager` entities by Euclidean distance, deduplicate block positions, and reject aborted operations.

- [ ] **Step 4: Run focused tests and commit**

Commit: `git commit -m "feat: verify bounded live village evidence"`

---

### Task 3: Real survival macro executor

**Files:**
- Create: `src/llm-agent/survival-demo-macro-executor.mjs`
- Test: `test/llm-agent-survival-demo-macro-executor.test.mjs`

**Interfaces:**
- Consumes: `createSurvivalDemoMacroExecutor({ bot, goals, Movements, villageObserver, actionTimeoutMs = 45000 })`.
- Produces: `execute({ action, line? }, { signal }) -> trusted action-specific receipt`; `cancel()` stops pathfinding and digging.
- Receipts match `proofMatches` in `survival-demo-minecraft-adapter.mjs`.

- [ ] **Step 1: Write failing wood test**

```js
test('gather_wood pathfinds, digs, and counts only three normally collected oak logs', async () => {
  const setup = oakWorld();
  const executor = createSurvivalDemoMacroExecutor(setup.dependencies);
  assert.deepEqual(await executor.execute({ action: 'gather_wood' }), {
    action: 'gather_wood', brokenOakLogs: 3
  });
  assert.equal(setup.bot.inventoryCount('oak_log'), 3);
  assert.equal(setup.dug.every((block) => block.name === 'oak_log'), true);
});
```

- [ ] **Step 2: Verify RED, then implement bounded target revalidation and collection waiting**

Before every dig, re-read the block at its position and require `oak_log`. Use non-digging Pathfinder movement to approach it, then `bot.dig`. Count the log only after the live inventory increases. Stop after three or fail when the action deadline or search bound is exhausted.

- [ ] **Step 3: Write failing crafting-table test, then implement recipe and placement verification**

```js
test('craft_and_place_table uses owned logs, a live recipe, and solid clearing support', async () => {
  const setup = craftingWorld({ oakLogs: 3 });
  const executor = createSurvivalDemoMacroExecutor(setup.dependencies);
  const receipt = await executor.execute({ action: 'craft_and_place_table' });
  assert.deepEqual(receipt, { action: 'craft_and_place_table', placedCraftingTable: true });
  assert.equal(setup.blockAt(setup.placedPosition).name, 'crafting_table');
});
```

Craft planks and one table with `bot.recipesFor`/`bot.craft`; select a nearby passable cell over solid support; revalidate it; equip and place the table; prove the resulting live block.

- [ ] **Step 4: Write failing wooden-pickaxe test, then implement table-bound crafting and equip**

Require a live placed crafting table, craft missing planks/sticks through live recipes, craft exactly one wooden pickaxe, equip it to hand, and verify `bot.heldItem.name === 'wooden_pickaxe'`.

- [ ] **Step 5: Write failing stone test, then implement eight verified stone digs**

```js
test('mine_stone requires the wooden pickaxe and counts only inventory-confirmed cobblestone', async () => {
  const setup = stoneWorld({ held: 'wooden_pickaxe', stone: 8 });
  const executor = createSurvivalDemoMacroExecutor(setup.dependencies);
  const receipt = await executor.execute({ action: 'mine_stone' });
  assert.deepEqual(receipt, { action: 'mine_stone', minedStone: 8 });
  assert.equal(setup.bot.inventoryCount('cobblestone'), 8);
});
```

Reject other held tools, revalidate each `stone` block, and count only a corresponding cobblestone inventory delta.

- [ ] **Step 6: Write failing furnace test, then implement live recipe crafting**

Require at least eight owned cobblestone and the live crafting table, select a matching furnace recipe, craft once, and verify one furnace inventory increase.

- [ ] **Step 7: Write failing bounded village-search test, then implement deterministic exploration**

Search current evidence first. If incomplete, walk a fixed bounded sequence of observation points around the clearing using non-digging Pathfinder. Stop at the first observation containing bell, bed, and villager; approach the observed bell without exposing its coordinates to the LLM. Exhaustion returns `SURVIVAL_DEMO_VILLAGE_NOT_FOUND`.

- [ ] **Step 8: Write failing speech and cancellation tests, then implement exact speech**

```js
test('say_final_line sends only the controller supplied exact line', async () => {
  const { bot, dependencies } = speechWorld();
  const executor = createSurvivalDemoMacroExecutor(dependencies);
  await executor.execute({ action: 'say_final_line', line: 'This is gonna be great!!!' });
  assert.deepEqual(bot.chatCalls, ['This is gonna be great!!!']);
});

test('abort stops pathfinding and active digging without a success receipt', async () => {
  const controller = new AbortController();
  const { bot, dependencies } = pendingDigWorld();
  const executor = createSurvivalDemoMacroExecutor(dependencies);
  const pending = executor.execute({ action: 'mine_stone' }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'SURVIVAL_DEMO_ABORTED' });
  assert.equal(bot.pathfinder.stopped, true);
});
```

- [ ] **Step 9: Run macro and adapter regression tests and commit**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/llm-agent-survival-demo-macro-executor.test.mjs test/llm-agent-survival-demo-adapter.test.mjs`

Commit: `git commit -m "feat: execute bounded survival progression"`

---

### Task 4: Compose the delayed-connect live host

**Files:**
- Create: `src/llm-agent/survival-demo-live-host.mjs`
- Test: `test/llm-agent-survival-demo-live-host.test.mjs`
- Modify: `src/llm-agent/survival-demo-minecraft-adapter.mjs`
- Modify: `test/llm-agent-survival-demo-adapter.test.mjs`

**Interfaces:**
- Produces: `createSurvivalDemoLiveHost({ connection, actorId, stateDirectory, codexBin, clearingStart })`.
- Returned launch handle: `start(): Promise<object>`, `stop(reason): Promise<void>`, `close(): Promise<void>`, and `completion: Promise<object>`.

- [x] **Step 1: Write failing delayed-connect composition test**

```js
test('constructing the live host does not connect; start connects, places at clearing, and runs', async () => {
  const setup = compositionHarness();
  const host = createSurvivalDemoLiveHost(setup.options);
  assert.equal(setup.botFactory.calls.length, 0);
  const completion = host.start();
  assert.equal(setup.botFactory.calls.length, 1);
  await setup.spawnActor();
  assert.deepEqual(setup.clearingPlacement, ['LlmAgent']);
  await completion;
});
```

- [x] **Step 2: Verify RED, then implement lazy composition**

Only `start()` may call `mineflayer.createBot`. Load Pathfinder, wait for spawn with a deadline, construct the village observer, macro executor, evidence adapter, provider, store, and runner, place the actor at the configured clearing start through the trusted scene setup port, then invoke `runner.start()`.

- [x] **Step 3: Add death, disconnect, stop, and close tests**

Death or disconnect calls runner stop and closes the bot. `close()` is idempotent and awaits pending provider/action work before quitting. Remove all listeners during cleanup.

- [x] **Step 4: Tighten adapter lifecycle**

Add `close()` to remove its chat listener. Make `cancel()` idempotent while continuing to stop Pathfinder. Update its constructor tests to prove no listener leak.

- [x] **Step 5: Run host, adapter, runner, and store tests and commit**

Commit: `git commit -m "feat: compose delayed survival demo actor"`

---

### Task 5: CLI, configuration, and runnable command

**Files:**
- Create: `src/llm-agent/survival-demo-cli.mjs`
- Test: `test/llm-agent-survival-demo-cli.test.mjs`
- Modify: `package.json`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Adds `npm run survival-demo`.
- Defaults: log `server/logs/latest.log`, actor `LlmAgent`, state `runtime/survival-demo-state`, host `127.0.0.1`, port `25565`, version `1.21.4`.

- [x] **Step 1: Write failing CLI configuration test**

```js
test('starts only the external log gate and supplies a lazy actor launch function', async () => {
  const setup = cliHarness();
  const cli = await startSurvivalDemoCli(setup.options);
  assert.equal(setup.gateStarted, true);
  assert.equal(setup.botFactoryCalls, 0);
  await setup.triggerLaunch();
  assert.equal(setup.botFactoryCalls, 1);
  await cli.close();
});
```

- [x] **Step 2: Verify RED, then implement validated environment parsing and signals**

Resolve an executable Codex binary using the existing CLI policy, validate port/path/identity values, create the gate, and install idempotent `SIGINT`/`SIGTERM` shutdown. Print `WAITING: join as VPNAJ, then say start.` only after the watcher is active.

- [x] **Step 3: Add package script and exact operator documentation**

Add:

```json
"survival-demo": "env MC_VERSION=${MC_VERSION:-1.21.4} /opt/homebrew/opt/node@22/bin/node src/llm-agent/survival-demo-cli.mjs"
```

Document terminal commands and distinguish them from Minecraft chat:

```text
Terminal: npm run server
Terminal: npm run survival-demo
Minecraft chat (no slash): start
Minecraft chat emergency stop (no slash): stop
```

- [x] **Step 4: Run CLI tests and commit**

Commit: `git commit -m "feat: add survival demo launch command"`

---

### Task 6: Automated release verification

**Files:**
- Modify only files implicated by failures; do not weaken assertions.

- [x] **Step 1: Run every LLM-agent test**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/llm-agent-*.test.mjs`

Expected: zero failures and a final TAP summary.

- [x] **Step 2: Run the complete repository test suite**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/*.test.mjs`

Expected: zero failures. Diagnose each failure using the systematic-debugging workflow and re-run the narrow failing file before re-running the suite.

- [x] **Step 3: Audit prohibited shortcuts**

Run:

```bash
rg -n "/give|/locate|creative|setblock|spawn actor before|chat\(['\"]This is gonna be great" src/llm-agent/survival-demo-*.mjs
```

Expected: no gameplay shortcuts; the only final-line chat call is inside the gated `say_final_line` executor branch.

- [x] **Step 4: Commit any verification fixes**

Commit only if fixes were needed: `git commit -m "fix: close survival demo release blockers"`

---

### Task 7: Incremental real-world validation

**Files:**
- Create: `SURVIVAL_DEMO_FINDINGS.md`.
- Update: `SHOWRUNNER_RESUME.md` with exact current commands, state, and observed evidence.

- [ ] **Step 1: Verify the server and clearing without launching the actor**

Start `npm run server`, verify TCP `127.0.0.1:25565`, confirm `VPNAJ` can join, inspect the saved clearing landing/headroom, and record its trusted setup position. Do not start the agent.

- [ ] **Step 2: Validate the gate alone**

Start `npm run survival-demo`, verify no `LlmAgent` is online, try rejected variants, then say exact `start`. Confirm precisely one actor joins. Immediately say exact `stop`; confirm the actor leaves and persisted state is stopped.

- [ ] **Step 3: Reset deliberately and validate clearing wood only**

Use the explicit state reset workflow, run through `wood_collected`, stop, and inspect proof for three real breaks plus three inventory logs.

- [ ] **Step 4: Validate crafting and mining progression**

Run through `furnace_crafted`, verify the placed table in the world, equipped wooden pickaxe, eight real stone digs, cobblestone inventory, and furnace inventory. Stop before village search.

- [ ] **Step 5: Validate bounded village discovery**

Confirm a real village exists within the configured search envelope without disclosing its coordinates to the model. Run village discovery, verify bell, bed, and villager evidence, then stop before speech.

- [ ] **Step 6: Perform one complete rehearsal**

Reset, say exact `start`, and allow all seven milestones. Confirm the final line appears once, after village proof, from `LlmAgent`. Confirm terminal state `succeeded` and actor cleanup.

- [ ] **Step 7: Save findings and continuation state**

Record commands, commit hash, test counts, proof sequence, any measured timing, and any remaining filming risks. Do not label the scene filming-ready unless the complete rehearsal passes.

- [ ] **Step 8: Commit validation documentation**

Commit: `git commit -m "docs: record survival demo live validation"`

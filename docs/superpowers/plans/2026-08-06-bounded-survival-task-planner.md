# Bounded Survival Task Planner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic, bounded Survival task planner and genuine Mineflayer action execution for the First Day in the Meadow episode.

**Architecture:** Keep planning pure and separate from Mineflayer side effects. Trusted resolvers issue fenced receipts for targets and recipes; a reservation ledger prevents actor contention; the existing actor runtime executes typed actions and emits authoritative proof; a Survival coordinator advances goals only after verified observations. This plan produces a complete core and integration harness. A separate live-host plan will connect it to real bot accounts, the server, and capture acceptance.

**Tech Stack:** Node.js 22, ECMAScript modules, Mineflayer, mineflayer-pathfinder, vec3, YAML, Node.js built-in test runner

## Global Constraints

- Minecraft and protocol target: Java 1.21.4.
- Actors remain non-operator Survival players.
- No generated JavaScript, shell commands, Minecraft slash commands, direct world edits, item grants, teleports around failures, or game-mode changes.
- Runtime actions are limited to `moveNearTarget`, `lookAtTarget`, `digTarget`, `collectItem`, `craftRecipe`, `placeAtMark`, `equipItem`, and `observeSurvival`.
- Every destructive target is authorized by a trusted receipt bound to production, take, attempt, goal, actor, coordinates, block type, observation version, and expiry.
- Every action follows `prepare -> execute -> observe -> confirm`; a resolved Mineflayer promise is not authoritative proof.
- Identical goal, observation, and reservation inputs produce the same planner decision.
- Dialogue remains signed and may occur only at authored safe boundaries.
- Run focused tests with `node --test test/<file>.test.mjs`; run the full suite with `node --test test/*.test.mjs`.

---

### Task 1: Survival goal schema and executable meadow source

**Files:**
- Create: `src/showrunner/survival-schema.mjs`
- Create: `test/showrunner-survival-schema.test.mjs`
- Create: `production/episodes/first-day-meadow.survival.yaml`

**Interfaces:**
- Produces: `loadSurvivalEpisode(sourcePath): Promise<Readonly<SurvivalEpisode>>`
- Produces: normalized goals with `{ id, actor, kind, region?, mark?, item?, block?, recipe?, count, timeoutMs, maxReplans, completion }`
- Consumes later: `createSurvivalCoordinator` in Task 5

The loader must expose this exact entry point and constants:

```js
export const SURVIVAL_GOAL_KINDS = Object.freeze(['gather', 'craft', 'place', 'equip', 'excavate', 'regroup']);
export async function loadSurvivalEpisode(sourcePath) {
  const source = await readFile(sourcePath, 'utf8');
  return normalizeSurvivalEpisode(parseDocument(source).toJS(), { sourcePath, source });
}
```

- [ ] Write failing tests that accept the six meadow beats and reject unknown goal kinds, actors, fields, blocks, recipes, marks, predicates, zero/oversized counts, missing regions, and excavation outside an approved volume.
- [ ] Run `node --test test/showrunner-survival-schema.test.mjs`; expect failures because the module and episode do not exist.
- [ ] Implement an exact-key YAML loader with line/column errors, deep-frozen output, schema version `1`, goal kinds `gather|craft|place|equip|excavate|regroup`, maximum count `64`, maximum replans `5`, and maximum timeout `120000` milliseconds.
- [ ] Author `first-day-meadow.survival.yaml` with six ordered beats, separate tree regions, one crafting mark, one two-wide excavation volume, safe dialogue boundaries, and completion predicates for three logs per actor, two wooden pickaxes, a placed table, and eleven combined cobblestone.
- [ ] Run the focused test; expect all schema tests to pass.
- [ ] Commit with `git add src/showrunner/survival-schema.mjs test/showrunner-survival-schema.test.mjs production/episodes/first-day-meadow.survival.yaml && git commit -m "feat: define bounded survival episodes"`.

### Task 2: Trusted receipts and contention-free reservations

**Files:**
- Create: `src/showrunner/survival-authority.mjs`
- Create: `test/showrunner-survival-authority.test.mjs`

**Interfaces:**
- Produces: `createSurvivalAuthority({ clock, signingKey, maxReceiptAgeMs })`
- Produces methods: `issueTargetReceipt(input)`, `issueItemReceipt(input)`, `issueRecipeReceipt(input)`, `verifyReceipt(receipt, expected)`, `reserve(receipt, actorId)`, `release(receiptId, reason)`, and `snapshotReservations()`
- Receipt identity: `{ receiptId, kind, productionId, takeId, attemptId, goalId, actorId, observationVersion, expiresAt, payload, signature }`

The public factory must return only the bounded authority surface:

```js
export function createSurvivalAuthority({ clock, signingKey, maxReceiptAgeMs = 5000 }) {
  return Object.freeze({
    issueTargetReceipt,
    issueItemReceipt,
    issueRecipeReceipt,
    verifyReceipt,
    reserve,
    release,
    snapshotReservations
  });
}
```

- [ ] Write failing tests for deterministic candidate ordering, signature verification, actor/attempt/goal mismatch, expiry, world-version mismatch, mutation after signing, duplicate reservation, release, cancellation cleanup, and immutable snapshots.
- [ ] Run `node --test test/showrunner-survival-authority.test.mjs`; expect module-not-found failure.
- [ ] Implement canonical JSON signing with Ed25519, defensive JSON cloning, stable sort by path cost then distance then `x/y/z`, exclusive reservation keys, and bounded receipt age between `100` and `30000` milliseconds.
- [ ] Run the focused test; expect all authority tests to pass.
- [ ] Commit with `git add src/showrunner/survival-authority.mjs test/showrunner-survival-authority.test.mjs && git commit -m "feat: authorize survival targets and reservations"`.

### Task 3: Pure deterministic Survival planner

**Files:**
- Create: `src/showrunner/survival-planner.mjs`
- Create: `test/showrunner-survival-planner.test.mjs`

**Interfaces:**
- Produces: `planSurvivalStep({ goal, observation, reservations }): Readonly<PlannerDecision>`
- Decision union: `{ status: 'action', action, reason, observationVersion } | { status: 'completed', reason, observationVersion } | { status: 'blocked', reason, observationVersion }`
- Action union uses only the eight action names in Global Constraints and JSON-safe payloads.

Use one exported pure function and freeze every result:

```js
export function planSurvivalStep({ goal, observation, reservations }) {
  validatePlannerInput(goal, observation, reservations);
  if (completionSatisfied(goal.completion, observation)) {
    return Object.freeze({ status: 'completed', reason: 'GOAL_SATISFIED', observationVersion: observation.version });
  }
  return Object.freeze(nextAction(goal, observation, reservations));
}
```

- [ ] Write failing table-driven tests for gathering, drop collection, regrouping, plank/stick/table/pickaxe recipe dependencies, table placement, equipping, excavation, exact completion, missing materials, stale observations, exhausted replans, and identical-input determinism.
- [ ] Run `node --test test/showrunner-survival-planner.test.mjs`; expect module-not-found failure.
- [ ] Implement a pure planner with a fixed dependency graph: `oak_log -> oak_planks`, `oak_planks -> stick`, `oak_planks -> crafting_table`, and `oak_planks + stick + crafting_table -> wooden_pickaxe`. Return stable reason codes and never access Mineflayer, the filesystem, environment variables, time, or randomness.
- [ ] Run the focused test twice; expect identical passing results.
- [ ] Commit with `git add src/showrunner/survival-planner.mjs test/showrunner-survival-planner.test.mjs && git commit -m "feat: add deterministic survival planner"`.

### Task 4: Genuine typed actions in the actor runtime

**Files:**
- Modify: `src/showrunner/actor-runtime.mjs`
- Modify: `test/showrunner-actor-runtime.test.mjs`

**Interfaces:**
- Extends `createActorRuntime({ ..., survivalAuthority, survivalObserver })`
- Extends `execute(command, sink)` with the eight typed Survival actions.
- Proofs include `{ kind, authoritative: true, actor, goalId, observationVersion, before, after }`.

Dispatch must remain an explicit allowlist rather than dynamic method lookup:

```js
const SURVIVAL_ACTIONS = new Set([
  'moveNearTarget', 'lookAtTarget', 'digTarget', 'collectItem',
  'craftRecipe', 'placeAtMark', 'equipItem', 'observeSurvival'
]);

if (SURVIVAL_ACTIONS.has(action)) {
  return executeSurvivalAction({ action, validated, command, sink, token });
}
```

- [ ] Add failing fake-Mineflayer tests proving valid digging, real drop collection, recipe crafting, table placement, equipping, and normalized Survival observation.
- [ ] Add failing safety tests proving rejection of raw coordinates, stale/forged receipts, wrong actors, wrong blocks, out-of-volume excavation, mismatched inventory deltas, duplicate execution, timeout, and late completion after cancellation.
- [ ] Run `node --test test/showrunner-actor-runtime.test.mjs`; expect the new cases to fail while existing cases remain green.
- [ ] Extend command validation to require verified receipts before any destructive or inventory action. Clone all verified values before awaiting.
- [ ] Implement one bounded operation per action using `bot.pathfinder.goto`, `bot.lookAt`, `bot.dig`, item-entity collection, `bot.recipesFor`/`bot.craft`, `bot.placeBlock`, and `bot.equip`.
- [ ] After each operation, request a fresh `survivalObserver.observe(...)` receipt and compare block, item, inventory, placement, or equipment deltas before emitting `observationVerified`.
- [ ] Extend cancellation to stop digging, close the active window when supported, clear controls, release actor reservations, fence late results, and prove quiescence.
- [ ] Run the focused test; expect all actor-runtime tests to pass.
- [ ] Commit with `git add src/showrunner/actor-runtime.mjs test/showrunner-actor-runtime.test.mjs && git commit -m "feat: execute verified survival actions"`.

### Task 5: Goal coordinator and dialogue-safe boundaries

**Files:**
- Create: `src/showrunner/survival-coordinator.mjs`
- Create: `test/showrunner-survival-coordinator.test.mjs`
- Modify: `src/showrunner/state-machine.mjs`
- Modify: `test/showrunner-state-machine.test.mjs`

**Interfaces:**
- Produces: `createSurvivalCoordinator({ episode, planner, authority, actors, emit, clock })`
- Produces methods: `start(identity)`, `handle(event)`, `cancel(attemptId)`, and `snapshot()`.
- The existing state machine receives only verified `goalCompleted`, `goalBlocked`, and `safeDialogueBoundary` events.

The coordinator owns the loop and never exposes raw actor bots:

```js
export function createSurvivalCoordinator({ episode, planner, authority, actors, emit, clock }) {
  return Object.freeze({ start, handle, cancel, snapshot });
}
```

- [ ] Write failing coordinator tests for sequential goals, two-actor parallel gathering with distinct reservations, safe dialogue boundaries, bounded replanning, transient path failure, terminal blocker, cancellation, stale-event fencing, and reservation release.
- [ ] Add failing state-machine tests proving dialogue cannot start during a dig/craft critical section and a Survival beat cannot advance on speech alone.
- [ ] Run both focused test files; expect the new cases to fail.
- [ ] Implement the coordinator as the sole planner loop owner: observe, plan, authorize/reserve, dispatch, await proof, re-observe, and either replan or emit terminal status.
- [ ] Add the minimal state-machine event handling needed to gate authored dialogue and beat advancement without weakening existing dialogue-only episodes.
- [ ] Run both focused tests; expect all cases to pass.
- [ ] Commit with `git add src/showrunner/survival-coordinator.mjs test/showrunner-survival-coordinator.test.mjs src/showrunner/state-machine.mjs test/showrunner-state-machine.test.mjs && git commit -m "feat: coordinate survival goals with dialogue"`.

### Task 6: Full meadow integration and evidence artifacts

**Files:**
- Create: `test/showrunner-survival-integration.test.mjs`
- Modify: `src/showrunner/artifacts.mjs`
- Modify: `test/showrunner-integration.test.mjs`
- Create: `production/scripts/first-day-meadow.md`
- Create: `test/first-day-meadow-script.test.mjs`

**Interfaces:**
- Adds take artifacts `planner-decisions.ndjson` and `survival-observations.ndjson` through the existing rooted artifact port.
- Connects the executable episode to the approved shooting-script wording and cue IDs.

The integration assertion must prove genuine resource flow rather than final state alone:

```js
assert.equal(result.inventory.oak_logConsumed, result.crafting.oakLogInput);
assert.equal(result.inventory.wooden_pickaxe, 2);
assert.equal(result.inventory.cobblestone >= 11, true);
assert.deepEqual(result.mutatedBlocks, result.approvedExcavationCells);
assert.equal(result.events.some((event) => event.kind === 'serverCommandFallback'), false);
```

- [ ] Write a failing integration test with two fake actors that completes all six beats, contends for one rejected shared target, survives one transient path failure, crafts from gathered inventory, excavates only the allowed cells, and produces ordered dialogue and planner evidence.
- [ ] Write the approved six-beat shooting script and its structural test from `docs/superpowers/plans/2026-08-06-first-day-meadow-scene.md`.
- [ ] Extend artifact writing so every planner decision and Survival observation is append-only, fenced, JSON-safe, and included in the final evidence digest.
- [ ] Run `node --test test/showrunner-survival-integration.test.mjs test/first-day-meadow-script.test.mjs test/showrunner-integration.test.mjs`; expect all focused tests to pass.
- [ ] Run `node --test test/*.test.mjs`; expect 0 failures.
- [ ] Run `node src/showrunner/cli.mjs validate production/episodes/first-day-meadow.survival.yaml`; expect successful normalized episode output without attempting a live take.
- [ ] Run `git diff --check`; expect no output.
- [ ] Commit with `git add src/showrunner/artifacts.mjs test/showrunner-integration.test.mjs test/showrunner-survival-integration.test.mjs production/scripts/first-day-meadow.md test/first-day-meadow-script.test.mjs && git commit -m "feat: make meadow survival cues executable"`.

## Live-Execution Boundary

Completion of this plan proves the planner, genuine Mineflayer operations, orchestration, episode, and evidence contracts in automated integration. It does not claim that the repository's currently missing production-host adapters exist. After this plan passes, write and execute a separate live-host plan covering two authenticated actor processes, trusted target/recipe observation, the separately privileged reset controller, rooted artifact and recording ports, capture lifecycle, CLI composition, live server preflight, and a recorded acceptance take.

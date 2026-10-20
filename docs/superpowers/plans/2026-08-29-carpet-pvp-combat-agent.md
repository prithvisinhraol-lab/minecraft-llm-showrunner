# Carpet PvP Combat Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one bounded LLM-controlled Carpet PvP combat character on an isolated Fabric server while preserving the current Mineflayer survival agent and vanilla world.

**Architecture:** Implement a mod-independent combat intent, policy, observation, and driver boundary inside `llm-combat`, beginning with a deterministic fake driver. Add a Carpet command driver only after resolving and pinning a compatible isolated Fabric stack, then expose the capability pack to the generated-goal pipeline after its generic compiler and fast runner are complete.

**Tech Stack:** Node.js 22 ESM, `node:test`, generated-goal pipeline contracts, RCON or a local server-console transport, Fabric Server, Fabric API, Carpet, Carpet PvP.

**Spec:** `docs/superpowers/specs/2026-08-29-carpet-pvp-combat-agent-design.md`

## Global Constraints

- Do not modify, upgrade, or copy the existing vanilla 1.21.4 world.
- Keep the Fabric combat server, world, state, logs, configuration, and port separate.
- Never expose raw Minecraft commands, selectors, Scarpet, shell, files, or network access to an LLM.
- Permit exactly one controlled combat actor, one approved opponent, and one tactical sequence at a time.
- Enforce the 12-block engagement radius, 750-millisecond decision cadence, 20-second exchange ceiling, 120-decision session ceiling, and four-health emergency disengagement threshold.
- Only fresh trusted observations may prove action or goal success.
- Stop on disconnect, death, target loss, arena exit, stale observation, operator stop, or policy violation.
- Run repository tests with `/opt/homebrew/opt/node@22/bin/node --test test/*.test.mjs`, never broad `node --test`.
- Perform live validation one checkpoint at a time and retain explicit rejection evidence.

---

### Task 1: Exact Combat Intent and Observation Contracts

**Files:**
- Create: `src/llm-combat/contracts.mjs`
- Test: `test/llm-combat-contracts.test.mjs`

**Interfaces:**
- Produces: `COMBAT_INTENT_KINDS`, `validateCombatIntent(value, context)`, `validateCombatObservation(value)`, and `validateCombatExecutionResult(value)`.
- Consumes: controller-owned `actorId`, `targetId`, `arenaId`, item IDs, hotbar slots, and observation versions.

- [x] **Step 1: Write failing exact-schema tests**

```js
const intent = validateCombatIntent({
  kind: 'strafe_left', actorId: 'fighter-1', targetId: 'opponent-1',
  observationVersion: 7, durationMs: 400
}, allowedContext());
assert.equal(intent.kind, 'strafe_left');
assert.throws(() => validateCombatIntent({ ...intent, command: '/kill @a' }, allowedContext()),
  { code: 'COMBAT_INTENT_INVALID' });
```

Cover every allowed intent, exact fields, actor/target mismatch, stale observations, slots 0 through 8, duration maximum 750, unknown items, coordinates, commands, selectors, NaN, and deep freezing. Cover observations and results with increasing safe integer versions, finite relative positions, health 0 through 20, booleans, bounded cooldown categories, and exact fields.

- [x] **Step 2: Run the focused test and verify RED**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/llm-combat-contracts.test.mjs`

Expected: FAIL because `src/llm-combat/contracts.mjs` does not exist.

- [x] **Step 3: Implement the exact validators**

```js
export const COMBAT_INTENT_KINDS = Object.freeze([
  'approach_target', 'hold_distance', 'strafe_left', 'strafe_right',
  'sprint_attack', 'normal_attack', 'critical_attack', 'raise_shield',
  'lower_shield', 'use_item', 'select_hotbar_slot', 'retreat_to_anchor', 'wait'
]);

export function validateCombatIntent(value, context) {
  // Select an exact field set by kind, validate symbolic IDs and numeric bounds,
  // require the current observation version, clone, and deep-freeze.
}
```

Implement exact per-kind field sets rather than a permissive union. Return errors with code `COMBAT_INTENT_INVALID`; never clamp invalid input.

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/llm-combat-contracts.test.mjs`

Expected: PASS with zero failures.

- [x] **Step 5: Commit Task 1**

```bash
git add src/llm-combat/contracts.mjs test/llm-combat-contracts.test.mjs
git commit -m "feat: define bounded combat contracts"
```

---

### Task 2: Deterministic Combat Policy and Verifier

**Files:**
- Create: `src/llm-combat/policy.mjs`
- Create: `src/llm-combat/verifier.mjs`
- Test: `test/llm-combat-policy.test.mjs`
- Test: `test/llm-combat-verifier.test.mjs`

**Interfaces:**
- Produces: `authorizeCombatIntent(intent, observation, sessionPolicy)`, `verifyCombatAction(before, intent, after, result)`, and `verifyCombatGoal(goal, history)`.
- Consumes: validated contracts from Task 1.

- [x] **Step 1: Write failing policy tests**

```js
assert.equal(authorizeCombatIntent(intent, observation, policy).authorized, true);
assert.deepEqual(authorizeCombatIntent(intent, { ...observation, health: 4 }, policy), {
  authorized: false, code: 'EMERGENCY_DISENGAGE'
});
```

Cover approved actor and opponent, arena membership, 12-block radius, cooldown, decision and duration budgets, spectators and non-approved entities, stale observations, target loss, and one-sequence lease exclusion.

- [x] **Step 2: Write failing verifier tests**

```js
assert.deepEqual(verifyCombatAction(before, attackIntent, afterDamage, driverResult), {
  verified: true, proofKinds: ['opponent_health_decreased']
});
assert.equal(verifyCombatAction(before, attackIntent, before, driverResult).verified, false);
```

Require a newer observation. Test damage, strafe displacement, approach distance, shield state, selected slot, retreat anchor, wait, death, disconnect, and chat or driver-claim-only rejection.

- [x] **Step 3: Run both tests and verify RED**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/llm-combat-policy.test.mjs test/llm-combat-verifier.test.mjs`

Expected: FAIL because the policy and verifier do not exist.

- [x] **Step 4: Implement fail-closed authorization and proof construction**

```js
export function authorizeCombatIntent(intent, observation, policy) {
  if (observation.health <= policy.disengageAtHealth) return reject('EMERGENCY_DISENGAGE');
  if (!observation.actorInArena || !observation.targetInArena) return reject('OUTSIDE_ARENA');
  if (observation.distance > policy.maximumEngagementDistance) return reject('TARGET_OUT_OF_RANGE');
  return Object.freeze({ authorized: true, code: 'AUTHORIZED' });
}
```

Implement every rejection in the test matrix and construct proof only from before/after observation differences.

- [x] **Step 5: Run both tests and verify GREEN, then commit**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/llm-combat-policy.test.mjs test/llm-combat-verifier.test.mjs`

```bash
git add src/llm-combat/policy.mjs src/llm-combat/verifier.mjs test/llm-combat-policy.test.mjs test/llm-combat-verifier.test.mjs
git commit -m "feat: enforce combat safety and proof"
```

---

### Task 3: Driver Port, Fake Driver, and Bounded Session Runner

**Files:**
- Create: `src/llm-combat/driver-port.mjs`
- Create: `src/llm-combat/fake-driver.mjs`
- Create: `src/llm-combat/session-runner.mjs`
- Test: `test/llm-combat-driver.test.mjs`
- Test: `test/llm-combat-session-runner.test.mjs`

**Interfaces:**
- Produces: `validateCombatDriver(driver)`, `createFakeCombatDriver(scenario)`, and `createCombatSessionRunner({ driver, policy, verifier, clock })`.
- Runner methods: `start(session)`, `execute(intent)`, `stop(reason)`, `status()`, and `snapshot()`.

- [ ] **Step 1: Write failing driver and session tests**

```js
await runner.start(sessionSpec());
const outcome = await runner.execute(strafeIntent());
assert.equal(outcome.verified, true);
await runner.stop('operator_stop');
assert.equal(driver.cancelReasons.at(-1), 'operator_stop');
```

Cover missing driver methods, connection, spawn, observation monotonicity, one in-flight sequence, 750-millisecond cadence, 20-second exchange, 120-decision session, emergency retreat, abort, late-result fencing, disconnect, death, target loss, arena exit, and bounded history.

- [ ] **Step 2: Run tests and verify RED**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/llm-combat-driver.test.mjs test/llm-combat-session-runner.test.mjs`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement the port, fake driver, and serialized runner**

```js
export function createCombatSessionRunner({ driver, policy, verifier, clock = Date }) {
  let active = null;
  let inFlight = false;
  return Object.freeze({ start, execute, stop, status, snapshot });
}
```

Use one serialized promise queue, `AbortController` per sequence, monotonic session counters, bounded proof history, and immutable public snapshots. `stop` cancels the driver before publishing stopped state.

- [ ] **Step 4: Run tests and verify GREEN, then commit**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/llm-combat-driver.test.mjs test/llm-combat-session-runner.test.mjs`

```bash
git add src/llm-combat/driver-port.mjs src/llm-combat/fake-driver.mjs src/llm-combat/session-runner.mjs test/llm-combat-driver.test.mjs test/llm-combat-session-runner.test.mjs
git commit -m "feat: run bounded combat sessions"
```

---

### Task 4: Resolve and Pin the Isolated Fabric Stack

**Files:**
- Create: `combat-server/versions.json`
- Create: `combat-server/README.md`
- Create: `scripts/verify-combat-server-files.mjs`
- Test: `test/combat-server-files.test.mjs`

**Interfaces:**
- Produces: a machine-readable manifest containing exact Minecraft, Java, Fabric Loader, Fabric API, Carpet, and Carpet PvP versions, source URLs, SHA-256 hashes, filenames, server port, and RCON port.

- [ ] **Step 1: Write the manifest validation test**

```js
const manifest = JSON.parse(await readFile('combat-server/versions.json', 'utf8'));
assert.deepEqual(Object.keys(manifest).sort(), EXPECTED_KEYS);
for (const artifact of manifest.artifacts) assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
```

Reject missing versions, `latest`, duplicate ports, non-HTTPS sources, missing hashes, unknown fields, and the existing server ports or paths.

- [ ] **Step 2: Verify RED, then research only authoritative release metadata**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/combat-server-files.test.mjs`

Use official Fabric metadata and the Carpet/Carpet PvP release repositories. Record incompatible combinations as rejected candidates rather than silently substituting versions.

- [ ] **Step 3: Add the exact manifest, verifier, and operator README**

```json
{
  "schemaVersion": 1,
  "serverDirectory": "combat-server/runtime",
  "serverPort": 25575,
  "rconPort": 25585,
  "artifacts": []
}
```

Replace the empty `artifacts` array with the resolved pinned entries before committing. Document that installation requires explicit approval because it downloads executable jars and accepts a separate EULA.

- [ ] **Step 4: Run the focused test and repository regression, then commit**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/combat-server-files.test.mjs`

Run: `/opt/homebrew/opt/node@22/bin/node --test test/*.test.mjs`

```bash
git add combat-server/versions.json combat-server/README.md scripts/verify-combat-server-files.mjs test/combat-server-files.test.mjs
git commit -m "build: pin isolated carpet pvp stack"
```

---

### Task 5: Carpet Command Transport and Driver

**Files:**
- Create: `src/llm-combat/command-transport.mjs`
- Create: `src/llm-combat/carpet-driver.mjs`
- Test: `test/llm-combat-command-transport.test.mjs`
- Test: `test/llm-combat-carpet-driver.test.mjs`

**Interfaces:**
- Produces: `createCommandTransport(config)` and `createCarpetCombatDriver({ transport, actorRegistry, arenaRegistry, clock })` implementing the Task 3 port.
- Consumes: only validated intents and controller-owned symbolic registries.

- [ ] **Step 1: Write failing translation and injection tests**

```js
await driver.execute(validatedStrafeIntent, context);
assert.deepEqual(transport.commands, [
  'player CombatActor move left',
  'player CombatActor move left stop'
]);
assert.throws(() => createActorRegistry({ fighter: '@a' }), { code: 'COMBAT_CONFIG_INVALID' });
```

Use exact commands confirmed by the pinned Carpet PvP version. Cover all MVP intents, fixed actor-name mapping, selector and whitespace rejection, maximum command length, command count ceilings, deterministic stop commands, timeout, abort, transport disconnect, and response-size ceilings.

- [ ] **Step 2: Run tests and verify RED**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/llm-combat-command-transport.test.mjs test/llm-combat-carpet-driver.test.mjs`

Expected: FAIL because the transport and driver do not exist.

- [ ] **Step 3: Implement fixed command templates**

```js
const translators = Object.freeze({
  strafe_left: ({ actor }) => [`player ${actor} move left`, `player ${actor} move left stop`],
  normal_attack: ({ actor }) => [`player ${actor} attack once`]
});
```

Populate templates from the pinned version's verified syntax. Never concatenate LLM strings; resolve every inserted value through controller-owned registries first. Ensure `cancel` emits all applicable stop actions.

- [ ] **Step 4: Run tests and verify GREEN, then commit**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/llm-combat-command-transport.test.mjs test/llm-combat-carpet-driver.test.mjs`

```bash
git add src/llm-combat/command-transport.mjs src/llm-combat/carpet-driver.mjs test/llm-combat-command-transport.test.mjs test/llm-combat-carpet-driver.test.mjs
git commit -m "feat: drive carpet pvp through fixed intents"
```

---

### Task 6: Generated-Goal Pipeline Combat Capability Pack

**Files:**
- Create: `src/llm-combat/pipeline-pack.mjs`
- Modify: `src/llm-goal-pipeline/registry.mjs`
- Test: `test/llm-combat-pipeline-pack.test.mjs`
- Modify: `test/llm-goal-pipeline-registry.test.mjs`

**Interfaces:**
- Produces: `createCombatCapabilityPack({ actorRegistry, arenaRegistry })` with capability, predicate, constraint, action-kind, and proof-kind definitions.
- Requires: the generated-goal pipeline compiler/evaluator and fast runner from Tasks 2 and 5 of `docs/superpowers/plans/2026-08-29-generated-goal-pipeline.md`.

- [ ] **Step 1: Write failing registry and compilation tests**

```js
const pack = createCombatCapabilityPack(registries());
const compiled = compileGeneratedContract(combatContract(), contextWith(pack));
assert.deepEqual(compiled.capabilities, ['combat_melee_exchange']);
assert.throws(() => compileGeneratedContract(crystalPvpContract(), contextWith(pack)),
  { code: 'PIPELINE_REGISTRY_UNKNOWN' });
```

Register `combat_melee_exchange`, `combat_disengage`, `combat_actor_alive`, `combat_target_alive`, `combat_actor_health_at_least`, `combat_target_defeated`, `combat_actor_in_arena`, `combat_target_in_arena`, `combat_distance_at_most`, `approved_combat_target_only`, and `emergency_disengage`. Reject unregistered combat styles and multi-target goals.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/llm-combat-pipeline-pack.test.mjs test/llm-goal-pipeline-registry.test.mjs`

Expected: FAIL because the capability pack does not exist.

- [ ] **Step 3: Implement optional registry composition**

```js
export function createCombatCapabilityPack({ actorRegistry, arenaRegistry }) {
  return deepFreeze({ capabilities, predicates, constraints, actionKinds, proofKinds });
}
```

Do not add Carpet command knowledge to the generic registry. Compose the pack only when starting a combat runtime, and make duplicate IDs a startup error.

- [ ] **Step 4: Run focused and compatibility tests, then commit**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/llm-combat-pipeline-pack.test.mjs test/llm-goal-pipeline-*.test.mjs test/llm-agent-*.test.mjs test/llm-director-*.test.mjs`

```bash
git add src/llm-combat/pipeline-pack.mjs src/llm-goal-pipeline/registry.mjs test/llm-combat-pipeline-pack.test.mjs test/llm-goal-pipeline-registry.test.mjs
git commit -m "feat: add optional combat goal pack"
```

---

### Task 7: User-Gated Live Validation Ladder

**Files:**
- Create: `scripts/install-combat-server.mjs`
- Create: `scripts/run-combat-server.mjs`
- Create: `scripts/verify-carpet-combat-live.mjs`
- Create: `docs/validation/carpet-pvp-combat-agent.md`
- Modify: `package.json`
- Test: `test/combat-server-scripts.test.mjs`

**Interfaces:**
- Produces: `npm run combat-server:install`, `npm run combat-server`, and `npm run combat:verify-live`.
- Live verifier records pinned versions, observation/action evidence, stop evidence, and explicit pass or rejection state.

- [ ] **Step 1: Write failing script-safety tests**

```js
assert.equal(commands['combat-server'].includes('combat-server/runtime'), true);
assert.equal(commands['combat-server'].includes('server/server.jar'), false);
```

Cover explicit paths, distinct ports, hash verification before jar use, no existing-world access, EULA gate, idempotent install, bounded child-process cleanup, operator start gate, and rejection artifact creation.

- [ ] **Step 2: Run tests and verify RED**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/combat-server-scripts.test.mjs`

Expected: FAIL because the scripts do not exist.

- [ ] **Step 3: Implement installation, startup, and validation scripts**

```js
if (process.env.ACCEPT_COMBAT_SERVER_EULA !== 'true') {
  throw new Error('Set ACCEPT_COMBAT_SERVER_EULA=true only after reviewing the isolated server EULA.');
}
```

Require a separate user approval before the first executable download. Keep the runtime ignored by Git while committing manifest, scripts, and validation evidence.

- [ ] **Step 4: Run all automated tests and commit**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/*.test.mjs`

```bash
git add scripts/install-combat-server.mjs scripts/run-combat-server.mjs scripts/verify-carpet-combat-live.mjs docs/validation/carpet-pvp-combat-agent.md package.json test/combat-server-scripts.test.mjs
git commit -m "test: add gated carpet combat validation"
```

- [ ] **Step 5: Execute each live checkpoint only with the user present**

Run the six validation checkpoints from the spec in order. Stop at the first failure, preserve logs and observations, mark the artifact `REJECTED`, and fix that bounded problem before advancing. Mark `LIVE_PASS` only after the complete melee exchange and emergency stop are independently verified.

# Meadow Beat Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute exactly six dialogue-first meadow beats while allowing each beat to own multiple bounded Survival goals, proving per-actor tools and excavation lanes and preserving artifact absence integrity.

**Architecture:** Schema-v2 Survival episodes map visible beat IDs to ordered goal ID lists. Showrunner cues bind to a `survivalBeatId`; completed dialogue starts that beat's coordinator work, authoritative `beatCompleted` releases the held transcript line, and schema-v1 `goalId` behavior remains unchanged. Artifact schema-v2 verification treats every known optional evidence file as either digested and present or manifest-omitted and absent.

**Tech Stack:** Node.js ESM, `node:test`, strict YAML loaders, immutable reducer/coordinator state, Ed25519 Survival receipts, rooted in-memory artifact ports, fake Mineflayer integration.

## Global Constraints

- Preserve exactly six visible beats: Arrival, First Priorities, Two Trees, Crafting, Breaking Ground, Hook.
- No Survival action begins while its visible beat dialogue is held.
- Preserve all schema-v1 cue `goalId` and `dialogue_boundaries` behavior.
- No grants, server commands, arbitrary commands, or fabricated final state.
- Each actor crafts and equips one wooden pickaxe from gathered resources.
- Each actor excavates only its own non-overlapping approved lane.
- Every planner decision and Survival observation remains append-only, JSON-safe, fenced, and acceptance-digested.
- Live authenticated production-host adapters remain out of scope.

---

### Task 1: Schema-v2 Beats and Cue Bindings

**Files:**
- Modify: `src/showrunner/survival-schema.mjs`
- Modify: `src/showrunner/schema.mjs`
- Modify: `test/showrunner-survival-schema.test.mjs`
- Modify: `test/showrunner-schema.test.mjs`

**Interfaces:**
- Consumes: schema-v1 `{dialogue_boundaries, goals}` and existing cue `goalId`.
- Produces: schema-v2 `episode.beats: ReadonlyArray<{id:string, goalIds:string[]}>` and optional normalized cue `survivalBeatId:string`.

- [ ] **Step 1: Write failing schema tests**

Add literal expectations that the meadow loads as schema version 2 with six beat IDs and more than six internal goals. Add malformed fixtures proving duplicate beat IDs, unknown/duplicate/skipped/reordered goal IDs, a non-six beat list, simultaneous cue `goalId` plus `survivalBeatId`, and unsafe `survivalBeatId` values are rejected.

```js
assert.deepEqual(episode.beats.map(({ id }) => id), [
  'arrival', 'first_priorities', 'two_trees', 'crafting', 'breaking_ground', 'hook'
]);
assert.deepEqual(episode.beats.flatMap(({ goalIds }) => goalIds), episode.goals.map(({ id }) => id));
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/showrunner-survival-schema.test.mjs test/showrunner-schema.test.mjs`

Expected: failures because schema version 2, `beats`, and `survivalBeatId` are unsupported.

- [ ] **Step 3: Implement strict schema-v2 normalization**

Normalize exact beat keys `{id, goal_ids}`, require six unique IDs, and require the flattened goal IDs to exactly equal authored goal order. Keep the schema-v1 branch unchanged. Extend showrunner cue normalization with mutually exclusive optional `goalId` and `survivalBeatId`.

- [ ] **Step 4: Run schema tests and verify GREEN**

Run: `node --test test/showrunner-survival-schema.test.mjs test/showrunner-schema.test.mjs`

Expected: all schema tests pass.

---

### Task 2: Dialogue-First Beat Handshake

**Files:**
- Modify: `src/showrunner/state-machine.mjs`
- Modify: `src/showrunner/survival-coordinator.mjs`
- Modify: `test/showrunner-state-machine.test.mjs`
- Modify: `test/showrunner-survival-coordinator.test.mjs`

**Interfaces:**
- Consumes: cue `survivalBeatId`, Survival episode `beats`, and existing fenced event identities.
- Produces: showrunner-to-coordinator `dialogueCompleted` payload `{beatId, proof}` and coordinator-to-showrunner `beatCompleted` payload `{beatId, goalIds, proof}`.

- [ ] **Step 1: Write failing state-machine tests**

Prove a beat-bound cue speaks before any completion, retains completed speech without advancing, emits exactly one beat handshake, ignores wrong/stale `beatCompleted`, and advances only after authoritative matching completion. Prove legacy `goalId` tests remain behaviorally unchanged.

```js
assert.equal(snapshot.cueIndex, 0);
assert.equal(snapshot.survivalBeats.two_trees.dialogueCompleted, true);
await runner.dispatch(beatCompleted('two_trees'));
assert.equal(runner.snapshot().cueIndex, 1);
```

- [ ] **Step 2: Write failing coordinator tests**

Use a schema-v2 episode with empty and multi-goal beats. Assert `start()` emits no actor command, empty beats complete after dialogue, nonempty beats start only after dialogue, all goals stay inside the beat, `beatCompleted` is last, and next-beat work waits for its own dialogue. Include wrong beat, stale identity, duplicate handshake, and cancellation cases.

- [ ] **Step 3: Run tests and verify RED**

Run: `node --test test/showrunner-state-machine.test.mjs test/showrunner-survival-coordinator.test.mjs`

Expected: failures because the reducer and coordinator only understand legacy goal boundaries.

- [ ] **Step 4: Implement the state-machine beat path**

Initialize `survivalBeats` from `survivalBeatId` cues. When speech completes, retain it, send one beat-scoped handshake, and wait. Validate `beatCompleted` identity/proof before marking the beat complete and calling the existing transcript/cue advancement. Leave `goalId` branches untouched.

- [ ] **Step 5: Implement the coordinator beat path**

For `episode.schemaVersion === 2`, start at `awaiting_dialogue`. On a valid current beat handshake, execute only its ordered goal slice; for empty beats emit completion immediately. Stop at the beat end, emit authoritative `beatCompleted`, advance the internal beat cursor, and return to `awaiting_dialogue`. Do not emit legacy safe boundaries in beat mode.

- [ ] **Step 6: Run orchestration tests and verify GREEN**

Run: `node --test test/showrunner-state-machine.test.mjs test/showrunner-survival-coordinator.test.mjs`

Expected: all tests pass, including legacy cases.

---

### Task 3: Genuine Per-Actor Crafting, Equipment, and Lanes

**Files:**
- Modify: `production/episodes/first-day-meadow.survival.yaml`
- Modify: `src/showrunner/survival-schema.mjs`
- Modify: `src/showrunner/survival-planner.mjs` only if actor-scoped excavation completion requires planner validation changes
- Modify: `test/showrunner-survival-schema.test.mjs`
- Modify: `test/showrunner-survival-planner.test.mjs` only for new completion coverage
- Modify: `test/showrunner-survival-integration.test.mjs`
- Modify: `src/showrunner/cli.mjs` or its expectations only if output wording still implies six goals

**Interfaces:**
- Consumes: existing `gather`, `regroup`, `place`, `craft`, `equip`, and `excavate` goal kinds.
- Produces: more than six goals assigned to six beats, actor-scoped excavation predicates, and per-actor integration evidence.

- [ ] **Step 1: Write failing integration and schema assertions**

Assert no actor operation exists before Arrival and First Priorities dialogue completion. Assert both gather goals occur in Two Trees; Crafting contains both regroups, placement, one craft and one equip per actor; Breaking Ground contains two lane goals; Hook has no goals. Assert per-actor pickaxe inventory/equipment, per-lane mutations, and per-actor cobblestone counts.

```js
assert.equal(result.actors.hero.equipment.hand, 'wooden_pickaxe');
assert.equal(result.actors.rival.equipment.hand, 'wooden_pickaxe');
assert.deepEqual(result.mutationsByActor.hero, heroLaneCells);
assert.deepEqual(result.mutationsByActor.rival, rivalLaneCells);
```

- [ ] **Step 2: Run focused integration and verify RED**

Run: `node --test test/showrunner-survival-schema.test.mjs test/showrunner-survival-integration.test.mjs`

Expected: failures because the episode has six shifted goals, one crafter, no equip goals, and one excavation owner.

- [ ] **Step 3: Author the schema-v2 meadow episode**

Split the mine into `hero_mine_lane` and `rival_mine_lane`. Add the approved six-beat map and ordered internal goals. Each actor gathers three logs, regroups, crafts one wooden pickaxe, equips it, and excavates an actor-owned lane. Hero places the one shared table. Allow an excavate goal's `actor_inventory_at_least` completion only when actor, item, and count match that goal.

- [ ] **Step 4: Update the fake host without grants**

Keep inventory mutations exclusively inside real fake Mineflayer `dig`, `goto` pickup, `craft`, `placeBlock`, and `equip` methods. Record the actor for each block mutation and recipe. Require table-bound recipes to receive the live table block. Derive final per-actor results from world state.

- [ ] **Step 5: Run integration/schema/planner tests and verify GREEN**

Run: `node --test test/showrunner-survival-schema.test.mjs test/showrunner-survival-planner.test.mjs test/showrunner-survival-integration.test.mjs`

Expected: all tests pass with six visible beats and more than six internal goals.

---

### Task 4: Verify Omitted Optional Evidence Remains Absent

**Files:**
- Modify: `src/showrunner/artifacts.mjs`
- Modify: `test/showrunner-integration.test.mjs`

**Interfaces:**
- Consumes: schema-v2 decision `evidenceFiles` and the known optional file list.
- Produces: `verify()` failure `ARTIFACT_EVIDENCE_MISMATCH` when an omitted optional file exists after acceptance.

- [ ] **Step 1: Write failing post-acceptance injection tests**

Accept a core-only take, inject each optional file independently and then both together, reopen, and require verification failure. Keep the existing pre-commit absence-race regression.

```js
for (const injected of [['planner-decisions.ndjson'], ['survival-observations.ndjson'], both]) {
  // accept, inject exact paths, reopen
  await assert.rejects(reopened.verify(), { code: 'ARTIFACT_EVIDENCE_MISMATCH' });
}
```

- [ ] **Step 2: Run artifact integration and verify RED**

Run: `node --test --test-name-pattern='optional evidence|acceptance' test/showrunner-integration.test.mjs`

Expected: post-acceptance injection cases return `ok: true` before the fix.

- [ ] **Step 3: Implement manifest absence verification**

After verifying every listed evidence digest for schema version 2, read every known optional file not in `evidenceFiles`; if any exists, fail with `ARTIFACT_EVIDENCE_MISMATCH`. Schema-v1 verification continues to use its recorded evidence keys only.

- [ ] **Step 4: Run artifact integration and verify GREEN**

Run: `node --test test/showrunner-integration.test.mjs`

Expected: all artifact and integration tests pass.

---

### Task 5: Verification, Review, Report, and Commit

**Files:**
- Modify: `.superpowers/sdd/2026-08-06-bounded-survival-task-planner/task-6-report.md`

**Interfaces:**
- Consumes: all preceding implementation and test evidence.
- Produces: auditable fix-round report and committed implementation.

- [ ] **Step 1: Run required focused tests**

Run: `node --test test/showrunner-survival-integration.test.mjs test/first-day-meadow-script.test.mjs test/showrunner-integration.test.mjs`

Expected: 0 failures.

- [ ] **Step 2: Run the full repository suite**

Run: `node --test --test-reporter=dot test/*.test.mjs`

Expected: exit 0.

- [ ] **Step 3: Run schema-v2 CLI validation**

Run: `node src/showrunner/cli.mjs validate production/episodes/first-day-meadow.survival.yaml`

Expected: two actors, exactly six visible beats, and the actual internal goal count greater than six; no live take.

- [ ] **Step 4: Run hygiene and inspect the diff**

Run: `git diff --check`

Expected: no output. Review every changed file against the approved spec and preserve unrelated user work.

- [ ] **Step 5: Append exact evidence to the Task 6 report**

Record every observed RED, final focused/full/CLI/hygiene output, implementation commit, independent review result, and the unchanged live-host boundary.

- [ ] **Step 6: Commit implementation**

```bash
git add production/episodes/first-day-meadow.survival.yaml src/showrunner test docs/superpowers/plans/2026-08-07-meadow-beat-orchestration.md
git commit -m "fix: align meadow beats with survival work"
```

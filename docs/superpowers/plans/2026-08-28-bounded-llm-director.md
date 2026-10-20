# Bounded LLM Director Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one slow, bounded LLM goal-selection handoff that chooses and runs the verified `collect_oak_log_above_gold_marker` goal after the existing placement goal succeeds.

**Architecture:** A local goal catalog is shared by the fast agent and a new `llm-director` subsystem. The director validates one structured Codex selection, persists it, invokes an injected fast-agent runner, records only the verified outcome, and stops; Minecraft execution and proof remain exclusively in the existing agent controller and adapter.

**Tech Stack:** Node.js 22 ESM, `node:test`, Mineflayer, Codex CLI structured output, atomic JSON state files.

**Spec:** `docs/superpowers/specs/2026-08-28-bounded-llm-director-design.md`

## Execution Checkpoint

- Task 1 complete: `750cbe0` (`feat: add bounded agent goal catalog`)
- Task 2 complete: `c0237ae` (`feat: verify oak log collection goal`)
- Task 3 complete: `01ac2a1` (`feat: define bounded director contracts`)
- Task 4 complete: `0c12c35` (`feat: persist bounded director state`)
- Task 5 complete: `3d4c6be` (`feat: add slow director codex provider`)
- Task 6 complete: `bc3c0bf` (`feat: orchestrate one verified director handoff`)
- Task 7 complete: `2ef24d0` (`feat: expose director through minecraft chat`)
- Task 8 automated gate complete: `ed1dd61` (`docs: add director live validation workflow`)
- Task 8 live acceptance passed on 2026-08-28; evidence recorded in `docs/llm-agent-operations.md` pending its final evidence commit.
- Active worktree: `/Users/jayraol/Documents/Minecraft/persistent-llm-agent.nosync` (relocated from the iCloud-backed `.worktrees` directory after reproducible short reads).

## Global Constraints

- One director decision and at most one fast-agent run per `director start` invocation.
- The director selects only stable IDs from a local catalog; it never emits executable goal text or Minecraft actions.
- Director context contains at most five eligible goals and five verified outcomes.
- Director timeout is exactly 90,000 ms; existing fast-agent safety limits remain unchanged.
- Live success requires deterministic world and inventory proof; simulated or provider-only claims cannot complete the handoff.
- Existing `agent start`, `agent status`, `agent stop`, `agent resume`, and `agent reset` behavior must remain compatible.
- Persist no chain-of-thought, raw prompts, full observations, or unbounded dialogue.

---

### Task 1: Shared Executable Goal Catalog

**Files:**
- Create: `src/llm-agent/goals.mjs`
- Modify: `src/llm-agent/contracts.mjs`
- Test: `test/llm-agent-goals.test.mjs`
- Modify test: `test/llm-agent-contracts.test.mjs`

**Interfaces:**
- Produces: `GOAL_IDS`, `PLACE_OAK_LOG_GOAL`, `COLLECT_OAK_LOG_GOAL`, `resolveAgentGoal(goalId)`, and `validateAgentGoal(goal)`.
- Consumes: no runtime dependencies; returns cloned, frozen catalog values suitable for actor state.

- [ ] **Step 1: Write failing catalog tests**

Add tests asserting that the two stable IDs resolve to exact goal objects, returned objects cannot mutate catalog state, and unknown IDs fail with `LLM_AGENT_GOAL_UNSUPPORTED`. Add contract tests proving `createInitialActorState` accepts both resolved goals and rejects arbitrary objective/success-condition combinations.

```js
assert.deepEqual(resolveAgentGoal('collect_oak_log_above_gold_marker'), {
  id: 'collect_oak_log_above_gold_marker',
  objective: 'mine the oak_log directly above the controller-identified gold_block marker and retain it in inventory',
  successCondition: { kind: 'oak_log_collected_from_above_gold_marker' },
  maxTurns: 12
});
assert.throws(() => resolveAgentGoal('invent_house'), { code: 'LLM_AGENT_GOAL_UNSUPPORTED' });
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test test/llm-agent-goals.test.mjs test/llm-agent-contracts.test.mjs`

Expected: FAIL because `src/llm-agent/goals.mjs` and generalized goal validation do not exist.

- [ ] **Step 3: Implement the minimal catalog and contract generalization**

Create exact local definitions for the placement and collection goals. Replace the fixed-objective comparison in `normalizeGoal` with `validateAgentGoal`; retain `FIRST_GOAL_OBJECTIVE` as a compatibility export pointing to the placement objective. Include `goal.id` in newly created actor states, while accepting and canonically upgrading the existing persisted placement-goal shape that lacks `id`.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `node --test test/llm-agent-goals.test.mjs test/llm-agent-contracts.test.mjs test/llm-agent-state-store.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/llm-agent/goals.mjs src/llm-agent/contracts.mjs test/llm-agent-goals.test.mjs test/llm-agent-contracts.test.mjs
git commit -m "feat: add bounded agent goal catalog"
```

---

### Task 2: Deterministic Collection-Goal Verification

**Files:**
- Modify: `src/llm-agent/minecraft-adapter.mjs`
- Modify: `src/llm-agent/controller.mjs`
- Modify test: `test/llm-agent-minecraft-adapter.test.mjs`
- Modify test: `test/llm-agent-controller.test.mjs`
- Modify test: `test/llm-agent-live-verifier.test.mjs`

**Interfaces:**
- Consumes: catalog goal with success condition `oak_log_collected_from_above_gold_marker`.
- Produces: proof `{ markerTargetId, marker, markerBlock: 'gold_block', aboveBlock: 'air', collectedItem: 'oak_log', collectedCount }`.
- Preserves: placement proof shape and existing action-verification behavior.

- [ ] **Step 1: Write failing adapter and controller tests**

Create a live-adapter fixture with a selected gold marker, an oak log above it before mining, air above it after mining, and one new oak log in inventory. Assert `verifyGoal(COLLECT_OAK_LOG_GOAL)` returns the collection proof. Assert failure when the marker changes, the above block remains a log, inventory has no log, or the log was already present before the run. Assert the controller accepts that proof only for the collection goal and stamps live evidence.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test test/llm-agent-minecraft-adapter.test.mjs test/llm-agent-controller.test.mjs test/llm-agent-live-verifier.test.mjs`

Expected: FAIL because only `oak_log_above_gold_marker` is recognized.

- [ ] **Step 3: Implement collection provenance and proof validation**

Extend `verifyGoal` by success-condition kind. For collection, require the live marker/air/inventory facts and require the current run's trusted `mined_oak_log` milestone before the controller accepts the proof; this establishes that the retained log came from mining during this run without leaking controller history into the adapter. Extend controller `goalProof` validation to the discriminated placement/collection proof union, and preserve the correct proof in `trusted.evidence`. Do not weaken placement verification.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test test/llm-agent-minecraft-adapter.test.mjs test/llm-agent-controller.test.mjs test/llm-agent-live-verifier.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/llm-agent/minecraft-adapter.mjs src/llm-agent/controller.mjs test/llm-agent-minecraft-adapter.test.mjs test/llm-agent-controller.test.mjs test/llm-agent-live-verifier.test.mjs
git commit -m "feat: verify oak log collection goal"
```

---

### Task 3: Director Contracts and Eligibility

**Files:**
- Create: `src/llm-director/contracts.mjs`
- Create: `src/llm-director/catalog.mjs`
- Test: `test/llm-director-contracts.test.mjs`
- Test: `test/llm-director-catalog.test.mjs`

**Interfaces:**
- Produces: `createInitialDirectorState(options)`, `validateDirectorState(value)`, `toDirectorContext(state, eligibleGoals, latestAgentState)`, and `validateDirectorDecision(value, eligibleGoalIds)`.
- Produces: `eligibleGoals({ latestAgentState })` returning at most five public catalog summaries.
- Consumes: live successful placement evidence from the actor state and shared agent goal definitions.

- [ ] **Step 1: Write failing exact-contract tests**

Assert exact top-level keys, five-entry history truncation, 300/500 character limits, rejection of unknown fields, `select_goal`/`stop` discrimination, and rejection of an unlisted goal ID. Assert coordinate details do not leak outside the typed `latestGoalProof` field.

- [ ] **Step 2: Write failing eligibility tests**

Assert a successful, `mineflayer-live`, non-simulated placement outcome makes only `collect_oak_log_above_gold_marker` eligible. Assert failed, simulated, missing-proof, wrong-actor, and non-placement states return no eligible goals.

- [ ] **Step 3: Run tests and verify RED**

Run: `node --test test/llm-director-contracts.test.mjs test/llm-director-catalog.test.mjs`

Expected: FAIL because the director modules do not exist.

- [ ] **Step 4: Implement minimal contracts and eligibility**

Use schema version `1`, lifecycle statuses `idle|running|succeeded|failed|stopped`, maximum five outcomes, and exact-key validation. Return defensive clones. Eligibility must derive from validated trusted evidence, never from `working.summary` alone.

- [ ] **Step 5: Run tests and verify GREEN**

Run: `node --test test/llm-director-contracts.test.mjs test/llm-director-catalog.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/llm-director/contracts.mjs src/llm-director/catalog.mjs test/llm-director-contracts.test.mjs test/llm-director-catalog.test.mjs
git commit -m "feat: define bounded director contracts"
```

---

### Task 4: Durable Director State Store

**Files:**
- Create: `src/llm-director/state-store.mjs`
- Test: `test/llm-director-state-store.test.mjs`

**Interfaces:**
- Produces: `createDirectorStateStore({ directory, fsImpl })` with `load(actorId)`, `save(actorId, state)`, `reset(actorId)`, `acquireLease(actorId, lease)`, and `releaseLease(actorId, ownerId)`.
- Consumes: `validateDirectorState`.

- [ ] **Step 1: Write failing persistence tests**

Cover missing records, atomic temporary-file/rename saves, mode `0600`, invalid JSON, mismatched actor identity, write cleanup, concurrent lease exclusion, expired-lease replacement, wrong-owner release, and actor-ID traversal rejection.

- [ ] **Step 2: Run test and verify RED**

Run: `node --test test/llm-director-state-store.test.mjs`

Expected: FAIL because the store does not exist.

- [ ] **Step 3: Implement the store**

Follow the proven actor-store pattern with a distinct `.director.lease.json` filename and a maximum lease duration of 405,000 ms, covering one 90-second director decision plus one 300-second agent run and 15 seconds of bounded orchestration overhead. Validate before every save and after every load.

- [ ] **Step 4: Run test and verify GREEN**

Run: `node --test test/llm-director-state-store.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```bash
git add src/llm-director/state-store.mjs test/llm-director-state-store.test.mjs
git commit -m "feat: persist bounded director state"
```

---

### Task 5: Slow Codex Goal-Selection Provider

**Files:**
- Create: `src/llm-director/codex-provider.mjs`
- Create: `src/llm-director/scripted-provider.mjs`
- Test: `test/llm-director-codex-provider.test.mjs`

**Interfaces:**
- Produces: `createDirectorCodexProvider({ codexBin, spawnImpl, timeoutMs = 90000, tempDirectory })` with `select(context, { signal })`.
- Produces: `createScriptedDirectorProvider(decisions)` for deterministic controller tests.

- [ ] **Step 1: Write failing provider tests**

Assert the spawned Codex command is `exec --ephemeral --ignore-user-config --ignore-rules --sandbox read-only`, disables external tools, uses an exact JSON schema, writes the prompt only to stdin, enforces 64 KiB output capture, cleans temporary files, handles abort, and terminates at 90,000 ms. Assert malformed and schema-incompatible output fail with stable director provider codes.

- [ ] **Step 2: Run test and verify RED**

Run: `node --test test/llm-director-codex-provider.test.mjs`

Expected: FAIL because the provider does not exist.

- [ ] **Step 3: Implement the minimal provider**

Mirror the existing hardened Codex transport but use a director-only schema:

```js
{
  decision: 'select_goal' | 'stop',
  goalId: 'collect_oak_log_above_gold_marker' | null,
  reason: string,
  stateSummary: string
}
```

The prompt states that goal IDs must come from `eligibleGoals`, no actions may be emitted, and the output is not authority to execute.

- [ ] **Step 4: Run test and verify GREEN**

Run: `node --test test/llm-director-codex-provider.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit Task 5**

```bash
git add src/llm-director/codex-provider.mjs src/llm-director/scripted-provider.mjs test/llm-director-codex-provider.test.mjs
git commit -m "feat: add slow director codex provider"
```

---

### Task 6: One-Handoff Director Controller

**Files:**
- Create: `src/llm-director/controller.mjs`
- Test: `test/llm-director-controller.test.mjs`

**Interfaces:**
- Produces: `createDirectorController({ actorId, overallObjective, store, provider, loadAgentState, inspectPrerequisite, runGoal, clock })`.
- Controller methods: `start()`, `status()`, `stop(reason)`, `reset()`, `awaitIdle()`.
- `inspectPrerequisite(goal, latestAgentState, { signal })` returns `{ ok: boolean, proof }` from the live adapter boundary.
- `runGoal(goal, { signal })` resolves only after the fast controller reaches a terminal state and returns the validated actor state.

- [ ] **Step 1: Write failing lifecycle and handoff tests**

Test successful flow order: load evidence, calculate eligibility, live prerequisite check, provider selection, persist selection, run goal, require live success, append one outcome, stop. Assert the selected goal is saved before `runGoal` is called and no second provider call occurs.

- [ ] **Step 2: Write failing fail-closed tests**

Cover no eligible goal, invalid selection, changed prerequisite, simulated result, fast-agent failure, provider timeout, persistence failure, duplicate start, stop/abort, lease contention, and bounded outcome truncation. Each case must end in a stable terminal state without another goal attempt.

- [ ] **Step 3: Run test and verify RED**

Run: `node --test test/llm-director-controller.test.mjs`

Expected: FAIL because the controller does not exist.

- [ ] **Step 4: Implement the controller**

Serialize commands through one promise queue, hold one director lease for the invocation, use one abort controller for provider/prerequisite/agent handoff, persist every authority transition, and release the lease in `finally`. Validate the returned actor state and accept success only when `lifecycle.status === 'succeeded'`, evidence source is `mineflayer-live`, `simulated === false`, and evidence goal proof matches the selected goal.

- [ ] **Step 5: Run test and verify GREEN**

Run: `node --test test/llm-director-controller.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit Task 6**

```bash
git add src/llm-director/controller.mjs test/llm-director-controller.test.mjs
git commit -m "feat: orchestrate one verified director handoff"
```

---

### Task 7: Live Composition and Minecraft Chat Command

**Files:**
- Create: `src/llm-director/live-runtime.mjs`
- Modify: `src/llm-agent/live-host.mjs`
- Modify: `src/llm-agent/cli.mjs`
- Modify: `package.json`
- Test: `test/llm-director-live-runtime.test.mjs`
- Modify test: `test/llm-agent-live-host.test.mjs`

**Interfaces:**
- Produces: `createDirectorLiveRuntime({ bot, actorControllerFactory, directorControllerFactory, ... })` providing the injected `inspectPrerequisite` and `runGoal` ports.
- Extends authorized exact chat commands with `director start`, `director status`, `director stop`, and `director reset`.
- CLI creates separate state directories and a 90-second director provider while preserving the current agent provider configuration.

- [ ] **Step 1: Write failing live-composition tests**

Assert only exact commands from `VPNAJ` are accepted; duplicate `director start` cannot overlap; selection and terminal messages occur in order; `agent stop` interrupts a director-owned fast run; shutdown aborts both layers and releases both leases; existing agent command tests remain unchanged.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test test/llm-director-live-runtime.test.mjs test/llm-agent-live-host.test.mjs`

Expected: FAIL because director chat/runtime composition does not exist.

- [ ] **Step 3: Implement composition and chat reporting**

Keep the Mineflayer bot and Minecraft adapter single-owned. For a selected goal, create a fresh fast controller using that goal, start it, await idle, then return status. Report only concise lifecycle text; never echo provider reasoning beyond its bounded state summary.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test test/llm-director-live-runtime.test.mjs test/llm-agent-live-host.test.mjs test/llm-agent-controller.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit Task 7**

```bash
git add src/llm-director/live-runtime.mjs src/llm-agent/live-host.mjs src/llm-agent/cli.mjs package.json test/llm-director-live-runtime.test.mjs test/llm-agent-live-host.test.mjs
git commit -m "feat: expose director through minecraft chat"
```

---

### Task 8: Operations, Regression Gate, and Live Acceptance

**Files:**
- Modify: `docs/llm-agent-operations.md`
- Modify: `README.md`
- Create: `scripts/verify-llm-director-live.mjs`
- Test: `test/llm-director-live-verifier.test.mjs`

**Interfaces:**
- Produces: read-only verifier output for agent state, director state, and live server prerequisites/results.
- Documents: exact Minecraft-chat commands without `/`, state locations, reset procedure, expected evidence, and safe shutdown.

- [x] **Step 1: Write the failing verifier test**

Provide placement-success and collection-success fixtures and assert the verifier rejects simulated evidence, wrong run IDs, absent marker proof, nonterminal director state, a third director decision, and mismatched agent/director outcomes.

- [x] **Step 2: Run verifier test and verify RED**

Run: `node --test test/llm-director-live-verifier.test.mjs`

Expected: FAIL because the verifier does not exist.

- [x] **Step 3: Implement verifier and operations documentation**

The verifier must print separate automated-state and live-world checks and exit nonzero for any unmet acceptance condition. Document `director start` as Minecraft chat text with no slash and state clearly that automated tests are not live validation.

- [x] **Step 4: Run all automated tests**

Run: `node --test test/*.test.mjs`

Expected: all tests PASS with zero failures, cancellations, or skipped director tests.

- [x] **Step 5: Run the pre-live verifier**

Run: `node scripts/verify-llm-director-live.mjs --phase preflight`

Expected: PASS only when the existing placement state is live and successful and the marker/log prerequisite is present.

- [x] **Step 6: Commit automated completion**

```bash
git add docs/llm-agent-operations.md README.md scripts/verify-llm-director-live.mjs test/llm-director-live-verifier.test.mjs
git commit -m "docs: add director live validation workflow"
```

- [x] **Step 7: Perform the user-gated live test**

Start the server and combined runtime, confirm the user and actor are safely positioned, and wait. The user presses `T`, types `director start` with no slash, and presses Enter. Do not trigger the command on the user's behalf.

- [x] **Step 8: Verify the live result before claiming success**

Confirm through the server console that the gold block remains, its upper block is air, and `LlmAgent` holds an oak log. Then run:

`node scripts/verify-llm-director-live.mjs --phase completed`

Expected: agent and director states both report live, matching success; exactly one director choice was made; no third goal began.

- [x] **Step 9: Record the live evidence checkpoint**

Update `docs/llm-agent-operations.md` with the run IDs, timestamp, commands used, and whether each acceptance condition passed. Commit only after fresh verification.

```bash
git add docs/llm-agent-operations.md
git commit -m "test: record live director handoff evidence"
```

# Bounded Live Meadow Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the word `begin`, spoken by online operator `VPNAJ`, launch the complete approved first-day meadow scene through real Mineflayer actor runtimes and the existing bounded showrunner.

**Architecture:** Add a dedicated live composition root with narrow adapters for actor connections, trusted live observations, fixed-line bank creation, timers, reset/preflight, and operator command gating. Reuse the existing state machine, Survival planner/coordinator/authority, and ActorRuntime without console choreography or legacy bot commands.

**Tech Stack:** Node.js ESM, Mineflayer 4.x, mineflayer-pathfinder, `node:test`, existing showrunner modules.

## Global Constraints

- `begin` is accepted only from `VPNAJ` while online.
- No dialogue or world-changing actor action occurs before `begin`.
- Only the twelve authored fixed lines may be spoken.
- All eleven Survival goals execute through signed typed commands.
- Disconnect, death, unsafe terrain, or stop cancels and fails closed.
- The host never uses arbitrary server-console commands, legacy `bot` chat commands, or fake motion.
- OBS and production acceptance remain out of scope for this test host.

---

### Task 1: Operator gate and lifecycle

**Files:**
- Create: `src/showrunner/live-meadow-gate.mjs`
- Create: `test/showrunner-live-meadow-gate.test.mjs`

**Interfaces:**
- Consumes: actor chat events, player presence snapshots, and lifecycle callbacks.
- Produces: `createLiveMeadowGate({ operatorName, isOnline, onBegin, onStop })` with `handleChat`, `status`, and `close`.

- [ ] Write tests proving non-operator, offline, repeated, and post-close `begin` commands cannot start.
- [ ] Run the focused test and verify RED.
- [ ] Implement the smallest serialized gate with states `idle`, `starting`, `running`, `stopping`, `completed`, and `aborted`.
- [ ] Run the focused test and verify GREEN.
- [ ] Commit Task 1.

### Task 2: Exact fixed-line runtime bank

**Files:**
- Create: `src/showrunner/fixed-line-bank.mjs`
- Create: `test/showrunner-fixed-line-bank.test.mjs`

**Interfaces:**
- Consumes: normalized schema-v2 episode and an ephemeral Ed25519 private key.
- Produces: `createFixedLineBank(episode, privateKey)` containing one approved variant and one authored fallback per line, both with identical authored text.

- [ ] Write tests for exactly twelve bindings, episode hash, authored line IDs, speakers, text, and public verification.
- [ ] Run the focused test and verify RED.
- [ ] Implement bank creation using `signApprovedBank` only.
- [ ] Run the focused test and verify GREEN.
- [ ] Commit Task 2.

### Task 3: Trusted live scene observer

**Files:**
- Create: `src/showrunner/live-meadow-observer.mjs`
- Create: `test/showrunner-live-meadow-observer.test.mjs`

**Interfaces:**
- Consumes: normalized Survival episode, two Mineflayer bot objects, and monotonic version allocator.
- Produces: `observeActor(actorId, goalId)` and verifier methods for marks, target receipts, item receipts, recipe receipts, and authoritative Survival observations.

- [ ] Write tests for canonical dimension, inventory/equipment counts, solid support, clear headroom, region-bounded logs and stone cells, item drops, crafting-table state, stable target IDs, and monotonic versions.
- [ ] Run focused tests and verify RED.
- [ ] Implement read-only snapshots using Mineflayer `blockAt`, inventory, entities, position, and held/equipped items.
- [ ] Run focused tests and verify GREEN.
- [ ] Commit Task 3.

### Task 4: Live preflight and natural-ground calibration

**Files:**
- Create: `src/showrunner/live-meadow-preflight.mjs`
- Create: `test/showrunner-live-meadow-preflight.test.mjs`

**Interfaces:**
- Consumes: normalized episode pair, operator/actor observations, and path reachability checks.
- Produces: `runLiveMeadowPreflight(input)` with immutable validated actor/camera marks or a typed blocker.

- [ ] Write tests rejecting air support, hazards, blocked headroom, shared positions, missing trees, missing excavation blocks, wrong dimension, unreachable marks, and offline operator.
- [ ] Run focused tests and verify RED.
- [ ] Implement validation without editing blocks.
- [ ] Add a deterministic natural-surface candidate search bounded to the protected cuboid and require explicit manifest agreement; do not silently rewrite coordinates.
- [ ] Run focused tests and verify GREEN.
- [ ] Commit Task 4.

### Task 5: Live actor connection owner

**Files:**
- Create: `src/showrunner/live-actor-host.mjs`
- Create: `test/showrunner-live-actor-host.test.mjs`

**Interfaces:**
- Consumes: Mineflayer factory, server configuration, exact actor names, observer/verifier, and runtime authorization.
- Produces: `createLiveActorHost(options)` with `connect`, `actors`, `players`, `awaitReady`, `cancel`, and `close`.

- [ ] Write tests for exact usernames, duplicate-login rejection, spawn readiness, non-op command refusal, operator presence, disconnect/death cancellation, and idempotent close.
- [ ] Run focused tests and verify RED.
- [ ] Compose `createActorRuntime` for each owned bot and expose only typed execution methods.
- [ ] Run focused tests and verify GREEN.
- [ ] Commit Task 5.

### Task 6: Test-only production, timer, and capture adapters

**Files:**
- Create: `src/showrunner/live-test-ports.mjs`
- Create: `test/showrunner-live-test-ports.test.mjs`

**Interfaces:**
- Consumes: live actor host, preflight result, and event sink.
- Produces: typed `production`, `timers`, and no-recording `capture` ports satisfying the showrunner barriers.

- [ ] Write tests for preparation, pre-roll, cue timeout scheduling/cancellation, actor reset, capture-ready test acknowledgment, stop, and emergency cancellation.
- [ ] Run focused tests and verify RED.
- [ ] Implement typed barriers and bounded timers; capture must identify itself as `test-no-recording` and can never satisfy production acceptance.
- [ ] Run focused tests and verify GREEN.
- [ ] Commit Task 6.

### Task 7: Dedicated live composition root and `begin`

**Files:**
- Create: `src/showrunner/live-meadow-host.mjs`
- Create: `test/showrunner-live-meadow-host.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: episode paths, server configuration, actor/operator names, and owned live adapters.
- Produces: `createLiveMeadowHost(options)` plus `npm run meadow-live`.

- [ ] Write an integration test proving connect and preflight produce zero chat/motion, `begin` from `VPNAJ` executes all twelve lines in order, every goal completes, and a second begin cannot replay the take.
- [ ] Write cancellation tests for operator disconnect and explicit `stop`.
- [ ] Run focused tests and verify RED.
- [ ] Compose episode loading, ephemeral bank, authority, planner, coordinator, showrunner, actor host, test ports, and gate.
- [ ] Add bounded status output without secrets or arbitrary command input.
- [ ] Run focused tests and verify GREEN.
- [ ] Commit Task 7.

### Task 8: Operations and full verification

**Files:**
- Modify: `docs/showrunner-operations.md`
- Modify: `SHOWRUNNER_RESUME.md` only if it is tracked in this branch; otherwise leave the user's file untouched.

**Interfaces:**
- Consumes: completed live test host.
- Produces: exact connect/preflight/begin/stop commands and recovery procedure.

- [ ] Document that `npm run meadow-live` connects and preflights but remains idle until `VPNAJ` says `begin`.
- [ ] Run `node --test test/*.test.mjs` and require zero failures.
- [ ] Validate both meadow episode files through the CLI.
- [ ] Run `git diff --check`.
- [ ] Perform live validation incrementally: stop legacy bots, connect owned actors, verify positions and geometry, reset-only rehearsal, then arm idle.
- [ ] Confirm `VPNAJ` is online before reporting ready; do not send or simulate `begin`.
- [ ] Commit Task 8 and finish the branch through the standard integration workflow.

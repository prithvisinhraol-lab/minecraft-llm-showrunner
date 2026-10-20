# Persistent LLM Minecraft Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one restart-safe LLM-controlled Mineflayer actor that independently mines one oak log and places it on a gold-block marker.

**Architecture:** Add an isolated `src/llm-agent/` subsystem with strict schemas, an atomic per-actor state store, an ephemeral Codex CLI decision provider, a deterministic controller, and a Mineflayer adapter. A separate live host accepts commands only from `VPNAJ`; it shares no actor or runtime state with the meadow showrunner.

**Tech Stack:** Node.js 22 ESM, built-in `node:test`, Mineflayer 4.37, mineflayer-pathfinder 2.4, Codex CLI noninteractive execution, JSON files.

**Spec:** `docs/superpowers/specs/2026-08-24-persistent-llm-minecraft-agent-design.md`

## Global Constraints

- The first goal is exactly: obtain one `oak_log` and place an `oak_log` directly above a controller-identified `gold_block` marker.
- The LLM chooses exactly one action per turn from `observe`, `move_to_block`, `mine_block`, `select_item`, `place_on_block`, and `finish`.
- The LLM never receives or emits raw coordinates and cannot run Minecraft commands, JavaScript, shell commands, or filesystem operations.
- Controller-owned Minecraft facts never accept writes from LLM output.
- The working summary is limited to 500 Unicode characters; trusted history retains exactly the five most recent action results.
- A run permits at most 12 decisions and stops on death, disconnect, deadline, repeated identical failures, or an operator stop.
- Persistent LLM-authored state survives process and server restarts until the operator resets it.
- Real-server evidence must be labeled separately from simulated test evidence.
- Do not modify or reuse the production meadow host, meadow actors, or meadow test area.

## File Map

- `src/llm-agent/contracts.mjs` — constants, state construction, persisted-state validation, decision validation, and prompt projection.
- `src/llm-agent/state-store.mjs` — atomic per-actor JSON persistence and reset.
- `src/llm-agent/codex-provider.mjs` — one ephemeral Codex CLI invocation and strict JSON response parsing.
- `src/llm-agent/scripted-provider.mjs` — deterministic one-decision-at-a-time provider used only for incremental live action checks.
- `src/llm-agent/controller.mjs` — serialized lifecycle commands and the bounded observe/decide/execute/verify loop.
- `src/llm-agent/minecraft-adapter.mjs` — compact target observations and six allowlisted Mineflayer actions.
- `src/llm-agent/live-host.mjs` — Mineflayer composition, `VPNAJ` chat authorization, lifecycle wiring, and shutdown.
- `src/llm-agent/cli.mjs` — environment loading and executable entrypoint.
- `scripts/verify-llm-agent-live.mjs` — read-only live evidence reporter for actor state and marker completion.
- `test/llm-agent-*.test.mjs` — focused unit, controller, adapter, and host tests.
- `docs/llm-agent-operations.md` — exact start, chat, reset, and real-validation instructions.
- `package.json` — `llm-agent` and `llm-agent:verify-live` scripts.
- `.gitignore` — exclude persistent local actor records from version control.

---

### Task 1: Strict Contracts and State Ownership

**Files:**
- Create: `src/llm-agent/contracts.mjs`
- Test: `test/llm-agent-contracts.test.mjs`

**Interfaces:**
- Produces: `createInitialActorState({ actorId, runId, now, goal }) -> ActorState`
- Produces: `validateActorState(value) -> frozen ActorState`
- Produces: `validateDecision(value, observation) -> frozen Decision`
- Produces: `toDecisionContext(state, observation) -> plain JSON object`
- Produces: `ACTION_NAMES`, `MAX_TURNS`, `MAX_SUMMARY_CHARACTERS`, `MAX_RECENT_RESULTS`

- [ ] **Step 1: Write failing contract tests**

Cover exact action keys, rejection of unknown fields/raw coordinates, 500-character summaries, custom variables containing JSON scalars only, target IDs that must exist in the current observation, preservation of controller-owned fields, and eviction to five recent results.

```js
test('rejects coordinates and unknown decision fields', () => {
  const observation = { targets: [{ id: 'oak-1', kind: 'block', block: 'oak_log' }] };
  assert.throws(() => validateDecision({
    action: 'mine_block', targetId: 'oak-1', x: 10,
    reason: 'mine it', summary: '', plan: ['mine'], subgoal: 'mine', variables: {}
  }, observation), { code: 'LLM_AGENT_DECISION_INVALID' });
});

test('decision context exposes target IDs but no coordinates', () => {
  const context = toDecisionContext(state, observationWithPrivatePositions);
  assert.equal(JSON.stringify(context).includes('"x"'), false);
  assert.deepEqual(context.observation.targets[0], {
    id: 'oak-1', kind: 'block', block: 'oak_log', distanceBand: 'near', reachable: true
  });
});
```

- [ ] **Step 2: Run the tests and confirm the expected failure**

Run: `node --test test/llm-agent-contracts.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/llm-agent/contracts.mjs`.

- [ ] **Step 3: Implement the minimal strict contracts**

Use exact-key checks per action. Normalize the decision to this discriminated shape:

```js
{
  action: 'observe' | 'finish' |
    'move_to_block' | 'mine_block' | 'place_on_block' | 'select_item',
  targetId?: string,
  item?: 'oak_log',
  reason: string,
  summary: string,
  plan: string[],
  subgoal: string,
  variables: Record<string, string | number | boolean | null>
}
```

Require `targetId` only for target actions and `item` only for `select_item`. Limit `plan` to five nonempty entries, variables to 16 keys, each string value to 200 characters, and all explanatory strings to their declared bounds. Ensure `toDecisionContext` strips adapter-private positions and returns only compact public target descriptions.

- [ ] **Step 4: Run the focused and full test suites**

Run: `node --test test/llm-agent-contracts.test.mjs`

Expected: PASS.

Run: `node --test test/*.test.mjs`

Expected: all existing and new tests PASS.

- [ ] **Step 5: Commit the contracts**

```bash
git add src/llm-agent/contracts.mjs test/llm-agent-contracts.test.mjs
git commit -m "feat: define strict LLM agent contracts"
```

### Task 2: Atomic Per-Actor State Store

**Files:**
- Create: `src/llm-agent/state-store.mjs`
- Test: `test/llm-agent-state-store.test.mjs`

**Interfaces:**
- Consumes: `validateActorState(value)` from Task 1
- Produces: `createActorStateStore({ directory, fsImpl? }) -> { load(actorId), save(actorId, state), reset(actorId) }`
- Contract: actor IDs match `/^[A-Za-z0-9_-]{1,32}$/`; filenames are `<actorId>.json`

- [ ] **Step 1: Write failing state-store tests**

Use `mkdtemp` and verify missing loads return `null`, save/load round trips, invalid actor IDs cannot escape the directory, unknown schema versions fail with `LLM_AGENT_STATE_INVALID`, reset removes only the requested actor, and a simulated rename failure leaves the previous JSON intact.

```js
test('failed replacement preserves the previous valid record', async (t) => {
  const store = createActorStateStore({ directory, fsImpl: failingRenameFs });
  await assert.rejects(store.save('AgentOne', nextState), { code: 'LLM_AGENT_STATE_WRITE_FAILED' });
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'AgentOne.json'))), previousState);
});
```

- [ ] **Step 2: Run the tests and confirm the expected failure**

Run: `node --test test/llm-agent-state-store.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `state-store.mjs`.

- [ ] **Step 3: Implement atomic persistence**

Serialize validated state to `<actor>.json.tmp-<pid>-<nonce>`, open with mode `0o600`, write, `sync`, close, rename, then best-effort sync the containing directory. On failure, unlink only the resolved temporary sibling and wrap the original error with code `LLM_AGENT_STATE_WRITE_FAILED`. Never use recursive deletion.

- [ ] **Step 4: Run focused and full tests**

Run: `node --test test/llm-agent-state-store.test.mjs`

Expected: PASS.

Run: `node --test test/*.test.mjs`

Expected: all tests PASS.

- [ ] **Step 5: Commit the store**

```bash
git add src/llm-agent/state-store.mjs test/llm-agent-state-store.test.mjs
git commit -m "feat: persist LLM actor state atomically"
```

### Task 3: Ephemeral Codex CLI Decision Provider

**Files:**
- Create: `src/llm-agent/codex-provider.mjs`
- Create: `src/llm-agent/scripted-provider.mjs`
- Test: `test/llm-agent-codex-provider.test.mjs`

**Interfaces:**
- Consumes: the JSON context from `toDecisionContext`
- Produces: `createCodexProvider({ codexBin, spawnImpl?, timeoutMs, tempDirectory }) -> { decide(context, { signal? }) }`
- Produces: `createScriptedProvider(decisions) -> { decide(context, { signal? }) }`
- `decide` resolves to parsed JSON; contract validation remains the controller's responsibility

- [ ] **Step 1: Write failing provider tests**

Capture the spawned executable, arguments, stdin, stdout, stderr, and cancellation behavior. Assert one fresh process per call and exact safety flags.

```js
assert.deepEqual(args.slice(0, 8), [
  'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules',
  '--sandbox', 'read-only', '--ask-for-approval', 'never'
]);
assert.match(stdinText, /Return exactly one JSON decision/);
assert.deepEqual(await provider.decide(context), validDecision);
```

Also test nonzero exit (`LLM_AGENT_PROVIDER_FAILED`), timeout (`LLM_AGENT_PROVIDER_TIMEOUT`), invalid JSON (`LLM_AGENT_PROVIDER_OUTPUT_INVALID`), output larger than 64 KiB, and a scripted provider that returns exactly one deep-cloned decision per call before failing closed with `LLM_AGENT_SCRIPT_EXHAUSTED`.

- [ ] **Step 2: Run the tests and confirm the expected failure**

Run: `node --test test/llm-agent-codex-provider.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the provider**

Generate a temporary JSON Schema file and output file inside the supplied temporary directory. Invoke:

```text
codex exec --ephemeral --ignore-user-config --ignore-rules \
  --sandbox read-only --ask-for-approval never \
  --output-schema <schema-path> --output-last-message <output-path> -
```

Send the compact decision instructions and serialized context on stdin. Cap captured stderr and output at 64 KiB, terminate on timeout/abort, parse only the output file, and remove only the two files created for that decision. Never interpolate prompt data into arguments or a shell command.

Implement `createScriptedProvider` without `eval`, dynamic imports, or filesystem access. The host will parse an explicitly configured JSON decision file once at startup and pass its array to this provider; every returned decision still goes through the same controller validation and action limits as Codex output.

- [ ] **Step 4: Run focused and full tests**

Run: `node --test test/llm-agent-codex-provider.test.mjs`

Expected: PASS.

Run: `node --test test/*.test.mjs`

Expected: all tests PASS.

- [ ] **Step 5: Commit the provider**

```bash
git add src/llm-agent/codex-provider.mjs src/llm-agent/scripted-provider.mjs test/llm-agent-codex-provider.test.mjs
git commit -m "feat: add ephemeral Codex decision provider"
```

### Task 4: Serialized Bounded Agent Controller

**Files:**
- Create: `src/llm-agent/controller.mjs`
- Test: `test/llm-agent-controller.test.mjs`

**Interfaces:**
- Consumes: `store.load/save/reset`, `provider.decide`, and adapter methods `observe`, `execute`, `verifyGoal`, `isConnected`
- Produces: `createAgentController({ actorId, goal, store, provider, adapter, clock, limits? })`
- Produces methods: `start()`, `status()`, `stop(reason)`, `resume()`, `reset()`, `handleDeath()`, `handleDisconnect(reason)`, `awaitIdle()`

- [ ] **Step 1: Write failing controller tests with fake ports**

Test one action per decision, observe-before-decide, persisted state after every rejection/result, LLM working-state updates without trusted-field mutation, verified `finish`, the 12-turn bound, repeated identical failures, stop during a pending decision, death/disconnect, restart resume with a fresh observation, command serialization, and provider failure causing no fallback action.

```js
test('rejects attempted trusted-state writes without executing an action', async () => {
  provider.decisions.push({
    action: 'mine_block', targetId: 'oak-1', reason: 'need a log',
    summary: 'Found the tree.', plan: ['mine', 'place'], subgoal: 'mine', variables: { attempts: 1 },
    trusted: { status: 'succeeded' }
  });
  await controller.start();
  await controller.awaitIdle();
  assert.deepEqual(adapter.executed, []);
  assert.notEqual((await store.load('AgentOne')).lifecycle.status, 'succeeded');
});
```

- [ ] **Step 2: Run the tests and confirm the expected failure**

Run: `node --test test/llm-agent-controller.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the controller state machine**

Use one internal promise queue for all lifecycle events. At the start of each turn, observe, persist trusted observation, call the provider with an `AbortSignal`, validate, execute exactly once, observe again, verify the result, append/evict recent results, and save atomically. Count invalid output as a turn. Treat `finish` as a verification request, never success by assertion. Compute repeated failure identity from validated action plus verified error code.

Default limits:

```js
{
  maxTurns: 12,
  decisionTimeoutMs: 30_000,
  actionTimeoutMs: 30_000,
  runTimeoutMs: 300_000,
  maxInvalidResponses: 3,
  maxIdenticalFailures: 3
}
```

- [ ] **Step 4: Run focused and full tests**

Run: `node --test test/llm-agent-controller.test.mjs`

Expected: PASS.

Run: `node --test test/*.test.mjs`

Expected: all tests PASS.

- [ ] **Step 5: Commit the controller**

```bash
git add src/llm-agent/controller.mjs test/llm-agent-controller.test.mjs
git commit -m "feat: add bounded LLM agent controller"
```

### Task 5: Mineflayer Observation and Action Adapter

**Files:**
- Create: `src/llm-agent/minecraft-adapter.mjs`
- Test: `test/llm-agent-minecraft-adapter.test.mjs`

**Interfaces:**
- Produces: `createMinecraftAdapter({ bot, goals, Movements, scanRadius? })`
- Produces methods: `observe()`, `execute(action, { signal })`, `verifyGoal(goal)`, `isConnected()`, `stop()`
- Observation public targets contain `{ id, kind, block, distanceBand, reachable }`; private target positions remain inside the adapter

- [ ] **Step 1: Write failing adapter tests with a fake Mineflayer bot**

Verify stable target IDs within an observation version, nearest oak and gold target discovery, no coordinates in public observations, movement via `GoalNear`, mining only a currently mapped `oak_log`, selecting only an owned `oak_log`, placement only on a mapped `gold_block`, abort stopping pathfinder/digging, and success only when the live block above the selected gold marker is `oak_log`.

```js
test('verifies placement from the world rather than the action receipt', async () => {
  fakeBot.blockAt = (position) => position.equals(marker.offset(0, 1, 0))
    ? { name: 'oak_log' }
    : { name: 'gold_block' };
  assert.equal(await adapter.verifyGoal(goal), true);
});
```

- [ ] **Step 2: Run the tests and confirm the expected failure**

Run: `node --test test/llm-agent-minecraft-adapter.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement compact observation and six actions**

Scan up to 32 blocks for `oak_log` and `gold_block`; expose at most eight nearest targets. Derive opaque IDs from observation version and sorted index, retain the ID-to-position map only in memory, and invalidate it on the next observation. Use pathfinder for movement, `bot.dig` plus a bounded wait for normal item pickup for mining, `bot.equip` for selection, and `bot.placeBlock(marker, { x: 0, y: 1, z: 0 })` for placement. If the mined log is not collected before the action timeout, return `ITEM_NOT_COLLECTED`; do not grant an item or teleport the actor. `observe` performs no mutation; `finish` performs no mutation. Return receipts containing request, before/after inventory counts, observed block names, and a specific error code.

- [ ] **Step 4: Run focused and full tests**

Run: `node --test test/llm-agent-minecraft-adapter.test.mjs`

Expected: PASS.

Run: `node --test test/*.test.mjs`

Expected: all tests PASS.

- [ ] **Step 5: Commit the adapter**

```bash
git add src/llm-agent/minecraft-adapter.mjs test/llm-agent-minecraft-adapter.test.mjs
git commit -m "feat: add bounded Mineflayer agent adapter"
```

### Task 6: Isolated Live Host and Authorized Commands

**Files:**
- Create: `src/llm-agent/live-host.mjs`
- Create: `src/llm-agent/cli.mjs`
- Test: `test/llm-agent-live-host.test.mjs`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: controller, adapter, provider, state store, Mineflayer, pathfinder
- Produces: `createLlmAgentLiveHost(options) -> { start(), close(), controller, bot }`
- Chat contract: only username exactly `VPNAJ` may send messages exactly matching `agent start|status|stop|resume|reset`

- [ ] **Step 1: Write failing host tests**

Use injected fake bot/controller factories. Verify commands from other users and near matches are ignored, each authorized command is awaited through one queue, status is reported in chat, duplicate start does not create a second loop, death/disconnect reaches the controller, and close stops controller/pathfinder before ending the bot.

```js
await fakeBot.emitAsync('chat', 'VPNAJ', 'agent start');
assert.deepEqual(controller.calls, ['start']);
await fakeBot.emitAsync('chat', 'OtherPlayer', 'agent reset');
assert.deepEqual(controller.calls, ['start']);
```

- [ ] **Step 2: Run the tests and confirm the expected failure**

Run: `node --test test/llm-agent-live-host.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement composition and the executable**

Load `.env`, create a distinct actor username from `LLM_AGENT_USERNAME` defaulting to `LlmAgent`, store state under `runtime/llm-agent-state`, and require `CODEX_BIN` or resolve the bundled Codex binary only through an explicit startup check. Configure Mineflayer from `MC_HOST`, `MC_PORT`, and `MC_VERSION`. When `LLM_AGENT_SCRIPT_PATH` is set, read one JSON array at startup and use `createScriptedProvider`; otherwise use Codex. Reject a missing, malformed, or non-array script before connecting the actor. Add signal handlers that await `host.close()`.

Add scripts:

```json
"llm-agent": "env MC_VERSION=${MC_VERSION:-1.21.4} /opt/homebrew/opt/node@22/bin/node src/llm-agent/cli.mjs",
"llm-agent:verify-live": "node scripts/verify-llm-agent-live.mjs"
```

Add `runtime/llm-agent-state/` to `.gitignore`; the state survives restarts locally but never enters a commit.

- [ ] **Step 4: Run focused and full tests**

Run: `node --test test/llm-agent-live-host.test.mjs`

Expected: PASS.

Run: `node --test test/*.test.mjs`

Expected: all tests PASS.

- [ ] **Step 5: Commit the live host**

```bash
git add src/llm-agent/live-host.mjs src/llm-agent/cli.mjs test/llm-agent-live-host.test.mjs package.json .gitignore
git commit -m "feat: compose isolated live LLM agent host"
```

### Task 7: Real-Server Evidence Reporter and Operations Guide

**Files:**
- Create: `scripts/verify-llm-agent-live.mjs`
- Create: `docs/llm-agent-operations.md`
- Test: `test/llm-agent-live-verifier.test.mjs`

**Interfaces:**
- Produces: `evaluateLiveEvidence({ state }) -> { ok, checks, classification }`
- Classification is exactly `real-server-evidence` or `not-verified`
- CLI reads one persisted actor-state path containing the controller's latest live observation; it never mutates the world

- [ ] **Step 1: Write failing evidence tests**

Require `succeeded` state, a verified mined-log milestone, an `oak_log` above the same gold target, non-simulated observation metadata, and at least one successful action receipt. Prove that mock-only, stale, or mismatched evidence returns `not-verified`.

```js
assert.deepEqual(evaluateLiveEvidence({ state }), {
  ok: true,
  classification: 'real-server-evidence',
  checks: {
    controllerSucceeded: true,
    minedOakLog: true,
    oakLogAboveGoldMarker: true,
    liveObservation: true
  }
});
```

- [ ] **Step 2: Run the tests and confirm the expected failure**

Run: `node --test test/llm-agent-live-verifier.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the reporter and exact operator guide**

Document these phases with copyable commands and expected output:

1. run `npm test`;
2. start the Minecraft server with `npm run server`;
3. prepare an isolated area containing reachable oak and one gold marker;
4. start the actor with `npm run llm-agent`;
5. in Minecraft chat as `VPNAJ`, type `agent status`, then `agent start`;
6. validate each action individually with a test-provider mode before enabling Codex;
7. run the complete goal, stop/restart/resume midway, and repeat successful complete runs;
8. immediately after the terminal status, run `npm run llm-agent:verify-live -- runtime/llm-agent-state/LlmAgent.json`.

Explicitly label Minecraft chat commands as having no leading `/`. Include recovery for provider timeout, invalid state, actor death, disconnect, and `agent reset`. State that the verifier cannot convert mocked evidence into real-server evidence.

- [ ] **Step 4: Run focused and full automated verification**

Run: `node --test test/llm-agent-live-verifier.test.mjs`

Expected: PASS.

Run: `npm test`

Expected: all tests PASS with zero failures.

- [ ] **Step 5: Commit live-validation tooling and documentation**

```bash
git add scripts/verify-llm-agent-live.mjs docs/llm-agent-operations.md test/llm-agent-live-verifier.test.mjs
git commit -m "docs: add incremental LLM agent live validation"
```

### Task 8: Execute the Incremental Real-World Validation Gate

**Files:**
- Modify: `docs/llm-agent-operations.md` only after measured evidence exists
- Runtime evidence (not committed): `runtime/llm-agent-state/`

**Interfaces:**
- Consumes: all previous tasks and the real Minecraft 1.21.4 server
- Produces: an evidence section recording date, actor, run ID, exact commands, checks, failures, and result classification

- [ ] **Step 1: Re-run automated tests immediately before live work**

Run: `npm test`

Expected: all tests PASS. If any test fails, stop; do not start a live run.

- [ ] **Step 2: Validate real connection and observation only**

Start the server and actor using the operations guide. As `VPNAJ`, type `agent status` in Minecraft chat with no `/`.

Expected: the distinct LLM actor is online, reports `idle`, sees compact target IDs, and exposes no raw coordinates to the provider context.

- [ ] **Step 3: Validate each real action separately**

Use the documented deterministic test-provider sequence to exercise `observe`, `move_to_block`, `mine_block`, `select_item`, `place_on_block`, and `finish`, resetting the isolated area between destructive checks.

Expected: every receipt matches a fresh world/inventory observation. Record any failure exactly; do not continue to the autonomous run until all six actions pass.

- [ ] **Step 4: Run one autonomous goal and one restart-resume goal**

In Minecraft chat as `VPNAJ`, type `agent start`. For the restart case, type `agent stop`, close only the LLM agent host, restart it, type `agent resume`, and wait for a terminal status.

Expected: both runs reach controller-verified `succeeded` within 12 decisions, and persisted LLM summary/plan/variables survive the restart.

- [ ] **Step 5: Run the evidence reporter and document the measured result**

Run: `npm run llm-agent:verify-live -- runtime/llm-agent-state/LlmAgent.json`

Expected: `classification=real-server-evidence` and exit code 0. If not, document `not-verified` and the exact failed checks; do not claim the proof of concept works.

- [ ] **Step 6: Commit only durable evidence documentation**

```bash
git add docs/llm-agent-operations.md
git commit -m "test: record LLM agent real-server validation"
```

Do not commit secrets, Codex prompts containing sensitive data, transient state files, world data, or absolute temporary paths.

# Generated Goal Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a persistent two-LLM Minecraft pipeline in which a slow LLM generates bounded goal contracts one step ahead while a fast LLM executes and deterministically verifies the active survival goal.

**Architecture:** Add an isolated `llm-goal-pipeline` subsystem beside the compatible legacy `llm-agent` and `llm-director` systems. Code-owned registries and a deterministic compiler turn slow-LLM proposals into frozen contracts; a supervisor permits one active contract and one speculative successor, while a pipeline-specific fast runner and survival adapter execute only approved primitives and produce live proof.

**Tech Stack:** Node.js 22 ESM, `node:test`, Mineflayer 4.32, mineflayer-pathfinder, Codex CLI structured output, atomic JSON state files.

**Spec:** `docs/superpowers/specs/2026-08-29-generated-goal-pipeline-design.md`

## Global Constraints

- The slow LLM generates contracts but never executes Minecraft actions or defines code, commands, capabilities, predicates, or verifiers.
- Exactly one active contract, one speculative successor, one slow request, and one fast request may exist.
- Contract maxima are 16 predicates at Boolean depth 3, eight constraints, eight capabilities, 40 actions, five replans, 300 seconds, 64-block search radius, and 128-block travel radius.
- Text maxima are 300 objective characters, 500 rationale/summary characters, 200 question characters, and 80 characters per choice label.
- Session ceilings are 90 minutes, ten completed goals, 20 slow calls, 400 fast calls, three consecutive goal failures, three consecutive generation failures, five outcomes, and ten failure fences.
- One question may contain two or three choices, use a safe default, and remain pending for no more than 30 seconds.
- Unknown fields and IDs, raw coordinates, commands, code, protected resources, contradictions, stale fences, and unverifiable success conditions fail closed.
- Only live Mineflayer observations and deterministic predicates may establish action or goal success.
- Mission changes, stop, death, disconnect, timeout, and restart must fence late work and preserve bounded state.
- Existing `agent ...` and `director ...` behavior must remain compatible and cannot overlap the new pipeline runtime.
- Run tests with `/opt/homebrew/opt/node@22/bin/node --test test/*.test.mjs`; never use broad `node --test` in this repository.
- Live validation is user-gated, occurs in a fresh isolated survival area, and requires independent server-console evidence.

---

### Task 1: Generated Contract Schema and Code-Owned Registries

**Files:**
- Create: `src/llm-goal-pipeline/contracts.mjs`
- Create: `src/llm-goal-pipeline/registry.mjs`
- Test: `test/llm-goal-pipeline-contracts.test.mjs`
- Test: `test/llm-goal-pipeline-registry.test.mjs`

**Interfaces:**
- Produces: `validateGeneratedContract(value, fences)`, `createContractRequestFences(input)`, `CAPABILITY_IDS`, `PREDICATE_IDS`, `CONSTRAINT_IDS`, `resolveCapability(id)`, `resolvePredicate(id)`, and `resolveConstraint(id)`.
- Contract predicates use `{ predicate, ...parameters }`; Boolean expressions use exactly one of `{ all: [...] }`, `{ any: [...] }`, or `{ not: expression }`.

- [x] **Step 1: Write failing contract and registry tests**

```js
const fences = createContractRequestFences({
  contractId: 'contract-1', missionVersion: 4, observationVersion: 9,
  predecessorContractId: 'contract-0', registryVersion: 1
});
const contract = validContract({ fences, objective: 'retain eight cobblestone' });
assert.equal(validateGeneratedContract(contract, fences).budget.maximumActions, 30);
assert.throws(() => validateGeneratedContract({ ...contract, rawCommand: '/give @s stone' }, fences),
  { code: 'PIPELINE_CONTRACT_INVALID' });
assert.throws(() => resolveCapability('shell'), { code: 'PIPELINE_REGISTRY_UNKNOWN' });
```

Cover exact fields, all string/array/numeric maxima, depth 3 versus 4, 16 versus 17 predicates, duplicate IDs, raw coordinate-shaped fields recursively, two/three versus four choices, timeout 30 versus 31, frozen detached outputs, and registry immutability.

- [x] **Step 2: Run the tests and verify RED**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/llm-goal-pipeline-contracts.test.mjs test/llm-goal-pipeline-registry.test.mjs`

Expected: FAIL because `src/llm-goal-pipeline/contracts.mjs` and `registry.mjs` do not exist.

- [x] **Step 3: Implement the exact schema and registry metadata**

```js
export const CONTRACT_LIMITS = Object.freeze({
  predicates: 16, booleanDepth: 3, constraints: 8, capabilities: 8,
  actions: 40, replans: 5, seconds: 300, searchRadius: 64, travelRadius: 128
});

const CAPABILITIES = new Map([
  ['observe', { actionKinds: ['observe'] }],
  ['navigate', { actionKinds: ['navigate_to_target', 'navigate_to_landmark'] }],
  ['mine_block', { actionKinds: ['mine_target'] }],
  ['collect_item', { actionKinds: ['collect_drop'] }],
  ['craft_recipe', { actionKinds: ['craft_recipe'] }],
  ['place_block', { actionKinds: ['place_against_target'] }],
  ['equip_item', { actionKinds: ['equip_item'] }],
  ['consume_food', { actionKinds: ['consume_item'] }]
]);
```

Also register `attack_hostile`, `retreat`, and `speak`; register the predicates and constraints named in the spec with exact parameter schemas. Keep registry entries declarative; execution functions arrive in Task 6.

- [x] **Step 4: Run focused tests and verify GREEN**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/llm-goal-pipeline-contracts.test.mjs test/llm-goal-pipeline-registry.test.mjs`

Expected: PASS with zero failures.

- [x] **Step 5: Commit Task 1**

```bash
git add src/llm-goal-pipeline/contracts.mjs src/llm-goal-pipeline/registry.mjs test/llm-goal-pipeline-contracts.test.mjs test/llm-goal-pipeline-registry.test.mjs
git commit -m "feat: define generated minecraft goal contracts"
```

---

### Task 2: Deterministic Contract Compiler and Predicate Evaluation

**Files:**
- Create: `src/llm-goal-pipeline/compiler.mjs`
- Create: `src/llm-goal-pipeline/predicates.mjs`
- Test: `test/llm-goal-pipeline-compiler.test.mjs`
- Test: `test/llm-goal-pipeline-predicates.test.mjs`

**Interfaces:**
- Consumes: Task 1 contract validation and registry resolvers.
- Produces: `compileGeneratedContract({ proposal, fences, snapshot, permissions, remainingLimits }) -> frozenContract` and `evaluateExpression(expression, snapshot, context) -> { ok, facts, proofKinds }`.

- [x] **Step 1: Write failing compiler and predicate tests**

```js
const compiled = compileGeneratedContract({
  proposal: cobblestoneProposal(), fences, snapshot: survivalSnapshot(),
  permissions: survivalPermissions(), remainingLimits: sessionLimits()
});
assert.deepEqual(compiled.authority.capabilities, ['collect_item', 'mine_block', 'navigate', 'observe']);
assert.deepEqual(evaluateExpression(compiled.success, snapshotWithCobblestone(8), { outcomes: [] }), {
  ok: true,
  facts: [{ predicate: 'inventory_at_least', item: 'cobblestone', actual: 8, required: 8 }],
  proofKinds: ['inventory_at_least:cobblestone']
});
```

Reject unsupported success predicates, success that cannot be reached by requested capabilities, protected resources, conflicting `all` leaves, stale fences, budgets above remaining session limits, and prerequisite failures. Assert no clamp occurs.

- [x] **Step 2: Run focused tests and verify RED**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/llm-goal-pipeline-compiler.test.mjs test/llm-goal-pipeline-predicates.test.mjs`

Expected: FAIL because compiler and evaluator modules do not exist.

- [x] **Step 3: Implement pure predicate evaluation**

```js
export function evaluateExpression(expression, snapshot, context = {}) {
  if (expression.all) return combineAll(expression.all.map((entry) => evaluateExpression(entry, snapshot, context)));
  if (expression.any) return combineAny(expression.any.map((entry) => evaluateExpression(entry, snapshot, context)));
  if (expression.not) return invert(evaluateExpression(expression.not, snapshot, context));
  return evaluateLeaf(resolvePredicate(expression.predicate), expression, snapshot, context);
}
```

Return controller-owned facts only. Never copy untrusted proposal prose into proof objects.

- [x] **Step 4: Implement deterministic compilation**

```js
export function compileGeneratedContract(input) {
  const proposal = validateGeneratedContract(input.proposal, input.fences);
  assertRemainingBudgets(proposal.budget, input.remainingLimits);
  const authority = resolveAuthority(proposal, input.permissions);
  assertNoContradictions(proposal.prerequisites, proposal.success);
  assertSuccessSupported(proposal.success, authority);
  const prerequisite = evaluateExpression(proposal.prerequisites, input.snapshot, input.context);
  if (!prerequisite.ok) throw coded('PIPELINE_PREREQUISITE_UNMET', 'generated contract prerequisites are not met');
  return deepFreeze({ ...proposal, authority, compiledAt: input.fences.now });
}
```

- [x] **Step 5: Run focused tests and verify GREEN**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/llm-goal-pipeline-compiler.test.mjs test/llm-goal-pipeline-predicates.test.mjs`

Expected: PASS with zero failures.

- [x] **Step 6: Commit Task 2**

```bash
git add src/llm-goal-pipeline/compiler.mjs src/llm-goal-pipeline/predicates.mjs test/llm-goal-pipeline-compiler.test.mjs test/llm-goal-pipeline-predicates.test.mjs
git commit -m "feat: compile and verify generated goal contracts"
```

---

### Task 3: Persistent Supervisor State, Leases, and Budget Accounting

**Files:**
- Create: `src/llm-goal-pipeline/state.mjs`
- Create: `src/llm-goal-pipeline/state-store.mjs`
- Test: `test/llm-goal-pipeline-state.test.mjs`
- Test: `test/llm-goal-pipeline-state-store.test.mjs`

**Interfaces:**
- Produces: `createInitialPipelineState({ actorId, mission, now })`, `validatePipelineState(value)`, and `createPipelineStateStore({ directory, fsImpl })` with `load`, `save`, `reset`, `acquireLease`, and `releaseLease`.

- [x] **Step 1: Write failing state and store tests**

```js
const state = createInitialPipelineState({ actorId: 'LlmAgent', mission: 'survive and progress', now });
assert.equal(state.mission.version, 1);
assert.equal(state.activeContract, null);
assert.equal(state.speculativeContract, null);
assert.equal(state.limits.maximumGoals, 10);
await store.save('LlmAgent', state);
assert.deepEqual(await store.load('LlmAgent'), state);
```

Test exact lifecycle states, five-outcome and ten-fence truncation, monotonic counters, no budget refresh on resume, atomic rename failure preserving prior state, path traversal rejection, stale/held leases, and schema-version rejection.

- [x] **Step 2: Run focused tests and verify RED**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/llm-goal-pipeline-state.test.mjs test/llm-goal-pipeline-state-store.test.mjs`

Expected: FAIL because state modules do not exist.

- [x] **Step 3: Implement validated compact state**

```js
export const PIPELINE_LIMITS = Object.freeze({
  maximumRuntimeMs: 5_400_000, maximumGoals: 10, maximumSlowCalls: 20,
  maximumFastCalls: 400, maximumGoalFailures: 3, maximumGenerationFailures: 3
});

export function createInitialPipelineState({ actorId, mission, now }) {
  return validatePipelineState({
    identity: { actorId, schemaVersion: 1 },
    mission: { text: mission, version: 1 }, lifecycle: { status: 'idle', updatedAt: now },
    activeContract: null, speculativeContract: null, pendingQuestion: null,
    outcomes: [], failureFences: [], counters: zeroCounters(), limits: PIPELINE_LIMITS,
    failure: null
  });
}
```

- [x] **Step 4: Implement atomic persistence and a 15-minute lease**

Follow `src/llm-director/state-store.mjs`: mode `0o600`, sibling temporary file, write, sync, close, rename, best-effort directory sync, and exact owner release. Set maximum lease duration to 900,000 ms and validate all timestamps.

- [x] **Step 5: Run focused tests and verify GREEN**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/llm-goal-pipeline-state.test.mjs test/llm-goal-pipeline-state-store.test.mjs`

Expected: PASS with zero failures.

- [x] **Step 6: Commit Task 3**

```bash
git add src/llm-goal-pipeline/state.mjs src/llm-goal-pipeline/state-store.mjs test/llm-goal-pipeline-state.test.mjs test/llm-goal-pipeline-state-store.test.mjs
git commit -m "feat: persist generated goal pipeline state"
```

---

### Task 4: Hardened Slow-LLM Contract Provider

**Files:**
- Create: `src/llm-goal-pipeline/slow-provider.mjs`
- Create: `src/llm-goal-pipeline/scripted-slow-provider.mjs`
- Test: `test/llm-goal-pipeline-slow-provider.test.mjs`

**Interfaces:**
- Consumes: Task 1 JSON schema and request fences.
- Produces: `createSlowContractProvider({ codexBin, timeoutMs, tempDirectory, spawnImpl })` exposing `generate(context, { signal })`, and `createScriptedSlowProvider(proposals)`.

- [x] **Step 1: Write failing provider tests**

```js
const proposal = await provider.generate(context, { signal });
assert.equal(proposal.contractId, context.fences.contractId);
assert.deepEqual(spawned.args.slice(0, 5), ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox']);
assert.equal(spawned.args[5], 'read-only');
```

Assert stdin-only prompt delivery, exact output schema file, no external tools, 64 KiB stdout/stderr/output ceilings, 90-second timeout, abort termination, cleanup after child close, nonzero exit handling, malformed output failure, and scripted exhaustion.

- [x] **Step 2: Run provider tests and verify RED**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/llm-goal-pipeline-slow-provider.test.mjs`

Expected: FAIL because the providers do not exist.

- [x] **Step 3: Implement the slow provider by adapting the proven director transport**

```js
export function createSlowContractProvider({ codexBin, timeoutMs = 90_000, tempDirectory, spawnImpl = spawn }) {
  if (timeoutMs !== 90_000) throw new TypeError('slow provider timeout must be 90000 ms');
  return Object.freeze({
    async generate(context, { signal } = {}) {
      const files = await createInvocationFiles(tempDirectory, generatedContractJsonSchema(context.fences));
      try {
        await runCodex({ codexBin, files, prompt: buildContractPrompt(context), signal, spawnImpl, timeoutMs });
        return parseBoundedOutput(await readFile(files.output, 'utf8'));
      } finally {
        await cleanupInvocationFiles(files);
      }
    }
  });
}
```

The prompt includes only compact mission state, active contract/expected outcome, five outcomes, approved vocabulary summaries, remaining budgets, and opaque target/landmark facts.

- [x] **Step 4: Run provider tests and verify GREEN**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/llm-goal-pipeline-slow-provider.test.mjs`

Expected: PASS with zero failures.

- [x] **Step 5: Commit Task 4**

```bash
git add src/llm-goal-pipeline/slow-provider.mjs src/llm-goal-pipeline/scripted-slow-provider.mjs test/llm-goal-pipeline-slow-provider.test.mjs
git commit -m "feat: generate bounded goals with slow llm"
```

---

### Task 5: Generic Fast Decision Provider and Contract Runner

**Files:**
- Create: `src/llm-goal-pipeline/fast-contracts.mjs`
- Create: `src/llm-goal-pipeline/fast-provider.mjs`
- Create: `src/llm-goal-pipeline/fast-runner.mjs`
- Test: `test/llm-goal-pipeline-fast-contracts.test.mjs`
- Test: `test/llm-goal-pipeline-fast-provider.test.mjs`
- Test: `test/llm-goal-pipeline-fast-runner.test.mjs`

**Interfaces:**
- Produces: `validateFastDecision(value, context)`, `createFastProvider(...)`, and `createFastRunner({ actorId, provider, adapter, evaluateSuccess, limits })` with `run(contract, { signal, onTransition })`, `stop(reason)`, and `status()`.
- Adapter port: `observe`, `execute`, `verifyAction`, `isConnected`, and `cancel`.

- [x] **Step 1: Write failing fast contract/provider tests**

```js
const decision = validateFastDecision({
  decision: 'act', action: { kind: 'mine_target', targetId: 'target-2' },
  summary: 'Mine the reachable stone target.', plan: ['collect the drop']
}, contextAllowing('mine_block'));
assert.equal(decision.action.kind, 'mine_target');
assert.throws(() => validateFastDecision({ ...decision, action: { kind: 'shell' } }, contextAllowing('mine_block')),
  { code: 'PIPELINE_FAST_DECISION_INVALID' });
```

Test capability/action matching, opaque current-observation target IDs, recipe/item allowlists, no coordinates, exact fields, 30-second provider timeout, 64 KiB ceilings, abort, cleanup, and no fallback actions.

- [x] **Step 2: Write failing fast runner tests**

```js
const result = await runner.run(contract, { signal, onTransition: (event) => events.push(event) });
assert.equal(result.status, 'succeeded');
assert.deepEqual(events.map((event) => event.phase), ['observing', 'deciding', 'acting', 'verifying_action', 'verifying_goal']);
assert.equal(adapter.executions.length, 1);
```

Cover pre-action observations, one decision/one action, post-action verification, success only from predicate evaluation, 40-action/5-replan/300-second ceilings, three identical failure fencing, stop/death/disconnect abort, stale observation rejection, and late results ignored.

- [x] **Step 3: Run fast tests and verify RED**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/llm-goal-pipeline-fast-contracts.test.mjs test/llm-goal-pipeline-fast-provider.test.mjs test/llm-goal-pipeline-fast-runner.test.mjs`

Expected: FAIL because the fast pipeline modules do not exist.

- [x] **Step 4: Implement exact fast decisions and the hardened provider**

```js
export function validateFastDecision(value, context) {
  exact(value, ['decision', 'action', 'summary', 'plan']);
  if (!new Set(['act', 'finish', 'fail']).has(value.decision)) invalid('decision');
  if (value.decision === 'act') validateActionAgainstContract(value.action, context);
  else if (value.action !== null) invalid('terminal action must be null');
  return deepFreeze(structuredClone(value));
}
```

Use the same isolated Codex CLI transport requirements as Task 4, with a 30,000 ms timeout and a fast-decision-only JSON schema.

- [x] **Step 5: Implement the serialized runner**

```js
async function run(contract, { signal, onTransition = () => {} } = {}) {
  const deadline = monotonicNow() + contract.budget.maximumSeconds * 1000;
  for (let turn = 0; turn < contract.budget.maximumActions; turn += 1) {
    const before = await adapter.observe({ signal, contract });
    const success = evaluateSuccess(contract.success, before);
    if (success.ok) return terminal('succeeded', success);
    const decision = validateFastDecision(await provider.decide(buildContext(contract, before), { signal }), buildAuthority(contract, before));
    if (decision.decision !== 'act') return verifyTerminalDecision(decision, contract, before);
    const receipt = await adapter.execute(decision.action, { signal, contract, before });
    const after = await adapter.observe({ signal, contract });
    record(await adapter.verifyAction(decision.action, receipt, before, after, { contract }));
    enforceDeadlineAndFailures(deadline);
  }
  return terminal('failed', proof('PIPELINE_ACTION_LIMIT'));
}
```

- [x] **Step 6: Run fast tests and verify GREEN**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/llm-goal-pipeline-fast-contracts.test.mjs test/llm-goal-pipeline-fast-provider.test.mjs test/llm-goal-pipeline-fast-runner.test.mjs`

Expected: PASS with zero failures.

- [x] **Step 7: Commit Task 5**

```bash
git add src/llm-goal-pipeline/fast-contracts.mjs src/llm-goal-pipeline/fast-provider.mjs src/llm-goal-pipeline/fast-runner.mjs test/llm-goal-pipeline-fast-contracts.test.mjs test/llm-goal-pipeline-fast-provider.test.mjs test/llm-goal-pipeline-fast-runner.test.mjs
git commit -m "feat: execute generated goals with fast llm"
```

---

### Task 6: Survival Observation and Capability Adapter

**Files:**
- Create: `src/llm-goal-pipeline/survival-adapter.mjs`
- Create: `src/llm-goal-pipeline/survival-permissions.mjs`
- Test: `test/llm-goal-pipeline-survival-adapter.test.mjs`

**Interfaces:**
- Consumes: Task 1 registry IDs and Task 5 adapter port.
- Produces: `createSurvivalAdapter({ bot, goals, Movements, permissions })` and `createDefaultSurvivalPermissions({ origin, protectedRegions })`.

- [x] **Step 1: Write failing observation and permission tests**

```js
const snapshot = await adapter.observe({ contract, signal });
assert.deepEqual(snapshot.inventory, [{ item: 'oak_log', count: 2 }]);
assert.equal(snapshot.targets[0].id, 'observation-1-target-1');
assert.equal(Object.hasOwn(snapshot.targets[0], 'position'), false);
assert.equal(snapshot.recipes.includes('oak_planks'), true);
```

Test bounded nearest targets, target-ID rotation each observation, health/hunger/time/dimension/region, recipe facts, item drops, named landmarks, protected-region exclusion, 64-block search and 128-block origin bounds, and finite-number validation.

- [x] **Step 2: Write failing action and proof tests**

Test navigation without digging, mining only a current permitted target, pickup count increase, crafting exact recipe deltas, placing against a current target, equip/consume deltas, hostile-only attack, retreat to a safe landmark, abort cleanup, and contradiction-resistant post-action verification.

```js
const receipt = await adapter.execute({ kind: 'craft_recipe', recipe: 'oak_planks', count: 4 }, { contract, before, signal });
const after = await adapter.observe({ contract, signal });
assert.deepEqual(await adapter.verifyAction(receipt.request, receipt, before, after, { contract }), {
  ok: true, code: 'CRAFT_VERIFIED', facts: [{ item: 'oak_planks', delta: 4 }]
});
```

- [x] **Step 3: Run adapter tests and verify RED**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/llm-goal-pipeline-survival-adapter.test.mjs`

Expected: FAIL because survival adapter modules do not exist.

- [x] **Step 4: Implement compact observations and permissions**

```js
export function createDefaultSurvivalPermissions({ origin, protectedRegions = [] }) {
  return deepFreeze({
    origin: integerPosition(origin), maximumTravelRadius: 128, maximumSearchRadius: 64,
    mineableBlocks: ['oak_log', 'stone', 'cobblestone'],
    placeableBlocks: ['crafting_table'],
    recipes: ['oak_planks', 'stick', 'crafting_table', 'wooden_pickaxe', 'stone_pickaxe'],
    protectedRegions: protectedRegions.map(validateRegion), attackableEntities: HOSTILE_ENTITY_IDS
  });
}
```

Use opaque IDs publicly and keep positions only in controller-owned maps scoped to one observation version.

- [x] **Step 5: Implement survival actions and deterministic verification**

Reuse proven movement/abort patterns from `src/llm-agent/minecraft-adapter.mjs`, but route every action through compiled authority and permission checks. Craft through Mineflayer recipe lookup, table proximity, and exact before/after inventory proof. Never accept the Mineflayer method return value as sufficient proof.

- [x] **Step 6: Run adapter tests and verify GREEN**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/llm-goal-pipeline-survival-adapter.test.mjs`

Expected: PASS with zero failures.

- [x] **Step 7: Commit Task 6**

```bash
git add src/llm-goal-pipeline/survival-adapter.mjs src/llm-goal-pipeline/survival-permissions.mjs test/llm-goal-pipeline-survival-adapter.test.mjs
git commit -m "feat: add bounded survival capabilities"
```

---

### Task 7: Concurrent Supervisor and Speculative Promotion

**Files:**
- Create: `src/llm-goal-pipeline/supervisor.mjs`
- Test: `test/llm-goal-pipeline-supervisor.test.mjs`
- Test: `test/llm-goal-pipeline-concurrency.test.mjs`

**Interfaces:**
- Consumes: state store, slow provider, compiler, fast runner, adapter snapshot port.
- Produces: `createGoalPipelineSupervisor(dependencies)` with `start({ mission })`, `updateMission(text, { urgent })`, `answer(choiceId)`, `status()`, `stop(reason)`, `resume()`, `reset()`, and `awaitIdle()`.

- [x] **Step 1: Write failing lifecycle and concurrency tests**

```js
const run = supervisor.start({ mission: 'reach stone tools' });
await gates.firstFastStarted;
assert.equal(slow.calls.length, 2);
assert.equal((await supervisor.status()).activeContract.status, 'executing');
assert.equal((await supervisor.status()).speculativeContract.status, 'speculative');
gates.finishFirstFast.succeed(firstProof);
await gates.secondFastStarted;
assert.equal(fast.runs[1].contractId, slow.proposals[1].contractId);
await run;
```

Assert one-active/one-speculative bounds under reentrancy, speculative generation overlaps fast execution, promotion requires matching predecessor proof and fresh prerequisites, stale draft discard, no third generation, outcome cap five, and global ceilings.

- [x] **Step 2: Write failing mission, stop, question, and recovery tests**

Cover normal mission update finishing the active goal, urgent update aborting it, exact question choices/default timeout, unauthorized/late answer rejection, death/disconnect stop, slow failure while fast continues, fast failure recovery generation, restart reconciliation, lease exclusion, and late provider/runner completion fencing.

- [x] **Step 3: Run supervisor tests and verify RED**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/llm-goal-pipeline-supervisor.test.mjs test/llm-goal-pipeline-concurrency.test.mjs`

Expected: FAIL because the supervisor does not exist.

- [x] **Step 4: Implement one serialized authority queue with separate abort controllers**

```js
function enqueue(operation) {
  const result = queue.then(operation, operation);
  queue = result.catch(() => {});
  return result;
}

async function promoteOrRegenerate(terminalOutcome) {
  return enqueue(async () => {
    const snapshot = await adapter.observe({ signal: supervisorSignal });
    if (canPromote(state.speculativeContract, terminalOutcome, snapshot, state)) {
      state = transitionToReady(state, state.speculativeContract, terminalOutcome);
    } else {
      state = discardSpeculative(state, 'predecessor or prerequisite changed');
    }
    await store.save(actorId, state);
    scheduleWork();
  });
}
```

Do not await slow generation while holding the state queue. Capture fences, launch work, then enqueue the result and compare every fence before persistence.

- [x] **Step 5: Implement question/default and mission/recovery transitions**

Use supervisor-owned timers and exact choice IDs. Normal mission changes abort only slow/speculative work; urgent changes and stop abort slow and fast work. Resume never resets counters and begins with a fresh observation.

- [x] **Step 6: Run supervisor tests and verify GREEN**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/llm-goal-pipeline-supervisor.test.mjs test/llm-goal-pipeline-concurrency.test.mjs`

Expected: PASS with zero failures and no leaked timers or handles.

- [x] **Step 7: Commit Task 7**

```bash
git add src/llm-goal-pipeline/supervisor.mjs test/llm-goal-pipeline-supervisor.test.mjs test/llm-goal-pipeline-concurrency.test.mjs
git commit -m "feat: pipeline generated minecraft goals"
```

---

### Task 8: Live Runtime, Authorized Chat, and CLI Composition

**Files:**
- Create: `src/llm-goal-pipeline/live-runtime.mjs`
- Modify: `src/llm-agent/live-host.mjs`
- Modify: `src/llm-agent/cli.mjs`
- Test: `test/llm-goal-pipeline-live-runtime.test.mjs`
- Modify: `test/llm-agent-live-host.test.mjs`

**Interfaces:**
- Produces one shared-bot runtime and exact authorized commands: `pipeline start`, `pipeline status`, `pipeline stop`, `pipeline resume`, `pipeline reset`, `pipeline mission <bounded text>`, `pipeline urgent <bounded text>`, and `pipeline answer <choiceId>`.

- [x] **Step 1: Write failing live composition and command tests**

```js
bot.emit('chat', 'VPNAJ', 'pipeline start');
await host.flush();
assert.deepEqual(supervisor.calls[0], { method: 'start', mission: configuredMission });
bot.emit('chat', 'OtherPlayer', 'pipeline stop');
assert.equal(supervisor.calls.length, 1);
```

Assert exact lowercase command parsing, only `VPNAJ`, 300-character mission limit, no slash, duplicate starts serialized, concise status/question messages, legacy agent/director and pipeline mutual exclusion, stop/death/disconnect propagation, listener cleanup, and shutdown lease release.

- [x] **Step 2: Run live tests and verify RED**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/llm-goal-pipeline-live-runtime.test.mjs test/llm-agent-live-host.test.mjs`

Expected: FAIL because pipeline live modules and commands do not exist.

- [x] **Step 3: Compose one bot, adapter, stores, providers, runner, and supervisor**

```js
const pipeline = createGoalPipelineLiveRuntime({
  actorId, bot, adapter: createSurvivalAdapter({ bot, goals, Movements, permissions }),
  store: createPipelineStateStore({ directory: pipelineStateDirectory }),
  slowProvider: createSlowContractProvider({ codexBin, timeoutMs: 90_000, tempDirectory: slowTemp }),
  fastProvider: createFastProvider({ codexBin, timeoutMs: 30_000, tempDirectory: fastTemp })
});
```

Default pipeline mission is `survive and progress toward stone tools`. State directory is `runtime/llm-goal-pipeline-state`. The existing `npm run llm-agent` process owns the one `LlmAgent` Mineflayer connection and exposes legacy agent, one-shot director, and pipeline commands; do not add a second bot CLI.

- [x] **Step 4: Implement authorized chat and mutual exclusion**

Route each exact command through one host queue. Reject pipeline start while legacy agent/director work is active and reject legacy starts while the pipeline is active. Chat never carries raw JSON or executable contracts.

- [x] **Step 5: Run live tests and verify GREEN**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/llm-goal-pipeline-live-runtime.test.mjs test/llm-agent-live-host.test.mjs`

Expected: PASS with zero failures.

- [x] **Step 6: Commit Task 8**

```bash
git add src/llm-goal-pipeline/live-runtime.mjs src/llm-agent/live-host.mjs src/llm-agent/cli.mjs test/llm-goal-pipeline-live-runtime.test.mjs test/llm-agent-live-host.test.mjs
git commit -m "feat: expose generated goal pipeline in minecraft"
```

---

### Task 9: Operations, Full Regression, and User-Gated Live Acceptance

**Files:**
- Create: `scripts/verify-llm-goal-pipeline-live.mjs`
- Test: `test/llm-goal-pipeline-live-verifier.test.mjs`
- Modify: `docs/llm-agent-operations.md`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-08-29-generated-goal-pipeline.md`

**Interfaces:**
- Produces a read-only verifier that requires paired slow/fast/supervisor state plus an independently supplied server-world check.

- [x] **Step 1: Write failing live-verifier tests**

```js
const result = evaluatePipelineLiveEvidence({ pipelineState, actorEvidence, worldCheck: true });
assert.equal(result.ok, true);
assert.equal(result.checks.twoConsecutiveGoals, true);
assert.equal(result.checks.speculationOverlappedExecution, true);
assert.equal(result.checks.freshPromotionValidation, true);
```

Reject scripted/simulated evidence, mismatched run or contract IDs, fewer than two goals, successor generated after predecessor completion, stale promotion, missing inventory/world proof, exceeded limits, a third unverified goal, and absent independent world check.

- [x] **Step 2: Run verifier test and verify RED**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/llm-goal-pipeline-live-verifier.test.mjs`

Expected: FAIL because the verifier does not exist.

- [x] **Step 3: Implement verifier and operations documentation**

```js
export function evaluatePipelineLiveEvidence({ pipelineState, actorEvidence, worldCheck = false }) {
  const checks = {
    supervisorSucceeded: terminalMilestoneReached(pipelineState, 'stone_pickaxe'),
    twoConsecutiveGoals: matchingVerifiedOutcomes(pipelineState).length >= 2,
    speculationOverlappedExecution: hasControllerOwnedOverlapEvidence(pipelineState),
    freshPromotionValidation: allPromotionsHaveFreshObservation(pipelineState),
    liveFastEvidence: validLiveActorEvidence(actorEvidence, pipelineState),
    withinLimits: countersWithinLimits(pipelineState),
    serverWorldVerified: worldCheck === true
  };
  return { ok: Object.values(checks).every(Boolean), checks };
}
```

Document exact commands, state paths, normal/urgent mission updates, questions, limits, safe shutdown, failure recovery, and the fact that tests are not live proof.

- [x] **Step 4: Run focused pipeline tests**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/llm-goal-pipeline-*.test.mjs`

Expected: all pipeline tests PASS with zero failures, cancellations, or skips.

- [x] **Step 5: Run the complete regression suite**

Run: `/opt/homebrew/opt/node@22/bin/node --test test/*.test.mjs`

Expected: all tests PASS with zero failures, cancellations, or skipped pipeline tests.

- [x] **Step 6: Commit automated completion**

```bash
git add scripts/verify-llm-goal-pipeline-live.mjs test/llm-goal-pipeline-live-verifier.test.mjs docs/llm-agent-operations.md README.md docs/superpowers/plans/2026-08-29-generated-goal-pipeline.md
git commit -m "docs: add generated pipeline live validation"
```

- [ ] **Step 7: Prepare a fresh isolated survival validation area**

Use the server console to create and inspect an area separate from the meadow and prior gold-marker test. Record the bounded origin and protected regions in the live configuration. Confirm safe ground/headroom, reachable oak, reachable stone, empty actor inventory, no nearby hazards, `VPNAJ` online, and exactly one `LlmAgent` runtime.

- [ ] **Step 8: Wait for the user-gated start command**

The user presses `T` and types this exact Minecraft chat text with no slash:

```text
pipeline start
```

Do not send the command from the server console or on the user's behalf.

- [ ] **Step 9: Monitor the live pipeline to the stone-pickaxe milestone**

Record contract IDs, actor run IDs, generation/start/finish timestamps, promotion observation versions, compact verified outcomes, questions/defaults, and counters. Stop immediately on death, disconnect, protected-resource attempt, stale promotion, or evidence mismatch.

- [ ] **Step 10: Verify independently and record evidence**

Use the server console to verify the actor inventory contains the milestone items and inspect relevant world changes. Then run:

```bash
LLM_PIPELINE_WORLD_CHECK=completed-ok /opt/homebrew/opt/node@22/bin/node scripts/verify-llm-goal-pipeline-live.mjs --phase completed
```

Expected: `ok: true`, at least two matching live outcomes, proven overlap, fresh promotions, all counters within limits, and independent world verification.

- [ ] **Step 11: Update operations evidence and rerun verification**

Add the exact UTC timestamp, contract/run IDs, console commands/results, verifier JSON, and limitations to `docs/llm-agent-operations.md`. Run the focused verifier test, full suite, completed verifier, and `git diff --check` again.

- [ ] **Step 12: Commit the live evidence checkpoint**

```bash
git add docs/llm-agent-operations.md docs/superpowers/plans/2026-08-29-generated-goal-pipeline.md
git commit -m "test: record generated survival pipeline evidence"
```

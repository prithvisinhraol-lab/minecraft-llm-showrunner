# Two-Actor Showrunner MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a safe, deterministic two-actor Minecraft dialogue-production loop with creator-approved dialogue, verified resets, retry fencing, OBS readiness, and auditable take artifacts.

**Architecture:** Add a focused `src/showrunner/` subsystem beside the existing experimental bots. A single state-machine process owns production state; non-op Mineflayer actor adapters and a separately privileged production adapter communicate through typed commands and causally fenced events. Rehearsal happens before runtime, and a take uses only approved dialogue variants or authored fallbacks.

**Tech Stack:** Node.js 22, ECMAScript modules, Node's built-in test runner, Mineflayer 4, mineflayer-pathfinder 2, `yaml` 2.x, NDJSON artifacts, Minecraft Java 1.21.4, and a real Minecraft client captured by OBS.

## Global Constraints

- Target Minecraft Java Edition `1.21.4`.
- Run tests with `npm test`, which is scoped to `node --test test/*.test.mjs`.
- The MVP contains one isolated static set, one scene, two actors, and two or three sequential cues.
- The MVP excludes block mutation, crafting, gathering, combat, persistent memory, durable continuity, TTS, subtitles, dashboards, dynamic cameras, multi-scene episodes, and live free improvisation.
- Actor accounts are non-operator and cannot execute chat commands, shell commands, generated code, RCON, or console operations.
- Player chat is untrusted observation, never a director-control channel.
- Only approved dialogue variants, exact lines, or authored fallbacks may be spoken during a take.
- Every command/event is fenced by production, take, scene, beat, attempt, and cue identity; stale or duplicate work cannot mutate active state.
- A retry revokes the attempt, cancels work, awaits quiescence, restores and verifies baseline, then creates a new attempt epoch.
- Recording readiness must precede the first cue, and a non-empty recording artifact must cover the take before acceptance.
- Existing experimental combat/build scripts remain available but are not imported by the showrunner.
- Never commit `.env`, server jars, world directories, logs, crash reports, user caches, or recording files.

---

## File Map

### Existing files to modify

- `.gitignore` — ignore runtime artifacts, recordings, local approvals, and world/server state while allowing safe source fixtures.
- `.env.example` — document showrunner actor, controller, artifact, and capture settings without secrets.
- `package.json` / `package-lock.json` — add YAML parsing and showrunner/rehearsal/security scripts.
- `README.md` — document the safe showrunner workflow and distinguish it from legacy chat-controlled experiments.
- `server/ops.json` — remove actor identities only after the migration tool has created a backup and verified the controller identity.

### New source modules

- `src/showrunner/errors.mjs` — stable typed error codes.
- `src/showrunner/schema.mjs` — versioned episode/profile/manifest validation and YAML source diagnostics.
- `src/showrunner/policy.mjs` — policy precedence and deterministic dialogue validation.
- `src/showrunner/rehearsal.mjs` — bounded candidate generation, provenance, and creator approval-bank creation.
- `src/showrunner/protocol.mjs` — command/event envelopes, IDs, epochs, sequencing, and idempotency.
- `src/showrunner/state-machine.mjs` — sole-writer showrunner transitions and cue scheduler.
- `src/showrunner/actor-runtime.mjs` — five-action non-op Mineflayer adapter.
- `src/showrunner/production-controller.mjs` — typed privileged commands with no free-text interpolation.
- `src/showrunner/baseline.mjs` — reset transaction and manifest verification.
- `src/showrunner/capture.mjs` — recording readiness/stop/artifact contract.
- `src/showrunner/artifacts.mjs` — atomic NDJSON, transcript, and final-status output.
- `src/showrunner/cli.mjs` — rehearsal, run, capture acknowledgement, accept, reject, and security commands.

### New authored fixtures

- `production/profiles/hero.yaml` and `production/profiles/rival.yaml` — initial style profiles.
- `production/episodes/stolen-map.yaml` — MVP two-cue scene.
- `production/sets/city-square-dialogue.v1.json` — static-set baseline manifest.
- `production/approvals/.gitkeep` — location for local approved line banks; bank contents remain take inputs and are ignored by default.

### New tests

- `test/showrunner-schema.test.mjs`
- `test/showrunner-policy.test.mjs`
- `test/showrunner-rehearsal.test.mjs`
- `test/showrunner-protocol.test.mjs`
- `test/showrunner-state-machine.test.mjs`
- `test/showrunner-actor-runtime.test.mjs`
- `test/showrunner-production-controller.test.mjs`
- `test/showrunner-baseline.test.mjs`
- `test/showrunner-capture.test.mjs`
- `test/showrunner-integration.test.mjs`

---

### Task 1: Establish a Reproducible Repository and Security Baseline

**Files:**
- Modify: `.gitignore`
- Modify: `.env.example`
- Modify: `package.json`
- Add: `package-lock.json`
- Create: `src/showrunner/security.mjs`
- Create: `test/showrunner-security.test.mjs`
- Runtime migration: `server/ops.json`

**Interfaces:**
- Produces: `planOperatorMigration(entries, { actorNames, controllerName }) -> { nextEntries, removedActors, controller }`
- Produces: `applyOperatorMigration(path, options) -> Promise<{ backupPath, result }>`

- [ ] **Step 1: Record the baseline before staging anything**

Run:

```bash
git status --short
git ls-files
npm test
```

Expected: the scoped tests pass; note all untracked source/configuration files. Do not stage world data, archives, jars, logs, credentials, or the broken lockfile backup.

- [ ] **Step 2: Write the failing operator-migration test**

```js
test('removes actor ops but preserves the named production controller', () => {
  const entries = [op('HeroActor'), op('RivalActor'), op('ProductionController'), op('HumanOwner')];
  const result = planOperatorMigration(entries, {
    actorNames: ['HeroActor', 'RivalActor'],
    controllerName: 'ProductionController'
  });
  assert.deepEqual(result.removedActors, ['HeroActor', 'RivalActor']);
  assert.equal(result.controller.name, 'ProductionController');
  assert.deepEqual(result.nextEntries.map((entry) => entry.name), ['ProductionController', 'HumanOwner']);
});

test('refuses migration when controller is absent or also listed as an actor', () => {
  assert.throws(() => planOperatorMigration([op('HumanOwner')], {
    actorNames: ['HeroActor'], controllerName: 'ProductionController'
  }), { code: 'CONTROLLER_NOT_OP' });
});
```

- [ ] **Step 3: Run the focused test and verify the missing-module failure**

Run: `node --test test/showrunner-security.test.mjs`

Expected: FAIL because `src/showrunner/security.mjs` does not exist.

- [ ] **Step 4: Implement the pure migration planner and atomic backup writer**

```js
export function planOperatorMigration(entries, { actorNames, controllerName }) {
  const actors = new Set(actorNames.map((name) => name.toLowerCase()));
  if (actors.has(controllerName.toLowerCase())) throw coded('CONTROLLER_IS_ACTOR');
  const controller = entries.find((entry) => entry.name.toLowerCase() === controllerName.toLowerCase());
  if (!controller) throw coded('CONTROLLER_NOT_OP');
  const removedActors = entries.filter((entry) => actors.has(entry.name.toLowerCase())).map((entry) => entry.name);
  return { controller, removedActors, nextEntries: entries.filter((entry) => !actors.has(entry.name.toLowerCase())) };
}
```

`applyOperatorMigration` must read and parse the file, call the pure planner, append `.pre-showrunner-backup` to the source path with exclusive creation, write a temporary JSON file, rename it over the original, reread it, and assert no actor remains and the controller still has level 4.

- [ ] **Step 5: Harden ignored files and document non-secret configuration**

Append these exact patterns to `.gitignore`:

```gitignore
artifacts/
recordings/
production/approvals/*.json
server/ops.json.pre-showrunner-backup
*.broken-*.json
*.tar.gz
```

Add to `.env.example`:

```dotenv
SHOWRUNNER_HERO_USERNAME=HeroActor
SHOWRUNNER_RIVAL_USERNAME=RivalActor
SHOWRUNNER_CONTROLLER_NAME=ProductionController
SHOWRUNNER_ARTIFACT_DIR=/absolute/path/to/Minecraft/artifacts
SHOWRUNNER_RECORDING_DIR=/absolute/path/to/Minecraft/recordings
```

Add npm scripts `showrunner`, `showrunner:rehearse`, and `showrunner:security-check`, all invoking `node src/showrunner/cli.mjs` with the corresponding subcommand. Install and save `yaml@2` so the lockfile is regenerated by npm rather than edited manually.

- [ ] **Step 6: Verify and apply the operator migration deliberately**

Run:

```bash
node --test test/showrunner-security.test.mjs
npm run showrunner:security-check -- --actors HeroActor,RivalActor --controller ProductionController --dry-run
```

Expected: tests PASS; dry-run lists only the two actor removals and confirms the controller. Create/confirm the dedicated controller op in Minecraft console if absent, then rerun without `--dry-run`. Verify the backup and final JSON before proceeding.

- [ ] **Step 7: Run the full baseline and commit only safe project files**

Run: `npm test`

Expected: all tests PASS.

```bash
git add .gitignore .env.example package.json package-lock.json src scripts test server/server.properties server/VERSION.txt
git commit -m "chore: establish showrunner security baseline"
```

Before committing, inspect `git diff --cached --stat` and unstage any world, log, jar, archive, cache, secret, or runtime recording file.

---

### Task 2: Validate Versioned Episode, Profile, and Baseline Sources

**Files:**
- Create: `src/showrunner/errors.mjs`
- Create: `src/showrunner/schema.mjs`
- Create: `test/showrunner-schema.test.mjs`
- Create: `production/profiles/hero.yaml`
- Create: `production/profiles/rival.yaml`
- Create: `production/episodes/stolen-map.yaml`
- Create: `production/sets/city-square-dialogue.v1.json`

**Interfaces:**
- Produces: `loadEpisode(path) -> Promise<ValidatedEpisode>`
- Produces: `loadProfile(path) -> Promise<ValidatedProfile>`
- Produces: `loadBaselineManifest(path) -> Promise<BaselineManifest>`
- Produces: `ShowrunnerError(code, message, details)`

- [ ] **Step 1: Write schema tests for the approved contract**

```js
test('loads the two-actor episode and resolves referenced assets', async () => {
  const episode = await loadEpisode(fixture('valid-episode.yaml'));
  assert.equal(episode.schemaVersion, 1);
  assert.deepEqual(Object.keys(episode.actors), ['hero', 'rival']);
  assert.equal(episode.scene.cues.length, 2);
  assert.equal(episode.scene.marks.hero_start.dimension, 'minecraft:overworld');
});

test('reports YAML source location and rejects unsafe or missing mark fields', async () => {
  await assert.rejects(loadEpisode(fixture('invalid-mark.yaml')), (error) => {
    assert.equal(error.code, 'EPISODE_SCHEMA_INVALID');
    assert.equal(error.details.path.endsWith('invalid-mark.yaml'), true);
    assert.equal(Number.isInteger(error.details.line), true);
    return true;
  });
});
```

Also cover: schema version other than 1, actor count other than two, cue count outside 2–3, missing profile/manifest, duplicate cue IDs, unknown speaker/mark, nonpositive radius/dwell/timeout, `whole_scene_attempts` other than 1 or 2, and a writable-action field forbidden by the MVP.

- [ ] **Step 2: Run the tests and verify failure**

Run: `node --test test/showrunner-schema.test.mjs`

Expected: FAIL because the loader is not implemented.

- [ ] **Step 3: Implement parsing, normalization, and explicit validation**

```js
export async function loadEpisode(path) {
  const source = await readFile(path, 'utf8');
  let raw;
  try { raw = parseDocument(source, { prettyErrors: true }).toJS(); }
  catch (cause) { throw yamlError('EPISODE_YAML_INVALID', path, cause); }
  assertExactKeys(raw, EPISODE_KEYS, '$');
  assertVersion(raw.schema_version, 1, path);
  const episode = normalizeEpisode(raw, path);
  await resolveEpisodeReferences(episode, dirname(path));
  return deepFreeze(episode);
}
```

Use explicit validators rather than permissive property spreading. Normalize snake-case YAML keys to camelCase runtime types once at the boundary. Preserve the original source path on every validated document.

- [ ] **Step 4: Add the real MVP profile, episode, and manifest**

Use the exact structure from the approved specification. Set the city-square marks to verified safe coordinates only after observing them live. The manifest must include set ID/version, dimension, protected cuboid, block assertions, actor baselines, time/weather/gamerules, and entity cleanup tag.

- [ ] **Step 5: Verify fixtures, real documents, and full suite**

Run:

```bash
node --test test/showrunner-schema.test.mjs
node src/showrunner/cli.mjs validate production/episodes/stolen-map.yaml
npm test
```

Expected: all commands exit 0 and validation prints the resolved episode, profiles, and manifest paths.

- [ ] **Step 6: Commit**

```bash
git add src/showrunner/errors.mjs src/showrunner/schema.mjs test/showrunner-schema.test.mjs production/profiles production/episodes production/sets
git commit -m "feat: validate showrunner production sources"
```

---

### Task 3: Enforce Dialogue Policy and Creator-Approved Line Banks

**Files:**
- Create: `src/showrunner/policy.mjs`
- Create: `src/showrunner/rehearsal.mjs`
- Create: `test/showrunner-policy.test.mjs`
- Create: `test/showrunner-rehearsal.test.mjs`
- Create: `production/approvals/.gitkeep`

**Interfaces:**
- Consumes: `ValidatedEpisode`, `ValidatedProfile`, `ShowrunnerError`
- Produces: `validateDialogue(line, context) -> { ok, violations, wordCount, chatLength }`
- Produces: `buildRehearsalRequest({ episode, cue, profile, budget }) -> RehearsalRequest`
- Produces: `approveCandidateBank({ candidates, decisions, provenance }) -> ApprovedBank`
- Produces: `selectRuntimeLine({ cue, bank, variantId }) -> ValidatedLine`

- [ ] **Step 1: Write failing hard-policy tests**

```js
test('rejects command, newline, control, forbidden, oversized, and unapproved lines', () => {
  for (const line of ['/op HeroActor', 'hello\n/op me', 'bad\u0000text', 'subscribe now', 'one two three four']) {
    assert.equal(validateDialogue(line, context({ maxWords: 3 })).ok, false, line);
  }
  assert.equal(selectRuntimeLine({ cue, bank, variantId: 'not-approved' }).code, 'LINE_NOT_APPROVED');
});

test('applies stronger policies before cue policy', () => {
  const result = validateDialogue('rated phrase', context({ cueAllows: true, ratingForbids: true }));
  assert.deepEqual(result.violations.map((item) => item.policy), ['content_rating']);
});
```

Test exact/fallback membership, Unicode control categories, Minecraft chat limit, literal and regex bans, speaker/cue mismatch, duplicate variant IDs, and authored split plans.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `node --test test/showrunner-policy.test.mjs test/showrunner-rehearsal.test.mjs`

Expected: FAIL due to missing modules.

- [ ] **Step 3: Implement deterministic validation and precedence**

```js
const POLICY_ORDER = ['content_rating', 'global_safety', 'profile', 'scene', 'cue'];

export function validateDialogue(line, context) {
  const violations = [];
  if (line.startsWith('/')) violations.push(v('global_safety', 'LEADING_SLASH'));
  if (/\r|\n|\p{Cc}/u.test(line)) violations.push(v('global_safety', 'CONTROL_CHARACTER'));
  for (const policy of POLICY_ORDER) violations.push(...checkPolicy(line, context[policy]));
  violations.push(...checkLength(line, context));
  return { ok: violations.length === 0, violations, wordCount: countWords(line), chatLength: [...line].length };
}
```

Never use a model score inside `validateDialogue`. Soft style scores belong only in rehearsal metadata.

- [ ] **Step 4: Implement bounded rehearsal and approval provenance**

Define a provider-neutral `generateCandidates(request)` port. Enforce maximum candidates, input/output tokens, timeout, and one provider retry before calling it. Record provider, model, prompt-template version, SHA-256 prompt hash, tokens, latency, hard validation, and soft scores. `approveCandidateBank` accepts only explicit creator decisions and writes schema version 1 with stable variant IDs and a source-episode hash.

- [ ] **Step 5: Verify the no-provider runtime path**

```js
test('runtime selection never calls the model provider', () => {
  const provider = { generateCandidates: () => assert.fail('provider called during take') };
  const selected = selectRuntimeLine({ cue, bank, variantId: 'hero_reply_2', provider });
  assert.equal(selected.text, 'You will not hold it for long.');
});
```

Run: `node --test test/showrunner-policy.test.mjs test/showrunner-rehearsal.test.mjs && npm test`

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/showrunner/policy.mjs src/showrunner/rehearsal.mjs test/showrunner-policy.test.mjs test/showrunner-rehearsal.test.mjs production/approvals/.gitkeep
git commit -m "feat: add creator-approved dialogue workflow"
```

---

### Task 4: Build the Causally Fenced Event Protocol

**Files:**
- Create: `src/showrunner/protocol.mjs`
- Create: `test/showrunner-protocol.test.mjs`

**Interfaces:**
- Produces: `createEnvelope(kind, identity, payload, clock) -> EventEnvelope`
- Produces: `AttemptFence.start(identity)`, `.revoke(reason)`, `.accept(event) -> Acceptance`
- Produces: `IdempotencyLedger.claim(key) -> boolean`
- Event identity fields: `productionId`, `takeId`, `sceneId`, `beatId`, `attemptId`, `cueId`, `eventId`, `causalSequence`, `monotonicTimestamp`

- [ ] **Step 1: Write failing stale, duplicate, and ordering tests**

```js
test('rejects duplicate, stale, and out-of-order events without changing sequence', () => {
  const fence = AttemptFence.start(identity({ attemptId: 'attempt-2' }));
  assert.equal(fence.accept(event({ attemptId: 'attempt-1', causalSequence: 1 })).reason, 'STALE_ATTEMPT');
  assert.equal(fence.accept(event({ eventId: 'e2', causalSequence: 2 })).reason, 'OUT_OF_ORDER');
  assert.equal(fence.accept(event({ eventId: 'e1', causalSequence: 1 })).accepted, true);
  assert.equal(fence.accept(event({ eventId: 'e1', causalSequence: 1 })).reason, 'DUPLICATE_EVENT');
  assert.equal(fence.sequence, 1);
});
```

Also test wrong production/take/scene/beat/cue, duplicate idempotency keys, monotonic timestamps preserved in logs but not used instead of sequence, and all post-revocation events rejected.

- [ ] **Step 2: Run focused test and confirm failure**

Run: `node --test test/showrunner-protocol.test.mjs`

Expected: FAIL because the protocol module is missing.

- [ ] **Step 3: Implement immutable envelopes and fence decisions**

```js
export function createEnvelope(kind, identity, payload, clock = performance) {
  return Object.freeze({
    kind,
    ...identity,
    eventId: randomUUID(),
    causalSequence: identity.causalSequence,
    monotonicTimestamp: clock.now(),
    payload: structuredClone(payload)
  });
}
```

`AttemptFence.accept` returns a decision object and never throws for hostile or late input. Validate every identity field before sequence advancement. Keep the seen-event set and command-idempotency ledger bounded to the active take.

- [ ] **Step 4: Verify and commit**

Run: `node --test test/showrunner-protocol.test.mjs && npm test`

Expected: all tests PASS.

```bash
git add src/showrunner/protocol.mjs test/showrunner-protocol.test.mjs
git commit -m "feat: fence showrunner commands and events"
```

---

### Task 5: Implement the Sole-Writer Showrunner State Machine

**Files:**
- Create: `src/showrunner/state-machine.mjs`
- Create: `test/showrunner-state-machine.test.mjs`

**Interfaces:**
- Consumes: validated sources, approved bank, `AttemptFence`, actor/production/capture ports
- Produces: `createShowrunner(dependencies) -> { dispatch(event), snapshot(), startTake(input), emergencyStop(reason) }`
- States: `idle`, `preparing`, `awaiting_capture`, `pre_roll`, `running`, `resetting`, `completed`, `aborted`, `accepted`, `rejected`

- [ ] **Step 1: Write the failing happy-path state test**

```js
test('serializes preparation, capture, marks, cues, and completion', async () => {
  const rig = fakeRig();
  const runner = createShowrunner(rig.dependencies);
  await runner.startTake(rig.input);
  await rig.ackCapture();
  await rig.completeMark('hero');
  await rig.completeMark('rival');
  await rig.completeCue('rival_reveal');
  await rig.completeCue('hero_reply');
  assert.equal(runner.snapshot().state, 'completed');
  assert.deepEqual(rig.spokenCueIds, ['rival_reveal', 'hero_reply']);
});
```

- [ ] **Step 2: Add failure-path tests before implementation**

Cover: capture cannot arrive for another take; cue cannot start before both mark dwell verifications; one speaker token prevents overlap; completion requires ack plus authoritative observation; timeout invokes fallback at most once; retry creates a new attempt; late old-attempt completion is ignored; second failure aborts; emergency stop revokes before cancelling; only `completed` can become `accepted`.

- [ ] **Step 3: Run and confirm failure**

Run: `node --test test/showrunner-state-machine.test.mjs`

Expected: FAIL due to missing state machine.

- [ ] **Step 4: Implement an event queue with one reducer**

```js
export function createShowrunner(deps) {
  let state = initialState();
  let queue = Promise.resolve();
  const dispatch = (event) => {
    queue = queue.then(() => reduceOne(state, event, deps)).then((next) => { state = next; });
    return queue;
  };
  return { dispatch, snapshot: () => structuredClone(state), startTake: (input) => dispatch(start(input)), emergencyStop: (reason) => dispatch(stop(reason)) };
}
```

All timers enqueue fenced events; they never mutate state directly. Every side effect is emitted as a typed command, acknowledged, completed, and verified before the reducer crosses its barrier.

- [ ] **Step 5: Verify deterministic replay**

Add a test that feeds the same accepted event sequence into two fresh runners and deep-compares snapshots after removing generated IDs/timestamps.

Run: `node --test test/showrunner-state-machine.test.mjs && npm test`

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/showrunner/state-machine.mjs test/showrunner-state-machine.test.mjs
git commit -m "feat: add deterministic showrunner state machine"
```

---

### Task 6: Add the Five-Action Non-Op Actor Runtime

**Files:**
- Create: `src/showrunner/actor-runtime.mjs`
- Create: `test/showrunner-actor-runtime.test.mjs`

**Interfaces:**
- Consumes: fenced commands and validated marks/lines
- Produces: `createActorRuntime({ bot, movements, emit, clock })`
- Methods: `execute(command)`, `cancel(attemptId)`, `observe(scope)`, `close()`
- Supported command kinds: `moveToMark`, `lookAt`, `speak`, `observe`, `cancel`

- [ ] **Step 1: Write failing actor-boundary tests using a fake bot**

```js
test('speaks only a validated non-command line and emits ack then completion', async () => {
  const { runtime, bot, events } = rig();
  await runtime.execute(command('speak', { text: 'You will not hold it for long.', validated: true }));
  assert.deepEqual(bot.chatCalls, ['You will not hold it for long.']);
  assert.deepEqual(events.map((event) => event.kind), ['command_acknowledged', 'command_completed']);
});

test('rejects slash chat even when a hostile command claims validation', async () => {
  await assert.rejects(runtime.execute(command('speak', { text: '/op HeroActor', validated: true })), { code: 'UNSAFE_SPEECH' });
  assert.deepEqual(bot.chatCalls, []);
});
```

Also test unknown actions, attempt mismatch, duplicate idempotency, cancellation stopping pathfinder/control states, movement with `canDig=false`, dimension/radius/yaw/pitch/dwell observations, and disconnect completion arriving after cancellation.

- [ ] **Step 2: Run and confirm failure**

Run: `node --test test/showrunner-actor-runtime.test.mjs`

Expected: FAIL due to missing runtime.

- [ ] **Step 3: Implement the adapter without importing legacy bot handlers**

```js
const ACTIONS = new Set(['moveToMark', 'lookAt', 'speak', 'observe', 'cancel']);

async function execute(command) {
  assertFenced(command);
  if (!ACTIONS.has(command.kind)) throw coded('ACTION_NOT_ALLOWED');
  if (!ledger.claim(command.idempotencyKey)) return emitDuplicate(command);
  emit(ack(command));
  return handlers[command.kind](command);
}
```

Create Mineflayer clients from showrunner-specific usernames. Do not attach `parseBotMessages`, legacy combat handlers, or slash-command helpers. Set pathfinder movements to `canDig=false`; clear all controls during cancellation and shutdown.

- [ ] **Step 4: Verify and commit**

Run: `node --test test/showrunner-actor-runtime.test.mjs && npm test`

Expected: all tests PASS.

```bash
git add src/showrunner/actor-runtime.mjs test/showrunner-actor-runtime.test.mjs
git commit -m "feat: add bounded showrunner actor runtime"
```

---

### Task 7: Implement Typed Production Control and Transactional Reset

**Files:**
- Create: `src/showrunner/production-controller.mjs`
- Create: `src/showrunner/baseline.mjs`
- Create: `test/showrunner-production-controller.test.mjs`
- Create: `test/showrunner-baseline.test.mjs`

**Interfaces:**
- Produces: `createProductionController({ transport, allowlist, emit })`
- Produces: `resetToBaseline({ attempt, manifest, actors, controller, clock }) -> ResetReport`
- Command kinds: `teleportActor`, `restoreActor`, `setEnvironment`, `removeTaggedEntities`, `verifySet`, `emergencyStop`

- [ ] **Step 1: Write failing command-construction tests**

```js
test('constructs commands only from validated typed values', async () => {
  await controller.teleportActor({ actor: 'HeroActor', mark: safeMark });
  assert.deepEqual(transport.calls, ['execute in minecraft:overworld run tp HeroActor 532.5 92 44.5 -90 0']);
});

test('rejects selector and command injection in every identifier', async () => {
  for (const actor of ['@a', 'HeroActor run op x', 'HeroActor\n/op x']) {
    await assert.rejects(controller.teleportActor({ actor, mark: safeMark }), { code: 'INVALID_ACTOR_NAME' });
  }
  assert.deepEqual(transport.calls, []);
});
```

Test allowlisted dimensions/gamerules/weather, numeric bounds, fixed inventory item IDs, production tag format, transport failures, and verification based on response/telemetry rather than sleep duration.

- [ ] **Step 2: Write the reset-order and failure tests**

```js
test('revokes, cancels, awaits quiescence, restores, verifies, then opens a new epoch', async () => {
  const report = await resetToBaseline(rig.input);
  assert.deepEqual(rig.calls, ['revoke', 'cancel:hero', 'cancel:rival', 'quiesce', 'restore', 'cleanup', 'verify', 'new_attempt']);
  assert.equal(report.verified, true);
});
```

Test cancellation timeout, unsafe headroom, block assertion/checksum mismatch, entity cleanup mismatch, actor inventory/health/effect mismatch, and that no new attempt is created after any failure.

- [ ] **Step 3: Run and confirm failure**

Run: `node --test test/showrunner-production-controller.test.mjs test/showrunner-baseline.test.mjs`

Expected: FAIL due to missing modules.

- [ ] **Step 4: Implement fixed templates and the reset transaction**

```js
export async function resetToBaseline(ctx) {
  ctx.attempt.revoke('retry');
  await Promise.all(ctx.actors.map((actor) => actor.cancel(ctx.attempt.id)));
  await withTimeout(Promise.all(ctx.actors.map((actor) => actor.awaitQuiescence())), ctx.manifest.quiescenceTimeoutMs);
  await ctx.controller.restore(ctx.manifest);
  await ctx.controller.removeTaggedEntities(ctx.manifest.entityCleanupTag);
  const verification = await ctx.controller.verify(ctx.manifest);
  if (!verification.ok) throw coded('BASELINE_VERIFICATION_FAILED', verification);
  return { verified: true, verification, nextAttempt: ctx.attempt.next() };
}
```

Implement manifest verification with exact actor state plus declared block assertions or checksum samples. Do not claim arbitrary-world restoration and do not issue fill/setblock/damage commands.

- [ ] **Step 5: Verify and commit**

Run: `node --test test/showrunner-production-controller.test.mjs test/showrunner-baseline.test.mjs && npm test`

Expected: all tests PASS.

```bash
git add src/showrunner/production-controller.mjs src/showrunner/baseline.mjs test/showrunner-production-controller.test.mjs test/showrunner-baseline.test.mjs
git commit -m "feat: add verified showrunner reset control"
```

---

### Task 8: Add OBS Readiness and Recording Artifact Verification

**Files:**
- Create: `src/showrunner/capture.mjs`
- Create: `test/showrunner-capture.test.mjs`

**Interfaces:**
- Produces: `createCaptureSession({ takeId, expectedPath, clock, preRollMs })`
- Methods: `acknowledgeReady(input)`, `markTakeStarted()`, `requestStop()`, `acknowledgeStopped(input)`, `verifyArtifact(fsPort)`

- [ ] **Step 1: Write failing capture-contract tests**

```js
test('requires matching readiness before take start and verifies coverage', async () => {
  const capture = createCaptureSession({ takeId: 'take-1', expectedPath: '/recordings/take-1.mkv', clock, preRollMs: 3000 });
  capture.acknowledgeReady({ takeId: 'take-1', path: '/recordings/take-1.mkv', monotonicTimestamp: 100 });
  clock.set(3100);
  capture.markTakeStarted();
  capture.requestStop();
  capture.acknowledgeStopped({ takeId: 'take-1', monotonicTimestamp: 9000 });
  assert.equal((await capture.verifyArtifact(fakeFs({ size: 4096, start: 100, end: 9000 }))).ok, true);
});
```

Test wrong take/path, missing pre-roll, zero-byte/missing file, stop not acknowledged, artifact starting after first cue, artifact ending before take completion, and paths outside `SHOWRUNNER_RECORDING_DIR`.

- [ ] **Step 2: Run and confirm failure**

Run: `node --test test/showrunner-capture.test.mjs`

Expected: FAIL due to missing module.

- [ ] **Step 3: Implement the manual real-client/OBS handshake**

Use monotonic times for ordering and an artifact sidecar formed by appending `.showrunner.json` to the recording path. It contains take ID, ready/start/stop monotonic times, and the resolved recording path. Resolve and validate paths against the configured recording root before filesystem access.

- [ ] **Step 4: Verify and commit**

Run: `node --test test/showrunner-capture.test.mjs && npm test`

Expected: all tests PASS.

```bash
git add src/showrunner/capture.mjs test/showrunner-capture.test.mjs
git commit -m "feat: verify showrunner recording artifacts"
```

---

### Task 9: Integrate the CLI, Artifacts, and End-to-End Fake Production

**Files:**
- Create: `src/showrunner/artifacts.mjs`
- Create: `src/showrunner/cli.mjs`
- Create: `test/showrunner-integration.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: all prior modules
- Produces: `createArtifactWriter(root, identity)` with `appendEvent`, `writeTranscript`, `writeValidation`, `finalize`
- Produces CLI commands: `validate`, `rehearse`, `run`, `recording-ready`, `recording-stopped`, `accept`, `reject`, `security-check`

- [ ] **Step 1: Write the failing end-to-end fake-production test**

```js
test('runs, retries, fences a late event, and creates an auditable completed take', async () => {
  const production = await createIntegrationRig({ firstAttemptFails: true });
  await production.run();
  await production.injectLateEvent({ attemptId: 'attempt-1', cueId: 'rival_reveal' });
  const result = await production.finishAttemptTwo();
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.transcript.map((line) => line.cueId), ['rival_reveal', 'hero_reply']);
  assert.equal(result.events.some((event) => event.reason === 'STALE_ATTEMPT'), true);
  assert.equal(result.resetReport.verified, true);
  assert.equal(result.capture.ok, true);
});
```

Also assert that NDJSON parses line-by-line, writes are atomic, transcript contains variant IDs, final status cannot be rewritten from accepted to rejected, and a discarded attempt never appears in the accepted transcript.

- [ ] **Step 2: Run and confirm failure**

Run: `node --test test/showrunner-integration.test.mjs`

Expected: FAIL because orchestration/artifact modules are missing.

- [ ] **Step 3: Implement artifact layout and CLI composition root**

```text
artifacts/showrunner/{production_id}/{take_id}/
  events.ndjson
  transcript.json
  validation.json
  baseline-report.json
  capture.json
  status.json
```

Write each JSON document to a same-directory temporary file, fsync/close, and rename. Append NDJSON through one serialized writer. `cli.mjs` is the only composition root that creates real Mineflayer clients and the real production transport; importing any module must not connect to Minecraft or start timers.

- [ ] **Step 4: Add explicit CLI argument validation**

```js
const COMMANDS = new Set(['validate', 'rehearse', 'run', 'recording-ready', 'recording-stopped', 'accept', 'reject', 'security-check']);
if (!COMMANDS.has(command)) throw new ShowrunnerError('UNKNOWN_CLI_COMMAND', `Unknown command: ${command}`);
```

Require an episode path and approved bank for `run`; require take ID and recording path for capture acknowledgements; require completed status plus verified capture for `accept`. Never accept director instructions through Minecraft chat.

- [ ] **Step 5: Verify integration and full suite**

Run:

```bash
node --test test/showrunner-integration.test.mjs
npm test
node src/showrunner/cli.mjs validate production/episodes/stolen-map.yaml
```

Expected: all tests PASS and validation exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/showrunner/artifacts.mjs src/showrunner/cli.mjs test/showrunner-integration.test.mjs package.json package-lock.json
git commit -m "feat: integrate two-actor showrunner MVP"
```

---

### Task 10: Document, Rehearse, and Run the Live Acceptance Gate

**Files:**
- Modify: `README.md`
- Create: `docs/showrunner-operations.md`
- Runtime outputs: `production/approvals/{episode}.approved.json`, `artifacts/showrunner/**`, `recordings/**`

**Interfaces:**
- Consumes: completed Phase 0–1 implementation
- Produces: operator runbook and evidence for every Live MVP Acceptance criterion

- [ ] **Step 1: Add the operator runbook**

Document these exact stages with commands and expected states:

```bash
npm test
npm run showrunner:security-check -- --actors HeroActor,RivalActor --controller ProductionController
npm run showrunner:rehearse -- production/episodes/stolen-map.yaml
npm run showrunner -- run production/episodes/stolen-map.yaml --bank production/approvals/stolen-map.approved.json
TAKE_ID=take-id-printed-by-the-run-command
npm run showrunner -- recording-ready --take "$TAKE_ID" --path "recordings/$TAKE_ID.mkv"
npm run showrunner -- recording-stopped --take "$TAKE_ID" --path "recordings/$TAKE_ID.mkv"
npm run showrunner -- accept --take "$TAKE_ID"
```

Explain that `TAKE_ID` is copied from the CLI's concrete output. Include emergency-stop and hard-reset procedures, OBS pre-roll, fixed camera placement, artifact inspection, and that copy-on-write continuity is deferred until Phase 2.

- [ ] **Step 2: Update README security and workflow guidance**

State clearly that legacy `bot ...` chat commands and combat scripts are experimental and must not be used as the control path for an LLM production take. Link the approved spec, this plan, and the operations guide.

- [ ] **Step 3: Run automated verification before touching the live world**

Run:

```bash
npm test
git diff --check
npm run showrunner:security-check -- --actors HeroActor,RivalActor --controller ProductionController
node src/showrunner/cli.mjs validate production/episodes/stolen-map.yaml
```

Expected: tests PASS; diff check is clean; both actors are non-op; controller is op; episode validation passes.

- [ ] **Step 4: Rehearse and approve two visibly different style banks**

Generate candidates with the default profile, approve a finite bank, then change a style field such as cadence/humor and create a second bank. Verify both banks pass hard constraints and that their approved lines are visibly different. Record model, provider, prompt hash, usage, and decisions.

- [ ] **Step 5: Run the live happy-path take**

Start the local server, place the real client at the fixed camera mark, start OBS, start both non-op actors, acknowledge recording readiness, and run the take. Verify from artifacts that both actors reached the correct dimension/mark/facing/dwell, each line appeared exactly once in cue order, no overlap occurred, and the recording covers the take.

- [ ] **Step 6: Run the live retry-fencing take**

Force the first attempt to time out while retaining a delayed completion callback. Verify the event log shows revocation, actor cancellation, quiescence, baseline restoration, baseline verification, a new attempt ID, rejection of the delayed event as `STALE_ATTEMPT`, and successful second-attempt dialogue.

- [ ] **Step 7: Run the hostile-dialogue and emergency-stop checks**

Attempt to inject `/op HeroActor`, a newline command, a forbidden literal, and an unapproved line. Confirm none reaches Minecraft chat. Trigger emergency stop during movement and verify the attempt is revoked before cancellation and cannot later complete.

- [ ] **Step 8: Verify final evidence and commit documentation**

Run:

```bash
npm test
git diff --check
git status --short
```

Expected: all tests PASS; only intentional documentation/source changes remain; runtime approvals, artifacts, recordings, worlds, logs, and backups are ignored.

```bash
git add README.md docs/showrunner-operations.md
git commit -m "docs: add showrunner production runbook"
```

Do not declare the MVP accepted unless every Live MVP Acceptance item in the approved specification is backed by the generated event log, transcript, baseline report, capture report, and recording artifact.

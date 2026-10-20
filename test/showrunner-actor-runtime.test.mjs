import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';

import { createActorRuntime } from '../src/showrunner/actor-runtime.mjs';
import { signApprovedBank } from '../src/showrunner/approved-bank.mjs';
import { createSurvivalAuthority } from '../src/showrunner/survival-authority.mjs';

const EPISODE_CONTENT_HASH = 'a'.repeat(64);
const { privateKey: approvalPrivateKey, publicKey: approvalPublicKey } = generateKeyPairSync('ed25519');
const { privateKey: survivalPrivateKey } = generateKeyPairSync('ed25519');
const receiptCache = new Map();
const require = createRequire(import.meta.url);

function authorizationFor(text, cueId = 'cue', speaker = 'hero', authoredLineId) {
  const cacheKey = `${cueId}\0${speaker}\0${authoredLineId ?? ''}\0${text}`;
  if (receiptCache.has(cacheKey)) return receiptCache.get(cacheKey);
  const hardValidation = { ok: true, violations: [] };
  const decision = { candidateId: 'candidate', approved: true, variantId: 'variant', creator: 'Jay' };
  const result = signApprovedBank({
    schemaVersion: 2,
    creator: 'Jay',
    sourceEpisodeHash: EPISODE_CONTENT_HASH,
    provenance: {
      provider: 'test', model: 'test', promptTemplateVersion: 'v2', promptHash: 'b'.repeat(64),
      tokens: { input: 1, output: 1 }, latencyMs: 1, sourceEpisodeHash: EPISODE_CONTENT_HASH
    },
    variants: [{ id: 'variant', cueId, ...(authoredLineId === undefined ? {} : { authoredLineId }), speaker, text, hardValidation, softScores: {}, decision }],
    fallbacks: [{
      id: `fallback:${cueId}`, cueId, speaker, text: 'Signed fallback.', hardValidation,
      decision: { approved: true, kind: 'authored-fallback', lineId: `fallback:${cueId}`, creator: 'Jay' }
    }]
  }, approvalPrivateKey);
  assert.equal(result.ok, true);
  const receipt = result.bank.variants[0].authorization;
  receiptCache.set(cacheKey, receipt);
  return receipt;
}

function identity(overrides = {}) {
  return { productionId: 'production', takeId: 'take', sceneId: 'scene', beatId: 'beat', attemptId: 'attempt-1', cueId: 'cue', eventId: 'command-event', causalSequence: 1, monotonicTimestamp: 1, ...overrides };
}

function command(action, payload = {}, overrides = {}) {
  const value = { ...identity(overrides), kind: action, commandId: 'command-1', idempotencyKey: 'key-1', payload, ...overrides };
  if (action === 'speak') value.payload.authorization ??= authorizationFor(value.payload.text ?? value.payload.line, value.cueId, 'hero');
  if (action === 'moveToMark' || action === 'lookAt') value.payload.authorization ??= 'mark-ok';
  return value;
}

function normalizedMark(x, y, z, overrides = {}) {
  return {
    dimension: 'minecraft:overworld',
    position: { x, y, z },
    facing: { yaw: 0, pitch: 0 },
    radius: 1,
    dwellTicks: 1,
    safeHeadroom: true,
    ...overrides
  };
}

function survivalCommand(action, payload = {}, overrides = {}) {
  return command(action, {
    actor: 'hero',
    goalId: 'survival-goal',
    observationVersion: 7,
    ...payload
  }, {
    commandId: `command-${action}`,
    eventId: `event-${action}`,
    idempotencyKey: `key-${action}`,
    ...overrides
  });
}

function survivalAuthority(now = () => 1_000) {
  return createSurvivalAuthority({ clock: now, signingKey: survivalPrivateKey });
}

function authorityIdentity(overrides = {}) {
  return {
    productionId: 'production', takeId: 'take', attemptId: 'attempt-1', goalId: 'survival-goal',
    actorId: 'hero', observationVersion: 7, ...overrides
  };
}

function observation(version, overrides = {}) {
  return {
    authoritative: true,
    actor: 'hero',
    goalId: 'survival-goal',
    observationVersion: version,
    dimension: 'minecraft:overworld',
    inventory: {},
    equipment: {},
    blocks: {},
    drops: [],
    placedAtMarks: {},
    ...overrides
  };
}

function observerSequence(...receipts) {
  let index = 0;
  return {
    async observe() {
      return receipts[Math.min(index++, receipts.length - 1)];
    }
  };
}

function signedDropPayload(overrides = {}) {
  return {
    entityId: 41,
    dropId: 'drop-1',
    item: 'oak_log',
    region: 'hero_tree',
    dimension: 'minecraft:overworld',
    position: { x: 11, y: 64, z: 10 },
    volume: { min: { x: 10, y: 60, z: 8 }, max: { x: 14, y: 70, z: 12 } },
    stack: { item: 'oak_log', count: 1 },
    ...overrides
  };
}

function signedRecipePayload(recipe, count = 1, overrides = {}) {
  const specifications = {
    oak_planks: { inputs: [{ item: 'oak_log', count: 1 }], output: { item: 'oak_planks', count: 4 } },
    stick: { inputs: [{ item: 'oak_planks', count: 2 }], output: { item: 'stick', count: 4 } },
    crafting_table: { inputs: [{ item: 'oak_planks', count: 4 }], output: { item: 'crafting_table', count: 1 } },
    wooden_pickaxe: {
      inputs: [{ item: 'oak_planks', count: 3 }, { item: 'stick', count: 2 }],
      output: { item: 'wooden_pickaxe', count: 1 }
    }
  };
  return {
    recipe,
    count,
    mark: {
      id: 'crafting_mark',
      dimension: 'minecraft:overworld',
      position: { x: 4, y: 65, z: 4 },
      safeHeadroom: true
    },
    ...specifications[recipe],
    ...overrides
  };
}

function rig(options = {}) {
  const events = [];
  const bot = {
    username: 'hero',
    chatCalls: [], controls: { forward: true, back: true, left: true, right: true, jump: true, sneak: true, sprint: true },
    entity: { position: { x: 10, y: 64, z: 10 }, yaw: 0.5, pitch: -0.25 }, game: { dimension: 'minecraft:overworld' },
    pathfinder: {
      setMovements(value) { this.movements = value; },
      async goto(goal) { this.goal = goal; bot.entity.position = { x: goal.x, y: goal.y, z: goal.z }; },
      stop() { this.stopped = true; }
    },
    chat(text) { this.chatCalls.push(text); },
    async look(yaw, pitch) { this.entity.yaw = yaw; this.entity.pitch = pitch; },
    lookAtCalls: [], async lookAt(point) { this.lookAtCalls.push(point); },
    blockAt() { return { boundingBox: 'empty' }; },
    setControlState(control, value) { this.controls[control] = value; }, clearControlStates() { this.cleared = true; for (const key of Object.keys(this.controls)) this.controls[key] = false; }
  };
  const verifier = {
    verifyMark(kind, payload) {
      if (payload.authorization !== 'mark-ok') throw Object.assign(new Error('mark rejected'), { code: 'MARK_NOT_VALIDATED' });
      return { ...payload.mark };
    },
    ...options.verifier
  };
  const speechObserver = options.speechObserver ?? {
    async observe({ actorId, command: suppliedCommand, text }) {
      return { authoritative: true, observed: true, speaker: actorId, cueId: suppliedCommand.cueId, text };
    }
  };
  return {
    bot,
    events,
    verifier,
    runtime: createActorRuntime({
      bot, actorId: 'hero', movements: {}, emit: (event) => events.push(event), clock: { now: () => 20 },
      approvalPublicKey, episodeContentHash: EPISODE_CONTENT_HASH,
      ...options, verifier, speechObserver
    })
  };
}

test('speaks only a validated non-command line and emits ack then completion', async () => {
  const { runtime, bot, events } = rig();
  await runtime.execute(command('speak', { text: 'You will not hold it for long.' }));
  assert.deepEqual(bot.chatCalls, ['You will not hold it for long.']);
  assert.deepEqual(events.map((event) => event.kind), ['commandAcknowledged', 'commandCompleted', 'observationVerified']);
});

test('requires exact server-observed speech proof and preserves source event identity', async () => {
  const observations = [];
  const { runtime, events } = rig({
    actorId: 'hero',
    speechObserver: {
      async observe(input) {
        observations.push(input);
        return { authoritative: true, observed: true, speaker: 'hero', text: input.text };
      }
    }
  });
  await runtime.execute(command('speak', { text: 'Server sees this line.' }));

  assert.equal(observations.length, 1);
  assert.deepEqual(events.map((event) => event.kind), ['commandAcknowledged', 'commandCompleted', 'observationVerified']);
  assert.equal(events.every((event) => typeof event.eventId === 'string' && Number.isSafeInteger(event.causalSequence)), true);
  assert.deepEqual(events.at(-1).payload.proof, {
    kind: 'speech', authoritative: true, observed: true, speaker: 'hero', cueId: 'cue', text: 'Server sees this line.'
  });
});

test('rejects a mismatched authored line before chat reaches the bot', async () => {
  const { runtime, bot } = rig();
  const text = 'This line is signed for another authored cue.';
  await assert.rejects(runtime.execute(command('speak', {
    text,
    authoredLineId: 'line-b',
    authorization: authorizationFor(text, 'cue', 'hero', 'line-a')
  })), { code: 'LINE_AUTHORIZATION_MISMATCH' });
  assert.deepEqual(bot.chatCalls, []);
});

test('rejects slash chat even when a hostile command claims validation', async () => {
  const { runtime, bot } = rig({ operationTimeoutMs: 5 });
  const hostile = command('speak', { text: '/op HeroActor' });
  await assert.rejects(runtime.execute(hostile), { code: 'UNSAFE_SPEECH' });
  assert.deepEqual(bot.chatCalls, []);
});

test('independently rejects newline and control chat despite a forged validation flag', async () => {
  const { runtime, bot } = rig();
  await assert.rejects(runtime.execute(command('speak', { text: 'line one\n/op HeroActor' }, { idempotencyKey: 'newline' })), { code: 'UNSAFE_SPEECH' });
  await assert.rejects(runtime.execute(command('speak', { text: 'bell\u0007' }, { idempotencyKey: 'control' })), { code: 'UNSAFE_SPEECH' });
  assert.deepEqual(bot.chatCalls, []);
});

test('moves with non-digging movements and observes dimension, facing, radius, and dwell', async () => {
  const { runtime, bot } = rig();
  const mark = normalizedMark(10, 64, 10, { radius: 2, facing: { yaw: 0, pitch: 0 } });
  await runtime.execute(command('moveToMark', { mark }));
  const observation = await runtime.observe({ mark });
  assert.equal(bot.pathfinder.movements.canDig, false);
  assert.equal(observation.dimension, true);
  assert.equal(observation.radius, true);
  assert.equal(observation.facing, true);
  assert.equal(observation.dwell, true);
});

test('executes normalized nested marks with a Pathfinder Goal and proves headroom plus consecutive dwell ticks', async () => {
  let now = 0;
  const { runtime, bot, events } = rig({
    actorId: 'hero',
    clock: {
      now: () => now,
      async sleep(ms) { now += ms; }
    }
  });
  bot.blockAt = () => ({ boundingBox: 'empty' });
  const mark = {
    dimension: 'minecraft:overworld',
    position: { x: 10, y: 64, z: 10 },
    facing: { yaw: 0, pitch: 0 },
    radius: 2,
    dwellTicks: 2,
    safeHeadroom: true
  };

  await runtime.execute(command('moveToMark', { mark }));

  assert.equal(bot.pathfinder.goal.constructor.name, 'GoalNear');
  assert.equal(bot.pathfinder.movements.canDig, false);
  assert.deepEqual(events.at(-1).payload.proof, {
    kind: 'mark', authoritative: true, actor: 'hero', markId: undefined,
    dimension: 'minecraft:overworld', radius: true, facing: true, safeHeadroom: true, dwellTicks: 2
  });
});

test('exposes the reset actor contract and cancels a target attempt from a reset envelope', async () => {
  const { runtime } = rig({ actorId: 'hero' });
  await runtime.execute(command('speak', { text: 'Bind attempt.' }));
  await runtime.execute(command('cancel', { targetAttemptId: 'attempt-1' }, {
    attemptId: 'attempt-1:reset', commandId: 'cancel-command', eventId: 'cancel-event', idempotencyKey: 'cancel-key'
  }));

  assert.equal(runtime.name, 'hero');
  assert.deepEqual(await runtime.cancel('attempt-1'), {
    authoritative: true, acknowledged: true, cancelled: true,
    actor: 'hero', targetAttemptId: 'attempt-1'
  });
  assert.deepEqual(await runtime.awaitQuiescence(), {
    authoritative: true, acknowledged: true, quiescent: true, actor: 'hero'
  });
});

test('rejects unknown and legacy action aliases plus mismatched cancellation attempts', async () => {
  const { runtime } = rig();
  await assert.rejects(runtime.execute(command('dance')), { code: 'ACTION_NOT_ALLOWED' });
  await assert.rejects(runtime.execute(command('move-to-mark', { mark: normalizedMark(1, 2, 3) })), { code: 'ACTION_NOT_ALLOWED' });
  await runtime.execute(command('speak', { text: 'bind' }));
  await assert.rejects(runtime.execute(command('cancel', { attemptId: 'other' }, { idempotencyKey: 'cancel-other' })), { code: 'ATTEMPT_MISMATCH' });
});

test('requires public receipt verification and ignores forged receipt fields before acknowledgement or attempt binding', async () => {
  const { runtime, bot, events } = rig();
  const rejected = command('speak', { text: 'Safe.', authorization: 'forged', receipt: Object.freeze({ kind: 'validated-line', ok: true }) }, { idempotencyKey: 'same-key' });
  await assert.rejects(runtime.execute(rejected), { code: 'LINE_AUTHORIZATION_INVALID' });
  assert.deepEqual(events, []);
  const valid = command('speak', { text: 'Safe.', receipt: Object.freeze({ kind: 'validated-line', ok: true, text: 'other' }) }, { idempotencyKey: 'same-key', attemptId: 'attempt-2' });
  await runtime.execute(valid);
  assert.deepEqual(bot.chatCalls, ['Safe.']);

  await assert.rejects(runtime.execute(command('speak', {
    text: 'Exact text.', authorization: authorizationFor('Different text.')
  }, { attemptId: 'attempt-2', commandId: 'mismatch', eventId: 'mismatch-event', idempotencyKey: 'mismatch-key' })), { code: 'LINE_AUTHORIZATION_MISMATCH' });
  assert.throws(() => rig({ approvalPublicKey: undefined }), { code: 'APPROVAL_PUBLIC_KEY_REQUIRED' });
});

test('uses verifier-returned cloned marks for move and look even if the command payload changes afterwards', async () => {
  const { runtime, bot } = rig({ verifier: {
    verifyMark(kind, payload) {
      const result = { ...payload.mark };
      payload.mark.x = 999;
      return result;
    }
  } });
  await runtime.execute(command('moveToMark', { mark: normalizedMark(1, 64, 2) }));
  assert.equal(bot.pathfinder.goal.constructor.name, 'GoalNear');
  await runtime.cancel('attempt-1');
  await runtime.execute(command('lookAt', { mark: { x: 3, y: 65, z: 4 } }, { attemptId: 'attempt-2', commandId: 'look', eventId: 'look-event', idempotencyKey: 'look-key' }));
  assert.deepEqual(bot.lookAtCalls.map(({ x, y, z }) => ({ x, y, z })), [{ x: 3, y: 65, z: 4 }]);
});

test('requires trusted mark verification for both move and look', async () => {
  const { runtime } = rig({ verifier: { verifyMark: () => { throw Object.assign(new Error('no'), { code: 'MARK_NOT_VALIDATED' }); } } });
  await assert.rejects(runtime.execute(command('moveToMark', { mark: normalizedMark(1, 64, 1) })), { code: 'MARK_NOT_VALIDATED' });
  await assert.rejects(runtime.execute(command('lookAt', { mark: { x: 1, y: 64, z: 1 } }, { idempotencyKey: 'look-key' })), { code: 'MARK_NOT_VALIDATED' });
});

test('deduplicates command keys without repeating bot side effects', async () => {
  const { runtime, bot } = rig();
  await runtime.execute(command('speak', { text: 'Once.' }));
  await runtime.execute(command('speak', { text: 'Twice.' }));
  assert.deepEqual(bot.chatCalls, ['Once.']);
});

test('cancellation stops pathfinding and clears every control', async () => {
  const { runtime, bot } = rig();
  await runtime.execute(command('moveToMark', { mark: normalizedMark(1, 64, 1) }));
  await runtime.cancel('attempt-1');
  assert.equal(bot.pathfinder.stopped, true);
  assert.deepEqual(Object.values(bot.controls), [false, false, false, false, false, false, false]);
});

test('fences a late movement completion after cancellation', async () => {
  const { runtime, bot, events } = rig();
  let resolveMove;
  bot.pathfinder.goto = () => new Promise((resolve) => { resolveMove = resolve; });
  const work = runtime.execute(command('moveToMark', { mark: normalizedMark(1, 64, 1) }));
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.cancel('attempt-1');
  resolveMove();
  await work;
  assert.deepEqual(events.map(({ kind }) => kind), ['commandAcknowledged']);
});

test('fences a late disconnect after cancellation and allows the next attempt to bind', async () => {
  const { runtime, bot, events } = rig();
  let rejectMove;
  bot.pathfinder.goto = () => new Promise((resolve, reject) => { rejectMove = reject; });
  const oldWork = runtime.execute(command('moveToMark', { mark: normalizedMark(1, 64, 1) }));
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.cancel('attempt-1');
  rejectMove(new Error('socket disconnected'));
  await oldWork;
  await runtime.execute(command('speak', { text: 'New take.' }, { attemptId: 'attempt-2', eventId: 'new-event', commandId: 'new-command', idempotencyKey: 'new-key' }));
  assert.deepEqual(events.map(({ kind }) => kind), ['commandAcknowledged', 'commandAcknowledged', 'commandCompleted', 'observationVerified']);
});

test('fences a pending look rejection after cancellation and disconnect', async () => {
  const { runtime, bot, events } = rig();
  let rejectLook;
  bot.lookAt = () => new Promise((resolve, reject) => { rejectLook = reject; });
  const work = runtime.execute(command('lookAt', { mark: { x: 1, y: 64, z: 1 } }));
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.cancel('attempt-1');
  rejectLook(new Error('socket disconnected'));
  await work;
  assert.deepEqual(events.map(({ kind }) => kind), ['commandAcknowledged']);
});

test('does not prove quiescence while an underlying actor operation remains unsettled', async () => {
  const { runtime, bot, events } = rig();
  let resolveLook;
  bot.lookAt = () => new Promise((resolve) => { resolveLook = resolve; });
  const work = runtime.execute(command('lookAt', { mark: { x: 1, y: 64, z: 1 } }));
  await new Promise((resolve) => setImmediate(resolve));

  const cancellation = runtime.execute(command('cancel', { targetAttemptId: 'attempt-1' }, {
    attemptId: 'attempt-1:reset', commandId: 'cancel-pending', eventId: 'cancel-pending-event', idempotencyKey: 'cancel-pending-key'
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.some((event) => event.payload?.proof?.quiescent === true), false);

  resolveLook();
  await Promise.all([work, cancellation]);
  assert.equal(events.at(-1).payload.proof.quiescent, true);
});

test('headroom proof checks the actor feet and head cells at the observed position', async () => {
  const { runtime, bot } = rig();
  bot.entity.position = { x: 10, y: 64, z: 10 };
  bot.blockAt = ({ y }) => ({ boundingBox: y === 64 ? 'block' : 'empty' });

  const observation = await runtime.observe({ mark: normalizedMark(10, 64, 10) });
  assert.equal(observation.safeHeadroom, false);
  assert.equal(observation.authoritative, false);
});

test('digs only the signed target and proves the block delta with fresh Survival observations', async () => {
  const authority = survivalAuthority();
  const receipt = authority.issueTargetReceipt({
    ...authorityIdentity(),
    payload: {
      targetId: 'oak-1', region: 'hero_tree',
      target: { x: 12, y: 64, z: 9, dimension: 'minecraft:overworld', block: 'oak_log' },
      volume: { min: { x: 10, y: 60, z: 8 }, max: { x: 14, y: 70, z: 12 } }
    }
  });
  const before = observation(7, { blocks: { 'oak-1': 'oak_log' }, passableTargets: [] });
  const after = observation(8, { blocks: { 'oak-1': 'air' }, passableTargets: ['oak-1'] });
  const { runtime, bot, events } = rig({ survivalAuthority: authority, survivalObserver: observerSequence(before, after) });
  const targetBlock = { name: 'oak_log', position: { x: 12, y: 64, z: 9 } };
  let dug = false;
  bot.blockAt = ({ x, y, z }) => x === 12 && y === 64 && z === 9 && !dug ? targetBlock : { name: 'air', boundingBox: 'empty' };
  bot.digCalls = [];
  bot.dig = async (block) => { bot.digCalls.push(block); dug = true; };

  await runtime.execute(survivalCommand('digTarget', { targetId: 'oak-1', region: 'hero_tree', block: 'oak_log', receipt }));

  assert.deepEqual(bot.digCalls, [targetBlock]);
  assert.deepEqual(events.map(({ kind }) => kind), ['commandAcknowledged', 'commandCompleted', 'observationVerified']);
  assert.deepEqual(events.at(-1).payload.proof, {
    kind: 'digTarget', authoritative: true, actor: 'hero', goalId: 'survival-goal', observationVersion: 8,
    before, after
  });
  assert.deepEqual(authority.snapshotReservations(), []);
});

test('collects the exact signed item entity and proves a real inventory increase', async () => {
  const authority = survivalAuthority();
  const receipt = authority.issueItemReceipt({
    ...authorityIdentity(),
    payload: signedDropPayload()
  });
  const before = observation(7, { inventory: { oak_log: 0 }, drops: [{
    id: 'drop-1', entityId: 41, item: 'oak_log', count: 1, region: 'hero_tree',
    dimension: 'minecraft:overworld', position: { x: 11, y: 64, z: 10 }
  }] });
  const after = observation(8, { inventory: { oak_log: 1 }, drops: [] });
  const { runtime, bot, events } = rig({ survivalAuthority: authority, survivalObserver: observerSequence(before, after) });
  bot.entities = { 41: { id: 41, name: 'item', position: { x: 11, y: 64, z: 10 }, getDroppedItem: () => ({ name: 'oak_log', count: 1 }) } };

  await runtime.execute(survivalCommand('collectItem', { dropId: 'drop-1', item: 'oak_log', region: 'hero_tree', receipt }));

  assert.equal(bot.pathfinder.goal.constructor.name, 'GoalNear');
  assert.equal(events.at(-1).payload.proof.before.inventory.oak_log, 0);
  assert.equal(events.at(-1).payload.proof.after.inventory.oak_log, 1);
});

test('crafts a signed recipe through Mineflayer and rejects an unproved output delta', async () => {
  const authority = survivalAuthority();
  const receipt = authority.issueRecipeReceipt({
    ...authorityIdentity(),
    payload: signedRecipePayload('oak_planks')
  });
  const before = observation(7, { inventory: { oak_log: 1, oak_planks: 0 } });
  const after = observation(8, { inventory: { oak_log: 0, oak_planks: 4 } });
  const { runtime, bot, events } = rig({ survivalAuthority: authority, survivalObserver: observerSequence(before, after) });
  const recipe = { ingredients: [{ id: 17, count: 1 }], result: { id: 5, count: 4 } };
  bot.registry = { itemsByName: { oak_planks: { id: 5, name: 'oak_planks' } }, items: { 17: { name: 'oak_log' } } };
  bot.recipesForCalls = [];
  bot.recipesFor = (...args) => { bot.recipesForCalls.push(args); return [recipe]; };
  bot.craftCalls = [];
  bot.craft = async (...args) => { bot.craftCalls.push(args); };

  await runtime.execute(survivalCommand('craftRecipe', { recipe: 'oak_planks', count: 1, mark: 'crafting_mark', receipt }));
  assert.equal(bot.recipesForCalls.length, 1);
  assert.deepEqual(bot.craftCalls, [[recipe, 1, null]]);
  assert.equal(events.at(-1).payload.proof.after.inventory.oak_planks, 4);

  const failed = rig({
    survivalAuthority: authority,
    survivalObserver: observerSequence(before, observation(9, { inventory: { oak_log: 1, oak_planks: 0 } }))
  });
  failed.bot.registry = bot.registry;
  failed.bot.recipesFor = () => [recipe];
  failed.bot.craft = async () => {};
  await assert.rejects(failed.runtime.execute(survivalCommand('craftRecipe', {
    recipe: 'oak_planks', count: 1, mark: 'crafting_mark', receipt
  }, { idempotencyKey: 'craft-mismatch' })), { code: 'SURVIVAL_DELTA_INVALID' });
});

test('uses the signed live crafting-table position for table-bound recipes', async () => {
  const authority = survivalAuthority();
  const tablePosition = { x: 4, y: 65, z: 4 };
  const receipt = authority.issueRecipeReceipt({
    ...authorityIdentity(),
    payload: {
      ...signedRecipePayload('wooden_pickaxe'),
      table: { ...tablePosition, dimension: 'minecraft:overworld', block: 'crafting_table' }
    }
  });
  const before = observation(7, { inventory: { oak_planks: 3, stick: 2, wooden_pickaxe: 0 } });
  const after = observation(8, { inventory: { oak_planks: 0, stick: 0, wooden_pickaxe: 1 } });
  const { runtime, bot } = rig({ survivalAuthority: authority, survivalObserver: observerSequence(before, after) });
  const recipe = { ingredients: [{ id: 5, count: 3 }, { id: 280, count: 2 }], result: { id: 270, count: 1 } };
  const table = { name: 'crafting_table', position: tablePosition };
  bot.registry = {
    itemsByName: { wooden_pickaxe: { id: 270, name: 'wooden_pickaxe' } },
    items: { 5: { name: 'oak_planks' }, 280: { name: 'stick' } }
  };
  bot.blockAt = () => table;
  bot.recipesFor = (...args) => {
    assert.equal(args[3], table);
    return [recipe];
  };
  bot.craftCalls = [];
  bot.craft = async (...args) => { bot.craftCalls.push(args); };

  await runtime.execute(survivalCommand('craftRecipe', {
    recipe: 'wooden_pickaxe', count: 1, mark: 'crafting_mark', receipt
  }, { idempotencyKey: 'craft-at-table' }));
  assert.deepEqual(bot.craftCalls, [[recipe, 1, table]]);

  const missingTable = rig({
    survivalAuthority: authority,
    survivalObserver: observerSequence(before, after)
  });
  missingTable.bot.registry = bot.registry;
  missingTable.bot.blockAt = () => ({ name: 'air', position: tablePosition });
  missingTable.bot.recipesFor = () => [recipe];
  missingTable.bot.craft = async () => {};
  await assert.rejects(missingTable.runtime.execute(survivalCommand('craftRecipe', {
    recipe: 'wooden_pickaxe', count: 1, mark: 'crafting_mark', receipt
  }, { idempotencyKey: 'craft-missing-table' })), { code: 'SURVIVAL_CRAFTING_TABLE_INVALID' });
});

test('selects the oak-input variant from real 1.21.4 shaped recipe objects', async () => {
  const registry = require('prismarine-registry')('1.21.4');
  const { Recipe } = require('prismarine-recipe')(registry);
  const cases = [
    {
      recipe: 'stick', before: { oak_planks: 2, stick: 0 }, after: { oak_planks: 0, stick: 4 },
      inputs: { oak_planks: 2 }
    },
    {
      recipe: 'crafting_table', before: { oak_planks: 4, crafting_table: 0 },
      after: { oak_planks: 0, crafting_table: 1 }, inputs: { oak_planks: 4 }
    },
    {
      recipe: 'wooden_pickaxe', before: { oak_planks: 3, stick: 2, wooden_pickaxe: 0 },
      after: { oak_planks: 0, stick: 0, wooden_pickaxe: 1 }, inputs: { oak_planks: 3, stick: 2 }, table: true
    }
  ];

  for (const [index, value] of cases.entries()) {
    const authority = survivalAuthority();
    const tablePosition = { x: 4, y: 65, z: 4 };
    const receipt = authority.issueRecipeReceipt({
      ...authorityIdentity(),
      payload: {
        ...signedRecipePayload(value.recipe),
        ...(value.table ? { table: { ...tablePosition, dimension: 'minecraft:overworld', block: 'crafting_table' } } : {})
      }
    });
    const setup = rig({
      survivalAuthority: authority,
      survivalObserver: observerSequence(
        observation(7, { inventory: value.before }),
        observation(8, { inventory: value.after })
      )
    });
    setup.bot.registry = registry;
    setup.bot.blockAt = () => value.table
      ? { name: 'crafting_table', position: tablePosition }
      : { name: 'air', boundingBox: 'empty' };
    setup.bot.recipesFor = (itemId) => Recipe.find(itemId, null);
    setup.bot.craftCalls = [];
    setup.bot.craft = async (...args) => { setup.bot.craftCalls.push(args); };

    await setup.runtime.execute(survivalCommand('craftRecipe', {
      recipe: value.recipe, count: 1, mark: 'crafting_mark', receipt
    }, { idempotencyKey: `real-shaped-recipe-${index}` }));

    const selected = setup.bot.craftCalls[0][0];
    const selectedInputs = Object.fromEntries(selected.delta
      .filter(({ count }) => count < 0)
      .map(({ id, count }) => [registry.items[id].name, -count]));
    assert.deepEqual(selectedInputs, value.inputs);
  }
});

test('places at a verified mark and equips only an exact signed inventory item', async () => {
  const authority = survivalAuthority();
  const placeReceipt = authority.issueTargetReceipt({
    ...authorityIdentity(),
    payload: {
      mark: 'crafting_mark', item: 'crafting_table',
      target: { x: 4, y: 65, z: 4, dimension: 'minecraft:overworld', block: 'air' }
    }
  });
  const placeBefore = observation(7, { inventory: { crafting_table: 1 }, placedAtMarks: {} });
  const placeAfter = observation(8, { inventory: { crafting_table: 0 }, placedAtMarks: { crafting_mark: 'crafting_table' } });
  const placed = rig({ survivalAuthority: authority, survivalObserver: observerSequence(placeBefore, placeAfter) });
  const tableItem = { name: 'crafting_table', type: 58, count: 1 };
  placed.bot.inventory = { items: () => [tableItem] };
  placed.bot.equipCalls = [];
  placed.bot.equip = async (...args) => { placed.bot.equipCalls.push(args); };
  placed.bot.placeCalls = [];
  placed.bot.placeBlock = async (...args) => { placed.bot.placeCalls.push(args); };
  placed.bot.blockAt = ({ x, y, z }) => ({ name: y === 64 ? 'grass_block' : 'air', boundingBox: y === 64 ? 'block' : 'empty', position: { x, y, z } });
  const mark = normalizedMark(4, 65, 4);

  await placed.runtime.execute(survivalCommand('placeAtMark', {
    item: 'crafting_table', mark: 'crafting_mark', resolvedMark: mark, authorization: 'mark-ok', receipt: placeReceipt
  }));
  assert.deepEqual(placed.bot.equipCalls, [[tableItem, 'hand']]);
  assert.equal(placed.bot.placeCalls.length, 1);

  const mismatchedMark = rig({
    survivalAuthority: authority,
    survivalObserver: observerSequence(placeBefore, placeAfter)
  });
  await assert.rejects(mismatchedMark.runtime.execute(survivalCommand('placeAtMark', {
    item: 'crafting_table', mark: 'crafting_mark', resolvedMark: normalizedMark(99, 65, 99), authorization: 'mark-ok', receipt: placeReceipt
  }, { idempotencyKey: 'mismatched-mark' })), { code: 'SURVIVAL_MARK_TARGET_MISMATCH' });
  assert.equal(mismatchedMark.bot.pathfinder.goal, undefined);

  const equipReceipt = authority.issueItemReceipt({
    ...authorityIdentity({ receiptId: 'equip-receipt' }),
    payload: { item: 'wooden_pickaxe', destination: 'hand', stack: { item: 'wooden_pickaxe', count: 1 } }
  });
  const equipBefore = observation(7, { inventory: { wooden_pickaxe: 1 }, equipment: {} });
  const equipAfter = observation(8, { inventory: { wooden_pickaxe: 1 }, equipment: { hand: 'wooden_pickaxe' } });
  const equipped = rig({ survivalAuthority: authority, survivalObserver: observerSequence(equipBefore, equipAfter) });
  const pickaxe = { name: 'wooden_pickaxe', type: 270, count: 1 };
  equipped.bot.inventory = { items: () => [pickaxe] };
  equipped.bot.equipCalls = [];
  equipped.bot.equip = async (...args) => { equipped.bot.equipCalls.push(args); };
  await equipped.runtime.execute(survivalCommand('equipItem', { item: 'wooden_pickaxe', destination: 'hand', receipt: equipReceipt }, {
    commandId: 'command-equip', eventId: 'event-equip', idempotencyKey: 'key-equip'
  }));
  assert.deepEqual(equipped.bot.equipCalls, [[pickaxe, 'hand']]);
});

test('emits a cloned normalized Survival observation proof without exposing observer-owned state', async () => {
  const source = observation(8, { inventory: { oak_log: 2 }, equipment: { hand: 'wooden_pickaxe' } });
  const { runtime, events } = rig({ survivalAuthority: survivalAuthority(), survivalObserver: observerSequence(source) });
  await runtime.execute(survivalCommand('observeSurvival'));
  source.inventory.oak_log = 999;

  assert.deepEqual(events.at(-1).payload.proof, {
    kind: 'observeSurvival', authoritative: true, actor: 'hero', goalId: 'survival-goal', observationVersion: 8,
    before: null,
    after: observation(8, { inventory: { oak_log: 2 }, equipment: { hand: 'wooden_pickaxe' } })
  });
});

test('moves near and looks at only authority-resolved targets with non-digging pathfinding', async () => {
  const authority = survivalAuthority();
  const receipt = authority.issueTargetReceipt({
    ...authorityIdentity(),
    payload: { targetId: 'oak-4', target: { x: 14, y: 64, z: 10, dimension: 'minecraft:overworld', block: 'oak_log' } }
  });
  const moved = rig({
    survivalAuthority: authority,
    survivalObserver: observerSequence(observation(7), observation(8, { nearTargetId: 'oak-4', position: { x: 14, y: 64, z: 10 } }))
  });
  await moved.runtime.execute(survivalCommand('moveNearTarget', { targetId: 'oak-4', block: 'oak_log', receipt }));
  assert.equal(moved.bot.pathfinder.movements.canDig, false);
  assert.equal(moved.bot.pathfinder.goal.constructor.name, 'GoalNear');

  const looked = rig({
    survivalAuthority: authority,
    survivalObserver: observerSequence(observation(7), observation(8, { lookedAtTargetId: 'oak-4' }))
  });
  await looked.runtime.execute(survivalCommand('lookAtTarget', { targetId: 'oak-4', block: 'oak_log', receipt }, {
    commandId: 'look-target', eventId: 'look-target-event', idempotencyKey: 'look-target-key'
  }));
  assert.deepEqual(looked.bot.lookAtCalls.map(({ x, y, z }) => ({ x, y, z })), [{ x: 14, y: 64, z: 10 }]);
});

test('rejects non-JSON observer receipts and signed item receipts missing exact action bindings', async () => {
  const authority = survivalAuthority();
  const malformedObserver = rig({
    survivalAuthority: authority,
    survivalObserver: observerSequence({
      ...observation(8),
      inventory: new Map([['oak_log', 1]])
    })
  });
  await assert.rejects(malformedObserver.runtime.execute(survivalCommand('observeSurvival')), { code: 'SURVIVAL_OBSERVATION_INVALID' });

  assert.throws(() => authority.issueItemReceipt({
    ...authorityIdentity(), payload: { entityId: 43, dropId: 'drop-underbound' }
  }), { code: 'ITEM_SCHEMA_INVALID' });
  const underbound = authority.issueItemReceipt({
    ...authorityIdentity(), payload: signedDropPayload({ entityId: 43, dropId: 'drop-underbound' })
  });
  const collection = rig({ survivalAuthority: authority, survivalObserver: observerSequence(observation(7), observation(8)) });
  collection.bot.entities = { 43: { id: 43, position: { x: 10, y: 64, z: 11 }, getDroppedItem: () => ({ name: 'oak_log' }) } };
  await assert.rejects(collection.runtime.execute(survivalCommand('collectItem', {
    dropId: 'drop-underbound', item: 'stick', receipt: underbound
  }, { idempotencyKey: 'underbound' })), { code: 'SURVIVAL_RECEIPT_MISMATCH' });
  assert.equal(collection.bot.pathfinder.goal, undefined);
});

test('rejects raw coordinates plus forged, stale, wrong-actor, wrong-block, and out-of-volume authority receipts before side effects', async () => {
  let now = 1_000;
  const authority = survivalAuthority(() => now);
  const basePayload = {
    targetId: 'stone-1', region: 'mine',
    target: { x: 20, y: 61, z: 20, dimension: 'minecraft:overworld', block: 'stone' },
    volume: { min: { x: 19, y: 60, z: 19 }, max: { x: 21, y: 62, z: 21 } }
  };
  const valid = authority.issueTargetReceipt({ ...authorityIdentity(), payload: basePayload });
  const { runtime, bot } = rig({ survivalAuthority: authority, survivalObserver: observerSequence(observation(7), observation(8)) });
  bot.digCalls = [];
  bot.dig = async (block) => { bot.digCalls.push(block); };
  bot.blockAt = () => ({ name: 'dirt', position: { x: 20, y: 61, z: 20 } });

  await assert.rejects(runtime.execute(survivalCommand('digTarget', {
    targetId: 'stone-1', block: 'stone', x: 20, y: 61, z: 20
  }, { idempotencyKey: 'raw' })), { code: 'RAW_COORDINATES_NOT_ALLOWED' });
  const forged = structuredClone(valid);
  forged.payload.target.x = 21;
  await assert.rejects(runtime.execute(survivalCommand('digTarget', {
    targetId: 'stone-1', block: 'stone', receipt: forged
  }, { idempotencyKey: 'forged' })), { code: 'RECEIPT_SIGNATURE_INVALID' });
  await assert.rejects(runtime.execute(survivalCommand('digTarget', {
    targetId: 'stone-1', block: 'stone', receipt: valid
  }, { idempotencyKey: 'wrong-block' })), { code: 'SURVIVAL_TARGET_BLOCK_MISMATCH' });

  const wrongActor = authority.issueTargetReceipt({ ...authorityIdentity({ actorId: 'rival' }), payload: basePayload });
  await assert.rejects(runtime.execute(survivalCommand('digTarget', {
    targetId: 'stone-1', block: 'stone', receipt: wrongActor
  }, { idempotencyKey: 'wrong-actor' })), { code: 'RECEIPT_BINDING_MISMATCH' });
  const outside = authority.issueTargetReceipt({
    ...authorityIdentity({ receiptId: 'outside' }),
    payload: { ...basePayload, volume: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } } }
  });
  await assert.rejects(runtime.execute(survivalCommand('digTarget', {
    targetId: 'stone-1', block: 'stone', receipt: outside
  }, { idempotencyKey: 'outside' })), { code: 'SURVIVAL_TARGET_OUT_OF_VOLUME' });

  const unlistedCell = authority.issueTargetReceipt({
    ...authorityIdentity({ receiptId: 'unlisted-cell' }),
    payload: {
      ...basePayload,
      allowedCells: [{ x: 20, y: 61, z: 21 }]
    }
  });
  await assert.rejects(runtime.execute(survivalCommand('digTarget', {
    targetId: 'stone-1', block: 'stone', receipt: unlistedCell
  }, { idempotencyKey: 'unlisted-cell' })), { code: 'SURVIVAL_TARGET_OUT_OF_VOLUME' });

  now = valid.expiresAt;
  await assert.rejects(runtime.execute(survivalCommand('digTarget', {
    targetId: 'stone-1', block: 'stone', receipt: valid
  }, { idempotencyKey: 'stale' })), { code: 'RECEIPT_EXPIRED' });
  assert.deepEqual(bot.digCalls, []);
});

test('deduplicates typed Survival actions without repeating Mineflayer or observer work', async () => {
  const authority = survivalAuthority();
  const receipt = authority.issueItemReceipt({
    ...authorityIdentity(),
    payload: signedDropPayload({ entityId: 42, dropId: 'drop-2', position: { x: 10, y: 64, z: 11 } })
  });
  let observations = 0;
  const survivalObserver = {
    async observe() {
      observations += 1;
      return observations === 1
        ? observation(7, { inventory: { oak_log: 0 }, drops: [{
          id: 'drop-2', entityId: 42, item: 'oak_log', count: 1, region: 'hero_tree',
          dimension: 'minecraft:overworld', position: { x: 10, y: 64, z: 11 }
        }] })
        : observation(8, { inventory: { oak_log: 1 }, drops: [] });
    }
  };
  const { runtime, bot } = rig({ survivalAuthority: authority, survivalObserver });
  bot.entities = { 42: { id: 42, name: 'item', position: { x: 10, y: 64, z: 11 }, getDroppedItem: () => ({ name: 'oak_log', count: 1 }) } };
  const supplied = survivalCommand('collectItem', { dropId: 'drop-2', item: 'oak_log', receipt });
  await runtime.execute(supplied);
  assert.deepEqual(await runtime.execute(supplied), { duplicate: true });
  assert.equal(observations, 2);
});

test('releases a Survival reservation when command acknowledgement fails before Mineflayer runs', async () => {
  const authority = survivalAuthority();
  const receipt = authority.issueTargetReceipt({
    ...authorityIdentity(),
    payload: { targetId: 'oak-ack', target: { x: 12, y: 64, z: 9, dimension: 'minecraft:overworld', block: 'oak_log' } }
  });
  const { runtime, bot } = rig({
    survivalAuthority: authority,
    survivalObserver: observerSequence(observation(7), observation(8)),
    emit: async () => { throw new Error('sink disconnected'); }
  });
  bot.digCalls = [];
  bot.dig = async (block) => { bot.digCalls.push(block); };
  await assert.rejects(runtime.execute(survivalCommand('digTarget', {
    targetId: 'oak-ack', block: 'oak_log', receipt
  })), /sink disconnected/u);
  assert.deepEqual(authority.snapshotReservations(), []);
  assert.deepEqual(bot.digCalls, []);
});

test('times out typed operations and cancellation stops digging, closes windows, releases reservations, and fences late completion', async () => {
  const authority = survivalAuthority();
  const receipt = authority.issueTargetReceipt({
    ...authorityIdentity(),
    payload: { targetId: 'oak-2', target: { x: 12, y: 64, z: 9, dimension: 'minecraft:overworld', block: 'oak_log' } }
  });
  const before = observation(7, { blocks: { 'oak-2': 'oak_log' } });
  const timed = rig({ survivalAuthority: authority, survivalObserver: observerSequence(before), operationTimeoutMs: 5 });
  timed.bot.blockAt = () => ({ name: 'oak_log', position: { x: 12, y: 64, z: 9 } });
  timed.bot.dig = () => new Promise(() => {});
  timed.bot.stopDigging = () => { timed.bot.digStopped = true; };
  await assert.rejects(timed.runtime.execute(survivalCommand('digTarget', {
    targetId: 'oak-2', block: 'oak_log', receipt
  })), { code: 'ACTOR_OPERATION_TIMEOUT' });
  assert.equal(timed.bot.digStopped, true);

  const secondAuthority = survivalAuthority();
  const secondReceipt = secondAuthority.issueTargetReceipt({
    ...authorityIdentity(),
    payload: { targetId: 'oak-3', target: { x: 13, y: 64, z: 9, dimension: 'minecraft:overworld', block: 'oak_log' } }
  });
  const cancelled = rig({ survivalAuthority: secondAuthority, survivalObserver: observerSequence(observation(7, { blocks: { 'oak-3': 'oak_log' } })) });
  cancelled.bot.blockAt = () => ({ name: 'oak_log', position: { x: 13, y: 64, z: 9 } });
  cancelled.bot.stopDigging = () => { cancelled.bot.digStopped = true; };
  cancelled.bot.currentWindow = { close() { cancelled.bot.windowClosed = true; } };
  let resolveDig;
  cancelled.bot.dig = () => new Promise((resolve) => { resolveDig = resolve; });
  const work = cancelled.runtime.execute(survivalCommand('digTarget', {
    targetId: 'oak-3', block: 'oak_log', receipt: secondReceipt
  }));
  await new Promise((resolve) => setImmediate(resolve));
  await cancelled.runtime.cancel('attempt-1');
  assert.equal(cancelled.bot.digStopped, true);
  assert.equal(cancelled.bot.windowClosed, true);
  assert.equal(secondAuthority.snapshotReservations().length, 1);
  resolveDig();
  await work;
  assert.deepEqual(secondAuthority.snapshotReservations(), []);
  assert.deepEqual(cancelled.events.map(({ kind }) => kind), ['commandAcknowledged']);
});

test('cancellation during acknowledgement fences Survival observation and Mineflayer effects', async () => {
  const authority = survivalAuthority();
  const receipt = authority.issueTargetReceipt({
    ...authorityIdentity(),
    payload: { targetId: 'oak-ack-race', target: { x: 12, y: 64, z: 9, dimension: 'minecraft:overworld', block: 'oak_log' } }
  });
  let releaseAcknowledgement;
  const acknowledgement = new Promise((resolve) => { releaseAcknowledgement = resolve; });
  let observations = 0;
  const setup = rig({
    survivalAuthority: authority,
    survivalObserver: {
      async observe() {
        observations += 1;
        return observations === 1
          ? observation(7, { blocks: { 'oak-ack-race': 'oak_log' } })
          : observation(8, { blocks: { 'oak-ack-race': 'air' } });
      }
    }
  });
  setup.bot.blockAt = () => ({ name: 'oak_log' });
  setup.bot.digCalls = [];
  setup.bot.dig = async (block) => { setup.bot.digCalls.push(block); };
  const sink = {
    async emit(event) {
      setup.events.push(event);
      if (event.kind === 'commandAcknowledged') await acknowledgement;
    }
  };

  const work = setup.runtime.execute(survivalCommand('digTarget', {
    targetId: 'oak-ack-race', block: 'oak_log', receipt
  }), sink);
  await new Promise((resolve) => setImmediate(resolve));
  await setup.runtime.cancel('attempt-1');
  releaseAcknowledgement();
  await work;

  assert.equal(observations, 0);
  assert.deepEqual(setup.bot.digCalls, []);
  assert.deepEqual(authority.snapshotReservations(), []);
});

test('cancellation aborts a pending pre-observation before any Mineflayer effect', async () => {
  const authority = survivalAuthority();
  const receipt = authority.issueTargetReceipt({
    ...authorityIdentity(),
    payload: { targetId: 'oak-pre-race', target: { x: 12, y: 64, z: 9, dimension: 'minecraft:overworld', block: 'oak_log' } }
  });
  let releaseObservation;
  const pendingObservation = new Promise((resolve) => { releaseObservation = resolve; });
  let observedSignal;
  const setup = rig({
    survivalAuthority: authority,
    survivalObserver: {
      async observe({ signal }) {
        observedSignal = signal;
        await pendingObservation;
        return observation(7, { blocks: { 'oak-pre-race': 'oak_log' } });
      }
    }
  });
  setup.bot.blockAt = () => ({ name: 'oak_log' });
  setup.bot.digCalls = [];
  setup.bot.dig = async (block) => { setup.bot.digCalls.push(block); };

  const work = setup.runtime.execute(survivalCommand('digTarget', {
    targetId: 'oak-pre-race', block: 'oak_log', receipt
  }));
  await new Promise((resolve) => setImmediate(resolve));
  await setup.runtime.cancel('attempt-1');

  assert.equal(observedSignal.aborted, true);
  assert.equal(authority.snapshotReservations().length, 1);
  releaseObservation();
  await work;
  assert.deepEqual(setup.bot.digCalls, []);
  assert.deepEqual(authority.snapshotReservations(), []);
});

test('cancellation between placement equip and placeBlock fences placement and retains its reservation until settle', async () => {
  const authority = survivalAuthority();
  const receipt = authority.issueTargetReceipt({
    ...authorityIdentity(),
    payload: {
      mark: 'placement-race', item: 'crafting_table',
      target: { x: 4, y: 65, z: 4, dimension: 'minecraft:overworld', block: 'air' }
    }
  });
  const before = observation(7, { inventory: { crafting_table: 1 } });
  let releaseEquip;
  const pendingEquip = new Promise((resolve) => { releaseEquip = resolve; });
  const setup = rig({ survivalAuthority: authority, survivalObserver: observerSequence(before) });
  const item = { name: 'crafting_table', type: 58, count: 1 };
  setup.bot.inventory = { items: () => [item] };
  setup.bot.blockAt = ({ x, y, z }) => ({
    name: y === 64 ? 'grass_block' : 'air', boundingBox: y === 64 ? 'block' : 'empty', position: { x, y, z }
  });
  setup.bot.equip = async () => pendingEquip;
  setup.bot.placeCalls = [];
  setup.bot.placeBlock = async (...args) => { setup.bot.placeCalls.push(args); };

  const work = setup.runtime.execute(survivalCommand('placeAtMark', {
    item: 'crafting_table', mark: 'placement-race', resolvedMark: normalizedMark(4, 65, 4), authorization: 'mark-ok', receipt
  }));
  await new Promise((resolve) => setImmediate(resolve));
  await setup.runtime.cancel('attempt-1');
  assert.equal(authority.snapshotReservations().length, 1);
  releaseEquip();
  await work;

  assert.deepEqual(setup.bot.placeCalls, []);
  assert.deepEqual(authority.snapshotReservations(), []);
});

test('rejects signed move, look, dig, and placement targets from another live dimension', async () => {
  const actions = ['moveNearTarget', 'lookAtTarget', 'digTarget', 'placeAtMark'];
  for (const [index, action] of actions.entries()) {
    const authority = survivalAuthority();
    const targetId = `dimension-target-${index}`;
    const payload = action === 'placeAtMark'
      ? {
          mark: 'dimension-mark', item: 'crafting_table',
          target: { x: 4, y: 65, z: 4, dimension: 'minecraft:overworld', block: 'air' }
        }
      : { targetId, target: { x: 12, y: 64, z: 9, dimension: 'minecraft:overworld', block: 'oak_log' } };
    const receipt = authority.issueTargetReceipt({ ...authorityIdentity(), payload });
    const setup = rig({
      survivalAuthority: authority,
      survivalObserver: observerSequence(observation(7, { dimension: 'minecraft:the_nether' }))
    });
    setup.bot.game.dimension = 'minecraft:the_nether';
    setup.bot.inventory = { items: () => [{ name: 'crafting_table' }] };
    setup.bot.digCalls = [];
    setup.bot.dig = async (...args) => { setup.bot.digCalls.push(args); };
    setup.bot.placeCalls = [];
    setup.bot.placeBlock = async (...args) => { setup.bot.placeCalls.push(args); };
    const commandPayload = action === 'placeAtMark'
      ? { item: 'crafting_table', mark: 'dimension-mark', resolvedMark: normalizedMark(4, 65, 4), authorization: 'mark-ok', receipt }
      : { targetId, block: 'oak_log', receipt };

    await assert.rejects(setup.runtime.execute(survivalCommand(action, commandPayload, {
      commandId: `dimension-command-${index}`, eventId: `dimension-event-${index}`, idempotencyKey: `dimension-key-${index}`
    })), { code: 'SURVIVAL_DIMENSION_MISMATCH' });
    assert.equal(setup.bot.pathfinder.goal, undefined);
    assert.deepEqual(setup.bot.lookAtCalls, []);
    assert.deepEqual(setup.bot.digCalls, []);
    assert.deepEqual(setup.bot.placeCalls, []);
  }
});

test('rejects authoritative Survival observations whose dimension differs from the live bot', async () => {
  const setup = rig({
    survivalAuthority: survivalAuthority(),
    survivalObserver: observerSequence(observation(8, { dimension: 'minecraft:the_nether' }))
  });
  await assert.rejects(setup.runtime.execute(survivalCommand('observeSurvival')), { code: 'SURVIVAL_OBSERVATION_INVALID' });
  assert.deepEqual(setup.events.map(({ kind }) => kind), ['commandAcknowledged']);
});

test('normalizes real Mineflayer dimension names against namespaced authored marks and receipts', async () => {
  const markSetup = rig();
  markSetup.bot.game.dimension = 'overworld';
  const mark = normalizedMark(10, 64, 10);
  const markObservation = await markSetup.runtime.observe({ mark });
  assert.equal(markObservation.dimension, true);

  const authority = survivalAuthority();
  const receipt = authority.issueTargetReceipt({
    ...authorityIdentity(),
    payload: {
      targetId: 'mineflayer-oak', region: 'hero_tree', purpose: 'tree',
      target: { x: 12, y: 64, z: 9, dimension: 'minecraft:overworld', block: 'oak_log' },
      volume: { min: { x: 10, y: 60, z: 8 }, max: { x: 14, y: 70, z: 12 } }
    }
  });
  const before = observation(7, {
    dimension: 'overworld', blocks: { 'mineflayer-oak': 'oak_log' }, passableTargets: []
  });
  const after = observation(8, {
    dimension: 'overworld', blocks: { 'mineflayer-oak': 'air' }, passableTargets: ['mineflayer-oak']
  });
  const setup = rig({ survivalAuthority: authority, survivalObserver: observerSequence(before, after) });
  setup.bot.game.dimension = 'overworld';
  setup.bot.blockAt = (() => {
    let reads = 0;
    return () => reads++ === 0
      ? { name: 'oak_log', boundingBox: 'block' }
      : { name: 'air', boundingBox: 'empty' };
  })();
  setup.bot.dig = async () => {};

  await setup.runtime.execute(survivalCommand('digTarget', {
    targetId: 'mineflayer-oak', region: 'hero_tree', block: 'oak_log', receipt
  }));
  assert.equal(setup.events.at(-1).payload.proof.after.dimension, 'minecraft:overworld');
});

test('craft proof requires the signed recipe inputs to decrease exactly as output increases', async () => {
  const authority = survivalAuthority();
  const receipt = authority.issueRecipeReceipt({
    ...authorityIdentity(),
    payload: signedRecipePayload('oak_planks')
  });
  const before = observation(7, { inventory: { oak_log: 1, oak_planks: 0 } });
  const launderedOutput = observation(8, { inventory: { oak_log: 1, oak_planks: 4 } });
  const setup = rig({ survivalAuthority: authority, survivalObserver: observerSequence(before, launderedOutput) });
  setup.bot.registry = {
    itemsByName: { oak_planks: { id: 5, name: 'oak_planks' } },
    items: { 17: { name: 'oak_log' } }
  };
  const recipe = { ingredients: [{ id: 17, count: 1 }], result: { id: 5, count: 4 } };
  setup.bot.recipesFor = () => [recipe];
  setup.bot.craft = async () => {};

  await assert.rejects(setup.runtime.execute(survivalCommand('craftRecipe', {
    recipe: 'oak_planks', count: 1, mark: 'crafting_mark', receipt
  })), { code: 'SURVIVAL_DELTA_INVALID' });
});

test('dig proof rejects a non-passable replacement cell even when the expected block disappeared', async () => {
  const authority = survivalAuthority();
  const receipt = authority.issueTargetReceipt({
    ...authorityIdentity(),
    payload: {
      targetId: 'stone-passability', region: 'mine', purpose: 'excavation',
      target: { x: 12, y: 64, z: 9, dimension: 'minecraft:overworld', block: 'stone' },
      volume: { min: { x: 12, y: 64, z: 9 }, max: { x: 12, y: 64, z: 9 } },
      allowedCells: [{ x: 12, y: 64, z: 9 }]
    }
  });
  const before = observation(7, { blocks: { 'stone-passability': 'stone' }, passableTargets: [] });
  const after = observation(8, { blocks: { 'stone-passability': 'dirt' }, passableTargets: [] });
  const setup = rig({ survivalAuthority: authority, survivalObserver: observerSequence(before, after) });
  let reads = 0;
  setup.bot.blockAt = () => reads++ === 0
    ? { name: 'stone', boundingBox: 'block' }
    : { name: 'dirt', boundingBox: 'block' };
  setup.bot.dig = async () => {};

  await assert.rejects(setup.runtime.execute(survivalCommand('digTarget', {
    targetId: 'stone-passability', region: 'mine', block: 'stone', receipt
  })), { code: 'SURVIVAL_REPLACEMENT_NOT_PASSABLE' });
});

test('collection rechecks signed dimension, position, region, and stack state before movement', async () => {
  const authority = survivalAuthority();
  const receipt = authority.issueItemReceipt({ ...authorityIdentity(), payload: signedDropPayload() });
  const setup = rig({
    survivalAuthority: authority,
    survivalObserver: observerSequence(observation(7, {
      drops: [{ id: 'drop-1', entityId: 41, item: 'oak_log', count: 1, region: 'hero_tree',
        dimension: 'minecraft:overworld', position: { x: 11, y: 64, z: 10 } }]
    }))
  });
  setup.bot.entities = {
    41: {
      id: 41,
      position: { x: 12, y: 64, z: 10 },
      getDroppedItem: () => ({ name: 'oak_log', count: 1 })
    }
  };

  await assert.rejects(setup.runtime.execute(survivalCommand('collectItem', {
    dropId: 'drop-1', item: 'oak_log', region: 'hero_tree', receipt
  })), { code: 'SURVIVAL_ITEM_MOVED' });
  assert.equal(setup.bot.pathfinder.goal, undefined);
});

test('treats repeated direct and command cancellation of the same revoked attempt as idempotent quiescence', async () => {
  const setup = rig({
    survivalAuthority: survivalAuthority(),
    survivalObserver: observerSequence(observation(8))
  });
  await setup.runtime.execute(survivalCommand('observeSurvival'));
  const first = await setup.runtime.cancel('attempt-1');
  const second = await setup.runtime.cancel('attempt-1');
  assert.deepEqual(second, first);

  await setup.runtime.execute(command('cancel', { targetAttemptId: 'attempt-1' }, {
    attemptId: 'attempt-1:reset', commandId: 'cancel-idempotent',
    eventId: 'cancel-idempotent-event', idempotencyKey: 'cancel-idempotent-key'
  }));
  assert.equal(setup.events.at(-1).payload.proof.quiescent, true);
});

test('equip rechecks the complete signed inventory stack before the side effect', async () => {
  const authority = survivalAuthority();
  const receipt = authority.issueItemReceipt({
    ...authorityIdentity(),
    payload: { item: 'wooden_pickaxe', destination: 'hand', stack: { item: 'wooden_pickaxe', count: 1 } }
  });
  const setup = rig({
    survivalAuthority: authority,
    survivalObserver: observerSequence(observation(7, { inventory: { wooden_pickaxe: 1 } }))
  });
  setup.bot.inventory = { items: () => [{ name: 'wooden_pickaxe', count: 2 }] };
  setup.bot.equipCalls = [];
  setup.bot.equip = async (...args) => { setup.bot.equipCalls.push(args); };

  await assert.rejects(setup.runtime.execute(survivalCommand('equipItem', {
    item: 'wooden_pickaxe', destination: 'hand', receipt
  })), { code: 'SURVIVAL_ITEM_MISMATCH' });
  assert.deepEqual(setup.bot.equipCalls, []);
});

test('honors a coordinator supplied remaining goal budget below the runtime default timeout', async () => {
  const setup = rig({ operationTimeoutMs: 100 });
  setup.bot.lookAt = () => new Promise(() => {});
  const startedAt = performance.now();
  await assert.rejects(setup.runtime.execute(command('lookAt', {
    mark: { position: { x: 1, y: 64, z: 1 } }, authorization: 'mark-ok', operationBudgetMs: 5
  })), { code: 'ACTOR_OPERATION_TIMEOUT' });
  assert.ok(performance.now() - startedAt < 50);
});

test('reverifies a cloned receipt after pre-observation so expiry cannot cross into a dig side effect', async () => {
  let now = 1_000;
  const authority = survivalAuthority(() => now);
  const receipt = authority.issueTargetReceipt({
    ...authorityIdentity(),
    payload: { targetId: 'expiring-oak', target: { x: 12, y: 64, z: 9, dimension: 'minecraft:overworld', block: 'oak_log' } }
  });
  const setup = rig({
    survivalAuthority: authority,
    survivalObserver: {
      async observe() {
        now = receipt.expiresAt;
        return observation(7, { blocks: { 'expiring-oak': 'oak_log' } });
      }
    }
  });
  setup.bot.blockAt = () => ({ name: 'oak_log' });
  setup.bot.digCalls = [];
  setup.bot.dig = async (...args) => { setup.bot.digCalls.push(args); };

  await assert.rejects(setup.runtime.execute(survivalCommand('digTarget', {
    targetId: 'expiring-oak', block: 'oak_log', receipt
  })), { code: 'RECEIPT_EXPIRED' });
  assert.deepEqual(setup.bot.digCalls, []);
});

test('retains a cancelled Survival reservation and withholds quiescence until late work settles', async () => {
  const authority = survivalAuthority();
  const receipt = authority.issueTargetReceipt({
    ...authorityIdentity(),
    payload: { targetId: 'unsettled-oak', target: { x: 12, y: 64, z: 9, dimension: 'minecraft:overworld', block: 'oak_log' } }
  });
  const setup = rig({
    survivalAuthority: authority,
    survivalObserver: observerSequence(observation(7, { blocks: { 'unsettled-oak': 'oak_log' } }))
  });
  setup.bot.blockAt = () => ({ name: 'oak_log' });
  let settleDig;
  setup.bot.dig = () => new Promise((resolve) => { settleDig = resolve; });
  const work = setup.runtime.execute(survivalCommand('digTarget', {
    targetId: 'unsettled-oak', block: 'oak_log', receipt
  }));
  await new Promise((resolve) => setImmediate(resolve));

  const cancellation = setup.runtime.execute(command('cancel', { targetAttemptId: 'attempt-1' }, {
    attemptId: 'attempt-1:reset', commandId: 'cancel-unsettled', eventId: 'cancel-unsettled-event', idempotencyKey: 'cancel-unsettled-key'
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(authority.snapshotReservations().length, 1);
  assert.equal(setup.events.some((event) => event.payload?.proof?.quiescent === true), false);

  settleDig();
  await Promise.all([work, cancellation]);
  assert.deepEqual(authority.snapshotReservations(), []);
  assert.equal(setup.events.at(-1).payload.proof.quiescent, true);
});

test('snapshots and freezes the complete command envelope before acknowledgement awaits', async () => {
  const authority = survivalAuthority();
  const receipt = authority.issueTargetReceipt({
    ...authorityIdentity(),
    payload: { targetId: 'snapshot-oak', target: { x: 12, y: 64, z: 9, dimension: 'minecraft:overworld', block: 'oak_log' } }
  });
  let releaseAcknowledgement;
  const acknowledgement = new Promise((resolve) => { releaseAcknowledgement = resolve; });
  const observedCommands = [];
  const setup = rig({
    survivalAuthority: authority,
    survivalObserver: {
      async observe({ command: observedCommand, phase }) {
        observedCommands.push(observedCommand);
        return phase === 'before'
          ? observation(7, { blocks: { 'snapshot-oak': 'oak_log' }, passableTargets: [] })
          : observation(8, { blocks: { 'snapshot-oak': 'air' }, passableTargets: ['snapshot-oak'] });
      }
    }
  });
  let snapshotDug = false;
  setup.bot.blockAt = () => snapshotDug ? { name: 'air', boundingBox: 'empty' } : { name: 'oak_log', boundingBox: 'block' };
  setup.bot.dig = async () => { snapshotDug = true; };
  const sink = {
    async emit(event) {
      setup.events.push(event);
      if (event.kind === 'commandAcknowledged') await acknowledgement;
    }
  };
  const supplied = survivalCommand('digTarget', { targetId: 'snapshot-oak', block: 'oak_log', receipt });
  const work = setup.runtime.execute(supplied, sink);
  await new Promise((resolve) => setImmediate(resolve));
  supplied.productionId = 'mutated-production';
  supplied.attemptId = 'mutated-attempt';
  supplied.commandId = 'mutated-command';
  supplied.payload = { actor: 'rival', goalId: 'mutated-goal', observationVersion: 999 };
  releaseAcknowledgement();
  await work;

  assert.equal(observedCommands.length, 2);
  assert.notEqual(observedCommands[0], supplied);
  assert.equal(observedCommands.every((value) => Object.isFrozen(value) && Object.isFrozen(value.payload)), true);
  assert.equal(observedCommands.every((value) => value.productionId === 'production' && value.attemptId === 'attempt-1' && value.commandId === 'command-digTarget'), true);
  assert.equal(setup.events.every((event) => event.productionId === 'production' && event.attemptId === 'attempt-1' && event.payload.commandId === 'command-digTarget'), true);
});

test('rejects a passable live placement block that differs from the signed target block', async () => {
  const authority = survivalAuthority();
  const receipt = authority.issueTargetReceipt({
    ...authorityIdentity(),
    payload: {
      mark: 'block-mismatch', item: 'crafting_table',
      target: { x: 4, y: 65, z: 4, dimension: 'minecraft:overworld', block: 'air' }
    }
  });
  const setup = rig({
    survivalAuthority: authority,
    survivalObserver: observerSequence(observation(7, { inventory: { crafting_table: 1 } }))
  });
  setup.bot.inventory = { items: () => [{ name: 'crafting_table' }] };
  setup.bot.blockAt = ({ y }) => y === 65
    ? { name: 'cave_air', boundingBox: 'empty' }
    : { name: 'grass_block', boundingBox: 'block' };
  setup.bot.equipCalls = [];
  setup.bot.equip = async (...args) => { setup.bot.equipCalls.push(args); };
  setup.bot.placeCalls = [];
  setup.bot.placeBlock = async (...args) => { setup.bot.placeCalls.push(args); };

  await assert.rejects(setup.runtime.execute(survivalCommand('placeAtMark', {
    item: 'crafting_table', mark: 'block-mismatch', resolvedMark: normalizedMark(4, 65, 4), authorization: 'mark-ok', receipt
  })), { code: 'SURVIVAL_TARGET_BLOCK_MISMATCH' });
  assert.deepEqual(setup.bot.equipCalls, []);
  assert.deepEqual(setup.bot.placeCalls, []);
});

test('silently fences cancellation while observeSurvival observation is pending', async () => {
  let releaseObservation;
  const pendingObservation = new Promise((resolve) => { releaseObservation = resolve; });
  let observedSignal;
  const setup = rig({
    survivalAuthority: survivalAuthority(),
    survivalObserver: {
      async observe({ signal }) {
        observedSignal = signal;
        await pendingObservation;
        return observation(8);
      }
    }
  });

  const work = setup.runtime.execute(survivalCommand('observeSurvival'));
  await new Promise((resolve) => setImmediate(resolve));
  await setup.runtime.cancel('attempt-1');
  assert.equal(observedSignal.aborted, true);
  releaseObservation();

  await work;
  assert.deepEqual(setup.events.map(({ kind }) => kind), ['commandAcknowledged']);
});

test('silently fences observation evidence when cancellation occurs during commandCompleted emission', async () => {
  const authority = survivalAuthority();
  const receipt = authority.issueTargetReceipt({
    ...authorityIdentity(),
    payload: { targetId: 'completion-race', target: { x: 12, y: 64, z: 9, dimension: 'minecraft:overworld', block: 'oak_log' } }
  });
  let releaseCompletion;
  const pendingCompletion = new Promise((resolve) => { releaseCompletion = resolve; });
  let completionStarted;
  const completion = new Promise((resolve) => { completionStarted = resolve; });
  const setup = rig({
    survivalAuthority: authority,
    survivalObserver: observerSequence(
      observation(7, { blocks: { 'completion-race': 'oak_log' }, passableTargets: [] }),
      observation(8, { blocks: { 'completion-race': 'air' }, passableTargets: ['completion-race'] })
    )
  });
  let completionDug = false;
  setup.bot.blockAt = () => completionDug ? { name: 'air', boundingBox: 'empty' } : { name: 'oak_log', boundingBox: 'block' };
  setup.bot.dig = async () => { completionDug = true; };
  const sink = {
    async emit(event) {
      setup.events.push(event);
      if (event.kind === 'commandCompleted') {
        completionStarted();
        await pendingCompletion;
      }
    }
  };

  const work = setup.runtime.execute(survivalCommand('digTarget', {
    targetId: 'completion-race', block: 'oak_log', receipt
  }), sink);
  await completion;
  await setup.runtime.cancel('attempt-1');
  releaseCompletion();

  await work;
  assert.deepEqual(setup.events.map(({ kind }) => kind), ['commandAcknowledged', 'commandCompleted']);
});

test('keeps an expired receipt reservation exclusive until cancellation-ignoring work settles', async () => {
  let now = 1_000;
  const authority = survivalAuthority(() => now);
  const first = authority.issueTargetReceipt({
    ...authorityIdentity(),
    payload: { targetId: 'leased-oak', target: { x: 12, y: 64, z: 9, dimension: 'minecraft:overworld', block: 'oak_log' } }
  });
  const setup = rig({
    survivalAuthority: authority,
    survivalObserver: observerSequence(observation(7, { blocks: { 'leased-oak': 'oak_log' } }))
  });
  setup.bot.blockAt = () => ({ name: 'oak_log' });
  let settleDig;
  setup.bot.dig = () => new Promise((resolve) => { settleDig = resolve; });

  const work = setup.runtime.execute(survivalCommand('digTarget', {
    targetId: 'leased-oak', block: 'oak_log', receipt: first
  }));
  await new Promise((resolve) => setImmediate(resolve));
  await setup.runtime.cancel('attempt-1');
  now = first.expiresAt;
  const heldDuringLateWork = authority.snapshotReservations().length;
  const second = authority.issueTargetReceipt({
    ...authorityIdentity({ receiptId: 'fresh-conflict', attemptId: 'attempt-2', actorId: 'rival', goalId: 'rival-goal' }),
    payload: { targetId: 'rival-oak', target: { x: 12, y: 64, z: 9, dimension: 'minecraft:overworld', block: 'oak_log' } }
  });
  const conflict = authority.reserve(second, 'rival');
  if (conflict.ok) authority.release(second.receiptId, 'red-test-cleanup');

  settleDig();
  await work;
  const afterSettlement = authority.reserve(second, 'rival');

  assert.equal(heldDuringLateWork, 1);
  assert.deepEqual(conflict, { ok: false, code: 'RESERVATION_CONFLICT' });
  assert.equal(afterSettlement.ok, true);
  authority.release(second.receiptId, 'test-complete');
});

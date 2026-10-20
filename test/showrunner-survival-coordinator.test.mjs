import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import { createSurvivalAuthority } from '../src/showrunner/survival-authority.mjs';
import { createSurvivalCoordinator } from '../src/showrunner/survival-coordinator.mjs';
import { planSurvivalStep } from '../src/showrunner/survival-planner.mjs';

function gatherGoal(actor, id = `${actor}-gather`, overrides = {}) {
  return {
    id, actor, kind: 'gather', region: `${actor}_tree`, item: 'oak_log', count: 1,
    timeoutMs: 30_000, maxReplans: 2,
    completion: { kind: 'actor_inventory_at_least', actor, item: 'oak_log', count: 1 },
    ...overrides
  };
}

function craftGoal() {
  return {
    id: 'hero-craft', actor: 'hero', kind: 'craft', recipe: 'oak_planks', mark: 'table', count: 4,
    timeoutMs: 30_000, maxReplans: 2,
    completion: { kind: 'actor_inventory_at_least', actor: 'hero', item: 'oak_planks', count: 4 }
  };
}

function episode(goals) {
  return {
    schemaVersion: 1,
    episode: 'coordinator-test',
    actors: ['hero', 'rival'],
    regions: {
      hero_tree: { purpose: 'tree', min: { x: 0, y: 60, z: 0 }, max: { x: 9, y: 80, z: 9 }, allowedBlocks: ['oak_log'] },
      rival_tree: { purpose: 'tree', min: { x: 10, y: 60, z: 0 }, max: { x: 19, y: 80, z: 9 }, allowedBlocks: ['oak_log'] }
    },
    marks: { table: { position: { x: 8, y: 64, z: 8 }, safeHeadroom: true } },
    dialogueBoundaries: goals.map(({ id }) => id),
    goals
  };
}

function beatEpisode(goals) {
  return {
    ...episode(goals),
    schemaVersion: 2,
    beats: [
      { id: 'arrival', goalIds: [] },
      { id: 'first_priorities', goalIds: [] },
      { id: 'two_trees', goalIds: goals.slice(0, 2).map(({ id }) => id) },
      { id: 'crafting', goalIds: goals.slice(2).map(({ id }) => id) },
      { id: 'breaking_ground', goalIds: [] },
      { id: 'hook', goalIds: [] }
    ],
    dialogueBoundaries: undefined
  };
}

function identity(overrides = {}) {
  return {
    productionId: 'production', takeId: 'take', sceneId: 'scene', beatId: 'beat',
    attemptId: 'attempt-1', cueId: 'cue', causalSequence: 0, ...overrides
  };
}

function observation(version, overrides = {}) {
  return {
    version,
    actors: {
      hero: { inventory: {}, atMark: null, equipped: {} },
      rival: { inventory: {}, atMark: null, equipped: {} }
    },
    targets: [], drops: [], placedAtMarks: {},
    dimension: 'minecraft:overworld',
    ...overrides
  };
}

function target(id, actor, x) {
  return {
    id, region: `${actor}_tree`, block: 'oak_log', x, y: 64, z: 1,
    dimension: 'minecraft:overworld', pathCost: 1, distance: 1
  };
}

function createRig(goals, options = {}) {
  let now = 1_000;
  const commands = [];
  const emitted = [];
  const cancellations = [];
  const { privateKey } = generateKeyPairSync('ed25519');
  const authority = createSurvivalAuthority({ clock: { now: () => now++ }, signingKey: privateKey });
  const actors = Object.fromEntries(['hero', 'rival'].map((actor) => [actor, {
    execute(command, sink) { commands.push({ actor, command, sink }); },
    async cancel(attemptId) {
      cancellations.push({ actor, attemptId });
      return {
        authoritative: true, acknowledged: true, cancelled: true,
        actor, targetAttemptId: attemptId
      };
    },
    async awaitQuiescence() { return { authoritative: true, acknowledged: true, quiescent: true, actor }; },
    ...options.actorOverrides?.[actor]
  }]));
  const coordinator = createSurvivalCoordinator({
    episode: options.episode ?? episode(goals),
    planner: options.planner ?? planSurvivalStep,
    authority,
    actors,
    emit: options.emit ?? (async (event) => { emitted.push(event); }),
    clock: options.clock ?? { now: () => now++ },
    cleanupTimeoutMs: options.cleanupTimeoutMs
  });
  const used = new Set();

  function next(actor, kind) {
    const entry = commands.find((candidate) => candidate.actor === actor && candidate.command.kind === kind && !used.has(candidate));
    assert.ok(entry, `missing ${kind} command for ${actor}`);
    used.add(entry);
    return entry;
  }

  async function send(entry, kind, payload = {}) {
    await entry.sink.emit(entry.sink.createEvent(kind, { commandId: entry.command.commandId, ...payload }));
  }

  async function barrier(entry, proof) {
    await send(entry, 'commandAcknowledged');
    await send(entry, 'commandCompleted');
    await send(entry, 'observationVerified', { proof });
  }

  async function observe(actor, value) {
    const entry = next(actor, 'observeSurvival');
    await barrier(entry, {
      kind: 'observeSurvival', authoritative: true, actor,
      goalId: entry.command.payload.goalId,
      observationVersion: value.version,
      before: null,
      after: { ...value, authoritative: true, actor, goalId: entry.command.payload.goalId, observationVersion: value.version }
    });
    return entry;
  }

  async function completeAction(actor, after) {
    const entry = commands.find((candidate) => candidate.actor === actor &&
      candidate.command.kind !== 'observeSurvival' && !used.has(candidate));
    assert.ok(entry, `missing Survival action for ${actor}`);
    used.add(entry);
    await barrier(entry, {
      kind: entry.command.kind, authoritative: true, actor,
      goalId: entry.command.payload.goalId,
      observationVersion: after.version,
      before: observation(entry.command.payload.observationVersion),
      after: { ...after, authoritative: true, actor, goalId: entry.command.payload.goalId, observationVersion: after.version }
    });
    return entry;
  }

  async function release(goalId, nextIdentity) {
    const current = coordinator.snapshot().identity;
    return coordinator.handle({
      kind: 'dialogueCompleted',
      ...current,
      eventId: `dialogue-completed:${goalId}:${current.cueId}`,
      causalSequence: coordinator.snapshot().causalSequence + 1,
      monotonicTimestamp: now++,
      payload: {
        goalId,
        nextIdentity,
        proof: { authoritative: true, dialogueCompleted: true }
      }
    });
  }

  async function releaseBeat(beatId, overrides = {}) {
    const current = coordinator.snapshot().identity;
    const event = {
      kind: 'dialogueCompleted',
      ...current,
      ...overrides,
      eventId: `dialogue-completed:${beatId}:${current.cueId}`,
      causalSequence: coordinator.snapshot().causalSequence + 1,
      monotonicTimestamp: now++,
      payload: {
        beatId,
        proof: { authoritative: true, dialogueCompleted: true }
      }
    };
    await coordinator.expectDialogue(event);
    return coordinator.handle(event);
  }

  return { authority, actors, coordinator, commands, emitted, cancellations, next, send, barrier, observe, completeAction, release, releaseBeat };
}

test('schema-v2 waits for dialogue, completes empty beats, and confines multiple goals to their beat', async () => {
  const goals = [gatherGoal('hero'), gatherGoal('rival'), craftGoal()];
  const rig = createRig(goals, { episode: beatEpisode(goals) });
  await rig.coordinator.start(identity({ beatId: 'arrival', cueId: 'arrival' }));

  assert.equal(rig.coordinator.snapshot().status, 'awaiting_dialogue');
  assert.equal(rig.commands.length, 0);

  await rig.releaseBeat('arrival');
  await rig.coordinator.flush();
  assert.deepEqual(rig.emitted.map(({ kind }) => kind), ['beatCompleted']);
  assert.equal(rig.commands.length, 0);

  const afterArrival = rig.coordinator.snapshot();
  await rig.coordinator.handle({
    kind: 'dialogueCompleted', ...afterArrival.identity,
    eventId: 'wrong-beat', causalSequence: afterArrival.causalSequence + 1,
    monotonicTimestamp: 2_000,
    payload: { beatId: 'two_trees', proof: { authoritative: true, dialogueCompleted: true } }
  });
  assert.equal(rig.coordinator.snapshot().ignoredEvents.at(-1).reason, 'BEAT_NOT_CURRENT');
  assert.equal(rig.commands.length, 0);

  await rig.releaseBeat('first_priorities', { beatId: 'first_priorities', cueId: 'first_priorities' });
  await rig.coordinator.flush();
  assert.deepEqual(rig.emitted.map(({ kind }) => kind), ['beatCompleted', 'beatCompleted']);
  assert.deepEqual(rig.emitted.map(({ causalSequence }) => causalSequence), [2, 2]);
  assert.equal(rig.commands.length, 0);

  await rig.releaseBeat('two_trees');
  assert.deepEqual(rig.commands.map(({ command }) => command.kind), ['observeSurvival', 'observeSurvival']);
  await rig.observe('hero', observation(1, { targets: [target('hero-log', 'hero', 1)] }));
  await rig.observe('rival', observation(1, { targets: [target('rival-log', 'rival', 11)] }));
  await rig.completeAction('hero', observation(2, { actors: {
    hero: { inventory: { oak_log: 1 }, atMark: null, equipped: {} },
    rival: { inventory: {}, atMark: null, equipped: {} }
  } }));
  await rig.observe('hero', observation(3, { actors: {
    hero: { inventory: { oak_log: 1 }, atMark: null, equipped: {} },
    rival: { inventory: {}, atMark: null, equipped: {} }
  } }));
  assert.equal(rig.emitted.some((event) => event.kind === 'beatCompleted' && event.payload?.beatId === 'two_trees'), false);
  await rig.completeAction('rival', observation(2, { actors: {
    hero: { inventory: { oak_log: 1 }, atMark: null, equipped: {} },
    rival: { inventory: { oak_log: 1 }, atMark: null, equipped: {} }
  } }));
  await rig.observe('rival', observation(3, { actors: {
    hero: { inventory: { oak_log: 1 }, atMark: null, equipped: {} },
    rival: { inventory: { oak_log: 1 }, atMark: null, equipped: {} }
  } }));
  await rig.coordinator.flush();

  assert.deepEqual(rig.emitted.slice(-3).map(({ kind }) => kind), ['goalCompleted', 'goalCompleted', 'beatCompleted']);
  assert.equal(rig.emitted.at(-1).payload.beatId, 'two_trees');
  assert.equal(rig.commands.some(({ command }) => command.payload.goalId === 'hero-craft'), false);
  assert.equal(rig.coordinator.snapshot().status, 'awaiting_dialogue');
});

test('schema-v2 requires the exact expected beat identity and a positive causal sequence before work', async () => {
  const goals = [gatherGoal('hero'), gatherGoal('rival'), craftGoal()];
  const rig = createRig(goals, { episode: beatEpisode(goals) });
  await rig.coordinator.start(identity({ beatId: 'arrival', cueId: 'arrival' }));
  const current = rig.coordinator.snapshot().identity;

  await rig.coordinator.handle({
    kind: 'dialogueCompleted', ...current, beatId: 'spoofed', cueId: 'spoofed',
    eventId: 'spoofed-identity', causalSequence: 1, monotonicTimestamp: 2_000,
    payload: { beatId: 'arrival', proof: { authoritative: true, dialogueCompleted: true } }
  });
  assert.equal(rig.coordinator.snapshot().ignoredEvents.at(-1).reason, 'WRONG_IDENTITY');
  assert.equal(rig.emitted.length, 0);

  await rig.coordinator.handle({
    kind: 'dialogueCompleted', ...current,
    eventId: 'unsafe-causal-sequence', causalSequence: 0, monotonicTimestamp: 2_001,
    payload: { beatId: 'arrival', proof: { authoritative: true, dialogueCompleted: true } }
  });
  assert.equal(rig.coordinator.snapshot().ignoredEvents.at(-1).reason, 'CAUSAL_SEQUENCE_INVALID');
  assert.equal(rig.emitted.length, 0);

  await rig.coordinator.handle({
    kind: 'dialogueCompleted', ...current,
    eventId: 'far-ahead-causal-sequence', causalSequence: 999, monotonicTimestamp: 2_002,
    payload: { beatId: 'arrival', proof: { authoritative: true, dialogueCompleted: true } }
  });
  assert.equal(rig.coordinator.snapshot().ignoredEvents.at(-1).reason, 'DIALOGUE_FENCE_MISMATCH');
  assert.equal(rig.coordinator.snapshot().status, 'awaiting_dialogue');
  assert.equal(rig.emitted.length, 0);

  await rig.releaseBeat('arrival');
  assert.deepEqual(rig.coordinator.snapshot().identity, {
    productionId: 'production', takeId: 'take', sceneId: 'scene',
    beatId: 'first_priorities', attemptId: 'attempt-1', cueId: 'first_priorities'
  });
});

test('schema-v2 maps a terminal internal goal blocker to the active visible beat', async () => {
  const goals = [gatherGoal('hero')];
  const configured = beatEpisode(goals);
  configured.beats[2].goalIds = [goals[0].id];
  configured.beats[3].goalIds = [];
  const rig = createRig(goals, {
    episode: configured,
    planner: ({ observation: observed }) => ({
      status: 'blocked', reason: 'NO_VALID_TARGET', observationVersion: observed.version
    })
  });
  await rig.coordinator.start(identity({ beatId: 'arrival', cueId: 'arrival' }));
  await rig.releaseBeat('arrival');
  await rig.releaseBeat('first_priorities');
  await rig.releaseBeat('two_trees');
  await rig.observe('hero', observation(1));

  assert.equal(rig.coordinator.snapshot().status, 'blocked');
  assert.equal(rig.emitted.at(-1).kind, 'beatBlocked');
  assert.deepEqual(rig.emitted.at(-1).payload, {
    beatId: 'two_trees', goalId: 'hero-gather', actor: 'hero', observationVersion: 1,
    reason: 'NO_VALID_TARGET', proof: { authoritative: true, terminal: true }
  });
});

test('schema-v2 rebinds only a quiescent blocked coordinator to a fresh attempt and rejects late old-attempt events', async () => {
  const goals = [gatherGoal('hero')];
  const configured = beatEpisode(goals);
  configured.beats[2].goalIds = [goals[0].id];
  configured.beats[3].goalIds = [];
  const rig = createRig(goals, {
    episode: configured,
    planner: ({ observation: observed }) => ({
      status: 'blocked', reason: 'NO_VALID_TARGET', observationVersion: observed.version
    })
  });
  const attemptOne = identity({ beatId: 'arrival', cueId: 'arrival' });
  const attemptTwo = identity({ beatId: 'arrival', cueId: 'arrival', attemptId: 'attempt-2' });
  const request = {
    previousAttemptId: 'attempt-1',
    nextIdentity: attemptTwo,
    proof: { authoritative: true, cleanupVerified: true, resetVerified: true }
  };

  await rig.coordinator.start(attemptOne);
  await assert.rejects(rig.coordinator.rebind(request), { code: 'SURVIVAL_REBIND_NOT_READY' });
  await rig.releaseBeat('arrival');
  await rig.releaseBeat('first_priorities');
  await rig.releaseBeat('two_trees');
  await rig.observe('hero', observation(1));
  assert.equal(rig.coordinator.snapshot().status, 'blocked');
  assert.deepEqual(rig.authority.snapshotReservations(), []);

  await rig.coordinator.rebind(request);
  assert.equal(rig.coordinator.snapshot().status, 'awaiting_dialogue');
  assert.equal(rig.coordinator.snapshot().beatIndex, 0);
  assert.equal(rig.coordinator.snapshot().identity.attemptId, 'attempt-2');
  assert.deepEqual(rig.coordinator.snapshot().decisions, []);

  await rig.coordinator.handle({
    kind: 'commandCompleted', ...attemptOne,
    eventId: 'late-attempt-one', causalSequence: 99, monotonicTimestamp: 9_999,
    payload: { commandId: 'late-command' }
  });
  assert.equal(rig.coordinator.snapshot().ignoredEvents.at(-1).reason, 'STALE_ATTEMPT');
  assert.equal(rig.coordinator.snapshot().status, 'awaiting_dialogue');

  await rig.releaseBeat('arrival');
  await rig.coordinator.flush();
  assert.equal(rig.emitted.at(-1).attemptId, 'attempt-2');
  assert.equal(rig.emitted.at(-1).payload.beatId, 'arrival');
});

test('runs ordered goals sequentially and emits safe boundaries only after verified completion', async () => {
  const rig = createRig([gatherGoal('hero'), craftGoal()]);
  await rig.coordinator.start(identity());

  await rig.observe('hero', observation(1, { targets: [target('hero-log', 'hero', 1)] }));
  const gatherAction = await rig.completeAction('hero', observation(2, {
    actors: {
      hero: { inventory: { oak_log: 1 }, atMark: null, equipped: {} },
      rival: { inventory: {}, atMark: null, equipped: {} }
    }
  }));
  assert.equal(gatherAction.command.kind, 'moveNearTarget');
  assert.deepEqual(rig.emitted, []);

  await rig.observe('hero', observation(3, {
    actors: {
      hero: { inventory: { oak_log: 1 }, atMark: null, equipped: {} },
      rival: { inventory: {}, atMark: null, equipped: {} }
    }
  }));
  await rig.coordinator.flush();
  assert.deepEqual(rig.emitted.map(({ kind }) => kind), ['goalCompleted', 'safeDialogueBoundary']);
  assert.equal(rig.coordinator.snapshot().status, 'awaiting_dialogue');
  assert.equal(rig.commands.some(({ command }) => command.payload.goalId === 'hero-craft'), false);

  await rig.release('hero-gather', identity({ beatId: 'craft-beat', cueId: 'craft-cue', causalSequence: 0 }));
  const craftObservation = rig.next('hero', 'observeSurvival');
  assert.equal(craftObservation.command.payload.goalId, 'hero-craft');
  assert.equal(craftObservation.command.cueId, 'craft-cue');

  await rig.barrier(craftObservation, {
    kind: 'observeSurvival', authoritative: true, actor: 'hero', goalId: 'hero-craft', observationVersion: 4,
    before: null,
    after: { ...observation(4, { actors: {
      hero: { inventory: { oak_log: 1 }, atMark: 'table', equipped: {} },
      rival: { inventory: {}, atMark: null, equipped: {} }
    } }), authoritative: true, actor: 'hero', goalId: 'hero-craft', observationVersion: 4 }
  });
  const craftAction = await rig.completeAction('hero', observation(5, { actors: {
    hero: { inventory: { oak_planks: 4 }, atMark: 'table', equipped: {} },
    rival: { inventory: {}, atMark: null, equipped: {} }
  } }));
  assert.equal(craftAction.command.kind, 'craftRecipe');
  await rig.observe('hero', observation(6, { actors: {
    hero: { inventory: { oak_planks: 4 }, atMark: 'table', equipped: {} },
    rival: { inventory: {}, atMark: null, equipped: {} }
  } }));
  await rig.coordinator.flush();

  assert.deepEqual(rig.emitted.map(({ kind }) => kind), [
    'goalCompleted', 'safeDialogueBoundary', 'goalCompleted', 'safeDialogueBoundary'
  ]);
  assert.equal(rig.coordinator.snapshot().status, 'awaiting_dialogue');
  await rig.release('hero-craft', identity({ beatId: 'outro-beat', cueId: 'outro-cue', causalSequence: 0 }));
  assert.equal(rig.coordinator.snapshot().status, 'completed');
});

test('plans consecutive two-actor gathering in parallel with distinct reservations', async () => {
  const rig = createRig([gatherGoal('hero'), gatherGoal('rival')]);
  await rig.coordinator.start(identity());

  await rig.observe('hero', observation(1, { targets: [target('hero-log', 'hero', 1)] }));
  assert.equal(rig.commands.filter(({ command }) => command.kind !== 'observeSurvival').length, 0);
  await rig.observe('rival', observation(1, { targets: [target('rival-log', 'rival', 11)] }));

  const actions = rig.commands.filter(({ command }) => command.kind === 'moveNearTarget');
  assert.equal(actions.length, 2);
  assert.deepEqual(actions.map(({ actor }) => actor).sort(), ['hero', 'rival']);
  assert.notEqual(actions[0].command.payload.receipt.receiptId, actions[1].command.payload.receipt.receiptId);
  assert.notDeepEqual(actions[0].command.payload.receipt.payload.target, actions[1].command.payload.receipt.payload.target);
  assert.equal(new Set(rig.coordinator.snapshot().decisions.map(({ reservationKey }) => reservationKey)).size, 2);

  await rig.completeAction('hero', observation(2, { actors: {
    hero: { inventory: { oak_log: 1 }, atMark: null, equipped: {} },
    rival: { inventory: {}, atMark: null, equipped: {} }
  } }));
  await rig.observe('hero', observation(3, { actors: {
    hero: { inventory: { oak_log: 1 }, atMark: null, equipped: {} },
    rival: { inventory: {}, atMark: null, equipped: {} }
  } }));
  assert.equal(rig.emitted.some(({ kind }) => kind === 'safeDialogueBoundary'), false);

  await rig.completeAction('rival', observation(2, { actors: {
    hero: { inventory: { oak_log: 1 }, atMark: null, equipped: {} },
    rival: { inventory: { oak_log: 1 }, atMark: null, equipped: {} }
  } }));
  await rig.observe('rival', observation(3, { actors: {
    hero: { inventory: { oak_log: 1 }, atMark: null, equipped: {} },
    rival: { inventory: { oak_log: 1 }, atMark: null, equipped: {} }
  } }));
  await rig.coordinator.flush();

  assert.deepEqual(rig.emitted.map(({ kind }) => kind), [
    'goalCompleted', 'goalCompleted', 'safeDialogueBoundary', 'safeDialogueBoundary'
  ]);
  assert.deepEqual(
    rig.emitted.filter(({ kind }) => kind === 'safeDialogueBoundary').map(({ payload }) => payload.goalId),
    ['rival-gather', 'hero-gather']
  );
  assert.equal(rig.coordinator.snapshot().status, 'awaiting_dialogue');
  await rig.release('hero-gather', identity({ beatId: 'rival-beat', cueId: 'rival-cue', causalSequence: 0 }));
  assert.equal(rig.coordinator.snapshot().status, 'awaiting_dialogue');
  await rig.release('rival-gather', identity({ beatId: 'next-beat', cueId: 'next-cue', causalSequence: 0 }));
  assert.equal(rig.coordinator.snapshot().status, 'completed');
  assert.deepEqual(rig.authority.snapshotReservations(), []);
});

test('re-observes after one transient path failure and then completes', async () => {
  const rig = createRig([gatherGoal('hero')]);
  await rig.coordinator.start(identity());
  await rig.observe('hero', observation(1, { targets: [target('hero-log-a', 'hero', 1)] }));
  const failed = rig.next('hero', 'moveNearTarget');
  await rig.send(failed, 'commandAcknowledged');
  await rig.send(failed, 'commandFailed', { reason: 'PATH_INVALIDATED' });

  await rig.observe('hero', observation(2, { targets: [target('hero-log-b', 'hero', 2)] }));
  await rig.completeAction('hero', observation(3, { actors: {
    hero: { inventory: { oak_log: 1 }, atMark: null, equipped: {} },
    rival: { inventory: {}, atMark: null, equipped: {} }
  } }));
  await rig.observe('hero', observation(4, { actors: {
    hero: { inventory: { oak_log: 1 }, atMark: null, equipped: {} },
    rival: { inventory: {}, atMark: null, equipped: {} }
  } }));
  await rig.coordinator.flush();

  assert.equal(rig.coordinator.snapshot().status, 'awaiting_dialogue');
  assert.equal(rig.coordinator.snapshot().decisions.filter(({ status }) => status === 'action').length, 2);
  assert.deepEqual(rig.emitted.map(({ kind }) => kind), ['goalCompleted', 'safeDialogueBoundary']);
  await rig.release('hero-gather', identity({ beatId: 'next-beat', cueId: 'next-cue', causalSequence: 0 }));
  assert.equal(rig.coordinator.snapshot().status, 'completed');
});

test('stops after the authored replan budget and emits a terminal blocker', async () => {
  const rig = createRig([gatherGoal('hero', 'bounded', { maxReplans: 1 })]);
  await rig.coordinator.start(identity());
  await rig.observe('hero', observation(1, { targets: [target('hero-log', 'hero', 1)] }));
  const failed = rig.next('hero', 'moveNearTarget');
  await rig.send(failed, 'commandAcknowledged');
  await rig.send(failed, 'commandFailed', { reason: 'PATH_OBSTRUCTED' });
  await rig.observe('hero', observation(2, { targets: [target('hero-log-next', 'hero', 2)] }));

  assert.equal(rig.commands.filter(({ command }) => command.kind === 'moveNearTarget').length, 1);
  assert.equal(rig.coordinator.snapshot().status, 'blocked');
  assert.equal(rig.emitted.at(-1).kind, 'goalBlocked');
  assert.equal(rig.emitted.at(-1).payload.reason, 'REPLAN_BUDGET_EXHAUSTED');
});

test('emits an immediate terminal blocker when the planner finds no valid target', async () => {
  const rig = createRig([gatherGoal('hero')]);
  await rig.coordinator.start(identity());
  await rig.observe('hero', observation(1));

  assert.equal(rig.coordinator.snapshot().status, 'blocked');
  assert.deepEqual(rig.emitted.map(({ kind }) => kind), ['goalBlocked']);
  assert.equal(rig.emitted[0].payload.reason, 'NO_TARGET_AVAILABLE');
});

test('cancellation releases reservations and fences late actor proof', async () => {
  const rig = createRig([gatherGoal('hero')]);
  await rig.coordinator.start(identity());
  await rig.observe('hero', observation(1, { targets: [target('hero-log', 'hero', 1)] }));
  const action = rig.next('hero', 'moveNearTarget');

  await rig.coordinator.cancel('attempt-1');
  assert.equal(rig.coordinator.snapshot().status, 'cancelled');
  assert.deepEqual(rig.authority.snapshotReservations(), []);
  assert.deepEqual(rig.cancellations, [
    { actor: 'hero', attemptId: 'attempt-1' },
    { actor: 'rival', attemptId: 'attempt-1' }
  ]);

  await rig.send(action, 'commandAcknowledged');
  await rig.send(action, 'commandCompleted');
  await rig.send(action, 'observationVerified', {
    proof: {
      kind: 'moveNearTarget', authoritative: true, actor: 'hero', goalId: 'hero-gather', observationVersion: 2,
      before: observation(1), after: observation(2)
    }
  });
  assert.deepEqual(rig.emitted, []);
  assert.equal(rig.coordinator.snapshot().ignoredEvents.at(-1).reason, 'STALE_ATTEMPT');
});

test('rejects stale observation versions and wrong cue identities without consuming the pending barrier', async () => {
  const rig = createRig([gatherGoal('hero')]);
  await rig.coordinator.start(identity());
  const entry = rig.next('hero', 'observeSurvival');
  await rig.send(entry, 'commandAcknowledged');
  await rig.send(entry, 'commandCompleted');
  const stale = entry.sink.createEvent('observationVerified', {
    commandId: entry.command.commandId,
    proof: {
      kind: 'observeSurvival', authoritative: true, actor: 'hero', goalId: 'hero-gather',
      observationVersion: 0, before: null, after: observation(0)
    }
  });
  await rig.coordinator.handle(stale);
  assert.equal(rig.coordinator.snapshot().ignoredEvents.at(-1).reason, 'PROOF_STALE');

  const valid = entry.sink.createEvent('observationVerified', {
    commandId: entry.command.commandId,
    proof: {
      kind: 'observeSurvival', authoritative: true, actor: 'hero', goalId: 'hero-gather',
      observationVersion: 1, before: null,
      after: observation(1, {
        authoritative: true, actor: 'hero', goalId: 'hero-gather', observationVersion: 1,
        targets: [target('hero-log', 'hero', 1)]
      })
    }
  });
  await rig.coordinator.handle({ ...valid, cueId: 'wrong-cue' });
  assert.equal(rig.coordinator.snapshot().ignoredEvents.at(-1).reason, 'WRONG_IDENTITY');

  await rig.coordinator.handle(valid);
  assert.equal(rig.commands.some(({ command }) => command.kind === 'moveNearTarget'), true);
});

test('holds an authored boundary until matching dialogue completion advances the fenced identity', async () => {
  const rig = createRig([gatherGoal('hero'), craftGoal()]);
  await rig.coordinator.start(identity({ beatId: 'gather-beat', cueId: 'gather-cue' }));
  await rig.observe('hero', observation(1, { actors: {
    hero: { inventory: { oak_log: 1 }, atMark: null, equipped: {} },
    rival: { inventory: {}, atMark: null, equipped: {} }
  } }));

  assert.equal(rig.coordinator.snapshot().status, 'awaiting_dialogue');
  assert.equal(rig.commands.some(({ command }) => command.payload.goalId === 'hero-craft'), false);
  const before = rig.coordinator.snapshot();
  await rig.coordinator.handle({
    kind: 'dialogueCompleted', ...before.identity,
    eventId: 'wrong-goal-release', causalSequence: before.causalSequence + 1, monotonicTimestamp: 2_000,
    payload: {
      goalId: 'hero-craft', nextIdentity: identity({ beatId: 'craft-beat', cueId: 'craft-cue' }),
      proof: { authoritative: true, dialogueCompleted: true }
    }
  });
  assert.equal(rig.coordinator.snapshot().ignoredEvents.at(-1).reason, 'BOUNDARY_NOT_PENDING');

  await rig.release('hero-gather', identity({ beatId: 'craft-beat', cueId: 'craft-cue', causalSequence: 0 }));
  assert.equal(rig.commands.at(-1).command.payload.goalId, 'hero-craft');
  assert.equal(rig.commands.at(-1).command.cueId, 'craft-cue');

  const stale = before.identity;
  await rig.coordinator.handle({
    kind: 'dialogueCompleted', ...stale,
    eventId: 'stale-old-cue', causalSequence: 99, monotonicTimestamp: 2_001,
    payload: {
      goalId: 'hero-gather', nextIdentity: identity({ beatId: 'bad', cueId: 'bad' }),
      proof: { authoritative: true, dialogueCompleted: true }
    }
  });
  assert.equal(rig.coordinator.snapshot().ignoredEvents.at(-1).reason, 'WRONG_IDENTITY');
});

test('requires cancellation and authoritative quiescence capabilities and fails closed on cleanup errors', async () => {
  assert.throws(() => createRig([gatherGoal('hero')], {
    actorOverrides: { hero: { cancel: undefined } }
  }), { code: 'SURVIVAL_ACTORS_REQUIRED' });
  assert.throws(() => createRig([gatherGoal('hero')], {
    actorOverrides: { hero: { awaitQuiescence: undefined } }
  }), { code: 'SURVIVAL_ACTORS_REQUIRED' });

  const falseReceipt = createRig([gatherGoal('hero')], {
    actorOverrides: { hero: { async awaitQuiescence() { return { authoritative: true, acknowledged: true, quiescent: false, actor: 'hero' }; } } }
  });
  await falseReceipt.coordinator.start(identity());
  await assert.rejects(falseReceipt.coordinator.cancel('attempt-1'), { code: 'SURVIVAL_CLEANUP_FAILED' });
  assert.equal(falseReceipt.coordinator.snapshot().status, 'cleanup_failed');
  assert.deepEqual(falseReceipt.emitted, []);

  const unauthoritativeCancellation = createRig([gatherGoal('hero')], {
    actorOverrides: { hero: { async cancel(attemptId) {
      return { authoritative: false, acknowledged: true, cancelled: true, actor: 'hero', targetAttemptId: attemptId };
    } } }
  });
  await unauthoritativeCancellation.coordinator.start(identity());
  await assert.rejects(unauthoritativeCancellation.coordinator.cancel('attempt-1'), { code: 'SURVIVAL_CLEANUP_FAILED' });
  assert.equal(unauthoritativeCancellation.coordinator.snapshot().status, 'cleanup_failed');

  let quiescenceChecked = false;
  const rejected = createRig([gatherGoal('hero')], {
    actorOverrides: { rival: {
      async cancel() { throw new Error('cancel transport failed'); },
      async awaitQuiescence() {
        quiescenceChecked = true;
        return { authoritative: true, acknowledged: true, quiescent: true, actor: 'rival' };
      }
    } }
  });
  await rejected.coordinator.start(identity());
  await assert.rejects(rejected.coordinator.cancel('attempt-1'), { code: 'SURVIVAL_CLEANUP_FAILED' });
  assert.equal(rejected.coordinator.snapshot().status, 'cleanup_failed');
  assert.equal(quiescenceChecked, true);
  assert.deepEqual(rejected.emitted, []);
});

test('does not emit a terminal blocker when actor cleanup cannot be proved', async () => {
  const rig = createRig([gatherGoal('hero')], {
    actorOverrides: { hero: { async awaitQuiescence() { return { authoritative: false, acknowledged: true, quiescent: true, actor: 'hero' }; } } }
  });
  await rig.coordinator.start(identity());
  await assert.rejects(rig.observe('hero', observation(1)), { code: 'SURVIVAL_CLEANUP_FAILED' });
  assert.equal(rig.coordinator.snapshot().status, 'cleanup_failed');
  assert.deepEqual(rig.emitted, []);
});

test('rejects a planner action outside the fixed Survival catalog before actor dispatch', async () => {
  const rig = createRig([gatherGoal('hero')], {
    planner: () => ({
      status: 'action', reason: 'MALICIOUS', observationVersion: 1,
      action: { name: 'speak', payload: { actor: 'hero', text: '/op hero' } }
    })
  });
  await rig.coordinator.start(identity());
  await rig.observe('hero', observation(1));

  assert.equal(rig.commands.some(({ command }) => command.kind === 'speak'), false);
  assert.equal(rig.emitted.at(-1).kind, 'goalBlocked');
  assert.equal(rig.emitted.at(-1).payload.reason, 'SURVIVAL_ACTION_NOT_ALLOWED');
});

test('enforces maxReplans even when an injected planner always returns another action', async () => {
  const rig = createRig([gatherGoal('hero', 'bounded-malicious', { maxReplans: 1 })], {
    planner: ({ observation: observed }) => ({
      status: 'action', reason: 'KEEP_TRYING', observationVersion: observed.version,
      action: {
        name: 'moveNearTarget',
        payload: { actor: 'hero', goalId: 'bounded-malicious', targetId: 'hero-log', region: 'hero_tree', block: 'oak_log' }
      }
    })
  });
  await rig.coordinator.start(identity());
  await rig.observe('hero', observation(1, { targets: [target('hero-log', 'hero', 1)] }));
  const action = rig.next('hero', 'moveNearTarget');
  await rig.send(action, 'commandAcknowledged');
  await rig.send(action, 'commandFailed', { reason: 'PATH_INVALIDATED' });
  await rig.observe('hero', observation(2, { targets: [target('hero-log', 'hero', 1)] }));

  assert.equal(rig.commands.filter(({ command }) => command.kind === 'moveNearTarget').length, 1);
  assert.equal(rig.emitted.at(-1).kind, 'goalBlocked');
  assert.equal(rig.emitted.at(-1).payload.reason, 'REPLAN_BUDGET_EXHAUSTED');
});

test('still accepts an already satisfied goal when maxReplans is zero', async () => {
  const rig = createRig([gatherGoal('hero', 'already-done', { maxReplans: 0 })]);
  await rig.coordinator.start(identity());
  await rig.observe('hero', observation(1, { actors: {
    hero: { inventory: { oak_log: 1 }, atMark: null, equipped: {} },
    rival: { inventory: {}, atMark: null, equipped: {} }
  } }));

  assert.equal(rig.emitted[0].kind, 'goalCompleted');
  assert.equal(rig.emitted.some(({ kind }) => kind === 'goalBlocked'), false);
});

test('accepts actor events only once and in exact acknowledgement, completion, observation order', async () => {
  const rig = createRig([gatherGoal('hero')]);
  await rig.coordinator.start(identity());
  const entry = rig.next('hero', 'observeSurvival');
  const initialPending = structuredClone(rig.coordinator.snapshot().pendingCommands[entry.command.commandId]);
  const observationFirst = entry.sink.createEvent('observationVerified', {
    commandId: entry.command.commandId,
    proof: {
      kind: 'observeSurvival', authoritative: true, actor: 'hero', goalId: 'hero-gather',
      observationVersion: 1, before: null, after: observation(1)
    }
  });
  await rig.coordinator.handle(observationFirst);
  assert.equal(rig.coordinator.snapshot().ignoredEvents.at(-1).reason, 'EVENT_ORDER_INVALID');
  assert.deepEqual(rig.coordinator.snapshot().pendingCommands[entry.command.commandId], initialPending);

  const ack = {
    ...entry.sink.createEvent('commandAcknowledged', { commandId: entry.command.commandId }),
    causalSequence: 1
  };
  await rig.coordinator.handle(ack);
  assert.equal(rig.coordinator.snapshot().pendingCommands[entry.command.commandId].acknowledged, true);
  await rig.coordinator.handle(ack);
  assert.equal(rig.coordinator.snapshot().ignoredEvents.at(-1).reason, 'DUPLICATE_EVENT');

  const skipped = {
    ...entry.sink.createEvent('commandCompleted', { commandId: entry.command.commandId }),
    causalSequence: 99
  };
  await rig.coordinator.handle(skipped);
  assert.equal(rig.coordinator.snapshot().ignoredEvents.at(-1).reason, 'CAUSAL_SEQUENCE_INVALID');
  assert.equal(rig.coordinator.snapshot().pendingCommands[entry.command.commandId].completed, false);
});

test('rejects an allowlisted action whose goal, item, destination, and action kind do not match trusted planning', async () => {
  const rig = createRig([gatherGoal('hero')], {
    planner: ({ observation: observed }) => ({
      status: 'action', reason: 'LAUNDER_EQUIPMENT', observationVersion: observed.version,
      action: {
        name: 'equipItem',
        payload: { actor: 'hero', goalId: 'hero-gather', item: 'wooden_pickaxe', destination: 'head' }
      }
    })
  });
  await rig.coordinator.start(identity());
  await rig.observe('hero', observation(1, { targets: [target('hero-log', 'hero', 1)] }));

  assert.equal(rig.commands.some(({ command }) => command.kind === 'equipItem'), false);
  assert.equal(rig.coordinator.snapshot().status, 'blocked');
  assert.equal(rig.emitted.at(-1).payload.reason, 'SURVIVAL_ACTION_GOAL_MISMATCH');
  assert.deepEqual(rig.authority.snapshotReservations(), []);
});

test('refuses to sign an observed item drop without an explicit entity stack count', async () => {
  const rig = createRig([gatherGoal('hero')]);
  await rig.coordinator.start(identity());
  await rig.observe('hero', observation(1, {
    drops: [{
      id: 'drop-1', entityId: 41, item: 'oak_log', region: 'hero_tree',
      dimension: 'minecraft:overworld', position: { x: 1, y: 64, z: 1 }
    }]
  }));

  assert.equal(rig.commands.some(({ command }) => command.kind === 'collectItem'), false);
  assert.equal(rig.coordinator.snapshot().status, 'blocked');
  assert.equal(rig.coordinator.snapshot().lastError, 'SURVIVAL_ITEM_UNRESOLVED');
  assert.deepEqual(rig.authority.snapshotReservations(), []);
});

test('rejects a correct action carrying a planner-forged observation version', async () => {
  const rig = createRig([gatherGoal('hero')], {
    planner: () => ({
      status: 'action', reason: 'MOVE_TO_GATHER_TARGET', observationVersion: 999,
      action: {
        name: 'moveNearTarget',
        payload: { actor: 'hero', goalId: 'hero-gather', targetId: 'hero-log', region: 'hero_tree', block: 'oak_log' }
      }
    })
  });
  await rig.coordinator.start(identity());
  await rig.observe('hero', observation(1, { targets: [target('hero-log', 'hero', 1)] }));

  assert.equal(rig.commands.some(({ command }) => command.kind === 'moveNearTarget'), false);
  assert.equal(rig.coordinator.snapshot().status, 'blocked');
  assert.equal(rig.emitted.at(-1).payload.reason, 'SURVIVAL_DECISION_OBSERVATION_MISMATCH');
  assert.deepEqual(rig.authority.snapshotReservations(), []);
});

test('fences a transiently failed target and chooses the next ranked candidate on re-observation', async () => {
  const rig = createRig([gatherGoal('hero')]);
  const cheap = target('z-cheap', 'hero', 1);
  const fallback = { ...target('a-fallback', 'hero', 2), pathCost: 3, distance: 2 };
  await rig.coordinator.start(identity());
  await rig.observe('hero', observation(1, { targets: [fallback, cheap] }));
  const first = rig.next('hero', 'moveNearTarget');
  assert.equal(first.command.payload.targetId, 'z-cheap');
  await rig.send(first, 'commandAcknowledged');
  await rig.send(first, 'commandFailed', { reason: 'PATH_INVALIDATED' });

  await rig.observe('hero', observation(2, { targets: [cheap, fallback] }));
  const second = rig.next('hero', 'moveNearTarget');
  assert.equal(second.command.payload.targetId, 'a-fallback');
});

test('enforces one total goal deadline and fails closed when cleanup exceeds its separate bound', async () => {
  const never = new Promise(() => {});
  const rig = createRig([gatherGoal('hero', 'deadline-goal', { timeoutMs: 5 })], {
    cleanupTimeoutMs: 10,
    actorOverrides: {
      hero: { async cancel() { return never; } }
    }
  });
  await rig.coordinator.start(identity());
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(rig.coordinator.snapshot().status, 'cleanup_failed');
  assert.equal(rig.coordinator.snapshot().lastError, 'SURVIVAL_CLEANUP_TIMEOUT');
  assert.equal(rig.emitted.some(({ kind }) => kind === 'goalBlocked' || kind === 'beatBlocked' || kind === 'goalCompleted'), false);
  assert.equal(rig.coordinator.snapshot().cleanupVerified, false);
});

test('does not authorize or dispatch an action once the total goal deadline has already expired', async () => {
  let now = 1_000;
  const rig = createRig([gatherGoal('hero', 'expired-before-plan')], {
    clock: { now: () => now }
  });
  await rig.coordinator.start(identity());
  now = 31_001;
  await rig.observe('hero', observation(1, { targets: [target('hero-log', 'hero', 1)] }));

  assert.equal(rig.commands.some(({ command }) => command.kind === 'moveNearTarget'), false);
  assert.equal(rig.coordinator.snapshot().status, 'blocked');
  assert.equal(rig.emitted.at(-1).payload.reason, 'GOAL_DEADLINE_EXCEEDED');
  assert.deepEqual(rig.authority.snapshotReservations(), []);
});

test('uses a positive integer actor budget with a fractional monotonic clock', async () => {
  let now = 1_000.25;
  const rig = createRig([gatherGoal('hero')], { clock: { now: () => { const value = now; now += 0.25; return value; } } });
  await rig.coordinator.start(identity());
  const observeCommand = rig.next('hero', 'observeSurvival').command;
  assert.equal(Number.isSafeInteger(observeCommand.payload.operationBudgetMs), true);
  assert.equal(observeCommand.payload.operationBudgetMs <= 30_000, true);
});

test('validates nested observation identity before promoting proof.after', async () => {
  const rig = createRig([gatherGoal('hero')]);
  await rig.coordinator.start(identity());
  const entry = rig.next('hero', 'observeSurvival');
  await rig.send(entry, 'commandAcknowledged');
  await rig.send(entry, 'commandCompleted');
  await rig.send(entry, 'observationVerified', { proof: {
    kind: 'observeSurvival', authoritative: true, actor: 'hero', goalId: 'hero-gather', observationVersion: 1,
    before: null,
    after: { ...observation(1), authoritative: true, actor: 'rival', goalId: 'hero-gather', observationVersion: 1 }
  } });
  assert.equal(rig.coordinator.snapshot().activeGoals[0].observation, null);
  assert.equal(rig.coordinator.snapshot().ignoredEvents.at(-1).reason, 'PROOF_INVALID');
});

test('cancels and rebinds safely when cleanup happens before coordinator start', async () => {
  const rig = createRig([gatherGoal('hero')]);
  await rig.coordinator.cancel('attempt-1');
  assert.equal(rig.coordinator.snapshot().status, 'cancelled');
  await rig.coordinator.rebind({
    previousAttemptId: 'attempt-1',
    nextIdentity: identity({ attemptId: 'attempt-2' }),
    proof: { authoritative: true, cleanupVerified: true, resetVerified: true }
  });
  assert.equal(rig.coordinator.snapshot().identity.attemptId, 'attempt-2');
});

test('commits an empty beat without awaiting reentrant delivery and exposes bridge delivery failure', async () => {
  const goals = [gatherGoal('hero')];
  const rig = createRig(goals, {
    episode: beatEpisode(goals),
    emit: () => { throw new Error('showrunner bridge offline'); }
  });
  await rig.coordinator.start(identity({ beatId: 'arrival', cueId: 'arrival' }));
  await rig.releaseBeat('arrival');

  assert.equal(rig.coordinator.snapshot().beatIndex, 1);
  await assert.rejects(rig.coordinator.flush(), { code: 'SURVIVAL_EMIT_FAILED' });
  assert.equal(rig.coordinator.snapshot().status, 'delivery_failed');
  assert.equal(rig.coordinator.snapshot().lastError, 'SURVIVAL_EMIT_FAILED');
});

test('serializes delivery failure and fences a concurrent next-beat event', async () => {
  const goals = [gatherGoal('hero')];
  let rejectDelivery;
  const delivery = new Promise((resolve, reject) => { rejectDelivery = reject; });
  const rig = createRig(goals, { episode: beatEpisode(goals), emit: () => delivery });
  await rig.coordinator.start(identity({ beatId: 'arrival', cueId: 'arrival' }));
  await rig.releaseBeat('arrival');

  const current = rig.coordinator.snapshot().identity;
  const nextDialogue = {
    kind: 'dialogueCompleted', ...current,
    eventId: 'next-beat-dialogue', causalSequence: rig.coordinator.snapshot().outputSequence + 1,
    monotonicTimestamp: 2_000,
    payload: { beatId: 'first_priorities', proof: { authoritative: true, dialogueCompleted: true } }
  };
  await rig.coordinator.expectDialogue(nextDialogue);
  rejectDelivery(new Error('bridge failed during next beat'));
  await Promise.resolve();
  await Promise.resolve();
  await rig.coordinator.handle(nextDialogue);
  await assert.rejects(rig.coordinator.flush(), { code: 'SURVIVAL_EMIT_FAILED' });

  assert.equal(rig.coordinator.snapshot().status, 'delivery_failed');
  assert.equal(rig.coordinator.snapshot().beatIndex, 1);
  assert.equal(rig.coordinator.snapshot().ignoredEvents.at(-1).reason, 'DELIVERY_FAILED');
});

test('invokes the direct bridge only after state commit and serializes outbound deliveries', async () => {
  const goals = [gatherGoal('hero')];
  const observedStates = [];
  let activeDeliveries = 0;
  let maximumActiveDeliveries = 0;
  let rig;
  rig = createRig(goals, {
    episode: beatEpisode(goals),
    emit: async (event) => {
      activeDeliveries += 1;
      maximumActiveDeliveries = Math.max(maximumActiveDeliveries, activeDeliveries);
      const snapshot = rig.coordinator.snapshot();
      observedStates.push({
        kind: event.kind,
        beatIndex: snapshot.beatIndex,
        status: snapshot.status,
        beatId: snapshot.identity.beatId
      });
      await rig.coordinator.handle({ kind: 'flush' });
      await new Promise((resolve) => setImmediate(resolve));
      activeDeliveries -= 1;
    }
  });

  await rig.coordinator.start(identity({ beatId: 'arrival', cueId: 'arrival' }));
  await rig.releaseBeat('arrival');
  await rig.coordinator.flush();

  assert.deepEqual(observedStates, [{
    kind: 'beatCompleted', beatIndex: 1, status: 'awaiting_dialogue', beatId: 'first_priorities'
  }]);
  assert.equal(maximumActiveDeliveries, 1);
});

test('starts multiple outbound events in strict serial order', async () => {
  let activeDeliveries = 0;
  let maximumActiveDeliveries = 0;
  const delivered = [];
  const rig = createRig([gatherGoal('hero')], {
    emit: async (event) => {
      activeDeliveries += 1;
      maximumActiveDeliveries = Math.max(maximumActiveDeliveries, activeDeliveries);
      delivered.push(event.kind);
      await new Promise((resolve) => setImmediate(resolve));
      activeDeliveries -= 1;
    }
  });
  await rig.coordinator.start(identity());
  await rig.observe('hero', observation(1, { actors: {
    hero: { inventory: { oak_log: 1 }, atMark: null, equipped: {} },
    rival: { inventory: {}, atMark: null, equipped: {} }
  } }));
  await rig.coordinator.flush();

  assert.deepEqual(delivered, ['goalCompleted', 'safeDialogueBoundary']);
  assert.equal(maximumActiveDeliveries, 1);
});

test('flush drains outbound work created by a reentrant direct bridge', async () => {
  const goals = [gatherGoal('hero')];
  const deliveredBeats = [];
  let rig;
  rig = createRig(goals, {
    episode: beatEpisode(goals),
    emit: async (event) => {
      deliveredBeats.push(event.payload.beatId);
      if (event.payload.beatId === 'arrival') await rig.releaseBeat('first_priorities');
    }
  });
  await rig.coordinator.start(identity({ beatId: 'arrival', cueId: 'arrival' }));
  await rig.releaseBeat('arrival');
  await rig.coordinator.flush();

  assert.deepEqual(deliveredBeats, ['arrival', 'first_priorities']);
  assert.equal(rig.coordinator.snapshot().beatIndex, 2);
  assert.equal(rig.coordinator.snapshot().identity.beatId, 'two_trees');
});

test('binds every planner decision to the complete active fence before action dispatch', async () => {
  const rig = createRig([gatherGoal('hero')]);
  await rig.coordinator.start(identity());
  await rig.observe('hero', observation(1, { targets: [target('hero-log', 'hero', 1)] }));
  const recorded = rig.coordinator.snapshot().decisions[0];

  assert.deepEqual(
    Object.fromEntries(['productionId', 'takeId', 'sceneId', 'beatId', 'attemptId', 'cueId']
      .map((field) => [field, recorded[field]])),
    {
      productionId: 'production', takeId: 'take', sceneId: 'scene', beatId: 'beat',
      attemptId: 'attempt-1', cueId: 'cue'
    }
  );
  assert.equal(recorded.eventId.startsWith('attempt-1:planner-decision:'), true);
  assert.equal(Number.isSafeInteger(recorded.causalSequence) && recorded.causalSequence > 0, true);
  assert.equal(Number.isFinite(recorded.monotonicTimestamp), true);
  assert.equal(recorded.observationVersion, 1);
  assert.deepEqual(recorded.decision.action, recorded.action);
});

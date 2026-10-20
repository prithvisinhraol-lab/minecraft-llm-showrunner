import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import { createActorRuntime } from '../src/showrunner/actor-runtime.mjs';
import { createSurvivalAuthority } from '../src/showrunner/survival-authority.mjs';
import { createSurvivalCoordinator } from '../src/showrunner/survival-coordinator.mjs';

const EPISODE_HASH = 'a'.repeat(64);

function goal() {
  return {
    id: 'hero-gather', actor: 'hero', kind: 'gather', region: 'hero_tree', item: 'oak_log', count: 1,
    timeoutMs: 1_000, maxReplans: 1,
    completion: { kind: 'actor_inventory_at_least', actor: 'hero', item: 'oak_log', count: 1 }
  };
}

function episode() {
  return {
    schemaVersion: 2, episode: 'composition', actors: ['hero', 'rival'],
    regions: {
      hero_tree: {
        purpose: 'tree', min: { x: 0, y: 60, z: 0 }, max: { x: 9, y: 80, z: 9 },
        allowedBlocks: ['oak_log']
      }
    },
    marks: {}, goals: [goal()],
    beats: [
      { id: 'arrival', goalIds: [] },
      { id: 'first_priorities', goalIds: [] },
      { id: 'two_trees', goalIds: ['hero-gather'] },
      { id: 'crafting', goalIds: [] },
      { id: 'breaking_ground', goalIds: [] },
      { id: 'hook', goalIds: [] }
    ]
  };
}

function identity(attemptId = 'attempt-1') {
  return {
    productionId: 'production', takeId: 'take', sceneId: 'scene', beatId: 'arrival',
    attemptId, cueId: 'arrival', causalSequence: 0
  };
}

function runtimeBot(actor) {
  return {
    username: actor,
    game: { dimension: 'overworld' },
    entity: { position: { x: 1, y: 64, z: 1 }, yaw: 0, pitch: 0 },
    pathfinder: { stop() {} },
    blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
    clearControlStates() {},
    setControlState() {}
  };
}

function cancelCommand(actor, attemptId, suffix) {
  return {
    kind: 'cancel', productionId: 'production', takeId: 'take', sceneId: 'scene',
    beatId: 'two_trees', attemptId: `${attemptId}:reset`, cueId: 'two_trees',
    eventId: `cancel-event-${suffix}`, causalSequence: 1, monotonicTimestamp: 1,
    commandId: `cancel-command-${suffix}`, idempotencyKey: `cancel-key-${suffix}`,
    payload: { targetAttemptId: attemptId, actor }
  };
}

async function releaseBeat(coordinator, beatId) {
  const current = coordinator.snapshot().identity;
  const event = {
    kind: 'dialogueCompleted', ...current,
    eventId: `dialogue-${beatId}`, causalSequence: coordinator.snapshot().causalSequence + 1,
    monotonicTimestamp: 1,
    payload: { beatId, proof: { authoritative: true, dialogueCompleted: true } }
  };
  await coordinator.expectDialogue(event);
  await coordinator.handle(event);
}

async function until(predicate) {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('composition did not settle');
}

function composition() {
  let now = 1_000;
  const approval = generateKeyPairSync('ed25519');
  const survival = generateKeyPairSync('ed25519');
  const authority = createSurvivalAuthority({ clock: { now: () => now++ }, signingKey: survival.privateKey });
  const runtimes = Object.fromEntries(['hero', 'rival'].map((actor) => [actor, createActorRuntime({
    bot: runtimeBot(actor), actorId: actor, movements: {},
    approvalPublicKey: approval.publicKey, episodeContentHash: EPISODE_HASH,
    survivalAuthority: authority,
    survivalObserver: {
      async observe({ goalId, observationVersion }) {
        return {
          authoritative: true, actor, goalId, observationVersion: observationVersion + 1,
          dimension: 'overworld', inventory: {}, equipment: {}, actors: {
            hero: { inventory: {}, atMark: null, equipped: {} },
            rival: { inventory: {}, atMark: null, equipped: {} }
          }, targets: [], drops: [], placedAtMarks: {}
        };
      }
    },
    clock: { now: () => now++ }
  })]));
  const emitted = [];
  const coordinator = createSurvivalCoordinator({
    episode: episode(),
    planner: ({ observation }) => ({ status: 'blocked', reason: 'NO_VALID_TARGET', observationVersion: observation.version }),
    authority, actors: runtimes, emit: (event) => { emitted.push(event); }, clock: { now: () => now++ }
  });
  return { authority, coordinator, emitted, runtimes };
}

test('real ActorRuntime cleanup is idempotent after a coordinator-origin blocker and attempt two can rebind', async () => {
  const setup = composition();
  await setup.coordinator.start(identity());
  await releaseBeat(setup.coordinator, 'arrival');
  await releaseBeat(setup.coordinator, 'first_priorities');
  await releaseBeat(setup.coordinator, 'two_trees');
  await until(() => setup.coordinator.snapshot().status === 'blocked');
  assert.equal(setup.emitted.at(-1).kind, 'beatBlocked');

  for (const actor of ['hero', 'rival']) {
    const events = [];
    await setup.runtimes[actor].execute(cancelCommand(actor, 'attempt-1', actor), {
      emit: (event) => { events.push(event); }
    });
    assert.equal(events.at(-1).payload.proof.quiescent, true);
  }
  await setup.coordinator.rebind({
    previousAttemptId: 'attempt-1', nextIdentity: identity('attempt-2'),
    proof: { authoritative: true, cleanupVerified: true, resetVerified: true }
  });
  assert.equal(setup.coordinator.snapshot().identity.attemptId, 'attempt-2');
  assert.deepEqual(setup.authority.snapshotReservations(), []);
});

test('real ActorRuntime cleanup is idempotent after a non-coordinator cancellation and rebinds cleanly', async () => {
  const setup = composition();
  await setup.coordinator.start(identity());
  await setup.coordinator.cancel('attempt-1');
  for (const actor of ['hero', 'rival']) {
    await setup.runtimes[actor].execute(cancelCommand(actor, 'attempt-1', `external-${actor}`), () => {});
  }
  await setup.coordinator.rebind({
    previousAttemptId: 'attempt-1', nextIdentity: identity('attempt-2'),
    proof: { authoritative: true, cleanupVerified: true, resetVerified: true }
  });
  assert.equal(setup.coordinator.snapshot().status, 'awaiting_dialogue');
  assert.deepEqual(setup.authority.snapshotReservations(), []);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createProductionController } from '../src/showrunner/production-controller.mjs';
import { loadEpisode } from '../src/showrunner/schema.mjs';

const safeMark = Object.freeze({
  dimension: 'minecraft:overworld',
  position: Object.freeze({ x: 532.5, y: 92, z: 44.5 }),
  facing: Object.freeze({ yaw: -90, pitch: 0 }),
  safeHeadroom: true
});

function rig(options = {}) {
  const calls = [];
  const observations = [];
  const transport = {
    async execute(command) {
      calls.push(command);
      if (options.execute) return options.execute(command);
      return { acknowledged: true, completed: true };
    },
    async observe(query) {
      observations.push(query);
      if (options.observe) return options.observe(query);
      return { acknowledged: true, completed: true, observation: options.observation };
    }
  };
  const allowlist = {
    actors: ['HeroActor', 'RivalActor'],
    dimensions: ['minecraft:overworld'],
    gamerules: ['doDaylightCycle', 'doWeatherCycle'],
    items: ['minecraft:stone', 'minecraft:wooden_sword'],
    effects: ['minecraft:speed'],
    tags: ['showrunner_production'],
    marks: { hero_start: safeMark, rival_start: { ...safeMark, position: { x: 540.5, y: 92, z: 44.5 }, facing: { yaw: 90, pitch: 0 } } }
  };
  const eventContext = () => ({ productionId: 'production', takeId: 'take', sceneId: 'scene', beatId: 'beat', attemptId: 'attempt-1', cueId: 'cue' });
  return { calls, observations, transport, controller: createProductionController({ transport, allowlist, eventContext }) };
}

test('constructs commands only from validated typed values', async () => {
  const { controller, calls } = rig();
  await controller.teleportActor({ actor: 'HeroActor', mark: safeMark });
  assert.deepEqual(calls, ['execute in minecraft:overworld run tp HeroActor 532.5 92 44.5 -90 0']);
});

test('restores the normalized baseline manifest using only fixed non-world-mutating templates', async () => {
  const episode = await loadEpisode(fileURLToPath(new URL('./fixtures/showrunner/valid-episode.yaml', import.meta.url)));
  const calls = [];
  const controller = createProductionController({
    transport: { async execute(command) { calls.push(command); return { acknowledged: true, completed: true }; } },
    eventContext: () => ({ productionId: 'production', takeId: 'take', sceneId: 'scene', beatId: 'beat', attemptId: 'attempt-1', cueId: 'cue' }),
    allowlist: {
      actors: Object.keys(episode.actors), dimensions: [episode.scene.dimension],
      gamerules: ['doDaylightCycle', 'doWeatherCycle'], items: [], effects: [],
      tags: [episode.set.baselineManifest.entityCleanupTag], marks: episode.scene.marks
    }
  });

  await controller.restore(episode.set.baselineManifest);

  assert.equal(calls[0], 'execute in minecraft:overworld run tp hero 532.5 92 44.5 -90 0');
  assert.equal(calls.includes('execute in minecraft:overworld run weather clear'), true);
  assert.equal(calls.some((command) => /(?:^|\s)(?:fill|setblock|damage)(?:\s|$)/.test(command)), false);
});

test('rejects selector and command injection in every identifier before transport', async () => {
  const { controller, calls } = rig();
  for (const actor of ['@a', 'HeroActor run op x', 'HeroActor\n/op x']) {
    await assert.rejects(controller.teleportActor({ actor, mark: safeMark }), { code: 'INVALID_ACTOR_NAME' });
  }
  await assert.rejects(controller.teleportActor({ actor: 'UnknownActor', mark: safeMark }), { code: 'ACTOR_NOT_ALLOWED' });
  await assert.rejects(controller.teleportActor({ actor: 'HeroActor', mark: { ...safeMark, dimension: 'minecraft:overworld run op x' } }), { code: 'INVALID_DIMENSION' });
  assert.deepEqual(calls, []);
});

test('rejects unsafe headroom and every out-of-bounds coordinate or facing value', async () => {
  const { controller, calls } = rig();
  await assert.rejects(controller.teleportActor({ actor: 'HeroActor', mark: { ...safeMark, safeHeadroom: false } }), { code: 'UNSAFE_HEADROOM' });
  for (const [field, value] of [['x', 30_000_001], ['y', 321], ['z', Number.NaN]]) {
    await assert.rejects(controller.teleportActor({
      actor: 'HeroActor',
      mark: { ...safeMark, position: { ...safeMark.position, [field]: value } }
    }), { code: 'INVALID_COORDINATE' });
  }
  await assert.rejects(controller.teleportActor({ actor: 'HeroActor', mark: { ...safeMark, facing: { yaw: 181, pitch: 0 } } }), { code: 'INVALID_FACING' });
  await assert.rejects(controller.teleportActor({ actor: 'HeroActor', mark: { ...safeMark, facing: { yaw: 0, pitch: 91 } } }), { code: 'INVALID_FACING' });
  assert.deepEqual(calls, []);
});

test('uses fixed templates for inventory, health, food, effects, weather, time, and gamerules', async () => {
  const { controller, calls } = rig();
  await controller.restoreActor({
    actor: 'HeroActor', mark: safeMark,
    inventory: [{ item: 'minecraft:wooden_sword', count: 1 }, { item: 'minecraft:stone', count: 2 }],
    health: 20, food: 20, effects: [{ id: 'minecraft:speed', durationSeconds: 4, amplifier: 1 }]
  });
  await controller.setEnvironment({
    dimension: 'minecraft:overworld', time: 6000, weather: 'clear',
    gamerules: { doDaylightCycle: false, doWeatherCycle: false }
  });
  assert.deepEqual(calls, [
    'execute in minecraft:overworld run tp HeroActor 532.5 92 44.5 -90 0',
    'clear HeroActor',
    'give HeroActor minecraft:wooden_sword 1',
    'give HeroActor minecraft:stone 2',
    'effect clear HeroActor',
    'effect give HeroActor minecraft:instant_health 1 255 true',
    'effect give HeroActor minecraft:saturation 1 255 true',
    'effect give HeroActor minecraft:speed 4 1 true',
    'execute in minecraft:overworld run gamerule doDaylightCycle false',
    'execute in minecraft:overworld run gamerule doWeatherCycle false',
    'execute in minecraft:overworld run time set 6000',
    'execute in minecraft:overworld run weather clear'
  ]);
});

test('rejects non-allowlisted item, effect, gamerule, weather, tag, and invalid numeric values', async () => {
  const { controller, calls } = rig();
  const baseline = { actor: 'HeroActor', mark: safeMark, inventory: [], health: 20, food: 20, effects: [] };
  await assert.rejects(controller.restoreActor({ ...baseline, inventory: [{ item: 'minecraft:diamond_block', count: 1 }] }), { code: 'ITEM_NOT_ALLOWED' });
  await assert.rejects(controller.restoreActor({ ...baseline, effects: [{ id: 'minecraft:strength', durationSeconds: 1, amplifier: 0 }] }), { code: 'EFFECT_NOT_ALLOWED' });
  await assert.rejects(controller.restoreActor({ ...baseline, health: 19 }), { code: 'UNSUPPORTED_HEALTH_BASELINE' });
  await assert.rejects(controller.restoreActor({ ...baseline, food: 19 }), { code: 'UNSUPPORTED_FOOD_BASELINE' });
  await assert.rejects(controller.setEnvironment({ dimension: 'minecraft:overworld', time: 6000, weather: 'snow', gamerules: {} }), { code: 'INVALID_WEATHER' });
  await assert.rejects(controller.setEnvironment({ dimension: 'minecraft:overworld', time: 24001, weather: 'clear', gamerules: {} }), { code: 'INVALID_TIME' });
  await assert.rejects(controller.setEnvironment({ dimension: 'minecraft:overworld', time: 6000, weather: 'clear', gamerules: { keepInventory: true } }), { code: 'GAMERULE_NOT_ALLOWED' });
  await assert.rejects(controller.removeTaggedEntities('showrunner_production] run kill @a'), { code: 'INVALID_PRODUCTION_TAG' });
  await assert.rejects(controller.removeTaggedEntities('other_tag'), { code: 'PRODUCTION_TAG_NOT_ALLOWED' });
  assert.deepEqual(calls, []);
});

test('requires daylight-cycle stabilization before any environment command', async () => {
  const { controller, calls } = rig();
  await assert.rejects(controller.setEnvironment({
    dimension: 'minecraft:overworld', time: 6000, weather: 'clear',
    gamerules: { doDaylightCycle: true, doWeatherCycle: false }
  }), { code: 'UNSTABLE_DAYLIGHT_CYCLE' });
  await assert.rejects(controller.setEnvironment({
    dimension: 'minecraft:overworld', time: 6000, weather: 'clear',
    gamerules: { doWeatherCycle: false }
  }), { code: 'UNSTABLE_DAYLIGHT_CYCLE' });
  assert.deepEqual(calls, []);
});

test('removes only the validated production tag with a fixed selector template', async () => {
  const { controller, calls } = rig();
  await controller.removeTaggedEntities('showrunner_production');
  assert.deepEqual(calls, ['kill @e[tag=showrunner_production]']);
});

test('rejects inherited or unknown command kinds without reaching transport', async () => {
  const { controller, calls } = rig();
  await assert.rejects(controller.execute({ kind: 'toString', payload: {} }), { code: 'COMMAND_KIND_NOT_ALLOWED' });
  await assert.rejects(controller.execute({ kind: '__proto__', payload: {} }), { code: 'COMMAND_KIND_NOT_ALLOWED' });
  assert.deepEqual(calls, []);
});

test('requires explicit transport acknowledgement and completion and reports failures', async (t) => {
  await t.test('missing acknowledgement', async () => {
    const { controller } = rig({ execute: async () => ({ acknowledged: false, completed: true }) });
    await assert.rejects(controller.teleportActor({ actor: 'HeroActor', mark: safeMark }), { code: 'TRANSPORT_NOT_ACKNOWLEDGED' });
  });
  await t.test('missing completion', async () => {
    const { controller } = rig({ execute: async () => ({ acknowledged: true, completed: false }) });
    await assert.rejects(controller.teleportActor({ actor: 'HeroActor', mark: safeMark }), { code: 'TRANSPORT_NOT_COMPLETED' });
  });
  await t.test('transport rejection', async () => {
    const { controller } = rig({ execute: async () => { throw new Error('socket closed'); } });
    await assert.rejects(controller.teleportActor({ actor: 'HeroActor', mark: safeMark }), { code: 'TRANSPORT_FAILURE' });
  });
});

test('emits causally identified controller events bound to the supplied command envelope', async () => {
  const events = [];
  const { transport } = rig();
  const controller = createProductionController({
    transport,
    emit: (event) => events.push(event),
    allowlist: {
      actors: ['HeroActor', 'RivalActor'], dimensions: ['minecraft:overworld'], gamerules: [], items: [], effects: [],
      tags: ['showrunner_production'], marks: { hero_start: safeMark, rival_start: safeMark }
    }
  });
  await controller.execute({
    kind: 'teleportActor', payload: { actor: 'HeroActor', mark: safeMark },
    productionId: 'production', takeId: 'take', sceneId: 'scene', beatId: 'beat', attemptId: 'attempt-1', cueId: 'cue'
  });
  assert.deepEqual(events.map((event) => event.causalSequence), [1, 2, 3]);
  assert.equal(events.every((event) => typeof event.eventId === 'string' && event.attemptId === 'attempt-1'), true);
});

test('rejects direct controller mutations when no causal context is available', async () => {
  const { transport } = rig();
  const controller = createProductionController({
    transport,
    allowlist: {
      actors: ['HeroActor', 'RivalActor'], dimensions: ['minecraft:overworld'], gamerules: [], items: [], effects: [],
      tags: ['showrunner_production'], marks: { hero_start: safeMark, rival_start: safeMark }
    }
  });
  await assert.rejects(controller.teleportActor({ actor: 'HeroActor', mark: safeMark }), { code: 'CONTROLLER_EVENT_IDENTITY_REQUIRED' });
  await assert.rejects(controller.execute({ kind: 'teleportActor', payload: { actor: 'HeroActor', mark: safeMark } }), { code: 'CONTROLLER_EVENT_IDENTITY_REQUIRED' });
});

test('snapshots command identity before awaiting transport', async () => {
  const events = [];
  let release;
  const transport = { execute: () => new Promise((resolve) => { release = () => resolve({ acknowledged: true, completed: true }); }) };
  const controller = createProductionController({
    transport, emit: (event) => events.push(event),
    allowlist: {
      actors: ['HeroActor', 'RivalActor'], dimensions: ['minecraft:overworld'], gamerules: [], items: [], effects: [],
      tags: ['showrunner_production'], marks: { hero_start: safeMark, rival_start: safeMark }
    }
  });
  const supplied = {
    kind: 'teleportActor', payload: { actor: 'HeroActor', mark: safeMark },
    productionId: 'production', takeId: 'take', sceneId: 'scene', beatId: 'beat', attemptId: 'attempt-1', cueId: 'cue'
  };
  const work = controller.execute(supplied);
  await new Promise((resolve) => setImmediate(resolve));
  supplied.attemptId = 'attempt-2';
  release();
  await work;
  assert.deepEqual(events.map((event) => event.attemptId), ['attempt-1', 'attempt-1', 'attempt-1']);
});

function manifest() {
  return {
    dimension: 'minecraft:overworld',
    blockAssertions: [{ position: { x: 532, y: 91, z: 44 }, block: 'minecraft:stone_bricks' }],
    checksumSamples: [{ id: 'platform', checksum: 'a'.repeat(64) }],
    actorBaselines: {
      HeroActor: { mark: 'hero_start', inventory: [], health: 20, food: 20, effects: [] },
      RivalActor: { mark: 'rival_start', inventory: [], health: 20, food: 20, effects: [] }
    },
    environment: { time: 6000, weather: 'clear', gamerules: { doDaylightCycle: false, doWeatherCycle: false } },
    entityCleanupTag: 'showrunner_production'
  };
}

function exactObservation() {
  return {
    actors: {
      HeroActor: { dimension: 'minecraft:overworld', position: { x: 532.5, y: 92, z: 44.5 }, facing: { yaw: -90, pitch: 0 }, safeHeadroom: true, inventory: [], health: 20, food: 20, effects: [] },
      RivalActor: { dimension: 'minecraft:overworld', position: { x: 540.5, y: 92, z: 44.5 }, facing: { yaw: 90, pitch: 0 }, safeHeadroom: true, inventory: [], health: 20, food: 20, effects: [] }
    },
    blocks: [{ position: { x: 532, y: 91, z: 44 }, block: 'minecraft:stone_bricks' }],
    checksums: { platform: 'a'.repeat(64) },
    environment: { time: 6000, weather: 'clear', gamerules: { doDaylightCycle: false, doWeatherCycle: false } },
    taggedEntityCount: 0
  };
}

test('verifies only declared manifest assertions from acknowledged authoritative telemetry', async () => {
  const { controller, observations } = rig({ observation: exactObservation() });
  const result = await controller.verifySet(manifest());
  assert.equal(result.ok, true);
  assert.deepEqual(result.mismatches, []);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].kind, 'verifySet');
  assert.deepEqual(observations[0].blockAssertions, manifest().blockAssertions);
  assert.equal('protectedCuboid' in observations[0], false);
});

test('reports declared block, checksum, cleanup, actor, headroom, and environment mismatches', async () => {
  const observation = exactObservation();
  observation.actors.HeroActor.inventory = [{ item: 'minecraft:stone', count: 1 }];
  observation.actors.HeroActor.health = 19;
  observation.actors.HeroActor.effects = [{ id: 'minecraft:speed', durationSeconds: 1, amplifier: 0 }];
  observation.actors.HeroActor.safeHeadroom = false;
  observation.actors.HeroActor.dimension = 'minecraft:the_nether';
  observation.blocks[0].block = 'minecraft:dirt';
  observation.checksums.platform = 'b'.repeat(64);
  observation.taggedEntityCount = 1;
  observation.environment.weather = 'rain';
  const { controller } = rig({ observation });
  const result = await controller.verifySet(manifest());
  assert.equal(result.ok, false);
  assert.deepEqual(new Set(result.mismatches.map(({ kind }) => kind)), new Set([
    'actor_inventory', 'actor_health', 'actor_effects', 'actor_headroom', 'actor_dimension',
    'block_assertion', 'checksum_sample', 'tagged_entities', 'environment'
  ]));
});

test('requires an exact allowlisted actor baseline set and rejects actor redirection fields', async () => {
  const first = rig({ observation: exactObservation() });
  const partial = manifest();
  delete partial.actorBaselines.RivalActor;
  await assert.rejects(first.controller.verifySet(partial), { code: 'ACTOR_BASELINE_MISMATCH' });

  const second = rig({ observation: exactObservation() });
  const redirected = manifest();
  redirected.actorBaselines.HeroActor.actor = 'RivalActor';
  await assert.rejects(second.controller.verifySet(redirected), { code: 'INVALID_ACTOR_BASELINE' });
  assert.deepEqual(first.observations, []);
  assert.deepEqual(second.observations, []);
});

test('verification fails closed without acknowledged, completed, authoritative telemetry', async (t) => {
  for (const [name, receipt, code] of [
    ['ack', { acknowledged: false, completed: true, observation: exactObservation() }, 'TRANSPORT_NOT_ACKNOWLEDGED'],
    ['completion', { acknowledged: true, completed: false, observation: exactObservation() }, 'TRANSPORT_NOT_COMPLETED'],
    ['telemetry', { acknowledged: true, completed: true }, 'VERIFICATION_TELEMETRY_REQUIRED']
  ]) {
    await t.test(name, async () => {
      const { controller } = rig({ observe: async () => receipt });
      await assert.rejects(controller.verifySet(manifest()), { code });
    });
  }
});

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { sourceEpisodeHash } from '../src/showrunner/approved-bank.mjs';
import { createActorRuntime } from '../src/showrunner/actor-runtime.mjs';
import { createArtifactWriter } from '../src/showrunner/artifacts.mjs';
import { runCliCommand } from '../src/showrunner/cli.mjs';
import { approveCandidateBank } from '../src/showrunner/rehearsal.mjs';
import { loadEpisode } from '../src/showrunner/schema.mjs';
import { createShowrunner } from '../src/showrunner/state-machine.mjs';
import { createSurvivalAuthority } from '../src/showrunner/survival-authority.mjs';
import { createSurvivalCoordinator } from '../src/showrunner/survival-coordinator.mjs';
import { planSurvivalStep } from '../src/showrunner/survival-planner.mjs';
import { loadSurvivalEpisode } from '../src/showrunner/survival-schema.mjs';

const meadowEpisodePath = path.resolve('production/episodes/first-day-meadow.survival.yaml');
const meadowShowrunnerEpisodePath = path.resolve('production/episodes/first-day-meadow.yaml');
const meadowScriptPath = path.resolve('production/scripts/first-day-meadow.md');
const approvalKeys = generateKeyPairSync('ed25519');
const cues = Object.freeze([
  {
    id: 'arrival', survivalBeatId: 'arrival', dialogue: [
      { id: 'arrival_practical', speaker: 'hero', line: 'New world. Same sunset. Let us start with wood.' },
      { id: 'arrival_energetic', speaker: 'rival', line: 'I was going to say flowers, but wood is harder to regret.' }
    ]
  },
  {
    id: 'first_priorities', survivalBeatId: 'first_priorities', dialogue: [
      { id: 'first_priorities_energetic', speaker: 'rival', line: 'I found the best tree. It was the second one.' },
      { id: 'first_priorities_practical', speaker: 'hero', line: 'Excellent. Keep revising until you have three logs.' }
    ]
  },
  {
    id: 'two_trees', survivalBeatId: 'two_trees', dialogue: [
      { id: 'two_trees_practical', speaker: 'hero', line: 'Three logs each, then meet at the flat stone.' },
      { id: 'two_trees_energetic', speaker: 'rival', line: 'Three. I can count trees when they cooperate.' }
    ]
  },
  {
    id: 'crafting', survivalBeatId: 'crafting', dialogue: [
      { id: 'crafting_practical', speaker: 'hero', line: 'Crafting starts here. Try not to craft a door.' },
      { id: 'crafting_energetic', speaker: 'rival', line: 'A door was not the plan. It was a possibility.' }
    ]
  },
  {
    id: 'breaking_ground', survivalBeatId: 'breaking_ground', dialogue: [
      { id: 'breaking_ground_practical', speaker: 'hero', line: 'Two pickaxes. One each. That avoids negotiations.' },
      { id: 'breaking_ground_energetic', speaker: 'rival', line: 'I accept mine and reject the implication.' }
    ]
  },
  {
    id: 'hook', survivalBeatId: 'hook', dialogue: [
      { id: 'hook_energetic', speaker: 'rival', line: 'Coal already? The meadow is showing off.' },
      { id: 'hook_practical', speaker: 'hero', line: 'Good. It can help with the shelter.' }
    ]
  }
]);
const dialogueLines = Object.freeze(cues.flatMap((cue) => cue.dialogue.map((line) => Object.freeze({
  ...line,
  cueId: cue.id
}))));
const approvedExcavationCells = Object.freeze([
  { x: 66, y: 64, z: 54 }, { x: 67, y: 64, z: 54 },
  { x: 66, y: 64, z: 55 }, { x: 67, y: 64, z: 55 },
  { x: 66, y: 64, z: 56 }, { x: 67, y: 64, z: 56 },
  { x: 66, y: 64, z: 57 }, { x: 67, y: 64, z: 57 },
  { x: 66, y: 64, z: 58 }, { x: 67, y: 64, z: 58 },
  { x: 66, y: 65, z: 58 }
]);
const heroLaneCells = Object.freeze(approvedExcavationCells.filter(({ x }) => x === 66));
const rivalLaneCells = Object.freeze(approvedExcavationCells.filter(({ x }) => x === 67));

test('all six visible cues bind to their Survival beat and expose both fixed lines in order', async () => {
  const episode = await loadEpisode(meadowShowrunnerEpisodePath);
  assert.equal(cues.length, 6);
  assert.deepEqual(episode.scene.cues.map(({ id, survivalBeatId }) => ({ id, survivalBeatId })), cues.map(({ id }) => ({
    id,
    survivalBeatId: id
  })));
  assert.deepEqual(episode.scene.cues.flatMap(({ dialogue }) => dialogue.map(({ id, cueId, speaker, fallbackLine }) => ({
    id, cueId, speaker, line: fallbackLine
  }))), dialogueLines);
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function coded(code) {
  return Object.assign(new Error(code), { code });
}

function rootedArtifactHost(rootPath) {
  const canonicalRootPath = path.resolve(rootPath);
  const rootIdentity = Object.freeze({ dev: 101, ino: 202 });
  const files = new Map();
  let snapshotVersion = 0;

  function relative(value) {
    if (typeof value !== 'string' || path.isAbsolute(value) || value === '..' || value.startsWith(`..${path.sep}`)) {
      throw coded('EINVAL');
    }
    return path.normalize(value);
  }

  function proof(relativePath, extra = {}) {
    return {
      canonicalRootPath,
      canonicalPath: path.join(canonicalRootPath, relativePath),
      rootIdentity,
      ...extra
    };
  }

  function assertUnsealed(input) {
    if (input.guardAbsentRelativePath && files.has(relative(input.guardAbsentRelativePath))) throw coded('ESEALED');
  }

  function assertExpected(relativePath, expected) {
    const data = files.get(relativePath);
    if (expected?.found === false) {
      if (data) throw coded('ESTALE');
      return;
    }
    if (!data || expected?.found !== true || data.byteLength !== expected.size || sha256(data) !== expected.sha256) {
      throw coded('ESTALE');
    }
    const record = JSON.parse(data.toString('utf8'));
    if (record.status !== expected.status || record.version !== expected.version) throw coded('ESTALE');
  }

  function snapshotEntry(relativePath) {
    const data = files.get(relativePath);
    return data
      ? proof(relativePath, { found: true, data: Buffer.from(data), size: data.byteLength, snapshotVersion })
      : proof(relativePath, { found: false, snapshotVersion });
  }

  return {
    async mkdirBeneath(input) {
      assert.equal(input.rootPath, rootPath);
      const relativePath = relative(input.relativePath);
      assertUnsealed(input);
      return proof(relativePath);
    },
    async appendFileBeneath(input) {
      assert.equal(input.rootPath, rootPath);
      const relativePath = relative(input.relativePath);
      assertUnsealed(input);
      files.set(relativePath, Buffer.concat([files.get(relativePath) ?? Buffer.alloc(0), Buffer.from(input.data)]));
      return proof(relativePath, { size: files.get(relativePath).byteLength });
    },
    async atomicWriteFileBeneath(input) {
      assert.equal(input.rootPath, rootPath);
      const relativePath = relative(input.relativePath);
      assertUnsealed(input);
      files.set(relativePath, Buffer.from(input.data));
      return proof(relativePath, { size: files.get(relativePath).byteLength });
    },
    async compareAndSwapFileBeneath(input) {
      assert.equal(input.rootPath, rootPath);
      const relativePath = relative(input.relativePath);
      assertUnsealed(input);
      assertExpected(relativePath, input.expectedCurrent);
      files.set(relativePath, Buffer.from(input.data));
      snapshotVersion += 1;
      return proof(relativePath, { size: files.get(relativePath).byteLength });
    },
    async readFileBeneath(input) {
      assert.equal(input.rootPath, rootPath);
      const relativePath = relative(input.relativePath);
      const data = files.get(relativePath);
      return data
        ? proof(relativePath, { found: true, data: Buffer.from(data), size: data.byteLength })
        : proof(relativePath, { found: false });
    },
    async readStateSnapshotBeneath(input) {
      assert.equal(input.rootPath, rootPath);
      return {
        canonicalRootPath,
        rootIdentity,
        snapshotVersion,
        status: snapshotEntry(relative(input.statusRelativePath)),
        decision: snapshotEntry(relative(input.decisionRelativePath))
      };
    },
    async commitDecisionBeneath(input) {
      assert.equal(input.rootPath, rootPath);
      const relativePath = relative(input.relativePath);
      if (files.has(relativePath)) throw coded('EEXIST');
      const statusPath = relative(input.statusProjection.relativePath);
      assertExpected(statusPath, input.expectedStatus);
      for (const [expectedPath, expected] of Object.entries(input.expectedFiles ?? {})) {
        const data = files.get(relative(expectedPath));
        if (expected.found === false) {
          if (data !== undefined) throw coded('ECOMPARE');
          continue;
        }
        if (!data || data.byteLength !== expected.size || sha256(data) !== expected.sha256) throw coded('ECOMPARE');
      }
      files.set(relativePath, Buffer.from(input.data));
      files.set(statusPath, Buffer.from(input.statusProjection.data));
      snapshotVersion += 1;
      return proof(relativePath, {
        size: files.get(relativePath).byteLength,
        statusProjection: proof(statusPath, { size: files.get(statusPath).byteLength })
      });
    },
    async readText(relativePath) {
      const data = files.get(relative(relativePath));
      if (!data) throw coded('ENOENT');
      return data.toString('utf8');
    }
  };
}

function showrunnerEpisode(survivalEpisode, episode) {
  assert.deepEqual(episode.scene.cues.map(({ survivalBeatId, survivalGoalIds }) => ({
    survivalBeatId, survivalGoalIds
  })), survivalEpisode.beats.map(({ id, goalIds }) => ({
    survivalBeatId: id, survivalGoalIds: goalIds
  })));
  const approvedBank = approveCandidateBank({
    candidates: dialogueLines.map((line) => ({
      id: `${line.id}-candidate`, cueId: line.cueId, authoredLineId: line.id, speaker: line.speaker, text: line.line,
      hardValidation: { ok: true, violations: [] }, softScores: {}
    })),
    decisions: dialogueLines.map((line) => ({
      candidateId: `${line.id}-candidate`, approved: true,
      variantId: `${line.id}-approved`, creator: 'Meadow Integration Creator'
    })),
    creator: 'Meadow Integration Creator',
    provenance: {
      sourceEpisode: episode,
      provider: 'integration', model: 'fake-host', promptTemplateVersion: 'meadow-v1',
      promptHash: 'c'.repeat(64), tokens: { input: 1, output: 1 }, latencyMs: 1
    },
    approvalPrivateKey: approvalKeys.privateKey
  });
  return {
    productionId: 'meadow-production',
    takeId: 'meadow-take',
    episode,
    survivalEpisode,
    approvedBank,
    selectedLines: Object.fromEntries(dialogueLines.map((line) => [
      line.id,
      { id: `${line.id}-approved`, text: line.line }
    ]))
  };
}

function fakeWorld(survivalEpisode) {
  const cell = (id, region, block, position, reservationKey) => ({
    id, region, block, ...position, dimension: 'minecraft:overworld',
    reservationKey, pathCost: 1, distance: 1
  });
  const targets = [
    cell('a-shared-hero', 'hero_tree', 'oak_log', { x: 40, y: 64, z: 40 }, 'tree:shared'),
    cell('b-hero-log', 'hero_tree', 'oak_log', { x: 41, y: 64, z: 40 }, 'tree:hero:b'),
    cell('c-hero-log', 'hero_tree', 'oak_log', { x: 42, y: 64, z: 40 }, 'tree:hero:c'),
    cell('a-shared-rival', 'rival_tree', 'oak_log', { x: 54, y: 64, z: 40 }, 'tree:shared'),
    cell('b-rival-log', 'rival_tree', 'oak_log', { x: 55, y: 64, z: 40 }, 'tree:rival:b'),
    cell('c-rival-log', 'rival_tree', 'oak_log', { x: 56, y: 64, z: 40 }, 'tree:rival:c'),
    cell('d-rival-log', 'rival_tree', 'oak_log', { x: 57, y: 64, z: 40 }, 'tree:rival:d'),
    cell('mine-00a-rogue', 'hero_mine_lane', 'stone', { x: 66, y: 65, z: 54 }, 'mine:rogue'),
    ...approvedExcavationCells.map((position, index) =>
      cell(
        `mine-${String(index).padStart(2, '0')}`,
        position.x === 66 ? 'hero_mine_lane' : 'rival_mine_lane',
        'stone',
        position,
        `mine:${index}`
      ))
  ];
  return {
    actors: {
      hero: { position: { x: 0, y: 64, z: 0 }, inventory: {}, equipment: {}, atMark: null, nearTargetId: null, lookedAtTargetId: null },
      rival: { position: { x: 0, y: 64, z: 0 }, inventory: {}, equipment: {}, atMark: null, nearTargetId: null, lookedAtTargetId: null }
    },
    targets,
    blocks: new Map(targets.map(({ id, block }) => [id, block])),
    drops: new Map(),
    entities: {},
    placedAtMarks: {},
    nextEntityId: 1,
    gatheredOakLogs: 0,
    crafting: { oakLogInput: 0, pickaxesByActor: { hero: 0, rival: 0 } },
    excavatedBlocks: [],
    excavatedByActor: { hero: [], rival: [] },
    transientPathFailures: 0,
    rejectedSharedTargets: 0,
    recipeIds: { oak_planks: 1, stick: 2, crafting_table: 3, wooden_pickaxe: 4, oak_log: 5 },
    recipeNames: { 1: 'oak_planks', 2: 'stick', 3: 'crafting_table', 4: 'wooden_pickaxe', 5: 'oak_log' },
    craftingMark: survivalEpisode.marks.crafting_table.position
  };
}

function inventoryCount(inventory, item) {
  return inventory[item] ?? 0;
}

function samePosition(left, right) {
  return left && right && ['x', 'y', 'z'].every((axis) => left[axis] === right[axis]);
}

function sortedCells(cells) {
  return [...cells].sort((left, right) =>
    left.x - right.x || left.y - right.y || left.z - right.z);
}

function createFakeBot(actorId, world) {
  const actor = world.actors[actorId];
  const bot = {
    username: actorId,
    entity: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 },
    game: { dimension: 'minecraft:overworld' },
    entities: world.entities,
    registry: {
      itemsByName: Object.fromEntries(Object.entries(world.recipeIds).map(([name, id]) => [name, { id, name }])),
      items: Object.fromEntries(Object.entries(world.recipeIds).map(([name, id]) => [id, { id, name }]))
    },
    inventory: {
      items() {
        return Object.entries(actor.inventory)
          .filter(([, count]) => count > 0)
          .map(([name, count]) => ({ name, count, type: world.recipeIds[name] ?? 100 }));
      }
    },
    pathfinder: {
      setMovements() {},
      async goto(goal) {
        const position = { x: goal.x, y: goal.y, z: goal.z };
        const target = world.targets.find((candidate) => world.blocks.get(candidate.id) !== 'air' && samePosition(candidate, position));
        if (actorId === 'rival' && target?.region === 'rival_tree' && world.transientPathFailures === 0) {
          world.transientPathFailures += 1;
          throw coded('PATH_OBSTRUCTED');
        }
        bot.entity.position = position;
        actor.position = { ...position };
        const entity = Object.values(world.entities).find((candidate) => samePosition(candidate.position, position));
        if (entity) {
          const drop = world.drops.get(entity.dropId);
          actor.inventory[drop.item] = inventoryCount(actor.inventory, drop.item) + 1;
          if (drop.item === 'oak_log') world.gatheredOakLogs += 1;
          world.drops.delete(drop.id);
          delete world.entities[entity.id];
        } else if (target) {
          actor.nearTargetId = target.id;
        } else if (samePosition(world.craftingMark, position)) {
          actor.atMark = 'crafting_table';
        }
      },
      stop() {}
    },
    chat() {},
    async look(yaw, pitch) { bot.entity.yaw = yaw; bot.entity.pitch = pitch; },
    async lookAt(position) {
      const target = world.targets.find((candidate) => world.blocks.get(candidate.id) !== 'air' && samePosition(candidate, position));
      actor.lookedAtTargetId = target?.id ?? null;
    },
    blockAt(position) {
      const target = world.targets.find((candidate) => samePosition(candidate, position));
      if (target) return { name: world.blocks.get(target.id), targetId: target.id, position, boundingBox: world.blocks.get(target.id) === 'air' ? 'empty' : 'block' };
      if (samePosition(world.craftingMark, position)) {
        const name = world.placedAtMarks.crafting_table ?? 'air';
        return { name, position, boundingBox: name === 'air' ? 'empty' : 'block' };
      }
      if (samePosition({ ...world.craftingMark, y: world.craftingMark.y - 1 }, position)) {
        return { name: 'stone', position, boundingBox: 'block' };
      }
      return { name: 'air', position, boundingBox: 'empty' };
    },
    async dig(block) {
      const target = world.targets.find(({ id }) => id === block.targetId);
      assert.ok(target, 'dig must resolve an approved target');
      world.blocks.set(target.id, 'air');
      if (target.region.endsWith('_mine_lane')) {
        const position = { x: target.x, y: target.y, z: target.z };
        world.excavatedBlocks.push(position);
        world.excavatedByActor[actorId].push(position);
      }
      const item = target.block === 'stone' ? 'cobblestone' : 'oak_log';
      const id = `drop:${target.id}`;
      const entityId = world.nextEntityId++;
      world.drops.set(id, {
        id, dropId: id, entityId, item, region: target.region,
        reservationKey: `drop:${target.id}`,
        dimension: 'minecraft:overworld',
        position: { x: target.x, y: target.y, z: target.z },
        count: 1
      });
      world.entities[entityId] = {
        id: entityId, dropId: id, position: { x: target.x, y: target.y, z: target.z },
        getDroppedItem: () => ({ name: item, count: 1 })
      };
    },
    recipesFor(itemId, _metadata, _count, table) {
      const name = world.recipeNames[itemId];
      const output = { oak_planks: 4, stick: 4, crafting_table: 1, wooden_pickaxe: 1 }[name];
      const requirements = {
        oak_planks: { oak_log: 1 },
        stick: { oak_planks: 2 },
        crafting_table: { oak_planks: 4 },
        wooden_pickaxe: { oak_planks: 3, stick: 2 }
      }[name];
      if (name === 'wooden_pickaxe' && table?.name !== 'crafting_table') return [];
      return name ? [{
        name,
        ingredients: Object.entries(requirements).map(([item, count]) => ({ id: world.recipeIds[item], count })),
        result: { count: output }
      }] : [];
    },
    async craft(recipe, count) {
      const requirements = {
        oak_planks: { oak_log: 1 },
        stick: { oak_planks: 2 },
        crafting_table: { oak_planks: 4 },
        wooden_pickaxe: { oak_planks: 3, stick: 2 }
      }[recipe.name];
      for (const [item, needed] of Object.entries(requirements)) {
        assert.equal(inventoryCount(actor.inventory, item) >= needed * count, true, `missing ${item}`);
        actor.inventory[item] -= needed * count;
      }
      if (recipe.name === 'oak_planks') world.crafting.oakLogInput += count;
      const output = recipe.result.count * count;
      actor.inventory[recipe.name] = inventoryCount(actor.inventory, recipe.name) + output;
      if (recipe.name === 'wooden_pickaxe') world.crafting.pickaxesByActor[actorId] += output;
    },
    async equip(item, destination) { actor.equipment[destination] = item.name; },
    async placeBlock() {
      assert.equal(inventoryCount(actor.inventory, 'crafting_table') >= 1, true);
      actor.inventory.crafting_table -= 1;
      world.placedAtMarks.crafting_table = 'crafting_table';
    },
    stopDigging() {},
    clearControlStates() {},
    setControlState() {}
  };
  return bot;
}

function survivalObservation(world, actorId, goalId, observationVersion) {
  const actor = world.actors[actorId];
  return {
    authoritative: true,
    actor: actorId,
    goalId,
    observationVersion,
    dimension: 'minecraft:overworld',
    position: { ...actor.position },
    inventory: { ...actor.inventory },
    equipment: { ...actor.equipment },
    ...(actor.nearTargetId === null ? {} : { nearTargetId: actor.nearTargetId }),
    ...(actor.lookedAtTargetId === null ? {} : { lookedAtTargetId: actor.lookedAtTargetId }),
    ...(actor.atMark === null ? {} : { nearMark: actor.atMark }),
    actors: Object.fromEntries(Object.entries(world.actors).map(([name, value]) => [name, {
      inventory: { ...value.inventory }, atMark: value.atMark, equipped: { ...value.equipment }
    }])),
    targets: world.targets.filter(({ id }) => world.blocks.get(id) !== 'air').map((target) => ({ ...target })),
    drops: [...world.drops.values()].map((drop) => ({ ...drop })),
    blocks: Object.fromEntries(world.targets.map(({ id }) => [id, world.blocks.get(id)])),
    passableTargets: world.targets.filter(({ id }) => world.blocks.get(id) === 'air').map(({ id }) => id),
    placedAtMarks: { ...world.placedAtMarks }
  };
}

function parseNdjson(text) {
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('CLI validates the normalized Survival episode without invoking a live take', async () => {
  const output = [];
  let liveTakeAttempted = false;
  const episode = await runCliCommand(['validate', meadowEpisodePath], {
    stdout: (line) => output.push(line),
    productionHost: { async run() { liveTakeAttempted = true; } }
  });

  assert.equal(episode.episode, 'first_day_meadow');
  assert.deepEqual(episode.goals.map(({ id }) => id), [
    'gather_hero_logs',
    'gather_rival_logs',
    'regroup_hero_at_crafting_table',
    'regroup_rival_at_crafting_table',
    'place_crafting_table',
    'craft_hero_wooden_pickaxe',
    'craft_rival_wooden_pickaxe',
    'equip_hero_wooden_pickaxe',
    'equip_rival_wooden_pickaxe',
    'excavate_hero_lane',
    'excavate_rival_lane'
  ]);
  assert.equal(output.some((line) => line.includes('Visible Survival beats: 6')), true);
  assert.equal(output.some((line) => line.includes('Normalized Survival goals: 11')), true);
  assert.equal(liveTakeAttempted, false);
});

test('the table placement goal crafts its missing dependency from gathered logs', () => {
  const decision = planSurvivalStep({
    goal: {
      id: 'place_crafting_table', actor: 'hero', kind: 'place', block: 'crafting_table',
      mark: 'crafting_table', count: 1, timeoutMs: 30_000, maxReplans: 2,
      completion: { kind: 'placed_at_mark', block: 'crafting_table', mark: 'crafting_table' }
    },
    observation: {
      version: 7,
      replanCount: 0,
      actors: {
        hero: { inventory: { oak_log: 3 }, atMark: 'crafting_table', equipped: {} },
        rival: { inventory: { oak_log: 3 }, atMark: 'crafting_table', equipped: {} }
      },
      targets: [],
      drops: [],
      placedAtMarks: {}
    },
    reservations: []
  });

  assert.deepEqual(decision, {
    status: 'action',
    action: {
      name: 'craftRecipe',
      payload: {
        actor: 'hero', goalId: 'place_crafting_table', recipe: 'oak_planks',
        count: 1, mark: 'crafting_table'
      }
    },
    reason: 'CRAFT_OAK_PLANKS_FOR_TABLE',
    observationVersion: 7
  });
});

test('a schema-v2 blocked first attempt rebinds, rejects late proof, and completes from the first beat on attempt two', async () => {
  const survivalEpisode = await loadSurvivalEpisode(meadowEpisodePath);
  const episode = structuredClone(await loadEpisode(meadowShowrunnerEpisodePath));
  episode.retry.wholeSceneAttempts = 2;
  const take = showrunnerEpisode(survivalEpisode, episode);
  const background = [];
  const coordinatorEvents = [];
  const survivalCommands = [];
  let runner;
  let now = 10_000;
  const clock = { now: () => now++ };
  const authority = createSurvivalAuthority({ clock, signingKey: approvalKeys.privateKey });
  const schedule = (work) => background.push(Promise.resolve(work));
  const send = (sink, kind, payload) => sink.emit(sink.createEvent(kind, payload));
  const barrier = async (command, sink, proof) => {
    await send(sink, 'commandAcknowledged', { commandId: command.commandId });
    await send(sink, 'commandCompleted', { commandId: command.commandId });
    await send(sink, 'observationVerified', { commandId: command.commandId, proof });
  };

  const actors = Object.fromEntries(['hero', 'rival'].map((actor) => [actor, {
    execute(command, sink) {
      schedule((async () => {
        if (command.kind === 'moveToMark') {
          await barrier(command, sink, {
            kind: 'mark', authoritative: true, actor, markId: command.payload.markId,
            dimension: command.payload.mark.dimension, radius: true, facing: true,
            safeHeadroom: true, dwellTicks: command.payload.mark.dwellTicks
          });
          return;
        }
        if (command.kind === 'speak') {
          await barrier(command, sink, {
            kind: 'speech', authoritative: true, observed: true, speaker: actor,
            cueId: command.cueId, text: command.payload.text
          });
          return;
        }
        if (command.kind === 'observeSurvival') {
          survivalCommands.push(structuredClone(command));
          const observationVersion = command.payload.observationVersion + 1;
          const completing = command.attemptId === 'blocked-attempt-2';
          const after = {
            authoritative: true, actor, goalId: command.payload.goalId, observationVersion,
            dimension: 'minecraft:overworld',
            inventory: completing ? { oak_log: 3, wooden_pickaxe: 1, cobblestone: actor === 'hero' ? 6 : 5 } : {},
            equipment: completing ? { hand: 'wooden_pickaxe' } : {},
            actors: {
              hero: {
                inventory: completing ? { oak_log: 3, wooden_pickaxe: 1, cobblestone: 6 } : {},
                atMark: completing ? 'crafting_table' : null,
                equipped: completing ? { hand: 'wooden_pickaxe' } : {}
              },
              rival: {
                inventory: completing ? { oak_log: 3, wooden_pickaxe: 1, cobblestone: 5 } : {},
                atMark: completing ? 'crafting_table' : null,
                equipped: completing ? { hand: 'wooden_pickaxe' } : {}
              }
            },
            targets: [], drops: [],
            placedAtMarks: completing ? { crafting_table: 'crafting_table' } : {}
          };
          await barrier(command, sink, {
            kind: 'observeSurvival', authoritative: true, actor, goalId: command.payload.goalId,
            observationVersion, before: null, after
          });
          return;
        }
        if (command.kind === 'cancel') {
          await barrier(command, sink, {
            kind: 'quiescence', authoritative: true, quiescent: true,
            targetAttemptId: command.payload.targetAttemptId
          });
          return;
        }
        throw coded(`unexpected actor command ${command.kind}`);
      })());
    },
    async cancel(attemptId) {
      return { authoritative: true, acknowledged: true, cancelled: true, actor, targetAttemptId: attemptId };
    },
    async awaitQuiescence() {
      return { authoritative: true, acknowledged: true, quiescent: true, actor };
    }
  }]));

  const coordinator = createSurvivalCoordinator({
    episode: survivalEpisode,
    planner: planSurvivalStep,
    authority,
    actors,
    emit: async (event) => {
      coordinatorEvents.push(structuredClone(event));
      background.push(runner.dispatch(event));
    },
    clock
  });
  const production = {
    execute(command, sink) {
      schedule(barrier(command, sink, command.kind === 'resetBaseline'
        ? {
            kind: 'reset', authoritative: true, verified: true,
            nextAttempt: { id: 'blocked-attempt-2', number: 2 }
          }
        : { kind: 'preparation', authoritative: true, prepared: true, actors: command.payload.actors }));
    }
  };
  const timers = {
    execute(command, sink) {
      schedule((async () => {
        if (command.kind === 'preRoll') {
          await send(sink, 'commandAcknowledged', { commandId: command.commandId });
          await send(sink, 'commandCompleted', { commandId: command.commandId });
          await send(sink, 'timerFired', { commandId: command.commandId });
          return;
        }
        if (command.kind === 'cueTimeout' || command.kind === 'cleanupTimeout') {
          await send(sink, 'commandAcknowledged', { commandId: command.commandId });
          await send(sink, 'commandCompleted', { commandId: command.commandId });
          return;
        }
        await barrier(command, sink, {
          kind: 'quiescence', authoritative: true, quiescent: true,
          resourceKind: 'timer', resourceId: command.payload.timerId
        });
      })());
    }
  };
  const capture = {
    execute(command, sink) {
      schedule((async () => {
        if (command.kind === 'armCapture') {
          await barrier(command, sink, {
            kind: 'captureArm', authoritative: true, armed: true, takeId: command.takeId
          });
          await send(sink, 'captureReady', { takeId: command.takeId, path: 'blocked-meadow.mkv' });
          return;
        }
        if (command.kind === 'stopCapture') {
          await barrier(command, sink, {
            kind: 'capture', authoritative: true, ok: true, takeId: command.takeId,
            path: 'retry-meadow.mkv',
            coverage: { complete: true, startMonotonicTimestamp: 10_000, endMonotonicTimestamp: now }
          });
          return;
        }
        await barrier(command, sink, {
          kind: 'quiescence', authoritative: true, quiescent: true,
          resourceKind: 'capture', resourceId: command.payload.captureCommandId
        });
      })());
    }
  };
  runner = createShowrunner({
    actors, production, timers, capture, survivalCoordinator: coordinator, clock,
    ids: {
      attempt: ({ number }) => `blocked-attempt-${number}`,
      command: ({ attemptId, number }) => `${attemptId}:showrunner:${number}`
    },
    approvalPublicKey: approvalKeys.publicKey
  });

  await runner.startTake(take);
  const initial = runner.snapshot();
  await coordinator.start({
    productionId: initial.productionId, takeId: initial.takeId, sceneId: initial.sceneId,
    beatId: initial.beatId, attemptId: initial.attemptId, cueId: initial.cueId,
    causalSequence: initial.causalSequence
  });
  for (let iteration = 0; iteration < 200; iteration += 1) {
    while (background.length > 0) await background.shift();
    await runner.dispatch({ kind: 'flush' });
    await coordinator.handle({ kind: 'flush' });
    await new Promise((resolve) => setImmediate(resolve));
    if (runner.snapshot().state === 'completed' && coordinator.snapshot().status === 'completed' && background.length === 0) break;
  }

  assert.equal(coordinatorEvents.some((event) => event.kind === 'beatBlocked' &&
    event.attemptId === 'blocked-attempt-1' && event.payload.beatId === 'two_trees'), true);
  assert.equal(coordinatorEvents.filter((event) => event.kind === 'beatCompleted' && event.payload.beatId === 'arrival').length, 2);
  assert.equal(runner.snapshot().state, 'completed');
  assert.equal(runner.snapshot().attemptNumber, 2);
  assert.equal(coordinator.snapshot().status, 'completed');
  assert.deepEqual(runner.snapshot().transcript.map(({ cueId, lineId }) => ({ cueId, lineId })),
    dialogueLines.map(({ cueId, id: lineId }) => ({ cueId, lineId })));

  const stale = survivalCommands.find((command) => command.attemptId === 'blocked-attempt-1');
  await coordinator.handle({
    kind: 'commandCompleted',
    productionId: stale.productionId, takeId: stale.takeId, sceneId: stale.sceneId,
    beatId: stale.beatId, attemptId: stale.attemptId, cueId: stale.cueId,
    eventId: 'late-attempt-one-proof', causalSequence: stale.causalSequence + 100,
    monotonicTimestamp: now++, payload: { commandId: stale.commandId }
  });
  assert.equal(coordinator.snapshot().ignoredEvents.at(-1).reason, 'STALE_ATTEMPT');
  assert.equal(coordinator.snapshot().status, 'completed');
  assert.deepEqual(authority.snapshotReservations(), []);
});

test('full meadow take completes six synchronized cues through genuine bounded Survival flow', async () => {
  const survivalEpisode = await loadSurvivalEpisode(meadowEpisodePath);
  const episode = await loadEpisode(meadowShowrunnerEpisodePath);
  const take = showrunnerEpisode(survivalEpisode, episode);
  const script = await readFile(meadowScriptPath, 'utf8');
  const world = fakeWorld(survivalEpisode);
  const artifactRoot = '/trusted-meadow-artifacts';
  const artifactHost = rootedArtifactHost(artifactRoot);
  const writer = createArtifactWriter(artifactRoot, {
    productionId: take.productionId,
    takeId: take.takeId
  }, { fsPort: artifactHost, survivalRequired: true });
  const takeDirectory = path.join('showrunner', take.productionId, take.takeId);
  const events = [];
  const eventWrites = [];
  const plannerWrites = [];
  const plannerRecords = [];
  let evidenceSequence = 0;
  let now = 1_000;
  const clock = { now: () => now++, async sleep(ms) { now += ms; } };
  const authority = createSurvivalAuthority({ clock, signingKey: approvalKeys.privateKey });

  function evidenceIdentity(source, goalId, actor) {
    evidenceSequence += 1;
    return {
      productionId: source.productionId,
      takeId: source.takeId,
      sceneId: source.sceneId,
      beatId: source.beatId,
      attemptId: source.attemptId,
      cueId: source.cueId,
      eventId: `${source.attemptId}:evidence:${evidenceSequence}`,
      causalSequence: evidenceSequence,
      monotonicTimestamp: 10_000 + evidenceSequence,
      goalId,
      actor
    };
  }

  function recordEvent(event) {
    events.push(structuredClone(event));
    const write = writer.appendEvent(event);
    eventWrites.push(write);
    return write;
  }

  function actorRuntime(actorId) {
    const bot = createFakeBot(actorId, world);
    const runtime = createActorRuntime({
      bot,
      actorId,
      movements: {},
      clock,
      verifier: { verifyMark(_kind, payload) { return payload.mark; } },
      approvalPublicKey: approvalKeys.publicKey,
      episodeContentHash: sourceEpisodeHash(take.episode),
      speechObserver: {
        async observe({ actorId: observedActor, command, text }) {
          return {
            authoritative: true, observed: true, speaker: observedActor,
            cueId: command.cueId, text
          };
        }
      },
      survivalAuthority: authority,
      survivalObserver: {
        async observe({ actorId: observedActor, command, goalId, observationVersion, phase }) {
          const version = phase === 'before' ? observationVersion : observationVersion + 1;
          const observation = survivalObservation(world, observedActor, goalId, version);
          await writer.appendSurvivalObservation({
            ...evidenceIdentity(command, goalId, observedActor),
            phase,
            ...observation
          });
          return observation;
        }
      }
    });

    return Object.freeze({
      name: runtime.name,
      async execute(command, sink) {
        recordEvent({ kind: 'commandIssued', command });
        const loggingSink = Object.freeze({
          createEvent: (kind, payload) => sink.createEvent(kind, payload),
          async emit(event) {
            const delivery = sink.emit(event);
            await recordEvent(event);
            return delivery;
          }
        });
        return runtime.execute(command, loggingSink);
      },
      cancel: runtime.cancel,
      awaitQuiescence: runtime.awaitQuiescence,
      close: runtime.close
    });
  }

  const actors = { hero: actorRuntime('hero'), rival: actorRuntime('rival') };
  let runner;
  const planner = ({ goal, observation, reservations }) => {
    if (goal.id === 'gather_rival_logs' &&
        world.rejectedSharedTargets === 0 &&
        reservations.some(({ reservationKey }) => reservationKey === 'explicit:tree:shared') &&
        observation.targets.some(({ id }) => id === 'a-shared-rival')) {
      world.rejectedSharedTargets += 1;
    }
    const decision = planSurvivalStep({ goal, observation, reservations });
    const record = {
      ...evidenceIdentity(coordinator.snapshot().identity, goal.id, goal.actor),
      observationVersion: observation.version,
      replanCount: observation.replanCount,
      reservations,
      decision
    };
    plannerRecords.push(structuredClone(record));
    plannerWrites.push(writer.appendPlannerDecision(record));
    return decision;
  };
  const coordinator = createSurvivalCoordinator({
    episode: survivalEpisode,
    planner,
    authority,
    actors,
    emit: async (event) => {
      const delivery = runner.dispatch(event);
      await recordEvent(event);
      background.push(delivery);
    },
    clock
  });
  const background = [];
  const schedule = (work) => background.push(Promise.resolve(work));
  const emit = async (command, sink, kind, payload = {}) => {
    const event = sink.createEvent(kind, { commandId: command.commandId, ...payload });
    const delivery = sink.emit(event);
    await recordEvent(event);
    await delivery;
  };
  const barrier = async (command, sink, proof) => {
    await emit(command, sink, 'commandAcknowledged');
    await emit(command, sink, 'commandCompleted');
    await emit(command, sink, 'observationVerified', { proof });
  };
  const production = {
    execute(command, sink) {
      schedule((async () => {
        await recordEvent({ kind: 'commandIssued', command });
        await barrier(command, sink, {
          kind: 'preparation', authoritative: true, prepared: true, actors: command.payload.actors
        });
      })());
    }
  };
  const timers = {
    execute(command, sink) {
      schedule((async () => {
        await recordEvent({ kind: 'commandIssued', command });
        if (command.kind === 'preRoll') {
          await emit(command, sink, 'commandAcknowledged');
          await emit(command, sink, 'commandCompleted');
          await emit(command, sink, 'timerFired');
          return;
        }
        if (command.kind === 'cueTimeout') {
          await emit(command, sink, 'commandAcknowledged');
          await emit(command, sink, 'commandCompleted');
          return;
        }
        await barrier(command, sink, {
          kind: 'quiescence', authoritative: true, quiescent: true,
          resourceKind: 'timer', resourceId: command.payload.timerId
        });
      })());
    }
  };
  const capture = {
    execute(command, sink) {
      schedule((async () => {
        await recordEvent({ kind: 'commandIssued', command });
        if (command.kind === 'armCapture') {
          await barrier(command, sink, {
            kind: 'captureArm', authoritative: true, armed: true, takeId: take.takeId
          });
          await emit(command, sink, 'captureReady', { takeId: take.takeId, path: 'meadow-take.mkv' });
          return;
        }
        if (command.kind === 'stopCapture') {
          await barrier(command, sink, {
            kind: 'capture', authoritative: true, ok: true, takeId: take.takeId,
            path: 'meadow-take.mkv',
            coverage: { complete: true, startMonotonicTimestamp: 1_000, endMonotonicTimestamp: now }
          });
          return;
        }
        await barrier(command, sink, {
          kind: 'quiescence', authoritative: true, quiescent: true,
          resourceKind: 'capture', resourceId: command.payload.captureCommandId
        });
      })());
    }
  };

  runner = createShowrunner({
    actors,
    production,
    timers,
    capture,
    survivalCoordinator: coordinator,
    clock,
    ids: {
      attempt: ({ number }) => `meadow-attempt-${number}`,
      command: ({ attemptId, number }) => `${attemptId}:showrunner:${number}`
    },
    approvalPublicKey: approvalKeys.publicKey
  });

  async function drainUntil(predicate, label, maximum = 500) {
    for (let iteration = 0; iteration < maximum; iteration += 1) {
      while (background.length > 0) await background.shift();
      await runner.dispatch({ kind: 'flush' });
      await new Promise((resolve) => setImmediate(resolve));
      if (predicate() && background.length === 0) return;
    }
    assert.fail(`${label} did not settle: ${JSON.stringify({
      showrunner: runner.snapshot(), coordinator: coordinator.snapshot()
    })}`);
  }

  await runner.startTake(take);
  const initial = runner.snapshot();
  await coordinator.start({
    productionId: initial.productionId,
    takeId: initial.takeId,
    sceneId: initial.sceneId,
    beatId: initial.beatId,
    attemptId: initial.attemptId,
    cueId: initial.cueId,
    causalSequence: initial.causalSequence
  });
  await drainUntil(
    () => runner.snapshot().state === 'completed' && coordinator.snapshot().status === 'completed',
    'full meadow take'
  );
  await Promise.all(plannerWrites);
  await Promise.all(eventWrites);

  const snapshot = runner.snapshot();
  await writer.writeTranscript(snapshot.transcript);
  await writer.writeValidation({
    approvedBankVerified: true,
    normalizedSurvivalEpisode: survivalEpisode.episode,
    goalsCompleted: coordinator.snapshot().completedGoalIds
  });
  await writer.finalize({
    status: 'completed',
    baselineReport: { verified: true, attemptId: initial.attemptId },
    capture: { ok: true, takeId: take.takeId, path: 'meadow-take.mkv' }
  });
  await writer.finalize({ status: 'accepted' });

  const plannerEvidence = parseNdjson(await artifactHost.readText(path.join(takeDirectory, 'planner-decisions.ndjson')));
  const observationEvidence = parseNdjson(await artifactHost.readText(path.join(takeDirectory, 'survival-observations.ndjson')));
  const decision = JSON.parse(await artifactHost.readText(path.join(takeDirectory, 'decision.json')));
  const combinedInventory = Object.values(world.actors).reduce((combined, actor) => {
    for (const [item, count] of Object.entries(actor.inventory)) combined[item] = (combined[item] ?? 0) + count;
    return combined;
  }, {});
  const result = {
    actors: structuredClone(world.actors),
    inventory: {
      ...combinedInventory,
      oak_logConsumed: world.gatheredOakLogs - inventoryCount(combinedInventory, 'oak_log')
    },
    crafting: { ...world.crafting },
    mutatedBlocks: world.excavatedBlocks,
    mutatedBlocksByActor: structuredClone(world.excavatedByActor),
    approvedExcavationCells,
    events,
    transcript: snapshot.transcript,
    plannerEvidence,
    observationEvidence,
    decision
  };

  assert.equal(result.inventory.oak_logConsumed, result.crafting.oakLogInput);
  assert.equal(result.inventory.wooden_pickaxe, 2);
  assert.equal(result.inventory.cobblestone >= 11, true);
  assert.deepEqual(result.crafting.pickaxesByActor, { hero: 1, rival: 1 });
  for (const actorId of ['hero', 'rival']) {
    assert.equal(result.actors[actorId].inventory.wooden_pickaxe, 1);
    assert.equal(result.actors[actorId].equipment.hand, 'wooden_pickaxe');
  }
  assert.equal(result.actors.hero.inventory.cobblestone >= heroLaneCells.length, true);
  assert.equal(result.actors.rival.inventory.cobblestone >= rivalLaneCells.length, true);
  assert.deepEqual(result.mutatedBlocksByActor.hero, heroLaneCells);
  assert.deepEqual(result.mutatedBlocksByActor.rival, rivalLaneCells);
  assert.deepEqual(sortedCells(result.mutatedBlocks), sortedCells(result.approvedExcavationCells));
  assert.equal(world.blocks.get('mine-00a-rogue'), 'stone');
  assert.equal(coordinator.snapshot().decisions.some(({ action }) =>
    action?.payload?.targetId === 'mine-00a-rogue'), false);
  assert.equal(result.events.some((event) => event.kind === 'serverCommandFallback'), false);

  assert.equal(world.rejectedSharedTargets, 1);
  assert.equal(world.transientPathFailures, 1);
  assert.equal(coordinator.snapshot().decisions.some(({ goalId, replanCount }) =>
    goalId === 'gather_rival_logs' && replanCount === 1), true);
  assert.deepEqual(result.transcript.map(({ cueId, lineId }) => ({ cueId, lineId })),
    dialogueLines.map(({ cueId, id: lineId }) => ({ cueId, lineId })));
  assert.deepEqual(result.transcript.map(({ text }) => text), dialogueLines.map(({ line }) => line));
  assert.equal(result.transcript.every(({ cueId, text }) => script.includes(`\`${cueId}\``) && script.includes(text)), true);
  assert.equal(result.events.filter(({ kind, command }) => kind === 'commandIssued' && command?.kind === 'speak')
    .every(({ command }) => command.beatId === command.cueId), true);

  const goalToBeat = new Map(survivalEpisode.beats.flatMap(({ id, goalIds }) =>
    goalIds.map((goalId) => [goalId, id])));
  const speechCommands = new Map(result.events
    .filter(({ kind, command }) => kind === 'commandIssued' && command?.kind === 'speak')
    .map(({ command }) => [command.cueId, command]));
  for (const { command } of result.events.filter(({ kind, command }) =>
    kind === 'commandIssued' && command?.payload?.goalId)) {
    const expectedBeatId = goalToBeat.get(command.payload.goalId);
    assert.equal(command.cueId, expectedBeatId);
    const speech = speechCommands.get(expectedBeatId);
    const speechVerifiedIndex = result.events.findIndex(({ kind, payload }) =>
      kind === 'observationVerified' && payload?.commandId === speech.commandId && payload?.proof?.authoritative === true);
    const actionIndex = result.events.findIndex((event) => event.kind === 'commandIssued' && event.command?.commandId === command.commandId);
    assert.notEqual(speechVerifiedIndex, -1, `missing authoritative speech proof for ${expectedBeatId}`);
    assert.notEqual(actionIndex, -1, `missing command issue event for ${command.payload.goalId}`);
    assert.equal(actionIndex > speechVerifiedIndex, true, `${command.payload.goalId} acted before ${expectedBeatId} dialogue completed`);
  }

  const firstPlannerGoalOrder = [...new Set(plannerEvidence.map(({ goalId }) => goalId))];
  assert.deepEqual(firstPlannerGoalOrder, survivalEpisode.goals.map(({ id }) => id));
  assert.equal(plannerEvidence.length, plannerRecords.length);
  assert.equal(observationEvidence.length > plannerEvidence.length, true);
  assert.equal(result.decision.schemaVersion, 2);
  assert.deepEqual(result.decision.evidenceFiles, [
    'events.ndjson', 'transcript.json', 'validation.json', 'baseline-report.json', 'capture.json',
    'planner-decisions.ndjson', 'survival-observations.ndjson'
  ]);
  assert.deepEqual(Object.keys(result.decision.evidence).sort(), [
    'baseline-report.json', 'capture.json', 'events.ndjson', 'planner-decisions.ndjson',
    'survival-observations.ndjson', 'transcript.json', 'validation.json'
  ]);
  assert.deepEqual(await writer.verify(), {
    ok: true,
    status: 'accepted',
    evidence: result.decision.evidence
  });
  assert.deepEqual(authority.snapshotReservations(), []);

  actors.hero.close();
  actors.rival.close();
});

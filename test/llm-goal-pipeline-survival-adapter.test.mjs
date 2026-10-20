import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { Vec3 } from 'vec3';

import { createSurvivalAdapter } from '../src/llm-goal-pipeline/survival-adapter.mjs';
import { createDefaultSurvivalPermissions } from '../src/llm-goal-pipeline/survival-permissions.mjs';

const key = (position) => `${position.x},${position.y},${position.z}`;

class GoalNear {
  constructor(x, y, z, range) { Object.assign(this, { x, y, z, range }); }
}

class Movements {
  constructor() { this.canDig = true; }
}

class FakeBot extends EventEmitter {
  constructor() {
    super();
    this.health = 20;
    this.food = 18;
    this.time = { timeOfDay: 1_000 };
    this.isRaining = false;
    this.game = { dimension: 'minecraft:overworld' };
    this.player = { username: 'PipelineBot' };
    this.entity = { position: new Vec3(0, 64, 0) };
    this._client = { state: 'play', socket: { destroyed: false } };
    this.registry = {
      blocksByName: {
        oak_log: { id: 1 }, stone: { id: 2 }, cobblestone: { id: 3 },
        crafting_table: { id: 4 }, dirt: { id: 5 }, air: { id: 0 }
      },
      itemsByName: {
        oak_log: { id: 11 }, oak_planks: { id: 12 }, stick: { id: 13 },
        crafting_table: { id: 14 }, wooden_pickaxe: { id: 15 }, stone_pickaxe: { id: 16 },
        apple: { id: 17 }
      }
    };
    this.blocks = new Map();
    this.stacks = [];
    this.entities = {};
    this.effects = [];
    this.inventory = { items: () => this.stacks };
    this.pathfinder = {
      setMovements: (value) => this.effects.push(['movements', value]),
      goto: async (goal) => { this.effects.push(['goto', goal]); this.entity.position = new Vec3(goal.x, goal.y, goal.z); },
      stop: () => this.effects.push(['stop'])
    };
  }

  setBlock(position, name) {
    this.blocks.set(key(position), { name, type: this.registry.blocksByName[name]?.id ?? 0, position: position.clone() });
  }

  blockAt(position) {
    return this.blocks.get(key(position)) ?? { name: 'air', type: 0, position: position.clone() };
  }

  findBlocks({ matching, maxDistance, count }) {
    const allowed = new Set(Array.isArray(matching) ? matching : [matching]);
    return [...this.blocks.values()]
      .filter((block) => allowed.has(block.type) && block.position.distanceTo(this.entity.position) <= maxDistance)
      .sort((a, b) => a.position.distanceTo(this.entity.position) - b.position.distanceTo(this.entity.position))
      .slice(0, count).map((block) => block.position.clone());
  }

  async dig(block) {
    this.effects.push(['dig', block.name]);
    this.setBlock(block.position, 'air');
    const drop = block.name === 'stone' ? 'cobblestone' : block.name;
    const stack = this.stacks.find((item) => item.name === drop);
    if (stack) stack.count += 1;
    else this.stacks.push({ name: drop, count: 1 });
  }

  recipesFor(itemId) {
    const output = Object.values(this.registry.itemsByName).find((item) => item.id === itemId);
    return output ? [{ result: { name: Object.keys(this.registry.itemsByName).find((name) => this.registry.itemsByName[name].id === itemId) } }] : [];
  }

  async craft(recipe, count) {
    const output = recipe.result.name;
    const amount = output === 'oak_planks' ? 4 * count : count;
    this.effects.push(['craft', output, count]);
    const log = this.stacks.find((item) => item.name === 'oak_log');
    if (output === 'oak_planks' && log) log.count -= count;
    const stack = this.stacks.find((item) => item.name === output);
    if (stack) stack.count += amount;
    else this.stacks.push({ name: output, count: amount });
    this.stacks = this.stacks.filter((item) => item.count > 0);
  }

  async equip(item) { this.heldItem = item; this.effects.push(['equip', item.name]); }

  async consume() {
    this.effects.push(['consume']);
    const stack = this.stacks.find((item) => item === this.heldItem);
    stack.count -= 1;
    this.food += 4;
    this.stacks = this.stacks.filter((item) => item.count > 0);
  }

  async placeBlock(reference, face) {
    this.effects.push(['place', this.heldItem?.name]);
    const placed = reference.position.offset(face.x, face.y, face.z);
    this.setBlock(placed, this.heldItem.name);
    const stack = this.stacks.find((item) => item === this.heldItem);
    stack.count -= 1;
    this.stacks = this.stacks.filter((item) => item.count > 0);
  }

  attack(entity) { this.effects.push(['attack', entity.name]); delete this.entities[entity.id]; }

  chat(text) { this.effects.push(['chat', text]); }

  stopDigging() { this.effects.push(['stopDigging']); }
}

function contract(overrides = {}) {
  return {
    authority: {
      capabilities: ['observe', 'navigate', 'mine_block', 'collect_item', 'craft_recipe', 'place_block', 'equip_item', 'consume_food', 'attack_hostile', 'retreat', 'speak'],
      items: ['oak_log', 'oak_planks', 'cobblestone', 'crafting_table', 'apple'], blocks: ['oak_log', 'stone'],
      entities: ['zombie'], recipes: ['oak_planks'], landmarks: ['safe:origin'], regions: [], blueprints: [], containers: []
    },
    budget: { maximumSearchRadius: 64, maximumTravelRadius: 128 },
    ...overrides
  };
}

function rig({ protectedRegions = [] } = {}) {
  const bot = new FakeBot();
  const permissions = createDefaultSurvivalPermissions({ origin: { x: 0, y: 64, z: 0 }, protectedRegions });
  return { bot, adapter: createSurvivalAdapter({ bot, goals: { GoalNear }, Movements, permissions }) };
}

test('publishes bounded coordinate-free observations with rotating opaque target IDs', async () => {
  const { bot, adapter } = rig({ protectedRegions: [{ id: 'protected', min: { x: 8, y: 0, z: -2 }, max: { x: 12, y: 100, z: 2 } }] });
  bot.stacks = [{ name: 'oak_log', count: 2 }];
  bot.setBlock(new Vec3(3, 64, 0), 'oak_log');
  bot.setBlock(new Vec3(10, 64, 0), 'stone');
  bot.setBlock(new Vec3(65, 64, 0), 'oak_log');

  const first = await adapter.observe({ contract: contract() });
  assert.equal(first.observationVersion, 1);
  assert.deepEqual(first.inventory, [{ item: 'oak_log', count: 2 }]);
  assert.deepEqual(first.actor.inventory, { oak_log: 2 });
  assert.equal(first.actor.region, 'origin');
  assert.equal(first.targets.length, 1);
  assert.deepEqual(first.targets[0], {
    id: 'observation-1-target-1', targetId: 'observation-1-target-1', kind: 'block',
    block: 'oak_log', state: 'solid', distance: 3
  });
  assert.equal(JSON.stringify(first).includes('position'), false);
  assert.equal(first.recipes.includes('oak_planks'), true);
  assert.deepEqual(first.blocks, [{ block: 'oak_log', distance: 3 }]);

  const second = await adapter.observe({ contract: contract() });
  assert.equal(second.targets[0].id, 'observation-2-target-1');
});

test('mines only a current permitted target and verifies removal plus inventory delta', async () => {
  const { bot, adapter } = rig();
  bot.setBlock(new Vec3(2, 64, 0), 'oak_log');
  const before = await adapter.observe({ contract: contract() });
  const request = { kind: 'mine_target', observationVersion: before.observationVersion, targetId: before.targets[0].id };
  const receipt = await adapter.execute(request, { contract: contract(), before });
  const after = await adapter.observe({ contract: contract() });

  assert.equal(receipt.ok, true);
  assert.deepEqual(await adapter.verifyAction(request, receipt, before, after, { contract: contract() }), {
    ok: true, code: 'MINE_VERIFIED', facts: [{ block: 'oak_log', removed: true }, { item: 'oak_log', delta: 1 }]
  });
  assert.equal(bot.effects.some(([effect]) => effect === 'dig'), true);

  const stale = await adapter.execute(request, { contract: contract(), before: after });
  assert.equal(stale.code, 'STALE_OBSERVATION');
});

test('crafts an authorized exact recipe and proves the output delta', async () => {
  const { bot, adapter } = rig();
  bot.stacks = [{ name: 'oak_log', count: 1 }];
  const before = await adapter.observe({ contract: contract() });
  const request = { kind: 'craft_recipe', observationVersion: before.observationVersion, recipe: 'oak_planks', count: 1 };
  const receipt = await adapter.execute(request, { contract: contract(), before });
  const after = await adapter.observe({ contract: contract() });

  assert.deepEqual(await adapter.verifyAction(request, receipt, before, after, { contract: contract() }), {
    ok: true, code: 'CRAFT_VERIFIED', facts: [{ item: 'oak_planks', delta: 4 }]
  });
});

test('navigation disables digging, respects origin bounds, and cancellation stops effects', async () => {
  const { bot, adapter } = rig();
  bot.setBlock(new Vec3(4, 64, 0), 'oak_log');
  const before = await adapter.observe({ contract: contract() });
  const request = { kind: 'navigate_to_target', observationVersion: before.observationVersion, targetId: before.targets[0].id };
  await adapter.execute(request, { contract: contract(), before });
  assert.equal(bot.effects.find(([effect]) => effect === 'movements')[1].canDig, false);
  await adapter.cancel('operator stop');
  assert.equal(bot.effects.some(([effect]) => effect === 'stop'), true);
  assert.equal(bot.effects.some(([effect]) => effect === 'stopDigging'), true);
});

test('places, equips, consumes, attacks only hostiles, retreats, and speaks with live proof', async () => {
  const { bot, adapter } = rig();
  bot.stacks = [{ name: 'crafting_table', count: 1 }, { name: 'apple', count: 1 }];
  bot.setBlock(new Vec3(2, 64, 0), 'stone');
  bot.entities = {
    10: { id: 10, name: 'zombie', type: 'mob', position: new Vec3(3, 64, 0) },
    11: { id: 11, name: 'player', type: 'player', position: new Vec3(4, 64, 0) }
  };
  let before = await adapter.observe({ contract: contract() });
  assert.equal(before.targets.some((entry) => entry.entity === 'zombie'), true);
  assert.equal(before.targets.some((entry) => entry.entity === 'player'), false);
  assert.deepEqual(before.landmarks, [{ reference: 'safe:origin', visible: true, reached: true }]);

  const support = before.targets.find((entry) => entry.block === 'stone');
  let request = { kind: 'place_against_target', observationVersion: before.observationVersion, item: 'crafting_table', targetId: support.id };
  let result = await adapter.execute(request, { contract: contract(), before });
  let after = await adapter.observe({ contract: contract() });
  assert.equal((await adapter.verifyAction(request, result, before, after)).code, 'PLACE_VERIFIED');

  before = after;
  request = { kind: 'equip_item', observationVersion: before.observationVersion, item: 'apple' };
  result = await adapter.execute(request, { contract: contract(), before });
  after = await adapter.observe({ contract: contract() });
  assert.equal((await adapter.verifyAction(request, result, before, after)).code, 'EQUIP_VERIFIED');

  before = after;
  request = { kind: 'consume_item', observationVersion: before.observationVersion, item: 'apple' };
  result = await adapter.execute(request, { contract: contract(), before });
  after = await adapter.observe({ contract: contract() });
  assert.equal((await adapter.verifyAction(request, result, before, after)).code, 'CONSUME_VERIFIED');

  before = after;
  const zombie = before.targets.find((entry) => entry.entity === 'zombie');
  request = { kind: 'attack_target', observationVersion: before.observationVersion, targetId: zombie.id };
  result = await adapter.execute(request, { contract: contract(), before });
  after = await adapter.observe({ contract: contract() });
  assert.equal((await adapter.verifyAction(request, result, before, after)).code, 'ATTACK_VERIFIED');

  bot.entity.position = new Vec3(20, 64, 0);
  before = await adapter.observe({ contract: contract() });
  request = { kind: 'navigate_to_landmark', observationVersion: before.observationVersion, reference: 'safe:origin' };
  result = await adapter.execute(request, { contract: contract(), before });
  after = await adapter.observe({ contract: contract() });
  assert.equal((await adapter.verifyAction(request, result, before, after)).code, 'RETREAT_VERIFIED');

  before = after;
  request = { kind: 'speak', observationVersion: before.observationVersion, text: 'This is gonna be great!!!' };
  result = await adapter.execute(request, { contract: contract(), before });
  after = await adapter.observe({ contract: contract() });
  assert.equal((await adapter.verifyAction(request, result, before, after)).code, 'SPEAK_VERIFIED');
});

test('collects only a current authorized item drop and verifies inventory increase', async () => {
  const { bot, adapter } = rig();
  bot.entities = { 20: { id: 20, name: 'item', type: 'object', itemName: 'oak_log', count: 1, position: new Vec3(2, 64, 0) } };
  bot.pathfinder.goto = async (goal) => {
    bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
    bot.stacks.push({ name: 'oak_log', count: 1 });
    delete bot.entities[20];
  };
  const before = await adapter.observe({ contract: contract() });
  const drop = before.targets.find((entry) => entry.kind === 'drop');
  const request = { kind: 'collect_drop', observationVersion: before.observationVersion, targetId: drop.id };
  const receipt = await adapter.execute(request, { contract: contract(), before });
  const after = await adapter.observe({ contract: contract() });
  assert.deepEqual(await adapter.verifyAction(request, receipt, before, after), {
    ok: true, code: 'COLLECT_VERIFIED', facts: [{ item: 'oak_log', delta: 1 }]
  });
});

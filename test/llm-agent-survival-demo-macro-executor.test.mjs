import assert from 'node:assert/strict';
import test from 'node:test';

import { createSurvivalDemoMacroExecutor } from '../src/llm-agent/survival-demo-macro-executor.mjs';

class GoalNear {
  constructor(x, y, z, range) { Object.assign(this, { x, y, z, range }); }
}

class GoalFollow {
  constructor(entity, range) { Object.assign(this, { entity, range }); }
}

class Movements {
  constructor() { this.canDig = true; }
}

function key(position) { return `${position.x},${position.y},${position.z}`; }
function point(x, y, z) { return { x, y, z }; }

function worldFixture({ oak = 3, stone = 8, buriedStone = false, leafyOak = false, displacedDrops = false, villageEvidence = { bell: true, beds: 1, villagers: 1 } } = {}) {
  const names = ['oak_log', 'oak_planks', 'stick', 'crafting_table', 'wooden_pickaxe', 'cobblestone', 'furnace'];
  const itemsByName = Object.fromEntries(names.map((name, index) => [name, { id: index + 1, name }]));
  const items = Object.fromEntries(Object.values(itemsByName).map((item) => [item.id, item]));
  const blocksByName = {
    air: { id: 0, name: 'air' }, oak_log: { id: 10, name: 'oak_log' },
    stone: { id: 11, name: 'stone' }, dirt: { id: 12, name: 'dirt' },
    crafting_table: { id: 13, name: 'crafting_table' }, bell: { id: 14, name: 'bell' },
    white_bed: { id: 15, name: 'white_bed' }, oak_leaves: { id: 16, name: 'oak_leaves' }
  };
  const world = new Map();
  const add = (name, position) => world.set(key(position), { name, type: blocksByName[name].id, position });
  for (let index = 0; index < oak; index += 1) {
    add('oak_log', leafyOak ? point(2, 65 + index, 0) : point(2 + index, 65, 0));
  }
  if (leafyOak) {
    for (let index = 1; index < oak; index += 1) {
      const y = 65 + index;
      for (const [dx, dy, dz] of [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
        const position = point(2 + dx, y + dy, dz);
        if (!world.has(key(position))) add('oak_leaves', position);
      }
    }
  }
  if (buriedStone) {
    add('stone', point(0, 61, 0));
    for (const [x, y, z] of [[0, 62, 0], [0, 60, 0], [1, 61, 0], [-1, 61, 0], [0, 61, 1], [0, 61, -1]]) {
      add('dirt', point(x, y, z));
    }
  }
  for (let index = 0; index < stone; index += 1) add('stone', point(2 + index, 64, 3));
  add('bell', point(20, 64, 20));
  for (let x = -2; x <= 3; x += 1) for (let z = -2; z <= 3; z += 1) add('dirt', point(x, 63, z));
  const counts = {};
  const dug = [];
  const goals = [];
  const chatCalls = [];
  const itemStack = (name) => ({ ...itemsByName[name], count: counts[name] });
  const bot = {
    health: 20,
    player: { username: 'LlmAgent' },
    entity: { position: point(0, 64, 0), onGround: true },
    entities: {},
    registry: { itemsByName, items, blocksByName },
    inventory: {
      items: () => Object.keys(counts).filter((name) => counts[name] > 0).map(itemStack)
    },
    heldItem: null,
    pathfinder: {
      movements: null,
      stopped: false,
      setMovements(value) { this.movements = value; },
      async goto(goal) {
        goals.push(goal);
        if (goal instanceof GoalFollow) {
          const drop = goal.entity.getDroppedItem();
          counts[drop.name] = (counts[drop.name] ?? 0) + 1;
          delete bot.entities[goal.entity.id];
          return;
        }
        bot.entity.position = point(goal.x, goal.y, goal.z);
      },
      stop() { this.stopped = true; }
    },
    findBlock({ matching, useExtraInfo }) {
      const ids = Array.isArray(matching) ? matching : [matching];
      return [...world.values()].find((block) => ids.includes(block.type)
        && (typeof useExtraInfo !== 'function' || useExtraInfo(block))) ?? null;
    },
    blockAt(position) {
      return world.get(key(position)) ?? { name: 'air', type: 0, position: { ...position } };
    },
    async dig(block) {
      dug.push(block.name);
      world.delete(key(block.position));
      const dropName = block.name === 'stone' ? 'cobblestone' : block.name;
      if (displacedDrops) {
        const id = dug.length;
        bot.entities[id] = {
          id, name: 'item', isValid: true,
          position: point(block.position.x + 1.4, block.position.y, block.position.z),
          getDroppedItem: () => ({ name: dropName })
        };
      } else {
        counts[dropName] = (counts[dropName] ?? 0) + 1;
      }
    },
    stopDigging() { this.stoppedDigging = true; },
    recipesFor(itemId) { return [{ result: { id: itemId, count: itemId === itemsByName.oak_planks.id ? 4 : 1 } }]; },
    async craft(recipe) {
      const output = items[recipe.result.id].name;
      if (output === 'oak_planks') { counts.oak_log -= 1; counts.oak_planks = (counts.oak_planks ?? 0) + 4; }
      if (output === 'crafting_table') { counts.oak_planks -= 4; counts.crafting_table = 1; }
      if (output === 'stick') { counts.oak_planks -= 2; counts.stick = (counts.stick ?? 0) + 4; }
      if (output === 'wooden_pickaxe') { counts.oak_planks -= 3; counts.stick -= 2; counts.wooden_pickaxe = 1; }
      if (output === 'furnace') { counts.cobblestone -= 8; counts.furnace = 1; }
    },
    async equip(item) { this.heldItem = { ...item }; },
    async placeBlock(reference, face) {
      const target = point(reference.position.x + face.x, reference.position.y + face.y, reference.position.z + face.z);
      add('crafting_table', target);
      counts.crafting_table -= 1;
    },
    chat(line) { chatCalls.push(line); }
  };
  const villageObserver = async () => ({ ...villageEvidence });
  return {
    bot, world, counts, dug, goals, chatCalls,
    dependencies: {
      bot, goals: { GoalNear, GoalFollow }, Movements, villageObserver,
      clearingStart: point(0, 64, 0), actionTimeoutMs: 1_000,
      waitImpl: async () => {}
    }
  };
}

test('gather_wood pathfinds, digs, and counts three normally collected oak logs', async () => {
  const setup = worldFixture();
  const executor = createSurvivalDemoMacroExecutor(setup.dependencies);
  assert.deepEqual(await executor.execute({ action: 'gather_wood' }), {
    action: 'gather_wood', brokenOakLogs: 3
  });
  assert.equal(setup.counts.oak_log, 3);
  assert.deepEqual(setup.dug, ['oak_log', 'oak_log', 'oak_log']);
  assert.equal(setup.bot.pathfinder.movements.canDig, false);
});

test('approaches elevated dig targets at the actor walking level', async () => {
  const setup = worldFixture();
  setup.bot.pathfinder.goto = async (goal) => {
    setup.goals.push(goal);
    if (goal.y > 64) throw new Error('Took too long to decide path to elevated goal');
    setup.bot.entity.position = point(goal.x, goal.y + 1, goal.z);
  };
  const executor = createSurvivalDemoMacroExecutor(setup.dependencies);

  assert.deepEqual(await executor.execute({ action: 'gather_wood' }), {
    action: 'gather_wood', brokenOakLogs: 3
  });
  assert.equal(setup.goals.every((goal) => goal.y === 64), true);
});

test('waits for grounded physics before beginning each dig', async () => {
  const setup = worldFixture();
  const originalDig = setup.bot.dig.bind(setup.bot);
  let groundedWaits = 0;
  setup.bot.entity.onGround = false;
  setup.dependencies.waitImpl = async () => {
    groundedWaits += 1;
    setup.bot.entity.onGround = true;
  };
  setup.bot.dig = async (block) => {
    assert.equal(setup.bot.entity.onGround, true);
    return originalDig(block);
  };
  const executor = createSurvivalDemoMacroExecutor(setup.dependencies);

  await executor.execute({ action: 'gather_wood' });

  assert.equal(groundedWaits >= 1, true);
});

test('follows each newly spawned matching drop until inventory confirms pickup', async () => {
  const setup = worldFixture({ displacedDrops: true });
  const executor = createSurvivalDemoMacroExecutor(setup.dependencies);

  assert.deepEqual(await executor.execute({ action: 'gather_wood' }), {
    action: 'gather_wood', brokenOakLogs: 3
  });
  assert.equal(setup.goals.filter((goal) => goal instanceof GoalFollow).length, 3);
  assert.equal(setup.counts.oak_log, 3);
});

test('can mine upper oak logs surrounded by canopy leaves', async () => {
  const setup = worldFixture({ leafyOak: true });
  const executor = createSurvivalDemoMacroExecutor(setup.dependencies);

  assert.deepEqual(await executor.execute({ action: 'gather_wood' }), {
    action: 'gather_wood', brokenOakLogs: 3
  });
});

test('crafts and places a table, then crafts and equips a wooden pickaxe', async () => {
  const setup = worldFixture();
  const executor = createSurvivalDemoMacroExecutor(setup.dependencies);
  await executor.execute({ action: 'gather_wood' });
  assert.deepEqual(await executor.execute({ action: 'craft_and_place_table' }), {
    action: 'craft_and_place_table', placedCraftingTable: true
  });
  assert.equal([...setup.world.values()].some((block) => block.name === 'crafting_table'), true);
  assert.deepEqual(await executor.execute({ action: 'craft_wooden_pickaxe' }), {
    action: 'craft_wooden_pickaxe', craftedWoodenPickaxe: true
  });
  assert.equal(setup.bot.heldItem.name, 'wooden_pickaxe');
});

test('mines eight stone with the equipped wooden pickaxe and crafts a furnace', async () => {
  const setup = worldFixture();
  const executor = createSurvivalDemoMacroExecutor(setup.dependencies);
  await executor.execute({ action: 'gather_wood' });
  await executor.execute({ action: 'craft_and_place_table' });
  await executor.execute({ action: 'craft_wooden_pickaxe' });
  assert.deepEqual(await executor.execute({ action: 'mine_stone' }), {
    action: 'mine_stone', minedStone: 8
  });
  assert.equal(setup.counts.cobblestone, 8);
  assert.deepEqual(await executor.execute({ action: 'craft_furnace' }), {
    action: 'craft_furnace', craftedFurnace: true
  });
  assert.equal(setup.counts.furnace, 1);
});

test('returns within interaction range of the placed table before crafting a furnace', async () => {
  const setup = worldFixture();
  const originalCraft = setup.bot.craft.bind(setup.bot);
  setup.bot.craft = async (recipe, count, table) => {
    const output = setup.bot.registry.items[recipe.result.id].name;
    if (output === 'furnace') {
      assert.equal(table?.name, 'crafting_table');
      const actor = setup.bot.entity.position;
      const distanceToTable = Math.hypot(
        actor.x - table.position.x,
        actor.y - table.position.y,
        actor.z - table.position.z
      );
      assert.equal(distanceToTable <= 2, true);
    }
    return originalCraft(recipe, count, table);
  };
  const executor = createSurvivalDemoMacroExecutor(setup.dependencies);
  await executor.execute({ action: 'gather_wood' });
  await executor.execute({ action: 'craft_and_place_table' });
  await executor.execute({ action: 'craft_wooden_pickaxe' });
  await executor.execute({ action: 'mine_stone' });

  await executor.execute({ action: 'craft_furnace' });
});

test('ignores buried stone and walks only to exposed stone targets', async () => {
  const setup = worldFixture({ buriedStone: true });
  const executor = createSurvivalDemoMacroExecutor(setup.dependencies);
  await executor.execute({ action: 'gather_wood' });
  await executor.execute({ action: 'craft_and_place_table' });
  await executor.execute({ action: 'craft_wooden_pickaxe' });
  await executor.execute({ action: 'mine_stone' });

  assert.equal(setup.goals.some((goal) => goal.x === 0 && goal.y === 61 && goal.z === 0), false);
});

test('finds only complete village evidence and says only the exact final line', async () => {
  const setup = worldFixture();
  const executor = createSurvivalDemoMacroExecutor(setup.dependencies);
  assert.deepEqual(await executor.execute({ action: 'find_village' }), {
    action: 'find_village', villageFound: true
  });
  assert.deepEqual(setup.goals.at(-1), new GoalNear(20, 64, 20, 2));
  assert.deepEqual(await executor.execute({ action: 'say_final_line', line: 'This is gonna be great!!!' }), {
    action: 'say_final_line', spoken: true
  });
  assert.deepEqual(setup.chatCalls, ['This is gonna be great!!!']);
  await assert.rejects(executor.execute({ action: 'say_final_line', line: 'close enough' }), {
    code: 'SURVIVAL_DEMO_EXECUTION_INVALID'
  });
});

test('fails closed when village proof stays incomplete throughout bounded exploration', async () => {
  const setup = worldFixture({ villageEvidence: { bell: true, beds: 1, villagers: 0 } });
  const executor = createSurvivalDemoMacroExecutor(setup.dependencies);
  await assert.rejects(executor.execute({ action: 'find_village' }), {
    code: 'SURVIVAL_DEMO_VILLAGE_NOT_FOUND'
  });
  assert.equal(setup.goals.length, 8);
});

test('abort stops pending movement and digging without returning success', async () => {
  const setup = worldFixture();
  const controller = new AbortController();
  setup.bot.pathfinder.goto = () => new Promise(() => {});
  const executor = createSurvivalDemoMacroExecutor(setup.dependencies);
  const pending = executor.execute({ action: 'gather_wood' }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'SURVIVAL_DEMO_ABORTED' });
  assert.equal(setup.bot.pathfinder.stopped, true);
  assert.equal(setup.bot.stoppedDigging, true);
});

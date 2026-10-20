import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LLM_SCENE_BOUNDS,
  LLM_SCENE_LANDING,
  createNaturalLlmSceneCommands
} from '../src/llm-agent/natural-scene.mjs';

test('builds a natural clearing at the existing meadow location', () => {
  const commands = createNaturalLlmSceneCommands();
  const joined = commands.join('\n');

  assert.deepEqual(LLM_SCENE_BOUNDS, {
    min: { x: 40, y: 62, z: 40 },
    max: { x: 92, y: 79, z: 58 }
  });
  assert.match(joined, /minecraft:grass_block/);
  assert.match(joined, /minecraft:coarse_dirt/);
  assert.match(joined, /minecraft:podzol/);
  assert.match(joined, /minecraft:moss_block/);
  assert.match(joined, /minecraft:stone/);
  assert.match(joined, /minecraft:mossy_cobblestone/);
  assert.equal(commands.includes('fill 40 62 40 92 63 58 minecraft:dirt'), true);

  const grassHeights = new Set(commands
    .filter((command) => command.includes('minecraft:grass_block'))
    .flatMap((command) => command.match(/-?\d+/g) ?? [])
    .map(Number)
    .filter((value) => value >= 64 && value <= 66));
  assert.equal(grassHeights.size >= 2, true, 'terrain should not have one perfectly flat surface');
});

test('stages a separate village destination connected by a walkable trail', () => {
  const commands = createNaturalLlmSceneCommands();
  const joined = commands.join('\n');

  assert.match(joined, /minecraft:bell/);
  assert.match(joined, /minecraft:red_bed/);
  assert.match(joined, /summon minecraft:villager/);
  assert.equal(commands.includes('fill 66 64 48 82 64 50 minecraft:dirt_path'), true);
});

test('keeps the oak objective and single gold marker reachable in the clearing', () => {
  const commands = createNaturalLlmSceneCommands();
  const gold = commands.filter((command) => command.endsWith('minecraft:gold_block'));
  const oakLogs = commands.filter((command) => command.endsWith('minecraft:oak_log'));

  assert.equal(gold.length, 1);
  assert.equal(oakLogs.length >= 8, true);
  assert.match(gold[0], /^setblock 54 65 52 minecraft:gold_block$/);
  assert.equal(commands.some((command) => command === 'setblock 54 66 52 minecraft:air'), true);
});

test('provides eight exposed stone blocks on dry land for the survival demo', () => {
  const commands = createNaturalLlmSceneCommands();
  const stone = commands.filter((command) => command.endsWith('minecraft:stone'));

  assert.equal(stone.length >= 8, true);
  for (const command of stone) {
    const [, x, y, z] = command.match(/^setblock (-?\d+) (-?\d+) (-?\d+) minecraft:stone$/) ?? [];
    assert.equal(Number(x) >= 54 && Number(x) <= 58, true);
    assert.equal(Number(y) >= 65 && Number(y) <= 66, true);
    assert.equal(Number(z) >= 51 && Number(z) <= 54, true);
  }
});

test('uses irregular plants and provides a solid clear player landing', () => {
  const commands = createNaturalLlmSceneCommands();
  const plantTypes = new Set(commands
    .filter((command) => /minecraft:(short_grass|tall_grass|poppy|dandelion|cornflower|oxeye_daisy|azure_bluet|allium)$/.test(command))
    .map((command) => command.split('minecraft:')[1]));

  assert.equal(plantTypes.size >= 6, true);
  assert.deepEqual(LLM_SCENE_LANDING, { x: 52.5, y: 66, z: 48.5 });
  assert.equal(commands.includes('setblock 52 65 48 minecraft:grass_block'), true);
  assert.equal(commands.includes('setblock 52 66 48 minecraft:air'), true);
  assert.equal(commands.includes('setblock 52 67 48 minecraft:air'), true);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { createLiveMeadowObserver } from '../src/showrunner/live-meadow-observer.mjs';

function block(name, x, y, z, boundingBox = name === 'air' ? 'empty' : 'block') {
  return { name, boundingBox, position: { x, y, z } };
}

test('observes bounded targets, inventory, equipment, drops, marks, and monotonic identity', async () => {
  const blocks = new Map([
    ['1,64,1', block('oak_log', 1, 64, 1)],
    ['5,65,5', block('crafting_table', 5, 65, 5)]
  ]);
  const bot = {
    username: 'HeroActor', game: { dimension: 'overworld' },
    entity: { position: { x: 2, y: 65, z: 2 }, yaw: 0, pitch: 0 },
    inventory: { items: () => [{ name: 'oak_log', count: 2 }] },
    heldItem: { name: 'wooden_pickaxe' },
    entities: { 9: { id: 9, name: 'item', position: { x: 3, y: 65, z: 3 }, getDroppedItem: () => ({ name: 'oak_log', count: 1 }) } },
    blockAt(position) { return blocks.get(`${position.x},${position.y},${position.z}`) ?? block('air', position.x, position.y, position.z); }
  };
  const episode = {
    actors: ['hero', 'rival'],
    regions: { hero_tree: { min: { x: 0, y: 64, z: 0 }, max: { x: 2, y: 64, z: 2 }, allowedBlocks: ['oak_log'] } },
    marks: { crafting_table: { position: { x: 5, y: 65, z: 5 }, radius: 2, safeHeadroom: true } }
  };
  const observer = createLiveMeadowObserver({ episode, bots: { hero: bot, rival: { ...bot, username: 'RivalActor' } } });
  const first = await observer.observe({ actorId: 'hero', goalId: 'gather', observationVersion: 0, action: 'observeSurvival', phase: 'after' });
  const second = await observer.observe({ actorId: 'hero', goalId: 'gather', observationVersion: first.observationVersion, action: 'observeSurvival', phase: 'after' });

  assert.equal(first.authoritative, true);
  assert.equal(first.dimension, 'minecraft:overworld');
  assert.equal(first.inventory.oak_log, 2);
  assert.equal(first.equipment.hand, 'wooden_pickaxe');
  assert.deepEqual(Object.keys(first.actors).sort(), ['hero', 'rival']);
  assert.equal(first.actors.rival.inventory.oak_log, 2);
  assert.deepEqual(first.targets.map(({ id, block: name }) => ({ id, name })), [{ id: 'block:1:64:1', name: 'oak_log' }]);
  assert.equal(first.drops[0].id, 'item:9');
  assert.equal(first.placedAtMarks.crafting_table, 'crafting_table');
  assert.equal(second.observationVersion > first.observationVersion, true);
});

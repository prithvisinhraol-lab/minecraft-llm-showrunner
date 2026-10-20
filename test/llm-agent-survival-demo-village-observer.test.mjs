import assert from 'node:assert/strict';
import test from 'node:test';

import { createSurvivalDemoVillageObserver } from '../src/llm-agent/survival-demo-village-observer.mjs';

function position(x, y = 64, z = 0) {
  return { x, y, z };
}

function villageBot({ bell = [], beds = [], entities = [] } = {}) {
  const blocks = {
    bell: { id: 10, name: 'bell' },
    white_bed: { id: 20, name: 'white_bed' },
    red_bed: { id: 21, name: 'red_bed' }
  };
  const byId = new Map([[10, bell], [20, beds.filter((_, index) => index % 2 === 0)], [21, beds.filter((_, index) => index % 2 === 1)]]);
  return {
    entity: { position: position(0) },
    registry: { blocksByName: blocks },
    entities: Object.fromEntries(entities.map((entity, index) => [index, entity])),
    findBlocks({ matching, maxDistance }) {
      assert.equal(maxDistance, 48);
      const ids = Array.isArray(matching) ? matching : [matching];
      return ids.flatMap((id) => byId.get(id) ?? []);
    }
  };
}

test('requires a local bell, bed, and live villager in the same bounded observation', async () => {
  const observe = createSurvivalDemoVillageObserver();
  const bot = villageBot({
    bell: [position(8)],
    beds: [position(9), position(10)],
    entities: [{ name: 'villager', position: position(11), isValid: true }]
  });

  assert.deepEqual(await observe({ bot }), { bell: true, beds: 2, villagers: 1 });
  bot.entities = {};
  assert.deepEqual(await observe({ bot }), { bell: true, beds: 2, villagers: 0 });
});

test('does not count villagers outside 48 blocks or invalid villager entities', async () => {
  const observe = createSurvivalDemoVillageObserver();
  const bot = villageBot({
    bell: [position(5)],
    beds: [position(6)],
    entities: [
      { name: 'villager', position: position(49), isValid: true },
      { name: 'villager', position: position(7), isValid: false },
      { name: 'zombie', position: position(7), isValid: true }
    ]
  });

  assert.deepEqual(await observe({ bot }), { bell: true, beds: 1, villagers: 0 });
});

test('deduplicates bed positions returned for multiple registry IDs', async () => {
  const observe = createSurvivalDemoVillageObserver();
  const shared = position(6);
  const bot = villageBot({ beds: [shared, shared] });
  assert.deepEqual(await observe({ bot }), { bell: false, beds: 1, villagers: 0 });
});

test('rejects aborted and structurally unavailable observations', async () => {
  const observe = createSurvivalDemoVillageObserver();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(observe({ bot: villageBot(), signal: controller.signal }), {
    code: 'SURVIVAL_DEMO_ABORTED'
  });
  await assert.rejects(observe({ bot: { registry: { blocksByName: {} } } }), {
    code: 'SURVIVAL_DEMO_OBSERVATION_INVALID'
  });
});

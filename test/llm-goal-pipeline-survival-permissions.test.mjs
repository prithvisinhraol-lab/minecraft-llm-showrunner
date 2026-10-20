import assert from 'node:assert/strict';
import test from 'node:test';

import { createDefaultSurvivalPermissions } from '../src/llm-goal-pipeline/survival-permissions.mjs';

test('creates frozen bounded survival authority around one integer origin', () => {
  const permissions = createDefaultSurvivalPermissions({
    origin: { x: 52, y: 66, z: 48 },
    protectedRegions: [{ id: 'city', min: { x: 100, y: 0, z: 100 }, max: { x: 200, y: 320, z: 200 } }]
  });
  assert.equal(permissions.maximumSearchRadius, 64);
  assert.equal(permissions.maximumTravelRadius, 128);
  assert.deepEqual(permissions.mineableBlocks, ['oak_log', 'stone', 'cobblestone']);
  assert.deepEqual(permissions.recipes, ['oak_planks', 'stick', 'crafting_table', 'wooden_pickaxe', 'stone_pickaxe']);
  assert.equal(permissions.attackableEntities.includes('player'), false);
  assert.equal(Object.isFrozen(permissions.protectedRegions[0]), true);
});

test('rejects noninteger origins and overlapping or malformed protected regions', () => {
  assert.throws(() => createDefaultSurvivalPermissions({ origin: { x: 0.5, y: 64, z: 0 } }), { code: 'PIPELINE_PERMISSION_INVALID' });
  assert.throws(() => createDefaultSurvivalPermissions({
    origin: { x: 0, y: 64, z: 0 },
    protectedRegions: [{ id: 'spawn', min: { x: -2, y: 0, z: -2 }, max: { x: 2, y: 100, z: 2 } }]
  }), { code: 'PIPELINE_PERMISSION_INVALID' });
});

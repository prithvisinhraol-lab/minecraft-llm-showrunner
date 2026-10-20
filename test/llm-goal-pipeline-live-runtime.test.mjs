import assert from 'node:assert/strict';
import test from 'node:test';

import { createGoalPipelineLiveRuntime } from '../src/llm-goal-pipeline/live-runtime.mjs';

test('composes one shared bot into bounded adapter, runner, store, and supervisor ports', async () => {
  const bot = { username: 'shared-bot' };
  const calls = [];
  const supervisor = { start() {}, stop() {}, status() {} };
  const runtime = createGoalPipelineLiveRuntime({
    actorId: 'LlmAgent', bot, goals: { GoalNear: class {} }, Movements: class {},
    slowProvider: { generate() {} }, fastProvider: { decide() {} },
    stateDirectory: 'runtime/llm-goal-pipeline-state', origin: { x: 10, y: 64, z: 10 },
    storeFactory(options) { calls.push(['store', options]); return { kind: 'store', reset: async () => {} }; },
    evidenceStoreFactory(options) { calls.push(['evidence', options]); return { record: async () => {}, reset: async () => {} }; },
    permissionsFactory(options) { calls.push(['permissions', options]); return {
      origin: options.origin, maximumTravelRadius: 128, maximumSearchRadius: 64,
      mineableBlocks: ['oak_log'], placeableBlocks: ['crafting_table'], recipes: ['oak_planks'],
      consumableItems: ['apple'], attackableEntities: ['zombie'], protectedRegions: []
    }; },
    adapterFactory(options) { calls.push(['adapter', options]); return { kind: 'adapter' }; },
    runnerFactory(options) { calls.push(['runner', options]); return { kind: 'runner' }; },
    supervisorFactory(options) { calls.push(['supervisor', options]); return supervisor; }
  });

  assert.strictEqual(runtime.controller, supervisor);
  assert.strictEqual(calls.find(([kind]) => kind === 'adapter')[1].bot, bot);
  assert.equal(calls.find(([kind]) => kind === 'store')[1].directory, 'runtime/llm-goal-pipeline-state');
  const supervisorOptions = calls.find(([kind]) => kind === 'supervisor')[1];
  assert.equal(supervisorOptions.permissions.capabilities.includes('mine_block'), true);
  assert.equal(typeof supervisorOptions.onVerifiedOutcome, 'function');
  assert.equal(supervisorOptions.missionComplete({
    mission: { text: 'survive toward stone tools' },
    outcome: { proofKinds: ['inventory_at_least:stone_pickaxe'] },
    pipelineState: { counters: { goalsCompleted: 2 } }
  }), true);
  assert.deepEqual(calls.find(([kind]) => kind === 'evidence')[1], {
    directory: 'runtime/llm-goal-pipeline-state', actorId: 'LlmAgent'
  });
  await runtime.close();
});

test('close urgently stops the supervisor and cancels the shared adapter without quitting the bot', async () => {
  const order = [];
  const controller = { async stop(reason) { order.push(`supervisor:${reason}`); }, async awaitIdle() { order.push('idle'); } };
  const runtime = createGoalPipelineLiveRuntime({
    actorId: 'LlmAgent', bot: {}, goals: { GoalNear: class {} }, Movements: class {},
    slowProvider: { generate() {} }, fastProvider: { decide() {} }, origin: { x: 0, y: 64, z: 0 },
    storeFactory: () => ({ reset: async () => {} }), evidenceStoreFactory: () => ({ record: async () => {}, reset: async () => {} }), permissionsFactory: () => ({
      origin: { x: 0, y: 64, z: 0 }, maximumTravelRadius: 128, maximumSearchRadius: 64,
      mineableBlocks: [], placeableBlocks: [], recipes: [], consumableItems: [], attackableEntities: [], protectedRegions: []
    }),
    adapterFactory: () => ({ async cancel(reason) { order.push(`adapter:${reason}`); } }),
    runnerFactory: () => ({}), supervisorFactory: () => controller
  });
  await Promise.all([runtime.close(), runtime.close()]);
  assert.deepEqual(order, ['supervisor:runtime closing', 'idle', 'adapter:runtime closing']);
});

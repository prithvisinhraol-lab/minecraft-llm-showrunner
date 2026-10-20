import assert from 'node:assert/strict';
import test from 'node:test';

import { createGoalPipelineSupervisor } from '../src/llm-goal-pipeline/supervisor.mjs';

test('rejects concurrent starts before either can gain execution authority', async () => {
  let leases = 0;
  const supervisor = createGoalPipelineSupervisor({
    actorId: 'PipelineBot', ownerId: 'test-owner',
    store: {
      load: async () => null, save: async () => {}, reset: async () => {},
      acquireLease: async () => { leases += 1; }, releaseLease: async () => {}
    },
    adapter: { observe: async () => new Promise(() => {}), cancel: async () => {} },
    slowProvider: { generate: async () => {} }, compile: () => {},
    fastRunner: { run: async () => {}, stop: async () => {} },
    permissions: {}, remainingLimits: () => ({}), clock: { now: () => Date.now() }
  });
  const first = supervisor.start({ mission: 'survive' });
  await assert.rejects(supervisor.start({ mission: 'duplicate' }), { code: 'PIPELINE_ALREADY_RUNNING' });
  assert.equal(leases, 1);
  await supervisor.stop('test cleanup');
  await first;
});

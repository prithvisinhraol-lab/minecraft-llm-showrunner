import assert from 'node:assert/strict';
import test from 'node:test';

import { createFastRunner } from '../src/llm-goal-pipeline/fast-runner.mjs';

function contract(overrides = {}) {
  return {
    contractId: 'contract-1',
    success: { all: [{ predicate: 'inventory_at_least', item: 'oak_log', count: 1 }] },
    budget: { maximumActions: 3, maximumReplans: 1, maximumSeconds: 30 },
    authority: { capabilities: ['observe', 'mine_block'], items: ['oak_log'], blocks: ['oak_log'], entities: [], recipes: [], landmarks: [], regions: [], blueprints: [], containers: [] },
    ...overrides
  };
}

test('observes, decides one action, verifies it, then succeeds only from live predicate proof', async () => {
  const observations = [
    { observationVersion: 1, connected: true, alive: true, inventory: [], targets: [{ id: 'oak-1', kind: 'block', block: 'oak_log' }] },
    { observationVersion: 2, connected: true, alive: true, inventory: [{ item: 'oak_log', count: 1 }], targets: [] }
  ];
  const executions = [];
  const phases = [];
  const fastCalls = [];
  const runner = createFastRunner({
    actorId: 'LlmAgent',
    provider: { decide: async () => ({ decision: 'act', action: { kind: 'mine_target', observationVersion: 1, targetId: 'oak-1' }, summary: '', plan: [] }) },
    adapter: {
      isConnected: async () => true,
      observe: async () => observations.shift(),
      execute: async (action) => { executions.push(action); return { receiptId: 'receipt-1' }; },
      verifyAction: async () => ({ ok: true, code: 'MINE_VERIFIED', facts: [{ block: 'oak_log' }] }),
      cancel: async () => {}
    },
    evaluateSuccess: (_expression, observation) => ({
      ok: observation.inventory.some((entry) => entry.item === 'oak_log' && entry.count >= 1),
      facts: observation.inventory, proofKinds: observation.inventory.length ? ['inventory_at_least:oak_log'] : []
    })
  });

  const result = await runner.run(contract(), {
    onTransition: (event) => phases.push(event.phase),
    onFastCall: (event) => fastCalls.push(event)
  });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.proofKinds, ['inventory_at_least:oak_log']);
  assert.equal(executions.length, 1);
  assert.deepEqual(fastCalls, [{ turn: 0 }]);
  assert.deepEqual(phases, ['observing', 'deciding', 'acting', 'verifying_action', 'verifying_goal']);
});

test('fails closed on unverified action and never trusts provider finish without live success', async () => {
  const observation = { observationVersion: 1, connected: true, alive: true, inventory: [], targets: [{ id: 'oak-1', kind: 'block', block: 'oak_log' }] };
  const base = {
    actorId: 'LlmAgent',
    adapter: {
      isConnected: async () => true, observe: async () => structuredClone(observation),
      execute: async () => ({ receiptId: 'receipt' }), cancel: async () => {},
      verifyAction: async () => ({ ok: false, code: 'MINE_NOT_VERIFIED', facts: [] })
    },
    evaluateSuccess: () => ({ ok: false, facts: [], proofKinds: [] })
  };
  const unverified = createFastRunner({ ...base, provider: { decide: async () => ({ decision: 'act', action: { kind: 'mine_target', observationVersion: 1, targetId: 'oak-1' }, summary: '', plan: [] }) } });
  await assert.rejects(unverified.run(contract()), { code: 'PIPELINE_ACTION_NOT_VERIFIED' });
  const premature = createFastRunner({ ...base, provider: { decide: async () => ({ decision: 'finish', action: null, summary: 'done', plan: [] }) } });
  const result = await premature.run(contract());
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'PIPELINE_GOAL_NOT_VERIFIED');
});

test('operator stop aborts a pending provider and cancels the adapter', async () => {
  let cancelCalls = 0;
  const runner = createFastRunner({
    actorId: 'LlmAgent',
    provider: { decide: (_context, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ABORTED' })), { once: true })) },
    adapter: {
      isConnected: async () => true,
      observe: async () => ({ observationVersion: 1, connected: true, alive: true, inventory: [], targets: [] }),
      execute: async () => {}, verifyAction: async () => {}, cancel: async () => { cancelCalls += 1; }
    },
    evaluateSuccess: () => ({ ok: false, facts: [], proofKinds: [] })
  });
  const pending = runner.run(contract());
  await new Promise((resolve) => setImmediate(resolve));
  await runner.stop('operator stop');
  const result = await pending;
  assert.equal(result.status, 'stopped');
  assert.equal(cancelCalls, 1);
});

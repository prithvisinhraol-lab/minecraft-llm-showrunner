import assert from 'node:assert/strict';
import test from 'node:test';

import { validateFastDecision } from '../src/llm-goal-pipeline/fast-contracts.mjs';

const context = {
  authority: {
    capabilities: ['observe', 'navigate', 'mine_block', 'collect_item', 'craft_recipe', 'equip_item'],
    items: ['oak_log', 'wooden_pickaxe'], blocks: ['oak_log'], entities: [],
    recipes: ['wooden_pickaxe'], landmarks: ['safe:clearing'], regions: [], blueprints: [], containers: []
  },
  observation: {
    observationVersion: 7,
    targets: [{ id: 'target-1', kind: 'block', block: 'oak_log' }, { id: 'drop-1', kind: 'drop', item: 'oak_log' }]
  }
};

test('accepts only an action authorized by capability and current opaque targets', () => {
  const decision = validateFastDecision({
    decision: 'act', action: { kind: 'mine_target', observationVersion: 7, targetId: 'target-1' },
    summary: 'A reachable oak log is visible.', plan: ['Mine it', 'Collect its drop']
  }, context);
  assert.equal(decision.action.kind, 'mine_target');
  assert.equal(Object.isFrozen(decision), true);
  assert.throws(() => validateFastDecision({
    ...decision, action: { kind: 'mine_target', observationVersion: 7, targetId: 'stale-target' }
  }, context), { code: 'PIPELINE_FAST_DECISION_INVALID' });
});

test('rejects coordinates, unknown fields, stale observations, and unauthorized action kinds', () => {
  const base = { decision: 'act', action: { kind: 'mine_target', observationVersion: 7, targetId: 'target-1' }, summary: '', plan: [] };
  for (const value of [
    { ...base, x: 2 },
    { ...base, action: { ...base.action, x: 2 } },
    { ...base, action: { ...base.action, observationVersion: 6 } },
    { ...base, action: { kind: 'attack_target', observationVersion: 7, targetId: 'target-1' } },
    { ...base, action: { kind: 'shell', observationVersion: 7 } }
  ]) assert.throws(() => validateFastDecision(value, context), { code: 'PIPELINE_FAST_DECISION_INVALID' });
});

test('validates allowlisted recipe, item, landmark, and terminal decisions', () => {
  assert.equal(validateFastDecision({
    decision: 'act', action: { kind: 'craft_recipe', observationVersion: 7, recipe: 'wooden_pickaxe', count: 1 }, summary: '', plan: []
  }, context).action.recipe, 'wooden_pickaxe');
  assert.equal(validateFastDecision({
    decision: 'act', action: { kind: 'navigate_to_landmark', observationVersion: 7, reference: 'safe:clearing' }, summary: '', plan: []
  }, context).action.reference, 'safe:clearing');
  assert.deepEqual(validateFastDecision({ decision: 'finish', action: null, summary: 'Done.', plan: [] }, context), {
    decision: 'finish', action: null, summary: 'Done.', plan: []
  });
});

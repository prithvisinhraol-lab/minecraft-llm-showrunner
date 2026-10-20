import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CAPABILITY_IDS, CONSTRAINT_IDS, PREDICATE_IDS,
  resolveCapability, resolveConstraint, resolvePredicate
} from '../src/llm-goal-pipeline/registry.mjs';

test('resolves frozen detached code-owned vocabulary entries', () => {
  const capability = resolveCapability('mine_block');
  assert.deepEqual(capability, { id: 'mine_block', actionKinds: ['mine_target'] });
  assert.equal(Object.isFrozen(capability), true);
  assert.equal(CAPABILITY_IDS.includes('craft_recipe'), true);
  assert.equal(PREDICATE_IDS.includes('inventory_at_least'), true);
  assert.equal(CONSTRAINT_IDS.includes('do_not_attack_players'), true);
});

test('fails closed for unknown or inherited vocabulary IDs', () => {
  for (const lookup of [resolveCapability, resolvePredicate, resolveConstraint]) {
    assert.throws(() => lookup('toString'), { code: 'PIPELINE_REGISTRY_UNKNOWN' });
    assert.throws(() => lookup('invented'), { code: 'PIPELINE_REGISTRY_UNKNOWN' });
  }
});

test('registry calls return independent values without exposing mutable catalog state', () => {
  const first = resolvePredicate('inventory_at_least');
  const second = resolvePredicate('inventory_at_least');
  assert.notEqual(first, second);
  assert.deepEqual(first, second);
  assert.throws(() => { first.parameters.item = 'changed'; }, TypeError);
});

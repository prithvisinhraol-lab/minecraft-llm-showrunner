import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COLLECT_OAK_LOG_GOAL,
  GOAL_IDS,
  PLACE_OAK_LOG_GOAL,
  resolveAgentGoal,
  validateAgentGoal
} from '../src/llm-agent/goals.mjs';

test('resolves the two bounded executable goals by stable ID', () => {
  assert.deepEqual(GOAL_IDS, [
    'place_oak_log_above_gold_marker',
    'collect_oak_log_above_gold_marker'
  ]);
  assert.deepEqual(resolveAgentGoal('place_oak_log_above_gold_marker'), PLACE_OAK_LOG_GOAL);
  assert.deepEqual(resolveAgentGoal('collect_oak_log_above_gold_marker'), {
    id: 'collect_oak_log_above_gold_marker',
    objective: 'mine the oak_log directly above the controller-identified gold_block marker and retain it in inventory',
    successCondition: { kind: 'oak_log_collected_from_above_gold_marker' },
    maxTurns: 12
  });
  assert.deepEqual(resolveAgentGoal('collect_oak_log_above_gold_marker'), COLLECT_OAK_LOG_GOAL);
});

test('returns frozen detached goals and preserves the catalog', () => {
  const resolved = resolveAgentGoal('collect_oak_log_above_gold_marker');
  assert.equal(Object.isFrozen(resolved), true);
  assert.equal(Object.isFrozen(resolved.successCondition), true);
  assert.throws(() => { resolved.objective = 'build a castle'; }, TypeError);
  assert.equal(resolveAgentGoal(resolved.id).objective, COLLECT_OAK_LOG_GOAL.objective);
});

test('rejects unknown IDs and goal objects outside the catalog', () => {
  assert.throws(() => resolveAgentGoal('invent_house'), { code: 'LLM_AGENT_GOAL_UNSUPPORTED' });
  assert.throws(() => validateAgentGoal({
    id: COLLECT_OAK_LOG_GOAL.id,
    objective: 'build a castle',
    successCondition: COLLECT_OAK_LOG_GOAL.successCondition,
    maxTurns: 12
  }), { code: 'LLM_AGENT_GOAL_UNSUPPORTED' });
});

test('canonically upgrades the legacy placement goal shape', () => {
  assert.deepEqual(validateAgentGoal({
    objective: PLACE_OAK_LOG_GOAL.objective,
    successCondition: PLACE_OAK_LOG_GOAL.successCondition
  }), PLACE_OAK_LOG_GOAL);
  assert.deepEqual(validateAgentGoal(PLACE_OAK_LOG_GOAL.objective), PLACE_OAK_LOG_GOAL);
});

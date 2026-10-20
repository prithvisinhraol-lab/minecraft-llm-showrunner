import assert from 'node:assert/strict';
import test from 'node:test';

import { createInitialActorState } from '../src/llm-agent/contracts.mjs';
import { PLACE_OAK_LOG_GOAL } from '../src/llm-agent/goals.mjs';
import { eligibleGoals } from '../src/llm-director/catalog.mjs';

const now = '2026-08-28T20:00:00.000Z';

function successfulPlacement() {
  const state = structuredClone(createInitialActorState({
    actorId: 'LlmAgent', runId: 'agent-run-1', now, goal: PLACE_OAK_LOG_GOAL
  }));
  state.lifecycle.status = 'succeeded';
  state.lifecycle.startedAt = now;
  state.lifecycle.finishedAt = now;
  state.trusted.phase = 'goal_verified';
  state.trusted.evidence = {
    source: 'mineflayer-live', simulated: false, provider: 'codex', actorId: 'LlmAgent',
    runId: 'agent-run-1', observedAt: now,
    goalProof: {
      markerTargetId: 'target-1-1', marker: { dimension: 'minecraft:overworld', x: 4, y: 64, z: 0 },
      markerBlock: 'gold_block', aboveBlock: 'oak_log'
    }
  };
  return state;
}

test('offers only the collection goal after trusted live placement success', () => {
  assert.deepEqual(eligibleGoals({ latestAgentState: successfulPlacement() }), [{
    goalId: 'collect_oak_log_above_gold_marker',
    objective: 'mine the oak_log directly above the controller-identified gold_block marker and retain it in inventory',
    successKind: 'oak_log_collected_from_above_gold_marker'
  }]);
});

test('offers no goals from failed, simulated, missing, or mismatched evidence', () => {
  const cases = [];
  const failed = successfulPlacement();
  failed.lifecycle.status = 'failed';
  cases.push(failed);
  const simulated = successfulPlacement();
  simulated.trusted.evidence = { ...simulated.trusted.evidence, source: 'simulated', simulated: true };
  cases.push(simulated);
  const missing = successfulPlacement();
  missing.trusted.evidence.goalProof = null;
  cases.push(missing);
  const mismatch = successfulPlacement();
  mismatch.trusted.evidence.actorId = 'OtherAgent';
  cases.push(mismatch);
  const wrongGoal = successfulPlacement();
  wrongGoal.goal = { ...PLACE_OAK_LOG_GOAL, id: 'collect_oak_log_above_gold_marker' };
  cases.push(wrongGoal);

  for (const latestAgentState of cases) {
    assert.deepEqual(eligibleGoals({ latestAgentState }), []);
  }
});

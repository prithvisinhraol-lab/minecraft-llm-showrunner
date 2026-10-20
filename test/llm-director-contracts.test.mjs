import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createInitialDirectorState,
  toDirectorContext,
  validateDirectorDecision,
  validateDirectorState
} from '../src/llm-director/contracts.mjs';

const now = '2026-08-28T20:00:00.000Z';

function initial() {
  return createInitialDirectorState({
    actorId: 'LlmAgent', runId: 'director-run-1', now,
    overallObjective: 'develop useful survival skills through small verified goals'
  });
}

test('creates exact frozen bounded director state', () => {
  const state = initial();
  assert.deepEqual(Object.keys(state), [
    'identity', 'overallObjective', 'lifecycle', 'currentGoalId', 'outcomes', 'decision', 'limits', 'failure'
  ]);
  assert.deepEqual(state.limits, { maxSelections: 1, selectionsUsed: 0 });
  assert.equal(state.lifecycle.status, 'idle');
  assert.equal(Object.isFrozen(state), true);
});

test('truncates verified outcome history to five and rejects unknown state fields', () => {
  const state = structuredClone(initial());
  state.outcomes = Array.from({ length: 7 }, (_, index) => ({
    goalId: 'collect_oak_log_above_gold_marker', status: 'succeeded', agentRunId: `agent-${index}`,
    completedAt: now, summary: `outcome-${index}`, proof: { kind: 'oak_log_collected_from_above_gold_marker' }
  }));
  assert.deepEqual(validateDirectorState(state).outcomes.map(({ summary }) => summary), [
    'outcome-2', 'outcome-3', 'outcome-4', 'outcome-5', 'outcome-6'
  ]);
  state.extra = true;
  assert.throws(() => validateDirectorState(state), { code: 'LLM_DIRECTOR_STATE_INVALID' });
});

test('validates exact select and stop decisions against eligible IDs', () => {
  const eligible = ['collect_oak_log_above_gold_marker'];
  assert.deepEqual(validateDirectorDecision({
    decision: 'select_goal', goalId: eligible[0], reason: 'Continue from the verified placement.',
    stateSummary: 'A log is above the marker.'
  }, eligible), {
    decision: 'select_goal', goalId: eligible[0], reason: 'Continue from the verified placement.',
    stateSummary: 'A log is above the marker.'
  });
  assert.deepEqual(validateDirectorDecision({
    decision: 'stop', goalId: null, reason: 'No useful goal remains.', stateSummary: 'Waiting.'
  }, eligible).goalId, null);
  assert.throws(() => validateDirectorDecision({
    decision: 'select_goal', goalId: 'build_castle', reason: 'try', stateSummary: ''
  }, eligible), { code: 'LLM_DIRECTOR_DECISION_INVALID' });
  assert.throws(() => validateDirectorDecision({
    decision: 'select_goal', goalId: eligible[0], reason: 'x'.repeat(301), stateSummary: ''
  }, eligible), { code: 'LLM_DIRECTOR_DECISION_INVALID' });
  assert.throws(() => validateDirectorDecision({
    decision: 'stop', goalId: null, reason: 'stop', stateSummary: 'x'.repeat(501), extra: true
  }, eligible), { code: 'LLM_DIRECTOR_DECISION_INVALID' });
});

test('builds coordinate-bounded director context with at most five entries', () => {
  const state = structuredClone(initial());
  state.outcomes = Array.from({ length: 5 }, (_, index) => ({
    goalId: 'collect_oak_log_above_gold_marker', status: 'succeeded', agentRunId: `agent-${index}`,
    completedAt: now, summary: `outcome-${index}`, proof: { kind: 'oak_log_collected_from_above_gold_marker' }
  }));
  const proof = {
    markerTargetId: 'target-1-1', marker: { dimension: 'minecraft:overworld', x: 4, y: 64, z: 0 },
    markerBlock: 'gold_block', aboveBlock: 'oak_log'
  };
  const context = toDirectorContext(validateDirectorState(state), Array.from({ length: 7 }, (_, index) => ({
    goalId: `goal-${index}`, objective: `objective-${index}`, successKind: `kind-${index}`
  })), { trusted: { evidence: { goalProof: { ...proof, privateNote: 'do not expose' } } } });

  assert.deepEqual(Object.keys(context), [
    'schemaVersion', 'actorId', 'overallObjective', 'eligibleGoals', 'recentOutcomes',
    'latestGoalProof', 'remainingInvocations'
  ]);
  assert.equal(context.eligibleGoals.length, 5);
  assert.equal(context.recentOutcomes.length, 5);
  assert.deepEqual(context.latestGoalProof, proof);
  assert.equal(context.remainingInvocations, 1);
});

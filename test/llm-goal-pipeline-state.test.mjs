import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PIPELINE_LIMITS,
  createInitialPipelineState,
  validatePipelineState
} from '../src/llm-goal-pipeline/state.mjs';

const now = '2026-09-01T12:00:00.000Z';

test('creates exact frozen bounded pipeline state', () => {
  const state = createInitialPipelineState({ actorId: 'LlmAgent', mission: 'survive and progress', now });
  assert.equal(state.identity.schemaVersion, 1);
  assert.deepEqual(state.mission, { text: 'survive and progress', version: 1 });
  assert.equal(state.lifecycle.status, 'idle');
  assert.equal(state.activeContract, null);
  assert.equal(state.speculativeContract, null);
  assert.equal(state.pendingQuestion, null);
  assert.deepEqual(state.outcomes, []);
  assert.deepEqual(state.failureFences, []);
  assert.deepEqual(state.audit, []);
  assert.equal(state.limits.maximumRuntimeMs, 5_400_000);
  assert.equal(state.limits.maximumGoals, 10);
  assert.equal(state.limits.maximumSlowCalls, 20);
  assert.equal(state.limits.maximumFastCalls, 400);
  assert.equal(Object.isFrozen(state), true);
});

test('keeps only five outcomes, ten failure fences, and forty audit events', () => {
  const initial = structuredClone(createInitialPipelineState({ actorId: 'LlmAgent', mission: 'survive', now }));
  initial.outcomes = Array.from({ length: 7 }, (_, index) => ({
    contractId: `contract-${index}`, status: 'succeeded', proofKinds: ['actor_alive'],
    summary: `outcome ${index}`, completedAt: now
  }));
  initial.failureFences = Array.from({ length: 12 }, (_, index) => ({
    kind: 'action', key: `target-${index}`, code: 'TARGET_FAILED', count: 1, observedAt: now
  }));
  initial.audit = Array.from({ length: 42 }, (_, index) => ({
    kind: 'generation_started', contractId: `contract-${index}`,
    predecessorContractId: index === 0 ? null : `contract-${index - 1}`,
    observationVersion: index + 1, relatedObservationVersion: null, observedAt: now
  }));
  const validated = validatePipelineState(initial);
  assert.deepEqual(validated.outcomes.map((entry) => entry.contractId), [
    'contract-2', 'contract-3', 'contract-4', 'contract-5', 'contract-6'
  ]);
  assert.deepEqual(validated.failureFences.map((entry) => entry.key), [
    'target-2', 'target-3', 'target-4', 'target-5', 'target-6',
    'target-7', 'target-8', 'target-9', 'target-10', 'target-11'
  ]);
  assert.deepEqual(validated.audit.map((entry) => entry.contractId),
    Array.from({ length: 40 }, (_, index) => `contract-${index + 2}`));
});

test('rejects malformed audit events and promotion without a fresh observation', () => {
  const initial = structuredClone(createInitialPipelineState({ actorId: 'LlmAgent', mission: 'survive', now }));
  initial.audit = [{
    kind: 'unknown', contractId: 'contract-1', predecessorContractId: null,
    observationVersion: 1, relatedObservationVersion: null, observedAt: now
  }];
  assert.throws(() => validatePipelineState(initial), { code: 'PIPELINE_STATE_INVALID' });

  initial.audit = [{
    kind: 'promotion_validated', contractId: 'contract-2', predecessorContractId: 'contract-1',
    observationVersion: 2, relatedObservationVersion: 2, observedAt: now
  }];
  assert.throws(() => validatePipelineState(initial), { code: 'PIPELINE_STATE_INVALID' });
});

test('rejects counter ceilings, unknown fields, and budget replacement', () => {
  const initial = structuredClone(createInitialPipelineState({ actorId: 'LlmAgent', mission: 'survive', now }));
  assert.throws(() => validatePipelineState({ ...initial, unknown: true }), { code: 'PIPELINE_STATE_INVALID' });
  assert.throws(() => validatePipelineState({
    ...initial, counters: { ...initial.counters, slowCalls: PIPELINE_LIMITS.maximumSlowCalls + 1 }
  }), { code: 'PIPELINE_STATE_INVALID' });
  assert.throws(() => validatePipelineState({
    ...initial, limits: { ...initial.limits, maximumGoals: 999 }
  }), { code: 'PIPELINE_STATE_INVALID' });
});

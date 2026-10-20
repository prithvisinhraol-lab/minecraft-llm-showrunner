import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluatePipelineLiveEvidence } from '../scripts/verify-llm-goal-pipeline-live.mjs';
import { createInitialPipelineState, validatePipelineState } from '../src/llm-goal-pipeline/state.mjs';

const observedAt = '2026-09-10T12:00:20.000Z';
const now = '2026-09-10T12:04:59.999Z';

function event(kind, contractId, predecessorContractId, observationVersion, relatedObservationVersion, time) {
  return { kind, contractId, predecessorContractId, observationVersion, relatedObservationVersion, observedAt: time };
}

function evidence() {
  const state = structuredClone(createInitialPipelineState({
    actorId: 'LlmAgent', mission: 'survive and progress toward stone tools', now: '2026-09-10T12:00:00.000Z'
  }));
  state.lifecycle.status = 'succeeded';
  state.lifecycle.startedAt = '2026-09-10T12:00:00.000Z';
  state.lifecycle.finishedAt = observedAt;
  state.lifecycle.updatedAt = observedAt;
  state.outcomes = [
    { contractId: 'contract-1-1', status: 'succeeded', proofKinds: ['inventory_at_least:oak_log'], summary: 'succeeded', completedAt: '2026-09-10T12:00:10.000Z' },
    { contractId: 'contract-1-2', status: 'succeeded', proofKinds: ['inventory_at_least:stone_pickaxe'], summary: 'succeeded', completedAt: observedAt }
  ];
  state.counters.goalsCompleted = 2;
  state.counters.slowCalls = 2;
  state.counters.fastCalls = 4;
  state.counters.runtimeMs = 20_000;
  state.audit = [
    event('generation_started', 'contract-1-1', null, 1, null, '2026-09-10T12:00:00.000Z'),
    event('generation_completed', 'contract-1-1', null, 1, null, '2026-09-10T12:00:01.000Z'),
    event('execution_started', 'contract-1-1', null, 1, null, '2026-09-10T12:00:02.000Z'),
    event('generation_started', 'contract-1-2', 'contract-1-1', 1, null, '2026-09-10T12:00:03.000Z'),
    event('generation_completed', 'contract-1-2', 'contract-1-1', 1, null, '2026-09-10T12:00:05.000Z'),
    event('promotion_validated', 'contract-1-2', 'contract-1-1', 1, 2, '2026-09-10T12:00:11.000Z'),
    event('execution_started', 'contract-1-2', 'contract-1-1', 2, null, '2026-09-10T12:00:12.000Z')
  ];
  const pipelineState = validatePipelineState(state);
  const actorEvidence = {
    source: 'mineflayer-live', simulated: false, provider: 'codex', actorId: 'LlmAgent', observedAt,
    contracts: [
      { contractId: 'contract-1-1', status: 'succeeded', proofKinds: ['inventory_at_least:oak_log'] },
      { contractId: 'contract-1-2', status: 'succeeded', proofKinds: ['inventory_at_least:stone_pickaxe'] }
    ],
    inventory: [{ item: 'stone_pickaxe', count: 1 }]
  };
  return { pipelineState, actorEvidence };
}

test('accepts paired live evidence for two overlapped goals and a fresh promotion', () => {
  assert.deepEqual(evaluatePipelineLiveEvidence({ ...evidence(), worldCheck: true, now }), {
    ok: true,
    classification: 'verified-live-generated-pipeline',
    checks: {
      supervisorSucceeded: true,
      twoConsecutiveGoals: true,
      speculationOverlappedExecution: true,
      freshPromotionValidation: true,
      liveFastEvidence: true,
      withinLimits: true,
      noUnverifiedThirdGoal: true,
      serverWorldVerified: true
    }
  });
});

test('rejects simulated, mismatched, stale, or incomplete fast evidence', () => {
  const cases = [
    ({ actorEvidence }) => ({ ...actorEvidence, source: 'simulated', simulated: true }),
    ({ actorEvidence }) => ({ ...actorEvidence, provider: 'scripted' }),
    ({ actorEvidence }) => ({ ...actorEvidence, actorId: 'OtherAgent' }),
    ({ actorEvidence }) => ({ ...actorEvidence, observedAt: '2026-09-10T11:54:59.999Z' }),
    ({ actorEvidence }) => ({ ...actorEvidence, contracts: actorEvidence.contracts.slice(0, 1) }),
    ({ actorEvidence }) => ({ ...actorEvidence, inventory: [] })
  ];
  for (const alter of cases) {
    const input = evidence();
    input.actorEvidence = alter(input);
    assert.equal(evaluatePipelineLiveEvidence({ ...input, worldCheck: true, now }).ok, false);
  }
});

test('rejects missing overlap, stale promotion, exceeded limits, third work, and absent world check', () => {
  const cases = [
    ({ pipelineState }) => {
      const state = structuredClone(pipelineState);
      state.outcomes[0].completedAt = '2026-09-10T12:00:04.000Z';
      return validatePipelineState(state);
    },
    ({ pipelineState }) => {
      const state = structuredClone(pipelineState);
      const promotion = state.audit.find(({ kind }) => kind === 'promotion_validated');
      promotion.relatedObservationVersion = promotion.observationVersion;
      return state;
    },
    ({ pipelineState }) => {
      const state = structuredClone(pipelineState);
      state.counters.fastCalls = state.limits.maximumFastCalls + 1;
      return state;
    },
    ({ pipelineState }) => {
      const state = structuredClone(pipelineState);
      state.audit.push(event('execution_started', 'contract-1-3', 'contract-1-2', 3, null, observedAt));
      return validatePipelineState(state);
    }
  ];
  for (const alter of cases) {
    const input = evidence();
    input.pipelineState = alter(input);
    assert.equal(evaluatePipelineLiveEvidence({ ...input, worldCheck: true, now }).ok, false);
  }
  assert.equal(evaluatePipelineLiveEvidence({ ...evidence(), worldCheck: false, now }).ok, false);
});

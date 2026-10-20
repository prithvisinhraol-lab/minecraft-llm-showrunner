import assert from 'node:assert/strict';
import test from 'node:test';

import { FIRST_GOAL_OBJECTIVE, createInitialActorState } from '../src/llm-agent/contracts.mjs';
import { evaluateLiveEvidence } from '../scripts/verify-llm-agent-live.mjs';

const observedAt = '2026-08-24T12:00:00.000Z';
const now = '2026-08-24T12:04:59.999Z';
const marker = Object.freeze({ dimension: 'minecraft:overworld', x: 4, y: 64, z: 0 });

function verifiedState(overrides = {}) {
  const state = structuredClone(createInitialActorState({
    actorId: 'LlmAgent', runId: 'run-1', now: observedAt, goal: FIRST_GOAL_OBJECTIVE
  }));
  state.lifecycle = {
    ...state.lifecycle,
    status: 'succeeded', updatedAt: observedAt, startedAt: observedAt, finishedAt: observedAt
  };
  state.trusted = {
    ...state.trusted,
    phase: 'goal_verified',
    milestones: ['mined_oak_log'],
    recentObservations: [],
    recentActionResults: [
      { action: 'mine_block', ok: true, code: 'OAK_LOG_MINING_VERIFIED' },
      { action: 'place_on_block', targetId: 'target-7-2', ok: true, code: 'OAK_LOG_PLACEMENT_VERIFIED', marker },
      { action: 'finish', ok: true, code: 'GOAL_VERIFIED' }
    ],
    evidence: {
      source: 'mineflayer-live',
      simulated: false,
      provider: 'codex',
      actorId: 'LlmAgent',
      runId: 'run-1',
      observedAt,
      goalProof: { markerTargetId: 'target-7-2', marker, markerBlock: 'gold_block', aboveBlock: 'oak_log' }
    }
  };
  return { ...state, ...overrides };
}

test('reports current controller-owned Mineflayer completion evidence', () => {
  const state = verifiedState();

  assert.deepEqual(evaluateLiveEvidence({ state, now }), {
    ok: true,
    classification: 'real-server-evidence',
    checks: {
      controllerSucceeded: true,
      minedOakLog: true,
      oakLogAboveGoldMarker: true,
      liveObservation: true
    }
  });
});

test('never promotes simulated, stale, or mismatched state to live evidence', () => {
  const cases = [
    verifiedState({ trusted: { ...verifiedState().trusted, evidence: { ...verifiedState().trusted.evidence, source: 'simulated', simulated: true } } }),
    verifiedState({ trusted: { ...verifiedState().trusted, evidence: { ...verifiedState().trusted.evidence, provider: 'scripted' } } }),
    verifiedState({ trusted: { ...verifiedState().trusted, evidence: { ...verifiedState().trusted.evidence, observedAt: '2026-08-24T11:54:59.999Z' } } }),
    verifiedState({ trusted: { ...verifiedState().trusted, evidence: { ...verifiedState().trusted.evidence, observedAt: 'Sun, 24 Aug 2026 12:00:00 GMT' } } }),
    verifiedState({ trusted: { ...verifiedState().trusted, evidence: { ...verifiedState().trusted.evidence, observedAt: '2026-08-24T12:05:00.000Z' } } }),
    verifiedState({ trusted: { ...verifiedState().trusted, evidence: { ...verifiedState().trusted.evidence, actorId: 'DifferentAgent' } } })
  ];

  for (const state of cases) {
    const result = evaluateLiveEvidence({ state, now });
    assert.equal(result.ok, false);
    assert.equal(result.classification, 'not-verified');
    assert.deepEqual(Object.keys(result.checks).sort(), [
      'controllerSucceeded', 'liveObservation', 'minedOakLog', 'oakLogAboveGoldMarker'
    ]);
  }
});

test('requires one unique mining milestone and an exact stable marker identity', () => {
  const duplicateMilestone = verifiedState({
    trusted: { ...verifiedState().trusted, milestones: ['mined_oak_log', 'mined_oak_log'] }
  });
  const restartRenumberedMarker = verifiedState({
    trusted: {
      ...verifiedState().trusted,
      recentActionResults: verifiedState().trusted.recentActionResults.map((result) => result.action === 'place_on_block'
        ? { ...result, targetId: 'target-1-2', marker: { ...marker, x: 99 } }
        : result),
      evidence: {
        ...verifiedState().trusted.evidence,
        goalProof: { ...verifiedState().trusted.evidence.goalProof, markerTargetId: 'target-1-2' }
      }
    }
  });

  for (const state of [duplicateMilestone, restartRenumberedMarker]) {
    assert.equal(evaluateLiveEvidence({ state, now }).classification, 'not-verified');
  }
});

test('requires a verified mining milestone, successful receipt, and exact marker proof', () => {
  const missingMilestone = verifiedState({
    trusted: { ...verifiedState().trusted, milestones: [] }
  });
  const noSuccessfulReceipt = verifiedState({
    trusted: { ...verifiedState().trusted, recentActionResults: [{ action: 'finish', ok: false, code: 'GOAL_NOT_VERIFIED' }] }
  });
  const wrongProof = verifiedState({
    trusted: { ...verifiedState().trusted, evidence: {
      ...verifiedState().trusted.evidence,
      goalProof: { markerTargetId: 'target-7-2', markerBlock: 'gold_block', aboveBlock: 'spruce_log' }
    } }
  });

  for (const state of [missingMilestone, noSuccessfulReceipt, wrongProof]) {
    assert.deepEqual(evaluateLiveEvidence({ state, now }), {
      ok: false,
      classification: 'not-verified',
      checks: {
        controllerSucceeded: state === wrongProof ? false : true,
        minedOakLog: state === wrongProof || state === missingMilestone || state === noSuccessfulReceipt ? false : true,
        oakLogAboveGoldMarker: state === wrongProof || state === noSuccessfulReceipt ? false : true,
        liveObservation: state === wrongProof ? false : true
      }
    });
  }
});

test('fails closed when the persisted actor record is malformed', () => {
  const state = verifiedState({ goal: null });

  assert.deepEqual(evaluateLiveEvidence({ state, now }), {
    ok: false,
    classification: 'not-verified',
    checks: {
      controllerSucceeded: false,
      minedOakLog: false,
      oakLogAboveGoldMarker: false,
      liveObservation: false
    }
  });
});

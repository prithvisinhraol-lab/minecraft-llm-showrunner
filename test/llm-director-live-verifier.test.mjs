import assert from 'node:assert/strict';
import test from 'node:test';

import { createInitialActorState } from '../src/llm-agent/contracts.mjs';
import { COLLECT_OAK_LOG_GOAL } from '../src/llm-agent/goals.mjs';
import { createInitialDirectorState } from '../src/llm-director/contracts.mjs';
import { evaluateDirectorLiveEvidence } from '../scripts/verify-llm-director-live.mjs';

const now = '2026-08-28T20:00:00.000Z';
const proof = {
  markerTargetId: 'target-2-1', marker: { dimension: 'minecraft:overworld', x: 54, y: 65, z: 52 },
  markerBlock: 'gold_block', aboveBlock: 'air', collectedItem: 'oak_log', collectedCount: 1
};

function actor() {
  const state = structuredClone(createInitialActorState({ actorId: 'LlmAgent', runId: 'agent-2', now, goal: COLLECT_OAK_LOG_GOAL }));
  state.lifecycle = { ...state.lifecycle, status: 'succeeded', startedAt: now, finishedAt: now };
  state.trusted.phase = 'goal_verified'; state.trusted.milestones = ['mined_oak_log'];
  state.trusted.recentActionResults = [
    { action: 'mine_block', ok: true, code: 'OAK_LOG_MINING_VERIFIED' },
    { action: 'finish', ok: true, code: 'GOAL_VERIFIED' }
  ];
  state.trusted.evidence = { source: 'mineflayer-live', simulated: false, provider: 'codex', actorId: 'LlmAgent', runId: 'agent-2', observedAt: now, goalProof: proof };
  return state;
}

function director() {
  const state = structuredClone(createInitialDirectorState({ actorId: 'LlmAgent', runId: 'director-1', now, overallObjective: 'advance' }));
  state.lifecycle = { ...state.lifecycle, status: 'succeeded', startedAt: now, finishedAt: now };
  state.currentGoalId = COLLECT_OAK_LOG_GOAL.id; state.limits.selectionsUsed = 1;
  state.decision = { reason: 'collect it', stateSummary: 'collected verified marker log' };
  state.outcomes = [{ goalId: COLLECT_OAK_LOG_GOAL.id, status: 'succeeded', agentRunId: 'agent-2', completedAt: now, summary: 'collected verified marker log', proof: { kind: COLLECT_OAK_LOG_GOAL.successCondition.kind } }];
  return state;
}

test('requires matching paired live state plus an independent server-world check', () => {
  assert.deepEqual(evaluateDirectorLiveEvidence({ actorState: actor(), directorState: director(), worldCheck: true }), {
    ok: true, classification: 'verified-live-director-handoff',
    checks: { directorSucceeded: true, exactlyOneSelection: true, actorSucceeded: true, matchingRun: true, liveCollectionProof: true, serverWorldVerified: true }
  });
  assert.equal(evaluateDirectorLiveEvidence({ actorState: actor(), directorState: director(), worldCheck: false }).ok, false);
});

test('rejects simulated proof, run mismatch, absent proof, nonterminal director, and extra selection', () => {
  const cases = [];
  const simulated = actor(); simulated.trusted.evidence.source = 'simulated'; simulated.trusted.evidence.simulated = true; cases.push([simulated, director()]);
  const mismatch = director(); mismatch.outcomes[0].agentRunId = 'other'; cases.push([actor(), mismatch]);
  const absent = actor(); absent.trusted.evidence.goalProof = null; cases.push([absent, director()]);
  const running = director(); running.lifecycle.status = 'running'; running.lifecycle.finishedAt = null; cases.push([actor(), running]);
  const extra = director(); extra.limits.selectionsUsed = 2; cases.push([actor(), extra]);
  for (const [actorState, directorState] of cases) {
    assert.equal(evaluateDirectorLiveEvidence({ actorState, directorState, worldCheck: true }).ok, false);
  }
});

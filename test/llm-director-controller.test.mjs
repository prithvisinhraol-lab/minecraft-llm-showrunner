import assert from 'node:assert/strict';
import test from 'node:test';

import { createInitialActorState } from '../src/llm-agent/contracts.mjs';
import { COLLECT_OAK_LOG_GOAL, PLACE_OAK_LOG_GOAL } from '../src/llm-agent/goals.mjs';
import { createDirectorController } from '../src/llm-director/controller.mjs';

const now = '2026-08-28T20:00:00.000Z';
const placementProof = {
  markerTargetId: 'target-1-1', marker: { dimension: 'minecraft:overworld', x: 4, y: 64, z: 0 },
  markerBlock: 'gold_block', aboveBlock: 'oak_log'
};
const collectionProof = {
  markerTargetId: 'target-2-1', marker: placementProof.marker,
  markerBlock: 'gold_block', aboveBlock: 'air', collectedItem: 'oak_log', collectedCount: 1
};

function actorState(goal, proof, status = 'succeeded') {
  const state = structuredClone(createInitialActorState({ actorId: 'LlmAgent', runId: `agent-${goal.id}`, now, goal }));
  state.lifecycle = { ...state.lifecycle, status, startedAt: now, finishedAt: now };
  state.trusted.phase = status === 'succeeded' ? 'goal_verified' : 'failed';
  state.trusted.milestones = ['mined_oak_log'];
  state.trusted.evidence = {
    source: 'mineflayer-live', simulated: false, provider: 'codex', actorId: 'LlmAgent',
    runId: state.lifecycle.runId, observedAt: now, goalProof: proof
  };
  return state;
}

class Store {
  constructor(events) { this.events = events; this.value = null; this.lease = null; this.saved = []; }
  async load() { this.events.push('store:load'); return structuredClone(this.value); }
  async save(_actor, state) { this.events.push(`store:save:${state.currentGoalId ?? state.lifecycle.status}`); this.value = structuredClone(state); this.saved.push(structuredClone(state)); }
  async reset() { this.value = null; }
  async acquireLease(_actor, lease) { if (this.lease) throw Object.assign(new Error('held'), { code: 'LLM_DIRECTOR_LEASE_HELD' }); this.lease = lease; }
  async releaseLease(_actor, owner) { if (this.lease?.ownerId !== owner) return false; this.lease = null; return true; }
}

function harness(overrides = {}) {
  const events = [];
  const store = overrides.store ?? new Store(events);
  let providerCalls = 0; let runCalls = 0;
  const provider = overrides.provider ?? { async select() { providerCalls += 1; events.push('provider'); return {
    decision: 'select_goal', goalId: COLLECT_OAK_LOG_GOAL.id, reason: 'collect the placed log', stateSummary: 'placement verified'
  }; } };
  const controller = createDirectorController({
    actorId: 'LlmAgent', overallObjective: 'advance through small verified goals', store, provider,
    loadAgentState: overrides.loadAgentState ?? (async () => actorState(PLACE_OAK_LOG_GOAL, placementProof)),
    inspectPrerequisite: overrides.inspectPrerequisite ?? (async () => ({ ok: true, proof: placementProof })),
    runGoal: overrides.runGoal ?? (async (goal) => { runCalls += 1; events.push('runGoal'); assert.deepEqual(goal, COLLECT_OAK_LOG_GOAL); return actorState(goal, collectionProof); }),
    clock: { now: () => new Date(now) }
  });
  return { controller, store, events, calls: () => ({ providerCalls, runCalls }) };
}

test('persists one selection before one fast run and records matching live success', async () => {
  const h = harness();
  const result = await h.controller.start();
  await h.controller.awaitIdle();
  assert.equal(result.lifecycle.status, 'succeeded');
  assert.deepEqual(h.calls(), { providerCalls: 1, runCalls: 1 });
  assert.ok(h.events.indexOf(`store:save:${COLLECT_OAK_LOG_GOAL.id}`) < h.events.indexOf('runGoal'));
  assert.equal(h.store.value.outcomes.length, 1);
  assert.deepEqual(h.store.value.outcomes[0], {
    goalId: COLLECT_OAK_LOG_GOAL.id, status: 'succeeded', agentRunId: `agent-${COLLECT_OAK_LOG_GOAL.id}`,
    completedAt: now, summary: 'placement verified', proof: { kind: 'oak_log_collected_from_above_gold_marker' }
  });
  assert.equal(h.store.lease, null);
});

test('rejects duplicate start while a director run is active', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const h = harness({ runGoal: async () => pending });
  const first = h.controller.start();
  await assert.rejects(h.controller.start(), { code: 'LLM_DIRECTOR_ALREADY_RUNNING' });
  release(actorState(COLLECT_OAK_LOG_GOAL, collectionProof));
  await first;
});

test('fails closed without a second selection for invalid prerequisites or agent evidence', async (t) => {
  const cases = [
    { name: 'no eligible evidence', loadAgentState: async () => actorState(PLACE_OAK_LOG_GOAL, placementProof, 'failed') },
    { name: 'changed prerequisite', inspectPrerequisite: async () => ({ ok: false, proof: null }) },
    { name: 'simulated result', runGoal: async () => {
      const state = actorState(COLLECT_OAK_LOG_GOAL, collectionProof); state.trusted.evidence.source = 'simulated'; state.trusted.evidence.simulated = true; return state;
    } },
    { name: 'failed agent', runGoal: async () => actorState(COLLECT_OAK_LOG_GOAL, collectionProof, 'failed') }
  ];
  for (const entry of cases) await t.test(entry.name, async () => {
    const h = harness(entry);
    await assert.rejects(h.controller.start());
    assert.equal(h.store.value.lifecycle.status, 'failed');
    assert.ok(h.calls().providerCalls <= 1);
    assert.ok(h.calls().runCalls <= 1);
    assert.equal(h.store.lease, null);
  });
});

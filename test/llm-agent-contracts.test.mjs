import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACTION_NAMES,
  MAX_RECENT_RESULTS,
  MAX_SUMMARY_CHARACTERS,
  MAX_TURNS,
  createInitialActorState,
  toDecisionContext,
  validateActorState,
  validateDecision
} from '../src/llm-agent/contracts.mjs';
import { COLLECT_OAK_LOG_GOAL, PLACE_OAK_LOG_GOAL } from '../src/llm-agent/goals.mjs';

const now = '2026-08-24T12:00:00.000Z';
const goal = 'obtain one oak_log and place an oak_log directly above a controller-identified gold_block marker';
const observation = {
  health: 20,
  inventory: [{ item: 'oak_log', count: 1 }],
  targets: [{ id: 'oak-1', kind: 'block', block: 'oak_log', distanceBand: 'near', reachable: true }],
  landmarks: [{ reference: 'landmark:goal-marker', kind: 'gold_block', status: 'out_of_view', revisitable: true }]
};

function decision(overrides = {}) {
  return {
    action: 'observe',
    reason: 'check the nearby area',
    summary: '',
    plan: ['inspect the nearby targets'],
    subgoal: 'inspect',
    variables: {},
    ...overrides
  };
}

test('exports the bounded action contract constants', () => {
  assert.deepEqual(ACTION_NAMES, [
    'observe', 'move_to_block', 'navigate_to_landmark', 'mine_block', 'select_item', 'place_on_block', 'finish'
  ]);
  assert.equal(MAX_TURNS, 12);
  assert.equal(MAX_SUMMARY_CHARACTERS, 500);
  assert.equal(MAX_RECENT_RESULTS, MAX_TURNS);
  assert.equal(Object.isFrozen(ACTION_NAMES), true);
});

test('creates and freezes controller-owned initial state', () => {
  const state = createInitialActorState({ actorId: 'AgentOne', runId: 'run-1', now, goal });

  assert.equal(state.identity.actorId, 'AgentOne');
  assert.equal(state.identity.schemaVersion, 1);
  assert.equal(state.lifecycle.runId, 'run-1');
  assert.equal(state.lifecycle.status, 'idle');
  assert.equal(state.goal.objective, goal);
  assert.equal(state.goal.id, PLACE_OAK_LOG_GOAL.id);
  assert.deepEqual(state.working, { summary: '', plan: [], subgoal: '', variables: {} });
  assert.deepEqual(state.trusted.recentActionResults, []);
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.working), true);
});

test('accepts both catalog goals and rejects arbitrary goal combinations', () => {
  const collection = createInitialActorState({
    actorId: 'AgentOne', runId: 'run-collect', now, goal: COLLECT_OAK_LOG_GOAL
  });
  assert.deepEqual(collection.goal, COLLECT_OAK_LOG_GOAL);

  assert.throws(() => createInitialActorState({
    actorId: 'AgentOne', runId: 'run-bad', now,
    goal: { objective: 'build a castle', successCondition: { kind: 'castle_exists' } }
  }), { code: 'LLM_AGENT_STATE_INVALID' });
});

test('loads the legacy persisted placement goal and upgrades it canonically', () => {
  const state = structuredClone(createInitialActorState({
    actorId: 'AgentOne', runId: 'run-legacy', now, goal: PLACE_OAK_LOG_GOAL
  }));
  delete state.goal.id;
  delete state.goal.maxTurns;

  assert.deepEqual(validateActorState(state).goal, PLACE_OAK_LOG_GOAL);
});

test('rejects coordinates and unknown decision fields', () => {
  assert.throws(() => validateDecision({
    action: 'mine_block', targetId: 'oak-1', x: 10,
    reason: 'mine it', summary: '', plan: ['mine'], subgoal: 'mine', variables: {}
  }, observation), { code: 'LLM_AGENT_DECISION_INVALID' });
});

test('requires exact action parameters and known targets', () => {
  assert.throws(() => validateDecision(decision({ action: 'mine_block' }), observation), {
    code: 'LLM_AGENT_DECISION_INVALID'
  });
  assert.throws(() => validateDecision(decision({ action: 'mine_block', targetId: 'spruce-1' }), observation), {
    code: 'LLM_AGENT_DECISION_INVALID'
  });
  assert.throws(() => validateDecision(decision({ action: 'select_item', item: 'diamond' }), observation), {
    code: 'LLM_AGENT_DECISION_INVALID'
  });
  assert.throws(() => validateDecision(decision({ action: 'observe', targetId: 'oak-1' }), observation), {
    code: 'LLM_AGENT_DECISION_INVALID'
  });
});

test('accepts each allowlisted action and freezes normalized decisions', () => {
  for (const value of [
    decision(),
    decision({ action: 'move_to_block', targetId: 'oak-1' }),
    decision({ action: 'navigate_to_landmark', reference: 'landmark:goal-marker' }),
    decision({ action: 'mine_block', targetId: 'oak-1' }),
    decision({ action: 'select_item', item: 'oak_log' }),
    decision({ action: 'place_on_block', targetId: 'oak-1' }),
    decision({ action: 'finish' })
  ]) {
    const result = validateDecision(value, observation);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.plan), true);
    assert.deepEqual(Object.keys(result).sort(), Object.keys(value).sort());
  }
});

test('accepts only a coordinate-free landmark reference from the current trusted observation', () => {
  const accepted = validateDecision(decision({
    action: 'navigate_to_landmark', reference: 'landmark:goal-marker'
  }), observation);
  assert.equal(accepted.reference, 'landmark:goal-marker');
  assert.equal(JSON.stringify(accepted).includes('"x"'), false);

  assert.throws(() => validateDecision(decision({
    action: 'navigate_to_landmark', reference: 'landmark:unknown'
  }), observation), { code: 'LLM_AGENT_DECISION_INVALID' });
});

test('enforces summary, plan, and JSON-scalar variable limits', () => {
  assert.doesNotThrow(() => validateDecision(decision({
    summary: '🙂'.repeat(MAX_SUMMARY_CHARACTERS),
    variables: { string: 'x'.repeat(200), number: 1, boolean: false, nothing: null }
  }), observation));
  assert.throws(() => validateDecision(decision({ summary: '🙂'.repeat(MAX_SUMMARY_CHARACTERS + 1) }), observation), {
    code: 'LLM_AGENT_DECISION_INVALID'
  });
  assert.throws(() => validateDecision(decision({ plan: ['', 'ok'] }), observation), {
    code: 'LLM_AGENT_DECISION_INVALID'
  });
  assert.throws(() => validateDecision(decision({ plan: ['x', 'x', 'x', 'x', 'x', 'x'] }), observation), {
    code: 'LLM_AGENT_DECISION_INVALID'
  });
  assert.throws(() => validateDecision(decision({ variables: { nested: { bad: true } } }), observation), {
    code: 'LLM_AGENT_DECISION_INVALID'
  });
  assert.throws(() => validateDecision(decision({ variables: { text: 'x'.repeat(201) } }), observation), {
    code: 'LLM_AGENT_DECISION_INVALID'
  });
  assert.throws(() => validateDecision(decision({ variables: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`v${i}`, i])) }), observation), {
    code: 'LLM_AGENT_DECISION_INVALID'
  });
});

test('preserves controller-owned state while validating and freezes a detached copy', () => {
  const state = createInitialActorState({ actorId: 'AgentOne', runId: 'run-1', now, goal });
  const persisted = structuredClone(state);
  persisted.lifecycle.status = 'running';
  persisted.trusted.phase = 'working';
  persisted.trusted.milestones = ['found_marker'];
  persisted.trusted.recentActionResults = Array.from({ length: MAX_RECENT_RESULTS + 2 }, (_, i) => ({
    action: 'observe', ok: i > 1, code: i > 1 ? 'OK' : 'FAILED'
  }));
  persisted.working = {
    summary: 'remembered', plan: ['mine', 'place'], subgoal: 'collect', variables: { attempts: 2 }
  };

  const validated = validateActorState(persisted);
  assert.equal(validated.lifecycle.status, 'running');
  assert.equal(validated.trusted.phase, 'working');
  assert.deepEqual(validated.trusted.milestones, ['found_marker']);
  assert.equal(validated.trusted.recentActionResults.length, MAX_RECENT_RESULTS);
  assert.equal(validated.working.summary, 'remembered');
  assert.notEqual(validated, persisted);
  assert.equal(Object.isFrozen(validated.trusted.recentActionResults), true);
});

test('preserves only well-formed controller-owned live evidence', () => {
  const state = structuredClone(createInitialActorState({ actorId: 'AgentOne', runId: 'run-1', now, goal }));
  state.trusted.evidence = {
    source: 'mineflayer-live',
    simulated: false,
    provider: 'codex',
    actorId: 'AgentOne',
    runId: 'run-1',
    observedAt: now,
    goalProof: {
      markerTargetId: 'target-2-1', marker: { dimension: 'minecraft:overworld', x: 4, y: 64, z: 0 },
      markerBlock: 'gold_block', aboveBlock: 'oak_log'
    }
  };

  const validated = validateActorState(state);
  assert.deepEqual(validated.trusted.evidence, state.trusted.evidence);
  assert.equal(Object.isFrozen(validated.trusted.evidence), true);

  const invalid = structuredClone(state);
  invalid.trusted.evidence.source = 'forged';
  assert.throws(() => validateActorState(invalid), { code: 'LLM_AGENT_STATE_INVALID' });
});

test('rejects duplicate milestones and keeps stable marker coordinates out of decision context', () => {
  const state = structuredClone(createInitialActorState({ actorId: 'AgentOne', runId: 'run-1', now, goal }));
  state.trusted.milestones = ['mined_oak_log', 'mined_oak_log'];
  assert.throws(() => validateActorState(state), { code: 'LLM_AGENT_STATE_INVALID' });

  state.trusted.milestones = ['mined_oak_log'];
  state.trusted.recentActionResults = [{
    action: 'place_on_block', ok: true, code: 'OAK_LOG_PLACEMENT_VERIFIED', targetId: 'target-2-1',
    marker: { dimension: 'minecraft:overworld', x: 4, y: 64, z: 0 }
  }];
  state.trusted.evidence = {
    source: 'mineflayer-live', simulated: false, provider: 'codex', actorId: 'AgentOne', runId: 'run-1', observedAt: now,
    goalProof: {
      markerTargetId: 'target-2-1', marker: { dimension: 'minecraft:overworld', x: 4, y: 64, z: 0 },
      markerBlock: 'gold_block', aboveBlock: 'oak_log'
    }
  };

  assert.equal(JSON.stringify(toDecisionContext(state, observation)).includes('"x"'), false);
});

test('enforces the fixed first goal and the persisted twelve-turn ceiling', () => {
  assert.throws(() => createInitialActorState({
    actorId: 'AgentOne', runId: 'run-1', now, goal: 'build a castle'
  }), { code: 'LLM_AGENT_STATE_INVALID' });

  const state = createInitialActorState({ actorId: 'AgentOne', runId: 'run-1', now, goal });
  const overBudget = structuredClone(state);
  overBudget.limits.maxTurns = MAX_TURNS + 1;
  assert.throws(() => validateActorState(overBudget), { code: 'LLM_AGENT_STATE_INVALID' });
  overBudget.limits.maxTurns = MAX_TURNS;
  overBudget.limits.turnsUsed = MAX_TURNS + 1;
  assert.throws(() => validateActorState(overBudget), { code: 'LLM_AGENT_STATE_INVALID' });
});

test('rejects attempts to smuggle controller fields into decisions', () => {
  assert.throws(() => validateDecision(decision({ trusted: { phase: 'succeeded' } }), observation), {
    code: 'LLM_AGENT_DECISION_INVALID'
  });
});

test('decision context exposes target IDs but no coordinates', () => {
  const state = createInitialActorState({ actorId: 'AgentOne', runId: 'run-1', now, goal });
  const privateObservation = {
    ...observation,
    position: { x: 10, y: 64, z: -3 },
    targets: [{ ...observation.targets[0], x: 12, y: 64, z: -3, position: { x: 12, y: 64, z: -3 } }]
  };
  const context = toDecisionContext(state, privateObservation);

  assert.equal(JSON.stringify(context).includes('"x"'), false);
  assert.deepEqual(context.observation.targets[0], {
    id: 'oak-1', kind: 'block', block: 'oak_log', distanceBand: 'near', reachable: true
  });
});

test('decision context rejects coordinate-shaped goal, history, observation, and target data', () => {
  const state = createInitialActorState({ actorId: 'AgentOne', runId: 'run-1', now, goal });
  const coordinateGoal = structuredClone(state);
  coordinateGoal.goal.successCondition = { x: 1, y: 2, z: 3 };
  assert.throws(() => toDecisionContext(coordinateGoal, observation), { code: 'LLM_AGENT_STATE_INVALID' });

  const coordinateHistory = structuredClone(state);
  coordinateHistory.trusted.recentActionResults = [{ action: 'observe', ok: true, receipt: { x: 1, y: 2, z: 3 } }];
  assert.equal(JSON.stringify(toDecisionContext(coordinateHistory, observation)).includes('"x"'), false);

  const coordinateObservation = structuredClone(state);
  coordinateObservation.trusted.recentObservations = [{ actorPosition: { x: 1, y: 2, z: 3 } }];
  assert.equal(JSON.stringify(toDecisionContext(coordinateObservation, observation)).includes('"x"'), false);

  assert.throws(() => toDecisionContext(state, {
    targets: [{ id: 'oak-1', kind: 'block', block: { x: 1, y: 2, z: 3 }, distanceBand: 'near', reachable: true }]
  }), { code: 'LLM_AGENT_DECISION_INVALID' });
});

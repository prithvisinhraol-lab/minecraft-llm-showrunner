import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FINAL_SURVIVAL_DEMO_LINE,
  SURVIVAL_DEMO_ACTIONS,
  SURVIVAL_DEMO_MILESTONES,
  applyVerifiedSurvivalDemoOutcome,
  createInitialSurvivalDemoState,
  expectedSurvivalDemoAction,
  validateSurvivalDemoDecision,
  validateSurvivalDemoState,
  verifySurvivalDemoMilestone
} from '../src/llm-agent/survival-demo-contracts.mjs';

const now = '2026-08-30T18:00:00.000Z';

function observation(overrides = {}) {
  return {
    observationVersion: 1, connected: true, alive: true,
    inventory: {}, equippedHand: null,
    runFacts: { brokenOakLogs: 0, minedStone: 0, placedCraftingTable: false },
    villageEvidence: { bell: false, beds: 0, villagers: 0 },
    observedChat: [],
    ...overrides
  };
}

function decision(action, overrides = {}) {
  return {
    action, observationVersion: 1,
    reason: 'Take the next verified survival step.',
    ...overrides
  };
}

test('defines one exact ordered survival demonstration and final line', () => {
  assert.deepEqual(SURVIVAL_DEMO_MILESTONES, [
    'wood_collected', 'crafting_table_placed', 'wooden_pickaxe_crafted',
    'stone_mined', 'furnace_crafted', 'village_found', 'final_line_spoken'
  ]);
  assert.deepEqual(SURVIVAL_DEMO_ACTIONS, [
    'gather_wood', 'craft_and_place_table', 'craft_wooden_pickaxe',
    'mine_stone', 'craft_furnace', 'find_village', 'say_final_line', 'stop'
  ]);
  assert.equal(FINAL_SURVIVAL_DEMO_LINE, 'This is gonna be great!!!');
  assert.equal(Object.isFrozen(SURVIVAL_DEMO_MILESTONES), true);
});

test('creates a frozen bounded state with the first action selected by code', () => {
  const state = createInitialSurvivalDemoState({ actorId: 'LlmAgent', runId: 'run-1', now });
  assert.equal(state.status, 'idle');
  assert.equal(state.maximumDecisions, 16);
  assert.equal(state.nextMilestoneIndex, 0);
  assert.deepEqual(state.verifiedMilestones, []);
  assert.equal(expectedSurvivalDemoAction(state), 'gather_wood');
  assert.equal(Object.isFrozen(state), true);
});

test('accepts only the next action or stop and binds it to the current observation', () => {
  const state = createInitialSurvivalDemoState({ actorId: 'LlmAgent', runId: 'run-1', now });
  assert.deepEqual(validateSurvivalDemoDecision(decision('gather_wood'), state, observation()), decision('gather_wood'));
  assert.deepEqual(validateSurvivalDemoDecision(decision('stop'), state, observation()), decision('stop'));
  assert.throws(() => validateSurvivalDemoDecision(decision('craft_furnace'), state, observation()), {
    code: 'SURVIVAL_DEMO_DECISION_INVALID'
  });
  assert.throws(() => validateSurvivalDemoDecision(decision('gather_wood', { observationVersion: 2 }), state, observation()), {
    code: 'SURVIVAL_DEMO_DECISION_INVALID'
  });
  assert.throws(() => validateSurvivalDemoDecision({ ...decision('gather_wood'), command: '/give @s oak_log' }, state, observation()), {
    code: 'SURVIVAL_DEMO_DECISION_INVALID'
  });
});

test('requires live run facts as well as inventory for gathered and mined resources', () => {
  assert.equal(verifySurvivalDemoMilestone('wood_collected', observation({
    inventory: { oak_log: 3 }, runFacts: { brokenOakLogs: 0, minedStone: 0, placedCraftingTable: false }
  })).verified, false);
  assert.deepEqual(verifySurvivalDemoMilestone('wood_collected', observation({
    inventory: { oak_log: 3 }, runFacts: { brokenOakLogs: 3, minedStone: 0, placedCraftingTable: false }
  })), { verified: true, proofKinds: ['inventory:oak_log>=3', 'run:broken_oak_logs>=3'] });

  assert.equal(verifySurvivalDemoMilestone('stone_mined', observation({
    inventory: { cobblestone: 8 }, runFacts: { brokenOakLogs: 3, minedStone: 0, placedCraftingTable: true }
  })).verified, false);
  assert.equal(verifySurvivalDemoMilestone('stone_mined', observation({
    inventory: { cobblestone: 8 }, runFacts: { brokenOakLogs: 3, minedStone: 8, placedCraftingTable: true }
  })).verified, true);
});

test('verifies table, pickaxe, furnace, and village from trusted observations', () => {
  assert.equal(verifySurvivalDemoMilestone('crafting_table_placed', observation({
    runFacts: { brokenOakLogs: 3, minedStone: 0, placedCraftingTable: true }
  })).verified, true);
  assert.equal(verifySurvivalDemoMilestone('wooden_pickaxe_crafted', observation({
    inventory: { wooden_pickaxe: 1 }, equippedHand: 'wooden_pickaxe'
  })).verified, true);
  assert.equal(verifySurvivalDemoMilestone('furnace_crafted', observation({ inventory: { furnace: 1 } })).verified, true);

  assert.equal(verifySurvivalDemoMilestone('village_found', observation({
    villageEvidence: { bell: true, beds: 0, villagers: 0 }
  })).verified, false);
  assert.deepEqual(verifySurvivalDemoMilestone('village_found', observation({
    villageEvidence: { bell: true, beds: 2, villagers: 1 }
  })), { verified: true, proofKinds: ['village:bell', 'village:beds>=1', 'village:villagers>=1'] });
});

test('refuses the final line before every prior milestone and requires observed actor chat', () => {
  let valid = createInitialSurvivalDemoState({ actorId: 'LlmAgent', runId: 'run-1', now });
  for (let index = 0; index < 6; index += 1) {
    valid = applyVerifiedSurvivalDemoOutcome(valid, {
      action: expectedSurvivalDemoAction(valid), observationVersion: index + 1,
      verification: { verified: true, proofKinds: [`proof:${SURVIVAL_DEMO_MILESTONES[index]}`] },
      observedAt: `2026-08-30T18:00:0${index}.000Z`
    });
  }
  validateSurvivalDemoState(valid);
  assert.equal(expectedSurvivalDemoAction(valid), 'say_final_line');
  assert.equal(verifySurvivalDemoMilestone('final_line_spoken', observation({
    observedChat: [{ username: 'OtherPlayer', message: FINAL_SURVIVAL_DEMO_LINE }]
  }), { actorId: 'LlmAgent' }).verified, false);
  assert.equal(verifySurvivalDemoMilestone('final_line_spoken', observation({
    observedChat: [{ username: 'LlmAgent', message: FINAL_SURVIVAL_DEMO_LINE }]
  }), { actorId: 'LlmAgent' }).verified, true);

  const early = createInitialSurvivalDemoState({ actorId: 'LlmAgent', runId: 'run-2', now });
  assert.throws(() => validateSurvivalDemoDecision(decision('say_final_line'), early, observation()), {
    code: 'SURVIVAL_DEMO_DECISION_INVALID'
  });
});

test('advances exactly one verified milestone and fails closed on stale or unverified outcomes', () => {
  const state = createInitialSurvivalDemoState({ actorId: 'LlmAgent', runId: 'run-1', now });
  const next = applyVerifiedSurvivalDemoOutcome(state, {
    action: 'gather_wood', observationVersion: 2,
    verification: { verified: true, proofKinds: ['inventory:oak_log>=3', 'run:broken_oak_logs>=3'] },
    observedAt: '2026-08-30T18:00:05.000Z'
  });
  assert.deepEqual(next.verifiedMilestones, ['wood_collected']);
  assert.equal(next.nextMilestoneIndex, 1);
  assert.equal(next.decisionsUsed, 1);
  assert.equal(expectedSurvivalDemoAction(next), 'craft_and_place_table');
  assert.throws(() => applyVerifiedSurvivalDemoOutcome(state, {
    action: 'gather_wood', observationVersion: 1,
    verification: { verified: true, proofKinds: [] }, observedAt: now
  }), { code: 'SURVIVAL_DEMO_OUTCOME_INVALID' });
  assert.throws(() => applyVerifiedSurvivalDemoOutcome(state, {
    action: 'gather_wood', observationVersion: 2,
    verification: { verified: false, proofKinds: [] }, observedAt: now
  }), { code: 'SURVIVAL_DEMO_OUTCOME_INVALID' });
});

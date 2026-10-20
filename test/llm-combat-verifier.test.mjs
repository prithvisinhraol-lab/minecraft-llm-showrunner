import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyCombatAction, verifyCombatGoal } from '../src/llm-combat/verifier.mjs';

const position = (x, y = 0, z = 0) => ({ x, y, z });
const observation = (version, overrides = {}) => ({
  observationVersion: version, actorId: 'fighter-1', targetId: 'opponent-1',
  actorPosition: position(0), targetPosition: position(3), distance: 3,
  actorHealth: 18, targetHealth: 16, selectedSlot: 2, shieldState: 'lowered',
  targetValid: true, actorInArena: true, targetInArena: true, connected: true,
  ...overrides
});
const intent = (kind, extra = {}) => ({
  kind, actorId: 'fighter-1', targetId: 'opponent-1', observationVersion: 7, ...extra
});
const result = (kind, overrides = {}) => ({
  status: 'completed', intentKind: kind, beforeObservationVersion: 7,
  afterObservationVersion: 8, ...overrides
});

test('verifies attack only from fresh independently observed target damage', () => {
  assert.deepEqual(verifyCombatAction(
    observation(7), intent('normal_attack'), observation(8, { targetHealth: 13 }), result('normal_attack')
  ), { verified: true, proofKinds: ['opponent_health_decreased'] });
  assert.deepEqual(verifyCombatAction(
    observation(7), intent('normal_attack'), observation(8), result('normal_attack')
  ), { verified: false, proofKinds: [], code: 'ATTACK_NOT_OBSERVED' });
});

test('verifies movement, shield, slot, item, and wait intents from their own effects', () => {
  const cases = [
    ['approach_target', {}, {}, { distance: 2.5 }, 'distance_decreased'],
    ['hold_distance', {}, {}, { distance: 3.1 }, 'distance_held'],
    ['strafe_left', { durationMs: 300 }, {}, { actorPosition: position(0, 0, 0.5) }, 'actor_position_changed'],
    ['strafe_right', { durationMs: 300 }, {}, { actorPosition: position(0, 0, -0.5) }, 'actor_position_changed'],
    ['raise_shield', {}, {}, { shieldState: 'raised' }, 'shield_raised'],
    ['lower_shield', {}, { shieldState: 'raised' }, { shieldState: 'lowered' }, 'shield_lowered'],
    ['select_hotbar_slot', { slot: 5 }, {}, { selectedSlot: 5 }, 'hotbar_slot_selected'],
    ['use_item', { itemId: 'golden_apple' }, {}, { actorHealth: 20 }, 'item_effect_observed'],
    ['retreat_to_anchor', { anchorId: 'arena-home', durationMs: 500 }, {}, { distance: 4, actorPosition: position(-1) }, 'retreat_movement_observed'],
    ['wait', { durationMs: 100 }, {}, {}, 'fresh_observation_after_wait']
  ];
  for (const [kind, extra, before, after, proofKind] of cases) {
    assert.deepEqual(verifyCombatAction(
      observation(7, before), intent(kind, extra), observation(8, after), result(kind)
    ), { verified: true, proofKinds: [proofKind] });
  }
});

test('fails closed for stale, mismatched, failed, disconnected, or out-of-arena evidence', () => {
  const cases = [
    [observation(7), result('wait'), 'OBSERVATION_NOT_FRESH'],
    [observation(8), result('wait', { afterObservationVersion: 9 }), 'RESULT_FENCE_MISMATCH'],
    [observation(8), result('wait', { status: 'failed' }), 'DRIVER_NOT_COMPLETED'],
    [observation(8, { connected: false }), result('wait'), 'ACTOR_DISCONNECTED'],
    [observation(8, { actorInArena: false }), result('wait'), 'OUTSIDE_ARENA']
  ];
  for (const [after, receipt, code] of cases) {
    assert.equal(verifyCombatAction(observation(7), intent('wait', { durationMs: 100 }), after, receipt).code, code);
  }
});

test('verifies bounded combat goals only from observation and session history', () => {
  const history = [{ proofKinds: ['opponent_health_decreased'] }, { proofKinds: ['opponent_defeated'] }];
  assert.deepEqual(verifyCombatGoal({
    kind: 'defeat_target', actorId: 'fighter-1', targetId: 'opponent-1', minimumActorHealth: 8
  }, observation(12, { actorHealth: 11, targetHealth: 0, targetValid: false }), history), {
    verified: true, proofKinds: ['opponent_defeated', 'actor_health_at_least:8']
  });
  assert.equal(verifyCombatGoal({
    kind: 'defeat_target', actorId: 'fighter-1', targetId: 'opponent-1', minimumActorHealth: 8
  }, observation(12, { actorHealth: 7, targetHealth: 0, targetValid: false }), history).verified, false);
  assert.equal(verifyCombatGoal({
    kind: 'defeat_target', actorId: 'fighter-1', targetId: 'opponent-1', minimumActorHealth: 8
  }, observation(12, { actorHealth: 11, targetHealth: 0, targetValid: false }), []).verified, false);
});

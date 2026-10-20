import assert from 'node:assert/strict';
import test from 'node:test';

import { authorizeCombatIntent } from '../src/llm-combat/policy.mjs';

const intent = (overrides = {}) => ({
  kind: 'normal_attack', actorId: 'fighter-1', targetId: 'opponent-1', observationVersion: 7,
  ...overrides
});

const observation = (overrides = {}) => ({
  observationVersion: 7, actorId: 'fighter-1', targetId: 'opponent-1',
  connected: true, actorHealth: 18, targetHealth: 16, targetValid: true,
  actorInArena: true, targetInArena: true, distance: 3, lineOfSight: true,
  attackCooldown: 'ready', itemCooldown: 'ready', ...overrides
});

const policy = (overrides = {}) => ({
  actorId: 'fighter-1', targetId: 'opponent-1', arenaId: 'arena-1',
  maximumEngagementDistance: 12, disengageAtHealth: 4,
  maximumExchangeMs: 20_000, maximumDecisions: 120, minimumDecisionCadenceMs: 750,
  exchangeStartedAt: 1_000, lastDecisionAt: 1_000, now: 1_750,
  decisionsUsed: 0, sequenceInFlight: false, ...overrides
});

test('authorizes one current in-arena intent for the approved actor and opponent', () => {
  assert.deepEqual(authorizeCombatIntent(intent(), observation(), policy()), {
    authorized: true, code: 'AUTHORIZED'
  });
});

test('prioritizes emergency disengagement at or below the configured health threshold', () => {
  assert.deepEqual(authorizeCombatIntent(intent(), observation({ actorHealth: 4 }), policy()), {
    authorized: false, code: 'EMERGENCY_DISENGAGE'
  });
});

test('rejects stale, mismatched, disconnected, invalid, or out-of-arena observations', () => {
  const cases = [
    [intent({ observationVersion: 6 }), observation(), 'STALE_OBSERVATION'],
    [intent(), observation({ actorId: 'other' }), 'ACTOR_MISMATCH'],
    [intent(), observation({ targetId: 'other' }), 'TARGET_MISMATCH'],
    [intent(), observation({ connected: false }), 'DISCONNECTED'],
    [intent(), observation({ targetValid: false }), 'TARGET_INVALID'],
    [intent(), observation({ actorInArena: false }), 'OUTSIDE_ARENA'],
    [intent(), observation({ targetInArena: false }), 'OUTSIDE_ARENA'],
    [intent(), observation({ distance: 12.1 }), 'TARGET_OUT_OF_RANGE']
  ];
  for (const [candidate, observed, code] of cases) {
    assert.equal(authorizeCombatIntent(candidate, observed, policy()).code, code);
  }
});

test('rejects overlapping, too-fast, expired, and exhausted tactical decisions', () => {
  const cases = [
    [policy({ sequenceInFlight: true }), 'SEQUENCE_IN_FLIGHT'],
    [policy({ now: 1_749 }), 'DECISION_CADENCE'],
    [policy({ now: 21_001 }), 'EXCHANGE_DEADLINE'],
    [policy({ decisionsUsed: 120 }), 'DECISION_LIMIT']
  ];
  for (const [configured, code] of cases) {
    assert.equal(authorizeCombatIntent(intent(), observation(), configured).code, code);
  }
});

test('requires line of sight and a ready cooldown only for relevant intents', () => {
  assert.equal(authorizeCombatIntent(intent(), observation({ lineOfSight: false }), policy()).code, 'NO_LINE_OF_SIGHT');
  assert.equal(authorizeCombatIntent(intent(), observation({ attackCooldown: 'cooling' }), policy()).code, 'ATTACK_COOLDOWN');
  assert.equal(authorizeCombatIntent(
    intent({ kind: 'use_item', itemId: 'golden_apple' }), observation({ itemCooldown: 'cooling' }), policy()
  ).code, 'ITEM_COOLDOWN');
  assert.equal(authorizeCombatIntent(
    intent({ kind: 'strafe_left', durationMs: 300 }), observation({ lineOfSight: false }), policy()
  ).authorized, true);
});

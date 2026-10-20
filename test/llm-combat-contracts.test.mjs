import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMBAT_INTENT_KINDS,
  validateCombatExecutionResult,
  validateCombatIntent,
  validateCombatObservation
} from '../src/llm-combat/contracts.mjs';

const context = (overrides = {}) => ({
  actorId: 'fighter-1', targetId: 'opponent-1', observationVersion: 7,
  itemIds: ['shield', 'golden_apple'], anchorIds: ['arena-home'], ...overrides
});

const base = (kind, extra = {}) => ({
  kind, actorId: 'fighter-1', targetId: 'opponent-1', observationVersion: 7, ...extra
});

test('accepts every bounded tactical intent and freezes detached values', () => {
  const cases = [
    base('approach_target', { durationMs: 400 }),
    base('hold_distance', { durationMs: 400 }),
    base('strafe_left', { durationMs: 400 }),
    base('strafe_right', { durationMs: 400 }),
    base('sprint_attack'), base('normal_attack'), base('critical_attack'),
    base('raise_shield'), base('lower_shield'),
    base('use_item', { itemId: 'golden_apple' }),
    base('select_hotbar_slot', { slot: 8 }),
    base('retreat_to_anchor', { anchorId: 'arena-home', durationMs: 750 }),
    base('wait', { durationMs: 100 })
  ];
  assert.equal(COMBAT_INTENT_KINDS.length, 13);
  for (const source of cases) {
    const validated = validateCombatIntent(source, context());
    assert.deepEqual(validated, source);
    assert.notEqual(validated, source);
    assert.equal(Object.isFrozen(validated), true);
  }
});

test('rejects unknown fields, commands, selectors, coordinates, and mismatched fences', () => {
  const cases = [
    base('strafe_left', { durationMs: 400, command: '/kill @a' }),
    base('strafe_left', { durationMs: 400, x: 1 }),
    base('invented', { durationMs: 400 }),
    { ...base('normal_attack'), actorId: '@a' },
    { ...base('normal_attack'), targetId: 'opponent-2' },
    { ...base('normal_attack'), observationVersion: 6 }
  ];
  for (const value of cases) {
    assert.throws(() => validateCombatIntent(value, context()), { code: 'COMBAT_INTENT_INVALID' });
  }
});

test('enforces duration, hotbar, item, and anchor bounds without clamping', () => {
  for (const durationMs of [0, 751, 1.5, Number.NaN]) {
    assert.throws(() => validateCombatIntent(base('wait', { durationMs }), context()), { code: 'COMBAT_INTENT_INVALID' });
  }
  for (const slot of [-1, 9, 1.5]) {
    assert.throws(() => validateCombatIntent(base('select_hotbar_slot', { slot }), context()), { code: 'COMBAT_INTENT_INVALID' });
  }
  assert.throws(() => validateCombatIntent(base('use_item', { itemId: 'end_crystal' }), context()), { code: 'COMBAT_INTENT_INVALID' });
  assert.throws(() => validateCombatIntent(base('retreat_to_anchor', { anchorId: 'outside', durationMs: 200 }), context()), { code: 'COMBAT_INTENT_INVALID' });
});

function observation(overrides = {}) {
  return {
    schemaVersion: 1, observationVersion: 7, observedAt: '2026-08-29T16:00:00.000Z',
    actorId: 'fighter-1', targetId: 'opponent-1', arenaId: 'arena-1',
    actorPosition: { x: 0, y: 0, z: 0 }, targetPosition: { x: 3.25, y: 0, z: -1 },
    distance: 3.4, lineOfSight: true, actorHealth: 18, targetHealth: 14,
    selectedSlot: 2, heldItemCategory: 'sword', shieldState: 'lowered',
    sprinting: true, onGround: true, recentDamageDirection: 'front',
    targetValid: true, actorInArena: true, targetInArena: true,
    attackCooldown: 'ready', itemCooldown: 'ready', connected: true,
    ...overrides
  };
}

test('validates and deeply freezes one compact combat observation', () => {
  const source = observation();
  const validated = validateCombatObservation(source);
  assert.deepEqual(validated, source);
  assert.notEqual(validated.actorPosition, source.actorPosition);
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.actorPosition), true);
});

test('rejects malformed health, position, state, timestamp, and observation fields', () => {
  const cases = [
    observation({ actorHealth: 21 }), observation({ targetHealth: -1 }),
    observation({ actorPosition: { x: Number.NaN, y: 0, z: 0 } }),
    observation({ shieldState: 'maybe' }), observation({ attackCooldown: 'soon' }),
    observation({ observedAt: 'not-a-date' }), observation({ connected: 'yes' }),
    observation({ rawCommand: 'player Fighter attack' })
  ];
  for (const value of cases) {
    assert.throws(() => validateCombatObservation(value), { code: 'COMBAT_OBSERVATION_INVALID' });
  }
});

test('validates exact bounded execution results and rejects contradictory versions', () => {
  const value = {
    schemaVersion: 1, sequenceId: 'sequence-1', intentKind: 'normal_attack',
    status: 'completed', code: 'COMMANDS_COMPLETED', beforeObservationVersion: 7,
    afterObservationVersion: 8, startedAt: '2026-08-29T16:00:00.000Z',
    finishedAt: '2026-08-29T16:00:00.300Z', commandCount: 1
  };
  assert.deepEqual(validateCombatExecutionResult(value), value);
  assert.throws(() => validateCombatExecutionResult({ ...value, afterObservationVersion: 7 }), { code: 'COMBAT_EXECUTION_INVALID' });
  assert.throws(() => validateCombatExecutionResult({ ...value, commandCount: 9 }), { code: 'COMBAT_EXECUTION_INVALID' });
  assert.throws(() => validateCombatExecutionResult({ ...value, output: 'server text' }), { code: 'COMBAT_EXECUTION_INVALID' });
});

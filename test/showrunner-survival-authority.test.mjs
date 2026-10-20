import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import { createSurvivalAuthority, survivalReservationKey } from '../src/showrunner/survival-authority.mjs';

function identity(overrides = {}) {
  return {
    productionId: 'meadow-production',
    takeId: 'take-7',
    attemptId: 'attempt-2',
    goalId: 'hero-gather-logs',
    actorId: 'hero',
    observationVersion: 41,
    ...overrides
  };
}

function authorityAt(now = 10_000, options = {}) {
  const keys = generateKeyPairSync('ed25519');
  const clock = { now: () => now };
  return {
    keys,
    clock,
    authority: createSurvivalAuthority({ clock, signingKey: keys.privateKey, ...options })
  };
}

function itemPayload(overrides = {}) {
  return {
    entityId: 'drop-11', dropId: 'drop-11', item: 'oak_log', region: 'hero_tree',
    dimension: 'minecraft:overworld', position: { x: 1, y: 64, z: 1 },
    volume: { min: { x: 0, y: 60, z: 0 }, max: { x: 9, y: 80, z: 9 } },
    stack: { item: 'oak_log', count: 1 },
    ...overrides
  };
}

function recipePayload(overrides = {}) {
  return {
    recipe: 'oak_planks', count: 1,
    mark: { id: 'table', dimension: 'minecraft:overworld', position: { x: 8, y: 64, z: 8 }, safeHeadroom: true },
    inputs: [{ item: 'oak_log', count: 1 }], output: { item: 'oak_planks', count: 4 },
    ...overrides
  };
}

test('issues target receipts with a stable path-cost, distance, and coordinate candidate order', () => {
  const { authority } = authorityAt();
  const receipt = authority.issueTargetReceipt({
    ...identity(),
    candidates: [
      { pathCost: 4, distance: 4, x: 6, y: 64, z: 1, dimension: 'minecraft:overworld', block: 'oak_log' },
      { pathCost: 2, distance: 9, x: 9, y: 64, z: 1, dimension: 'minecraft:overworld', block: 'oak_log' },
      { pathCost: 2, distance: 3, x: 8, y: 64, z: 1, dimension: 'minecraft:overworld', block: 'oak_log' },
      { pathCost: 2, distance: 3, x: 1, y: 65, z: 1, dimension: 'minecraft:overworld', block: 'oak_log' },
      { pathCost: 2, distance: 3, x: 1, y: 64, z: 2, dimension: 'minecraft:overworld', block: 'oak_log' }
    ]
  });

  assert.deepEqual(receipt.payload.candidates.map(({ x, y, z }) => [x, y, z]), [
    [1, 64, 2], [1, 65, 1], [8, 64, 1], [9, 64, 1], [6, 64, 1]
  ]);
  assert.deepEqual(receipt.payload.target, receipt.payload.candidates[0]);
  assert.equal(receipt.expiresAt, 15_000);
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.payload.candidates), true);
  assert.deepEqual(Object.keys(authority).sort(), [
    'issueItemReceipt', 'issueRecipeReceipt', 'issueTargetReceipt', 'release', 'reserve', 'snapshotReservations', 'verifyReceipt'
  ]);
});

test('uses the first sorted candidate when a caller supplies a conflicting target', () => {
  const { authority } = authorityAt();
  const receipt = authority.issueTargetReceipt({
    ...identity(),
    payload: { target: { pathCost: 999, distance: 999, x: 99, y: 64, z: 99, dimension: 'minecraft:overworld', block: 'diamond_block' } },
    candidates: [
      { pathCost: 3, distance: 4, x: 4, y: 64, z: 4, dimension: 'minecraft:overworld', block: 'oak_log' },
      { pathCost: 1, distance: 2, x: 2, y: 64, z: 2, dimension: 'minecraft:overworld', block: 'oak_log' }
    ]
  });

  assert.deepEqual(receipt.payload.target, { pathCost: 1, distance: 2, x: 2, y: 64, z: 2, dimension: 'minecraft:overworld', block: 'oak_log' });
});

test('breaks fully tied target candidates by code-unit id independent of input order', () => {
  const { authority } = authorityAt();
  const tied = (id) => ({
    id, pathCost: 1, distance: 1, x: 2, y: 64, z: 2,
    dimension: 'minecraft:overworld', block: 'oak_log'
  });
  const first = authority.issueTargetReceipt({
    ...identity(), candidates: [tied('z-target'), tied('A-target')]
  });
  const second = authority.issueTargetReceipt({
    ...identity({ actorId: 'rival', goalId: 'rival-goal' }), candidates: [tied('A-target'), tied('z-target')]
  });

  assert.equal(first.payload.target.id, 'A-target');
  assert.equal(second.payload.target.id, 'A-target');
});

test('rejects target receipts without integral coordinates, a block, and an explicit dimension', () => {
  const { authority } = authorityAt();
  for (const target of [
    { x: 1, y: 64, z: 1, dimension: 'minecraft:overworld' },
    { x: 1, y: 64, block: 'oak_log', dimension: 'minecraft:overworld' },
    { x: 1.5, y: 64, z: 1, block: 'oak_log', dimension: 'minecraft:overworld' },
    { x: 1, y: 64, z: 1, block: 'oak_log' }
  ]) {
    assert.throws(() => authority.issueTargetReceipt({ ...identity(), payload: { target } }), {
      code: 'TARGET_SCHEMA_INVALID'
    });
  }
});

test('rejects malformed single target candidates before signing', () => {
  const { authority } = authorityAt();
  assert.throws(() => authority.issueTargetReceipt({
    ...identity(),
    candidates: [{ pathCost: 'near', distance: 2, x: 1, y: 64, z: 1, dimension: 'minecraft:overworld', block: 'oak_log' }]
  }), { code: 'TARGET_CANDIDATE_INVALID' });
});

test('verifies Ed25519 signatures and rejects a receipt signed by another authority', () => {
  const { authority } = authorityAt();
  const receipt = authority.issueItemReceipt({ ...identity(), payload: itemPayload() });
  const verified = authority.verifyReceipt(receipt, identity());
  assert.equal(verified.ok, true);
  assert.equal(verified.receipt.signature.algorithm, 'Ed25519');

  const other = authorityAt().authority;
  assert.deepEqual(other.verifyReceipt(receipt, identity()), { ok: false, code: 'RECEIPT_SIGNATURE_INVALID' });
});

test('rejects actor, attempt, and goal bindings that do not match the signed receipt', () => {
  const { authority } = authorityAt();
  const receipt = authority.issueRecipeReceipt({ ...identity(), payload: recipePayload() });

  for (const expected of [
    identity({ actorId: 'rival' }),
    identity({ attemptId: 'attempt-3' }),
    identity({ goalId: 'rival-gather-logs' })
  ]) {
    assert.deepEqual(authority.verifyReceipt(receipt, expected), { ok: false, code: 'RECEIPT_BINDING_MISMATCH' });
  }
});

test('rejects expired receipts and observation versions while retaining acquired reservations until release', () => {
  let now = 10_000;
  const keys = generateKeyPairSync('ed25519');
  const authority = createSurvivalAuthority({ clock: { now: () => now }, signingKey: keys.privateKey, maxReceiptAgeMs: 100 });
  const receipt = authority.issueTargetReceipt({
    ...identity(), payload: { target: { x: 1, y: 64, z: 1, dimension: 'minecraft:overworld', block: 'oak_log' } }
  });

  assert.deepEqual(authority.verifyReceipt(receipt, identity({ observationVersion: 42 })), {
    ok: false, code: 'RECEIPT_OBSERVATION_MISMATCH'
  });
  assert.equal(authority.reserve(receipt, 'hero').ok, true);
  now = 10_100;
  assert.deepEqual(authority.verifyReceipt(receipt, identity()), { ok: false, code: 'RECEIPT_EXPIRED' });
  assert.equal(authority.snapshotReservations().length, 1);
  assert.equal(authority.release(receipt.receiptId, 'settled').ok, true);
  assert.deepEqual(authority.snapshotReservations(), []);
});

test('fences verified target coordinates, dimension, and block exactly', () => {
  const { authority } = authorityAt();
  const receipt = authority.issueTargetReceipt({
    ...identity(), payload: { target: { x: 1, y: 64, z: 1, dimension: 'minecraft:overworld', block: 'oak_log' } }
  });

  assert.equal(authority.verifyReceipt(receipt, {
    ...identity(), target: { x: 1, y: 64, z: 1, dimension: 'minecraft:overworld' }, block: 'oak_log'
  }).ok, true);
  assert.deepEqual(authority.verifyReceipt(receipt, {
    ...identity(), target: { x: 2, y: 64, z: 1, dimension: 'minecraft:overworld' }, block: 'oak_log'
  }), { ok: false, code: 'RECEIPT_TARGET_MISMATCH' });
  assert.deepEqual(authority.verifyReceipt(receipt, {
    ...identity(), target: { x: 1, y: 64, z: 1, dimension: 'minecraft:overworld' }, block: 'stone'
  }), { ok: false, code: 'RECEIPT_TARGET_MISMATCH' });
});

test('defensively clones signed data and detects a post-signing mutation', () => {
  const { authority } = authorityAt();
  const input = { ...identity(), payload: { target: { x: 1, y: 64, z: 1, dimension: 'minecraft:overworld', block: 'oak_log' } } };
  const receipt = authority.issueTargetReceipt(input);
  input.payload.target.x = 999;
  assert.equal(receipt.payload.target.x, 1);

  const tampered = structuredClone(receipt);
  tampered.payload.target.block = 'diamond_block';
  assert.deepEqual(authority.verifyReceipt(tampered, identity()), { ok: false, code: 'RECEIPT_SIGNATURE_INVALID' });
});

test('reserves target keys exclusively, then makes them available on release and cancellation cleanup', () => {
  const { authority } = authorityAt();
  const first = authority.issueTargetReceipt({ ...identity(), payload: { target: { x: 1, y: 64, z: 1, dimension: 'minecraft:overworld', block: 'oak_log' } } });
  const second = authority.issueTargetReceipt({ ...identity({ actorId: 'rival', goalId: 'rival-gather-logs' }), payload: { target: { x: 1, y: 64, z: 1, dimension: 'minecraft:overworld', block: 'oak_log' } } });

  assert.equal(authority.reserve(first, 'hero').ok, true);
  assert.deepEqual(authority.reserve(second, 'rival'), { ok: false, code: 'RESERVATION_CONFLICT' });
  assert.equal(authority.release(first.receiptId, 'cancelled').ok, true);
  assert.equal(authority.snapshotReservations().length, 0);
  assert.equal(authority.reserve(second, 'rival').ok, true);
  assert.equal(authority.release(second.receiptId, 'completed').ok, true);
});

test('returns immutable, defensively cloned reservation snapshots', () => {
  const { authority } = authorityAt();
  const receipt = authority.issueItemReceipt({ ...identity(), payload: itemPayload() });
  authority.reserve(receipt, 'hero');

  const snapshot = authority.snapshotReservations();
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot[0]), true);
  assert.throws(() => snapshot.push({}), TypeError);
  assert.throws(() => { snapshot[0].actorId = 'rival'; }, TypeError);
  assert.equal(authority.snapshotReservations()[0].actorId, 'hero');
});

test('uses one stable reservation key for numeric Mineflayer item entity ids', () => {
  const { authority } = authorityAt();
  const receipt = authority.issueItemReceipt({
    ...identity(), payload: itemPayload({ entityId: 41, dropId: 'drop-41' })
  });

  assert.equal(survivalReservationKey('item', { entityId: 41 }), 'item:41');
  assert.equal(survivalReservationKey('item', receipt.payload), 'item:41');
  assert.equal(authority.reserve(receipt, 'hero').ok, true);
  assert.equal(authority.snapshotReservations()[0].reservationKey, 'item:41');
});

test('rejects receipt lifetimes outside the 100 to 30000 millisecond bound', () => {
  const keys = generateKeyPairSync('ed25519');
  assert.throws(() => createSurvivalAuthority({ clock: { now: () => 0 }, signingKey: keys.privateKey, maxReceiptAgeMs: 99 }), {
    code: 'RECEIPT_AGE_INVALID'
  });
  assert.throws(() => createSurvivalAuthority({ clock: { now: () => 0 }, signingKey: keys.privateKey, maxReceiptAgeMs: 30_001 }), {
    code: 'RECEIPT_AGE_INVALID'
  });
});

test('rejects a clock value that cannot represent a safe receipt expiry', () => {
  const keys = generateKeyPairSync('ed25519');
  const authority = createSurvivalAuthority({
    clock: { now: () => Number.MAX_SAFE_INTEGER }, signingKey: keys.privateKey, maxReceiptAgeMs: 100
  });
  assert.throws(() => authority.issueItemReceipt({ ...identity(), payload: itemPayload() }), {
    code: 'SURVIVAL_CLOCK_INVALID'
  });
});

test('canonicalizes Mineflayer dimension aliases before signing and reservation keying', () => {
  const { authority } = authorityAt();
  const alias = authority.issueTargetReceipt({
    ...identity(),
    payload: { target: { x: 1, y: 64, z: 1, dimension: 'overworld', block: 'oak_log' } }
  });
  const canonical = authority.issueTargetReceipt({
    ...identity({ actorId: 'rival', goalId: 'rival-goal' }),
    payload: { target: { x: 1, y: 64, z: 1, dimension: 'minecraft:overworld', block: 'oak_log' } }
  });

  assert.equal(alias.payload.target.dimension, 'minecraft:overworld');
  assert.equal(authority.reserve(alias, 'hero').ok, true);
  assert.deepEqual(authority.reserve(canonical, 'rival'), { ok: false, code: 'RESERVATION_CONFLICT' });
  assert.throws(() => authority.issueTargetReceipt({
    ...identity({ goalId: 'unknown-dimension' }),
    payload: { target: { x: 2, y: 64, z: 1, dimension: 'moon', block: 'oak_log' } }
  }), { code: 'TARGET_SCHEMA_INVALID' });
});

test('rejects underbound item and recipe receipts before signing', () => {
  const { authority } = authorityAt();
  assert.throws(() => authority.issueItemReceipt({
    ...identity(), payload: { entityId: 41, dropId: 'drop-1', item: 'oak_log', region: 'hero_tree' }
  }), { code: 'ITEM_SCHEMA_INVALID' });
  assert.throws(() => authority.issueRecipeReceipt({
    ...identity(), payload: { recipe: 'oak_planks', count: 1, mark: 'table' }
  }), { code: 'RECIPE_SCHEMA_INVALID' });
  assert.throws(() => authority.issueRecipeReceipt({
    ...identity(), payload: recipePayload({
      recipe: 'wooden_pickaxe',
      inputs: [{ item: 'oak_planks', count: 3 }, { item: 'stick', count: 2 }],
      output: { item: 'wooden_pickaxe', count: 1 },
      table: { x: 9, y: 64, z: 8, dimension: 'minecraft:the_nether', block: 'crafting_table' }
    })
  }), { code: 'RECIPE_SCHEMA_INVALID' });
});

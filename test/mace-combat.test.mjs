import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isMaceBoostActive,
  shouldMaceAttackDuringBoost,
  shouldRaiseShieldForSparring,
  shouldUseWindCharge
} from '../src/mace-combat.mjs';

test('uses wind charge for mace combat at mid range after cooldown', () => {
  assert.equal(shouldUseWindCharge({
    distance: 6,
    now: 5000,
    lastWindChargeAt: 1000,
    mainHandName: 'mace',
    offHandName: 'wind_charge',
    inventoryWindCharges: 0
  }), true);
});

test('does not use wind charge when already point blank', () => {
  assert.equal(shouldUseWindCharge({
    distance: 1.8,
    now: 5000,
    lastWindChargeAt: 1000,
    mainHandName: 'mace',
    offHandName: 'wind_charge',
    inventoryWindCharges: 0
  }), false);
});

test('uses inventory wind charges if off hand is empty', () => {
  assert.equal(shouldUseWindCharge({
    distance: 7,
    now: 5000,
    lastWindChargeAt: 1000,
    mainHandName: 'mace',
    offHandName: null,
    inventoryWindCharges: 16
  }), true);
});

test('does not raise a shield before sparring with a mace', () => {
  assert.equal(shouldRaiseShieldForSparring('mace'), false);
});

test('keeps a short boost window after firing a wind charge', () => {
  assert.equal(isMaceBoostActive({ now: 6200, lastWindChargeAt: 5000 }), true);
  assert.equal(isMaceBoostActive({ now: 7600, lastWindChargeAt: 5000 }), false);
});

test('mace attacks during boost only when close enough', () => {
  assert.equal(shouldMaceAttackDuringBoost({
    distance: 4,
    now: 6200,
    lastWindChargeAt: 5000,
    lastAttackAt: 5200
  }), true);

  assert.equal(shouldMaceAttackDuringBoost({
    distance: 6,
    now: 6200,
    lastWindChargeAt: 5000,
    lastAttackAt: 5200
  }), false);
});

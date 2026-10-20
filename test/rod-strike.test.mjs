import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getForcedRodStrikeMode,
  getRodStrikeModeFromItem,
  isFishingBobberEntity,
  planBedrockTntBeam,
  planGroundTntRing,
  shouldDropRodStrike
} from '../src/rod-strike.mjs';

test('recognizes fishing bobber entities by modern Java name', () => {
  assert.equal(isFishingBobberEntity({ name: 'fishing_bobber' }), true);
  assert.equal(isFishingBobberEntity({ name: 'zombie' }), false);
});

test('recognizes older fishing hook entity names too', () => {
  assert.equal(isFishingBobberEntity({ name: 'fishing_hook' }), true);
  assert.equal(isFishingBobberEntity({ objectType: 'Fishing Hook' }), true);
});

test('drops rod strike only after cooldown', () => {
  assert.equal(shouldDropRodStrike({
    now: 10_000,
    lastDropAt: 4_000,
    cooldownMs: 5_000
  }), true);

  assert.equal(shouldDropRodStrike({
    now: 10_000,
    lastDropAt: 7_000,
    cooldownMs: 5_000
  }), false);
});

test('plans a larger TNT ring on the ground around a target', () => {
  const ring = planGroundTntRing({ x: 10.8, y: 64.2, z: -3.1 }, { count: 8, radius: 18, fuse: 80 });

  assert.equal(ring.length, 8);
  assert.deepEqual(ring[0], { x: 28, y: 64, z: -4, fuse: 80 });
  assert.deepEqual(ring[2], { x: 10, y: 64, z: 14, fuse: 80 });
  assert.deepEqual(ring[4], { x: -8, y: 64, z: -4, fuse: 80 });
  assert.deepEqual(ring[6], { x: 10, y: 64, z: -22, fuse: 80 });
});

test('plans a 4x4 TNT beam down to bedrock', () => {
  const beam = planBedrockTntBeam({ x: 10.8, y: 64.2, z: -3.1 }, { count: 16, fuse: 70, minY: -63 });

  assert.equal(beam.length, 16);
  assert.deepEqual(beam[0], { x: 9, y: 64, z: -5, fuse: 70 });
  assert.deepEqual(beam[1], { x: 9, y: 56, z: -4, fuse: 70 });
  assert.deepEqual(beam[15], { x: 12, y: -63, z: -2, fuse: 70 });
});

test('uses rod custom names to choose circle or stab shot', () => {
  assert.equal(getRodStrikeModeFromItem({ customName: 'circle shot' }), 'circle');
  assert.equal(getRodStrikeModeFromItem({ customName: 'Stab Shot' }), 'beam');
  assert.equal(getRodStrikeModeFromItem({ displayName: 'Fishing Rod' }), 'circle');
});

test('reads modern custom-name component formats from renamed rods', () => {
  assert.equal(getRodStrikeModeFromItem({ customName: { text: 'stab shot' } }), 'beam');
  assert.equal(getRodStrikeModeFromItem({ customName: '{"text":"stab shot"}' }), 'beam');
  assert.equal(getRodStrikeModeFromItem({
    componentMap: new Map([
      ['custom_name', { data: { text: 'stab shot' } }]
    ])
  }), 'beam');
});

test('supports forced rod strike modes for stubborn client item sync', () => {
  assert.equal(getForcedRodStrikeMode('stab'), 'beam');
  assert.equal(getForcedRodStrikeMode('beam'), 'beam');
  assert.equal(getForcedRodStrikeMode('circle'), 'circle');
  assert.equal(getForcedRodStrikeMode('ring'), 'circle');
  assert.equal(getForcedRodStrikeMode('potato'), null);
});

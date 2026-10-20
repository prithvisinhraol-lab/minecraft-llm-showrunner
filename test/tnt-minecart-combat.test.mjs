import test from 'node:test';
import assert from 'node:assert/strict';
import { planTntMinecartLane, shouldFireTntMinecartChain } from '../src/tnt-minecart-combat.mjs';

test('plans an east-west TNT minecart lane toward an x-axis target', () => {
  assert.deepEqual(planTntMinecartLane(
    { x: 0.2, y: 64, z: 0.7 },
    { x: 8.5, y: 64, z: 2.1 }
  ), {
    start: { x: 2, y: 64, z: 0 },
    end: { x: 7, y: 64, z: 0 },
    supportStart: { x: 1, y: 63, z: -1 },
    supportEnd: { x: 8, y: 63, z: 1 },
    railShape: 'east_west',
    motion: [0.75, 0, 0],
    shotTarget: { x: 2.5, y: 64.4, z: 0.5 }
  });
});

test('plans a north-south TNT minecart lane toward a z-axis target', () => {
  assert.deepEqual(planTntMinecartLane(
    { x: 4.9, y: 70, z: 10.2 },
    { x: 3.5, y: 70, z: 1.4 }
  ), {
    start: { x: 4, y: 70, z: 8 },
    end: { x: 4, y: 70, z: 3 },
    supportStart: { x: 3, y: 69, z: 2 },
    supportEnd: { x: 5, y: 69, z: 9 },
    railShape: 'north_south',
    motion: [0, 0, -0.75],
    shotTarget: { x: 4.5, y: 70.4, z: 8.5 }
  });
});

test('fires TNT minecart chain only after cooldown', () => {
  assert.equal(shouldFireTntMinecartChain({
    now: 10_000,
    lastFiredAt: 3_000,
    cooldownMs: 6_000
  }), true);

  assert.equal(shouldFireTntMinecartChain({
    now: 10_000,
    lastFiredAt: 5_000,
    cooldownMs: 6_000
  }), false);
});

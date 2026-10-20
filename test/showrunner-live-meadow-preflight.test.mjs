import assert from 'node:assert/strict';
import test from 'node:test';

import { runLiveMeadowPreflight } from '../src/showrunner/live-meadow-preflight.mjs';

const point = (x, y, z, overrides = {}) => ({
  position: { x, y, z }, dimension: 'minecraft:overworld', support: 'grass_block', feetPassable: true,
  headPassable: true, hazardous: false, reachable: true, ...overrides
});

test('accepts distinct safe marks with trees, excavation cells, and online operator', () => {
  const result = runLiveMeadowPreflight({
    operatorName: 'VPNAJ', onlinePlayers: ['VPNAJ', 'HeroActor', 'RivalActor'],
    camera: point(50, 67, 47), hero: point(42, 71, 50), rival: point(58, 64, 49), crafting: point(52, 65, 50),
    treeTargets: { hero: [{ id: 'h' }], rival: [{ id: 'r' }] },
    excavationCells: { expected: 11, valid: 11 }
  });
  assert.equal(result.ok, true);
  assert.equal(Object.isFrozen(result), true);
});

test('fails closed for offline operator and each unsafe live-world boundary', () => {
  const base = {
    operatorName: 'VPNAJ', onlinePlayers: ['VPNAJ', 'HeroActor', 'RivalActor'],
    camera: point(50, 67, 47), hero: point(42, 71, 50), rival: point(58, 64, 49), crafting: point(52, 65, 50),
    treeTargets: { hero: [{ id: 'h' }], rival: [{ id: 'r' }] }, excavationCells: { expected: 11, valid: 11 }
  };
  const cases = [
    [{ ...base, onlinePlayers: ['HeroActor', 'RivalActor'] }, 'OPERATOR_OFFLINE'],
    [{ ...base, hero: point(42, 71, 50, { support: 'air' }) }, 'UNSAFE_SUPPORT'],
    [{ ...base, rival: point(58, 64, 49, { headPassable: false }) }, 'HEADROOM_BLOCKED'],
    [{ ...base, camera: point(42, 71, 50) }, 'POSITIONS_NOT_DISTINCT'],
    [{ ...base, treeTargets: { hero: [], rival: [{ id: 'r' }] } }, 'TREE_TARGETS_MISSING'],
    [{ ...base, excavationCells: { expected: 11, valid: 10 } }, 'EXCAVATION_INVALID']
  ];
  for (const [input, code] of cases) assert.throws(() => runLiveMeadowPreflight(input), { code });
});

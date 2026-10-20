import assert from 'node:assert/strict';
import test from 'node:test';

import { inspectLiveMeadowPreflight } from '../src/showrunner/live-meadow-production.mjs';

test('preflight inspection derives safe marks and exact bounded resources from live blocks', () => {
  const blocks = new Map([
    ['43,65,43', 'oak_log'], ['57,65,43', 'oak_log'],
    ...[54, 55, 56, 57, 58].flatMap((z) => [[`66,64,${z}`, 'stone'], [`67,64,${z}`, 'stone']]),
    ['66,65,58', 'stone']
  ]);
  const bot = {
    game: { dimension: 'overworld' },
    entity: { position: { x: 48.5, y: 65, z: 48.5 } },
    players: { VPNAJ: { entity: { position: { x: 52.5, y: 65, z: 50.5 } } } },
    blockAt(position) {
      const key = `${position.x},${position.y},${position.z}`;
      const name = blocks.get(key) ?? (position.y === 64 ? 'grass_block' : 'air');
      return { name, boundingBox: name === 'air' ? 'empty' : 'block' };
    }
  };
  const episode = { scene: { marks: {
    hero_start: { position: { x: 48, y: 65, z: 48 } },
    rival_start: { position: { x: 56, y: 65, z: 48 } },
    crafting_table: { position: { x: 52, y: 65, z: 50 } }
  } } };
  const survivalEpisode = {
    regions: {
      hero_tree: { min: { x: 41, y: 65, z: 41 }, max: { x: 45, y: 70, z: 45 }, allowedBlocks: ['oak_log'] },
      rival_tree: { min: { x: 55, y: 65, z: 41 }, max: { x: 59, y: 70, z: 45 }, allowedBlocks: ['oak_log'] },
      hero_mine_lane: { allowedCells: [54, 55, 56, 57, 58].map((z) => ({ x: 66, y: 64, z })) },
      rival_mine_lane: { allowedCells: [...[54, 55, 56, 57, 58].map((z) => ({ x: 67, y: 64, z })), { x: 66, y: 65, z: 58 }] }
    }
  };
  const result = inspectLiveMeadowPreflight({ episode, survivalEpisode, bots: { hero: bot, rival: bot }, operatorName: 'VPNAJ' });
  assert.equal(result.operatorName, 'VPNAJ');
  assert.equal(result.treeTargets.hero.length, 1);
  assert.equal(result.treeTargets.rival.length, 1);
  assert.deepEqual(result.excavationCells, { expected: 11, valid: 11 });
  assert.equal(result.hero.support, 'grass_block');
  assert.equal(result.camera.headPassable, true);
});

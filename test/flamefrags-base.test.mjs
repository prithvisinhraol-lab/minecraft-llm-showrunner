import test from 'node:test'
import assert from 'node:assert/strict'
import { circlePoints, createBaseCommands, chunkCommands } from '../src/flamefrags-base.mjs'
import { createDatapackFiles } from '../scripts/generate-flamefrags-base.mjs'

test('circle points are unique, symmetric, and include cardinal points', () => {
  const points = circlePoints(0, 0, 5)
  const keys = new Set(points.map(({ x, z }) => `${x},${z}`))
  assert.equal(keys.size, points.length)
  for (const key of ['5,0', '-5,0', '0,5', '0,-5']) assert.ok(keys.has(key))
  for (const { x, z } of points) {
    assert.ok(keys.has(`${-x},${z}`))
    assert.ok(keys.has(`${x},${-z}`))
  }
})

test('base fits its footprint and exposes all landmarks', () => {
  const result = createBaseCommands({ x: 0, y: 90, z: 0 })
  assert.deepEqual(Object.keys(result.landmarks).sort(), ['arrival', 'brewing', 'central', 'enchanting', 'utility'])
  assert.ok(result.commands.length > 1000)
  assert.doesNotMatch(result.commands.join('\n'), /NaN/)
  for (const command of result.commands) {
    const match = command.match(/^setblock (-?\d+) -?\d+ (-?\d+) /)
    if (match) {
      assert.ok(Math.abs(Number(match[1])) <= 45, command)
      assert.ok(Math.abs(Number(match[2])) <= 45, command)
    }
  }
})

test('base includes its industrial palette and functional rooms', () => {
  const { commands } = createBaseCommands({ x: 0, y: 90, z: 0 })
  const text = commands.join('\n')
  assert.doesNotMatch(text, /minecraft:cauldron\[level=/)
  for (const block of ['deepslate_tiles', 'polished_blackstone_bricks', 'tuff_bricks', 'iron_bars', 'red_nether_bricks', 'oxidized_copper', 'shroomlight', 'enchanting_table', 'bookshelf', 'brewing_stand', 'barrel', 'crafting_table', 'farmland', 'water']) {
    assert.match(text, new RegExp(`minecraft:${block}`))
  }
})

test('command chunks are bounded and schedule exactly one successor', () => {
  const chunks = chunkCommands(Array.from({ length: 1701 }, (_, i) => `say ${i}`), 800)
  assert.deepEqual(chunks.map(chunk => chunk.length), [801, 801, 102])
  assert.match(chunks[0].at(-1), /part_001 2t$/)
  assert.match(chunks[1].at(-1), /part_002 2t$/)
  assert.doesNotMatch(chunks[2].join('\n'), /part_003/)
})

test('datapack files include start, bounded parts, and safe finish', () => {
  const files = createDatapackFiles({ x: 1200, y: 90, z: 1200 })
  assert.match(files.get('pack.mcmeta'), /"pack_format": 61/)
  assert.match(files.get('data/codex_flamefrags/function/build/start.mcfunction'), /forceload add 1155 1155 1245 1245/)
  assert.match(files.get('data/codex_flamefrags/function/build/start.mcfunction'), /part_000/)
  assert.match(files.get('data/codex_flamefrags/function/build/finish.mcfunction'), /FlameFrags compact base complete/)
  const parts = [...files].filter(([name]) => /part_\d+\.mcfunction$/.test(name))
  assert.ok(parts.length > 1)
  assert.ok(parts.every(([, text]) => text.trim().split('\n').length <= 801))
})

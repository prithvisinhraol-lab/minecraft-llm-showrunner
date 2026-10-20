export function circlePoints(cx, cz, radius) {
  const points = []
  const inner = (radius - 0.55) ** 2
  const outer = (radius + 0.55) ** 2
  for (let x = -radius; x <= radius; x++) {
    for (let z = -radius; z <= radius; z++) {
      const d = x * x + z * z
      if (d >= inner && d <= outer) points.push({ x: cx + x, z: cz + z })
    }
  }
  return [...new Map(points.map(point => [`${point.x},${point.z}`, point])).values()]
}

function diskPoints(cx, cz, radius) {
  const points = []
  for (let x = -radius; x <= radius; x++) {
    for (let z = -radius; z <= radius; z++) {
      if (x * x + z * z <= radius * radius) points.push({ x: cx + x, z: cz + z })
    }
  }
  return points
}

function linePoints(x0, z0, x1, z1) {
  const points = []
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0))
  if (steps === 0) return [{ x: x0, z: z0 }]
  for (let i = 0; i <= steps; i++) {
    points.push({
      x: Math.round(x0 + (x1 - x0) * i / steps),
      z: Math.round(z0 + (z1 - z0) * i / steps),
    })
  }
  return [...new Map(points.map(point => [`${point.x},${point.z}`, point])).values()]
}

export function createBaseCommands(origin) {
  const blocks = new Map()
  const set = (x, y, z, block) => blocks.set(`${x},${y},${z}`, `setblock ${x} ${y} ${z} minecraft:${block}`)
  const local = (x, y, z, block) => set(origin.x + x, origin.y + y, origin.z + z, block)
  const commands = [
    `fill ${origin.x - 45} ${origin.y} ${origin.z - 45} ${origin.x} ${origin.y + 38} ${origin.z} air`,
    `fill ${origin.x + 1} ${origin.y} ${origin.z - 45} ${origin.x + 45} ${origin.y + 38} ${origin.z} air`,
    `fill ${origin.x - 45} ${origin.y} ${origin.z + 1} ${origin.x} ${origin.y + 38} ${origin.z + 45} air`,
    `fill ${origin.x + 1} ${origin.y} ${origin.z + 1} ${origin.x + 45} ${origin.y + 38} ${origin.z + 45} air`,
  ]

  const towers = [
    { name: 'central', x: 0, z: 0, r: 18, h: 27 },
    { name: 'enchanting', x: -30, z: -22, r: 12, h: 18 },
    { name: 'brewing', x: 30, z: -22, r: 12, h: 18 },
    { name: 'utility', x: 0, z: 30, r: 12, h: 18 },
  ]

  for (const tower of towers) {
    for (const p of diskPoints(tower.x, tower.z, tower.r + 1)) local(p.x, -1, p.z, 'polished_blackstone_bricks')
    for (const p of diskPoints(tower.x, tower.z, tower.r)) local(p.x, 0, p.z, 'deepslate_tiles')
    for (let y = 1; y < tower.h; y++) {
      const wallBlock = y % 7 === 0 ? 'red_nether_bricks' : y % 4 === 0 ? 'tuff_bricks' : 'polished_blackstone_bricks'
      for (const p of circlePoints(tower.x, tower.z, tower.r)) local(p.x, y, p.z, wallBlock)
    }
    for (let y = 1; y < tower.h + 4; y++) {
      for (const [dx, dz] of [[tower.r, 0], [-tower.r, 0], [0, tower.r], [0, -tower.r]]) {
        local(tower.x + dx, y, tower.z + dz, y % 5 === 0 ? 'shroomlight' : 'tuff_bricks')
      }
    }
    for (const p of diskPoints(tower.x, tower.z, tower.r + 1)) local(p.x, tower.h, p.z, 'deepslate_tiles')
    for (const p of circlePoints(tower.x, tower.z, tower.r + 2)) local(p.x, tower.h + 1, p.z, 'polished_blackstone_bricks')
    for (const p of circlePoints(tower.x, tower.z, tower.r - 3)) local(p.x, tower.h + 2, p.z, 'oxidized_copper')
    for (const p of circlePoints(tower.x, tower.z, tower.r - 5)) local(p.x, tower.h + 3, p.z, 'deepslate_tile_slab[type=top]')
    for (let a = -2; a <= 2; a++) {
      local(tower.x + a, 8, tower.z - tower.r, 'orange_stained_glass')
      local(tower.x + a, 9, tower.z - tower.r, 'iron_bars')
    }
  }

  for (const target of towers.slice(1)) {
    const startScale = 18 / Math.hypot(target.x, target.z)
    const endScale = (Math.hypot(target.x, target.z) - 12) / Math.hypot(target.x, target.z)
    const start = { x: Math.round(target.x * startScale), z: Math.round(target.z * startScale) }
    const end = { x: Math.round(target.x * endScale), z: Math.round(target.z * endScale) }
    for (const p of linePoints(start.x, start.z, end.x, end.z)) {
      const horizontal = Math.abs(target.x) >= Math.abs(target.z)
      for (let w = -2; w <= 2; w++) local(p.x + (horizontal ? 0 : w), 10, p.z + (horizontal ? w : 0), 'deepslate_tiles')
      local(p.x + (horizontal ? 0 : -3), 11, p.z + (horizontal ? -3 : 0), 'iron_bars')
      local(p.x + (horizontal ? 0 : 3), 11, p.z + (horizontal ? 3 : 0), 'iron_bars')
    }
  }

  // Central storage and workshop.
  for (const [x, z] of [[-5, -3], [-5, 0], [-5, 3], [5, -3], [5, 0], [5, 3]]) local(x, 1, z, 'barrel')
  local(0, 1, 2, 'crafting_table')
  local(2, 1, 2, 'smithing_table')
  local(-2, 1, 2, 'stonecutter')
  local(0, 1, -3, 'shroomlight')

  // Enchanting satellite with fifteen bookshelves.
  local(-30, 1, -22, 'enchanting_table')
  const shelfOffsets = [[-3,-3],[-2,-3],[-1,-3],[0,-3],[1,-3],[2,-3],[3,-3],[-3,-2],[3,-2],[-3,-1],[3,-1],[-3,0],[3,0],[-3,1],[3,1]]
  for (const [dx, dz] of shelfOffsets) local(-30 + dx, 1, -22 + dz, 'bookshelf')

  // Brewing satellite.
  for (const x of [27, 30, 33]) local(x, 1, -22, 'brewing_stand')
  for (const x of [27, 30, 33]) local(x, 1, -25, 'barrel')
  local(30, 1, -18, 'water_cauldron[level=3]')

  // Enclosed utility crop plot.
  for (let x = -5; x <= 5; x++) for (let z = 29; z <= 35; z++) local(x, 0, z, x === 0 ? 'water' : 'farmland[moisture=7]')
  for (let x = -5; x <= 5; x++) for (let z = 29; z <= 35; z++) if (x !== 0) local(x, 1, z, (x + z) % 2 ? 'wheat[age=7]' : 'carrots[age=7]')

  // Safe south entrance and industrial arch.
  for (let z = -28; z <= -18; z++) for (let x = -3; x <= 3; x++) local(x, 0, z, 'deepslate_tiles')
  for (let z = -28; z <= -18; z++) { local(-4, 1, z, 'polished_blackstone_brick_wall'); local(4, 1, z, 'polished_blackstone_brick_wall') }
  local(-4, 2, -18, 'shroomlight'); local(4, 2, -18, 'shroomlight')

  commands.push(...blocks.values())
  return {
    commands,
    landmarks: {
      arrival: { x: origin.x + 0.5, y: origin.y + 1, z: origin.z - 24.5 },
      central: { x: origin.x, y: origin.y + 1, z: origin.z },
      enchanting: { x: origin.x - 30, y: origin.y + 1, z: origin.z - 22 },
      brewing: { x: origin.x + 30, y: origin.y + 1, z: origin.z - 22 },
      utility: { x: origin.x, y: origin.y + 1, z: origin.z + 30 },
    },
  }
}

export function chunkCommands(commands, size = 800) {
  const chunks = []
  for (let i = 0; i < commands.length; i += size) chunks.push(commands.slice(i, i + size))
  return chunks.map((chunk, index) => index + 1 < chunks.length
    ? [...chunk, `schedule function codex_flamefrags:build/part_${String(index + 1).padStart(3, '0')} 2t`]
    : [...chunk, 'schedule function codex_flamefrags:build/finish 2t'])
}

import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { chunkCommands, createBaseCommands } from '../src/flamefrags-base.mjs'

export function createDatapackFiles(origin) {
  const { commands, landmarks } = createBaseCommands(origin)
  const chunks = chunkCommands(commands, 800)
  const files = new Map()
  files.set('pack.mcmeta', `${JSON.stringify({ pack: { pack_format: 61, description: 'Compact FlameFrags industrial base replica' } }, null, 2)}\n`)
  files.set('data/codex_flamefrags/function/build/start.mcfunction', [
    `forceload add ${origin.x - 45} ${origin.z - 45} ${origin.x + 45} ${origin.z + 45}`,
    'say Building the compact FlameFrags base. Please wait...',
    'function codex_flamefrags:build/part_000',
  ].join('\n') + '\n')
  chunks.forEach((chunk, index) => files.set(
    `data/codex_flamefrags/function/build/part_${String(index).padStart(3, '0')}.mcfunction`,
    `${chunk.join('\n')}\n`,
  ))
  files.set('data/codex_flamefrags/function/build/finish.mcfunction', [
    `say FlameFrags compact base complete at ${origin.x} ${origin.y} ${origin.z}.`,
    `setworldspawn ${Math.floor(landmarks.arrival.x)} ${landmarks.arrival.y} ${Math.floor(landmarks.arrival.z)}`,
  ].join('\n') + '\n')
  return files
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]])
    return pairs
  }, []))
  const origin = { x: Number(args.x ?? 1200), y: Number(args.y ?? 90), z: Number(args.z ?? 1200) }
  if (Object.values(origin).some(value => !Number.isInteger(value))) throw new Error('Origin coordinates must be integers')
  const root = path.resolve('server/world-1.21.4/datapacks/codex_flamefrags_base')
  const files = createDatapackFiles(origin)
  for (const [relative, contents] of files) {
    const destination = path.join(root, relative)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.writeFile(destination, contents)
  }
  const functionDir = path.join(root, 'data/codex_flamefrags/function/build')
  const expected = new Set([...files.keys()].map(name => path.basename(name)))
  for (const entry of await fs.readdir(functionDir)) {
    if (/^part_\d+\.mcfunction$/.test(entry) && !expected.has(entry)) await fs.unlink(path.join(functionDir, entry))
  }
  const partCount = [...files.keys()].filter(name => /part_\d+\.mcfunction$/.test(name)).length
  console.log(`Generated compact FlameFrags base at ${origin.x} ${origin.y} ${origin.z}: ${partCount} staged parts`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()

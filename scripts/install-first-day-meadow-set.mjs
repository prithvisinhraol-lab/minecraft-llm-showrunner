import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createLiveMeadowSetCommands } from '../src/showrunner/live-meadow-set.mjs';

export function createMeadowDatapackFiles() {
  const commands = createLiveMeadowSetCommands().map((command) => `execute in minecraft:overworld run ${command}`);
  const files = new Map();
  files.set('pack.mcmeta', `${JSON.stringify({ pack: { pack_format: 61, description: 'Bounded first-day meadow test set' } }, null, 2)}\n`);
  files.set('data/codex_meadow/function/build.mcfunction', [
    'execute in minecraft:overworld run forceload add 40 40 67 58',
    ...commands,
    'execute in minecraft:overworld run forceload remove 40 40 67 58',
    'say First-day meadow set prepared; waiting for VPNAJ begin.'
  ].join('\n') + '\n');
  return files;
}

async function main() {
  const root = path.resolve('server/world-1.21.4/datapacks/codex_meadow');
  for (const [relative, contents] of createMeadowDatapackFiles()) {
    const destination = path.join(root, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, contents);
  }
  console.log(`Installed bounded meadow datapack at ${root}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

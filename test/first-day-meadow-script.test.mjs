import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { loadEpisode } from '../src/showrunner/schema.mjs';

const scriptPath = new URL('../production/scripts/first-day-meadow.md', import.meta.url);
const episodePath = fileURLToPath(new URL('../production/episodes/first-day-meadow.yaml', import.meta.url));

test('first-day meadow script contains six complete production beats', async () => {
  const script = await readFile(scriptPath, 'utf8');
  const beats = script.split(/^## Beat \d+ — /m).slice(1);

  assert.equal(beats.length, 6);
  assert.deepEqual(
    [...script.matchAll(/^## Beat \d+ — (.+)$/gm)].map((match) => match[1]),
    ['Arrival', 'First Priorities', 'Two Trees', 'Crafting', 'Breaking Ground', 'Hook']
  );

  for (const beat of beats) {
    for (const label of ['**Camera**', '**Practical action**', '**Energetic action**', '**Dialogue**', '**Complete when**', '**Recovery**']) {
      assert.ok(beat.includes(label), `missing ${label}`);
    }
  }
});

test('dialogue and action cues cover the required first-day progression', async () => {
  const script = await readFile(scriptPath, 'utf8');

  for (const required of [
    'nearest_reachable_oak_log',
    'inventory oak_log >= 3',
    'craft oak_planks',
    'place crafting_table',
    'craft wooden_pickaxe',
    'Practical inventory cobblestone >= 6',
    'Energetic inventory cobblestone >= 5',
    'prepare -> execute -> observe -> confirm'
  ]) assert.match(script, new RegExp(required));

  assert.match(script, /Current runtime boundary/);
  assert.doesNotMatch(script, /\b(?:TBD|TODO|PLACEHOLDER)\b/);
});

test('dialogue-first crafting and excavation are actor-scoped while the hook stays empty', async () => {
  const script = await readFile(scriptPath, 'utf8');
  const beats = script.split(/^## Beat \d+ — /m).slice(1);

  assert.match(beats[1], /No Survival action begins in this beat/);
  assert.match(beats[2], /After the dialogue completes/);
  assert.match(beats[3], /Practical action.*craft wooden_pickaxe.*equip.*own inventory/s);
  assert.match(beats[3], /Energetic action.*craft wooden_pickaxe.*equip.*own inventory/s);
  assert.match(beats[3], /place crafting_table/);
  assert.match(beats[4], /excavate only approved stone cells/i);
  assert.match(beats[4], /Practical inventory cobblestone >= 6/);
  assert.match(beats[4], /Energetic inventory cobblestone >= 5/);
  assert.match(beats[5], /coal or an animal/);
  assert.match(beats[5], /shelter/);
  assert.match(beats[5], /No Survival goal executes in this beat/);
});

test('shooting-script cue ids and all twelve fixed lines match the executable six-beat episode', async () => {
  const script = await readFile(scriptPath, 'utf8');
  const episode = await loadEpisode(episodePath);
  const scriptLines = [...script.matchAll(/^- (Practical|Energetic): “(.+)”$/gm)].map(([, role, text]) => ({
    speaker: role === 'Practical' ? 'hero' : 'rival',
    text
  }));
  const executableLines = episode.scene.cues.flatMap(({ dialogue }) => dialogue.map(({ speaker, fallbackLine: text }) => ({
    speaker,
    text
  })));

  assert.deepEqual(
    [...script.matchAll(/^\*\*Cue ID\*\*: `([^`]+)`$/gm)].map((match) => match[1]),
    episode.scene.cues.map(({ id }) => id)
  );
  assert.equal(episode.scene.cues.every(({ dialogue }) => dialogue.length === 2), true);
  assert.equal(executableLines.length, 12);
  assert.deepEqual(executableLines, scriptLines);
});

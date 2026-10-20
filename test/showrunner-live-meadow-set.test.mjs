import assert from 'node:assert/strict';
import test from 'node:test';

import { createLiveMeadowSetCommands } from '../src/showrunner/live-meadow-set.mjs';
import { createMeadowDatapackFiles } from '../scripts/install-first-day-meadow-set.mjs';

test('builds the exact bounded meadow resources without starting the scene', () => {
  const commands = createLiveMeadowSetCommands();
  const text = commands.join('\n');
  assert.match(text, /fill 40 64 40 67 64 58 minecraft:grass_block/);
  assert.equal(commands.filter((line) => /setblock (66|67) 64 (54|55|56|57|58) minecraft:stone/.test(line)).length, 10);
  assert.equal(commands.filter((line) => line === 'setblock 66 65 58 minecraft:stone').length, 1);
  assert.equal(commands.filter((line) => /setblock (43|57) (65|66|67|68) 43 minecraft:oak_log/.test(line)).length, 8);
  assert.equal(commands.filter((line) => line.startsWith('summon ')).length >= 4, true);
  assert.equal(commands.some((line) => /\b(say|tellraw)\b.*(New world|flowers|pickaxes|Coal already)/.test(line)), false);
  assert.equal(commands.some((line) => /function .*begin|startTake|bot /.test(line)), false);
  assert.equal(commands.some((line) => line === 'tp HeroActor 48.5 65 48.5 0 0'), true);
  assert.equal(commands.some((line) => line === 'tp RivalActor 56.5 65 48.5 0 0'), true);
});

test('installs one explicit overworld build function', () => {
  const files = createMeadowDatapackFiles();
  assert.ok(files.has('pack.mcmeta'));
  const build = files.get('data/codex_meadow/function/build.mcfunction');
  assert.match(build, /^execute in minecraft:overworld run forceload add 40 40 67 58/m);
  assert.match(build, /execute in minecraft:overworld run fill 40 65 40 67 79 58 minecraft:air/);
  assert.doesNotMatch(build, /save-all/);
});

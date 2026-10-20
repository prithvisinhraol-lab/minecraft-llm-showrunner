import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBotMessages } from '../src/command-parser.mjs';

test('parses comma-separated bot cannon commands as separate commands', () => {
  assert.deepEqual(parseBotMessages('bot cannon build, bot cannon target, bot cannon safe'), [
    { command: 'cannon', args: ['build'] },
    { command: 'cannon', args: ['target'] },
    { command: 'cannon', args: ['safe'] }
  ]);
});

test('parses pasted bot commands with no separator before the next bot command', () => {
  assert.deepEqual(parseBotMessages('bot cannon buildbot cannon targetbot cannon safe'), [
    { command: 'cannon', args: ['build'] },
    { command: 'cannon', args: ['target'] },
    { command: 'cannon', args: ['safe'] }
  ]);
});

test('parses regular single bot commands', () => {
  assert.deepEqual(parseBotMessages('bot come'), [
    { command: 'come', args: [] }
  ]);
});

test('ignores non-bot chat', () => {
  assert.deepEqual(parseBotMessages('hello bot come'), []);
});

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createServerSpeechObserver, subscribePlayerChat } from '../src/showrunner/server-speech-observer.mjs';

test('extracts unsigned player chat from formatted server messages', () => {
  const bot = new EventEmitter();
  const seen = [];
  const unsubscribe = subscribePlayerChat(bot, (username, message) => seen.push([username, message]));
  bot.emit('messagestr', '<VPNAJ> begin');
  bot.emit('messagestr', '[Server] begin');
  assert.deepEqual(seen, [['VPNAJ', 'begin']]);
  unsubscribe();
  bot.emit('messagestr', '<VPNAJ> begin');
  assert.equal(seen.length, 1);
});

test('speech completion waits for matching server-observed actor chat', async () => {
  const hero = new EventEmitter();
  const rival = new EventEmitter();
  const observer = createServerSpeechObserver({
    bots: [hero, rival], actorNames: { hero: 'HeroActor', rival: 'RivalActor' }, timeoutMs: 1_000,
    sleep: async () => {}
  });
  const pending = observer.observe({ actorId: 'hero', command: { cueId: 'arrival' }, text: 'New world.' });
  rival.emit('chat', 'RivalActor', 'New world.');
  hero.emit('chat', 'HeroActor', 'New world.');
  assert.deepEqual(await pending, {
    authoritative: true, observed: true, speaker: 'hero', cueId: 'arrival', text: 'New world.'
  });
  observer.close();
});

test('speech completion holds for a readable production pace after server observation', async () => {
  const hero = new EventEmitter();
  const waits = [];
  const observer = createServerSpeechObserver({
    bots: [hero], actorNames: { hero: 'HeroActor' }, timeoutMs: 1_000,
    sleep: async (milliseconds) => waits.push(milliseconds)
  });
  const pending = observer.observe({
    actorId: 'hero', command: { cueId: 'arrival' },
    text: 'New world. Same sunset. Let us start with wood.'
  });
  hero.emit('chat', 'HeroActor', 'New world. Same sunset. Let us start with wood.');
  await pending;
  assert.deepEqual(waits, [2_520]);
  observer.close();
});

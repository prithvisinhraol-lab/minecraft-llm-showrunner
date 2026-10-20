import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createLiveActorHost } from '../src/showrunner/live-actor-host.mjs';

function fakeBot(username) {
  const bot = new EventEmitter();
  bot.username = username;
  bot.players = { VPNAJ: { username: 'VPNAJ' } };
  bot.quitCalls = 0;
  bot.respawnCalls = 0;
  bot.quit = () => { bot.quitCalls += 1; };
  bot.respawn = () => { bot.respawnCalls += 1; };
  return bot;
}

test('owns exactly two named actors and becomes ready only after both spawn', async () => {
  const bots = [];
  const host = createLiveActorHost({
    actorNames: { hero: 'HeroActor', rival: 'RivalActor' },
    botFactory(config) { const bot = fakeBot(config.username); bots.push(bot); return bot; },
    runtimeFactory(bot, actorId) { return { name: actorId, bot, async cancel() {}, async awaitQuiescence() {}, close() {} }; }
  });
  const connecting = host.connect();
  bots[0].emit('spawn');
  assert.equal(host.status().ready, false);
  bots[1].emit('spawn');
  await connecting;
  assert.equal(host.status().ready, true);
  assert.deepEqual(host.onlinePlayers(), ['VPNAJ']);
  assert.deepEqual(Object.keys(host.actors), ['hero', 'rival']);
  host.close();
  assert.equal(bots.every((bot) => bot.quitCalls === 1), true);
});

test('fails closed on duplicate names and actor disconnect', async () => {
  assert.throws(() => createLiveActorHost({ actorNames: { hero: 'Same', rival: 'Same' }, botFactory() {}, runtimeFactory() {} }),
    { code: 'LIVE_ACTOR_NAMES_INVALID' });
  const failures = [];
  const bots = [];
  const host = createLiveActorHost({
    actorNames: { hero: 'HeroActor', rival: 'RivalActor' }, onFailure: (error) => failures.push(error.code),
    botFactory(config) { const bot = fakeBot(config.username); bots.push(bot); return bot; },
    runtimeFactory() { return { async cancel() {}, async awaitQuiescence() {}, close() {} }; }
  });
  const connecting = host.connect();
  bots.forEach((bot) => bot.emit('spawn'));
  await connecting;
  bots[0].emit('end', 'lost');
  assert.deepEqual(failures, ['LIVE_ACTOR_DISCONNECTED']);
  bots[1].emit('death');
  assert.deepEqual(failures, ['LIVE_ACTOR_DISCONNECTED', 'LIVE_ACTOR_DIED']);
  host.close();
});

test('recovers a stored death only during initial connection', async () => {
  const failures = [];
  const bots = [];
  const host = createLiveActorHost({
    actorNames: { hero: 'HeroActor', rival: 'RivalActor' }, onFailure: (error) => failures.push(error.code),
    botFactory(config) { const bot = fakeBot(config.username); bots.push(bot); return bot; },
    runtimeFactory() { return { async cancel() {}, async awaitQuiescence() {}, close() {} }; }
  });
  const connecting = host.connect();
  bots[0].emit('death');
  assert.equal(bots[0].respawnCalls, 1);
  assert.deepEqual(failures, []);
  bots.forEach((bot) => bot.emit('spawn'));
  await connecting;
  bots[0].emit('death');
  assert.deepEqual(failures, ['LIVE_ACTOR_DIED']);
  host.close();
});

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createSurvivalDemoMinecraftAdapter } from '../src/llm-agent/survival-demo-minecraft-adapter.mjs';

class FakeBot extends EventEmitter {
  constructor() {
    super();
    this.health = 20;
    this.player = { username: 'LlmAgent' };
    this.heldItem = null;
    this.inventory = { items: () => [] };
    this.pathfinder = { stopCalls: 0, stop: () => { this.pathfinder.stopCalls += 1; } };
  }
}

test('records only trusted executor facts and fences every observation', async () => {
  const bot = new FakeBot();
  bot.inventory.items = () => [{ name: 'oak_log', count: 3 }];
  const calls = [];
  const adapter = createSurvivalDemoMinecraftAdapter({
    bot,
    actorId: 'LlmAgent',
    macroExecutor: async (request) => {
      calls.push(request);
      return { action: 'gather_wood', brokenOakLogs: 3 };
    }
  });

  const before = await adapter.observe();
  await adapter.execute({ action: 'gather_wood', observationVersion: before.observationVersion });
  const after = await adapter.observe();

  assert.deepEqual(calls, [{ action: 'gather_wood' }]);
  assert.equal(after.observationVersion, before.observationVersion + 1);
  assert.equal(after.inventory.oak_log, 3);
  assert.equal(after.runFacts.brokenOakLogs, 3);
  assert.equal(after.runFacts.minedStone, 0);
});

test('rejects stale requests and untrusted executor receipts', async () => {
  const bot = new FakeBot();
  const adapter = createSurvivalDemoMinecraftAdapter({
    bot, actorId: 'LlmAgent', macroExecutor: async () => ({ action: 'mine_stone', minedStone: 8 })
  });
  const observation = await adapter.observe();

  await assert.rejects(adapter.execute({ action: 'gather_wood', observationVersion: observation.observationVersion }), {
    code: 'SURVIVAL_DEMO_EXECUTION_PROOF_INVALID'
  });
  await assert.rejects(adapter.execute({ action: 'gather_wood', observationVersion: observation.observationVersion - 1 }), {
    code: 'SURVIVAL_DEMO_OBSERVATION_STALE'
  });
});

test('observes exact actor chat and cancellation stops movement', async () => {
  const bot = new FakeBot();
  const adapter = createSurvivalDemoMinecraftAdapter({
    bot, actorId: 'LlmAgent', macroExecutor: async ({ action }) => ({ action, spoken: true })
  });
  const before = await adapter.observe();
  bot.emit('chat', 'SomeoneElse', 'This is gonna be great!!!');
  bot.emit('chat', 'LlmAgent', 'This is gonna be great!!!');
  await adapter.execute({ action: 'say_final_line', observationVersion: before.observationVersion, line: 'This is gonna be great!!!' });
  const after = await adapter.observe();
  await adapter.cancel('test stop');

  assert.deepEqual(after.observedChat, [
    { username: 'SomeoneElse', message: 'This is gonna be great!!!' },
    { username: 'LlmAgent', message: 'This is gonna be great!!!' }
  ]);
  assert.equal(bot.pathfinder.stopCalls, 1);
});

test('waits for the server echo of the final actor line before execution completes', async () => {
  const bot = new FakeBot();
  const adapter = createSurvivalDemoMinecraftAdapter({
    bot,
    actorId: 'LlmAgent',
    macroExecutor: async ({ action }) => {
      setTimeout(() => bot.emit('chat', 'LlmAgent', 'This is gonna be great!!!'), 10);
      return { action, spoken: true };
    }
  });
  const before = await adapter.observe();

  await adapter.execute({
    action: 'say_final_line',
    observationVersion: before.observationVersion,
    line: 'This is gonna be great!!!'
  });

  const after = await adapter.observe();
  assert.equal(after.observedChat.some((entry) => (
    entry.username === 'LlmAgent' && entry.message === 'This is gonna be great!!!'
  )), true);
});

test('cancellation also stops the owned macro executor', async () => {
  const bot = new FakeBot();
  let cancelled = 0;
  const adapter = createSurvivalDemoMinecraftAdapter({
    bot,
    actorId: 'LlmAgent',
    macroExecutor: {
      execute: async ({ action }) => ({ action, spoken: true }),
      async cancel() { cancelled += 1; }
    }
  });

  await adapter.cancel('operator stop');
  assert.equal(cancelled, 1);
  assert.equal(bot.pathfinder.stopCalls, 1);
});

test('close removes the owned chat listener and cancellation is idempotent', async () => {
  const bot = new FakeBot();
  let cancelled = 0;
  const adapter = createSurvivalDemoMinecraftAdapter({
    bot, actorId: 'LlmAgent',
    macroExecutor: { execute: async () => ({}), async cancel() { cancelled += 1; } }
  });
  assert.equal(bot.listenerCount('chat'), 1);
  await adapter.cancel('first');
  await adapter.cancel('second');
  await adapter.close();
  await adapter.close();
  assert.equal(cancelled, 1);
  assert.equal(bot.pathfinder.stopCalls, 1);
  assert.equal(bot.listenerCount('chat'), 0);
});

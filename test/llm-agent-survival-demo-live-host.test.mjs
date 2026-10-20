import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createSurvivalDemoLiveHost } from '../src/llm-agent/survival-demo-live-host.mjs';

function harness() {
  const calls = [];
  let bot;
  let finish;
  const runnerResult = new Promise((resolve) => { finish = resolve; });
  return {
    calls, finish,
    spawn() {
      bot.player = { username: 'LlmAgent' };
      bot.entity = { position: { x: 52.5, y: 66, z: 48.5 } };
      bot.emit('spawn');
    },
    options: {
      actorId: 'LlmAgent', connection: { host: '127.0.0.1', port: 25565, version: '1.21.4' },
      stateDirectory: 'runtime/survival-demo-state', codexBin: '/codex',
      clearingStart: { x: 52.5, y: 66, z: 48.5 },
      botFactory(config) {
        calls.push(['bot', config]);
        bot = new EventEmitter();
        bot.loadPlugin = (plugin) => calls.push(['plugin', plugin]);
        bot.pathfinder = { stop() {} };
        bot.quit = (reason) => { calls.push(['quit', reason]); bot.emit('end', reason); };
        return bot;
      },
      pathfinderPlugin() {}, goals: { GoalNear: class {} }, Movements: class {},
      providerFactory(options) { calls.push(['provider', options]); return { decide() {} }; },
      storeFactory(options) { calls.push(['store', options]); return {}; },
      villageObserverFactory() { return async () => ({ bell: false, beds: 0, villagers: 0 }); },
      macroExecutorFactory() { return { execute() {}, cancel() {} }; },
      adapterFactory() { return { observe() {}, execute() {}, cancel() {}, close() { calls.push(['adapter-close']); } }; },
      runnerFactory() { return { start: () => runnerResult, stop: async (reason) => calls.push(['runner-stop', reason]) }; },
      placeActor: async (_bot, position) => calls.push(['place', position]),
      spawnTimeoutMs: 1_000
    }
  };
}

test('constructing is actor-free; start connects, places, runs, and cleans up', async () => {
  const setup = harness();
  const host = createSurvivalDemoLiveHost(setup.options);
  assert.deepEqual(setup.calls, []);
  const completion = host.start();
  assert.equal(setup.calls.filter(([kind]) => kind === 'bot').length, 1);
  setup.spawn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(setup.calls.find(([kind]) => kind === 'place')[1], setup.options.clearingStart);
  setup.finish({ status: 'succeeded' });
  assert.deepEqual(await completion, { status: 'succeeded' });
  assert.equal(setup.calls.filter(([kind]) => kind === 'quit').length, 1);
  assert.equal(setup.calls.filter(([kind]) => kind === 'adapter-close').length, 1);
});

test('stop is idempotent and closes a spawned actor', async () => {
  const setup = harness();
  const host = createSurvivalDemoLiveHost(setup.options);
  host.start();
  setup.spawn();
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.all([host.stop('operator stop'), host.stop('operator stop')]);
  setup.finish({ status: 'stopped' });
  await host.close();
  assert.equal(setup.calls.filter(([kind]) => kind === 'runner-stop').length, 1);
  assert.equal(setup.calls.filter(([kind]) => kind === 'quit').length, 1);
});

test('close during connection aborts the pending spawn and cannot launch a runner', async () => {
  const setup = harness();
  const host = createSurvivalDemoLiveHost(setup.options);
  host.start();
  await host.close();
  await assert.rejects(host.completion, { code: 'SURVIVAL_DEMO_DISCONNECTED' });
  assert.equal(setup.calls.filter(([kind]) => kind === 'quit').length, 1);
  assert.equal(setup.calls.some(([kind]) => kind === 'place'), false);
});

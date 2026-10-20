import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { FIRST_GOAL_OBJECTIVE } from '../src/llm-agent/contracts.mjs';
import { startLlmAgentCli } from '../src/llm-agent/cli.mjs';
import { createLlmAgentLiveHost } from '../src/llm-agent/live-host.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

class FakeBot extends EventEmitter {
  constructor(order = []) {
    super();
    this.order = order;
    this.messages = [];
    this.loadedPlugins = [];
    this.pathfinder = { stop: () => this.order.push('pathfinder.stop') };
  }

  loadPlugin(plugin) {
    this.loadedPlugins.push(plugin);
  }

  chat(message) {
    this.messages.push(message);
  }

  quit(reason) {
    this.order.push(`bot.quit:${reason}`);
  }

  async emitAsync(event, ...args) {
    await Promise.all(this.listeners(event).map((listener) => listener(...args)));
  }
}

function controllerDouble(overrides = {}) {
  const calls = [];
  const state = {
    lifecycle: { status: 'running' },
    trusted: { phase: 'deciding', milestones: ['oak_log_collected'], recentActionResults: [{ code: 'OAK_LOG_COLLECTED' }] },
    limits: { turnsUsed: 2, maxTurns: 12 }
  };
  return {
    calls,
    async start() { calls.push('start'); return state; },
    async status() { calls.push('status'); return state; },
    async stop(reason) { calls.push(`stop:${reason}`); },
    async resume() { calls.push('resume'); },
    async reset() { calls.push('reset'); },
    async handleDeath() { calls.push('death'); },
    async handleDisconnect(reason) { calls.push(`disconnect:${reason}`); },
    async awaitIdle() { calls.push('awaitIdle'); },
    ...overrides
  };
}

function rig({ controller = controllerDouble(), bot = new FakeBot(), adapter, options = {} } = {}) {
  const stoppedAdapter = adapter ?? { stop() {} };
  const host = createLlmAgentLiveHost({
    actorId: 'LlmAgent',
    goal: FIRST_GOAL_OBJECTIVE,
    provider: { async decide() {} },
    stateDirectory: 'runtime/llm-agent-state',
    connection: { host: '127.0.0.1', port: 25565, version: '1.21.4', auth: 'offline' },
    botFactory: () => bot,
    pathfinderPlugin: function fakePathfinderPlugin() {},
    goals: { GoalNear: class GoalNear {} },
    Movements: class Movements {},
    storeFactory: () => ({ load() {}, save() {}, reset() {}, acquireLease() {}, releaseLease() {} }),
    adapterFactory: () => stoppedAdapter,
    controllerFactory: () => controller,
    ...options
  });
  return { host, bot, controller, adapter: stoppedAdapter };
}

async function spawn(host, bot) {
  const first = host.start();
  const second = host.start();
  assert.strictEqual(second, first);
  bot.emit('spawn');
  await first;
}

test('accepts only exact VPNAJ commands and reports status in chat', async () => {
  const { host, bot, controller } = rig();
  await spawn(host, bot);

  await bot.emitAsync('chat', 'VPNAJ', 'agent start');
  for (const [username, message] of [
    ['OtherPlayer', 'agent reset'],
    ['vpnaj', 'agent stop'],
    ['VPNAJ', 'agent start '],
    ['VPNAJ', 'Agent start'],
    ['VPNAJ', '/agent start'],
    ['VPNAJ', 'agent restart']
  ]) await bot.emitAsync('chat', username, message);
  await bot.emitAsync('chat', 'VPNAJ', 'agent status');
  await bot.emitAsync('chat', 'VPNAJ', 'agent stop');
  await bot.emitAsync('chat', 'VPNAJ', 'agent resume');
  await bot.emitAsync('chat', 'VPNAJ', 'agent reset');

  assert.deepEqual(controller.calls, ['start', 'status', 'stop:operator requested stop', 'resume', 'reset']);
  assert.equal(bot.messages.length, 5);
  assert.match(bot.messages[1], /running/);
  assert.match(bot.messages[1], /turns=2\/12/);
  assert.match(bot.messages[1], /last=OAK_LOG_COLLECTED/);
  await host.close();
});

test('routes exact authorized pipeline commands and reports bounded questions', async () => {
  const calls = [];
  const pipeline = {
    start({ mission }) { calls.push({ method: 'start', mission }); return Promise.resolve({ lifecycle: { status: 'stopped' } }); },
    async status() {
      calls.push({ method: 'status' });
      return {
        lifecycle: { status: 'running' }, mission: { text: 'survive', version: 2 },
        activeContract: { proposal: { objective: 'Collect wood.' } }, speculativeContract: null,
        pendingQuestion: {
          prompt: 'Which route?', choices: [{ id: 'safe', label: 'Safe route' }, { id: 'fast', label: 'Fast route' }]
        }, counters: { goalsCompleted: 1, slowCalls: 3, fastCalls: 8 }
      };
    },
    async stop(reason) { calls.push({ method: 'stop', reason }); },
    async resume() { calls.push({ method: 'resume' }); },
    async reset() { calls.push({ method: 'reset' }); },
    async updateMission(text, options) { calls.push({ method: 'mission', text, options }); },
    async answer(choiceId) { calls.push({ method: 'answer', choiceId }); },
    async awaitIdle() {}
  };
  const pipelineRuntime = { controller: pipeline, async close() { calls.push({ method: 'close' }); } };
  const { host, bot } = rig({ options: {
    pipelineSlowProvider: { generate() {} }, pipelineFastProvider: { decide() {} },
    pipelineRuntimeFactory: () => pipelineRuntime,
    pipelineMission: 'survive and progress toward stone tools',
    pipelineOrigin: { x: 0, y: 64, z: 0 }
  } });
  await spawn(host, bot);

  for (const [username, message] of [
    ['OtherPlayer', 'pipeline start'], ['VPNAJ', '/pipeline start'],
    ['VPNAJ', 'Pipeline start'], ['VPNAJ', 'pipeline start ']
  ]) await bot.emitAsync('chat', username, message);
  await bot.emitAsync('chat', 'VPNAJ', 'pipeline start');
  await new Promise((resolve) => setImmediate(resolve));
  await bot.emitAsync('chat', 'VPNAJ', 'pipeline status');
  await bot.emitAsync('chat', 'VPNAJ', 'pipeline mission build a safe shelter');
  await bot.emitAsync('chat', 'VPNAJ', 'pipeline urgent retreat to safety');
  await bot.emitAsync('chat', 'VPNAJ', 'pipeline answer safe');
  await bot.emitAsync('chat', 'VPNAJ', 'pipeline stop');
  await bot.emitAsync('chat', 'VPNAJ', 'pipeline resume');
  await bot.emitAsync('chat', 'VPNAJ', 'pipeline reset');
  await host.close();

  assert.deepEqual(calls, [
    { method: 'start', mission: 'survive and progress toward stone tools' },
    { method: 'status' },
    { method: 'mission', text: 'build a safe shelter', options: { urgent: false } },
    { method: 'mission', text: 'retreat to safety', options: { urgent: true } },
    { method: 'answer', choiceId: 'safe' },
    { method: 'stop', reason: 'operator requested stop' },
    { method: 'resume' }, { method: 'reset' }, { method: 'close' }
  ]);
  assert.ok(bot.messages.some((message) => message.includes('question="Which route?"')));
  assert.ok(bot.messages.some((message) => message.includes('safe=Safe route')));
});

test('pipeline and legacy starts are mutually exclusive while work is active', async () => {
  const pipelineGate = deferred();
  let pipelineStops = 0;
  const pipeline = {
    start: () => pipelineGate.promise,
    stop: async () => { pipelineStops += 1; pipelineGate.resolve({ lifecycle: { status: 'stopped' } }); },
    status: async () => ({ lifecycle: { status: 'running' } }), resume: async () => {}, reset: async () => {},
    updateMission: async () => {}, answer: async () => {}, awaitIdle: async () => {}
  };
  const { host, bot, controller } = rig({ options: {
    pipelineSlowProvider: { generate() {} }, pipelineFastProvider: { decide() {} },
    pipelineRuntimeFactory: () => ({ controller: pipeline, async close() {} }),
    pipelineOrigin: { x: 0, y: 64, z: 0 }
  } });
  await spawn(host, bot);
  await bot.emitAsync('chat', 'VPNAJ', 'pipeline start');
  await bot.emitAsync('chat', 'VPNAJ', 'agent start');
  assert.equal(controller.calls.includes('start'), false);
  assert.ok(bot.messages.some((message) => message.includes('LLM_RUNTIME_CONFLICT')));
  await bot.emitAsync('chat', 'VPNAJ', 'pipeline stop');
  assert.equal(pipelineStops, 1);
  await host.close();
});

test('creates pipeline authority at the shared bot spawn when no origin is configured', async () => {
  const bot = new FakeBot();
  bot.entity = { position: { x: 10.8, y: 64, z: -2.2 } };
  let runtimeOptions;
  const { host } = rig({ bot, options: {
    pipelineSlowProvider: { generate() {} }, pipelineFastProvider: { decide() {} },
    pipelineRuntimeFactory(options) {
      runtimeOptions = options;
      return { controller: { stop: async () => {} }, close: async () => {} };
    }
  } });
  await spawn(host, bot);
  assert.deepEqual(runtimeOptions.origin, { x: 10, y: 64, z: -3 });
  assert.strictEqual(runtimeOptions.bot, bot);
  await host.close();
});

test('rejects a pipeline start immediately while the legacy agent owns execution', async () => {
  const active = deferred();
  let pipelineStarts = 0;
  const controller = controllerDouble({ async start() { await active.promise; } });
  const pipeline = {
    start() { pipelineStarts += 1; }, stop: async () => {}, status: async () => null,
    resume: async () => {}, reset: async () => {}, updateMission: async () => {},
    answer: async () => {}, awaitIdle: async () => {}
  };
  const { host, bot } = rig({ controller, options: {
    pipelineSlowProvider: { generate() {} }, pipelineFastProvider: { decide() {} },
    pipelineRuntimeFactory: () => ({ controller: pipeline, async close() {} }),
    pipelineOrigin: { x: 0, y: 64, z: 0 }
  } });
  await spawn(host, bot);
  const agentStart = bot.emitAsync('chat', 'VPNAJ', 'agent start');
  await new Promise((resolve) => setImmediate(resolve));
  await bot.emitAsync('chat', 'VPNAJ', 'pipeline start');
  assert.equal(pipelineStarts, 0);
  assert.ok(bot.messages.some((message) => message.includes('LLM_RUNTIME_CONFLICT')));
  active.resolve();
  await agentStart;
  await host.close();
});

test('accepts exact director commands from VPNAJ and closes the director runtime', async () => {
  const calls = [];
  const directorController = {
    async start() { calls.push('director:start'); return { lifecycle: { status: 'succeeded' } }; },
    async status() { calls.push('director:status'); return { lifecycle: { status: 'succeeded' }, currentGoalId: 'collect_oak_log_above_gold_marker' }; },
    async stop() { calls.push('director:stop'); },
    async reset() { calls.push('director:reset'); }
  };
  const directorRuntime = { controller: directorController, async stopFast() {}, async close() { calls.push('director:close'); } };
  const { host, bot } = rig({ options: {
    directorProvider: { async select() {} },
    directorStoreFactory: () => ({}),
    directorRuntimeFactory: () => directorRuntime
  } });
  await spawn(host, bot);
  await bot.emitAsync('chat', 'OtherPlayer', 'director start');
  await bot.emitAsync('chat', 'VPNAJ', '/director start');
  await bot.emitAsync('chat', 'VPNAJ', 'director start');
  await new Promise((resolve) => setImmediate(resolve));
  await bot.emitAsync('chat', 'VPNAJ', 'director status');
  await bot.emitAsync('chat', 'VPNAJ', 'director stop');
  await bot.emitAsync('chat', 'VPNAJ', 'director reset');
  await host.close();
  assert.deepEqual(calls, ['director:start', 'director:status', 'director:stop', 'director:reset', 'director:close']);
  assert.ok(bot.messages.some((message) => message === 'LLM director started'));
  assert.ok(bot.messages.some((message) => /LLM director succeeded/.test(message)));
});

test('identifies its controller evidence as Mineflayer live-server evidence', async () => {
  let controllerOptions;
  const controller = controllerDouble();
  const { host, bot } = rig({
    controller,
    options: {
      controllerFactory(input) {
        controllerOptions = input;
        return controller;
      }
    }
  });

  await spawn(host, bot);
  assert.deepEqual(
    { evidenceSource: controllerOptions.evidenceSource, providerKind: controllerOptions.providerKind },
    { evidenceSource: 'mineflayer-live', providerKind: 'codex' }
  );
  await host.close();
});

test('awaits authorized commands through one queue', async () => {
  const firstCommand = deferred();
  const calls = [];
  const controller = controllerDouble({
    calls,
    async start() { calls.push('start:begin'); await firstCommand.promise; calls.push('start:end'); },
    async status() { calls.push('status'); return null; }
  });
  const { host, bot } = rig({ controller });
  await spawn(host, bot);

  const starting = bot.emitAsync('chat', 'VPNAJ', 'agent start');
  await new Promise((resolve) => setImmediate(resolve));
  const status = bot.emitAsync('chat', 'VPNAJ', 'agent status');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['start:begin']);

  firstCommand.resolve();
  await Promise.all([starting, status]);
  assert.deepEqual(calls, ['start:begin', 'start:end', 'status']);
  await host.close();
});

test('serial duplicate agent starts cannot create a second controller loop', async () => {
  let running = false;
  let loopsCreated = 0;
  const controller = controllerDouble({
    async start() {
      controller.calls.push('start');
      if (running) throw Object.assign(new Error('already running'), { code: 'LLM_AGENT_ALREADY_RUNNING' });
      running = true;
      loopsCreated += 1;
    }
  });
  const { host, bot } = rig({ controller });
  await spawn(host, bot);

  await Promise.all([
    bot.emitAsync('chat', 'VPNAJ', 'agent start'),
    bot.emitAsync('chat', 'VPNAJ', 'agent start')
  ]);

  assert.equal(loopsCreated, 1);
  assert.deepEqual(controller.calls, ['start', 'start']);
  assert.match(bot.messages.at(-1), /LLM_AGENT_ALREADY_RUNNING/);
  await host.close();
});

test('forwards death and one disconnect to the controller', async () => {
  const { host, bot, controller } = rig();
  await spawn(host, bot);

  await bot.emitAsync('death');
  await bot.emitAsync('kicked', 'server restart');
  await bot.emitAsync('end', 'socket closed');

  assert.deepEqual(controller.calls, ['death', 'disconnect:server restart']);
  await host.close();
});

test('close stops controller, adapter, and pathfinder before ending the bot', async () => {
  const order = [];
  const bot = new FakeBot(order);
  const controller = controllerDouble({
    async stop(reason) { order.push(`controller.stop:${reason}`); },
    async awaitIdle() { order.push('controller.awaitIdle'); }
  });
  const adapter = { stop() { order.push('adapter.stop'); } };
  const { host } = rig({ bot, controller, adapter });
  await spawn(host, bot);

  await Promise.all([host.close(), host.close()]);

  assert.deepEqual(order, [
    'controller.stop:host closing',
    'controller.awaitIdle',
    'adapter.stop',
    'pathfinder.stop',
    'bot.quit:llm-agent-host-close'
  ]);
});

test('close before first spawn rejects start and removes every host listener', async () => {
  const order = [];
  const bot = new FakeBot(order);
  const controller = controllerDouble({
    async stop(reason) { order.push(`controller.stop:${reason}`); },
    async awaitIdle() { order.push('controller.awaitIdle'); }
  });
  const adapter = { stop() { order.push('adapter.stop'); } };
  const { host } = rig({ bot, controller, adapter });
  const starting = host.start().catch((error) => {
    order.push(`start.rejected:${error.code}`);
    throw error;
  });

  const closing = host.close().then(() => order.push('close.resolved'));
  const outcome = await Promise.race([
    Promise.allSettled([starting, closing]),
    new Promise((resolve) => setImmediate(() => resolve('still-pending')))
  ]);

  assert.notEqual(outcome, 'still-pending');
  assert.equal(outcome[0].status, 'rejected');
  assert.equal(outcome[0].reason.code, 'LLM_AGENT_HOST_CLOSED');
  assert.equal(outcome[1].status, 'fulfilled');
  assert.deepEqual(order, [
    'controller.stop:host closing',
    'start.rejected:LLM_AGENT_HOST_CLOSED',
    'controller.awaitIdle',
    'adapter.stop',
    'pathfinder.stop',
    'bot.quit:llm-agent-host-close',
    'close.resolved'
  ]);
  assert.deepEqual(bot.eventNames(), []);
});

test('close fences an authorized command that was queued behind active work', async () => {
  const active = deferred();
  const calls = [];
  const controller = controllerDouble({
    calls,
    async start() { calls.push('start'); await active.promise; },
    async resume() { calls.push('resume'); },
    async stop() { calls.push('stop'); },
    async awaitIdle() { calls.push('awaitIdle'); }
  });
  const { host, bot } = rig({ controller });
  await spawn(host, bot);

  const starting = bot.emitAsync('chat', 'VPNAJ', 'agent start');
  await new Promise((resolve) => setImmediate(resolve));
  const resuming = bot.emitAsync('chat', 'VPNAJ', 'agent resume');
  const closing = host.close();
  active.resolve();
  await Promise.all([starting, resuming, closing]);

  assert.deepEqual(calls, ['start', 'stop', 'awaitIdle']);
});

test('composes one isolated actor from injected factories', async () => {
  const bot = new FakeBot();
  const plugin = function plugin() {};
  const provider = { async decide() {} };
  const store = { id: 'store' };
  const adapter = { id: 'adapter', stop() {} };
  const controller = controllerDouble();
  let botConfig;
  let storeConfig;
  let adapterConfig;
  let controllerConfig;

  const host = createLlmAgentLiveHost({
    actorId: 'AgentThree',
    goal: FIRST_GOAL_OBJECTIVE,
    provider,
    stateDirectory: '/tmp/llm-agent-state',
    connection: { host: 'localhost', port: 25570, version: '1.21.4', auth: 'offline' },
    botFactory(config) { botConfig = config; return bot; },
    pathfinderPlugin: plugin,
    goals: { GoalNear: class GoalNear {} },
    Movements: class Movements {},
    storeFactory(config) { storeConfig = config; return store; },
    adapterFactory(config) { adapterConfig = config; return adapter; },
    controllerFactory(config) { controllerConfig = config; return controller; }
  });

  assert.deepEqual(botConfig, {
    host: 'localhost', port: 25570, version: '1.21.4', auth: 'offline', username: 'AgentThree'
  });
  assert.deepEqual(storeConfig, { directory: '/tmp/llm-agent-state' });
  assert.equal(adapterConfig.bot, bot);
  assert.equal(controllerConfig.actorId, 'AgentThree');
  assert.equal(controllerConfig.goal, FIRST_GOAL_OBJECTIVE);
  assert.equal(controllerConfig.provider, provider);
  assert.equal(controllerConfig.store, store);
  assert.equal(controllerConfig.adapter, adapter);
  assert.deepEqual(bot.loadedPlugins, [plugin]);
  assert.strictEqual(host.bot, bot);
  assert.strictEqual(host.controller, controller);
  await host.close();
});

test('rejects malformed or missing startup scripts before connecting Mineflayer', async () => {
  for (const [label, readFileImpl] of [
    ['missing', async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }],
    ['malformed', async () => '{'],
    ['non-array', async () => '{"action":"observe"}']
  ]) {
    let connections = 0;
    await assert.rejects(startLlmAgentCli({
      env: { LLM_AGENT_SCRIPT_PATH: `${label}.json` },
      loadEnvFileImpl: async () => {},
      readFileImpl,
      hostFactory() { connections += 1; }
    }), { code: 'LLM_AGENT_SCRIPT_INVALID' });
    assert.equal(connections, 0, label);
  }
});

test('startup uses an explicit JSON script without requiring Codex', async () => {
  const decisions = [{
    action: 'observe', reason: 'inspect', summary: '', plan: ['inspect'], subgoal: 'inspect', variables: {}
  }];
  let hostOptions;
  let starts = 0;
  const host = await startLlmAgentCli({
    env: {
      LLM_AGENT_SCRIPT_PATH: 'script.json',
      LLM_AGENT_USERNAME: 'AgentScript',
      MC_HOST: 'minecraft.test',
      MC_PORT: '25566',
      MC_VERSION: '1.21.4',
      LLM_AGENT_STATE_DIRECTORY: '/private/tmp/agent-state'
    },
    loadEnvFileImpl: async () => {},
    readFileImpl: async () => JSON.stringify(decisions),
    hostFactory(options) {
      hostOptions = options;
      return { async start() { starts += 1; }, async close() {} };
    },
    processImpl: new EventEmitter()
  });

  assert.equal(starts, 1);
  assert.equal(hostOptions.actorId, 'AgentScript');
  assert.deepEqual(hostOptions.connection, {
    host: 'minecraft.test', port: 25566, version: '1.21.4', auth: 'offline'
  });
  assert.equal(hostOptions.providerKind, 'scripted');
  assert.equal(hostOptions.stateDirectory, '/private/tmp/agent-state');
  assert.equal((await hostOptions.provider.decide({})).action, 'observe');
  await assert.rejects(hostOptions.provider.decide({}), { code: 'LLM_AGENT_SCRIPT_EXHAUSTED' });
  await host.close();
});

test('Codex startup configures separate slow and fast pipeline providers on the shared host', async () => {
  let hostOptions;
  const host = await startLlmAgentCli({
    env: {
      CODEX_BIN: '/explicit/codex', LLM_AGENT_USERNAME: 'PipelineAgent',
      LLM_PIPELINE_STATE_DIRECTORY: '/private/tmp/pipeline-state',
      LLM_PIPELINE_MISSION: 'build toward stone tools'
    },
    loadEnvFileImpl: async () => {}, accessImpl: async () => {},
    hostFactory(options) {
      hostOptions = options;
      return { async start() {}, async close() {} };
    },
    processImpl: new EventEmitter()
  });
  assert.equal(typeof hostOptions.pipelineSlowProvider.generate, 'function');
  assert.equal(typeof hostOptions.pipelineFastProvider.decide, 'function');
  assert.equal(hostOptions.pipelineStateDirectory, '/private/tmp/pipeline-state');
  assert.equal(hostOptions.pipelineMission, 'build toward stone tools');
  await host.close();
});

test('Codex startup checks an explicit executable before connecting and reserves runtime identities case-insensitively', async () => {
  for (const username of ['HeroActor', 'heroactor', 'RivalActor', 'RIVALACTOR', 'VPNAJ', 'vpnaj']) {
    let connections = 0;
    await assert.rejects(startLlmAgentCli({
      env: { LLM_AGENT_USERNAME: username, CODEX_BIN: '/explicit/codex' },
      loadEnvFileImpl: async () => {},
      accessImpl: async () => {},
      hostFactory() { connections += 1; }
    }), { code: 'LLM_AGENT_IDENTITY_RESERVED' });
    assert.equal(connections, 0);
  }

  let connections = 0;
  await assert.rejects(startLlmAgentCli({
    env: { CODEX_BIN: '/missing/codex' },
    loadEnvFileImpl: async () => {},
    accessImpl: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    hostFactory() { connections += 1; }
  }), { code: 'LLM_AGENT_CODEX_BIN_UNAVAILABLE' });
  assert.equal(connections, 0);
});

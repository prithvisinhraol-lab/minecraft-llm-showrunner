import mineflayer from 'mineflayer';
import pathfinderPackage from 'mineflayer-pathfinder';

import { FIRST_GOAL_OBJECTIVE } from './contracts.mjs';
import { createAgentController } from './controller.mjs';
import { createMinecraftAdapter } from './minecraft-adapter.mjs';
import { createActorStateStore } from './state-store.mjs';
import { createDirectorLiveRuntime } from '../llm-director/live-runtime.mjs';
import { createDirectorStateStore } from '../llm-director/state-store.mjs';
import { createGoalPipelineLiveRuntime } from '../llm-goal-pipeline/live-runtime.mjs';

const COMMANDS = new Set([
  'agent start', 'agent status', 'agent stop', 'agent resume', 'agent reset',
  'director start', 'director status', 'director stop', 'director reset'
]);
const PIPELINE_COMMANDS = new Set([
  'pipeline start', 'pipeline status', 'pipeline stop', 'pipeline resume', 'pipeline reset'
]);
const ACTOR_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const PROVIDER_KINDS = new Set(['codex', 'scripted']);

function coded(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
}

function disconnectReason(reason) {
  if (typeof reason === 'string' && reason.length > 0) return reason;
  if (reason === undefined || reason === null) return 'connection lost';
  return String(reason);
}

function formatStatus(state) {
  if (state === null) return 'LLM agent idle; no persisted state';
  const lifecycle = state?.lifecycle?.status ?? 'unknown';
  const phase = state?.trusted?.phase ?? 'unknown';
  const used = state?.limits?.turnsUsed ?? '?';
  const maximum = state?.limits?.maxTurns ?? '?';
  const milestones = Array.isArray(state?.trusted?.milestones) && state.trusted.milestones.length > 0
    ? state.trusted.milestones.join(',')
    : 'none';
  const recent = Array.isArray(state?.trusted?.recentActionResults)
    ? state.trusted.recentActionResults.at(-1)
    : null;
  return `LLM agent ${lifecycle}; phase=${phase}; turns=${used}/${maximum}; milestones=${milestones}; last=${recent?.code ?? 'none'}`;
}

function safeChat(bot, message) {
  try {
    bot.chat?.(message);
  } catch {
    // The controller and persisted state remain authoritative if chat reporting fails.
  }
}

function parsePipelineCommand(message) {
  if (PIPELINE_COMMANDS.has(message)) return { kind: message.slice('pipeline '.length) };
  const mission = /^(pipeline mission|pipeline urgent) (.+)$/u.exec(message);
  if (mission && Array.from(mission[2]).length <= 300) {
    return { kind: mission[1] === 'pipeline urgent' ? 'urgent' : 'mission', value: mission[2] };
  }
  const answer = /^pipeline answer ([A-Za-z0-9_.:/-]{1,100})$/u.exec(message);
  return answer ? { kind: 'answer', value: answer[1] } : null;
}

function formatPipelineStatus(state) {
  if (state === null) return 'LLM pipeline idle; no persisted state';
  const question = state?.pendingQuestion;
  const choices = Array.isArray(question?.choices)
    ? question.choices.map(({ id, label }) => `${id}=${label}`).join(',')
    : 'none';
  return [
    `LLM pipeline ${state?.lifecycle?.status ?? 'unknown'}`,
    `mission=v${state?.mission?.version ?? '?'}:${state?.mission?.text ?? 'unknown'}`,
    `active=${state?.activeContract?.proposal?.objective ?? 'none'}`,
    `speculative=${state?.speculativeContract?.proposal?.objective ?? 'none'}`,
    `goals=${state?.counters?.goalsCompleted ?? '?'}`,
    `slow=${state?.counters?.slowCalls ?? '?'}`,
    `fast=${state?.counters?.fastCalls ?? '?'}`,
    `question="${question?.prompt ?? 'none'}"`,
    `choices=${choices}`
  ].join('; ');
}

export function createLlmAgentLiveHost({
  actorId = 'LlmAgent',
  goal = FIRST_GOAL_OBJECTIVE,
  provider,
  stateDirectory = 'runtime/llm-agent-state',
  connection = {},
  botFactory = (config) => mineflayer.createBot(config),
  pathfinderPlugin = pathfinderPackage.pathfinder,
  goals = pathfinderPackage.goals,
  Movements = pathfinderPackage.Movements,
  storeFactory = createActorStateStore,
  adapterFactory = createMinecraftAdapter,
  controllerFactory = createAgentController,
  providerKind = 'codex',
  directorProvider,
  directorStateDirectory = 'runtime/llm-director-state',
  directorStoreFactory = createDirectorStateStore,
  directorRuntimeFactory = createDirectorLiveRuntime,
  overallObjective = 'advance through small verified Minecraft goals',
  pipelineSlowProvider,
  pipelineFastProvider,
  pipelineStateDirectory = 'runtime/llm-goal-pipeline-state',
  pipelineRuntimeFactory = createGoalPipelineLiveRuntime,
  pipelineMission = 'survive and progress toward stone tools',
  pipelineOrigin,
  pipelineProtectedRegions = []
} = {}) {
  if (typeof actorId !== 'string' || !ACTOR_ID_PATTERN.test(actorId)) {
    throw coded('LLM_AGENT_IDENTITY_INVALID', 'actorId must match /^[A-Za-z0-9_-]{1,32}$/');
  }
  if (!provider || typeof provider.decide !== 'function') throw new TypeError('provider.decide must be a function');
  if (!PROVIDER_KINDS.has(providerKind)) throw new TypeError('providerKind must be codex or scripted');
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0) {
    throw new TypeError('stateDirectory must be a nonempty string');
  }
  for (const [factory, name] of [
    [botFactory, 'botFactory'],
    [storeFactory, 'storeFactory'],
    [adapterFactory, 'adapterFactory'],
    [controllerFactory, 'controllerFactory']
  ]) requireFunction(factory, name);
  requireFunction(pathfinderPlugin, 'pathfinderPlugin');

  const bot = botFactory({ ...connection, username: actorId });
  if (!bot || typeof bot !== 'object') throw coded('LLM_AGENT_BOT_INVALID', 'botFactory must return a bot object');
  requireFunction(bot.loadPlugin, 'bot.loadPlugin');
  bot.loadPlugin(pathfinderPlugin);

  const store = storeFactory({ directory: stateDirectory });
  const adapter = adapterFactory({ bot, goals, Movements });
  const controller = controllerFactory({ actorId, goal, store, provider, adapter, evidenceSource: 'mineflayer-live', providerKind });
  const directorRuntime = directorProvider ? directorRuntimeFactory({
    actorId, overallObjective, adapter, actorStore: store, actorProvider: provider,
    directorStore: directorStoreFactory({ directory: directorStateDirectory }), directorProvider,
    providerKind, agentControllerFactory: controllerFactory
  }) : null;
  const director = directorRuntime?.controller ?? null;
  if ((pipelineSlowProvider && !pipelineFastProvider) || (!pipelineSlowProvider && pipelineFastProvider)) {
    throw new TypeError('pipeline slow and fast providers must be supplied together');
  }
  let pipelineRuntime = null;
  let pipeline = null;

  function initializePipeline() {
    if (!pipelineSlowProvider || pipelineRuntime) return;
    const live = bot.entity?.position;
    const origin = pipelineOrigin ?? ([live?.x, live?.y, live?.z].every(Number.isFinite)
      ? { x: Math.floor(live.x), y: Math.floor(live.y), z: Math.floor(live.z) }
      : null);
    if (!origin) throw coded('LLM_PIPELINE_ORIGIN_UNAVAILABLE', 'pipeline origin is unavailable before actor spawn');
    pipelineRuntime = pipelineRuntimeFactory({
      actorId, bot, goals, Movements,
      slowProvider: pipelineSlowProvider, fastProvider: pipelineFastProvider,
      stateDirectory: pipelineStateDirectory, origin,
      protectedRegions: pipelineProtectedRegions
    });
    pipeline = pipelineRuntime?.controller ?? null;
    if (!pipeline) throw coded('LLM_PIPELINE_RUNTIME_INVALID', 'pipeline runtime has no controller');
  }

  let closed = false;
  let disconnected = false;
  let closePromise = null;
  let resolveStart;
  let rejectStart;
  const startPromise = new Promise((resolve, reject) => {
    resolveStart = resolve;
    rejectStart = reject;
  });
  startPromise.catch(() => {});
  let commandQueue = Promise.resolve();
  let activeMode = null;
  const listeners = [];

  function listen(event, listener) {
    bot.on?.(event, listener);
    listeners.push([event, listener]);
  }

  function reportError(error) {
    const code = typeof error?.code === 'string' ? error.code : 'LLM_AGENT_COMMAND_FAILED';
    safeChat(bot, `LLM agent error: ${code}`);
  }

  function assertModeAvailable(requested) {
    if (activeMode && activeMode !== requested) {
      throw coded('LLM_RUNTIME_CONFLICT', `${activeMode} work is active`);
    }
  }

  function launchPipeline(operation, startedMessage) {
    assertModeAvailable('pipeline');
    activeMode = 'pipeline';
    safeChat(bot, startedMessage);
    void Promise.resolve().then(operation).then((result) => {
      if (!closed) safeChat(bot, `LLM pipeline ${result?.lifecycle?.status ?? 'finished'}`);
    }).catch((error) => { if (!closed) reportError(error); }).finally(() => {
      if (activeMode === 'pipeline') activeMode = null;
    });
  }

  async function handleCommand(message) {
    if (closed) return;
    if (message === 'agent start') {
      assertModeAvailable('agent');
      activeMode = 'agent';
      try {
        await controller.start();
        safeChat(bot, 'LLM agent started');
      } finally {
        if (activeMode === 'agent') activeMode = null;
      }
    } else if (message === 'agent status') {
      safeChat(bot, formatStatus(await controller.status()));
    } else if (message === 'agent stop') {
      await controller.stop('operator requested stop');
      safeChat(bot, 'LLM agent stopped');
    } else if (message === 'agent resume') {
      await controller.resume();
      safeChat(bot, 'LLM agent resumed');
    } else if (message === 'agent reset') {
      await controller.reset();
      safeChat(bot, 'LLM agent reset');
    } else if (message === 'director start' && director) {
      assertModeAvailable('director');
      activeMode = 'director';
      safeChat(bot, 'LLM director started');
      void director.start().then((result) => {
        if (!closed) safeChat(bot, `LLM director ${result?.lifecycle?.status ?? 'finished'}`);
      }).catch((error) => { if (!closed) reportError(error); }).finally(() => {
        if (activeMode === 'director') activeMode = null;
      });
    } else if (message === 'director status' && director) {
      const current = await director.status();
      safeChat(bot, `LLM director ${current?.lifecycle?.status ?? 'idle'}; goal=${current?.currentGoalId ?? 'none'}`);
    } else if (message === 'director stop' && director) {
      await directorRuntime.stopFast('operator requested director stop');
      await director.stop('operator requested stop');
      safeChat(bot, 'LLM director stopped');
    } else if (message === 'director reset' && director) {
      await director.reset();
      safeChat(bot, 'LLM director reset');
    } else if (pipeline) {
      const command = parsePipelineCommand(message);
      if (!command) return;
      if (command.kind === 'start') {
        launchPipeline(() => pipeline.start({ mission: pipelineMission }), 'LLM pipeline started');
      } else if (command.kind === 'status') {
        safeChat(bot, formatPipelineStatus(await pipeline.status()));
      } else if (command.kind === 'stop') {
        await pipeline.stop('operator requested stop');
        if (activeMode === 'pipeline') activeMode = null;
        safeChat(bot, 'LLM pipeline stopped');
      } else if (command.kind === 'resume') {
        launchPipeline(() => pipeline.resume(), 'LLM pipeline resumed');
      } else if (command.kind === 'reset') {
        await pipeline.reset();
        safeChat(bot, 'LLM pipeline reset');
      } else if (command.kind === 'mission') {
        await pipeline.updateMission(command.value, { urgent: false });
        safeChat(bot, 'LLM pipeline mission updated');
      } else if (command.kind === 'urgent') {
        await pipeline.updateMission(command.value, { urgent: true });
        safeChat(bot, 'LLM pipeline urgent mission applied');
      } else if (command.kind === 'answer') {
        await pipeline.answer(command.value);
        safeChat(bot, `LLM pipeline answer accepted: ${command.value}`);
      }
    }
  }

  function enqueue(operation, { report = true } = {}) {
    const result = commandQueue.then(operation);
    commandQueue = result.catch((error) => {
      if (report && !closed) reportError(error);
    });
    return commandQueue;
  }

  function onChat(username, message) {
    if (closed || username !== 'VPNAJ' || typeof message !== 'string'
      || (!COMMANDS.has(message) && parsePipelineCommand(message) === null)) {
      return Promise.resolve();
    }
    const requestedMode = message === 'agent start' ? 'agent'
      : message === 'director start' ? 'director'
        : (message === 'pipeline start' || message === 'pipeline resume') ? 'pipeline' : null;
    if (requestedMode && activeMode && activeMode !== requestedMode) {
      reportError(coded('LLM_RUNTIME_CONFLICT', `${activeMode} work is active`));
      return Promise.resolve();
    }
    return enqueue(() => handleCommand(message));
  }

  function onDeath() {
    if (closed) return Promise.resolve();
    return enqueue(async () => {
      if (closed) return;
      await pipeline?.stop?.('actor died');
      if (activeMode === 'pipeline') activeMode = null;
      await controller.handleDeath();
    });
  }

  function onDisconnect(reason) {
    if (closed || disconnected) return Promise.resolve();
    disconnected = true;
    const normalized = disconnectReason(reason);
    rejectStart(coded('LLM_AGENT_DISCONNECTED', `actor disconnected before startup completed: ${normalized}`));
    return enqueue(async () => {
      if (closed) return;
      await pipeline?.stop?.(`actor disconnected: ${normalized}`);
      if (activeMode === 'pipeline') activeMode = null;
      await controller.handleDisconnect(normalized);
    });
  }

  listen('spawn', () => {
    if (closed) return;
    try {
      initializePipeline();
      resolveStart(host);
    } catch (error) {
      rejectStart(error);
    }
  });
  listen('chat', onChat);
  listen('death', onDeath);
  listen('kicked', onDisconnect);
  listen('end', onDisconnect);
  listen('error', onDisconnect);

  function start() {
    if (closed) return Promise.reject(coded('LLM_AGENT_HOST_CLOSED', 'LLM agent host is closed'));
    return startPromise;
  }

  function close() {
    if (closePromise) return closePromise;
    closed = true;
    rejectStart(coded('LLM_AGENT_HOST_CLOSED', 'LLM agent host closed before first spawn'));
    for (const [event, listener] of listeners) bot.off?.(event, listener);
    listeners.length = 0;
    closePromise = (async () => {
      try {
        await controller.stop('host closing');
      } finally {
        try {
          await directorRuntime?.close?.();
          await pipelineRuntime?.close?.();
          await commandQueue;
          await controller.awaitIdle?.();
        } finally {
          try {
            await adapter.stop?.();
          } finally {
            try {
              bot.pathfinder?.stop?.();
            } finally {
              bot.quit?.('llm-agent-host-close');
            }
          }
        }
      }
    })();
    return closePromise;
  }

  const host = Object.freeze({ start, close, controller, director, get pipeline() { return pipeline; }, bot });
  return host;
}

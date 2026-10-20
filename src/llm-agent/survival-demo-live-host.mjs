import mineflayer from 'mineflayer';
import pathfinderPackage from 'mineflayer-pathfinder';
import path from 'node:path';

import { createSurvivalDemoMacroExecutor } from './survival-demo-macro-executor.mjs';
import { createSurvivalDemoMinecraftAdapter } from './survival-demo-minecraft-adapter.mjs';
import { createSurvivalDemoProvider } from './survival-demo-provider.mjs';
import { createSurvivalDemoRunner } from './survival-demo-runner.mjs';
import { createSurvivalDemoStore } from './survival-demo-store.mjs';
import { createSurvivalDemoVillageObserver } from './survival-demo-village-observer.mjs';

const ACTOR_ID = /^[A-Za-z0-9_-]{1,32}$/;

function coded(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function point(value) {
  return value && [value.x, value.y, value.z].every(Number.isFinite);
}

function requireFactory(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
}

function waitForSpawn(bot, timeoutMs) {
  if (bot.player && point(bot.entity?.position)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      bot.removeListener?.('spawn', onSpawn);
      bot.removeListener?.('error', onError);
      bot.removeListener?.('end', onEnd);
      error ? reject(error) : resolve();
    };
    const onSpawn = () => finish();
    const onError = (error) => finish(coded('SURVIVAL_DEMO_CONNECT_FAILED', 'actor connection failed', error));
    const onEnd = (reason) => finish(coded('SURVIVAL_DEMO_DISCONNECTED', `actor disconnected before spawn: ${String(reason ?? 'unknown')}`));
    const timer = setTimeout(() => finish(coded('SURVIVAL_DEMO_SPAWN_TIMEOUT', 'actor did not spawn before the deadline')), timeoutMs);
    bot.once?.('spawn', onSpawn);
    bot.once?.('error', onError);
    bot.once?.('end', onEnd);
  });
}

async function verifyClearing(bot, clearingStart) {
  const position = bot.entity?.position;
  if (!point(position) || Math.hypot(position.x - clearingStart.x, position.y - clearingStart.y, position.z - clearingStart.z) > 3) {
    throw coded('SURVIVAL_DEMO_START_POSITION_INVALID', 'actor did not spawn at the trusted clearing start');
  }
}

export function createSurvivalDemoLiveHost({
  connection = {}, actorId = 'LlmAgent', stateDirectory = 'runtime/survival-demo-state',
  codexBin, clearingStart,
  botFactory = (config) => mineflayer.createBot(config),
  pathfinderPlugin = pathfinderPackage.pathfinder,
  goals = pathfinderPackage.goals,
  Movements = pathfinderPackage.Movements,
  providerFactory = createSurvivalDemoProvider,
  storeFactory = createSurvivalDemoStore,
  villageObserverFactory = createSurvivalDemoVillageObserver,
  macroExecutorFactory = createSurvivalDemoMacroExecutor,
  adapterFactory = createSurvivalDemoMinecraftAdapter,
  runnerFactory = createSurvivalDemoRunner,
  placeActor = verifyClearing,
  spawnTimeoutMs = 15_000
} = {}) {
  if (!ACTOR_ID.test(actorId ?? '')) throw new TypeError('actorId is invalid');
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0) throw new TypeError('stateDirectory is invalid');
  if (typeof codexBin !== 'string' || codexBin.length === 0) throw new TypeError('codexBin is invalid');
  if (!point(clearingStart)) throw new TypeError('clearingStart is invalid');
  if (!Number.isSafeInteger(spawnTimeoutMs) || spawnTimeoutMs < 1 || spawnTimeoutMs > 60_000) throw new TypeError('spawnTimeoutMs is invalid');
  for (const [factory, name] of [
    [botFactory, 'botFactory'], [pathfinderPlugin, 'pathfinderPlugin'], [providerFactory, 'providerFactory'],
    [storeFactory, 'storeFactory'], [villageObserverFactory, 'villageObserverFactory'],
    [macroExecutorFactory, 'macroExecutorFactory'], [adapterFactory, 'adapterFactory'],
    [runnerFactory, 'runnerFactory'], [placeActor, 'placeActor']
  ]) requireFactory(factory, name);

  let bot = null;
  let adapter = null;
  let runner = null;
  let started = false;
  let closed = false;
  let stopPromise = null;
  let closePromise = null;
  let cleaned = false;
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
  completion.catch(() => {});
  const listeners = [];

  function listen(event, listener) {
    bot.on?.(event, listener);
    listeners.push([event, listener]);
  }

  async function cleanup() {
    if (!bot || cleaned) return;
    cleaned = true;
    for (const [event, listener] of listeners.splice(0)) bot.removeListener?.(event, listener);
    await adapter?.close?.();
    bot.pathfinder?.stop?.();
    try { bot.quit?.('survival demo finished'); } catch {}
  }

  async function run() {
    let result;
    let failure;
    try {
      bot = botFactory({ ...connection, username: actorId });
      if (!bot || typeof bot.loadPlugin !== 'function') throw coded('SURVIVAL_DEMO_BOT_INVALID', 'bot factory returned an invalid actor');
      bot.loadPlugin(pathfinderPlugin);
      await waitForSpawn(bot, spawnTimeoutMs);
      if (closed) throw coded('SURVIVAL_DEMO_HOST_CLOSED', 'host closed before actor setup');
      await placeActor(bot, clearingStart);
      if (closed) throw coded('SURVIVAL_DEMO_HOST_CLOSED', 'host closed before runner setup');
      const villageObserver = villageObserverFactory();
      const macroExecutor = macroExecutorFactory({ bot, goals, Movements, villageObserver, clearingStart });
      adapter = adapterFactory({ bot, actorId, macroExecutor, villageObserver });
      const provider = providerFactory({
        codexBin, timeoutMs: 30_000, tempDirectory: path.join(stateDirectory, '.codex-tmp')
      });
      const store = storeFactory({ directory: stateDirectory });
      runner = runnerFactory({ actorId, provider, adapter, store });
      const stopFromEvent = (reason) => { void stop(reason); };
      listen('death', () => stopFromEvent('actor died'));
      listen('end', (reason) => stopFromEvent(`actor disconnected: ${String(reason ?? 'unknown')}`));
      result = await runner.start();
    } catch (error) {
      failure = error;
    } finally {
      await cleanup();
    }
    if (failure) rejectCompletion(failure);
    else resolveCompletion(result);
  }

  function start() {
    if (!started) {
      started = true;
      void run();
    }
    return completion;
  }

  function stop(reason = 'operator requested stop') {
    if (!stopPromise) stopPromise = (async () => {
      await runner?.stop?.(reason);
      await adapter?.cancel?.(reason);
      await cleanup();
    })();
    return stopPromise;
  }

  function close() {
    if (!closePromise) closePromise = (async () => {
      closed = true;
      await stop('host closing');
      if (started) { try { await completion; } catch {} }
    })();
    return closePromise;
  }

  return Object.freeze({ start, stop, close, completion });
}

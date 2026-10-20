import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnvFile } from '../load-env.mjs';
import { resolveCodexBin } from './cli.mjs';
import { createSurvivalDemoLiveHost } from './survival-demo-live-host.mjs';
import { createSurvivalDemoLogGate } from './survival-demo-log-gate.mjs';

const ACTOR_ID = /^[A-Za-z0-9_-]{1,32}$/;
const RESERVED = new Set(['vpnaj', 'heroactor', 'rivalactor']);

function coded(message) {
  const error = new Error(message);
  error.code = 'SURVIVAL_DEMO_CONFIG_INVALID';
  return error;
}

function port(value) {
  const parsed = Number(value ?? 25565);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) throw coded('MC_PORT is invalid');
  return parsed;
}

function coordinate(value, fallback, name) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) throw coded(`${name} is invalid`);
  return parsed;
}

export async function startSurvivalDemoCli({
  env = process.env,
  processImpl = process,
  loadEnvFileImpl = loadEnvFile,
  resolveCodexBinImpl = resolveCodexBin,
  gateFactory = createSurvivalDemoLogGate,
  hostFactory = createSurvivalDemoLiveHost
} = {}) {
  await loadEnvFileImpl();
  const actorId = env.LLM_AGENT_USERNAME || 'LlmAgent';
  if (!ACTOR_ID.test(actorId) || RESERVED.has(actorId.toLowerCase())) throw coded('actor identity is invalid or reserved');
  const codexBin = await resolveCodexBinImpl({ configured: env.CODEX_BIN });
  const stateDirectory = path.resolve(env.SURVIVAL_DEMO_STATE_DIRECTORY || 'runtime/survival-demo-state');
  const logPath = path.resolve(env.SURVIVAL_DEMO_LOG_PATH || 'server/logs/latest.log');
  const clearingStart = {
    x: coordinate(env.SURVIVAL_DEMO_CLEARING_X, 52.5, 'SURVIVAL_DEMO_CLEARING_X'),
    y: coordinate(env.SURVIVAL_DEMO_CLEARING_Y, 66, 'SURVIVAL_DEMO_CLEARING_Y'),
    z: coordinate(env.SURVIVAL_DEMO_CLEARING_Z, 48.5, 'SURVIVAL_DEMO_CLEARING_Z')
  };
  const connection = {
    host: env.MC_HOST || '127.0.0.1', port: port(env.MC_PORT),
    version: env.MC_VERSION || '1.21.4', auth: env.MC_AUTH || 'offline'
  };

  const gate = gateFactory({
    logPath,
    launch: async () => {
      const host = hostFactory({ actorId, stateDirectory, codexBin, clearingStart, connection });
      host.start();
      return host;
    }
  });
  if (!gate || typeof gate.start !== 'function' || typeof gate.close !== 'function') throw new TypeError('gateFactory returned an invalid gate');

  let closePromise = null;
  const signals = ['SIGINT', 'SIGTERM'];
  const removeSignals = () => { for (const signal of signals) processImpl.off?.(signal, onSignal); };
  const close = () => {
    if (!closePromise) closePromise = Promise.resolve(gate.close()).finally(removeSignals);
    return closePromise;
  };
  const onSignal = () => { void close().catch((error) => { processImpl.exitCode = 1; console.error(error); }); };
  for (const signal of signals) processImpl.on?.(signal, onSignal);

  try {
    await gate.start();
    processImpl.stdout?.write?.('WAITING: join as VPNAJ, then say start.\n');
  } catch (error) {
    await close();
    throw error;
  }
  return Object.freeze({ gate, close });
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPath === fileURLToPath(import.meta.url)) {
  startSurvivalDemoCli().catch((error) => {
    process.exitCode = 1;
    console.error(error);
  });
}

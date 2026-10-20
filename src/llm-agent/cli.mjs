import { constants as fsConstants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnvFile } from '../load-env.mjs';
import { createCodexProvider } from './codex-provider.mjs';
import { FIRST_GOAL_OBJECTIVE } from './contracts.mjs';
import { createLlmAgentLiveHost } from './live-host.mjs';
import { createScriptedProvider } from './scripted-provider.mjs';
import { createDirectorCodexProvider } from '../llm-director/codex-provider.mjs';
import { createFastProvider } from '../llm-goal-pipeline/fast-provider.mjs';
import { createSlowContractProvider } from '../llm-goal-pipeline/slow-provider.mjs';

const RESERVED_RUNTIME_IDENTITIES = new Set(['heroactor', 'rivalactor', 'vpnaj']);
const BUNDLED_CODEX_CANDIDATES = Object.freeze([
  '/Applications/ChatGPT.app/Contents/Resources/codex',
  path.join(os.homedir(), 'Applications/ChatGPT.app/Contents/Resources/codex')
]);

function coded(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

async function executable(filePath, accessImpl) {
  try {
    await accessImpl(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveCodexBin({ configured, accessImpl = access, candidates = BUNDLED_CODEX_CANDIDATES } = {}) {
  if (configured !== undefined && configured !== '') {
    if (typeof configured !== 'string' || !(await executable(configured, accessImpl))) {
      throw coded('LLM_AGENT_CODEX_BIN_UNAVAILABLE', `CODEX_BIN is not executable: ${String(configured)}`);
    }
    return configured;
  }
  for (const candidate of candidates) {
    if (await executable(candidate, accessImpl)) return candidate;
  }
  throw coded(
    'LLM_AGENT_CODEX_BIN_UNAVAILABLE',
    'CODEX_BIN is required when the bundled ChatGPT Codex binary is unavailable'
  );
}

async function scriptedProvider(scriptPath, readFileImpl) {
  let source;
  try {
    source = await readFileImpl(scriptPath, 'utf8');
  } catch (cause) {
    throw coded('LLM_AGENT_SCRIPT_INVALID', `LLM agent script could not be read: ${scriptPath}`, cause);
  }
  let decisions;
  try {
    decisions = JSON.parse(source);
  } catch (cause) {
    throw coded('LLM_AGENT_SCRIPT_INVALID', 'LLM agent script must be valid JSON', cause);
  }
  if (!Array.isArray(decisions)) {
    throw coded('LLM_AGENT_SCRIPT_INVALID', 'LLM agent script must contain one JSON array');
  }
  return createScriptedProvider(decisions);
}

function connectionFromEnv(env) {
  const rawPort = env.MC_PORT ?? '25565';
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw coded('LLM_AGENT_CONFIG_INVALID', 'MC_PORT must be an integer between 1 and 65535');
  }
  return {
    host: env.MC_HOST || '127.0.0.1',
    port,
    version: env.MC_VERSION || false,
    auth: env.MC_AUTH || 'offline'
  };
}

export async function startLlmAgentCli({
  env = process.env,
  processImpl = process,
  loadEnvFileImpl = loadEnvFile,
  readFileImpl = readFile,
  accessImpl = access,
  codexCandidates = BUNDLED_CODEX_CANDIDATES,
  hostFactory = createLlmAgentLiveHost
} = {}) {
  await loadEnvFileImpl();

  const actorId = env.LLM_AGENT_USERNAME || 'LlmAgent';
  if (RESERVED_RUNTIME_IDENTITIES.has(actorId.toLowerCase())) {
    throw coded('LLM_AGENT_IDENTITY_RESERVED', `${actorId} is reserved for another live runtime identity`);
  }
  const stateDirectory = path.resolve(env.LLM_AGENT_STATE_DIRECTORY || 'runtime/llm-agent-state');
  const directorStateDirectory = path.resolve(env.LLM_DIRECTOR_STATE_DIRECTORY || 'runtime/llm-director-state');
  const pipelineStateDirectory = path.resolve(env.LLM_PIPELINE_STATE_DIRECTORY || 'runtime/llm-goal-pipeline-state');
  const providerKind = env.LLM_AGENT_SCRIPT_PATH ? 'scripted' : 'codex';
  const codexBin = providerKind === 'codex'
    ? await resolveCodexBin({ configured: env.CODEX_BIN, accessImpl, candidates: codexCandidates })
    : null;
  const provider = providerKind === 'scripted'
    ? await scriptedProvider(env.LLM_AGENT_SCRIPT_PATH, readFileImpl)
    : createCodexProvider({
        codexBin,
        timeoutMs: 30_000,
        tempDirectory: path.join(stateDirectory, '.codex-tmp')
      });
  const directorProvider = providerKind === 'codex' ? createDirectorCodexProvider({
    codexBin,
    timeoutMs: 90_000,
    tempDirectory: path.join(directorStateDirectory, '.codex-tmp')
  }) : undefined;
  const pipelineSlowProvider = providerKind === 'codex' ? createSlowContractProvider({
    codexBin,
    timeoutMs: 90_000,
    tempDirectory: path.join(pipelineStateDirectory, '.slow-codex-tmp')
  }) : undefined;
  const pipelineFastProvider = providerKind === 'codex' ? createFastProvider({
    codexBin,
    timeoutMs: 30_000,
    tempDirectory: path.join(pipelineStateDirectory, '.fast-codex-tmp')
  }) : undefined;

  const rawHost = hostFactory({
    actorId,
    goal: FIRST_GOAL_OBJECTIVE,
    provider,
    providerKind,
    stateDirectory,
    directorProvider,
    directorStateDirectory,
    overallObjective: env.LLM_DIRECTOR_OBJECTIVE || 'advance through small verified Minecraft goals',
    pipelineSlowProvider,
    pipelineFastProvider,
    pipelineStateDirectory,
    pipelineMission: env.LLM_PIPELINE_MISSION || 'survive and progress toward stone tools',
    connection: connectionFromEnv(env)
  });

  let closePromise = null;
  const signals = ['SIGINT', 'SIGTERM'];
  const removeSignalHandlers = () => {
    for (const signal of signals) processImpl.off?.(signal, onSignal);
  };
  const close = () => {
    if (!closePromise) {
      closePromise = Promise.resolve()
        .then(() => rawHost.close())
        .finally(removeSignalHandlers);
    }
    return closePromise;
  };
  const onSignal = async () => {
    try {
      await close();
    } catch (error) {
      processImpl.exitCode = 1;
      console.error(error);
    }
  };
  for (const signal of signals) processImpl.on?.(signal, onSignal);

  try {
    await rawHost.start();
  } catch (error) {
    try {
      await close();
    } catch {
      // Preserve the startup error as the failure reported to the operator.
    }
    throw error;
  }

  return Object.freeze({
    ...rawHost,
    close
  });
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPath === fileURLToPath(import.meta.url)) {
  startLlmAgentCli().catch((error) => {
    process.exitCode = 1;
    console.error(error);
  });
}

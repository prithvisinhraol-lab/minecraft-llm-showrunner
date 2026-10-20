import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateActorState } from '../src/llm-agent/contracts.mjs';
import { COLLECT_OAK_LOG_GOAL } from '../src/llm-agent/goals.mjs';
import { validateDirectorState } from '../src/llm-director/contracts.mjs';

export function evaluateDirectorLiveEvidence({ actorState, directorState, worldCheck = false } = {}) {
  let actor; let director;
  try { actor = validateActorState(actorState); director = validateDirectorState(directorState); } catch {}
  const outcome = director?.outcomes?.[0]; const evidence = actor?.trusted?.evidence; const proof = evidence?.goalProof;
  const checks = {
    directorSucceeded: director?.lifecycle?.status === 'succeeded',
    exactlyOneSelection: director?.limits?.selectionsUsed === 1 && director?.outcomes?.length === 1
      && director?.currentGoalId === COLLECT_OAK_LOG_GOAL.id,
    actorSucceeded: actor?.lifecycle?.status === 'succeeded' && actor?.goal?.id === COLLECT_OAK_LOG_GOAL.id,
    matchingRun: Boolean(actor && outcome && outcome.agentRunId === actor.lifecycle.runId
      && outcome.goalId === actor.goal.id && outcome.status === 'succeeded'),
    liveCollectionProof: Boolean(actor && evidence?.source === 'mineflayer-live' && evidence.simulated === false
      && evidence.provider === 'codex' && evidence.actorId === actor.identity.actorId
      && evidence.runId === actor.lifecycle.runId && proof?.markerBlock === 'gold_block'
      && proof?.aboveBlock === 'air' && proof?.collectedItem === 'oak_log' && proof?.collectedCount >= 1
      && actor.trusted.milestones.includes('mined_oak_log')),
    serverWorldVerified: worldCheck === true
  };
  const ok = Object.values(checks).every(Boolean);
  return { ok, classification: ok ? 'verified-live-director-handoff' : 'not-verified', checks };
}

async function main(argv, env) {
  const phase = argv.includes('--phase') ? argv[argv.indexOf('--phase') + 1] : 'completed';
  const actorPath = path.resolve(env.LLM_AGENT_STATE_PATH || 'runtime/llm-agent-state/LlmAgent.json');
  const directorPath = path.resolve(env.LLM_DIRECTOR_STATE_PATH || 'runtime/llm-director-state/LlmAgent.json');
  if (phase === 'preflight') {
    const actor = JSON.parse(await readFile(actorPath, 'utf8'));
    const proof = actor?.trusted?.evidence?.goalProof;
    const ok = actor?.lifecycle?.status === 'succeeded' && actor?.trusted?.evidence?.source === 'mineflayer-live'
      && proof?.markerBlock === 'gold_block' && proof?.aboveBlock === 'oak_log'
      && env.LLM_DIRECTOR_WORLD_CHECK === 'preflight-ok';
    process.stdout.write(`${JSON.stringify({ phase, ok, stateReady: Boolean(actor), serverWorldVerified: env.LLM_DIRECTOR_WORLD_CHECK === 'preflight-ok' })}\n`);
    if (!ok) process.exitCode = 1;
    return;
  }
  const [actorState, directorState] = await Promise.all([actorPath, directorPath].map(async (file) => JSON.parse(await readFile(file, 'utf8'))));
  const result = evaluateDirectorLiveEvidence({ actorState, directorState, worldCheck: env.LLM_DIRECTOR_WORLD_CHECK === 'completed-ok' });
  process.stdout.write(`${JSON.stringify({ phase, ...result })}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main(process.argv, process.env).catch((error) => { process.exitCode = 1; console.error(error.message); });
}

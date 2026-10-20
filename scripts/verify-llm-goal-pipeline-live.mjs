import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validatePipelineState } from '../src/llm-goal-pipeline/state.mjs';

const MAX_EVIDENCE_AGE_MS = 5 * 60 * 1_000;
const UTC_ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exact(value, keys) {
  return object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function freshTimestamp(value, now) {
  if (typeof value !== 'string' || !UTC_ISO_TIMESTAMP.test(value)) return false;
  const observed = Date.parse(value);
  const evaluated = now instanceof Date ? now.valueOf() : Date.parse(now);
  return Number.isFinite(observed) && Number.isFinite(evaluated)
    && evaluated - observed >= 0 && evaluated - observed <= MAX_EVIDENCE_AGE_MS;
}

function succeededPair(state) {
  if (state.outcomes.length < 2 || state.outcomes.some(({ status }) => status !== 'succeeded')) return null;
  const [first, second] = state.outcomes.slice(-2);
  const linked = state.audit.some((entry) => entry.kind === 'generation_started'
    && entry.contractId === second.contractId && entry.predecessorContractId === first.contractId);
  return linked ? [first, second] : null;
}

function auditIndex(state, kind, contractId) {
  return state.audit.findIndex((entry) => entry.kind === kind && entry.contractId === contractId);
}

function overlapVerified(state, pair) {
  if (!pair) return false;
  const [first, second] = pair;
  const execution = auditIndex(state, 'execution_started', first.contractId);
  const generated = auditIndex(state, 'generation_completed', second.contractId);
  const generationStarted = auditIndex(state, 'generation_started', second.contractId);
  const firstCompletedAt = Date.parse(first.completedAt);
  const generatedEvent = state.audit[generated];
  return execution >= 0 && generationStarted > execution && generated > generationStarted
    && Number.isFinite(firstCompletedAt) && Date.parse(generatedEvent?.observedAt) <= firstCompletedAt;
}

function promotionVerified(state, pair) {
  if (!pair) return false;
  const [first, second] = pair;
  const promotion = state.audit.find((entry) => entry.kind === 'promotion_validated'
    && entry.contractId === second.contractId && entry.predecessorContractId === first.contractId);
  return Boolean(promotion && promotion.relatedObservationVersion > promotion.observationVersion
    && auditIndex(state, 'generation_completed', second.contractId) < auditIndex(state, 'promotion_validated', second.contractId)
    && auditIndex(state, 'promotion_validated', second.contractId) < auditIndex(state, 'execution_started', second.contractId));
}

function contractEvidence(value) {
  return exact(value, ['contractId', 'status', 'proofKinds'])
    && typeof value.contractId === 'string' && value.status === 'succeeded'
    && Array.isArray(value.proofKinds) && value.proofKinds.length > 0
    && value.proofKinds.every((entry) => typeof entry === 'string');
}

function liveEvidenceValid(evidence, state, pair, now) {
  if (!pair || !exact(evidence, ['source', 'simulated', 'provider', 'actorId', 'observedAt', 'contracts', 'inventory'])
    || evidence.source !== 'mineflayer-live' || evidence.simulated !== false || evidence.provider !== 'codex'
    || evidence.actorId !== state.identity.actorId || !freshTimestamp(evidence.observedAt, now)
    || !Array.isArray(evidence.contracts) || evidence.contracts.length < 2
    || !evidence.contracts.every(contractEvidence) || !Array.isArray(evidence.inventory)) return false;
  const contractsMatch = pair.every((outcome) => {
    const proof = evidence.contracts.find(({ contractId }) => contractId === outcome.contractId);
    if (!proof) return false;
    return proof.contractId === outcome.contractId
      && proof.proofKinds.length === outcome.proofKinds.length
      && proof.proofKinds.every((kind) => outcome.proofKinds.includes(kind));
  });
  const stonePickaxe = evidence.inventory.some((entry) => exact(entry, ['item', 'count'])
    && entry.item === 'stone_pickaxe' && Number.isSafeInteger(entry.count) && entry.count >= 1);
  return contractsMatch && stonePickaxe;
}

function noUnverifiedThirdGoal(state, pair) {
  if (!pair || state.activeContract !== null || state.speculativeContract !== null) return false;
  const verified = new Set(state.outcomes.filter(({ status }) => status === 'succeeded').map(({ contractId }) => contractId));
  return !state.audit.some((entry) => entry.kind === 'execution_started' && !verified.has(entry.contractId));
}

function failedResult() {
  return {
    ok: false,
    classification: 'not-verified',
    checks: {
      supervisorSucceeded: false, twoConsecutiveGoals: false,
      speculationOverlappedExecution: false, freshPromotionValidation: false,
      liveFastEvidence: false, withinLimits: false,
      noUnverifiedThirdGoal: false, serverWorldVerified: false
    }
  };
}

export function evaluatePipelineLiveEvidence({ pipelineState, actorEvidence, worldCheck = false, now = new Date() } = {}) {
  let state;
  try { state = validatePipelineState(pipelineState); } catch { return failedResult(); }
  const pair = succeededPair(state);
  const finalProof = pair?.[1]?.proofKinds.includes('inventory_at_least:stone_pickaxe') === true;
  const counters = state.counters;
  const limits = state.limits;
  const checks = {
    supervisorSucceeded: state.lifecycle.status === 'succeeded' && finalProof,
    twoConsecutiveGoals: pair !== null,
    speculationOverlappedExecution: overlapVerified(state, pair),
    freshPromotionValidation: promotionVerified(state, pair),
    liveFastEvidence: liveEvidenceValid(actorEvidence, state, pair, now),
    withinLimits: counters.runtimeMs <= limits.maximumRuntimeMs
      && counters.goalsCompleted >= 2 && counters.goalsCompleted <= limits.maximumGoals
      && counters.slowCalls <= limits.maximumSlowCalls
      && counters.fastCalls <= limits.maximumFastCalls
      && counters.consecutiveGoalFailures < limits.maximumGoalFailures
      && counters.consecutiveGenerationFailures < limits.maximumGenerationFailures,
    noUnverifiedThirdGoal: noUnverifiedThirdGoal(state, pair),
    serverWorldVerified: worldCheck === true
  };
  const ok = Object.values(checks).every(Boolean);
  return { ok, classification: ok ? 'verified-live-generated-pipeline' : 'not-verified', checks };
}

async function main(argv, env) {
  if (argv[2] !== '--phase' || argv[3] !== 'completed' || argv.length !== 4) {
    throw new Error('usage: node scripts/verify-llm-goal-pipeline-live.mjs --phase completed');
  }
  const directory = path.resolve(env.LLM_PIPELINE_STATE_DIRECTORY || 'runtime/llm-goal-pipeline-state');
  const actorId = env.LLM_AGENT_USERNAME || 'LlmAgent';
  const [pipelineSource, evidenceSource] = await Promise.all([
    readFile(path.join(directory, `${actorId}.pipeline.json`), 'utf8'),
    readFile(path.join(directory, `${actorId}.pipeline.live-evidence.json`), 'utf8')
  ]);
  const result = evaluatePipelineLiveEvidence({
    pipelineState: JSON.parse(pipelineSource), actorEvidence: JSON.parse(evidenceSource),
    worldCheck: env.LLM_PIPELINE_WORLD_CHECK === 'completed-ok', now: new Date()
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPath === fileURLToPath(import.meta.url)) {
  main(process.argv, process.env).catch((error) => {
    process.exitCode = 1;
    console.error(error.message);
  });
}

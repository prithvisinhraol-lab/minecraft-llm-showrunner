import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateActorState } from '../src/llm-agent/contracts.mjs';

const MAX_EVIDENCE_AGE_MS = 5 * 60 * 1000;
const UTC_ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function successfulResult(results, predicate) {
  return Array.isArray(results) && results.some((result) => isObject(result)
    && result.ok === true && predicate(result));
}

function isMarker(value) {
  return isObject(value) && Object.keys(value).length === 4
    && ['dimension', 'x', 'y', 'z'].every((key) => Object.hasOwn(value, key))
    && typeof value.dimension === 'string' && value.dimension.length > 0
    && Number.isSafeInteger(value.x) && Number.isSafeInteger(value.y) && Number.isSafeInteger(value.z);
}

function sameMarker(left, right) {
  return isMarker(left) && isMarker(right)
    && left.dimension === right.dimension && left.x === right.x && left.y === right.y && left.z === right.z;
}

function liveObservation(evidence, state, now) {
  if (!isObject(evidence) || evidence.source !== 'mineflayer-live' || evidence.simulated !== false || evidence.provider !== 'codex') return false;
  if (evidence.actorId !== state?.identity?.actorId || evidence.runId !== state?.lifecycle?.runId) return false;
  if (typeof evidence.observedAt !== 'string' || !UTC_ISO_TIMESTAMP.test(evidence.observedAt)
    || new Date(evidence.observedAt).toISOString() !== evidence.observedAt) return false;
  const observedAt = Date.parse(evidence.observedAt);
  const evaluatedAt = now instanceof Date ? now.valueOf() : Date.parse(now);
  if (!Number.isFinite(observedAt) || !Number.isFinite(evaluatedAt)) return false;
  const age = evaluatedAt - observedAt;
  return age >= 0 && age <= MAX_EVIDENCE_AGE_MS;
}

function markerProof(evidence, results) {
  const proof = evidence?.goalProof;
  if (!isObject(proof) || typeof proof.markerTargetId !== 'string' || proof.markerTargetId.length === 0
    || proof.markerBlock !== 'gold_block' || proof.aboveBlock !== 'oak_log') return false;
  return successfulResult(results, (result) => result.action === 'place_on_block'
    && result.code === 'OAK_LOG_PLACEMENT_VERIFIED' && result.targetId === proof.markerTargetId
    && sameMarker(result.marker, proof.marker));
}

export function evaluateLiveEvidence({ state, now = new Date() } = {}) {
  let validated;
  try {
    validated = validateActorState(state);
  } catch {
    const checks = {
      controllerSucceeded: false,
      minedOakLog: false,
      oakLogAboveGoldMarker: false,
      liveObservation: false
    };
    return { ok: false, classification: 'not-verified', checks };
  }
  const trusted = validated.trusted;
  const results = trusted?.recentActionResults;
  const checks = {
    controllerSucceeded: validated.lifecycle.status === 'succeeded',
    minedOakLog: Array.isArray(trusted?.milestones)
      && trusted.milestones.filter((milestone) => milestone === 'mined_oak_log').length === 1
      && successfulResult(results, (result) => result.action === 'mine_block' && result.code === 'OAK_LOG_MINING_VERIFIED'),
    oakLogAboveGoldMarker: markerProof(trusted?.evidence, results),
    liveObservation: liveObservation(trusted?.evidence, validated, now)
  };
  const ok = Object.values(checks).every(Boolean);
  return { ok, classification: ok ? 'real-server-evidence' : 'not-verified', checks };
}

async function main(argv) {
  const actorStatePath = argv[2];
  if (typeof actorStatePath !== 'string' || actorStatePath.length === 0) {
    throw new Error('usage: npm run llm-agent:verify-live -- runtime/llm-agent-state/LlmAgent.json');
  }
  const source = await readFile(path.resolve(actorStatePath), 'utf8');
  const state = JSON.parse(source);
  const result = evaluateLiveEvidence({ state, now: new Date() });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPath === fileURLToPath(import.meta.url)) {
  main(process.argv).catch((error) => {
    process.exitCode = 1;
    console.error(error.message);
  });
}

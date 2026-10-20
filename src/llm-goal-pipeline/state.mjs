import { createContractRequestFences, validateGeneratedContract } from './contracts.mjs';

export const PIPELINE_LIMITS = Object.freeze({
  maximumRuntimeMs: 5_400_000,
  maximumGoals: 10,
  maximumSlowCalls: 20,
  maximumFastCalls: 400,
  maximumGoalFailures: 3,
  maximumGenerationFailures: 3
});

const STATUSES = new Set(['idle', 'running', 'paused', 'stopped', 'succeeded', 'failed']);
const CONTRACT_STATUSES = new Set(['validated', 'speculative', 'ready', 'executing', 'verifying', 'succeeded', 'failed', 'stopped', 'invalidated']);
const ACTOR_ID = /^[A-Za-z0-9_-]{1,32}$/;
const IDENTIFIER = /^[A-Za-z0-9_.:/-]{1,100}$/;
const AUDIT_KINDS = new Set([
  'generation_started', 'generation_completed', 'execution_started', 'promotion_validated'
]);

function fail(message) {
  const error = new Error(message);
  error.code = 'PIPELINE_STATE_INVALID';
  throw error;
}

function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exact(value, keys, label) {
  if (!plain(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail(`${label} contains unknown or missing fields`);
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  return value;
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function identifier(value, label, pattern = IDENTIFIER) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(`${label} is invalid`);
}

function text(value, maximum, label, { empty = false } = {}) {
  if (typeof value !== 'string' || (!empty && value.trim().length === 0) || Array.from(value).length > maximum) fail(`${label} is invalid`);
}

function timestamp(value, label, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail(`${label} is invalid`);
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(`${label} is invalid`);
}

function validateContractSlot(value) {
  if (value === null) return null;
  exact(value, ['status', 'proposal', 'fences', 'compiledAt', 'expiresAt'], 'contract slot');
  if (!CONTRACT_STATUSES.has(value.status)) fail('contract status is invalid');
  const fences = createContractRequestFences(value.fences);
  const proposal = validateGeneratedContract(value.proposal, fences);
  timestamp(value.compiledAt, 'contract compiledAt');
  timestamp(value.expiresAt, 'contract expiresAt');
  if (Date.parse(value.expiresAt) <= Date.parse(value.compiledAt)) fail('contract expiry is invalid');
  return { status: value.status, proposal, fences, compiledAt: value.compiledAt, expiresAt: value.expiresAt };
}

function validateQuestion(value) {
  if (value === null) return null;
  exact(value, ['contractId', 'prompt', 'choices', 'defaultChoiceId', 'expiresAt', 'answeredChoiceId'], 'pending question');
  identifier(value.contractId, 'question contractId');
  text(value.prompt, 200, 'question prompt');
  if (!Array.isArray(value.choices) || value.choices.length < 2 || value.choices.length > 3) fail('question choices are invalid');
  const ids = new Set();
  const choices = value.choices.map((choice) => {
    exact(choice, ['id', 'label'], 'question choice');
    identifier(choice.id, 'question choice ID');
    text(choice.label, 80, 'question choice label');
    if (ids.has(choice.id)) fail('question choice IDs are duplicated');
    ids.add(choice.id);
    return clone(choice);
  });
  if (!ids.has(value.defaultChoiceId) || (value.answeredChoiceId !== null && !ids.has(value.answeredChoiceId))) fail('question selection is invalid');
  timestamp(value.expiresAt, 'question expiresAt');
  return { contractId: value.contractId, prompt: value.prompt, choices, defaultChoiceId: value.defaultChoiceId, expiresAt: value.expiresAt, answeredChoiceId: value.answeredChoiceId };
}

function validateOutcome(value) {
  exact(value, ['contractId', 'status', 'proofKinds', 'summary', 'completedAt'], 'outcome');
  identifier(value.contractId, 'outcome contractId');
  if (!new Set(['succeeded', 'failed', 'stopped']).has(value.status)) fail('outcome status is invalid');
  if (!Array.isArray(value.proofKinds) || value.proofKinds.length === 0 || value.proofKinds.length > 16) fail('outcome proofKinds are invalid');
  const proofKinds = value.proofKinds.map((entry) => { identifier(entry, 'outcome proof kind'); return entry; });
  if (new Set(proofKinds).size !== proofKinds.length) fail('outcome proofKinds are duplicated');
  text(value.summary, 500, 'outcome summary', { empty: true });
  timestamp(value.completedAt, 'outcome completedAt');
  return { ...clone(value), proofKinds };
}

function validateFence(value) {
  exact(value, ['kind', 'key', 'code', 'count', 'observedAt'], 'failure fence');
  if (!new Set(['action', 'target', 'generation', 'goal']).has(value.kind)) fail('failure fence kind is invalid');
  identifier(value.key, 'failure fence key');
  identifier(value.code, 'failure fence code');
  integer(value.count, 1, 400, 'failure fence count');
  timestamp(value.observedAt, 'failure fence observedAt');
  return clone(value);
}

function validateAuditEvent(value) {
  exact(value, [
    'kind', 'contractId', 'predecessorContractId', 'observationVersion',
    'relatedObservationVersion', 'observedAt'
  ], 'audit event');
  if (!AUDIT_KINDS.has(value.kind)) fail('audit event kind is invalid');
  identifier(value.contractId, 'audit contractId');
  if (value.predecessorContractId !== null) identifier(value.predecessorContractId, 'audit predecessorContractId');
  integer(value.observationVersion, 1, Number.MAX_SAFE_INTEGER, 'audit observationVersion');
  if (value.relatedObservationVersion !== null) {
    integer(value.relatedObservationVersion, 1, Number.MAX_SAFE_INTEGER, 'audit relatedObservationVersion');
  }
  if (value.kind === 'promotion_validated') {
    if (value.predecessorContractId === null
      || value.relatedObservationVersion === null
      || value.relatedObservationVersion <= value.observationVersion) {
      fail('promotion audit observation is not fresh');
    }
  } else if (value.relatedObservationVersion !== null) {
    fail('audit relatedObservationVersion is invalid');
  }
  timestamp(value.observedAt, 'audit observedAt');
  return clone(value);
}

export function validatePipelineState(value) {
  exact(value, [
    'identity', 'mission', 'lifecycle', 'activeContract', 'speculativeContract',
    'pendingQuestion', 'outcomes', 'failureFences', 'audit', 'counters', 'limits', 'failure'
  ], 'pipeline state');
  exact(value.identity, ['actorId', 'schemaVersion'], 'identity');
  identifier(value.identity.actorId, 'actorId', ACTOR_ID);
  if (value.identity.schemaVersion !== 1) fail('schema version is invalid');
  exact(value.mission, ['text', 'version'], 'mission');
  text(value.mission.text, 300, 'mission text');
  integer(value.mission.version, 1, Number.MAX_SAFE_INTEGER, 'mission version');
  exact(value.lifecycle, ['status', 'createdAt', 'updatedAt', 'startedAt', 'finishedAt'], 'lifecycle');
  if (!STATUSES.has(value.lifecycle.status)) fail('lifecycle status is invalid');
  timestamp(value.lifecycle.createdAt, 'createdAt');
  timestamp(value.lifecycle.updatedAt, 'updatedAt');
  timestamp(value.lifecycle.startedAt, 'startedAt', true);
  timestamp(value.lifecycle.finishedAt, 'finishedAt', true);
  const activeContract = validateContractSlot(value.activeContract);
  const speculativeContract = validateContractSlot(value.speculativeContract);
  const pendingQuestion = validateQuestion(value.pendingQuestion);
  if (!Array.isArray(value.outcomes) || !Array.isArray(value.failureFences) || !Array.isArray(value.audit)) fail('bounded histories are invalid');
  const outcomes = value.outcomes.map(validateOutcome).slice(-5);
  const failureFences = value.failureFences.map(validateFence).slice(-10);
  const audit = value.audit.map(validateAuditEvent).slice(-40);
  exact(value.counters, [
    'runtimeMs', 'goalsCompleted', 'slowCalls', 'fastCalls',
    'consecutiveGoalFailures', 'consecutiveGenerationFailures'
  ], 'counters');
  const limits = PIPELINE_LIMITS;
  integer(value.counters.runtimeMs, 0, limits.maximumRuntimeMs, 'runtimeMs');
  integer(value.counters.goalsCompleted, 0, limits.maximumGoals, 'goalsCompleted');
  integer(value.counters.slowCalls, 0, limits.maximumSlowCalls, 'slowCalls');
  integer(value.counters.fastCalls, 0, limits.maximumFastCalls, 'fastCalls');
  integer(value.counters.consecutiveGoalFailures, 0, limits.maximumGoalFailures, 'consecutiveGoalFailures');
  integer(value.counters.consecutiveGenerationFailures, 0, limits.maximumGenerationFailures, 'consecutiveGenerationFailures');
  if (JSON.stringify(value.limits) !== JSON.stringify(limits)) fail('pipeline limits are invalid');
  if (value.failure !== null) {
    exact(value.failure, ['code', 'message', 'observedAt'], 'failure');
    identifier(value.failure.code, 'failure code');
    text(value.failure.message, 500, 'failure message');
    timestamp(value.failure.observedAt, 'failure observedAt');
  }
  return freeze({
    identity: clone(value.identity), mission: clone(value.mission), lifecycle: clone(value.lifecycle),
    activeContract, speculativeContract, pendingQuestion, outcomes, failureFences, audit,
    counters: clone(value.counters), limits: { ...limits }, failure: clone(value.failure)
  });
}

export function createInitialPipelineState({ actorId, mission, now } = {}) {
  return validatePipelineState({
    identity: { actorId, schemaVersion: 1 },
    mission: { text: mission, version: 1 },
    lifecycle: { status: 'idle', createdAt: now, updatedAt: now, startedAt: null, finishedAt: null },
    activeContract: null,
    speculativeContract: null,
    pendingQuestion: null,
    outcomes: [],
    failureFences: [],
    audit: [],
    counters: {
      runtimeMs: 0, goalsCompleted: 0, slowCalls: 0, fastCalls: 0,
      consecutiveGoalFailures: 0, consecutiveGenerationFailures: 0
    },
    limits: { ...PIPELINE_LIMITS },
    failure: null
  });
}

const SCHEMA_VERSION = 1;
const MAX_OUTCOMES = 5;
const MAX_ELIGIBLE_GOALS = 5;
const MAX_REASON_CHARACTERS = 300;
const MAX_SUMMARY_CHARACTERS = 500;
const STATUSES = new Set(['idle', 'running', 'succeeded', 'failed', 'stopped']);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function isObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function exact(value, keys, code, label) {
  if (!isObject(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    fail(code, `${label} contains unknown or missing fields`);
  }
}

function nonempty(value, max, code, label) {
  if (typeof value !== 'string' || value.trim().length === 0 || Array.from(value).length > max) {
    fail(code, `${label} is invalid`);
  }
  return value;
}

function nullableTimestamp(value, code, label) {
  if (value !== null && (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))) fail(code, `${label} is invalid`);
  return value;
}

function validateOutcome(value) {
  const code = 'LLM_DIRECTOR_STATE_INVALID';
  exact(value, ['goalId', 'status', 'agentRunId', 'completedAt', 'summary', 'proof'], code, 'outcome');
  nonempty(value.goalId, 100, code, 'outcome goalId');
  if (!new Set(['succeeded', 'failed', 'stopped']).has(value.status)) fail(code, 'outcome status is invalid');
  nonempty(value.agentRunId, 200, code, 'outcome agentRunId');
  nullableTimestamp(value.completedAt, code, 'outcome completedAt');
  if (typeof value.summary !== 'string' || Array.from(value.summary).length > MAX_SUMMARY_CHARACTERS) fail(code, 'outcome summary is invalid');
  exact(value.proof, ['kind'], code, 'outcome proof');
  nonempty(value.proof.kind, 100, code, 'outcome proof kind');
  return clone(value);
}

export function validateDirectorState(value) {
  const code = 'LLM_DIRECTOR_STATE_INVALID';
  exact(value, ['identity', 'overallObjective', 'lifecycle', 'currentGoalId', 'outcomes', 'decision', 'limits', 'failure'], code, 'director state');
  exact(value.identity, ['actorId', 'schemaVersion'], code, 'identity');
  nonempty(value.identity.actorId, 32, code, 'actorId');
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(value.identity.actorId) || value.identity.schemaVersion !== SCHEMA_VERSION) fail(code, 'identity is invalid');
  nonempty(value.overallObjective, 500, code, 'overall objective');

  exact(value.lifecycle, ['runId', 'status', 'createdAt', 'updatedAt', 'startedAt', 'finishedAt'], code, 'lifecycle');
  nonempty(value.lifecycle.runId, 200, code, 'runId');
  if (!STATUSES.has(value.lifecycle.status)) fail(code, 'lifecycle status is invalid');
  nullableTimestamp(value.lifecycle.createdAt, code, 'createdAt');
  nullableTimestamp(value.lifecycle.updatedAt, code, 'updatedAt');
  nullableTimestamp(value.lifecycle.startedAt, code, 'startedAt');
  nullableTimestamp(value.lifecycle.finishedAt, code, 'finishedAt');
  if (value.lifecycle.createdAt === null || value.lifecycle.updatedAt === null) fail(code, 'required lifecycle timestamp is missing');

  if (value.currentGoalId !== null) nonempty(value.currentGoalId, 100, code, 'currentGoalId');
  if (!Array.isArray(value.outcomes)) fail(code, 'outcomes must be an array');
  exact(value.decision, ['reason', 'stateSummary'], code, 'decision');
  if (typeof value.decision.reason !== 'string' || Array.from(value.decision.reason).length > MAX_REASON_CHARACTERS
    || typeof value.decision.stateSummary !== 'string' || Array.from(value.decision.stateSummary).length > MAX_SUMMARY_CHARACTERS) {
    fail(code, 'persisted decision text is invalid');
  }
  exact(value.limits, ['maxSelections', 'selectionsUsed'], code, 'limits');
  if (value.limits.maxSelections !== 1 || !Number.isSafeInteger(value.limits.selectionsUsed)
    || value.limits.selectionsUsed < 0 || value.limits.selectionsUsed > 1) fail(code, 'director limits are invalid');
  if (value.failure !== null) {
    exact(value.failure, ['code', 'message'], code, 'failure');
    nonempty(value.failure.code, 100, code, 'failure code');
    nonempty(value.failure.message, 500, code, 'failure message');
  }

  return deepFreeze({
    identity: clone(value.identity),
    overallObjective: value.overallObjective,
    lifecycle: clone(value.lifecycle),
    currentGoalId: value.currentGoalId,
    outcomes: value.outcomes.map(validateOutcome).slice(-MAX_OUTCOMES),
    decision: clone(value.decision),
    limits: clone(value.limits),
    failure: clone(value.failure)
  });
}

export function createInitialDirectorState({ actorId, runId, now, overallObjective } = {}) {
  const timestamp = now instanceof Date ? now.toISOString() : now;
  return validateDirectorState({
    identity: { actorId, schemaVersion: SCHEMA_VERSION },
    overallObjective,
    lifecycle: {
      runId, status: 'idle', createdAt: timestamp, updatedAt: timestamp,
      startedAt: null, finishedAt: null
    },
    currentGoalId: null,
    outcomes: [],
    decision: { reason: '', stateSummary: '' },
    limits: { maxSelections: 1, selectionsUsed: 0 },
    failure: null
  });
}

export function validateDirectorDecision(value, eligibleGoalIds) {
  const code = 'LLM_DIRECTOR_DECISION_INVALID';
  exact(value, ['decision', 'goalId', 'reason', 'stateSummary'], code, 'director decision');
  if (!new Set(['select_goal', 'stop']).has(value.decision)) fail(code, 'decision is unsupported');
  nonempty(value.reason, MAX_REASON_CHARACTERS, code, 'reason');
  if (typeof value.stateSummary !== 'string' || Array.from(value.stateSummary).length > MAX_SUMMARY_CHARACTERS) {
    fail(code, 'stateSummary is invalid');
  }
  if (value.decision === 'select_goal') {
    if (typeof value.goalId !== 'string' || !eligibleGoalIds.includes(value.goalId)) fail(code, 'goalId is not eligible');
  } else if (value.goalId !== null) fail(code, 'stop must use a null goalId');
  return deepFreeze(clone(value));
}

function publicGoal(goal) {
  if (!isObject(goal)) fail('LLM_DIRECTOR_CONTEXT_INVALID', 'eligible goal is invalid');
  exact(goal, ['goalId', 'objective', 'successKind'], 'LLM_DIRECTOR_CONTEXT_INVALID', 'eligible goal');
  return clone(goal);
}

function publicGoalProof(value) {
  if (!isObject(value) || typeof value.markerTargetId !== 'string' || value.markerTargetId.length === 0
    || value.markerBlock !== 'gold_block' || !new Set(['oak_log', 'air']).has(value.aboveBlock)
    || !isObject(value.marker) || typeof value.marker.dimension !== 'string'
    || !Number.isSafeInteger(value.marker.x) || !Number.isSafeInteger(value.marker.y)
    || !Number.isSafeInteger(value.marker.z)) return null;
  return {
    markerTargetId: value.markerTargetId,
    marker: {
      dimension: value.marker.dimension,
      x: value.marker.x,
      y: value.marker.y,
      z: value.marker.z
    },
    markerBlock: 'gold_block',
    aboveBlock: value.aboveBlock
  };
}

export function toDirectorContext(state, eligibleGoalEntries, latestAgentState) {
  const validated = validateDirectorState(state);
  if (!Array.isArray(eligibleGoalEntries)) fail('LLM_DIRECTOR_CONTEXT_INVALID', 'eligible goals must be an array');
  return deepFreeze({
    schemaVersion: SCHEMA_VERSION,
    actorId: validated.identity.actorId,
    overallObjective: validated.overallObjective,
    eligibleGoals: eligibleGoalEntries.slice(0, MAX_ELIGIBLE_GOALS).map(publicGoal),
    recentOutcomes: clone(validated.outcomes.slice(-MAX_OUTCOMES)),
    latestGoalProof: publicGoalProof(latestAgentState?.trusted?.evidence?.goalProof),
    remainingInvocations: validated.limits.maxSelections - validated.limits.selectionsUsed
  });
}

import {
  MAX_GOAL_TURNS,
  PLACE_OAK_LOG_GOAL,
  validateAgentGoal
} from './goals.mjs';

const STATE_SCHEMA_VERSION = 1;

export const ACTION_NAMES = Object.freeze([
  'observe',
  'move_to_block',
  'navigate_to_landmark',
  'mine_block',
  'select_item',
  'place_on_block',
  'finish'
]);

export const MAX_TURNS = MAX_GOAL_TURNS;
export const MAX_SUMMARY_CHARACTERS = 500;
export const MAX_RECENT_RESULTS = MAX_TURNS;

const MAX_EXPLANATORY_CHARACTERS = 200;
const MAX_PLAN_ENTRIES = 5;
const MAX_VARIABLES = 16;
const TARGET_ACTIONS = new Set(['move_to_block', 'mine_block', 'place_on_block']);
const ACTION_KEYS = new Map([
  ['observe', new Set(['action', 'reason', 'summary', 'plan', 'subgoal', 'variables'])],
  ['finish', new Set(['action', 'reason', 'summary', 'plan', 'subgoal', 'variables'])],
  ['move_to_block', new Set(['action', 'targetId', 'reason', 'summary', 'plan', 'subgoal', 'variables'])],
  ['navigate_to_landmark', new Set(['action', 'reference', 'reason', 'summary', 'plan', 'subgoal', 'variables'])],
  ['mine_block', new Set(['action', 'targetId', 'reason', 'summary', 'plan', 'subgoal', 'variables'])],
  ['place_on_block', new Set(['action', 'targetId', 'reason', 'summary', 'plan', 'subgoal', 'variables'])],
  ['select_item', new Set(['action', 'item', 'reason', 'summary', 'plan', 'subgoal', 'variables'])]
]);

const EVIDENCE_SOURCES = new Set(['mineflayer-live', 'simulated']);
const EVIDENCE_PROVIDERS = new Set(['codex', 'scripted']);
const UTC_ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const FIRST_GOAL_OBJECTIVE = PLACE_OAK_LOG_GOAL.objective;
const LIFECYCLE_STATUSES = new Set(['idle', 'running', 'stopped', 'succeeded', 'failed']);

class ContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ContractError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ContractError(code, message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownKeys(value) {
  return Object.keys(value);
}

function hasExactKeys(value, expected, code, label) {
  const actual = new Set(ownKeys(value));
  if (actual.size !== expected.size || [...expected].some((key) => !actual.has(key))) {
    fail(code, `${label} contains unknown or missing fields`);
  }
}

function characterLength(value) {
  return Array.from(value).length;
}

function requireString(value, label, { max = MAX_EXPLANATORY_CHARACTERS, nonEmpty = false } = {}) {
  if (typeof value !== 'string' || (nonEmpty && value.trim().length === 0)) {
    fail('LLM_AGENT_DECISION_INVALID', `${label} must be a ${nonEmpty ? 'nonempty ' : ''}string`);
  }
  if (characterLength(value) > max) fail('LLM_AGENT_DECISION_INVALID', `${label} is too long`);
  return value;
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isJsonScalar(value) {
  return value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}

function validateVariables(value, code = 'LLM_AGENT_DECISION_INVALID') {
  if (!isPlainObject(value)) fail(code, 'variables must be an object');
  const entries = Object.entries(value);
  if (entries.length > MAX_VARIABLES) fail(code, `variables may contain at most ${MAX_VARIABLES} keys`);
  for (const [key, child] of entries) {
    if (key.length === 0) fail(code, 'variable names must not be empty');
    if (!isJsonScalar(child)) fail(code, `variable ${key} must be a JSON scalar`);
    if (typeof child === 'string' && characterLength(child) > MAX_EXPLANATORY_CHARACTERS) {
      fail(code, `variable ${key} is too long`);
    }
  }
  return clone(value);
}

function normalizeGoal(goal) {
  try {
    return clone(validateAgentGoal(goal));
  } catch (error) {
    fail('LLM_AGENT_STATE_INVALID', error instanceof Error ? error.message : 'goal is unsupported');
  }
}

function normalizeNow(now) {
  if (now instanceof Date) {
    if (Number.isNaN(now.valueOf())) fail('LLM_AGENT_STATE_INVALID', 'now must be a valid date');
    return now.toISOString();
  }
  if (typeof now !== 'string' || now.length === 0) fail('LLM_AGENT_STATE_INVALID', 'now must be a timestamp string');
  return now;
}

function validateMarkerIdentity(value, label) {
  if (!isPlainObject(value)) fail('LLM_AGENT_STATE_INVALID', `${label} is invalid`);
  hasExactKeys(value, new Set(['dimension', 'x', 'y', 'z']), 'LLM_AGENT_STATE_INVALID', label);
  if (typeof value.dimension !== 'string' || value.dimension.length === 0
    || !Number.isSafeInteger(value.x) || !Number.isSafeInteger(value.y) || !Number.isSafeInteger(value.z)) {
    fail('LLM_AGENT_STATE_INVALID', `${label} is invalid`);
  }
  return clone(value);
}

function validateEvidence(value) {
  if (!isPlainObject(value)) fail('LLM_AGENT_STATE_INVALID', 'trusted evidence must be an object');
  hasExactKeys(value, new Set(['source', 'simulated', 'provider', 'actorId', 'runId', 'observedAt', 'goalProof']), 'LLM_AGENT_STATE_INVALID', 'trusted evidence');
  if (!EVIDENCE_SOURCES.has(value.source)) fail('LLM_AGENT_STATE_INVALID', 'trusted evidence source is invalid');
  if (typeof value.simulated !== 'boolean' || value.simulated !== (value.source === 'simulated')) {
    fail('LLM_AGENT_STATE_INVALID', 'trusted evidence simulation status is invalid');
  }
  if (!EVIDENCE_PROVIDERS.has(value.provider)) fail('LLM_AGENT_STATE_INVALID', 'trusted evidence provider is invalid');
  if (typeof value.actorId !== 'string' || value.actorId.length === 0 || value.actorId.includes('/') || value.actorId.includes('\\')) {
    fail('LLM_AGENT_STATE_INVALID', 'trusted evidence actorId is invalid');
  }
  if (typeof value.runId !== 'string' || value.runId.length === 0) fail('LLM_AGENT_STATE_INVALID', 'trusted evidence runId is invalid');
  if (typeof value.observedAt !== 'string' || !UTC_ISO_TIMESTAMP.test(value.observedAt)
    || !Number.isFinite(Date.parse(value.observedAt)) || new Date(value.observedAt).toISOString() !== value.observedAt) {
    fail('LLM_AGENT_STATE_INVALID', 'trusted evidence observedAt is invalid');
  }
  if (value.goalProof !== null) {
    if (!isPlainObject(value.goalProof)) fail('LLM_AGENT_STATE_INVALID', 'trusted evidence goalProof is invalid');
    const placement = value.goalProof.aboveBlock === 'oak_log';
    hasExactKeys(
      value.goalProof,
      placement
        ? new Set(['markerTargetId', 'marker', 'markerBlock', 'aboveBlock'])
        : new Set(['markerTargetId', 'marker', 'markerBlock', 'aboveBlock', 'collectedItem', 'collectedCount']),
      'LLM_AGENT_STATE_INVALID',
      'trusted evidence goalProof'
    );
    if (typeof value.goalProof.markerTargetId !== 'string' || value.goalProof.markerTargetId.length === 0
      || value.goalProof.markerBlock !== 'gold_block'
      || (placement
        ? value.goalProof.aboveBlock !== 'oak_log'
        : value.goalProof.aboveBlock !== 'air' || value.goalProof.collectedItem !== 'oak_log'
          || !Number.isSafeInteger(value.goalProof.collectedCount) || value.goalProof.collectedCount < 1)) {
      fail('LLM_AGENT_STATE_INVALID', 'trusted evidence goalProof is invalid');
    }
    validateMarkerIdentity(value.goalProof.marker, 'trusted evidence goalProof marker');
  }
  return clone(value);
}

function validateStateSections(value) {
  if (!isPlainObject(value)) fail('LLM_AGENT_STATE_INVALID', 'actor state must be an object');
  hasExactKeys(value, new Set(['identity', 'lifecycle', 'goal', 'trusted', 'working', 'limits']), 'LLM_AGENT_STATE_INVALID', 'actor state');

  const { identity, lifecycle, goal, trusted, working, limits } = value;
  if (!isPlainObject(identity)) fail('LLM_AGENT_STATE_INVALID', 'identity must be an object');
  hasExactKeys(identity, new Set(['actorId', 'schemaVersion']), 'LLM_AGENT_STATE_INVALID', 'identity');
  if (typeof identity.actorId !== 'string' || identity.actorId.length === 0 || identity.actorId.includes('/') || identity.actorId.includes('\\')) {
    fail('LLM_AGENT_STATE_INVALID', 'identity actorId is invalid');
  }
  if (identity.schemaVersion !== STATE_SCHEMA_VERSION) fail('LLM_AGENT_STATE_INVALID', 'unknown actor state schema version');

  if (!isPlainObject(lifecycle)) fail('LLM_AGENT_STATE_INVALID', 'lifecycle must be an object');
  hasExactKeys(lifecycle, new Set(['runId', 'status', 'createdAt', 'updatedAt', 'startedAt', 'finishedAt']), 'LLM_AGENT_STATE_INVALID', 'lifecycle');
  if (typeof lifecycle.runId !== 'string' || lifecycle.runId.length === 0) fail('LLM_AGENT_STATE_INVALID', 'lifecycle runId is invalid');
  if (!LIFECYCLE_STATUSES.has(lifecycle.status)) fail('LLM_AGENT_STATE_INVALID', 'lifecycle status is invalid');
  for (const field of ['createdAt', 'updatedAt']) {
    if (typeof lifecycle[field] !== 'string' || lifecycle[field].length === 0) fail('LLM_AGENT_STATE_INVALID', `${field} is invalid`);
  }
  for (const field of ['startedAt', 'finishedAt']) {
    if (lifecycle[field] !== null && typeof lifecycle[field] !== 'string') fail('LLM_AGENT_STATE_INVALID', `${field} is invalid`);
  }

  const normalizedGoal = normalizeGoal(goal);
  if (!isPlainObject(trusted)) fail('LLM_AGENT_STATE_INVALID', 'trusted must be an object');
  hasExactKeys(trusted, new Set(['phase', 'milestones', 'recentObservations', 'recentActionResults', 'evidence']), 'LLM_AGENT_STATE_INVALID', 'trusted');
  if (typeof trusted.phase !== 'string' || trusted.phase.length === 0) fail('LLM_AGENT_STATE_INVALID', 'trusted phase is invalid');
  if (!Array.isArray(trusted.milestones) || trusted.milestones.some((item) => typeof item !== 'string')
    || new Set(trusted.milestones).size !== trusted.milestones.length) fail('LLM_AGENT_STATE_INVALID', 'milestones are invalid');
  if (!Array.isArray(trusted.recentObservations) || !Array.isArray(trusted.recentActionResults)) fail('LLM_AGENT_STATE_INVALID', 'trusted history is invalid');
  const normalizedEvidence = validateEvidence(trusted.evidence);

  if (!isPlainObject(working)) fail('LLM_AGENT_STATE_INVALID', 'working must be an object');
  hasExactKeys(working, new Set(['summary', 'plan', 'subgoal', 'variables']), 'LLM_AGENT_STATE_INVALID', 'working');
  if (typeof working.summary !== 'string' || characterLength(working.summary) > MAX_SUMMARY_CHARACTERS) fail('LLM_AGENT_STATE_INVALID', 'working summary is invalid');
  if (!Array.isArray(working.plan) || working.plan.length > MAX_PLAN_ENTRIES || working.plan.some((item) => typeof item !== 'string' || item.trim().length === 0 || characterLength(item) > MAX_EXPLANATORY_CHARACTERS)) {
    fail('LLM_AGENT_STATE_INVALID', 'working plan is invalid');
  }
  if (typeof working.subgoal !== 'string' || characterLength(working.subgoal) > MAX_EXPLANATORY_CHARACTERS) fail('LLM_AGENT_STATE_INVALID', 'working subgoal is invalid');
  validateVariables(working.variables, 'LLM_AGENT_STATE_INVALID');

  if (!isPlainObject(limits)) fail('LLM_AGENT_STATE_INVALID', 'limits must be an object');
  hasExactKeys(limits, new Set([
    'maxTurns', 'decisionTimeoutMs', 'actionTimeoutMs', 'runTimeoutMs',
    'maxInvalidResponses', 'maxIdenticalFailures', 'turnsUsed', 'invalidResponses',
    'repeatedFailures', 'deadline'
  ]), 'LLM_AGENT_STATE_INVALID', 'limits');
  for (const field of ['maxTurns', 'decisionTimeoutMs', 'actionTimeoutMs', 'runTimeoutMs', 'maxInvalidResponses', 'maxIdenticalFailures', 'turnsUsed', 'invalidResponses', 'repeatedFailures']) {
    if (!Number.isInteger(limits[field]) || limits[field] < 0) fail('LLM_AGENT_STATE_INVALID', `${field} is invalid`);
  }
  if (limits.maxTurns !== MAX_TURNS || limits.turnsUsed > MAX_TURNS) fail('LLM_AGENT_STATE_INVALID', 'decision limit exceeds the fixed turn ceiling');
  if (limits.deadline !== null && typeof limits.deadline !== 'string') fail('LLM_AGENT_STATE_INVALID', 'deadline is invalid');

  return {
    identity: clone(identity),
    lifecycle: clone(lifecycle),
    goal: normalizedGoal,
    trusted: {
      ...clone(trusted),
      evidence: normalizedEvidence,
      recentActionResults: clone(trusted.recentActionResults).slice(-MAX_RECENT_RESULTS)
    },
    working: clone(working),
    limits: clone(limits)
  };
}

export function createInitialActorState({ actorId, runId, now, goal }) {
  const timestamp = normalizeNow(now);
  const state = {
    identity: { actorId, schemaVersion: STATE_SCHEMA_VERSION },
    lifecycle: {
      runId,
      status: 'idle',
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: null,
      finishedAt: null
    },
    goal: normalizeGoal(goal),
    trusted: {
      phase: 'starting', milestones: [], recentObservations: [], recentActionResults: [],
      evidence: { source: 'simulated', simulated: true, provider: 'scripted', actorId, runId, observedAt: timestamp, goalProof: null }
    },
    working: { summary: '', plan: [], subgoal: '', variables: {} },
    limits: {
      maxTurns: MAX_TURNS,
      decisionTimeoutMs: 30_000,
      actionTimeoutMs: 30_000,
      runTimeoutMs: 300_000,
      maxInvalidResponses: 3,
      maxIdenticalFailures: 3,
      turnsUsed: 0,
      invalidResponses: 0,
      repeatedFailures: 0,
      deadline: null
    }
  };
  return validateActorState(state);
}

export function validateActorState(value) {
  try {
    return deepFreeze(validateStateSections(value));
  } catch (error) {
    if (error?.code === 'LLM_AGENT_STATE_INVALID') throw error;
    fail('LLM_AGENT_STATE_INVALID', error instanceof Error ? error.message : 'actor state is invalid');
  }
}

function validateObservationTargets(observation) {
  if (!isPlainObject(observation) || !Array.isArray(observation.targets)) {
    fail('LLM_AGENT_DECISION_INVALID', 'observation targets are required');
  }
  return observation.targets;
}

function publicLandmark(landmark) {
  if (!isPlainObject(landmark)) fail('LLM_AGENT_DECISION_INVALID', 'landmark is invalid');
  hasExactKeys(
    landmark,
    new Set(['reference', 'kind', 'status', 'revisitable']),
    'LLM_AGENT_DECISION_INVALID',
    'landmark'
  );
  if (typeof landmark.reference !== 'string' || landmark.reference.length === 0
    || landmark.kind !== 'gold_block'
    || !new Set(['visible', 'out_of_view']).has(landmark.status)
    || landmark.revisitable !== true) {
    fail('LLM_AGENT_DECISION_INVALID', 'landmark is invalid');
  }
  return clone(landmark);
}

export function validateDecision(value, observation) {
  if (!isPlainObject(value)) fail('LLM_AGENT_DECISION_INVALID', 'decision must be an object');
  const action = value.action;
  const expected = ACTION_KEYS.get(action);
  if (!expected) fail('LLM_AGENT_DECISION_INVALID', 'unsupported action');
  hasExactKeys(value, expected, 'LLM_AGENT_DECISION_INVALID', `${action} decision`);

  requireString(value.reason, 'reason', { nonEmpty: true });
  requireString(value.summary, 'summary', { max: MAX_SUMMARY_CHARACTERS });
  if (!Array.isArray(value.plan) || value.plan.length > MAX_PLAN_ENTRIES) fail('LLM_AGENT_DECISION_INVALID', 'plan must contain at most five entries');
  for (const entry of value.plan) requireString(entry, 'plan entry', { nonEmpty: true });
  requireString(value.subgoal, 'subgoal');
  const variables = validateVariables(value.variables);

  let targetId;
  let item;
  let reference;
  if (TARGET_ACTIONS.has(action)) {
    if (typeof value.targetId !== 'string' || value.targetId.length === 0) fail('LLM_AGENT_DECISION_INVALID', 'targetId is required');
    const targets = validateObservationTargets(observation);
    if (!targets.some((target) => isPlainObject(target) && target.id === value.targetId)) fail('LLM_AGENT_DECISION_INVALID', 'targetId is not in the current observation');
    targetId = value.targetId;
  } else if (action === 'select_item') {
    if (value.item !== 'oak_log') fail('LLM_AGENT_DECISION_INVALID', 'only oak_log may be selected');
    item = value.item;
  } else if (action === 'navigate_to_landmark') {
    if (typeof value.reference !== 'string' || value.reference.length === 0) {
      fail('LLM_AGENT_DECISION_INVALID', 'landmark reference is required');
    }
    if (!Array.isArray(observation?.landmarks)
      || !observation.landmarks.map(publicLandmark).some((landmark) => landmark.reference === value.reference)) {
      fail('LLM_AGENT_DECISION_INVALID', 'landmark reference is not in the current observation');
    }
    reference = value.reference;
  }

  const normalized = { action, ...(targetId === undefined ? {} : { targetId }), ...(item === undefined ? {} : { item }), ...(reference === undefined ? {} : { reference }), reason: value.reason, summary: value.summary, plan: [...value.plan], subgoal: value.subgoal, variables };
  return deepFreeze(normalized);
}

function publicActionResult(result) {
  if (!isPlainObject(result)) fail('LLM_AGENT_STATE_INVALID', 'action history entry is invalid');
  const safe = {};
  if (Object.hasOwn(result, 'action')) {
    if (typeof result.action !== 'string') fail('LLM_AGENT_STATE_INVALID', 'action history action is invalid');
    safe.action = result.action;
  }
  if (Object.hasOwn(result, 'ok')) {
    if (typeof result.ok !== 'boolean') fail('LLM_AGENT_STATE_INVALID', 'action history result is invalid');
    safe.ok = result.ok;
  }
  for (const key of ['code', 'message', 'targetId', 'reference']) {
    if (Object.hasOwn(result, key)) {
      if (typeof result[key] !== 'string') fail('LLM_AGENT_STATE_INVALID', `action history ${key} is invalid`);
      safe[key] = result[key];
    }
  }
  return safe;
}

function publicTrustedObservation(value) {
  if (!isPlainObject(value)) fail('LLM_AGENT_STATE_INVALID', 'trusted observation is invalid');
  const safe = {};
  for (const key of ['health', 'food', 'connected', 'dimension']) {
    if (!Object.hasOwn(value, key)) continue;
    const child = value[key];
    if (key === 'dimension' && typeof child !== 'string') fail('LLM_AGENT_STATE_INVALID', 'trusted observation dimension is invalid');
    if (key === 'connected' && typeof child !== 'boolean') fail('LLM_AGENT_STATE_INVALID', 'trusted observation connected is invalid');
    if ((key === 'health' || key === 'food') && typeof child !== 'number') fail('LLM_AGENT_STATE_INVALID', `trusted observation ${key} is invalid`);
    safe[key] = child;
  }
  if (Object.hasOwn(value, 'inventory')) {
    if (!Array.isArray(value.inventory)) fail('LLM_AGENT_STATE_INVALID', 'trusted observation inventory is invalid');
    safe.inventory = value.inventory.map((entry) => {
      if (!isPlainObject(entry) || typeof entry.item !== 'string' || !Number.isInteger(entry.count) || entry.count < 0) {
        fail('LLM_AGENT_STATE_INVALID', 'trusted observation inventory entry is invalid');
      }
      return { item: entry.item, count: entry.count };
    });
  }
  if (Object.hasOwn(value, 'targets')) {
    if (!Array.isArray(value.targets)) fail('LLM_AGENT_STATE_INVALID', 'trusted observation targets are invalid');
    safe.targets = value.targets.map(publicTarget).filter(Boolean);
  }
  return safe;
}

function publicTarget(target) {
  if (!isPlainObject(target)) return null;
  const result = {};
  for (const key of ['id', 'kind', 'block', 'distanceBand', 'reachable']) {
    if (!Object.hasOwn(target, key)) continue;
    if (key === 'reachable' && typeof target[key] !== 'boolean') fail('LLM_AGENT_DECISION_INVALID', 'target reachable flag is invalid');
    if (key !== 'reachable' && typeof target[key] !== 'string') fail('LLM_AGENT_DECISION_INVALID', `target ${key} is invalid`);
    result[key] = target[key];
  }
  return result.id ? result : null;
}

export function toDecisionContext(state, observation) {
  const validated = validateActorState(state);
  if (!isPlainObject(observation)) fail('LLM_AGENT_DECISION_INVALID', 'observation must be an object');
  if (Object.hasOwn(observation, 'targets') && !Array.isArray(observation.targets)) {
    fail('LLM_AGENT_DECISION_INVALID', 'observation targets must be an array');
  }
  const safeObservation = {};
  for (const key of ['health', 'food', 'inventory', 'targets', 'landmarks', 'connected', 'dimension']) {
    if (!Object.hasOwn(observation, key)) continue;
    if (key === 'targets') safeObservation.targets = observation.targets.map(publicTarget).filter(Boolean);
    else if (key === 'landmarks') {
      if (!Array.isArray(observation.landmarks)) fail('LLM_AGENT_DECISION_INVALID', 'observation landmarks must be an array');
      safeObservation.landmarks = observation.landmarks.map(publicLandmark);
    }
    else if (key === 'inventory') {
      if (!Array.isArray(observation.inventory)) fail('LLM_AGENT_DECISION_INVALID', 'observation inventory must be an array');
      safeObservation.inventory = observation.inventory.map((entry) => {
        if (!isPlainObject(entry) || typeof entry.item !== 'string' || !Number.isInteger(entry.count) || entry.count < 0) {
          fail('LLM_AGENT_DECISION_INVALID', 'observation inventory entry is invalid');
        }
        return { item: entry.item, count: entry.count };
      });
    } else if (key === 'health' || key === 'food') {
      if (typeof observation[key] !== 'number' || !Number.isFinite(observation[key])) fail('LLM_AGENT_DECISION_INVALID', `observation ${key} is invalid`);
      safeObservation[key] = observation[key];
    } else if (key === 'connected') {
      if (typeof observation[key] !== 'boolean') fail('LLM_AGENT_DECISION_INVALID', 'observation connected is invalid');
      safeObservation[key] = observation[key];
    } else {
      if (typeof observation[key] !== 'string') fail('LLM_AGENT_DECISION_INVALID', 'observation dimension is invalid');
      safeObservation[key] = observation[key];
    }
  }
  return {
    actor: {
      actorId: validated.identity.actorId,
      runId: validated.lifecycle.runId,
      status: validated.lifecycle.status,
      phase: validated.trusted.phase
    },
    goal: clone(validated.goal),
    trusted: {
      milestones: clone(validated.trusted.milestones),
      recentObservations: validated.trusted.recentObservations.map(publicTrustedObservation),
      recentActionResults: validated.trusted.recentActionResults.map(publicActionResult)
    },
    working: clone(validated.working),
    limits: clone(validated.limits),
    observation: safeObservation
  };
}

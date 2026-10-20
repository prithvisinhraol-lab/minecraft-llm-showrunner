export const FINAL_SURVIVAL_DEMO_LINE = 'This is gonna be great!!!';

export const SURVIVAL_DEMO_MILESTONES = Object.freeze([
  'wood_collected',
  'crafting_table_placed',
  'wooden_pickaxe_crafted',
  'stone_mined',
  'furnace_crafted',
  'village_found',
  'final_line_spoken'
]);

export const SURVIVAL_DEMO_ACTIONS = Object.freeze([
  'gather_wood',
  'craft_and_place_table',
  'craft_wooden_pickaxe',
  'mine_stone',
  'craft_furnace',
  'find_village',
  'say_final_line',
  'stop'
]);

const ACTION_FOR_MILESTONE = Object.freeze({
  wood_collected: 'gather_wood',
  crafting_table_placed: 'craft_and_place_table',
  wooden_pickaxe_crafted: 'craft_wooden_pickaxe',
  stone_mined: 'mine_stone',
  furnace_crafted: 'craft_furnace',
  village_found: 'find_village',
  final_line_spoken: 'say_final_line'
});

const MAXIMUM_DECISIONS = 16;
const STATE_STATUSES = new Set(['idle', 'running', 'stopped', 'succeeded', 'failed']);
const IDENTIFIER = /^[A-Za-z0-9_-]{1,64}$/;

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exact(value, keys, code, label) {
  if (!plain(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw coded(code, `${label} contains unknown or missing fields`);
  }
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

function identifier(value, code, label) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw coded(code, `${label} is invalid`);
}

function isoTimestamp(value, code, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw coded(code, `${label} is invalid`);
  }
}

function safeInteger(value, minimum, maximum, code, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw coded(code, `${label} is invalid`);
}

function inventoryCount(observation, item) {
  const count = observation?.inventory?.[item] ?? 0;
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function result(verified, proofKinds = [], code) {
  return freeze({ verified, proofKinds: [...proofKinds], ...(code ? { code } : {}) });
}

export function createInitialSurvivalDemoState({ actorId, runId, now }) {
  const value = {
    schemaVersion: 1,
    actorId,
    runId,
    status: 'idle',
    nextMilestoneIndex: 0,
    verifiedMilestones: [],
    lastObservationVersion: 0,
    decisionsUsed: 0,
    maximumDecisions: MAXIMUM_DECISIONS,
    startedAt: null,
    updatedAt: now,
    stoppedReason: null,
    proofs: []
  };
  return validateSurvivalDemoState(value);
}

export function validateSurvivalDemoState(value) {
  const code = 'SURVIVAL_DEMO_STATE_INVALID';
  exact(value, [
    'schemaVersion', 'actorId', 'runId', 'status', 'nextMilestoneIndex',
    'verifiedMilestones', 'lastObservationVersion', 'decisionsUsed', 'maximumDecisions',
    'startedAt', 'updatedAt', 'stoppedReason', 'proofs'
  ], code, 'survival demo state');
  if (value.schemaVersion !== 1) throw coded(code, 'schema version is invalid');
  identifier(value.actorId, code, 'actor ID');
  identifier(value.runId, code, 'run ID');
  if (!STATE_STATUSES.has(value.status)) throw coded(code, 'status is invalid');
  safeInteger(value.nextMilestoneIndex, 0, SURVIVAL_DEMO_MILESTONES.length, code, 'milestone index');
  safeInteger(value.lastObservationVersion, 0, Number.MAX_SAFE_INTEGER, code, 'observation version');
  safeInteger(value.decisionsUsed, 0, MAXIMUM_DECISIONS, code, 'decision count');
  if (value.maximumDecisions !== MAXIMUM_DECISIONS) throw coded(code, 'maximum decisions is invalid');
  if (!Array.isArray(value.verifiedMilestones)
    || JSON.stringify(value.verifiedMilestones) !== JSON.stringify(SURVIVAL_DEMO_MILESTONES.slice(0, value.nextMilestoneIndex))) {
    throw coded(code, 'verified milestones are not an exact prefix');
  }
  if (!Array.isArray(value.proofs) || value.proofs.length !== value.nextMilestoneIndex
    || value.proofs.some((entry, index) => !plain(entry) || entry.milestone !== value.verifiedMilestones[index]
      || !Array.isArray(entry.proofKinds) || entry.proofKinds.some((proof) => typeof proof !== 'string' || proof.length === 0))) {
    throw coded(code, 'proof history is invalid');
  }
  if (value.startedAt !== null) isoTimestamp(value.startedAt, code, 'start timestamp');
  isoTimestamp(value.updatedAt, code, 'updated timestamp');
  if (value.stoppedReason !== null && (typeof value.stoppedReason !== 'string' || value.stoppedReason.length === 0 || value.stoppedReason.length > 200)) {
    throw coded(code, 'stopped reason is invalid');
  }
  if (value.status === 'succeeded' && value.nextMilestoneIndex !== SURVIVAL_DEMO_MILESTONES.length) {
    throw coded(code, 'succeeded state is incomplete');
  }
  return freeze(clone(value));
}

export function expectedSurvivalDemoAction(state) {
  const validated = validateSurvivalDemoState(state);
  if (validated.nextMilestoneIndex >= SURVIVAL_DEMO_MILESTONES.length) return null;
  return ACTION_FOR_MILESTONE[SURVIVAL_DEMO_MILESTONES[validated.nextMilestoneIndex]];
}

export function validateSurvivalDemoDecision(value, state, observation) {
  const code = 'SURVIVAL_DEMO_DECISION_INVALID';
  const validatedState = validateSurvivalDemoState(state);
  exact(value, ['action', 'observationVersion', 'reason'], code, 'survival demo decision');
  if (!SURVIVAL_DEMO_ACTIONS.includes(value.action)) throw coded(code, 'action is not allowed');
  safeInteger(value.observationVersion, 1, Number.MAX_SAFE_INTEGER, code, 'observation version');
  if (!plain(observation) || observation.observationVersion !== value.observationVersion) throw coded(code, 'observation fence does not match');
  if (typeof value.reason !== 'string' || value.reason.trim().length === 0 || value.reason.length > 200 || /[\r\n\u0000-\u001f]/u.test(value.reason)) {
    throw coded(code, 'reason is invalid');
  }
  if (validatedState.decisionsUsed >= validatedState.maximumDecisions) throw coded(code, 'decision limit is exhausted');
  const expected = expectedSurvivalDemoAction(validatedState);
  if (value.action !== 'stop' && value.action !== expected) throw coded(code, 'action is not the next authorized milestone');
  if (value.action !== 'stop' && (observation.connected !== true || observation.alive !== true)) {
    throw coded(code, 'actor is not live and connected');
  }
  return freeze(clone(value));
}

export function verifySurvivalDemoMilestone(milestone, observation, context = {}) {
  if (!SURVIVAL_DEMO_MILESTONES.includes(milestone) || !plain(observation)) {
    return result(false, [], 'SURVIVAL_DEMO_EVIDENCE_INVALID');
  }
  const facts = observation.runFacts;
  const village = observation.villageEvidence;
  if (milestone === 'wood_collected') {
    const verified = inventoryCount(observation, 'oak_log') >= 3 && Number.isSafeInteger(facts?.brokenOakLogs) && facts.brokenOakLogs >= 3;
    return result(verified, verified ? ['inventory:oak_log>=3', 'run:broken_oak_logs>=3'] : []);
  }
  if (milestone === 'crafting_table_placed') {
    const verified = facts?.placedCraftingTable === true;
    return result(verified, verified ? ['world:crafting_table_placed'] : []);
  }
  if (milestone === 'wooden_pickaxe_crafted') {
    const verified = inventoryCount(observation, 'wooden_pickaxe') >= 1 && observation.equippedHand === 'wooden_pickaxe';
    return result(verified, verified ? ['inventory:wooden_pickaxe>=1', 'equipment:hand=wooden_pickaxe'] : []);
  }
  if (milestone === 'stone_mined') {
    const verified = inventoryCount(observation, 'cobblestone') >= 8 && Number.isSafeInteger(facts?.minedStone) && facts.minedStone >= 8;
    return result(verified, verified ? ['inventory:cobblestone>=8', 'run:mined_stone>=8'] : []);
  }
  if (milestone === 'furnace_crafted') {
    const verified = inventoryCount(observation, 'furnace') >= 1;
    return result(verified, verified ? ['inventory:furnace>=1'] : []);
  }
  if (milestone === 'village_found') {
    const verified = village?.bell === true && Number.isSafeInteger(village.beds) && village.beds >= 1
      && Number.isSafeInteger(village.villagers) && village.villagers >= 1;
    return result(verified, verified ? ['village:bell', 'village:beds>=1', 'village:villagers>=1'] : []);
  }
  if (milestone === 'final_line_spoken') {
    const verified = typeof context.actorId === 'string' && Array.isArray(observation.observedChat)
      && observation.observedChat.some((entry) => entry?.username === context.actorId && entry.message === FINAL_SURVIVAL_DEMO_LINE);
    return result(verified, verified ? ['chat:final_line_observed'] : []);
  }
  return result(false, [], 'SURVIVAL_DEMO_EVIDENCE_INVALID');
}

export function applyVerifiedSurvivalDemoOutcome(state, outcome) {
  const code = 'SURVIVAL_DEMO_OUTCOME_INVALID';
  const validated = validateSurvivalDemoState(state);
  exact(outcome, ['action', 'observationVersion', 'verification', 'observedAt'], code, 'survival demo outcome');
  const expectedAction = expectedSurvivalDemoAction(validated);
  if (outcome.action !== expectedAction) throw coded(code, 'outcome action is not current');
  safeInteger(outcome.observationVersion, validated.lastObservationVersion + 1, Number.MAX_SAFE_INTEGER, code, 'outcome observation version');
  isoTimestamp(outcome.observedAt, code, 'outcome timestamp');
  if (!plain(outcome.verification) || outcome.verification.verified !== true
    || !Array.isArray(outcome.verification.proofKinds) || outcome.verification.proofKinds.length === 0
    || outcome.verification.proofKinds.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw coded(code, 'outcome is not independently verified');
  }
  const milestone = SURVIVAL_DEMO_MILESTONES[validated.nextMilestoneIndex];
  const nextIndex = validated.nextMilestoneIndex + 1;
  return validateSurvivalDemoState({
    ...clone(validated),
    status: nextIndex === SURVIVAL_DEMO_MILESTONES.length ? 'succeeded' : 'running',
    nextMilestoneIndex: nextIndex,
    verifiedMilestones: [...validated.verifiedMilestones, milestone],
    lastObservationVersion: outcome.observationVersion,
    decisionsUsed: validated.decisionsUsed + 1,
    startedAt: validated.startedAt ?? outcome.observedAt,
    updatedAt: outcome.observedAt,
    proofs: [...validated.proofs, { milestone, proofKinds: [...outcome.verification.proofKinds] }]
  });
}

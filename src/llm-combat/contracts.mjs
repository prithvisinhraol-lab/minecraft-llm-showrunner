const IDENTIFIER = /^[A-Za-z0-9_.:/-]{1,100}$/;
const MAXIMUM_INTENT_DURATION_MS = 750;

export const COMBAT_INTENT_KINDS = Object.freeze([
  'approach_target', 'hold_distance', 'strafe_left', 'strafe_right',
  'sprint_attack', 'normal_attack', 'critical_attack', 'raise_shield',
  'lower_shield', 'use_item', 'select_hotbar_slot', 'retreat_to_anchor', 'wait'
]);

const DURATION_INTENTS = new Set(['approach_target', 'hold_distance', 'strafe_left', 'strafe_right', 'wait']);
const SIMPLE_INTENTS = new Set(['sprint_attack', 'normal_attack', 'critical_attack', 'raise_shield', 'lower_shield']);

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

function identifier(value, code, label) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw coded(code, `${label} is invalid`);
  return value;
}

function integer(value, minimum, maximum, code, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw coded(code, `${label} is invalid`);
  return value;
}

function finite(value, minimum, maximum, code, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw coded(code, `${label} is invalid`);
  }
  return value;
}

function oneOf(value, choices, code, label) {
  if (!choices.includes(value)) throw coded(code, `${label} is invalid`);
  return value;
}

function bool(value, code, label) {
  if (typeof value !== 'boolean') throw coded(code, `${label} is invalid`);
  return value;
}

function timestamp(value, code, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw coded(code, `${label} is invalid`);
  return value;
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validateContext(context) {
  const code = 'COMBAT_INTENT_INVALID';
  if (!plain(context)) throw coded(code, 'intent context is invalid');
  identifier(context.actorId, code, 'context actor ID');
  identifier(context.targetId, code, 'context target ID');
  integer(context.observationVersion, 1, Number.MAX_SAFE_INTEGER, code, 'context observation version');
  if (!Array.isArray(context.itemIds) || !Array.isArray(context.anchorIds)) throw coded(code, 'context allowlists are invalid');
  for (const id of [...context.itemIds, ...context.anchorIds]) identifier(id, code, 'context allowlist ID');
}

export function validateCombatIntent(value, context) {
  const code = 'COMBAT_INTENT_INVALID';
  validateContext(context);
  if (!plain(value) || !COMBAT_INTENT_KINDS.includes(value.kind)) throw coded(code, 'combat intent kind is invalid');
  const common = ['kind', 'actorId', 'targetId', 'observationVersion'];
  let extra;
  if (DURATION_INTENTS.has(value.kind)) extra = ['durationMs'];
  else if (SIMPLE_INTENTS.has(value.kind)) extra = [];
  else if (value.kind === 'use_item') extra = ['itemId'];
  else if (value.kind === 'select_hotbar_slot') extra = ['slot'];
  else if (value.kind === 'retreat_to_anchor') extra = ['anchorId', 'durationMs'];
  exact(value, [...common, ...extra], code, 'combat intent');
  identifier(value.actorId, code, 'actor ID');
  identifier(value.targetId, code, 'target ID');
  integer(value.observationVersion, 1, Number.MAX_SAFE_INTEGER, code, 'observation version');
  if (value.actorId !== context.actorId || value.targetId !== context.targetId || value.observationVersion !== context.observationVersion) {
    throw coded(code, 'combat intent fence does not match context');
  }
  if (Object.hasOwn(value, 'durationMs')) integer(value.durationMs, 1, MAXIMUM_INTENT_DURATION_MS, code, 'duration');
  if (value.kind === 'select_hotbar_slot') integer(value.slot, 0, 8, code, 'hotbar slot');
  if (value.kind === 'use_item') {
    identifier(value.itemId, code, 'item ID');
    if (!context.itemIds.includes(value.itemId)) throw coded(code, 'item is not permitted');
  }
  if (value.kind === 'retreat_to_anchor') {
    identifier(value.anchorId, code, 'anchor ID');
    if (!context.anchorIds.includes(value.anchorId)) throw coded(code, 'anchor is not permitted');
  }
  return deepFreeze(clone(value));
}

function position(value, code, label) {
  exact(value, ['x', 'y', 'z'], code, label);
  return {
    x: finite(value.x, -4096, 4096, code, `${label}.x`),
    y: finite(value.y, -4096, 4096, code, `${label}.y`),
    z: finite(value.z, -4096, 4096, code, `${label}.z`)
  };
}

export function validateCombatObservation(value) {
  const code = 'COMBAT_OBSERVATION_INVALID';
  const keys = [
    'schemaVersion', 'observationVersion', 'observedAt', 'actorId', 'targetId', 'arenaId',
    'actorPosition', 'targetPosition', 'distance', 'lineOfSight', 'actorHealth', 'targetHealth',
    'selectedSlot', 'heldItemCategory', 'shieldState', 'sprinting', 'onGround',
    'recentDamageDirection', 'targetValid', 'actorInArena', 'targetInArena',
    'attackCooldown', 'itemCooldown', 'connected'
  ];
  exact(value, keys, code, 'combat observation');
  integer(value.schemaVersion, 1, 1, code, 'schema version');
  integer(value.observationVersion, 1, Number.MAX_SAFE_INTEGER, code, 'observation version');
  timestamp(value.observedAt, code, 'observation timestamp');
  for (const field of ['actorId', 'targetId', 'arenaId', 'heldItemCategory']) identifier(value[field], code, field);
  const normalized = clone(value);
  normalized.actorPosition = position(value.actorPosition, code, 'actor position');
  normalized.targetPosition = position(value.targetPosition, code, 'target position');
  finite(value.distance, 0, 128, code, 'distance');
  finite(value.actorHealth, 0, 20, code, 'actor health');
  finite(value.targetHealth, 0, 20, code, 'target health');
  integer(value.selectedSlot, 0, 8, code, 'selected slot');
  oneOf(value.shieldState, ['raised', 'lowered', 'unavailable'], code, 'shield state');
  oneOf(value.recentDamageDirection, ['none', 'front', 'back', 'left', 'right'], code, 'damage direction');
  oneOf(value.attackCooldown, ['ready', 'cooling'], code, 'attack cooldown');
  oneOf(value.itemCooldown, ['ready', 'cooling'], code, 'item cooldown');
  for (const field of ['lineOfSight', 'sprinting', 'onGround', 'targetValid', 'actorInArena', 'targetInArena', 'connected']) {
    bool(value[field], code, field);
  }
  return deepFreeze(normalized);
}

export function validateCombatExecutionResult(value) {
  const code = 'COMBAT_EXECUTION_INVALID';
  const keys = [
    'schemaVersion', 'sequenceId', 'intentKind', 'status', 'code',
    'beforeObservationVersion', 'afterObservationVersion', 'startedAt', 'finishedAt', 'commandCount'
  ];
  exact(value, keys, code, 'combat execution result');
  integer(value.schemaVersion, 1, 1, code, 'schema version');
  identifier(value.sequenceId, code, 'sequence ID');
  oneOf(value.intentKind, COMBAT_INTENT_KINDS, code, 'intent kind');
  oneOf(value.status, ['completed', 'cancelled', 'failed'], code, 'execution status');
  identifier(value.code, code, 'execution code');
  integer(value.beforeObservationVersion, 1, Number.MAX_SAFE_INTEGER, code, 'before observation version');
  integer(value.afterObservationVersion, 1, Number.MAX_SAFE_INTEGER, code, 'after observation version');
  integer(value.commandCount, 0, 8, code, 'command count');
  timestamp(value.startedAt, code, 'start timestamp');
  timestamp(value.finishedAt, code, 'finish timestamp');
  if (value.afterObservationVersion <= value.beforeObservationVersion) throw coded(code, 'execution result does not contain a fresh observation');
  if (Date.parse(value.finishedAt) < Date.parse(value.startedAt)) throw coded(code, 'execution result timestamps are reversed');
  return deepFreeze(clone(value));
}

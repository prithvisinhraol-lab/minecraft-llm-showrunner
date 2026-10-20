const ATTACK_INTENTS = new Set(['sprint_attack', 'normal_attack', 'critical_attack']);

function decision(authorized, code) {
  return Object.freeze({ authorized, code });
}

function reject(code) {
  return decision(false, code);
}

function validNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function authorizeCombatIntent(intent, observation, policy) {
  if (!intent || !observation || !policy) return reject('POLICY_INPUT_INVALID');
  if (!validNumber(observation.actorHealth) || !validNumber(observation.distance)) return reject('OBSERVATION_INVALID');
  if (!validNumber(policy.now) || !validNumber(policy.exchangeStartedAt) || !validNumber(policy.lastDecisionAt)) return reject('POLICY_INPUT_INVALID');
  if (observation.actorHealth <= policy.disengageAtHealth) return reject('EMERGENCY_DISENGAGE');
  if (intent.observationVersion !== observation.observationVersion) return reject('STALE_OBSERVATION');
  if (intent.actorId !== policy.actorId || observation.actorId !== policy.actorId) return reject('ACTOR_MISMATCH');
  if (intent.targetId !== policy.targetId || observation.targetId !== policy.targetId) return reject('TARGET_MISMATCH');
  if (observation.connected !== true) return reject('DISCONNECTED');
  if (observation.targetValid !== true) return reject('TARGET_INVALID');
  if (observation.actorInArena !== true || observation.targetInArena !== true) return reject('OUTSIDE_ARENA');
  if (observation.distance > policy.maximumEngagementDistance) return reject('TARGET_OUT_OF_RANGE');
  if (policy.sequenceInFlight === true) return reject('SEQUENCE_IN_FLIGHT');
  if (policy.now - policy.lastDecisionAt < policy.minimumDecisionCadenceMs) return reject('DECISION_CADENCE');
  if (policy.now - policy.exchangeStartedAt > policy.maximumExchangeMs) return reject('EXCHANGE_DEADLINE');
  if (!Number.isSafeInteger(policy.decisionsUsed) || policy.decisionsUsed >= policy.maximumDecisions) return reject('DECISION_LIMIT');
  if (ATTACK_INTENTS.has(intent.kind) && observation.lineOfSight !== true) return reject('NO_LINE_OF_SIGHT');
  if (ATTACK_INTENTS.has(intent.kind) && observation.attackCooldown !== 'ready') return reject('ATTACK_COOLDOWN');
  if (intent.kind === 'use_item' && observation.itemCooldown !== 'ready') return reject('ITEM_COOLDOWN');
  return decision(true, 'AUTHORIZED');
}

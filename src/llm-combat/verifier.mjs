const ATTACK_INTENTS = new Set(['sprint_attack', 'normal_attack', 'critical_attack']);

function verified(proofKind) {
  return Object.freeze({ verified: true, proofKinds: Object.freeze([proofKind]) });
}

function rejected(code) {
  return Object.freeze({ verified: false, proofKinds: Object.freeze([]), code });
}

function displacement(left, right) {
  if (!left || !right) return 0;
  return Math.hypot(right.x - left.x, right.y - left.y, right.z - left.z);
}

function basicEvidence(before, intent, after, result) {
  if (result.status !== 'completed') return rejected('DRIVER_NOT_COMPLETED');
  if (after.observationVersion <= before.observationVersion) return rejected('OBSERVATION_NOT_FRESH');
  if (intent.observationVersion !== before.observationVersion ||
      result.beforeObservationVersion !== before.observationVersion ||
      result.afterObservationVersion !== after.observationVersion ||
      result.intentKind !== intent.kind) return rejected('RESULT_FENCE_MISMATCH');
  if (before.actorId !== intent.actorId || after.actorId !== intent.actorId ||
      before.targetId !== intent.targetId || after.targetId !== intent.targetId) return rejected('IDENTITY_MISMATCH');
  if (after.connected !== true) return rejected('ACTOR_DISCONNECTED');
  if (after.actorInArena !== true || after.targetInArena !== true) return rejected('OUTSIDE_ARENA');
  return null;
}

export function verifyCombatAction(before, intent, after, result) {
  const rejection = basicEvidence(before, intent, after, result);
  if (rejection) return rejection;
  if (ATTACK_INTENTS.has(intent.kind)) {
    return after.targetHealth < before.targetHealth ? verified('opponent_health_decreased') : rejected('ATTACK_NOT_OBSERVED');
  }
  if (intent.kind === 'approach_target') {
    return after.distance < before.distance ? verified('distance_decreased') : rejected('APPROACH_NOT_OBSERVED');
  }
  if (intent.kind === 'hold_distance') {
    return Math.abs(after.distance - before.distance) <= 0.25 ? verified('distance_held') : rejected('DISTANCE_NOT_HELD');
  }
  if (intent.kind === 'strafe_left' || intent.kind === 'strafe_right') {
    return displacement(before.actorPosition, after.actorPosition) >= 0.1 ? verified('actor_position_changed') : rejected('STRAFE_NOT_OBSERVED');
  }
  if (intent.kind === 'raise_shield') {
    return before.shieldState !== 'raised' && after.shieldState === 'raised' ? verified('shield_raised') : rejected('SHIELD_RAISE_NOT_OBSERVED');
  }
  if (intent.kind === 'lower_shield') {
    return before.shieldState === 'raised' && after.shieldState === 'lowered' ? verified('shield_lowered') : rejected('SHIELD_LOWER_NOT_OBSERVED');
  }
  if (intent.kind === 'select_hotbar_slot') {
    return after.selectedSlot === intent.slot ? verified('hotbar_slot_selected') : rejected('SLOT_CHANGE_NOT_OBSERVED');
  }
  if (intent.kind === 'use_item') {
    const changed = after.actorHealth !== before.actorHealth || after.selectedSlot !== before.selectedSlot;
    return changed ? verified('item_effect_observed') : rejected('ITEM_EFFECT_NOT_OBSERVED');
  }
  if (intent.kind === 'retreat_to_anchor') {
    const moved = displacement(before.actorPosition, after.actorPosition) >= 0.1 && after.distance > before.distance;
    return moved ? verified('retreat_movement_observed') : rejected('RETREAT_NOT_OBSERVED');
  }
  if (intent.kind === 'wait') return verified('fresh_observation_after_wait');
  return rejected('INTENT_NOT_VERIFIABLE');
}

export function verifyCombatGoal(goal, observation, history) {
  if (!goal || goal.kind !== 'defeat_target' || !Array.isArray(history)) return rejected('GOAL_INVALID');
  if (goal.actorId !== observation.actorId || goal.targetId !== observation.targetId) return rejected('IDENTITY_MISMATCH');
  if (observation.connected !== true || observation.actorInArena !== true) return rejected('ACTOR_NOT_VALID');
  if (observation.actorHealth < goal.minimumActorHealth) return rejected('ACTOR_HEALTH_BELOW_MINIMUM');
  const damageProved = history.some((entry) => Array.isArray(entry?.proofKinds) && entry.proofKinds.includes('opponent_health_decreased'));
  const defeatedProved = history.some((entry) => Array.isArray(entry?.proofKinds) && entry.proofKinds.includes('opponent_defeated'));
  if (observation.targetHealth !== 0 || observation.targetValid !== false || !damageProved || !defeatedProved) {
    return rejected('TARGET_DEFEAT_NOT_PROVED');
  }
  return Object.freeze({
    verified: true,
    proofKinds: Object.freeze(['opponent_defeated', `actor_health_at_least:${goal.minimumActorHealth}`])
  });
}

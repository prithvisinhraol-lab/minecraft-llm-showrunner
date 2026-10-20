import { survivalReservationKey } from './survival-authority.mjs';
import { canonicalDimension, isEquipmentDestination } from './survival-contracts.mjs';

const ACTION_NAMES = new Set([
  'moveNearTarget', 'lookAtTarget', 'digTarget', 'collectItem',
  'craftRecipe', 'placeAtMark', 'equipItem', 'observeSurvival'
]);
const GOAL_KINDS = new Set(['gather', 'craft', 'place', 'equip', 'excavate', 'regroup']);
const RECIPE_NAMES = new Set(['oak_planks', 'stick', 'crafting_table', 'wooden_pickaxe']);
const MAX_COUNT = 64;
const MAX_REPLANS = 5;
const MAX_TIMEOUT_MS = 120_000;
const GOAL_FIELDS = Object.freeze({
  gather: new Set(['id', 'actor', 'kind', 'region', 'item', 'count', 'timeoutMs', 'maxReplans', 'completion']),
  craft: new Set(['id', 'actor', 'kind', 'recipe', 'mark', 'count', 'timeoutMs', 'maxReplans', 'completion']),
  place: new Set(['id', 'actor', 'kind', 'block', 'mark', 'count', 'timeoutMs', 'maxReplans', 'completion']),
  equip: new Set(['id', 'actor', 'kind', 'item', 'destination', 'count', 'timeoutMs', 'maxReplans', 'completion']),
  excavate: new Set(['id', 'actor', 'kind', 'region', 'block', 'item', 'count', 'timeoutMs', 'maxReplans', 'completion']),
  regroup: new Set(['id', 'actor', 'kind', 'mark', 'count', 'timeoutMs', 'maxReplans', 'completion'])
});

function coded(code, message = code) {
  return Object.assign(new TypeError(message), { code });
}

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonemptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function boundedInteger(value, max) {
  return Number.isSafeInteger(value) && value >= 1 && value <= max;
}

function exactKeys(value, keys) {
  return plainObject(value) && Object.keys(value).length === keys.size && Object.keys(value).every((key) => keys.has(key));
}

function isJsonValue(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!plainObject(value) && !Array.isArray(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Array.isArray(value)
    ? value.every((entry) => isJsonValue(entry, seen))
    : Object.values(value).every((entry) => isJsonValue(entry, seen));
}

function cloneJson(value) {
  if (!isJsonValue(value)) throw coded('PLANNER_RESULT_INVALID');
  return JSON.parse(JSON.stringify(value));
}

function inventoryCount(inventory, item) {
  const value = inventory?.[item] ?? 0;
  return nonnegativeInteger(value) ? value : 0;
}

function actorObservation(observation, actor) {
  return observation.actors[actor];
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function decision(status, reason, observationVersion, action) {
  return freeze(cloneJson(action === undefined
    ? { status, reason, observationVersion }
    : { status, action, reason, observationVersion }));
}

function action(name, payload, reason, observationVersion) {
  if (!ACTION_NAMES.has(name)) throw coded('PLANNER_ACTION_INVALID');
  return decision('action', reason, observationVersion, { name, payload });
}

function boundedActionCount(count) {
  if (!boundedInteger(count, MAX_COUNT)) throw coded('PLANNER_ACTION_COUNT_INVALID');
  return count;
}

function blocked(reason, observation) {
  return decision('blocked', reason, observation.version);
}

function validateInventory(inventory) {
  if (!plainObject(inventory) || Object.values(inventory).some((count) => !nonnegativeInteger(count))) {
    throw coded('PLANNER_INVENTORY_INVALID');
  }
}

function validateCompletion(goal) {
  const completion = goal.completion;
  const matching = (keys, expected) => exactKeys(completion, new Set(keys)) && Object.entries(expected).every(([key, value]) => completion[key] === value);
  const accepted = {
    gather: () => matching(['kind', 'actor', 'item', 'count'], { kind: 'actor_inventory_at_least', actor: goal.actor, item: goal.item, count: goal.count }),
    craft: () => matching(['kind', 'actor', 'item', 'count'], { kind: 'actor_inventory_at_least', actor: goal.actor, item: goal.recipe, count: goal.count }),
    place: () => matching(['kind', 'block', 'mark'], { kind: 'placed_at_mark', block: goal.block, mark: goal.mark }),
    equip: () => matching(['kind', 'actor', 'item', 'destination'], { kind: 'equipped_item', actor: goal.actor, item: goal.item, destination: goal.destination }),
    excavate: () =>
      matching(['kind', 'actor', 'item', 'count'], {
        kind: 'actor_inventory_at_least', actor: goal.actor, item: goal.item, count: goal.count
      }) || matching(['kind', 'item', 'count'], {
        kind: 'combined_inventory_at_least', item: goal.item, count: goal.count
      }),
    regroup: () => matching(['kind', 'actor', 'mark'], { kind: 'at_mark', actor: goal.actor, mark: goal.mark })
  };
  if (!accepted[goal.kind]()) throw coded('PLANNER_COMPLETION_INVALID');
}

function validateGoal(goal) {
  if (!plainObject(goal) || !nonemptyString(goal.kind) || !GOAL_KINDS.has(goal.kind) || !exactKeys(goal, GOAL_FIELDS[goal.kind]) ||
    !nonemptyString(goal.id) || !nonemptyString(goal.actor) || !boundedInteger(goal.count, MAX_COUNT) ||
    !boundedInteger(goal.timeoutMs, MAX_TIMEOUT_MS) || !Number.isSafeInteger(goal.maxReplans) || goal.maxReplans < 0 || goal.maxReplans > MAX_REPLANS) {
    throw coded('PLANNER_GOAL_INVALID');
  }
  const fieldsByKind = {
    gather: ['region', 'item'], craft: ['recipe', 'mark'], place: ['block', 'mark'],
    equip: ['item', 'destination'], excavate: ['region', 'block', 'item'], regroup: ['mark']
  };
  if (fieldsByKind[goal.kind].some((field) => !nonemptyString(goal[field])) ||
    (goal.kind === 'craft' && !RECIPE_NAMES.has(goal.recipe)) ||
    (goal.kind === 'equip' && !isEquipmentDestination(goal.destination))) throw coded('PLANNER_GOAL_INVALID');
  validateCompletion(goal);
}

function validateActorObservation(actor) {
  if (!plainObject(actor) || !plainObject(actor.equipped) || (actor.atMark !== null && actor.atMark !== undefined && !nonemptyString(actor.atMark)) ||
    Object.values(actor.equipped).some((item) => !nonemptyString(item))) throw coded('PLANNER_ACTOR_OBSERVATION_INVALID');
  validateInventory(actor.inventory);
}

function validateTarget(target) {
  if (!plainObject(target) || !nonemptyString(target.id) || !nonemptyString(target.region) || !nonemptyString(target.block) ||
    !Number.isFinite(target.pathCost) || target.pathCost < 0 || !Number.isFinite(target.distance) || target.distance < 0 ||
    !['x', 'y', 'z'].every((axis) => Number.isSafeInteger(target[axis])) || !canonicalDimension(target.dimension) ||
    (target.reservationKey !== undefined && !nonemptyString(target.reservationKey))) throw coded('PLANNER_OBSERVATION_INVALID');
}

function validateDrop(drop) {
  if (!plainObject(drop) || !nonemptyString(drop.id) || !nonemptyString(drop.item) || !nonemptyString(drop.region) ||
    (drop.reservationKey !== undefined && !nonemptyString(drop.reservationKey))) throw coded('PLANNER_OBSERVATION_INVALID');
}

function validatePlannerInput(goal, observation, reservations) {
  validateGoal(goal);
  if (!plainObject(observation) || !nonnegativeInteger(observation.version) || !nonnegativeInteger(observation.replanCount) ||
    !plainObject(observation.actors) || !plainObject(observation.placedAtMarks) ||
    !Array.isArray(observation.targets) || !Array.isArray(observation.drops) || !isJsonValue(observation) ||
    (observation.stale !== undefined && typeof observation.stale !== 'boolean') ||
    (observation.nearTargetId !== undefined && !nonemptyString(observation.nearTargetId)) ||
    (observation.lookedAtTargetId !== undefined && !nonemptyString(observation.lookedAtTargetId)) ||
    Object.values(observation.placedAtMarks).some((block) => !nonemptyString(block))) {
    throw coded('PLANNER_OBSERVATION_INVALID');
  }
  const actor = actorObservation(observation, goal.actor);
  if (!actor) throw coded('PLANNER_ACTOR_OBSERVATION_INVALID');
  validateActorObservation(actor);
  for (const other of Object.values(observation.actors)) {
    validateActorObservation(other);
  }
  observation.targets.forEach(validateTarget);
  observation.drops.forEach(validateDrop);
  if (!Array.isArray(reservations) || !isJsonValue(reservations) || reservations.some((reservation) => !plainObject(reservation) ||
    (reservation.actorId !== undefined && !nonemptyString(reservation.actorId)) ||
    (reservation.reservationKey !== undefined && !nonemptyString(reservation.reservationKey)))) {
    throw coded('PLANNER_RESERVATIONS_INVALID');
  }
}

function completionSatisfied(completion, observation) {
  if (completion.kind === 'actor_inventory_at_least') {
    return inventoryCount(actorObservation(observation, completion.actor)?.inventory, completion.item) >= completion.count;
  }
  if (completion.kind === 'combined_inventory_at_least') {
    return Object.values(observation.actors)
      .reduce((total, actor) => total + inventoryCount(actor.inventory, completion.item), 0) >= completion.count;
  }
  if (completion.kind === 'placed_at_mark') return observation.placedAtMarks[completion.mark] === completion.block;
  if (completion.kind === 'at_mark') return actorObservation(observation, completion.actor)?.atMark === completion.mark;
  if (completion.kind === 'equipped_item') return actorObservation(observation, completion.actor)?.equipped?.[completion.destination] === completion.item;
  throw coded('PLANNER_COMPLETION_INVALID');
}

function reservedByAnotherActor(reservations, actor, key) {
  const explicitPrefix = 'explicit:';
  const unprefixedKey = key.startsWith(explicitPrefix) ? key.slice(explicitPrefix.length) : key;
  return reservations.some((reservation) => reservation.actorId !== actor &&
    (reservation.reservationKey === unprefixedKey || reservation.reservationKey === `${explicitPrefix}${unprefixedKey}`));
}

function observedTargetReservationKey(target) {
  if (nonemptyString(target.reservationKey)) return survivalReservationKey('target', { reservationKey: target.reservationKey });
  if (nonemptyString(target.dimension) && ['x', 'y', 'z'].every((axis) => Number.isSafeInteger(target[axis]))) {
    return survivalReservationKey('target', { target });
  }
  return `target:${target.id}`;
}

function observedDropReservationKey(drop) {
  if (nonemptyString(drop.reservationKey)) return survivalReservationKey('item', { reservationKey: drop.reservationKey });
  return survivalReservationKey('item', {
    entityId: drop.entityId ?? drop.id,
    dropId: drop.id,
    item: drop.item,
    region: drop.region
  });
}

function firstAvailable(items, actor, reservations, predicate) {
  return items
    .filter((item) => plainObject(item) && nonemptyString(item.id) && predicate(item) &&
      !reservedByAnotherActor(reservations, actor, observedTargetReservationKey(item)))
    .sort(targetOrder)[0];
}

function firstAvailableDrop(items, actor, reservations, predicate) {
  return items
    .filter((item) => plainObject(item) && nonemptyString(item.id) && predicate(item) &&
      !reservedByAnotherActor(reservations, actor, observedDropReservationKey(item)))
    .sort((left, right) => codeUnitCompare(left.id, right.id))[0];
}

function codeUnitCompare(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function targetOrder(left, right) {
  for (const key of ['pathCost', 'distance', 'x', 'y', 'z']) {
    const leftValue = Number.isFinite(left[key]) ? left[key] : Number.POSITIVE_INFINITY;
    const rightValue = Number.isFinite(right[key]) ? right[key] : Number.POSITIVE_INFINITY;
    if (leftValue !== rightValue) return leftValue - rightValue;
  }
  return codeUnitCompare(left.id, right.id);
}

function targetAction(goal, observation, target, mode) {
  const base = { actor: goal.actor, goalId: goal.id, targetId: target.id, region: goal.region, block: goal.block ?? goal.item };
  const prefix = mode === 'gather' ? 'GATHER' : 'EXCAVATION';
  if (observation.nearTargetId !== target.id) return action('moveNearTarget', base, `MOVE_TO_${prefix}_TARGET`, observation.version);
  if (observation.lookedAtTargetId !== target.id) return action('lookAtTarget', base, `LOOK_AT_${prefix}_TARGET`, observation.version);
  return action('digTarget', base, `DIG_${prefix}_TARGET`, observation.version);
}

function craftAction(goal, observation, recipe, count, reason) {
  return action('craftRecipe', { actor: goal.actor, goalId: goal.id, recipe, count: boundedActionCount(count), mark: goal.mark }, reason, observation.version);
}

function plankCraftCount(inventory, requiredPlanks) {
  const missingPlanks = Math.max(0, requiredPlanks - inventoryCount(inventory, 'oak_planks'));
  return Math.min(MAX_COUNT, inventoryCount(inventory, 'oak_log'), Math.ceil(missingPlanks / 4));
}

function craftDependency(goal, observation, recipe) {
  const inventory = actorObservation(observation, goal.actor).inventory;
  const needed = goal.count;
  if (recipe === 'oak_planks') {
    if (inventoryCount(inventory, 'oak_log') === 0) return blocked('MISSING_OAK_LOG', observation);
    return craftAction(goal, observation, 'oak_planks', plankCraftCount(inventory, needed), 'CRAFT_OAK_PLANKS');
  }
  if (recipe === 'stick') {
    const craftCount = Math.ceil((needed - inventoryCount(inventory, 'stick')) / 4);
    const requiredPlanks = craftCount * 2;
    if (inventoryCount(inventory, 'oak_planks') < requiredPlanks) {
      if (inventoryCount(inventory, 'oak_log') === 0) return blocked('MISSING_OAK_PLANKS', observation);
      return craftAction(goal, observation, 'oak_planks', plankCraftCount(inventory, requiredPlanks), 'CRAFT_OAK_PLANKS_FOR_STICKS');
    }
    return craftAction(goal, observation, 'stick', craftCount, 'CRAFT_STICKS');
  }
  if (recipe === 'crafting_table') {
    const requiredPlanks = needed * 4;
    if (inventoryCount(inventory, 'oak_planks') < requiredPlanks) {
      if (inventoryCount(inventory, 'oak_log') === 0) return blocked('MISSING_OAK_PLANKS', observation);
      return craftAction(goal, observation, 'oak_planks', plankCraftCount(inventory, requiredPlanks), 'CRAFT_OAK_PLANKS_FOR_TABLE');
    }
    return craftAction(goal, observation, 'crafting_table', needed, 'CRAFT_CRAFTING_TABLE');
  }
  return undefined;
}

function craftPickaxe(goal, observation) {
  const inventory = actorObservation(observation, goal.actor).inventory;
  const requiredSticks = goal.count * 2;
  const tableAlreadyAvailable = observation.placedAtMarks[goal.mark] === 'crafting_table' || inventoryCount(inventory, 'crafting_table') > 0;
  const totalPlanks = (goal.count * 3) + (Math.ceil(Math.max(0, requiredSticks - inventoryCount(inventory, 'stick')) / 4) * 2) + (tableAlreadyAvailable ? 0 : 4);
  if (inventoryCount(inventory, 'stick') < requiredSticks) {
    if (inventoryCount(inventory, 'oak_planks') >= 2) {
      return craftAction(goal, observation, 'stick', Math.ceil((requiredSticks - inventoryCount(inventory, 'stick')) / 4), 'CRAFT_STICKS_FOR_PICKAXE');
    }
    if (inventoryCount(inventory, 'oak_log') > 0) {
      return craftAction(goal, observation, 'oak_planks', plankCraftCount(inventory, totalPlanks), 'CRAFT_OAK_PLANKS_FOR_PICKAXE');
    }
    return blocked('MISSING_OAK_PLANKS', observation);
  }
  if (observation.placedAtMarks[goal.mark] !== 'crafting_table') {
    if (inventoryCount(inventory, 'crafting_table') > 0) {
      return action('placeAtMark', { actor: goal.actor, goalId: goal.id, item: 'crafting_table', mark: goal.mark }, 'PLACE_TABLE_FOR_PICKAXE', observation.version);
    }
    if (inventoryCount(inventory, 'oak_planks') >= 4) return craftAction(goal, observation, 'crafting_table', 1, 'CRAFT_TABLE_FOR_PICKAXE');
    if (inventoryCount(inventory, 'oak_log') > 0) return craftAction(goal, observation, 'oak_planks', plankCraftCount(inventory, totalPlanks), 'CRAFT_OAK_PLANKS_FOR_PICKAXE');
    return blocked('MISSING_CRAFTING_TABLE', observation);
  }
  if (inventoryCount(inventory, 'oak_planks') < goal.count * 3) {
    if (inventoryCount(inventory, 'oak_log') > 0) return craftAction(goal, observation, 'oak_planks', plankCraftCount(inventory, totalPlanks), 'CRAFT_OAK_PLANKS_FOR_PICKAXE');
    return blocked('MISSING_OAK_PLANKS', observation);
  }
  return craftAction(goal, observation, 'wooden_pickaxe', goal.count, 'CRAFT_WOODEN_PICKAXE');
}

function nextAction(goal, observation, reservations) {
  if (observation.stale === true) return blocked('STALE_OBSERVATION', observation);
  if (observation.replanCount >= goal.maxReplans) return blocked('REPLAN_BUDGET_EXHAUSTED', observation);
  const actor = actorObservation(observation, goal.actor);
  if (goal.kind === 'gather') {
    const drop = firstAvailableDrop(observation.drops, goal.actor, reservations, (item) => item.item === goal.item && item.region === goal.region);
    if (drop) return action('collectItem', { actor: goal.actor, goalId: goal.id, dropId: drop.id, item: goal.item, region: goal.region }, 'COLLECT_GATHERED_DROP', observation.version);
    const target = firstAvailable(observation.targets, goal.actor, reservations, (item) => item.region === goal.region && item.block === goal.item);
    return target ? targetAction(goal, observation, target, 'gather') : blocked('NO_TARGET_AVAILABLE', observation);
  }
  if (goal.kind === 'regroup') return action('moveNearTarget', { actor: goal.actor, goalId: goal.id, mark: goal.mark }, 'MOVE_TO_REGROUP_MARK', observation.version);
  if (goal.kind === 'place') {
    if (inventoryCount(actor.inventory, goal.block) > 0) {
      return action('placeAtMark', { actor: goal.actor, goalId: goal.id, item: goal.block, mark: goal.mark }, 'PLACE_REQUIRED_BLOCK', observation.version);
    }
    return craftDependency(goal, observation, 'crafting_table');
  }
  if (goal.kind === 'equip') {
    return inventoryCount(actor.inventory, goal.item) > 0
      ? action('equipItem', { actor: goal.actor, goalId: goal.id, item: goal.item, destination: goal.destination }, 'EQUIP_REQUIRED_ITEM', observation.version)
      : blocked('MISSING_EQUIPMENT_ITEM', observation);
  }
  if (goal.kind === 'excavate') {
    const drop = firstAvailableDrop(observation.drops, goal.actor, reservations, (item) => item.item === goal.item && item.region === goal.region);
    if (drop) return action('collectItem', { actor: goal.actor, goalId: goal.id, dropId: drop.id, item: goal.item, region: goal.region }, 'COLLECT_EXCAVATED_DROP', observation.version);
    const target = firstAvailable(observation.targets, goal.actor, reservations, (item) => item.region === goal.region && item.block === goal.block);
    return target ? targetAction(goal, observation, target, 'excavation') : blocked('NO_TARGET_AVAILABLE', observation);
  }
  if (!RECIPE_NAMES.has(goal.recipe)) throw coded('PLANNER_RECIPE_INVALID');
  if (goal.recipe === 'wooden_pickaxe') return craftPickaxe(goal, observation);
  return craftDependency(goal, observation, goal.recipe);
}

export function planSurvivalStep({ goal, observation, reservations }) {
  validatePlannerInput(goal, observation, reservations);
  if (observation.stale === true) return blocked('STALE_OBSERVATION', observation);
  if (completionSatisfied(goal.completion, observation)) {
    return decision('completed', 'GOAL_SATISFIED', observation.version);
  }
  return nextAction(goal, observation, reservations);
}

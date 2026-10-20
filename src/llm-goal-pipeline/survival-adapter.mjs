import { Vec3 } from 'vec3';

const MAX_TARGETS = 24;
const MOVE_RANGE = 2;

function coded(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function requireMethod(value, name) {
  if (typeof value?.[name] !== 'function') throw coded('PIPELINE_ADAPTER_UNAVAILABLE', `${name} is unavailable`);
  return value[name].bind(value);
}

function positionOf(value) {
  const position = value?.position ?? value;
  if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) return null;
  return new Vec3(position.x, position.y, position.z);
}

function blockName(block) {
  return typeof block?.name === 'string' ? block.name : 'unknown';
}

function inventoryMap(bot) {
  const result = {};
  const items = typeof bot.inventory?.items === 'function' ? bot.inventory.items() : [];
  for (const item of Array.isArray(items) ? items : []) {
    if (typeof item?.name !== 'string' || !Number.isSafeInteger(item.count) || item.count <= 0) continue;
    result[item.name] = (result[item.name] ?? 0) + item.count;
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

function publicInventory(map) {
  return Object.entries(map).map(([item, count]) => ({ item, count }));
}

function dimensionName(value) {
  const name = typeof value === 'string' ? value : value?.name;
  return typeof name === 'string' ? name.replace(/^minecraft:/u, '') : 'unknown';
}

function connected(bot) {
  if (bot._client?.socket?.destroyed === true || bot._client?.ended === true) return false;
  if (typeof bot._client?.state === 'string' && bot._client.state !== 'play') return false;
  return Boolean(bot.entity && bot.player);
}

function within(point, origin, radius) {
  return positionOf(point)?.distanceTo(positionOf(origin)) <= radius;
}

function inside(point, region) {
  return ['x', 'y', 'z'].every((axis) => point[axis] >= region.min[axis] && point[axis] <= region.max[axis]);
}

function regionName(position, permissions) {
  return permissions.protectedRegions.find((region) => inside(position, region))?.id ?? 'origin';
}

function timeOfDay(bot) {
  const time = Number(bot.time?.timeOfDay);
  if (!Number.isFinite(time)) return 'unknown';
  if (time < 1_000 || time >= 23_000) return 'dawn';
  if (time < 12_000) return 'day';
  if (time < 13_000) return 'dusk';
  return 'night';
}

function requestIdentity(action) {
  return JSON.stringify(action);
}

function count(snapshot, item) {
  return snapshot?.actor?.inventory?.[item] ?? 0;
}

function hasCapability(contract, capability) {
  return contract?.authority?.capabilities?.includes(capability) === true;
}

function authorized(contract, category, value) {
  return contract?.authority?.[category]?.includes(value) === true;
}

function receipt(action, ok, code, facts = []) {
  return Object.freeze({ request: structuredClone(action), ok, code, facts: structuredClone(facts) });
}

function droppedItem(entity) {
  try {
    const item = entity?.getDroppedItem?.();
    if (typeof item?.name === 'string') return { name: item.name, count: item.count ?? 1 };
  } catch {}
  if (typeof entity?.itemName === 'string') return { name: entity.itemName, count: entity.count ?? 1 };
  return null;
}

export function createSurvivalAdapter({ bot, goals, Movements, permissions } = {}) {
  if (!bot || typeof bot !== 'object') throw new TypeError('bot must be an object');
  if (typeof goals?.GoalNear !== 'function') throw new TypeError('goals.GoalNear must be a constructor');
  if (typeof Movements !== 'function') throw new TypeError('Movements must be a constructor');
  if (!permissions || typeof permissions !== 'object') throw new TypeError('permissions must be an object');

  let observationVersion = 0;
  let targets = new Map();
  let lastExecution = null;

  function stopEffects() {
    try { bot.pathfinder?.stop?.(); } catch {}
    try { bot.stopDigging?.(); } catch {}
  }

  async function isConnected({ signal } = {}) {
    if (signal?.aborted) throw coded('PIPELINE_ACTION_ABORTED', 'adapter operation was aborted');
    return connected(bot);
  }

  function assertSignal(signal) {
    if (signal?.aborted) throw coded('PIPELINE_ACTION_ABORTED', 'adapter operation was aborted');
  }

  function assertFence(action, before) {
    if (action?.observationVersion !== observationVersion || before?.observationVersion !== observationVersion) {
      return receipt(action, false, 'STALE_OBSERVATION');
    }
    return null;
  }

  function resolveTarget(action, kind) {
    const target = targets.get(action?.targetId);
    if (!target) return { error: receipt(action, false, 'UNKNOWN_TARGET') };
    if (kind && target.kind !== kind) return { error: receipt(action, false, 'INCOMPATIBLE_TARGET') };
    return { target };
  }

  function permittedRadius(contract, field, ceiling) {
    const value = contract?.budget?.[field];
    return Number.isSafeInteger(value) && value > 0 ? Math.min(value, ceiling) : ceiling;
  }

  async function observe({ contract, signal } = {}) {
    assertSignal(signal);
    const origin = positionOf(bot.entity);
    if (!origin) throw coded('PIPELINE_OBSERVATION_INVALID', 'actor position is unavailable');
    const scanRadius = permittedRadius(contract, 'maximumSearchRadius', permissions.maximumSearchRadius);
    const travelRadius = permittedRadius(contract, 'maximumTravelRadius', permissions.maximumTravelRadius);
    const blockIds = permissions.mineableBlocks
      .map((name) => bot.registry?.blocksByName?.[name]?.id)
      .filter(Number.isSafeInteger);
    const positions = blockIds.length === 0 ? [] : requireMethod(bot, 'findBlocks')({
      matching: blockIds, maxDistance: scanRadius, count: MAX_TARGETS * 2, point: origin
    });
    const candidates = [];
    const seen = new Set();
    for (const raw of Array.isArray(positions) ? positions : []) {
      const position = positionOf(raw);
      if (!position || seen.has(position.toString())) continue;
      seen.add(position.toString());
      const block = requireMethod(bot, 'blockAt')(position);
      const name = blockName(block);
      if (!permissions.mineableBlocks.includes(name) || !authorized(contract, 'blocks', name)) continue;
      if (!within(position, permissions.origin, travelRadius)) continue;
      if (permissions.protectedRegions.some((region) => inside(position, region))) continue;
      candidates.push({ kind: 'block', block: name, position, distance: position.distanceTo(origin) });
    }
    for (const entity of Object.values(bot.entities ?? {})) {
      if (!entity || entity === bot.entity) continue;
      const position = positionOf(entity);
      if (!position || !within(position, origin, scanRadius) || !within(position, permissions.origin, travelRadius)) continue;
      if (permissions.protectedRegions.some((region) => inside(position, region))) continue;
      const drop = droppedItem(entity);
      if (drop && authorized(contract, 'items', drop.name) && hasCapability(contract, 'collect_item')) {
        candidates.push({ kind: 'drop', item: drop.name, count: drop.count, entity, position, distance: position.distanceTo(origin) });
      } else if (typeof entity.name === 'string' && permissions.attackableEntities.includes(entity.name)
        && authorized(contract, 'entities', entity.name) && hasCapability(contract, 'attack_hostile')) {
        candidates.push({ kind: 'entity', entityName: entity.name, entity, position, distance: position.distanceTo(origin) });
      }
    }
    candidates.sort((a, b) => a.distance - b.distance
      || (a.block ?? a.item ?? a.entityName).localeCompare(b.block ?? b.item ?? b.entityName));

    observationVersion += 1;
    const nextTargets = new Map();
    const publicTargets = candidates.slice(0, MAX_TARGETS).map((candidate, index) => {
      const id = `observation-${observationVersion}-target-${index + 1}`;
      nextTargets.set(id, { ...candidate, position: candidate.position.clone() });
      if (candidate.kind === 'block') {
        return { id, targetId: id, kind: 'block', block: candidate.block, state: 'solid', distance: candidate.distance };
      }
      if (candidate.kind === 'drop') {
        return { id, targetId: id, kind: 'drop', item: candidate.item, count: candidate.count, state: 'present', distance: candidate.distance };
      }
      return { id, targetId: id, kind: 'entity', entity: candidate.entityName, hostile: true, state: 'present', distance: candidate.distance };
    });
    targets = nextTargets;
    const inventory = inventoryMap(bot);
    const recipes = permissions.recipes.filter((name) => {
      if (!authorized(contract, 'recipes', name)) return false;
      const itemId = bot.registry?.itemsByName?.[name]?.id;
      if (!Number.isSafeInteger(itemId) || typeof bot.recipesFor !== 'function') return false;
      return bot.recipesFor(itemId, null, 1, null)?.length > 0;
    });
    const actor = {
      alive: connected(bot) && Number(bot.health) > 0,
      connected: connected(bot),
      health: Number.isFinite(bot.health) ? bot.health : 0,
      hunger: Number.isFinite(bot.food) ? bot.food : 0,
      dimension: dimensionName(bot.game?.dimension),
      region: regionName(origin, permissions),
      inventory,
      equippedItem: bot.heldItem?.name ?? null
    };
    return Object.freeze({
      observationVersion, actor, connected: actor.connected, alive: actor.alive,
      inventory: publicInventory(inventory),
      blocks: publicTargets.filter(({ kind }) => kind === 'block').map(({ block, distance }) => ({ block, distance })),
      entities: publicTargets.filter(({ kind }) => kind === 'entity').map(({ entity, distance, hostile }) => ({ entity, distance, hostile })),
      targets: publicTargets,
      landmarks: authorized(contract, 'landmarks', 'safe:origin')
        ? [{ reference: 'safe:origin', visible: true, reached: origin.distanceTo(positionOf(permissions.origin)) <= MOVE_RANGE }]
        : [],
      recipes,
      timeOfDay: timeOfDay(bot), weather: bot.isRaining ? 'rain' : 'clear',
      containers: [], blueprints: []
    });
  }

  async function navigate(action, { contract, signal }) {
    if (!hasCapability(contract, 'navigate')) return receipt(action, false, 'CAPABILITY_DENIED');
    const resolved = resolveTarget(action);
    if (resolved.error) return resolved.error;
    const travelRadius = permittedRadius(contract, 'maximumTravelRadius', permissions.maximumTravelRadius);
    if (!within(resolved.target.position, permissions.origin, travelRadius)) return receipt(action, false, 'TRAVEL_LIMIT');
    assertSignal(signal);
    const movements = new Movements(bot);
    movements.canDig = false;
    movements.scafoldingBlocks = [];
    requireMethod(bot.pathfinder, 'setMovements')(movements);
    await requireMethod(bot.pathfinder, 'goto')(new goals.GoalNear(
      resolved.target.position.x, resolved.target.position.y, resolved.target.position.z, MOVE_RANGE
    ));
    assertSignal(signal);
    lastExecution = { identity: requestIdentity(action), kind: action.kind, position: resolved.target.position.clone(), block: resolved.target.block };
    return receipt(action, true, 'NAVIGATION_COMPLETED');
  }

  async function mine(action, { contract, signal }) {
    if (!hasCapability(contract, 'mine_block')) return receipt(action, false, 'CAPABILITY_DENIED');
    const resolved = resolveTarget(action, 'block');
    if (resolved.error) return resolved.error;
    const name = resolved.target.block;
    if (!permissions.mineableBlocks.includes(name) || !authorized(contract, 'blocks', name)) return receipt(action, false, 'BLOCK_DENIED');
    if (permissions.protectedRegions.some((region) => inside(resolved.target.position, region))) return receipt(action, false, 'PROTECTED_REGION');
    const live = requireMethod(bot, 'blockAt')(resolved.target.position);
    if (blockName(live) !== name) return receipt(action, false, 'TARGET_CHANGED');
    assertSignal(signal);
    await requireMethod(bot, 'dig')(live);
    assertSignal(signal);
    const output = name === 'stone' ? 'cobblestone' : name;
    lastExecution = { identity: requestIdentity(action), kind: action.kind, position: resolved.target.position.clone(), block: name, output };
    return receipt(action, true, 'MINE_COMPLETED');
  }

  async function craft(action, { contract, signal }) {
    if (!hasCapability(contract, 'craft_recipe')) return receipt(action, false, 'CAPABILITY_DENIED');
    if (!permissions.recipes.includes(action.recipe) || !authorized(contract, 'recipes', action.recipe)) return receipt(action, false, 'RECIPE_DENIED');
    if (!Number.isSafeInteger(action.count) || action.count < 1 || action.count > 64) return receipt(action, false, 'COUNT_INVALID');
    const itemId = bot.registry?.itemsByName?.[action.recipe]?.id;
    const recipe = Number.isSafeInteger(itemId) && typeof bot.recipesFor === 'function'
      ? bot.recipesFor(itemId, null, action.count, null)?.[0] : null;
    if (!recipe) return receipt(action, false, 'RECIPE_UNAVAILABLE');
    assertSignal(signal);
    await requireMethod(bot, 'craft')(recipe, action.count, null);
    assertSignal(signal);
    lastExecution = { identity: requestIdentity(action), kind: action.kind, item: action.recipe };
    return receipt(action, true, 'CRAFT_COMPLETED');
  }

  async function collect(action, { contract, signal }) {
    if (!hasCapability(contract, 'collect_item')) return receipt(action, false, 'CAPABILITY_DENIED');
    const resolved = resolveTarget(action, 'drop');
    if (resolved.error) return resolved.error;
    if (!authorized(contract, 'items', resolved.target.item)) return receipt(action, false, 'ITEM_DENIED');
    const movements = new Movements(bot);
    movements.canDig = false;
    movements.scafoldingBlocks = [];
    requireMethod(bot.pathfinder, 'setMovements')(movements);
    assertSignal(signal);
    await requireMethod(bot.pathfinder, 'goto')(new goals.GoalNear(
      resolved.target.position.x, resolved.target.position.y, resolved.target.position.z, 1
    ));
    assertSignal(signal);
    lastExecution = { identity: requestIdentity(action), kind: action.kind, item: resolved.target.item };
    return receipt(action, true, 'COLLECT_COMPLETED');
  }

  function ownedItem(name) {
    return (typeof bot.inventory?.items === 'function' ? bot.inventory.items() : [])
      .find((item) => item?.name === name && Number.isSafeInteger(item.count) && item.count > 0);
  }

  async function equip(action, { contract, signal }) {
    if (!hasCapability(contract, 'equip_item') || !authorized(contract, 'items', action.item)) return receipt(action, false, 'ITEM_DENIED');
    const item = ownedItem(action.item);
    if (!item) return receipt(action, false, 'ITEM_NOT_OWNED');
    assertSignal(signal);
    await requireMethod(bot, 'equip')(item, 'hand');
    assertSignal(signal);
    lastExecution = { identity: requestIdentity(action), kind: action.kind, item: action.item };
    return receipt(action, true, 'EQUIP_COMPLETED');
  }

  async function consume(action, { contract, signal }) {
    if (!hasCapability(contract, 'consume_food') || !permissions.consumableItems.includes(action.item)
      || !authorized(contract, 'items', action.item)) return receipt(action, false, 'ITEM_DENIED');
    const item = ownedItem(action.item);
    if (!item) return receipt(action, false, 'ITEM_NOT_OWNED');
    if (bot.heldItem !== item) await requireMethod(bot, 'equip')(item, 'hand');
    assertSignal(signal);
    await requireMethod(bot, 'consume')();
    assertSignal(signal);
    lastExecution = { identity: requestIdentity(action), kind: action.kind, item: action.item };
    return receipt(action, true, 'CONSUME_COMPLETED');
  }

  async function place(action, { contract, signal }) {
    if (!hasCapability(contract, 'place_block') || !permissions.placeableBlocks.includes(action.item)
      || !authorized(contract, 'items', action.item)) return receipt(action, false, 'ITEM_DENIED');
    const resolved = resolveTarget(action, 'block');
    if (resolved.error) return resolved.error;
    const item = ownedItem(action.item);
    if (!item) return receipt(action, false, 'ITEM_NOT_OWNED');
    const placedPosition = resolved.target.position.offset(0, 1, 0);
    if (blockName(requireMethod(bot, 'blockAt')(placedPosition)) !== 'air') return receipt(action, false, 'PLACEMENT_BLOCKED');
    if (bot.heldItem !== item) await requireMethod(bot, 'equip')(item, 'hand');
    assertSignal(signal);
    await requireMethod(bot, 'placeBlock')(requireMethod(bot, 'blockAt')(resolved.target.position), new Vec3(0, 1, 0));
    assertSignal(signal);
    lastExecution = { identity: requestIdentity(action), kind: action.kind, item: action.item, position: placedPosition };
    return receipt(action, true, 'PLACE_COMPLETED');
  }

  async function attack(action, { contract, signal }) {
    if (!hasCapability(contract, 'attack_hostile')) return receipt(action, false, 'CAPABILITY_DENIED');
    const resolved = resolveTarget(action, 'entity');
    if (resolved.error) return resolved.error;
    if (!permissions.attackableEntities.includes(resolved.target.entityName)
      || !authorized(contract, 'entities', resolved.target.entityName)) return receipt(action, false, 'ENTITY_DENIED');
    const entity = resolved.target.entity;
    const healthBefore = Number.isFinite(entity.health) ? entity.health : null;
    assertSignal(signal);
    await Promise.resolve(requireMethod(bot, 'attack')(entity));
    assertSignal(signal);
    lastExecution = { identity: requestIdentity(action), kind: action.kind, entityId: entity.id, entity: resolved.target.entityName, healthBefore };
    return receipt(action, true, 'ATTACK_COMPLETED');
  }

  async function retreat(action, { contract, signal }) {
    if ((!hasCapability(contract, 'retreat') && !hasCapability(contract, 'navigate'))
      || action.reference !== 'safe:origin' || !authorized(contract, 'landmarks', action.reference)) {
      return receipt(action, false, 'LANDMARK_DENIED');
    }
    const origin = positionOf(permissions.origin);
    const movements = new Movements(bot);
    movements.canDig = false;
    movements.scafoldingBlocks = [];
    requireMethod(bot.pathfinder, 'setMovements')(movements);
    assertSignal(signal);
    await requireMethod(bot.pathfinder, 'goto')(new goals.GoalNear(origin.x, origin.y, origin.z, MOVE_RANGE));
    assertSignal(signal);
    lastExecution = { identity: requestIdentity(action), kind: action.kind, position: origin };
    return receipt(action, true, 'RETREAT_COMPLETED');
  }

  async function speak(action, { contract }) {
    if (!hasCapability(contract, 'speak') || typeof action.text !== 'string' || action.text.length === 0 || action.text.length > 200) {
      return receipt(action, false, 'SPEECH_DENIED');
    }
    requireMethod(bot, 'chat')(action.text);
    lastExecution = { identity: requestIdentity(action), kind: action.kind, text: action.text };
    return receipt(action, true, 'SPEAK_COMPLETED', [{ text: action.text }]);
  }

  async function execute(action, { contract, before, signal } = {}) {
    assertSignal(signal);
    if (!action || typeof action !== 'object') return receipt({}, false, 'ACTION_INVALID');
    const stale = assertFence(action, before);
    if (stale) return stale;
    if (action.kind === 'observe') {
      lastExecution = { identity: requestIdentity(action), kind: action.kind };
      return receipt(action, true, 'OBSERVE_COMPLETED');
    }
    if (action.kind === 'navigate_to_target') return navigate(action, { contract, signal });
    if (action.kind === 'mine_target') return mine(action, { contract, signal });
    if (action.kind === 'collect_drop') return collect(action, { contract, signal });
    if (action.kind === 'craft_recipe') return craft(action, { contract, signal });
    if (action.kind === 'place_against_target') return place(action, { contract, signal });
    if (action.kind === 'equip_item') return equip(action, { contract, signal });
    if (action.kind === 'consume_item') return consume(action, { contract, signal });
    if (action.kind === 'attack_target') return attack(action, { contract, signal });
    if (action.kind === 'navigate_to_landmark') return retreat(action, { contract, signal });
    if (action.kind === 'speak') return speak(action, { contract, signal });
    return receipt(action, false, 'ACTION_DENIED');
  }

  async function verifyAction(action, executionReceipt, before, after, { signal } = {}) {
    assertSignal(signal);
    if (!executionReceipt?.ok || !lastExecution || lastExecution.identity !== requestIdentity(action)) {
      return { ok: false, code: 'ACTION_NOT_VERIFIED', facts: [] };
    }
    if (action.kind === 'observe') return { ok: after?.actor?.connected === true, code: 'OBSERVE_VERIFIED', facts: [] };
    if (action.kind === 'navigate_to_target') {
      const position = positionOf(bot.entity);
      const ok = Boolean(position && position.distanceTo(lastExecution.position) <= MOVE_RANGE
        && blockName(requireMethod(bot, 'blockAt')(lastExecution.position)) === lastExecution.block);
      return { ok, code: ok ? 'NAVIGATION_VERIFIED' : 'NAVIGATION_NOT_VERIFIED', facts: ok ? [{ targetId: action.targetId, reached: true }] : [] };
    }
    if (action.kind === 'mine_target') {
      const removed = blockName(requireMethod(bot, 'blockAt')(lastExecution.position)) !== lastExecution.block;
      const delta = count(after, lastExecution.output) - count(before, lastExecution.output);
      const ok = removed && delta > 0;
      return {
        ok, code: ok ? 'MINE_VERIFIED' : 'MINE_NOT_VERIFIED',
        facts: ok ? [{ block: lastExecution.block, removed: true }, { item: lastExecution.output, delta }] : []
      };
    }
    if (action.kind === 'craft_recipe') {
      const delta = count(after, lastExecution.item) - count(before, lastExecution.item);
      const ok = delta > 0;
      return { ok, code: ok ? 'CRAFT_VERIFIED' : 'CRAFT_NOT_VERIFIED', facts: ok ? [{ item: lastExecution.item, delta }] : [] };
    }
    if (action.kind === 'collect_drop') {
      const delta = count(after, lastExecution.item) - count(before, lastExecution.item);
      const ok = delta > 0;
      return { ok, code: ok ? 'COLLECT_VERIFIED' : 'COLLECT_NOT_VERIFIED', facts: ok ? [{ item: lastExecution.item, delta }] : [] };
    }
    if (action.kind === 'equip_item') {
      const ok = after?.actor?.equippedItem === lastExecution.item && count(after, lastExecution.item) > 0;
      return { ok, code: ok ? 'EQUIP_VERIFIED' : 'EQUIP_NOT_VERIFIED', facts: ok ? [{ item: lastExecution.item, equipped: true }] : [] };
    }
    if (action.kind === 'consume_item') {
      const delta = count(before, lastExecution.item) - count(after, lastExecution.item);
      const ok = delta > 0 && after.actor.hunger >= before.actor.hunger;
      return { ok, code: ok ? 'CONSUME_VERIFIED' : 'CONSUME_NOT_VERIFIED', facts: ok ? [{ item: lastExecution.item, consumed: delta }] : [] };
    }
    if (action.kind === 'place_against_target') {
      const delta = count(before, lastExecution.item) - count(after, lastExecution.item);
      const placed = blockName(requireMethod(bot, 'blockAt')(lastExecution.position)) === lastExecution.item;
      const ok = placed && delta > 0;
      return { ok, code: ok ? 'PLACE_VERIFIED' : 'PLACE_NOT_VERIFIED', facts: ok ? [{ block: lastExecution.item, placed: true }] : [] };
    }
    if (action.kind === 'attack_target') {
      const live = bot.entities?.[lastExecution.entityId];
      const damaged = live && lastExecution.healthBefore !== null && Number(live.health) < lastExecution.healthBefore;
      const ok = !live || damaged;
      return { ok, code: ok ? 'ATTACK_VERIFIED' : 'ATTACK_NOT_VERIFIED', facts: ok ? [{ entity: lastExecution.entity, harmed: true }] : [] };
    }
    if (action.kind === 'navigate_to_landmark') {
      const position = positionOf(bot.entity);
      const ok = Boolean(position && position.distanceTo(lastExecution.position) <= MOVE_RANGE);
      return { ok, code: ok ? 'RETREAT_VERIFIED' : 'RETREAT_NOT_VERIFIED', facts: ok ? [{ reference: action.reference, reached: true }] : [] };
    }
    if (action.kind === 'speak') {
      return { ok: executionReceipt.code === 'SPEAK_COMPLETED', code: 'SPEAK_VERIFIED', facts: [{ text: lastExecution.text }] };
    }
    return { ok: false, code: 'ACTION_NOT_VERIFIED', facts: [] };
  }

  async function cancel() {
    stopEffects();
  }

  return Object.freeze({ observe, execute, verifyAction, isConnected, cancel });
}

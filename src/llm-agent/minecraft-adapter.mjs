import { Vec3 } from 'vec3';

const MAX_SCAN_RADIUS = 32;
const MAX_TARGETS = 8;
const MOVE_RANGE = 2;
const PICKUP_TIMEOUT_MS = 1_500;
const PICKUP_POLL_MS = 50;
const TARGET_BLOCKS = new Set(['oak_log', 'gold_block']);
const GOAL_MARKER_REFERENCE = 'landmark:goal-marker';

function coded(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function abortError() {
  return coded('LLM_AGENT_ACTION_ABORTED', 'Minecraft adapter operation was aborted');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function isAbort(error) {
  return error?.code === 'LLM_AGENT_ACTION_ABORTED';
}

function requireMethod(value, name) {
  if (typeof value?.[name] !== 'function') throw coded('MINECRAFT_ADAPTER_UNAVAILABLE', `${name} is unavailable`);
  return value[name].bind(value);
}

function positionOf(value) {
  const position = value?.position ?? value;
  if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) return null;
  return new Vec3(position.x, position.y, position.z);
}

function inventoryCounts(bot) {
  const counts = new Map();
  const items = typeof bot.inventory?.items === 'function' ? bot.inventory.items() : [];
  for (const item of Array.isArray(items) ? items : []) {
    if (typeof item?.name !== 'string' || !Number.isSafeInteger(item.count) || item.count <= 0) continue;
    counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
  }
  return counts;
}

function inventoryCount(bot, name) {
  return inventoryCounts(bot).get(name) ?? 0;
}

function publicInventory(bot) {
  return [...inventoryCounts(bot)]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([item, count]) => ({ item, count }));
}

function observedInventory(observation, name) {
  if (!Array.isArray(observation?.inventory)) return 0;
  return observation.inventory
    .filter((entry) => entry?.item === name && Number.isSafeInteger(entry.count) && entry.count > 0)
    .reduce((total, entry) => total + entry.count, 0);
}

function dimensionName(dimension) {
  if (typeof dimension === 'string') return dimension;
  if (typeof dimension?.name === 'string') return dimension.name;
  return 'unknown';
}

function markerIdentity(position, dimension) {
  if (!position || !Number.isSafeInteger(position.x) || !Number.isSafeInteger(position.y) || !Number.isSafeInteger(position.z)) {
    return null;
  }
  const normalizedDimension = dimensionName(dimension);
  if (normalizedDimension.length === 0 || normalizedDimension === 'unknown') return null;
  return { dimension: normalizedDimension, x: position.x, y: position.y, z: position.z };
}

function distanceBand(distance) {
  if (distance <= 4) return 'near';
  if (distance <= 16) return 'medium';
  return 'far';
}

function publicRequest(action) {
  return structuredClone(action);
}

function receipt(action, { ok, code, message, before, after, observed = {} }) {
  return {
    request: publicRequest(action),
    ok,
    code,
    message,
    inventory: { before, after },
    observed: structuredClone(observed)
  };
}

function failureReceipt(bot, action, code, message, observed = {}) {
  const count = inventoryCount(bot, 'oak_log');
  return receipt(action, { ok: false, code, message, before: count, after: count, observed });
}

function requestIdentity(action) {
  return JSON.stringify({
    action: action?.action ?? null,
    targetId: action?.targetId ?? null,
    item: action?.item ?? null,
    reference: action?.reference ?? null
  });
}

function verification(ok, code, extras = {}) {
  return {
    ok,
    code,
    message: ok
      ? 'live world and inventory changes verified the action'
      : 'live world and inventory facts did not verify the action',
    ...extras
  };
}

function blockName(block) {
  return typeof block?.name === 'string' ? block.name : 'unknown';
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createMinecraftAdapter({ bot, goals, Movements, scanRadius = MAX_SCAN_RADIUS } = {}) {
  if (!bot || typeof bot !== 'object') throw new TypeError('bot must be an object');
  if (typeof goals?.GoalNear !== 'function') throw new TypeError('goals.GoalNear must be a constructor');
  if (typeof Movements !== 'function') throw new TypeError('Movements must be a constructor');
  if (!Number.isFinite(scanRadius) || scanRadius <= 0 || scanRadius > MAX_SCAN_RADIUS) {
    throw new TypeError(`scanRadius must be between 1 and ${MAX_SCAN_RADIUS}`);
  }

  let observationVersion = 0;
  let targetsById = new Map();
  let lastExecution = null;
  let selectedMarker = null;
  let goalMarker = null;
  let activeCancel = null;

  function connected() {
    if (bot._client?.socket?.destroyed === true || bot._client?.ended === true) return false;
    if (typeof bot._client?.state === 'string' && bot._client.state !== 'play') return false;
    return Boolean(bot.entity && bot.player);
  }

  function liveBlock(position) {
    return requireMethod(bot, 'blockAt')(position);
  }

  function lookupTarget(action, expectedBlock) {
    const target = targetsById.get(action?.targetId);
    if (!target) return { error: failureReceipt(bot, action, 'UNKNOWN_TARGET', 'target is not in the current observation') };
    if (expectedBlock && target.block !== expectedBlock) {
      return {
        error: failureReceipt(
          bot,
          action,
          expectedBlock === 'oak_log' ? 'TARGET_NOT_OAK_LOG' : 'TARGET_NOT_GOLD_BLOCK',
          `target is not a mapped ${expectedBlock}`,
          { targetBefore: blockName(liveBlock(target.position)) }
        )
      };
    }
    const block = liveBlock(target.position);
    if (blockName(block) !== target.block) {
      return {
        error: failureReceipt(bot, action, 'TARGET_CHANGED', 'target block changed after observation', {
          targetBefore: target.block,
          targetAfter: blockName(block)
        })
      };
    }
    return { target, block };
  }

  function stopMineflayerEffects() {
    try {
      bot.pathfinder?.stop?.();
    } catch {}
    try {
      bot.stopDigging?.();
    } catch {}
  }

  async function abortable(parentSignal, operation) {
    throwIfAborted(parentSignal);
    const controller = new AbortController();
    let cancelled = false;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      stopMineflayerEffects();
      controller.abort();
    };
    const onParentAbort = () => cancel();
    parentSignal?.addEventListener('abort', onParentAbort, { once: true });
    activeCancel = cancel;
    const aborted = new Promise((resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(abortError()), { once: true });
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => operation(controller.signal)),
        aborted
      ]);
    } finally {
      parentSignal?.removeEventListener('abort', onParentAbort);
      if (activeCancel === cancel) activeCancel = null;
    }
  }

  async function waitForOakPickup(before, signal) {
    const deadline = Date.now() + PICKUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const current = inventoryCount(bot, 'oak_log');
      if (current > before) return current;
      await sleep(Math.min(PICKUP_POLL_MS, Math.max(1, deadline - Date.now())));
    }
    throwIfAborted(signal);
    return inventoryCount(bot, 'oak_log');
  }

  async function waitForOakConsumption(before, signal) {
    const deadline = Date.now() + PICKUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const current = inventoryCount(bot, 'oak_log');
      if (current < before) return current;
      await sleep(Math.min(PICKUP_POLL_MS, Math.max(1, deadline - Date.now())));
    }
    throwIfAborted(signal);
    return inventoryCount(bot, 'oak_log');
  }

  async function isConnected({ signal } = {}) {
    throwIfAborted(signal);
    return connected();
  }

  async function observe({ signal } = {}) {
    throwIfAborted(signal);
    const origin = positionOf(bot.entity);
    if (!origin) throw coded('MINECRAFT_ADAPTER_UNAVAILABLE', 'bot position is unavailable');
    const oakId = bot.registry?.blocksByName?.oak_log?.id;
    const goldId = bot.registry?.blocksByName?.gold_block?.id;
    if (!Number.isSafeInteger(oakId) || !Number.isSafeInteger(goldId)) {
      throw coded('MINECRAFT_ADAPTER_UNAVAILABLE', 'oak_log or gold_block registry entry is unavailable');
    }
    const found = requireMethod(bot, 'findBlocks')({
      point: origin,
      matching: [oakId, goldId],
      maxDistance: scanRadius,
      count: 32
    });
    throwIfAborted(signal);
    const candidates = [];
    const seen = new Set();
    for (const rawPosition of Array.isArray(found) ? found : []) {
      const position = positionOf(rawPosition);
      if (!position || seen.has(position.toString())) continue;
      seen.add(position.toString());
      const block = liveBlock(position);
      if (!TARGET_BLOCKS.has(blockName(block))) continue;
      candidates.push({
        block: block.name,
        position,
        distance: position.distanceTo(origin)
      });
    }
    candidates.sort((left, right) => left.distance - right.distance
      || left.block.localeCompare(right.block)
      || left.position.y - right.position.y
      || left.position.x - right.position.x
      || left.position.z - right.position.z);

    observationVersion += 1;
    const nextTargets = new Map();
    const publicTargets = candidates.slice(0, MAX_TARGETS).map((candidate, index) => {
      const id = `target-${observationVersion}-${index + 1}`;
      nextTargets.set(id, {
        block: candidate.block,
        position: candidate.position.clone()
      });
      return {
        id,
        kind: 'block',
        block: candidate.block,
        distanceBand: distanceBand(candidate.distance),
        reachable: typeof bot.pathfinder?.goto === 'function'
      };
    });
    const visibleMarker = candidates.find(({ block }) => block === 'gold_block');
    if (visibleMarker) {
      goalMarker = {
        position: visibleMarker.position.clone(),
        dimension: dimensionName(bot.game?.dimension)
      };
    }
    targetsById = nextTargets;
    return {
      health: Number.isFinite(bot.health) ? bot.health : 0,
      food: Number.isFinite(bot.food) ? bot.food : 0,
      connected: connected(),
      dimension: dimensionName(bot.game?.dimension),
      inventory: publicInventory(bot),
      targets: publicTargets,
      landmarks: goalMarker === null ? [] : [{
        reference: GOAL_MARKER_REFERENCE,
        kind: 'gold_block',
        status: visibleMarker ? 'visible' : 'out_of_view',
        revisitable: true
      }]
    };
  }

  async function navigateToLandmark(action, options) {
    if (action?.reference !== GOAL_MARKER_REFERENCE || goalMarker === null) {
      return failureReceipt(bot, action, 'UNKNOWN_LANDMARK', 'landmark is not in trusted memory');
    }
    if (dimensionName(bot.game?.dimension) !== goalMarker.dimension
      || blockName(liveBlock(goalMarker.position)) !== 'gold_block') {
      goalMarker = null;
      return failureReceipt(bot, action, 'LANDMARK_INVALIDATED', 'remembered landmark no longer verifies as gold_block');
    }
    const before = inventoryCount(bot, 'oak_log');
    lastExecution = {
      identity: requestIdentity(action),
      action: action.action,
      position: goalMarker.position.clone(),
      targetBlock: 'gold_block'
    };
    try {
      await abortable(options.signal, async (signal) => {
        const movements = new Movements(bot);
        movements.canDig = false;
        movements.scafoldingBlocks = [];
        requireMethod(bot.pathfinder, 'setMovements')(movements);
        throwIfAborted(signal);
        await requireMethod(bot.pathfinder, 'goto')(
          new goals.GoalNear(goalMarker.position.x, goalMarker.position.y, goalMarker.position.z, MOVE_RANGE)
        );
        throwIfAborted(signal);
      });
      return receipt(action, {
        ok: true,
        code: 'LANDMARK_MOVE_REQUEST_COMPLETED',
        message: 'pathfinder completed movement toward the revalidated landmark',
        before,
        after: inventoryCount(bot, 'oak_log'),
        observed: { targetBefore: 'gold_block', targetAfter: blockName(liveBlock(goalMarker.position)) }
      });
    } catch (error) {
      if (isAbort(error)) throw error;
      return failureReceipt(bot, action, 'LANDMARK_MOVE_FAILED', 'pathfinder could not reach the landmark');
    }
  }

  async function moveToBlock(action, options) {
    const resolved = lookupTarget(action);
    if (resolved.error) return resolved.error;
    const before = inventoryCount(bot, 'oak_log');
    lastExecution = {
      identity: requestIdentity(action),
      action: action.action,
      position: resolved.target.position.clone(),
      targetBlock: resolved.target.block
    };
    try {
      await abortable(options.signal, async (signal) => {
        const movements = new Movements(bot);
        movements.canDig = false;
        movements.scafoldingBlocks = [];
        requireMethod(bot.pathfinder, 'setMovements')(movements);
        throwIfAborted(signal);
        await requireMethod(bot.pathfinder, 'goto')(
          new goals.GoalNear(resolved.target.position.x, resolved.target.position.y, resolved.target.position.z, MOVE_RANGE)
        );
        throwIfAborted(signal);
      });
      return receipt(action, {
        ok: true,
        code: 'MOVE_REQUEST_COMPLETED',
        message: 'pathfinder completed the requested GoalNear movement',
        before,
        after: inventoryCount(bot, 'oak_log'),
        observed: {
          targetBefore: blockName(resolved.block),
          targetAfter: blockName(liveBlock(resolved.target.position))
        }
      });
    } catch (error) {
      if (isAbort(error)) throw error;
      return failureReceipt(bot, action, 'MOVE_FAILED', 'pathfinder could not reach the target', {
        targetBefore: blockName(resolved.block),
        targetAfter: blockName(liveBlock(resolved.target.position))
      });
    }
  }

  async function mineBlock(action, options) {
    const resolved = lookupTarget(action, 'oak_log');
    if (resolved.error) return resolved.error;
    const before = inventoryCount(bot, 'oak_log');
    lastExecution = {
      identity: requestIdentity(action),
      action: action.action,
      position: resolved.target.position.clone(),
      inventoryBefore: before,
      targetBefore: blockName(resolved.block)
    };
    try {
      const after = await abortable(options.signal, async (signal) => {
        await requireMethod(bot, 'dig')(resolved.block);
        throwIfAborted(signal);
        return waitForOakPickup(before, signal);
      });
      const targetAfter = blockName(liveBlock(resolved.target.position));
      if (after <= before) {
        return receipt(action, {
          ok: false,
          code: 'ITEM_NOT_COLLECTED',
          message: 'the mined oak log was not collected before the pickup wait expired',
          before,
          after,
          observed: { targetBefore: 'oak_log', targetAfter }
        });
      }
      return receipt(action, {
        ok: targetAfter !== 'oak_log',
        code: targetAfter !== 'oak_log' ? 'OAK_LOG_COLLECTED' : 'BLOCK_NOT_MINED',
        message: targetAfter !== 'oak_log'
          ? 'the live oak log was removed and normal inventory pickup increased'
          : 'inventory changed but the target is still an oak log',
        before,
        after,
        observed: { targetBefore: 'oak_log', targetAfter }
      });
    } catch (error) {
      if (isAbort(error)) throw error;
      return failureReceipt(bot, action, 'MINE_FAILED', 'Mineflayer could not dig the oak log', {
        targetBefore: 'oak_log',
        targetAfter: blockName(liveBlock(resolved.target.position))
      });
    }
  }

  async function selectItem(action, options) {
    if (action?.item !== 'oak_log') {
      return failureReceipt(bot, action, 'ITEM_NOT_ALLOWED', 'only oak_log may be selected');
    }
    const item = (typeof bot.inventory?.items === 'function' ? bot.inventory.items() : [])
      .find((candidate) => candidate?.name === 'oak_log' && Number.isSafeInteger(candidate.count) && candidate.count > 0);
    if (!item) return failureReceipt(bot, action, 'ITEM_NOT_OWNED', 'no oak_log is present in live inventory');
    const before = inventoryCount(bot, 'oak_log');
    lastExecution = {
      identity: requestIdentity(action),
      action: action.action,
      inventoryBefore: before
    };
    try {
      await abortable(options.signal, async (signal) => {
        await requireMethod(bot, 'equip')(item, 'hand');
        throwIfAborted(signal);
      });
      return receipt(action, {
        ok: bot.heldItem?.name === 'oak_log',
        code: bot.heldItem?.name === 'oak_log' ? 'OAK_LOG_SELECTED' : 'ITEM_NOT_SELECTED',
        message: bot.heldItem?.name === 'oak_log' ? 'live held item is oak_log' : 'live held item did not become oak_log',
        before,
        after: inventoryCount(bot, 'oak_log'),
        observed: { heldBefore: null, heldAfter: bot.heldItem?.name ?? null }
      });
    } catch (error) {
      if (isAbort(error)) throw error;
      return failureReceipt(bot, action, 'SELECT_FAILED', 'Mineflayer could not equip the oak log');
    }
  }

  async function placeOnBlock(action, options) {
    const resolved = lookupTarget(action, 'gold_block');
    if (resolved.error) return resolved.error;
    const before = inventoryCount(bot, 'oak_log');
    if (bot.heldItem?.name !== 'oak_log') {
      return failureReceipt(bot, action, 'ITEM_NOT_SELECTED', 'live held item is not oak_log', {
        heldBefore: bot.heldItem?.name ?? null
      });
    }
    if (before === 0) return failureReceipt(bot, action, 'ITEM_NOT_OWNED', 'no oak_log is present in live inventory');
    const above = resolved.target.position.offset(0, 1, 0);
    const aboveBefore = blockName(liveBlock(above));
    selectedMarker = { targetId: action.targetId, position: resolved.target.position.clone() };
    lastExecution = {
      identity: requestIdentity(action),
      action: action.action,
      position: resolved.target.position.clone(),
      inventoryBefore: before,
      targetBefore: blockName(resolved.block),
      aboveBefore
    };
    try {
      const after = await abortable(options.signal, async (signal) => {
        await requireMethod(bot, 'placeBlock')(resolved.block, new Vec3(0, 1, 0));
        throwIfAborted(signal);
        return waitForOakConsumption(before, signal);
      });
      const targetAfter = blockName(liveBlock(resolved.target.position));
      const aboveAfter = blockName(liveBlock(above));
      const placed = targetAfter === 'gold_block' && aboveAfter === 'oak_log' && after < before;
      return receipt(action, {
        ok: placed,
        code: placed ? 'OAK_LOG_PLACED' : 'BLOCK_NOT_PLACED',
        message: placed ? 'live world and inventory show an oak log placed above gold' : 'live placement facts did not change as required',
        before,
        after,
        observed: { targetBefore: 'gold_block', targetAfter, aboveBefore, aboveAfter }
      });
    } catch (error) {
      if (isAbort(error)) throw error;
      return receipt(action, {
        ok: false,
        code: 'PLACE_FAILED',
        message: 'Mineflayer could not place the oak log',
        before,
        after: inventoryCount(bot, 'oak_log'),
        observed: {
          targetBefore: 'gold_block',
          targetAfter: blockName(liveBlock(resolved.target.position)),
          aboveBefore,
          aboveAfter: blockName(liveBlock(above))
        }
      });
    }
  }

  async function execute(action, { signal } = {}) {
    throwIfAborted(signal);
    if (!action || typeof action !== 'object') {
      return failureReceipt(bot, {}, 'ACTION_INVALID', 'action must be an object');
    }
    if (action.action === 'move_to_block') return moveToBlock(action, { signal });
    if (action.action === 'navigate_to_landmark') return navigateToLandmark(action, { signal });
    if (action.action === 'mine_block') return mineBlock(action, { signal });
    if (action.action === 'select_item') return selectItem(action, { signal });
    if (action.action === 'place_on_block') return placeOnBlock(action, { signal });
    if (action.action === 'observe' || action.action === 'finish') {
      const count = inventoryCount(bot, 'oak_log');
      lastExecution = { identity: requestIdentity(action), action: action.action };
      return receipt(action, {
        ok: true,
        code: action.action === 'observe' ? 'OBSERVATION_REQUEST_COMPLETED' : 'FINISH_REQUEST_DEFERRED',
        message: action.action === 'observe'
          ? 'the controller already holds a fresh observation'
          : 'finish requires separate live goal verification',
        before: count,
        after: count
      });
    }
    return failureReceipt(bot, action, 'ACTION_NOT_ALLOWED', 'action is outside the adapter allowlist');
  }

  async function verifyAction(action, { before, after } = {}, { signal } = {}) {
    throwIfAborted(signal);
    if (!lastExecution || lastExecution.identity !== requestIdentity(action)) {
      return verification(false, 'ACTION_NOT_VERIFIED');
    }
    let proved = false;
    let code = 'ACTION_NOT_VERIFIED';
    if (action.action === 'observe') {
      proved = after?.connected === true;
      code = 'OBSERVATION_VERIFIED';
    } else if (action.action === 'move_to_block' || action.action === 'navigate_to_landmark') {
      const livePosition = positionOf(bot.entity);
      proved = Boolean(livePosition && livePosition.distanceTo(lastExecution.position) <= MOVE_RANGE
        && blockName(liveBlock(lastExecution.position)) === lastExecution.targetBlock);
      code = action.action === 'move_to_block' ? 'MOVEMENT_VERIFIED' : 'LANDMARK_NAVIGATION_VERIFIED';
    } else if (action.action === 'mine_block') {
      const targetRemoved = lastExecution.targetBefore === 'oak_log'
        && blockName(liveBlock(lastExecution.position)) !== 'oak_log';
      const inventoryIncreased = observedInventory(after, 'oak_log') > observedInventory(before, 'oak_log');
      if (targetRemoved && !inventoryIncreased) {
        return {
          ok: false,
          code: 'ITEM_NOT_COLLECTED',
          message: 'the live oak log disappeared without an oak_log inventory increase'
        };
      }
      proved = targetRemoved && inventoryIncreased;
      code = 'OAK_LOG_MINING_VERIFIED';
    } else if (action.action === 'select_item') {
      proved = bot.heldItem?.name === 'oak_log' && observedInventory(after, 'oak_log') > 0;
      code = 'OAK_LOG_SELECTION_VERIFIED';
    } else if (action.action === 'place_on_block') {
      if (lastExecution.targetBefore !== 'gold_block') {
        return verification(false, 'PLACEMENT_TARGET_WAS_NOT_GOLD', {
          message: 'the mapped placement target was not gold_block before execution'
        });
      }
      if (blockName(liveBlock(lastExecution.position)) !== 'gold_block') {
        return verification(false, 'PLACEMENT_MARKER_CHANGED', {
          message: 'the live placement marker is no longer gold_block'
        });
      }
      if (lastExecution.aboveBefore === 'oak_log') {
        return verification(false, 'PLACEMENT_PREEXISTED', {
          message: 'an oak_log was already above the marker before execution'
        });
      }
      if (blockName(liveBlock(lastExecution.position.offset(0, 1, 0))) !== 'oak_log') {
        return verification(false, 'PLACED_BLOCK_NOT_PRESENT', {
          message: 'the live block above the gold marker is not oak_log'
        });
      }
      if (observedInventory(after, 'oak_log') >= observedInventory(before, 'oak_log')) {
        return verification(false, 'PLACEMENT_INVENTORY_NOT_CONSUMED', {
          message: 'oak_log inventory did not decrease after placement'
        });
      }
      proved = true;
      code = 'OAK_LOG_PLACEMENT_VERIFIED';
    } else if (action.action === 'finish') {
      proved = (await verifyGoal(undefined, { signal })).ok === true;
      code = 'GOAL_VERIFIED';
    }
    throwIfAborted(signal);
    const marker = action.action === 'place_on_block' && proved
      ? markerIdentity(lastExecution.position, bot.game?.dimension)
      : null;
    return verification(proved, proved ? code : 'ACTION_NOT_VERIFIED', marker === null ? {} : { marker });
  }

  async function verifyGoal(goal, { signal } = {}) {
    throwIfAborted(signal);
    const successKind = goal?.successCondition?.kind ?? 'oak_log_above_gold_marker';
    if (!new Set(['oak_log_above_gold_marker', 'oak_log_collected_from_above_gold_marker']).has(successKind)) {
      return { ok: false, proof: null };
    }
    if (!selectedMarker) return { ok: false, proof: null };
    const marker = liveBlock(selectedMarker.position);
    const above = liveBlock(selectedMarker.position.offset(0, 1, 0));
    throwIfAborted(signal);
    const expectedAbove = successKind === 'oak_log_above_gold_marker' ? 'oak_log' : 'air';
    const collectedCount = inventoryCount(bot, 'oak_log');
    if (blockName(marker) !== 'gold_block' || blockName(above) !== expectedAbove
      || (successKind === 'oak_log_collected_from_above_gold_marker' && collectedCount < 1)) {
      return { ok: false, proof: null };
    }
    const stableMarker = markerIdentity(selectedMarker.position, bot.game?.dimension);
    if (stableMarker === null) return { ok: false, proof: null };
    return {
      ok: true,
      proof: successKind === 'oak_log_above_gold_marker'
        ? { markerTargetId: selectedMarker.targetId, marker: stableMarker, markerBlock: 'gold_block', aboveBlock: 'oak_log' }
        : {
            markerTargetId: selectedMarker.targetId,
            marker: stableMarker,
            markerBlock: 'gold_block',
            aboveBlock: 'air',
            collectedItem: 'oak_log',
            collectedCount
          }
    };
  }

  async function inspectPrerequisite(goal, latestAgentState, { signal } = {}) {
    throwIfAborted(signal);
    if (goal?.successCondition?.kind !== 'oak_log_collected_from_above_gold_marker') return { ok: false, proof: null };
    const proof = latestAgentState?.trusted?.evidence?.goalProof;
    const marker = proof?.marker;
    if (proof?.markerBlock !== 'gold_block' || proof?.aboveBlock !== 'oak_log'
      || typeof proof.markerTargetId !== 'string' || !marker
      || dimensionName(marker.dimension) !== dimensionName(bot.game?.dimension)
      || !Number.isSafeInteger(marker.x) || !Number.isSafeInteger(marker.y) || !Number.isSafeInteger(marker.z)) {
      return { ok: false, proof: null };
    }
    const position = new Vec3(marker.x, marker.y, marker.z);
    if (blockName(liveBlock(position)) !== 'gold_block' || blockName(liveBlock(position.offset(0, 1, 0))) !== 'oak_log') {
      return { ok: false, proof: null };
    }
    selectedMarker = { targetId: proof.markerTargetId, position };
    return { ok: true, proof: structuredClone(proof) };
  }

  function stop() {
    if (activeCancel) activeCancel();
    else stopMineflayerEffects();
  }

  return Object.freeze({ isConnected, observe, execute, verifyAction, verifyGoal, inspectPrerequisite, stop });
}

import { Vec3 } from 'vec3';

import { FINAL_SURVIVAL_DEMO_LINE } from './survival-demo-contracts.mjs';

const ACTIONS = new Set([
  'gather_wood', 'craft_and_place_table', 'craft_wooden_pickaxe', 'mine_stone',
  'craft_furnace', 'find_village', 'say_final_line'
]);
const EXPLORATION_OFFSETS = Object.freeze([
  [24, 0], [24, 24], [0, 24], [-24, 24], [-24, 0], [-24, -24], [0, -24], [24, -24]
]);

function coded(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function point(value) {
  return value && [value.x, value.y, value.z].every(Number.isFinite);
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function countItem(bot, name) {
  const items = bot.inventory?.items?.();
  if (!Array.isArray(items)) throw coded('SURVIVAL_DEMO_INVENTORY_UNAVAILABLE', 'inventory is unavailable');
  return items.filter((item) => item?.name === name)
    .reduce((total, item) => total + (Number.isSafeInteger(item.count) ? item.count : 0), 0);
}

function inventoryItem(bot, name) {
  return bot.inventory.items().find((item) => item?.name === name) ?? null;
}

function completeVillage(value) {
  return value?.bell === true && Number.isSafeInteger(value.beds) && value.beds >= 1
    && Number.isSafeInteger(value.villagers) && value.villagers >= 1;
}

export function createSurvivalDemoMacroExecutor({
  bot,
  goals,
  Movements,
  villageObserver,
  clearingStart,
  actionTimeoutMs = 45_000,
  waitImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
} = {}) {
  if (!bot || typeof bot !== 'object') throw new TypeError('bot must be an object');
  if (typeof goals?.GoalNear !== 'function') throw new TypeError('goals.GoalNear must be a function');
  if (typeof goals?.GoalFollow !== 'function') throw new TypeError('goals.GoalFollow must be a function');
  if (typeof Movements !== 'function') throw new TypeError('Movements must be a function');
  if (typeof villageObserver !== 'function') throw new TypeError('villageObserver must be a function');
  if (!point(clearingStart)) throw new TypeError('clearingStart must contain finite x, y, and z');
  if (!Number.isSafeInteger(actionTimeoutMs) || actionTimeoutMs < 1 || actionTimeoutMs > 60_000) {
    throw new TypeError('actionTimeoutMs must be between 1 and 60000');
  }
  if (typeof waitImpl !== 'function') throw new TypeError('waitImpl must be a function');

  let cancelled = false;
  let tablePosition = null;

  function stopPhysicalWork() {
    bot.pathfinder?.stop?.();
    bot.stopDigging?.();
  }

  function assertActive(signal) {
    if (cancelled || signal?.aborted) {
      stopPhysicalWork();
      throw coded('SURVIVAL_DEMO_ABORTED', 'survival macro action was aborted');
    }
  }

  async function controlled(operation, signal) {
    assertActive(signal);
    let timer;
    let abortListener;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        stopPhysicalWork();
        reject(coded('SURVIVAL_DEMO_ACTION_TIMEOUT', `survival macro exceeded ${actionTimeoutMs}ms`));
      }, actionTimeoutMs);
    });
    const aborted = new Promise((_, reject) => {
      abortListener = () => {
        stopPhysicalWork();
        reject(coded('SURVIVAL_DEMO_ABORTED', 'survival macro action was aborted'));
      };
      signal?.addEventListener('abort', abortListener, { once: true });
    });
    try {
      return await Promise.race([operation(), timeout, aborted]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortListener);
    }
  }

  function nonDiggingMovements() {
    const movements = new Movements(bot);
    movements.canDig = false;
    return movements;
  }

  async function approach(position, range, signal) {
    assertActive(signal);
    if (typeof bot.pathfinder?.goto !== 'function' || typeof bot.pathfinder.setMovements !== 'function') {
      throw coded('SURVIVAL_DEMO_PATHFINDER_UNAVAILABLE', 'pathfinder is unavailable');
    }
    bot.pathfinder.setMovements(nonDiggingMovements());
    await bot.pathfinder.goto(new goals.GoalNear(position.x, position.y, position.z, range));
    assertActive(signal);
  }

  async function collectMatchingDrop(name, before, targetPosition, previousEntityIds, signal) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      assertActive(signal);
      if (countItem(bot, name) > before) return;
      const drop = Object.entries(bot.entities ?? {})
        .filter(([id]) => !previousEntityIds.has(id))
        .map(([, entity]) => entity)
        .find((entity) => {
          if (entity?.name !== 'item' || entity.isValid === false || !point(entity.position)
            || distance(entity.position, targetPosition) > 4 || typeof entity.getDroppedItem !== 'function') return false;
          try { return entity.getDroppedItem()?.name === name; } catch { return false; }
        });
      if (drop) {
        bot.pathfinder.setMovements(nonDiggingMovements());
        try {
          await bot.pathfinder.goto(new goals.GoalFollow(drop, 0));
        } catch (error) {
          if (countItem(bot, name) <= before && drop.isValid !== false) throw error;
        }
      }
      await waitImpl(100);
    }
    throw coded('SURVIVAL_DEMO_ITEM_NOT_COLLECTED', `${name} was not collected normally`);
  }

  async function waitForGround(signal) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      assertActive(signal);
      if (bot.entity?.onGround === true) return;
      await waitImpl(100);
    }
    throw coded('SURVIVAL_DEMO_NOT_GROUNDED', 'actor did not settle on the ground before digging');
  }

  async function digAndCollect(blockName, dropName, targetCount, signal) {
    const blockId = bot.registry?.blocksByName?.[blockName]?.id;
    if (!Number.isSafeInteger(blockId) || typeof bot.findBlock !== 'function'
      || typeof bot.blockAt !== 'function' || typeof bot.dig !== 'function') {
      throw coded('SURVIVAL_DEMO_WORLD_PORT_UNAVAILABLE', `${blockName} world ports are unavailable`);
    }
    let completed = 0;
    while (completed < targetCount) {
      assertActive(signal);
      const search = { matching: blockId, maxDistance: 32 };
      if (blockName === 'stone') {
        search.useExtraInfo = (candidate) => [
          [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]
        ].some(([dx, dy, dz]) => bot.blockAt(new Vec3(
          candidate.position.x + dx,
          candidate.position.y + dy,
          candidate.position.z + dz
        ))?.name === 'air');
      }
      const target = bot.findBlock(search);
      if (!target || target.name !== blockName || !point(target.position)) {
        throw coded('SURVIVAL_DEMO_TARGET_NOT_FOUND', `bounded ${blockName} target was not found`);
      }
      await approach({ x: target.position.x, y: clearingStart.y, z: target.position.z }, 1, signal);
      await waitForGround(signal);
      const live = bot.blockAt(new Vec3(target.position.x, target.position.y, target.position.z));
      if (!live || live.name !== blockName) throw coded('SURVIVAL_DEMO_TARGET_CHANGED', `${blockName} target changed`);
      const before = countItem(bot, dropName);
      const previousEntityIds = new Set(Object.keys(bot.entities ?? {}));
      await bot.dig(live);
      assertActive(signal);
      await collectMatchingDrop(dropName, before, target.position, previousEntityIds, signal);
      completed += 1;
    }
    return completed;
  }

  async function craftOnce(name, table, signal) {
    assertActive(signal);
    const item = bot.registry?.itemsByName?.[name];
    if (!item || !Number.isSafeInteger(item.id) || typeof bot.recipesFor !== 'function' || typeof bot.craft !== 'function') {
      throw coded('SURVIVAL_DEMO_RECIPE_UNAVAILABLE', `${name} recipe ports are unavailable`);
    }
    const recipes = bot.recipesFor(item.id, null, 1, table);
    if (!Array.isArray(recipes) || recipes.length === 0) throw coded('SURVIVAL_DEMO_RECIPE_UNAVAILABLE', `${name} recipe is unavailable`);
    const before = countItem(bot, name);
    await bot.craft(recipes[0], 1, table);
    assertActive(signal);
    if (countItem(bot, name) <= before) throw coded('SURVIVAL_DEMO_CRAFT_NOT_VERIFIED', `${name} inventory did not increase`);
  }

  async function ensurePlanks(count, signal) {
    while (countItem(bot, 'oak_planks') < count) await craftOnce('oak_planks', null, signal);
  }

  function liveTable() {
    if (!point(tablePosition) || typeof bot.blockAt !== 'function') return null;
    const block = bot.blockAt(new Vec3(tablePosition.x, tablePosition.y, tablePosition.z));
    return block?.name === 'crafting_table' ? block : null;
  }

  function placementSite() {
    if (!point(bot.entity?.position) || typeof bot.blockAt !== 'function') return null;
    const origin = bot.entity.position;
    const horizontal = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
    for (const vertical of [-1, -2, 0]) {
      for (const [dx, dz] of horizontal) {
        const target = new Vec3(Math.floor(origin.x) + dx, Math.floor(origin.y) + vertical, Math.floor(origin.z) + dz);
        const support = new Vec3(target.x, target.y - 1, target.z);
        const targetBlock = bot.blockAt(target);
        const supportBlock = bot.blockAt(support);
        if (targetBlock?.name === 'air' && supportBlock && supportBlock.name !== 'air') return { target, support: supportBlock };
      }
    }
    return null;
  }

  async function perform(request, signal) {
    if (request.action === 'gather_wood') {
      return { action: request.action, brokenOakLogs: await digAndCollect('oak_log', 'oak_log', 3, signal) };
    }
    if (request.action === 'craft_and_place_table') {
      await ensurePlanks(4, signal);
      await craftOnce('crafting_table', null, signal);
      const site = placementSite();
      const item = inventoryItem(bot, 'crafting_table');
      if (!site || !item || typeof bot.equip !== 'function' || typeof bot.placeBlock !== 'function') {
        throw coded('SURVIVAL_DEMO_PLACEMENT_UNAVAILABLE', 'crafting table placement is unavailable');
      }
      await bot.equip(item, 'hand');
      assertActive(signal);
      await bot.placeBlock(site.support, new Vec3(0, 1, 0));
      assertActive(signal);
      const placed = bot.blockAt(site.target);
      if (placed?.name !== 'crafting_table') throw coded('SURVIVAL_DEMO_PLACEMENT_NOT_VERIFIED', 'crafting table was not placed');
      tablePosition = { x: site.target.x, y: site.target.y, z: site.target.z };
      return { action: request.action, placedCraftingTable: true };
    }
    if (request.action === 'craft_wooden_pickaxe') {
      const table = liveTable();
      if (!table) throw coded('SURVIVAL_DEMO_CRAFTING_TABLE_INVALID', 'placed crafting table is unavailable');
      await ensurePlanks(5, signal);
      if (countItem(bot, 'stick') < 2) await craftOnce('stick', table, signal);
      await craftOnce('wooden_pickaxe', table, signal);
      const item = inventoryItem(bot, 'wooden_pickaxe');
      if (!item || typeof bot.equip !== 'function') throw coded('SURVIVAL_DEMO_EQUIP_UNAVAILABLE', 'wooden pickaxe cannot be equipped');
      await bot.equip(item, 'hand');
      if (bot.heldItem?.name !== 'wooden_pickaxe') throw coded('SURVIVAL_DEMO_EQUIP_NOT_VERIFIED', 'wooden pickaxe is not equipped');
      return { action: request.action, craftedWoodenPickaxe: true };
    }
    if (request.action === 'mine_stone') {
      if (bot.heldItem?.name !== 'wooden_pickaxe') throw coded('SURVIVAL_DEMO_TOOL_REQUIRED', 'wooden pickaxe must be equipped');
      return { action: request.action, minedStone: await digAndCollect('stone', 'cobblestone', 8, signal) };
    }
    if (request.action === 'craft_furnace') {
      const table = liveTable();
      if (!table || countItem(bot, 'cobblestone') < 8) throw coded('SURVIVAL_DEMO_FURNACE_INPUT_INVALID', 'furnace inputs are unavailable');
      await approach(table.position, 2, signal);
      await waitForGround(signal);
      const verifiedTable = liveTable();
      if (!verifiedTable) throw coded('SURVIVAL_DEMO_CRAFTING_TABLE_INVALID', 'placed crafting table is unavailable');
      await craftOnce('furnace', verifiedTable, signal);
      return { action: request.action, craftedFurnace: true };
    }
    if (request.action === 'find_village') {
      const approachVerifiedBell = async () => {
        const bellId = bot.registry?.blocksByName?.bell?.id;
        const bell = Number.isSafeInteger(bellId) && typeof bot.findBlock === 'function'
          ? bot.findBlock({ matching: bellId, maxDistance: 48 })
          : null;
        if (!bell || bell.name !== 'bell' || !point(bell.position)) {
          throw coded('SURVIVAL_DEMO_VILLAGE_EVIDENCE_CHANGED', 'verified village bell is no longer visible');
        }
        await approach(bell.position, 2, signal);
      };
      let evidence = await villageObserver({ bot, signal });
      if (completeVillage(evidence)) {
        await approachVerifiedBell();
        return { action: request.action, villageFound: true };
      }
      for (const [dx, dz] of EXPLORATION_OFFSETS) {
        await approach({ x: clearingStart.x + dx, y: clearingStart.y, z: clearingStart.z + dz }, 2, signal);
        evidence = await villageObserver({ bot, signal });
        if (completeVillage(evidence)) {
          await approachVerifiedBell();
          return { action: request.action, villageFound: true };
        }
      }
      throw coded('SURVIVAL_DEMO_VILLAGE_NOT_FOUND', 'complete village evidence was not found in the bounded search');
    }
    if (request.action === 'say_final_line') {
      if (request.line !== FINAL_SURVIVAL_DEMO_LINE || typeof bot.chat !== 'function') {
        throw coded('SURVIVAL_DEMO_EXECUTION_INVALID', 'final line is unavailable or not exact');
      }
      bot.chat(FINAL_SURVIVAL_DEMO_LINE);
      return { action: request.action, spoken: true };
    }
    throw coded('SURVIVAL_DEMO_EXECUTION_INVALID', 'survival macro action is not allowed');
  }

  async function execute(request, { signal } = {}) {
    if (!request || typeof request !== 'object' || !ACTIONS.has(request.action)) {
      throw coded('SURVIVAL_DEMO_EXECUTION_INVALID', 'survival macro request is invalid');
    }
    return Object.freeze(await controlled(() => perform(request, signal), signal));
  }

  async function cancel() {
    cancelled = true;
    stopPhysicalWork();
  }

  return Object.freeze({ execute, cancel });
}

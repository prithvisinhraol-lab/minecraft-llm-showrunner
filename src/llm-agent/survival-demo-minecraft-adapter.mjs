import { FINAL_SURVIVAL_DEMO_LINE, SURVIVAL_DEMO_ACTIONS } from './survival-demo-contracts.mjs';

const EXECUTABLE_ACTIONS = new Set(SURVIVAL_DEMO_ACTIONS.filter((action) => action !== 'stop'));
const CHAT_CONFIRMATION_TIMEOUT_MS = 3_000;

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function inventorySnapshot(bot) {
  const result = {};
  const items = bot.inventory?.items?.();
  if (!Array.isArray(items)) throw coded('SURVIVAL_DEMO_OBSERVATION_INVALID', 'inventory is unavailable');
  for (const item of items) {
    if (typeof item?.name !== 'string' || !Number.isSafeInteger(item.count) || item.count < 0) continue;
    result[item.name] = (result[item.name] ?? 0) + item.count;
  }
  return result;
}

function proofMatches(action, proof) {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof) || proof.action !== action) return false;
  if (action === 'gather_wood') return Number.isSafeInteger(proof.brokenOakLogs) && proof.brokenOakLogs >= 3;
  if (action === 'craft_and_place_table') return proof.placedCraftingTable === true;
  if (action === 'craft_wooden_pickaxe') return proof.craftedWoodenPickaxe === true;
  if (action === 'mine_stone') return Number.isSafeInteger(proof.minedStone) && proof.minedStone >= 8;
  if (action === 'craft_furnace') return proof.craftedFurnace === true;
  if (action === 'find_village') return proof.villageFound === true;
  if (action === 'say_final_line') return proof.spoken === true;
  return false;
}

export function createSurvivalDemoMinecraftAdapter({
  bot,
  actorId,
  macroExecutor,
  villageObserver = async () => ({ bell: false, beds: 0, villagers: 0 })
} = {}) {
  if (!bot || typeof bot !== 'object') throw new TypeError('bot must be an object');
  if (typeof actorId !== 'string' || actorId.length === 0) throw new TypeError('actorId must be a nonempty string');
  const executeMacro = typeof macroExecutor === 'function' ? macroExecutor : macroExecutor?.execute?.bind(macroExecutor);
  const cancelMacro = typeof macroExecutor === 'object' && typeof macroExecutor?.cancel === 'function'
    ? macroExecutor.cancel.bind(macroExecutor)
    : async () => {};
  if (typeof executeMacro !== 'function') throw new TypeError('macroExecutor must be a function or executor object');
  if (typeof villageObserver !== 'function') throw new TypeError('villageObserver must be a function');

  let observationVersion = 0;
  let cancelled = false;
  let closed = false;
  let cancelPromise = null;
  const chat = [];
  const runFacts = { brokenOakLogs: 0, minedStone: 0, placedCraftingTable: false };
  const onChat = (username, message) => {
    if (typeof username !== 'string' || typeof message !== 'string') return;
    chat.push({ username, message });
    if (chat.length > 20) chat.splice(0, chat.length - 20);
  };
  bot.on?.('chat', onChat);

  function hasFinalLine() {
    return chat.some((entry) => entry.username === actorId && entry.message === FINAL_SURVIVAL_DEMO_LINE);
  }

  async function waitForFinalLine(signal) {
    if (hasFinalLine()) return;
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        bot.removeListener?.('chat', onConfirmation);
        signal?.removeEventListener?.('abort', onAbort);
        error ? reject(error) : resolve();
      };
      const onConfirmation = (username, message) => {
        if (username === actorId && message === FINAL_SURVIVAL_DEMO_LINE) finish();
      };
      const onAbort = () => finish(coded('SURVIVAL_DEMO_ABORTED', 'survival demo operation was cancelled'));
      const timer = setTimeout(() => finish(coded(
        'SURVIVAL_DEMO_CHAT_NOT_CONFIRMED',
        'server did not echo the final actor line before the deadline'
      )), CHAT_CONFIRMATION_TIMEOUT_MS);
      bot.on?.('chat', onConfirmation);
      signal?.addEventListener?.('abort', onAbort, { once: true });
    });
  }

  async function observe({ signal } = {}) {
    if (signal?.aborted || cancelled) throw coded('SURVIVAL_DEMO_ABORTED', 'survival demo operation was cancelled');
    const village = await villageObserver({ bot, signal });
    if (!village || typeof village !== 'object') throw coded('SURVIVAL_DEMO_OBSERVATION_INVALID', 'village evidence is invalid');
    observationVersion += 1;
    return Object.freeze({
      observationVersion,
      connected: Boolean(bot.player),
      alive: Number.isFinite(bot.health) && bot.health > 0,
      inventory: Object.freeze(inventorySnapshot(bot)),
      equippedHand: typeof bot.heldItem?.name === 'string' ? bot.heldItem.name : null,
      runFacts: Object.freeze({ ...runFacts }),
      villageEvidence: Object.freeze({
        bell: village.bell === true,
        beds: Number.isSafeInteger(village.beds) && village.beds >= 0 ? village.beds : 0,
        villagers: Number.isSafeInteger(village.villagers) && village.villagers >= 0 ? village.villagers : 0
      }),
      observedChat: Object.freeze(chat.map((entry) => Object.freeze({ ...entry })))
    });
  }

  async function execute(request, { signal } = {}) {
    if (signal?.aborted || cancelled) throw coded('SURVIVAL_DEMO_ABORTED', 'survival demo operation was cancelled');
    if (!request || typeof request !== 'object' || !EXECUTABLE_ACTIONS.has(request.action)) {
      throw coded('SURVIVAL_DEMO_EXECUTION_INVALID', 'survival demo action is invalid');
    }
    if (request.observationVersion !== observationVersion) {
      throw coded('SURVIVAL_DEMO_OBSERVATION_STALE', 'survival demo request uses a stale observation');
    }
    if (request.action === 'say_final_line' && request.line !== FINAL_SURVIVAL_DEMO_LINE) {
      throw coded('SURVIVAL_DEMO_EXECUTION_INVALID', 'final line is not exact');
    }
    const proof = await executeMacro({
      action: request.action,
      ...(request.action === 'say_final_line' ? { line: FINAL_SURVIVAL_DEMO_LINE } : {})
    }, { bot, signal });
    if (!proofMatches(request.action, proof)) {
      throw coded('SURVIVAL_DEMO_EXECUTION_PROOF_INVALID', 'macro executor did not return matching proof');
    }
    if (request.action === 'say_final_line') await waitForFinalLine(signal);
    if (request.action === 'gather_wood') runFacts.brokenOakLogs += proof.brokenOakLogs;
    if (request.action === 'craft_and_place_table') runFacts.placedCraftingTable = true;
    if (request.action === 'mine_stone') runFacts.minedStone += proof.minedStone;
    return Object.freeze(structuredClone(proof));
  }

  function cancel() {
    if (!cancelPromise) {
      cancelled = true;
      cancelPromise = (async () => {
        try { await cancelMacro(); }
        finally { bot.pathfinder?.stop?.(); }
      })();
    }
    return cancelPromise;
  }

  async function close() {
    if (closed) return;
    closed = true;
    bot.removeListener?.('chat', onChat);
  }

  return Object.freeze({ observe, execute, cancel, close });
}

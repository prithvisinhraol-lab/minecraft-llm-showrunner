import { Vec3 } from 'vec3';
import { canonicalDimension } from './survival-contracts.mjs';

const PASSABLE = new Set(['air', 'cave_air', 'void_air', 'water', 'tall_grass', 'short_grass', 'fern', 'large_fern']);

function distance(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function inventory(bot) {
  const result = {};
  for (const item of bot.inventory?.items?.() ?? []) {
    if (typeof item?.name === 'string' && Number.isSafeInteger(item.count)) result[item.name] = (result[item.name] ?? 0) + item.count;
  }
  return result;
}

function droppedItem(bot, entity) {
  const item = typeof entity?.getDroppedItem === 'function' ? entity.getDroppedItem() : entity?.item;
  const name = item?.name ?? bot.registry?.items?.[item?.type ?? item?.itemId]?.name;
  if (!name || !entity?.position || !Number.isSafeInteger(entity.id)) return null;
  return {
    id: `item:${entity.id}`, dropId: `item:${entity.id}`, entityId: entity.id, item: name,
    count: Number.isSafeInteger(item?.count) ? item.count : 1,
    position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
    dimension: canonicalDimension(bot.game?.dimension)
  };
}

export function createLiveMeadowObserver({ episode, bots }) {
  if (!episode?.regions || !episode?.marks || !bots) throw new TypeError('Live meadow observer dependencies are required');
  const versions = new Map();

  function scanTargets(bot) {
    const targets = [];
    for (const [regionId, region] of Object.entries(episode.regions)) {
      for (let x = region.min.x; x <= region.max.x; x += 1) for (let y = region.min.y; y <= region.max.y; y += 1) {
        for (let z = region.min.z; z <= region.max.z; z += 1) {
          const value = bot.blockAt?.(new Vec3(x, y, z));
          if (!value || !region.allowedBlocks.includes(value.name)) continue;
          targets.push({
            id: `block:${x}:${y}:${z}`, region: regionId, block: value.name, x, y, z,
            dimension: canonicalDimension(bot.game?.dimension),
            pathCost: distance(bot.entity.position, { x, y, z }), distance: distance(bot.entity.position, { x, y, z })
          });
        }
      }
    }
    return targets;
  }

  function markState(bot) {
    const placedAtMarks = {};
    let atMark = null;
    for (const [id, mark] of Object.entries(episode.marks)) {
      const value = bot.blockAt?.(new Vec3(mark.position.x, mark.position.y, mark.position.z));
      if (value && !PASSABLE.has(value.name)) placedAtMarks[id] = value.name;
      if (distance(bot.entity.position, mark.position) <= (mark.radius ?? 1)) atMark = id;
    }
    return { placedAtMarks, atMark };
  }

  async function observe({ actorId, goalId, observationVersion = 0, action, command }) {
    const bot = bots[actorId];
    if (!bot?.entity?.position) throw Object.assign(new Error('LIVE_ACTOR_NOT_READY'), { code: 'LIVE_ACTOR_NOT_READY' });
    const previous = Math.max(versions.get(actorId) ?? 0, observationVersion);
    const version = previous + 1;
    versions.set(actorId, version);
    const marks = markState(bot);
    const receiptTarget = command?.payload?.receipt?.payload?.target;
    const targetId = command?.payload?.targetId;
    const blocks = {};
    const passableTargets = [];
    if (receiptTarget && targetId) {
      const current = bot.blockAt(new Vec3(receiptTarget.x, receiptTarget.y, receiptTarget.z));
      blocks[targetId] = current?.name ?? 'air';
      if (!current || PASSABLE.has(current.name) || current.boundingBox === 'empty') passableTargets.push(targetId);
    }
    const drops = Object.values(bot.entities ?? {}).map((entity) => droppedItem(bot, entity)).filter(Boolean);
    const actors = Object.fromEntries(Object.entries(bots).filter(([, actorBot]) => actorBot?.entity?.position).map(([id, actorBot]) => {
      const held = actorBot.heldItem?.name;
      return [id, {
        inventory: inventory(actorBot),
        atMark: markState(actorBot).atMark,
        equipped: held ? { hand: held } : {}
      }];
    }));
    const hand = bot.heldItem?.name;
    const offHand = bot.inventory?.slots?.[45]?.name;
    const result = {
      authoritative: true, actor: actorId, goalId, observationVersion: version,
      dimension: canonicalDimension(bot.game?.dimension),
      position: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
      inventory: inventory(bot),
      equipment: { ...(hand ? { hand } : {}), ...(offHand ? { 'off-hand': offHand } : {}) },
      actors,
      targets: scanTargets(bot), drops, blocks, passableTargets, placedAtMarks: marks.placedAtMarks,
      nearMark: marks.atMark,
      ...(targetId && receiptTarget && distance(bot.entity.position, receiptTarget) <= 2.5 ? { nearTargetId: targetId } : {}),
      ...(action === 'lookAtTarget' && targetId ? { lookedAtTargetId: targetId } : {})
    };
    return Object.freeze(structuredClone(result));
  }

  return Object.freeze({ observe });
}

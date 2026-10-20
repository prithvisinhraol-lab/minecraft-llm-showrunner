function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function point(value) {
  return value && [value.x, value.y, value.z].every(Number.isFinite);
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function uniquePositions(positions) {
  const unique = new Map();
  for (const position of Array.isArray(positions) ? positions : []) {
    if (!point(position)) continue;
    unique.set(`${position.x},${position.y},${position.z}`, position);
  }
  return [...unique.values()];
}

export function createSurvivalDemoVillageObserver({ maximumDistance = 48 } = {}) {
  if (!Number.isSafeInteger(maximumDistance) || maximumDistance < 1 || maximumDistance > 48) {
    throw new TypeError('maximumDistance must be an integer between 1 and 48');
  }

  return async function observeVillage({ bot, signal } = {}) {
    if (signal?.aborted) throw coded('SURVIVAL_DEMO_ABORTED', 'village observation was aborted');
    if (!bot || typeof bot !== 'object' || !point(bot.entity?.position)
      || typeof bot.findBlocks !== 'function' || !bot.registry?.blocksByName) {
      throw coded('SURVIVAL_DEMO_OBSERVATION_INVALID', 'live village observation ports are unavailable');
    }
    const bellId = bot.registry.blocksByName.bell?.id;
    const bedIds = Object.values(bot.registry.blocksByName)
      .filter((block) => typeof block?.name === 'string' && block.name.endsWith('_bed') && Number.isSafeInteger(block.id))
      .map((block) => block.id);
    if (!Number.isSafeInteger(bellId) || bedIds.length === 0) {
      throw coded('SURVIVAL_DEMO_OBSERVATION_INVALID', 'bell or bed registry entries are unavailable');
    }

    const bells = uniquePositions(bot.findBlocks({ matching: bellId, maxDistance: maximumDistance, count: 16 }));
    const beds = uniquePositions(bot.findBlocks({ matching: bedIds, maxDistance: maximumDistance, count: 64 }));
    if (signal?.aborted) throw coded('SURVIVAL_DEMO_ABORTED', 'village observation was aborted');
    const origin = bot.entity.position;
    const villagers = Object.values(bot.entities ?? {}).filter((entity) =>
      entity?.name === 'villager' && entity.isValid !== false && point(entity.position)
      && distance(origin, entity.position) <= maximumDistance
    ).length;

    return Object.freeze({ bell: bells.length > 0, beds: beds.length, villagers });
  };
}

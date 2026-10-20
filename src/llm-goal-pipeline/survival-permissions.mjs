const HOSTILES = Object.freeze([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'drowned', 'husk',
  'stray', 'witch', 'pillager', 'vindicator', 'evoker', 'ravager', 'slime', 'magma_cube'
]);

function fail(message) {
  const error = new Error(message);
  error.code = 'PIPELINE_PERMISSION_INVALID';
  throw error;
}

function integerPoint(value, label) {
  if (!value || !['x', 'y', 'z'].every((axis) => Number.isSafeInteger(value[axis]))) fail(`${label} is invalid`);
  return { x: value.x, y: value.y, z: value.z };
}

function inside(point, region) {
  return ['x', 'y', 'z'].every((axis) => point[axis] >= region.min[axis] && point[axis] <= region.max[axis]);
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function createDefaultSurvivalPermissions({ origin, protectedRegions = [] } = {}) {
  const normalizedOrigin = integerPoint(origin, 'origin');
  if (!Array.isArray(protectedRegions) || protectedRegions.length > 16) fail('protectedRegions are invalid');
  const seen = new Set();
  const regions = protectedRegions.map((region) => {
    if (!region || typeof region !== 'object' || Object.keys(region).sort().join(',') !== 'id,max,min'
      || typeof region.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(region.id) || seen.has(region.id)) fail('protected region is invalid');
    seen.add(region.id);
    const min = integerPoint(region.min, 'protected region min');
    const max = integerPoint(region.max, 'protected region max');
    if (['x', 'y', 'z'].some((axis) => min[axis] > max[axis])) fail('protected region bounds are invalid');
    return { id: region.id, min, max };
  });
  if (regions.some((region) => inside(normalizedOrigin, region))) fail('origin cannot be inside a protected region');
  return freeze({
    origin: normalizedOrigin,
    maximumTravelRadius: 128,
    maximumSearchRadius: 64,
    mineableBlocks: ['oak_log', 'stone', 'cobblestone'],
    placeableBlocks: ['crafting_table'],
    recipes: ['oak_planks', 'stick', 'crafting_table', 'wooden_pickaxe', 'stone_pickaxe'],
    consumableItems: ['apple', 'bread', 'cooked_beef', 'cooked_porkchop'],
    attackableEntities: [...HOSTILES],
    protectedRegions: regions
  });
}

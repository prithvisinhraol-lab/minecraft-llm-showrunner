const DIMENSION_ALIASES = Object.freeze({
  overworld: 'minecraft:overworld',
  the_nether: 'minecraft:the_nether',
  the_end: 'minecraft:the_end',
  'minecraft:overworld': 'minecraft:overworld',
  'minecraft:the_nether': 'minecraft:the_nether',
  'minecraft:the_end': 'minecraft:the_end'
});

export const EQUIPMENT_DESTINATIONS = Object.freeze([
  'hand', 'off-hand', 'head', 'torso', 'legs', 'feet'
]);

const EQUIPMENT_DESTINATION_SET = new Set(EQUIPMENT_DESTINATIONS);

export const SURVIVAL_RECIPES = Object.freeze({
  oak_planks: Object.freeze({
    inputs: Object.freeze([Object.freeze({ item: 'oak_log', count: 1 })]),
    output: Object.freeze({ item: 'oak_planks', count: 4 }),
    requiresTable: false
  }),
  stick: Object.freeze({
    inputs: Object.freeze([Object.freeze({ item: 'oak_planks', count: 2 })]),
    output: Object.freeze({ item: 'stick', count: 4 }),
    requiresTable: false
  }),
  crafting_table: Object.freeze({
    inputs: Object.freeze([Object.freeze({ item: 'oak_planks', count: 4 })]),
    output: Object.freeze({ item: 'crafting_table', count: 1 }),
    requiresTable: false
  }),
  wooden_pickaxe: Object.freeze({
    inputs: Object.freeze([
      Object.freeze({ item: 'oak_planks', count: 3 }),
      Object.freeze({ item: 'stick', count: 2 })
    ]),
    output: Object.freeze({ item: 'wooden_pickaxe', count: 1 }),
    requiresTable: true
  })
});

export function canonicalDimension(value) {
  return typeof value === 'string' ? DIMENSION_ALIASES[value] : undefined;
}

export function isEquipmentDestination(value) {
  return EQUIPMENT_DESTINATION_SET.has(value);
}

export function recipeSpecification(name) {
  return typeof name === 'string' ? SURVIVAL_RECIPES[name] : undefined;
}

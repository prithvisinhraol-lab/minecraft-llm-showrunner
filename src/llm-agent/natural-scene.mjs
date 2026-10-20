export const LLM_SCENE_BOUNDS = Object.freeze({
  min: Object.freeze({ x: 40, y: 62, z: 40 }),
  max: Object.freeze({ x: 92, y: 79, z: 58 })
});

export const LLM_SCENE_LANDING = Object.freeze({ x: 52.5, y: 66, z: 48.5 });

function addTree(commands, { x, groundY, z }) {
  for (let y = groundY + 1; y <= groundY + 4; y += 1) {
    commands.push(`setblock ${x} ${y} ${z} minecraft:oak_log`);
  }
  commands.push(
    `fill ${x - 2} ${groundY + 3} ${z - 1} ${x + 2} ${groundY + 4} ${z + 1} minecraft:oak_leaves[persistent=true] replace minecraft:air`,
    `fill ${x - 1} ${groundY + 3} ${z - 2} ${x + 1} ${groundY + 4} ${z + 2} minecraft:oak_leaves[persistent=true] replace minecraft:air`,
    `fill ${x - 1} ${groundY + 5} ${z - 1} ${x + 1} ${groundY + 5} ${z + 1} minecraft:oak_leaves[persistent=true] replace minecraft:air`,
    `setblock ${x + 2} ${groundY + 4} ${z + 2} minecraft:oak_leaves[persistent=true]`,
    `setblock ${x - 2} ${groundY + 3} ${z - 2} minecraft:oak_leaves[persistent=true]`
  );
}

export function createNaturalLlmSceneCommands() {
  const commands = [
    'kill @e[tag=llm_natural_scene]',
    'fill 40 62 40 92 79 58 minecraft:air',
    'fill 40 62 40 92 63 58 minecraft:dirt',
    'fill 40 64 40 92 64 58 minecraft:grass_block',
    'fill 40 64 40 45 64 46 minecraft:dirt',
    'fill 40 65 40 45 65 46 minecraft:grass_block',
    'fill 61 64 40 67 64 44 minecraft:dirt',
    'fill 61 65 40 67 65 44 minecraft:grass_block',
    'fill 41 64 54 47 64 58 minecraft:dirt',
    'fill 41 65 54 47 65 58 minecraft:grass_block',
    'setblock 46 64 47 minecraft:coarse_dirt',
    'setblock 47 64 47 minecraft:coarse_dirt',
    'setblock 48 64 46 minecraft:podzol',
    'setblock 59 64 49 minecraft:podzol',
    'setblock 60 64 49 minecraft:coarse_dirt',
    'setblock 43 65 52 minecraft:moss_block',
    'setblock 44 64 52 minecraft:moss_block',
    'setblock 54 64 52 minecraft:mossy_cobblestone',
    'setblock 55 64 52 minecraft:mossy_cobblestone',
    'setblock 55 65 53 minecraft:cobblestone',
    'setblock 54 65 53 minecraft:stone',
    'setblock 56 65 53 minecraft:stone',
    'setblock 57 65 53 minecraft:stone',
    'setblock 54 65 54 minecraft:stone',
    'setblock 55 65 54 minecraft:stone',
    'setblock 56 65 54 minecraft:stone',
    'setblock 57 65 54 minecraft:stone',
    'setblock 58 65 54 minecraft:stone',
    'setblock 54 65 52 minecraft:gold_block',
    'setblock 54 66 52 minecraft:air',
    'setblock 52 65 48 minecraft:grass_block',
    'setblock 52 66 48 minecraft:air',
    'setblock 52 67 48 minecraft:air'
  ];

  commands.push(
    'fill 66 64 48 82 64 50 minecraft:dirt_path',
    'fill 84 65 42 90 68 47 minecraft:oak_planks hollow',
    'fill 86 65 47 87 66 47 minecraft:air',
    'setblock 85 65 43 minecraft:red_bed[part=foot,facing=south]',
    'setblock 85 65 44 minecraft:red_bed[part=head,facing=south]',
    'fill 84 65 51 90 68 56 minecraft:cobblestone hollow',
    'fill 86 65 51 87 66 51 minecraft:air',
    'setblock 89 65 54 minecraft:red_bed[part=foot,facing=north]',
    'setblock 89 65 53 minecraft:red_bed[part=head,facing=north]',
    'setblock 82 65 49 minecraft:bell[attachment=floor,facing=east]',
    'summon minecraft:villager 87.5 65 49.5 {Tags:["llm_natural_scene"],PersistenceRequired:1b}'
  );

  addTree(commands, { x: 44, groundY: 65, z: 43 });
  addTree(commands, { x: 62, groundY: 65, z: 42 });

  for (const [x, y, z, block] of [
    [47, 65, 43, 'short_grass'], [49, 65, 42, 'poppy'], [51, 65, 44, 'dandelion'],
    [53, 65, 43, 'cornflower'], [56, 65, 45, 'oxeye_daisy'], [58, 65, 46, 'short_grass'],
    [42, 66, 50, 'allium'], [46, 65, 51, 'azure_bluet'], [49, 65, 54, 'tall_grass'],
    [52, 65, 55, 'short_grass'], [57, 65, 55, 'poppy'], [61, 65, 54, 'cornflower'],
    [64, 65, 50, 'dandelion'], [65, 65, 56, 'oxeye_daisy'], [43, 66, 56, 'short_grass']
  ]) commands.push(`setblock ${x} ${y} ${z} minecraft:${block}`);

  commands.push(
    'summon minecraft:cow 48.5 65 56.5 {Tags:["llm_natural_scene"],PersistenceRequired:1b}',
    'summon minecraft:sheep 59.5 65 56.5 {Tags:["llm_natural_scene"],PersistenceRequired:1b}',
    'summon minecraft:chicken 42.5 66 50.5 {Tags:["llm_natural_scene"],PersistenceRequired:1b}',
    'time set 6000',
    'weather clear'
  );

  return Object.freeze(commands);
}

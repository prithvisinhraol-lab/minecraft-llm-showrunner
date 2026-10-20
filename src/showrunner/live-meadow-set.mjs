export function createLiveMeadowSetCommands() {
  const commands = [
    'kill @e[tag=showrunner_meadow]',
    'fill 40 65 40 67 79 58 minecraft:air',
    'fill 40 62 40 67 63 58 minecraft:dirt',
    'fill 40 64 40 67 64 58 minecraft:grass_block',
    'setblock 52 64 50 minecraft:stone'
  ];
  for (const [x, z] of [[43, 43], [57, 43]]) {
    for (let y = 65; y <= 68; y += 1) commands.push(`setblock ${x} ${y} ${z} minecraft:oak_log`);
    commands.push(`fill ${x - 2} 68 ${z - 2} ${x + 2} 69 ${z + 2} minecraft:oak_leaves[persistent=true] replace minecraft:air`);
    commands.push(`fill ${x - 1} 70 ${z - 1} ${x + 1} 70 ${z + 1} minecraft:oak_leaves[persistent=true] replace minecraft:air`);
  }
  for (const [x, z, flower] of [
    [47, 44, 'poppy'], [49, 43, 'dandelion'], [51, 45, 'cornflower'], [53, 44, 'oxeye_daisy'],
    [46, 53, 'azure_bluet'], [50, 55, 'poppy'], [55, 53, 'dandelion'], [59, 55, 'cornflower']
  ]) commands.push(`setblock ${x} 65 ${z} minecraft:${flower}`);
  for (let z = 54; z <= 58; z += 1) {
    commands.push(`setblock 66 64 ${z} minecraft:stone`);
    commands.push(`setblock 67 64 ${z} minecraft:stone`);
  }
  commands.push('setblock 66 65 58 minecraft:stone');
  commands.push(
    'summon minecraft:cow 49.5 65 54.5 {Tags:["showrunner_meadow"],PersistenceRequired:1b}',
    'summon minecraft:sheep 53.5 65 54.5 {Tags:["showrunner_meadow"],PersistenceRequired:1b}',
    'summon minecraft:pig 57.5 65 53.5 {Tags:["showrunner_meadow"],PersistenceRequired:1b}',
    'summon minecraft:chicken 45.5 65 55.5 {Tags:["showrunner_meadow"],PersistenceRequired:1b}',
    'time set 6000',
    'weather clear',
    'gamerule doDaylightCycle false',
    'gamerule doWeatherCycle false',
    'clear HeroActor',
    'clear RivalActor',
    'effect clear HeroActor',
    'effect clear RivalActor',
    'effect give HeroActor minecraft:instant_health 1 10 true',
    'effect give RivalActor minecraft:instant_health 1 10 true',
    'effect give HeroActor minecraft:saturation 1 10 true',
    'effect give RivalActor minecraft:saturation 1 10 true',
    'gamemode survival HeroActor',
    'gamemode survival RivalActor',
    'tp HeroActor 48.5 65 48.5 0 0',
    'tp RivalActor 56.5 65 48.5 0 0',
    'spawnpoint HeroActor 48 65 48 0',
    'spawnpoint RivalActor 56 65 48 0'
  );
  return Object.freeze(commands);
}

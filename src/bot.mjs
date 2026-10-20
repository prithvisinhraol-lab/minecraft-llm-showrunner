import mineflayer from 'mineflayer';
import pathfinderPackage from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { parseBotMessages } from './command-parser.mjs';
import { loadEnvFile } from './load-env.mjs';
import {
  isMaceBoostActive,
  shouldMaceAttackDuringBoost,
  shouldRaiseShieldForSparring,
  shouldUseWindCharge
} from './mace-combat.mjs';
import { getForcedRodStrikeMode, getRodStrikeModeFromItem, isFishingBobberEntity, planBedrockTntBeam, planGroundTntRing, shouldDropRodStrike } from './rod-strike.mjs';
import { planTntMinecartLane, shouldFireTntMinecartChain } from './tnt-minecart-combat.mjs';

await loadEnvFile();

const { pathfinder, Movements, goals } = pathfinderPackage;

const config = {
  host: process.env.MC_HOST || '127.0.0.1',
  port: Number(process.env.MC_PORT || 25565),
  username: process.env.MC_USERNAME || 'CodexBot',
  auth: process.env.MC_AUTH || 'offline',
  version: process.env.MC_VERSION || false
};

console.log('Starting Mineflayer bot with config:', {
  host: config.host,
  port: config.port,
  username: config.username,
  auth: config.auth,
  version: config.version || 'auto'
});

const bot = mineflayer.createBot(config);
console.log('Mineflayer bot created; waiting for login/spawn.');
bot.loadPlugin(pathfinder);

let shieldInterval = null;
let combatInterval = null;
let combatTargetUsername = null;
let lastAttackAt = 0;
let lastWindChargeAt = 0;
let tntMinecartInterval = null;
let tntMinecartTargetUsername = null;
let lastTntMinecartFiredAt = 0;
let tntMinecartChainRunning = false;
let rodStrikeInterval = null;
let rodStrikeTargetUsername = null;
let rodStrikeForcedMode = null;
let lastRodStrikeDropAt = 0;
let lastRodStrikeBobberKey = null;
let orbitalTarget = null;

const TNT_MINECART_CHAIN_COOLDOWN_MS = 6500;
const ROD_STRIKE_COOLDOWN_MS = 2500;

function setMaceBoostControls(active) {
  bot.setControlState('sprint', active);
  bot.setControlState('forward', active);
  bot.setControlState('jump', active);
}

function nearestPlayer() {
  return bot.nearestEntity((entity) => entity.type === 'player' && entity.username !== bot.username);
}

function say(message, chat = true) {
  if (chat) bot.chat(message);
  console.log(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCommand(command, delayMs = 250) {
  bot.chat(`/${command}`);
  await sleep(delayMs);
}

function blockPosition(position) {
  return {
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z)
  };
}

function formatPosition(position) {
  return `${position.x} ${position.y} ${position.z}`;
}

function findInventoryItem(name) {
  return bot.inventory.items().find((item) => item.name === name);
}

function countInventoryItems(name) {
  return bot.inventory.items()
    .filter((item) => item.name === name)
    .reduce((total, item) => total + item.count, 0);
}

function getOffHandItem() {
  return bot.inventory.slots[45] || null;
}

async function equipWindCharge() {
  const offHandItem = getOffHandItem();
  if (offHandItem?.name === 'wind_charge') return true;

  const windCharge = findInventoryItem('wind_charge');
  if (!windCharge) return false;

  await bot.equip(windCharge, 'off-hand');
  return true;
}

async function tryWindChargeMace(target, distance, now) {
  if (!shouldUseWindCharge({
    distance,
    now,
    lastWindChargeAt,
    mainHandName: bot.heldItem?.name || null,
    offHandName: getOffHandItem()?.name || null,
    inventoryWindCharges: countInventoryItems('wind_charge')
  })) {
    return false;
  }

  if (!(await equipWindCharge())) return false;

  lastWindChargeAt = now;
  bot.pathfinder.stop();
  setMaceBoostControls(false);
  await bot.lookAt(bot.entity.position.offset(0, -1.2, 0), true);
  bot.activateItem(true);
  await sleep(150);
  bot.deactivateItem();

  await bot.lookAt(target.position.offset(0, 1.4, 0), true);
  setMaceBoostControls(true);
  return true;
}

async function equipShield(chat = true) {
  const offHandItem = getOffHandItem();
  if (offHandItem?.name === 'shield') {
    return true;
  }

  const shield = findInventoryItem('shield');
  if (!shield) {
    say('I need a shield first. In chat, run: /give CodexBot minecraft:shield 1', chat);
    return false;
  }

  await bot.equip(shield, 'off-hand');
  return true;
}

async function raiseShield(chat = true) {
  if (!(await equipShield(chat))) return;

  bot.activateItem(true);
  say('Shield up.', chat);
}

async function keepShieldUp() {
  await raiseShield();

  if (shieldInterval) clearInterval(shieldInterval);
  shieldInterval = setInterval(() => {
    raiseShield(false).catch((error) => {
      console.error('Could not keep shield up:', error);
    });
  }, 1500);
}

async function lowerShield() {
  if (shieldInterval) {
    clearInterval(shieldInterval);
    shieldInterval = null;
  }

  bot.deactivateItem();
  say('Shield down.');
}

function stopCombat() {
  if (combatInterval) {
    clearInterval(combatInterval);
    combatInterval = null;
  }

  combatTargetUsername = null;
  setMaceBoostControls(false);
  bot.pathfinder.stop();
}

function stopTntMinecartChain(chat = true) {
  if (tntMinecartInterval) {
    clearInterval(tntMinecartInterval);
    tntMinecartInterval = null;
  }

  tntMinecartTargetUsername = null;
  lastTntMinecartFiredAt = 0;
  tntMinecartChainRunning = false;
  if (chat) say('TNT minecart chain stopped.');
}

function stopRodStrike(chat = true) {
  if (rodStrikeInterval) {
    clearInterval(rodStrikeInterval);
    rodStrikeInterval = null;
  }

  rodStrikeTargetUsername = null;
  rodStrikeForcedMode = null;
  lastRodStrikeDropAt = 0;
  lastRodStrikeBobberKey = null;
  if (chat) say('Fishing-rod sky TNT stopped.');
}

async function startSparring(username) {
  const player = bot.players[username]?.entity;
  if (!player) {
    say(`I cannot see ${username} right now.`);
    return;
  }

  combatTargetUsername = username;
  lastAttackAt = 0;
  lastWindChargeAt = 0;
  if (shouldRaiseShieldForSparring(bot.heldItem?.name || null)) {
    await keepShieldUp();
  }
  bot.pathfinder.setGoal(new goals.GoalFollow(player, 2), true);
  say(`Sparring with ${username}.`);

  if (combatInterval) clearInterval(combatInterval);
  combatInterval = setInterval(async () => {
    const target = bot.players[combatTargetUsername]?.entity;
    if (!target) return;

    const distance = bot.entity.position.distanceTo(target.position);
    const now = Date.now();
    const boostActive = isMaceBoostActive({ now, lastWindChargeAt });

    if (boostActive) {
      bot.pathfinder.stop();
      setMaceBoostControls(true);
    } else {
      setMaceBoostControls(false);
      bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
    }

    await bot.lookAt(target.position.offset(0, 1.4, 0), true);

    if (shouldMaceAttackDuringBoost({ distance, now, lastWindChargeAt, lastAttackAt })) {
      lastAttackAt = now;
      bot.attack(target);
      return;
    }

    if (!boostActive && await tryWindChargeMace(target, distance, now)) {
      return;
    }

    if (distance <= 3.2 && now - lastAttackAt > 900) {
      lastAttackAt = now;
      bot.attack(target);
    }
  }, 250);
}

async function buildOrbitalCannon(origin) {
  const base = blockPosition(origin);
  const y = base.y - 1;

  const commands = [
    `fill ${base.x - 3} ${y} ${base.z - 3} ${base.x + 3} ${y} ${base.z + 3} minecraft:obsidian`,
    `fill ${base.x - 2} ${y + 1} ${base.z - 2} ${base.x + 2} ${y + 1} ${base.z + 2} minecraft:air`,
    `setblock ${base.x} ${y + 1} ${base.z} minecraft:beacon`,
    `setblock ${base.x} ${y + 2} ${base.z} minecraft:lightning_rod`,
    `setblock ${base.x + 2} ${y + 1} ${base.z + 2} minecraft:command_block`,
    `setblock ${base.x - 2} ${y + 1} ${base.z + 2} minecraft:sea_lantern`,
    `setblock ${base.x + 2} ${y + 1} ${base.z - 2} minecraft:sea_lantern`,
    `setblock ${base.x - 2} ${y + 1} ${base.z - 2} minecraft:sea_lantern`,
    `setblock ${base.x - 3} ${y + 1} ${base.z} minecraft:end_rod`,
    `setblock ${base.x + 3} ${y + 1} ${base.z} minecraft:end_rod`,
    `setblock ${base.x} ${y + 1} ${base.z - 3} minecraft:end_rod`,
    `setblock ${base.x} ${y + 1} ${base.z + 3} minecraft:end_rod`,
    `particle minecraft:end_rod ${base.x} ${y + 2} ${base.z} 2 2 2 0.03 80 force`,
    `playsound minecraft:block.beacon.activate master @a ${base.x} ${base.y} ${base.z} 1 1`
  ];

  for (const command of commands) {
    await runCommand(command);
  }

  orbitalTarget = { x: base.x, y: base.y, z: base.z };
  say(`Orbital cannon built. Target set to ${formatPosition(orbitalTarget)}. Use: bot cannon target, then bot cannon fire.`);
}

async function setOrbitalTargetFromPlayer(username) {
  const player = bot.players[username]?.entity;
  if (!player) {
    say(`I cannot see ${username} right now.`);
    return;
  }

  orbitalTarget = blockPosition(player.position);
  await runCommand(`particle minecraft:happy_villager ${orbitalTarget.x} ${orbitalTarget.y + 1} ${orbitalTarget.z} 0.6 0.8 0.6 0.05 30 force`);
  say(`Orbital target locked at ${formatPosition(orbitalTarget)}.`);
}

async function fireOrbitalStrike(mode = 'live') {
  if (!orbitalTarget) {
    say('No orbital target set. Use: bot cannon target');
    return;
  }

  const { x, y, z } = orbitalTarget;
  const commands = [
    `playsound minecraft:entity.warden.sonic_boom master @a ${x} ${y} ${z} 1 0.7`,
    `particle minecraft:end_rod ${x} ${y + 18} ${z} 1.4 8 1.4 0.08 220 force`,
    `summon minecraft:lightning_bolt ${x} ${y} ${z}`,
    `summon minecraft:lightning_bolt ${x + 1} ${y} ${z}`,
    `summon minecraft:lightning_bolt ${x - 1} ${y} ${z}`,
    `particle minecraft:explosion_emitter ${x} ${y + 1} ${z} 0 0 0 1 1 force`,
    `playsound minecraft:entity.generic.explode master @a ${x} ${y} ${z} 1 0.8`
  ];

  if (mode !== 'safe') {
    commands.push(
      `summon minecraft:tnt ${x} ${y + 8} ${z} {Fuse:35}`,
      `summon minecraft:tnt ${x + 2} ${y + 9} ${z} {Fuse:45}`,
      `summon minecraft:tnt ${x - 2} ${y + 9} ${z} {Fuse:45}`
    );
  }

  for (const command of commands) {
    await runCommand(command, 180);
  }

  say(mode === 'safe' ? 'Visual orbital strike fired.' : 'Orbital strike fired.');
}

async function gearTntMinecartArcher() {
  await runCommand(`give ${bot.username} minecraft:tnt_minecart 8`, 150);
  await runCommand(`give ${bot.username} minecraft:rail 32`, 150);
  await runCommand(`give ${bot.username} minecraft:powered_rail 16`, 150);
  await runCommand(`give ${bot.username} minecraft:arrow 64`, 150);
  await runCommand(`give ${bot.username} minecraft:bow 1`, 150);
  await runCommand(`item replace entity ${bot.username} weapon.mainhand with minecraft:bow`, 150);
  await runCommand(`item replace entity ${bot.username} weapon.offhand with minecraft:tnt_minecart 8`, 150);
  await runCommand(`enchant ${bot.username} minecraft:flame 1`, 150);
  await runCommand(`enchant ${bot.username} minecraft:power 3`, 150);
}

async function fireTntMinecartTrap(username) {
  const player = bot.players[username]?.entity;
  if (!player) {
    say(`I cannot see ${username} right now.`);
    return;
  }

  stopCombat();
  await lowerShield();
  await gearTntMinecartArcher();

  const lane = planTntMinecartLane(bot.entity.position, player.position);
  const railCoordinates = [];
  if (lane.railShape === 'east_west') {
    const step = lane.end.x >= lane.start.x ? 1 : -1;
    for (let x = lane.start.x; step > 0 ? x <= lane.end.x : x >= lane.end.x; x += step) {
      railCoordinates.push({ x, y: lane.start.y, z: lane.start.z });
    }
  } else {
    const step = lane.end.z >= lane.start.z ? 1 : -1;
    for (let z = lane.start.z; step > 0 ? z <= lane.end.z : z >= lane.end.z; z += step) {
      railCoordinates.push({ x: lane.start.x, y: lane.start.y, z });
    }
  }

  await runCommand(`fill ${formatPosition(lane.supportStart)} ${formatPosition(lane.supportEnd)} minecraft:stone replace air`, 150);
  for (const [index, position] of railCoordinates.entries()) {
    const railType = index === 0 ? 'powered_rail' : 'rail';
    const powered = index === 0 ? ',powered=true' : '';
    await runCommand(`setblock ${formatPosition(position)} minecraft:${railType}[shape=${lane.railShape}${powered}]`, 80);
  }

  const motion = lane.motion.map((value) => `${value.toFixed(2)}d`).join(',');
  await runCommand(`summon minecraft:tnt_minecart ${lane.start.x} ${lane.start.y + 0.2} ${lane.start.z} {Motion:[${motion}]}`, 150);
  await runCommand(`playsound minecraft:entity.tnt.primed master @a ${formatPosition(lane.start)} 1 1`, 100);

  await bot.lookAt(new Vec3(lane.shotTarget.x, lane.shotTarget.y, lane.shotTarget.z), true);
  bot.activateItem();
  await sleep(900);
  bot.deactivateItem();
  say('TNT minecart trap fired with Flame bow.');
}

async function runTntMinecartChainTick() {
  if (tntMinecartChainRunning) return;
  if (!tntMinecartTargetUsername) return;

  const now = Date.now();
  if (!shouldFireTntMinecartChain({
    now,
    lastFiredAt: lastTntMinecartFiredAt,
    cooldownMs: TNT_MINECART_CHAIN_COOLDOWN_MS
  })) {
    return;
  }

  tntMinecartChainRunning = true;
  lastTntMinecartFiredAt = now;
  try {
    await fireTntMinecartTrap(tntMinecartTargetUsername);
  } catch (error) {
    console.error('TNT minecart chain failed:', error);
  } finally {
    tntMinecartChainRunning = false;
  }
}

async function startTntMinecartChain(username) {
  const player = bot.players[username]?.entity;
  if (!player) {
    say(`I cannot see ${username} right now.`);
    return;
  }

  stopCombat();
  stopTntMinecartChain(false);
  await lowerShield();
  tntMinecartTargetUsername = username;
  lastTntMinecartFiredAt = 0;
  say(`TNT minecart chain started against ${username}.`);

  await runTntMinecartChainTick();
  tntMinecartInterval = setInterval(() => {
    runTntMinecartChainTick();
  }, 750);
}

async function dropGroundTntRingAt(position, mode = 'live') {
  const base = blockPosition(position);
  await runCommand(`particle minecraft:end_rod ${base.x} ${base.y + 1} ${base.z} 18 0.3 18 0.02 180 force`, 80);
  await runCommand(`playsound minecraft:entity.warden.sonic_boom master @a ${base.x} ${base.y} ${base.z} 1 1.2`, 80);

  if (mode === 'safe') {
    await runCommand(`summon minecraft:lightning_bolt ${base.x} ${base.y} ${base.z}`, 80);
    return;
  }

  for (const point of planGroundTntRing(base)) {
    await runCommand(`summon minecraft:tnt ${point.x} ${point.y} ${point.z} {Fuse:${point.fuse}}`, 10);
  }
}

async function fireBedrockTntBeamAt(position, mode = 'live') {
  const base = blockPosition(position);
  await runCommand(`particle minecraft:end_rod ${base.x} ${base.y + 8} ${base.z} 1.2 8 1.2 0.03 220 force`, 120);
  await runCommand(`playsound minecraft:entity.warden.sonic_charge master @a ${base.x} ${base.y} ${base.z} 1 0.7`, 120);
  await sleep(1400);
  await runCommand(`particle minecraft:explosion_emitter ${base.x} ${base.y + 1} ${base.z} 0 0 0 1 1 force`, 80);
  await runCommand(`playsound minecraft:entity.warden.sonic_boom master @a ${base.x} ${base.y} ${base.z} 1 0.6`, 80);
  await runCommand(`fill ${base.x - 1} -63 ${base.z - 1} ${base.x + 2} ${base.y} ${base.z + 2} minecraft:air destroy`, 100);

  if (mode === 'safe') return;

  for (const point of planBedrockTntBeam(base)) {
    await runCommand(`summon minecraft:tnt ${point.x} ${point.y} ${point.z} {Fuse:${point.fuse}}`, 8);
  }
}

function findRodStrikeBobber(username) {
  const player = bot.players[username]?.entity;
  if (!player) return null;

  return Object.values(bot.entities)
    .filter(isFishingBobberEntity)
    .filter((entity) => entity.position.distanceTo(player.position) <= 80)
    .sort((a, b) => a.position.distanceTo(player.position) - b.position.distanceTo(player.position))[0] || null;
}

async function runRodStrikeTick() {
  if (!rodStrikeTargetUsername) return;

  const player = bot.players[rodStrikeTargetUsername]?.entity;
  if (!player) return;

  const bobber = findRodStrikeBobber(rodStrikeTargetUsername);
  if (!bobber) return;

  const now = Date.now();
  const position = blockPosition(bobber.position);
  const bobberKey = `${bobber.id}:${position.x}:${position.y}:${position.z}`;
  if (bobberKey === lastRodStrikeBobberKey) return;
  if (!shouldDropRodStrike({ now, lastDropAt: lastRodStrikeDropAt, cooldownMs: ROD_STRIKE_COOLDOWN_MS })) return;

  lastRodStrikeBobberKey = bobberKey;
  lastRodStrikeDropAt = now;
  const mode = rodStrikeForcedMode || getRodStrikeModeFromItem(player.heldItem);

  if (mode === 'beam') {
    await fireBedrockTntBeamAt(position);
    say(`Stab shot beam fired at ${formatPosition(position)}.`);
    return;
  }

  await dropGroundTntRingAt(position);
  say(`Circle shot ring armed at ${formatPosition(position)}.`);
}

async function startRodStrike(username, forcedMode = null) {
  if (!bot.players[username]?.entity) {
    say(`I cannot see ${username} right now.`);
    return;
  }

  stopRodStrike(false);
  await runCommand(`give ${username} minecraft:fishing_rod 1`, 100);
  rodStrikeTargetUsername = username;
  rodStrikeForcedMode = forcedMode;
  if (forcedMode === 'beam') {
    say('Fishing-rod stab shot armed. Cast and pull to beam the bobber spot.');
  } else if (forcedMode === 'circle') {
    say('Fishing-rod circle shot armed. Cast and pull to ring the bobber spot.');
  } else {
    say('Fishing-rod shots armed. Rename rod to "circle shot" for ring or "stab shot" for beam, then cast.');
  }
  rodStrikeInterval = setInterval(() => {
    runRodStrikeTick().catch((error) => {
      console.error('Fishing-rod sky TNT failed:', error);
    });
  }, 250);
}

bot.once('spawn', () => {
  const movements = new Movements(bot);
  movements.canDig = false;
  bot.pathfinder.setMovements(movements);

  console.log(`${bot.username} connected to ${config.host}:${config.port}`);
  say('Ready for experiments. Try: bot come, bot stop, bot shield up, bot practice.');
});

bot.on('login', () => {
  console.log(`${bot.username} logged in.`);
});

bot.on('end', (reason) => {
  console.log('Bot disconnected:', reason);
});

async function handleBotCommand(username, command, args) {
  if (command === 'come') {
    const player = bot.players[username]?.entity;
    if (!player) {
      say(`I cannot see ${username} right now.`);
      return;
    }

    const goal = new goals.GoalNear(player.position.x, player.position.y, player.position.z, 2);
    bot.pathfinder.setGoal(goal);
    say(`Coming to ${username}.`);
    return;
  }

  if (command === 'stop') {
    stopRodStrike(false);
    stopTntMinecartChain(false);
    stopCombat();
    bot.pathfinder.stop();
    say('Stopped.');
    return;
  }

  if (command === 'passive') {
    stopRodStrike(false);
    stopTntMinecartChain(false);
    stopCombat();
    await lowerShield();
    say('Passive mode.');
    return;
  }

  if (command === 'say') {
    say(args.join(' ') || 'Hello from CodexBot.');
    return;
  }

  if (command === 'pos') {
    const { x, y, z } = bot.entity.position;
    say(`I am at ${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}.`);
    return;
  }

  if (command === 'look') {
    const player = bot.players[username]?.entity || nearestPlayer();
    if (!player) {
      say('I do not see a player to look at.');
      return;
    }

    await bot.lookAt(player.position.offset(0, 1.6, 0));
    say(`Looking at ${player.username || username}.`);
    return;
  }

  if (command === 'shield') {
    const mode = args[0] || 'up';

    if (mode === 'up' || mode === 'raise') {
      await keepShieldUp();
      return;
    }

    if (mode === 'down' || mode === 'lower') {
      await lowerShield();
      return;
    }

    if (mode === 'equip') {
      if (await equipShield()) say('Shield equipped.');
      return;
    }

    say('Try: bot shield up, bot shield down, or bot shield equip.');
    return;
  }

  if (command === 'spar' || command === 'attack') {
    await startSparring(username);
    return;
  }

  if (command === 'cannon' || command === 'orbital') {
    const mode = args[0] || 'help';

    if (mode === 'build') {
      await buildOrbitalCannon(bot.entity.position);
      return;
    }

    if (mode === 'target' || mode === 'lock') {
      await setOrbitalTargetFromPlayer(username);
      return;
    }

    if (mode === 'fire') {
      await fireOrbitalStrike(args[1] || 'live');
      return;
    }

    if (mode === 'safe') {
      await fireOrbitalStrike('safe');
      return;
    }

    say('Try: bot cannon build, bot cannon target, bot cannon fire, or bot cannon safe.');
    return;
  }

  if (command === 'tntcart' || command === 'minecart') {
    const mode = args[0] || 'fire';

    if (mode === 'gear') {
      await gearTntMinecartArcher();
      say('TNT minecart Flame-bow gear ready.');
      return;
    }

    if (mode === 'fire' || mode === 'spar' || mode === 'pvp') {
      await fireTntMinecartTrap(username);
      return;
    }

    if (mode === 'start' || mode === 'chain' || mode === 'auto') {
      await startTntMinecartChain(username);
      return;
    }

    if (mode === 'stop') {
      stopTntMinecartChain();
      return;
    }

    say('Try: bot tntcart gear, bot tntcart fire, bot tntcart start, or bot tntcart stop.');
    return;
  }

  if (command === 'rod' || command === 'fishing') {
    const mode = args[0] || 'start';

    if (mode === 'start' || mode === 'arm') {
      await startRodStrike(username, getForcedRodStrikeMode(args[1]));
      return;
    }

    if (mode === 'stop' || mode === 'disarm') {
      stopRodStrike();
      return;
    }

    if (mode === 'drop' || mode === 'fire') {
      const player = bot.players[username]?.entity;
      if (!player) {
        say(`I cannot see ${username} right now.`);
        return;
      }

      await dropGroundTntRingAt(player.position);
      say('Ground TNT ring dropped at your position.');
      return;
    }

    if (mode === 'safe') {
      const player = bot.players[username]?.entity;
      if (!player) {
        say(`I cannot see ${username} right now.`);
        return;
      }

      await dropGroundTntRingAt(player.position, 'safe');
      say('Safe visual strike dropped at your position.');
      return;
    }

    if (mode === 'beam' || mode === 'charged') {
      const player = bot.players[username]?.entity;
      if (!player) {
        say(`I cannot see ${username} right now.`);
        return;
      }

      await fireBedrockTntBeamAt(player.position, args[1] || 'live');
      say('Charged bedrock beam fired.');
      return;
    }

    say('Try: bot rod start, bot rod stop, bot rod drop, bot rod beam, or bot rod safe.');
    return;
  }

  if (command === 'beam' || command === 'charged') {
    const player = bot.players[username]?.entity;
    if (!player) {
      say(`I cannot see ${username} right now.`);
      return;
    }

    await fireBedrockTntBeamAt(player.position, args[0] || 'live');
    say('Charged bedrock beam fired.');
    return;
  }

  if (command === 'inventory' || command === 'inv') {
    const items = bot.inventory.items().map((item) => `${item.name}x${item.count}`).join(', ') || 'empty';
    const offHand = getOffHandItem()?.name || 'empty';
    say(`Inventory: ${items}; off-hand: ${offHand}.`);
    return;
  }

  if (command === 'practice') {
    bot.pathfinder.stop();

    const player = bot.players[username]?.entity;
    if (player) {
      await bot.lookAt(player.position.offset(0, 1.6, 0));
    }

    await keepShieldUp();
    return;
  }

  if (command === 'jump') {
    bot.setControlState('jump', true);
    setTimeout(() => bot.setControlState('jump', false), 500);
    return;
  }

  if (command === 'place-test') {
    const referenceBlock = bot.blockAt(bot.entity.position.offset(0, -1, 0));
    const held = bot.heldItem;

    if (!referenceBlock || !held) {
      say('I need to hold a placeable block while standing on solid ground.');
      return;
    }

    await bot.placeBlock(referenceBlock, new Vec3(1, 0, 0));
    say(`Placed ${held.name}.`);
    return;
  }

  say(`Unknown command: bot ${command}`);
}

bot.on('chat', async (username, message) => {
  if (username === bot.username) return;

  const commands = parseBotMessages(message);
  for (const { command, args } of commands) {
    await handleBotCommand(username, command, args);
  }
});

bot.on('kicked', (reason) => {
  console.error('Kicked:', reason);
});

bot.on('error', (error) => {
  console.error('Bot error:', error);
});

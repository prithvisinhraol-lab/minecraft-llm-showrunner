import mineflayer from 'mineflayer';
import pathfinderPackage from 'mineflayer-pathfinder';
import { loadEnvFile } from './load-env.mjs';
import {
  isMaceBoostActive,
  shouldMaceAttackDuringBoost,
  shouldUseWindCharge
} from './mace-combat.mjs';

await loadEnvFile();

const { pathfinder, Movements, goals } = pathfinderPackage;

const host = process.env.MC_HOST || '127.0.0.1';
const port = Number(process.env.MC_PORT || 25565);
const version = process.env.MC_VERSION || false;
const mode = process.env.MOVIE_WAR_MODE || 'hold';
const districtCenter = { x: 532, y: 94, z: 44 };
const fightStartDelayMs = Number(process.env.MOVIE_WAR_START_DELAY_MS || 9000);

const botConfigs = [
  { username: 'LordAegis', team: 'lord', color: 'dark_red', role: 'sword', side: 'west', lineOffset: -8, yaw: -90, skill: { tick: 210, attack: 760, follow: 2.0, aim: 1.45 } },
  { username: 'LordVow', team: 'lord', color: 'dark_red', role: 'sword', side: 'west', lineOffset: -4, yaw: -90, skill: { tick: 275, attack: 980, follow: 2.4, aim: 1.2 } },
  { username: 'Lord1Mace', team: 'lord', color: 'dark_red', role: 'mace', side: 'west', lineOffset: 0, yaw: -90, skill: { tick: 230, attack: 720, follow: 2.6, aim: 1.4, wind: 2600 } },
  { username: 'LordGuard', team: 'lord', color: 'dark_red', role: 'sword', side: 'west', lineOffset: 4, yaw: -90, skill: { tick: 240, attack: 860, follow: 2.2, aim: 1.35 } },
  { username: 'LordKnight', team: 'lord', color: 'dark_red', role: 'sword', side: 'west', lineOffset: 8, yaw: -90, skill: { tick: 330, attack: 1160, follow: 2.8, aim: 1.1 } },
  { username: 'KingCrown', team: 'king', color: 'gold', role: 'sword', side: 'east', lineOffset: -8, yaw: 90, skill: { tick: 225, attack: 810, follow: 2.1, aim: 1.4 } },
  { username: 'KingOath', team: 'king', color: 'gold', role: 'sword', side: 'east', lineOffset: -4, yaw: 90, skill: { tick: 290, attack: 1040, follow: 2.6, aim: 1.25 } },
  { username: 'King1Mace', team: 'king', color: 'gold', role: 'mace', side: 'east', lineOffset: 0, yaw: 90, skill: { tick: 245, attack: 780, follow: 2.7, aim: 1.35, wind: 3100 } },
  { username: 'KingBanner', team: 'king', color: 'gold', role: 'sword', side: 'east', lineOffset: 4, yaw: 90, skill: { tick: 255, attack: 900, follow: 2.3, aim: 1.3 } },
  { username: 'KingSteel', team: 'king', color: 'gold', role: 'sword', side: 'east', lineOffset: 8, yaw: 90, skill: { tick: 350, attack: 1240, follow: 3.0, aim: 1.05 } }
];

const roster = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getOffHandItem(bot) {
  return bot.inventory.slots[45] || null;
}

function countInventoryItems(bot, name) {
  return bot.inventory.items()
    .filter((item) => item.name === name)
    .reduce((total, item) => total + item.count, 0);
}

function findInventoryItem(bot, name) {
  return bot.inventory.items().find((item) => item.name === name);
}

async function equipItem(bot, name, destination) {
  const item = findInventoryItem(bot, name);
  if (!item) return false;
  await bot.equip(item, destination);
  return true;
}

async function equipRole(bot, config) {
  if (config.role === 'mace') {
    await equipItem(bot, 'mace', 'hand').catch(() => {});
    await equipItem(bot, 'shield', 'off-hand').catch(() => {});
    return;
  }

  await equipItem(bot, 'diamond_sword', 'hand').catch(() => {});
  await equipItem(bot, 'shield', 'off-hand').catch(() => {});
}

async function runCommand(bot, command, delayMs = 120) {
  bot.chat(`/${command}`);
  await sleep(delayMs);
}

async function selfGear(bot, config) {
  await runCommand(bot, `team add ${config.team}`, 50).catch(() => {});
  await runCommand(bot, `team modify ${config.team} color ${config.color}`, 50).catch(() => {});
  await runCommand(bot, `team join ${config.team} @s`, 50).catch(() => {});
  await runCommand(bot, `spawnpoint @s ${districtCenter.x} ${districtCenter.y} ${districtCenter.z}`, 70);
  await runCommand(bot, 'item replace entity @s armor.head with minecraft:diamond_helmet', 70);
  await runCommand(bot, 'item replace entity @s armor.chest with minecraft:diamond_chestplate', 70);
  await runCommand(bot, 'item replace entity @s armor.legs with minecraft:diamond_leggings', 70);
  await runCommand(bot, 'item replace entity @s armor.feet with minecraft:diamond_boots', 70);
  await runCommand(bot, 'item replace entity @s weapon.offhand with minecraft:shield', 70);

  if (config.role === 'mace') {
    await runCommand(bot, 'item replace entity @s weapon.mainhand with minecraft:mace', 70);
    await runCommand(bot, 'give @s minecraft:wind_charge 64', 70);
  } else {
    await runCommand(bot, 'item replace entity @s weapon.mainhand with minecraft:diamond_sword', 70);
  }
}

function lineupPosition(config) {
  const x = districtCenter.x + (config.side === 'west' ? -6 : 6);
  return { x, y: districtCenter.y, z: districtCenter.z + config.lineOffset };
}

async function stageBot(bot, config) {
  const position = lineupPosition(config);
  await runCommand(bot, `tp @s ${position.x} ${position.y} ${position.z} ${config.yaw} 0`, 90);
  await runCommand(bot, `spawnpoint @s ${districtCenter.x} ${districtCenter.y} ${districtCenter.z}`, 70);
  bot.pathfinder.stop();
  setMaceBoostControls(bot, false);
}

function setMaceBoostControls(bot, active) {
  bot.setControlState('sprint', active);
  bot.setControlState('forward', active);
  bot.setControlState('jump', active);
}

function lowerShield(bot, entry) {
  if (!entry.shieldUp) return;
  bot.deactivateItem();
  entry.shieldUp = false;
}

function raiseShield(bot, entry, now) {
  if (entry.shieldUp || now - entry.lastShieldAt < 650) return;
  if (getOffHandItem(bot)?.name !== 'shield') return;
  bot.activateItem(true);
  entry.shieldUp = true;
  entry.lastShieldAt = now;
}

async function readyTaunt(bot, config) {
  bot.pathfinder.stop();
  setMaceBoostControls(bot, false);
  for (let i = 0; i < 3; i += 1) {
    bot.setControlState('sneak', true);
    await sleep(450 + (config.skill.tick % 120));
    bot.setControlState('sneak', false);
    await sleep(350);
  }
}

function findTarget(bot, config) {
  return [...roster.values()]
    .filter((entry) => entry.config.team !== config.team)
    .map((entry) => bot.players?.[entry.config.username]?.entity || entry.bot.entity)
    .filter(Boolean)
    .filter((entity) => entity.username !== bot.username)
    .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))[0] || null;
}

async function tryWindChargeMace(entry, target, distance, now) {
  const { bot, config } = entry;
  const ready = shouldUseWindCharge({
    distance,
    now,
    lastWindChargeAt: entry.lastWindChargeAt,
    mainHandName: bot.heldItem?.name || null,
    offHandName: getOffHandItem(bot)?.name || null,
    inventoryWindCharges: countInventoryItems(bot, 'wind_charge')
  });

  if (!ready || now - entry.lastWindChargeAt < config.skill.wind) return false;
  if (getOffHandItem(bot)?.name !== 'wind_charge' && !(await equipItem(bot, 'wind_charge', 'off-hand').catch(() => false))) return false;

  entry.lastWindChargeAt = now;
  bot.pathfinder.stop();
  setMaceBoostControls(bot, false);
  await bot.lookAt(bot.entity.position.offset(0, -1.2, 0), true);
  bot.activateItem(true);
  await sleep(150);
  bot.deactivateItem();
  await bot.lookAt(target.position.offset(0, config.skill.aim, 0), true);
  setMaceBoostControls(bot, true);
  return true;
}

async function fightTick(entry) {
  const { bot, config } = entry;
  if (!bot.entity) return;

  const target = findTarget(bot, config);
  if (!target) return;

  const now = Date.now();
  const distance = bot.entity.position.distanceTo(target.position);
  const boostActive = config.role === 'mace' && isMaceBoostActive({ now, lastWindChargeAt: entry.lastWindChargeAt });

  if (boostActive) {
    bot.pathfinder.stop();
    lowerShield(bot, entry);
    setMaceBoostControls(bot, true);
  } else {
    setMaceBoostControls(bot, false);
    if (config.role === 'mace' && getOffHandItem(bot)?.name !== 'shield') {
      await equipItem(bot, 'shield', 'off-hand').catch(() => {});
    }
    bot.setControlState('sprint', true);
    bot.pathfinder.setGoal(new goals.GoalFollow(target, config.skill.follow), true);
  }

  await bot.lookAt(target.position.offset(0, config.skill.aim, 0), true);

  if (!boostActive && distance <= 8 && distance > 2.4) {
    raiseShield(bot, entry, now);
  }

  if (config.role === 'mace') {
    if (!boostActive && distance < 2.7 && now - entry.lastWindChargeAt > 1000) {
      lowerShield(bot, entry);
      bot.pathfinder.stop();
      bot.setControlState('back', true);
      await sleep(260);
      bot.setControlState('back', false);
    }

    if (shouldMaceAttackDuringBoost({ distance, now, lastWindChargeAt: entry.lastWindChargeAt, lastAttackAt: entry.lastAttackAt })) {
      lowerShield(bot, entry);
      entry.lastAttackAt = now;
      bot.attack(target);
      return;
    }

    if (!boostActive && await tryWindChargeMace(entry, target, distance, now)) return;
  }

  if (distance <= 3.6 && now - entry.lastAttackAt >= config.skill.attack) {
    lowerShield(bot, entry);
    entry.lastAttackAt = now;
    bot.attack(target);
    setTimeout(() => {
      if (entry.bot.entity && config.role === 'sword') raiseShield(entry.bot, entry, Date.now());
    }, 220 + (config.skill.tick % 180));
  }
}

function createMovieBot(config, index) {
  const bot = mineflayer.createBot({
    host,
    port,
    username: config.username,
    auth: process.env.MC_AUTH || 'offline',
    version
  });

  bot.loadPlugin(pathfinder);

  const entry = {
    bot,
    config,
    interval: null,
    deaths: 0,
    lastAttackAt: 0,
    lastWindChargeAt: 0,
    lastShieldAt: 0,
    shieldUp: false
  };
  roster.set(config.username, entry);

  bot.on('spawn', async () => {
    const movements = new Movements(bot);
    movements.canDig = false;
    bot.pathfinder.setMovements(movements);
    await sleep(700 + index * 120);
    await equipRole(bot, config);
    if (mode === 'fight' && !entry.interval) {
      readyTaunt(bot, config).catch((error) => console.error(`${config.username} ready taunt failed:`, error.message));
      setTimeout(() => {
        if (entry.interval || !bot.entity) return;
        bot.setControlState('sneak', false);
        entry.interval = setInterval(() => {
          fightTick(entry).catch((error) => console.error(`${config.username} fight tick failed:`, error.message));
        }, config.skill.tick);
      }, fightStartDelayMs + index * 80);
    }
    console.log(`${config.username} joined team ${config.team} as ${config.role} in ${mode} mode.`);
  });

  bot.on('death', () => {
    if (mode !== 'fight') {
      console.log(`${config.username} died in hold mode; leaving the fight paused.`);
      return;
    }

    entry.deaths += 1;
    lowerShield(bot, entry);
    setMaceBoostControls(bot, false);
    bot.pathfinder.stop();

    if (entry.deaths >= 3) {
      if (entry.interval) clearInterval(entry.interval);
      console.log(`${config.username} is out after 3 deaths.`);
      bot.end();
      return;
    }

    entry.lastAttackAt = 0;
    entry.lastWindChargeAt = 0;
    console.log(`${config.username} respawning (${3 - entry.deaths} deaths left).`);
    setTimeout(() => bot.respawn(), 1800 + index * 90);
  });

  bot.on('end', (reason) => {
    if (entry.interval) clearInterval(entry.interval);
    console.log(`${config.username} disconnected: ${reason}`);
  });

  bot.on('error', (error) => {
    console.error(`${config.username} error:`, error.message);
  });
}

console.log(`Starting ${botConfigs.length} movie-war bots on ${host}:${port} in ${mode} mode.`);
botConfigs.forEach((config, index) => {
  setTimeout(() => createMovieBot(config, index), index * 650);
});

process.on('SIGINT', () => {
  for (const { bot, interval } of roster.values()) {
    if (interval) clearInterval(interval);
    bot.end();
  }
  process.exit(0);
});

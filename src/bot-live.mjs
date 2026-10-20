import mineflayer from 'mineflayer';
import pathfinderPackage from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { loadEnvFile } from './load-env.mjs';

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
let orbitalTarget = null;

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

function getOffHandItem() {
  return bot.inventory.slots[45] || null;
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
  bot.pathfinder.stop();
}

async function startSparring(username) {
  const player = bot.players[username]?.entity;
  if (!player) {
    say(`I cannot see ${username} right now.`);
    return;
  }

  combatTargetUsername = username;
  lastAttackAt = 0;
  await keepShieldUp();
  bot.pathfinder.setGoal(new goals.GoalFollow(player, 2), true);
  say(`Sparring with ${username}.`);

  if (combatInterval) clearInterval(combatInterval);
  combatInterval = setInterval(async () => {
    const target = bot.players[combatTargetUsername]?.entity;
    if (!target) return;

    bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
    await bot.lookAt(target.position.offset(0, 1.4, 0), true);

    const distance = bot.entity.position.distanceTo(target.position);
    const now = Date.now();
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

bot.on('chat', async (username, message) => {
  if (username === bot.username || !message.startsWith('bot ')) return;

  const [command, ...args] = message.slice(4).trim().split(/\s+/);

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
    stopCombat();
    bot.pathfinder.stop();
    say('Stopped.');
    return;
  }

  if (command === 'passive') {
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
});

bot.on('kicked', (reason) => {
  console.error('Kicked:', reason);
});

bot.on('error', (error) => {
  console.error('Bot error:', error);
});

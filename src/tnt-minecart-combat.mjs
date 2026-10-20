function blockPosition(position) {
  return {
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z)
  };
}

export function planTntMinecartLane(botPosition, targetPosition) {
  const bot = blockPosition(botPosition);
  const dx = targetPosition.x - botPosition.x;
  const dz = targetPosition.z - botPosition.z;
  const useX = Math.abs(dx) >= Math.abs(dz);
  const step = useX
    ? (dx >= 0 ? 1 : -1)
    : (dz >= 0 ? 1 : -1);

  if (useX) {
    const startX = bot.x + (2 * step);
    const endX = bot.x + (7 * step);
    const minX = Math.min(bot.x + step, endX + step);
    const maxX = Math.max(bot.x + step, endX + step);

    return {
      start: { x: startX, y: bot.y, z: bot.z },
      end: { x: endX, y: bot.y, z: bot.z },
      supportStart: { x: minX, y: bot.y - 1, z: bot.z - 1 },
      supportEnd: { x: maxX, y: bot.y - 1, z: bot.z + 1 },
      railShape: 'east_west',
      motion: [0.75 * step, 0, 0],
      shotTarget: { x: startX + 0.5, y: bot.y + 0.4, z: bot.z + 0.5 }
    };
  }

  const startZ = bot.z + (2 * step);
  const endZ = bot.z + (7 * step);
  const minZ = Math.min(bot.z + step, endZ + step);
  const maxZ = Math.max(bot.z + step, endZ + step);

  return {
    start: { x: bot.x, y: bot.y, z: startZ },
    end: { x: bot.x, y: bot.y, z: endZ },
    supportStart: { x: bot.x - 1, y: bot.y - 1, z: minZ },
    supportEnd: { x: bot.x + 1, y: bot.y - 1, z: maxZ },
    railShape: 'north_south',
    motion: [0, 0, 0.75 * step],
    shotTarget: { x: bot.x + 0.5, y: bot.y + 0.4, z: startZ + 0.5 }
  };
}

export function shouldFireTntMinecartChain({ now, lastFiredAt, cooldownMs }) {
  return now - lastFiredAt >= cooldownMs;
}

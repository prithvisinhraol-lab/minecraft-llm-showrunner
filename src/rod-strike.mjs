export function isFishingBobberEntity(entity) {
  const names = [
    entity?.name,
    entity?.displayName
  ];

  if (entity && Object.prototype.hasOwnProperty.call(entity, 'objectType')) {
    names.push(entity.objectType);
  }

  return names
    .filter(Boolean)
    .map((name) => String(name).toLowerCase().replace(/\s+/g, '_'))
    .some((name) => name === 'fishing_bobber' || name === 'fishing_hook');
}

export function shouldDropRodStrike({ now, lastDropAt, cooldownMs }) {
  return now - lastDropAt >= cooldownMs;
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;

  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function collectNameText(value, parts = []) {
  if (value === null || value === undefined) return parts;

  const parsed = parseMaybeJson(value);
  if (parsed !== value) return collectNameText(parsed, parts);

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    parts.push(String(value));
    return parts;
  }

  if (Array.isArray(value)) {
    for (const part of value) collectNameText(part, parts);
    return parts;
  }

  if (typeof value === 'object') {
    collectNameText(value.data, parts);
    collectNameText(value.text, parts);
    collectNameText(value.value, parts);
    collectNameText(value.extra, parts);
  }

  return parts;
}

export function getRodStrikeModeFromItem(item) {
  const names = collectNameText([
    item?.customName,
    item?.componentMap?.get?.('custom_name'),
    item?.componentMap?.get?.('custom_name')?.data,
    item?.displayName,
    item?.name
  ]).map((name) => name.toLowerCase());

  if (names.some((name) => name.includes('stab shot'))) return 'beam';
  if (names.some((name) => name.includes('circle shot'))) return 'circle';

  return 'circle';
}

export function getForcedRodStrikeMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'stab' || mode === 'beam' || mode === 'charged') return 'beam';
  if (mode === 'circle' || mode === 'ring') return 'circle';
  return null;
}

export function planGroundTntRing(position, { count = 160, radius = 18, fuse = 80 } = {}) {
  const center = {
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z)
  };

  return Array.from({ length: count }, (_, index) => {
    const angle = (Math.PI * 2 * index) / count;
    return {
      x: Math.round(center.x + Math.cos(angle) * radius),
      y: center.y,
      z: Math.round(center.z + Math.sin(angle) * radius),
      fuse
    };
  });
}

export function planBedrockTntBeam(position, { count = 160, fuse = 70, minY = -63 } = {}) {
  const center = {
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z)
  };
  const footprint = [];

  for (let dx = -1; dx <= 2; dx += 1) {
    for (let dz = -1; dz <= 2; dz += 1) {
      footprint.push({ x: center.x + dx, z: center.z + dz });
    }
  }

  const verticalRange = Math.max(1, center.y - minY);
  return Array.from({ length: count }, (_, index) => {
    const point = footprint[index % footprint.length];
    const y = Math.max(minY, Math.round(center.y - (verticalRange * index) / Math.max(1, count - 1)));

    return {
      x: point.x,
      y,
      z: point.z,
      fuse
    };
  });
}

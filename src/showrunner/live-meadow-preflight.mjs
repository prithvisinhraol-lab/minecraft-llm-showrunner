function coded(code) {
  return Object.assign(new Error(code), { code });
}

function samePosition(left, right) {
  return left && right && ['x', 'y', 'z'].every((axis) => left.position?.[axis] === right.position?.[axis]);
}

function validatePoint(value) {
  if (!value || value.dimension !== 'minecraft:overworld') throw coded('WRONG_DIMENSION');
  if (!value.support || value.support === 'air' || value.support === 'water' || value.hazardous) throw coded('UNSAFE_SUPPORT');
  if (value.feetPassable !== true || value.headPassable !== true) throw coded('HEADROOM_BLOCKED');
  if (value.reachable !== true) throw coded('MARK_UNREACHABLE');
}

export function runLiveMeadowPreflight(input) {
  const requiredPlayers = [input.operatorName, 'HeroActor', 'RivalActor'];
  if (!Array.isArray(input.onlinePlayers) || !input.onlinePlayers.includes(input.operatorName)) throw coded('OPERATOR_OFFLINE');
  if (requiredPlayers.some((name) => !input.onlinePlayers.includes(name))) throw coded('ACTOR_OFFLINE');
  const points = [input.camera, input.hero, input.rival, input.crafting];
  points.forEach(validatePoint);
  for (let left = 0; left < 3; left += 1) for (let right = left + 1; right < 3; right += 1) {
    if (samePosition(points[left], points[right])) throw coded('POSITIONS_NOT_DISTINCT');
  }
  if (!input.treeTargets?.hero?.length || !input.treeTargets?.rival?.length) throw coded('TREE_TARGETS_MISSING');
  if (!Number.isSafeInteger(input.excavationCells?.expected) || input.excavationCells.expected < 1 ||
      input.excavationCells.valid !== input.excavationCells.expected) throw coded('EXCAVATION_INVALID');
  return Object.freeze({ ok: true, operator: input.operatorName, positions: Object.freeze({
    camera: structuredClone(input.camera.position), hero: structuredClone(input.hero.position),
    rival: structuredClone(input.rival.position), crafting: structuredClone(input.crafting.position)
  }) });
}

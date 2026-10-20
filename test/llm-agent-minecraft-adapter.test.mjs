import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { Vec3 } from 'vec3';

import { FIRST_GOAL_OBJECTIVE } from '../src/llm-agent/contracts.mjs';
import { COLLECT_OAK_LOG_GOAL } from '../src/llm-agent/goals.mjs';
import { createMinecraftAdapter } from '../src/llm-agent/minecraft-adapter.mjs';

const goal = {
  objective: FIRST_GOAL_OBJECTIVE,
  successCondition: { kind: 'oak_log_above_gold_marker' }
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function key(position) {
  return `${position.x},${position.y},${position.z}`;
}

class GoalNear {
  constructor(x, y, z, range) {
    Object.assign(this, { x, y, z, range });
  }
}

class Movements {
  constructor(bot) {
    this.bot = bot;
    this.canDig = true;
  }
}

class FakeBot extends EventEmitter {
  constructor() {
    super();
    this.health = 20;
    this.food = 18;
    this.game = { dimension: 'minecraft:overworld' };
    this.player = { username: 'AgentOne' };
    this.entity = { id: 7, position: new Vec3(0, 64, 0) };
    this._client = { state: 'play', socket: { destroyed: false } };
    this.registry = {
      blocksByName: {
        oak_log: { id: 17 },
        gold_block: { id: 41 }
      }
    };
    this.blocks = new Map();
    this.stacks = [];
    this.effects = [];
    this.findCalls = [];
    this.inventory = { items: () => this.stacks };
    this.pathfinder = {
      setMovements: (movements) => {
        this.effects.push(['setMovements', movements]);
      },
      goto: async (receivedGoal) => {
        this.effects.push(['goto', receivedGoal]);
        this.entity.position = new Vec3(receivedGoal.x, receivedGoal.y, receivedGoal.z);
      },
      stop: () => {
        this.effects.push(['stopPathfinder']);
      }
    };
  }

  setBlock(position, name) {
    const type = this.registry.blocksByName[name]?.id ?? 0;
    this.blocks.set(key(position), { name, type, position: position.clone() });
  }

  blockAt(position) {
    return this.blocks.get(key(position)) ?? { name: 'air', type: 0, position: position.clone() };
  }

  findBlocks(options) {
    this.findCalls.push(options);
    return [...this.blocks.values()]
      .filter((block) => block.position.distanceTo(options.point ?? this.entity.position) <= options.maxDistance)
      .filter((block) => typeof options.matching === 'function'
        ? options.matching(block)
        : (Array.isArray(options.matching) ? options.matching : [options.matching]).includes(block.type))
      .sort((left, right) => left.position.distanceTo(this.entity.position) - right.position.distanceTo(this.entity.position))
      .slice(0, options.count)
      .map((block) => block.position.clone());
  }

  async dig(block) {
    this.effects.push(['dig', block]);
    this.setBlock(block.position, 'air');
    const existing = this.stacks.find((item) => item.name === 'oak_log');
    if (existing) existing.count += 1;
    else this.stacks.push({ name: 'oak_log', count: 1 });
  }

  stopDigging() {
    this.effects.push(['stopDigging']);
  }

  async equip(item, destination) {
    this.effects.push(['equip', item, destination]);
    this.heldItem = item;
  }

  async placeBlock(reference, faceVector) {
    this.effects.push(['placeBlock', reference, faceVector]);
    this.setBlock(reference.position.offset(faceVector.x, faceVector.y, faceVector.z), 'oak_log');
    const stack = this.stacks.find((item) => item.name === 'oak_log');
    stack.count -= 1;
    if (stack.count === 0) this.stacks = this.stacks.filter((item) => item !== stack);
  }
}

function rig() {
  const bot = new FakeBot();
  return {
    bot,
    adapter: createMinecraftAdapter({ bot, goals: { GoalNear }, Movements })
  };
}

function target(observation, block) {
  return observation.targets.find((candidate) => candidate.block === block);
}

test('observes only the nearest public oak and gold targets with opaque per-observation IDs', async () => {
  const { bot, adapter } = rig();
  bot.stacks = [{ name: 'oak_log', count: 1 }, { name: 'apple', count: 2 }, { name: 'oak_log', count: 2 }];
  bot.setBlock(new Vec3(2, 64, 0), 'oak_log');
  bot.setBlock(new Vec3(4, 64, 0), 'gold_block');
  for (let x = 5; x <= 12; x += 1) bot.setBlock(new Vec3(x, 64, 0), 'oak_log');

  const first = await adapter.observe();

  assert.deepEqual(Object.keys(first), ['health', 'food', 'connected', 'dimension', 'inventory', 'targets', 'landmarks']);
  assert.deepEqual(first.inventory, [{ item: 'apple', count: 2 }, { item: 'oak_log', count: 3 }]);
  assert.equal(first.targets.length, 8);
  assert.deepEqual(first.targets.slice(0, 2).map(({ block }) => block), ['oak_log', 'gold_block']);
  assert.deepEqual(first.targets[0], {
    id: first.targets[0].id, kind: 'block', block: 'oak_log', distanceBand: 'near', reachable: true
  });
  assert.match(first.targets[0].id, /^target-[0-9]+-[0-9]+$/);
  assert.equal(JSON.stringify(first.targets).includes('position'), false);
  assert.equal(JSON.stringify(first.targets).includes('"x"'), false);
  assert.equal(Math.max(...bot.findCalls.map(({ maxDistance }) => maxDistance)), 32);

  const second = await adapter.observe();
  assert.notDeepEqual(second.targets.map(({ id }) => id), first.targets.map(({ id }) => id));
});

test('moves only to a target in the current observation using non-digging GoalNear', async () => {
  const { bot, adapter } = rig();
  bot.setBlock(new Vec3(3, 64, 0), 'oak_log');
  const first = await adapter.observe();
  const oldTarget = target(first, 'oak_log');
  await adapter.observe();

  const stale = await adapter.execute({ action: 'move_to_block', targetId: oldTarget.id });
  assert.equal(stale.code, 'UNKNOWN_TARGET');
  assert.equal(bot.effects.some(([kind]) => kind === 'goto'), false);

  const current = await adapter.observe();
  const receipt = await adapter.execute({ action: 'move_to_block', targetId: target(current, 'oak_log').id });
  const movement = bot.effects.find(([kind]) => kind === 'setMovements')[1];
  const movementGoal = bot.effects.find(([kind]) => kind === 'goto')[1];
  assert.equal(movement.canDig, false);
  assert.deepEqual(movement.scafoldingBlocks, []);
  assert.ok(movementGoal instanceof GoalNear);
  assert.deepEqual([movementGoal.x, movementGoal.y, movementGoal.z, movementGoal.range], [3, 64, 0, 2]);
  assert.equal(receipt.code, 'MOVE_REQUEST_COMPLETED');
});

test('returns to a previously verified goal marker through a stable coordinate-free landmark', async () => {
  const { bot, adapter } = rig();
  const marker = new Vec3(4, 64, 0);
  bot.setBlock(marker, 'gold_block');

  const initial = await adapter.observe();
  assert.deepEqual(initial.landmarks, [{
    reference: 'landmark:goal-marker', kind: 'gold_block', status: 'visible', revisitable: true
  }]);

  bot.entity.position = new Vec3(40, 64, 0);
  const remote = await adapter.observe();
  assert.equal(remote.targets.some(({ block }) => block === 'gold_block'), false);
  assert.deepEqual(remote.landmarks, [{
    reference: 'landmark:goal-marker', kind: 'gold_block', status: 'out_of_view', revisitable: true
  }]);

  const action = { action: 'navigate_to_landmark', reference: 'landmark:goal-marker' };
  const receipt = await adapter.execute(action);
  const after = await adapter.observe();
  const verified = await adapter.verifyAction(action, { before: remote, after, receipt });

  assert.equal(receipt.code, 'LANDMARK_MOVE_REQUEST_COMPLETED');
  assert.equal(after.targets.some(({ block }) => block === 'gold_block'), true);
  assert.deepEqual(verified, {
    ok: true, code: 'LANDMARK_NAVIGATION_VERIFIED', message: 'live world and inventory changes verified the action'
  });
});

test('invalidates a remembered landmark when its live gold block no longer exists', async () => {
  const { bot, adapter } = rig();
  const marker = new Vec3(4, 64, 0);
  bot.setBlock(marker, 'gold_block');
  await adapter.observe();
  bot.entity.position = new Vec3(40, 64, 0);
  bot.setBlock(marker, 'air');

  const receipt = await adapter.execute({
    action: 'navigate_to_landmark', reference: 'landmark:goal-marker'
  });

  assert.equal(receipt.code, 'LANDMARK_INVALIDATED');
  assert.deepEqual((await adapter.observe()).landmarks, []);
  assert.equal(bot.effects.some(([kind]) => kind === 'goto'), false);
});

test('mines only a currently mapped live oak log and waits for normal inventory pickup', async () => {
  const { bot, adapter } = rig();
  const oak = new Vec3(2, 64, 0);
  const gold = new Vec3(4, 64, 0);
  bot.setBlock(oak, 'oak_log');
  bot.setBlock(gold, 'gold_block');
  const observation = await adapter.observe();

  const wrongKind = await adapter.execute({ action: 'mine_block', targetId: target(observation, 'gold_block').id });
  assert.equal(wrongKind.code, 'TARGET_NOT_OAK_LOG');
  assert.equal(bot.effects.some(([kind]) => kind === 'dig'), false);

  const receipt = await adapter.execute({ action: 'mine_block', targetId: target(observation, 'oak_log').id });
  assert.equal(receipt.code, 'OAK_LOG_COLLECTED');
  assert.deepEqual(receipt.inventory, { before: 0, after: 1 });
  assert.deepEqual(receipt.observed, { targetBefore: 'oak_log', targetAfter: 'air' });
  assert.equal(bot.blockAt(oak).name, 'air');
});

test('returns ITEM_NOT_COLLECTED when digging removes the log without a normal pickup', async () => {
  const { bot, adapter } = rig();
  const oak = new Vec3(2, 64, 0);
  bot.setBlock(oak, 'oak_log');
  bot.dig = async (block) => {
    bot.effects.push(['dig', block]);
    bot.setBlock(block.position, 'air');
  };
  const observation = await adapter.observe();
  const action = { action: 'mine_block', targetId: target(observation, 'oak_log').id };

  const receipt = await adapter.execute(action);
  const after = await adapter.observe();
  const verified = await adapter.verifyAction(action, { before: observation, after, receipt: { ok: true } });

  assert.equal(receipt.ok, false);
  assert.equal(receipt.code, 'ITEM_NOT_COLLECTED');
  assert.deepEqual(receipt.inventory, { before: 0, after: 0 });
  assert.deepEqual(verified, {
    ok: false,
    code: 'ITEM_NOT_COLLECTED',
    message: 'the live oak log disappeared without an oak_log inventory increase'
  });
});

test('selects only an oak log that is currently owned', async () => {
  const { bot, adapter } = rig();

  const missing = await adapter.execute({ action: 'select_item', item: 'oak_log' });
  assert.equal(missing.code, 'ITEM_NOT_OWNED');
  assert.equal(bot.effects.some(([kind]) => kind === 'equip'), false);

  bot.stacks = [{ name: 'oak_log', count: 2 }];
  const selected = await adapter.execute({ action: 'select_item', item: 'oak_log' });
  assert.equal(selected.code, 'OAK_LOG_SELECTED');
  assert.equal(bot.heldItem.name, 'oak_log');
  assert.deepEqual(bot.effects.find(([kind]) => kind === 'equip').slice(2), ['hand']);
});

test('placement refuses an inventory-only oak log and never equips it', async () => {
  const { bot, adapter } = rig();
  bot.setBlock(new Vec3(4, 64, 0), 'gold_block');
  bot.stacks = [{ name: 'oak_log', count: 1 }];
  const observation = await adapter.observe();

  const receipt = await adapter.execute({
    action: 'place_on_block',
    targetId: target(observation, 'gold_block').id
  });

  assert.equal(receipt.ok, false);
  assert.equal(receipt.code, 'ITEM_NOT_SELECTED');
  assert.deepEqual(receipt.inventory, { before: 1, after: 1 });
  assert.equal(bot.effects.some(([kind]) => kind === 'equip'), false);
  assert.equal(bot.effects.some(([kind]) => kind === 'placeBlock'), false);
});

test('places only on a mapped live gold marker and verifies the selected marker from the world', async () => {
  const { bot, adapter } = rig();
  const marker = new Vec3(4, 64, 0);
  bot.setBlock(marker, 'gold_block');
  bot.stacks = [{ name: 'oak_log', count: 1 }];
  const observation = await adapter.observe();
  const markerTarget = target(observation, 'gold_block');
  await adapter.execute({ action: 'select_item', item: 'oak_log' });
  const effectsBeforePlacement = bot.effects.length;

  const receipt = await adapter.execute({ action: 'place_on_block', targetId: markerTarget.id });
  const placementEffects = bot.effects.slice(effectsBeforePlacement);

  assert.equal(receipt.code, 'OAK_LOG_PLACED');
  assert.deepEqual(receipt.inventory, { before: 1, after: 0 });
  assert.deepEqual(receipt.observed, {
    targetBefore: 'gold_block', targetAfter: 'gold_block', aboveBefore: 'air', aboveAfter: 'oak_log'
  });
  assert.equal(placementEffects.some(([kind]) => kind === 'equip'), false);
  assert.deepEqual(placementEffects.find(([kind]) => kind === 'placeBlock')[2], new Vec3(0, 1, 0));
  const verifiedPlacement = await adapter.verifyAction(
    { action: 'place_on_block', targetId: markerTarget.id },
    { before: observation, after: await adapter.observe(), receipt }
  );
  assert.deepEqual(verifiedPlacement.marker, { dimension: 'minecraft:overworld', x: 4, y: 64, z: 0 });
  assert.deepEqual(await adapter.verifyGoal(goal), {
    ok: true,
    proof: {
      markerTargetId: markerTarget.id, marker: { dimension: 'minecraft:overworld', x: 4, y: 64, z: 0 },
      markerBlock: 'gold_block', aboveBlock: 'oak_log'
    }
  });
  bot.setBlock(marker.offset(0, 1, 0), 'air');
  assert.deepEqual(await adapter.verifyGoal(goal), { ok: false, proof: null });
});

test('verifies collecting the oak log from directly above the selected gold marker', async () => {
  const { bot, adapter } = rig();
  const marker = new Vec3(4, 64, 0);
  const above = marker.offset(0, 1, 0);
  bot.setBlock(marker, 'gold_block');
  bot.stacks = [{ name: 'oak_log', count: 1 }];
  const before = await adapter.observe();
  const markerTarget = target(before, 'gold_block');
  await adapter.execute({ action: 'select_item', item: 'oak_log' });
  await adapter.execute({ action: 'place_on_block', targetId: markerTarget.id });
  const withPlacedLog = await adapter.observe();
  const logTarget = withPlacedLog.targets.find((candidate) => candidate.block === 'oak_log');

  await adapter.execute({ action: 'mine_block', targetId: logTarget.id });

  assert.deepEqual(await adapter.verifyGoal(COLLECT_OAK_LOG_GOAL), {
    ok: true,
    proof: {
      markerTargetId: markerTarget.id,
      marker: { dimension: 'minecraft:overworld', x: 4, y: 64, z: 0 },
      markerBlock: 'gold_block',
      aboveBlock: 'air',
      collectedItem: 'oak_log',
      collectedCount: 1
    }
  });

  bot.setBlock(above, 'oak_log');
  assert.deepEqual(await adapter.verifyGoal(COLLECT_OAK_LOG_GOAL), { ok: false, proof: null });
  bot.setBlock(above, 'air');
  bot.setBlock(marker, 'air');
  assert.deepEqual(await adapter.verifyGoal(COLLECT_OAK_LOG_GOAL), { ok: false, proof: null });
  bot.setBlock(marker, 'gold_block');
  bot.stacks = [];
  assert.deepEqual(await adapter.verifyGoal(COLLECT_OAK_LOG_GOAL), { ok: false, proof: null });
});

test('restores a controller-proven marker only when its live collection prerequisite still holds', async () => {
  const { bot, adapter } = rig();
  const marker = new Vec3(4, 64, 0);
  bot.setBlock(marker, 'gold_block');
  bot.setBlock(marker.offset(0, 1, 0), 'oak_log');
  const prior = { trusted: { evidence: { goalProof: {
    markerTargetId: 'prior-target', marker: { dimension: 'minecraft:overworld', x: 4, y: 64, z: 0 },
    markerBlock: 'gold_block', aboveBlock: 'oak_log'
  } } } };

  assert.deepEqual(await adapter.inspectPrerequisite(COLLECT_OAK_LOG_GOAL, prior), {
    ok: true, proof: prior.trusted.evidence.goalProof
  });
  bot.setBlock(marker.offset(0, 1, 0), 'air');
  assert.deepEqual(await adapter.inspectPrerequisite(COLLECT_OAK_LOG_GOAL, prior), { ok: false, proof: null });
});

test('reports the exact live placement fact that failed verification', async () => {
  const { bot, adapter } = rig();
  const marker = new Vec3(4, 64, 0);
  bot.setBlock(marker, 'gold_block');
  bot.stacks = [{ name: 'oak_log', count: 1 }];
  const before = await adapter.observe();
  const action = { action: 'place_on_block', targetId: target(before, 'gold_block').id };
  await adapter.execute({ action: 'select_item', item: 'oak_log' });
  await adapter.execute(action);
  const after = await adapter.observe();
  bot.setBlock(marker.offset(0, 1, 0), 'air');

  assert.deepEqual(await adapter.verifyAction(action, { before, after }), {
    ok: false,
    code: 'PLACED_BLOCK_NOT_PRESENT',
    message: 'the live block above the gold marker is not oak_log'
  });
});

test('waits for the live inventory update before verifying placement', async () => {
  const { bot, adapter } = rig();
  const marker = new Vec3(4, 64, 0);
  bot.setBlock(marker, 'gold_block');
  bot.stacks = [{ name: 'oak_log', count: 1 }];
  bot.placeBlock = async (reference, faceVector) => {
    bot.setBlock(reference.position.offset(faceVector.x, faceVector.y, faceVector.z), 'oak_log');
    setTimeout(() => { bot.stacks = []; }, 20);
  };
  const before = await adapter.observe();
  const action = { action: 'place_on_block', targetId: target(before, 'gold_block').id };
  await adapter.execute({ action: 'select_item', item: 'oak_log' });

  const receipt = await adapter.execute(action);
  const after = await adapter.observe();

  assert.equal(receipt.code, 'OAK_LOG_PLACED');
  assert.deepEqual(await adapter.verifyAction(action, { before, after }), {
    ok: true,
    code: 'OAK_LOG_PLACEMENT_VERIFIED',
    message: 'live world and inventory changes verified the action',
    marker: { dimension: 'minecraft:overworld', x: 4, y: 64, z: 0 }
  });
});

test('verifies actions from live deltas rather than receipt ok claims', async () => {
  const { bot, adapter } = rig();
  const oak = new Vec3(2, 64, 0);
  bot.setBlock(oak, 'oak_log');
  const before = await adapter.observe();
  const action = { action: 'mine_block', targetId: target(before, 'oak_log').id };
  await adapter.execute(action);
  const after = await adapter.observe();

  const proved = await adapter.verifyAction(action, {
    before, after, receipt: { ok: false, code: 'CONTRADICTORY_RECEIPT' }
  });
  assert.deepEqual(proved, {
    ok: true, code: 'OAK_LOG_MINING_VERIFIED', message: 'live world and inventory changes verified the action'
  });

  const unperformed = await adapter.verifyAction(
    { action: 'place_on_block', targetId: 'fabricated' },
    { before, after, receipt: { ok: true, code: 'FABRICATED_SUCCESS' } }
  );
  assert.equal(unperformed.ok, false);
  assert.equal(unperformed.code, 'ACTION_NOT_VERIFIED');
});

test('verifies movement after the controller post-action observation invalidates target IDs', async () => {
  const { bot, adapter } = rig();
  bot.setBlock(new Vec3(3, 64, 0), 'oak_log');
  const before = await adapter.observe();
  const action = { action: 'move_to_block', targetId: target(before, 'oak_log').id };
  await adapter.execute(action);
  const after = await adapter.observe();

  const proved = await adapter.verifyAction(action, {
    before, after, receipt: { ok: false, code: 'CONTRADICTORY_RECEIPT' }
  });

  assert.equal(proved.ok, true);
  assert.equal(proved.code, 'MOVEMENT_VERIFIED');
});

test('abort and stop cancel pending pathfinder and digging work', async () => {
  const moved = rig();
  moved.bot.setBlock(new Vec3(3, 64, 0), 'oak_log');
  const moveObservation = await moved.adapter.observe();
  const pendingMove = deferred();
  moved.bot.pathfinder.goto = () => pendingMove.promise;
  const moveAbort = new AbortController();
  const move = moved.adapter.execute({ action: 'move_to_block', targetId: target(moveObservation, 'oak_log').id }, { signal: moveAbort.signal });
  moveAbort.abort();
  await assert.rejects(move, { code: 'LLM_AGENT_ACTION_ABORTED' });
  assert.equal(moved.bot.effects.some(([kind]) => kind === 'stopPathfinder'), true);

  const dug = rig();
  dug.bot.setBlock(new Vec3(2, 64, 0), 'oak_log');
  const digObservation = await dug.adapter.observe();
  const pendingDig = deferred();
  dug.bot.dig = () => pendingDig.promise;
  const dig = dug.adapter.execute({ action: 'mine_block', targetId: target(digObservation, 'oak_log').id });
  await new Promise((resolve) => setImmediate(resolve));
  dug.adapter.stop();
  await assert.rejects(dig, { code: 'LLM_AGENT_ACTION_ABORTED' });
  assert.equal(dug.bot.effects.some(([kind]) => kind === 'stopDigging'), true);
});

test('all adapter ports reject a signal that is already aborted', async () => {
  const { adapter } = rig();
  const controller = new AbortController();
  controller.abort();
  const options = { signal: controller.signal };

  await assert.rejects(adapter.isConnected(options), { code: 'LLM_AGENT_ACTION_ABORTED' });
  await assert.rejects(adapter.observe(options), { code: 'LLM_AGENT_ACTION_ABORTED' });
  await assert.rejects(adapter.execute({ action: 'observe' }, options), { code: 'LLM_AGENT_ACTION_ABORTED' });
  await assert.rejects(adapter.verifyAction({ action: 'observe' }, { before: {}, after: {}, receipt: {} }, options), { code: 'LLM_AGENT_ACTION_ABORTED' });
  await assert.rejects(adapter.verifyGoal(goal, options), { code: 'LLM_AGENT_ACTION_ABORTED' });
});

test('observe and finish requests perform no Mineflayer gameplay mutation', async () => {
  const { bot, adapter } = rig();
  await adapter.execute({ action: 'observe' });
  await adapter.execute({ action: 'finish' });
  assert.deepEqual(bot.effects, []);
});

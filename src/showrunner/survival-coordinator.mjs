import { canonicalDimension, recipeSpecification } from './survival-contracts.mjs';
import { survivalReservationKey } from './survival-authority.mjs';
import { planSurvivalStep } from './survival-planner.mjs';

const TRANSIENT_FAILURES = new Set([
  'PATH_INVALIDATED', 'PATH_OBSTRUCTED', 'ITEM_MOVED', 'TARGET_MOVED'
]);
const TARGET_ACTIONS = new Set(['moveNearTarget', 'lookAtTarget', 'digTarget']);
const RECEIPT_ACTIONS = new Set([
  ...TARGET_ACTIONS, 'collectItem', 'craftRecipe', 'placeAtMark', 'equipItem'
]);
const SURVIVAL_ACTIONS = new Set([
  'moveNearTarget', 'lookAtTarget', 'digTarget', 'collectItem',
  'craftRecipe', 'placeAtMark', 'equipItem', 'observeSurvival'
]);

function coded(code, message = code) {
  return Object.assign(new TypeError(message), { code });
}

function string(value) {
  return typeof value === 'string' && value.length > 0;
}

function safeVersion(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function clone(value) {
  return structuredClone(value);
}

function requireIdentity(value) {
  const fields = ['productionId', 'takeId', 'sceneId', 'beatId', 'attemptId', 'cueId'];
  if (!value || fields.some((field) => !string(value[field]))) throw coded('SURVIVAL_IDENTITY_INVALID');
  if (value.causalSequence !== undefined && !safeVersion(value.causalSequence)) throw coded('SURVIVAL_IDENTITY_INVALID');
  return Object.freeze({
    ...Object.fromEntries(fields.map((field) => [field, value[field]])),
    causalSequence: value.causalSequence ?? 0
  });
}

function requireDependencies({ episode, planner, authority, actors, emit, clock, cleanupTimeoutMs = 5_000 }) {
  if (!episode || !Array.isArray(episode.actors) || episode.actors.length !== 2 ||
    !Array.isArray(episode.goals) || episode.goals.length === 0 ||
    (episode.schemaVersion === 2 ? !Array.isArray(episode.beats) : !Array.isArray(episode.dialogueBoundaries))) {
    throw coded('SURVIVAL_EPISODE_REQUIRED');
  }
  if (typeof planner !== 'function' && typeof planner?.plan !== 'function') throw coded('SURVIVAL_PLANNER_REQUIRED');
  for (const method of ['issueTargetReceipt', 'issueItemReceipt', 'issueRecipeReceipt', 'reserve', 'release', 'snapshotReservations']) {
    if (typeof authority?.[method] !== 'function') throw coded('SURVIVAL_AUTHORITY_REQUIRED');
  }
  if (!actors || episode.actors.some((actor) =>
    typeof actors[actor]?.execute !== 'function' || typeof actors[actor]?.cancel !== 'function' ||
    typeof actors[actor]?.awaitQuiescence !== 'function')) throw coded('SURVIVAL_ACTORS_REQUIRED');
  if (typeof emit !== 'function') throw coded('SURVIVAL_EMIT_REQUIRED');
  if (typeof clock?.now !== 'function') throw coded('SURVIVAL_CLOCK_REQUIRED');
  if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > 60_000) {
    throw coded('SURVIVAL_CLEANUP_TIMEOUT_INVALID');
  }
}

function initialState() {
  return {
    status: 'idle',
    identity: null,
    nextGoalIndex: 0,
    groupEndIndex: 0,
    beatIndex: 0,
    beatEndGoalIndex: 0,
    currentBeatId: null,
    activeGoals: [],
    pendingBoundaryGoalIds: [],
    completedGoalIds: [],
    pendingCommands: {},
    decisions: [],
    reservationHistory: [],
    ignoredEvents: [],
    lastError: null,
    causalSequence: 0,
    commandNumber: 0,
    eventNumber: 0,
    decisionNumber: 0,
    outputSequence: 0,
    expectedDialogue: null,
    cleanupVerified: false,
    cancelledAttemptId: null
  };
}

function groupEnd(goals, start) {
  const first = goals[start];
  if (first?.kind !== 'gather') return start + 1;
  const actors = new Set();
  let end = start;
  while (goals[end]?.kind === 'gather' && !actors.has(goals[end].actor)) {
    actors.add(goals[end].actor);
    end += 1;
  }
  return end;
}

function reservationTarget(target, fallbackBlock) {
  const dimension = canonicalDimension(target?.dimension);
  if (!target || !['x', 'y', 'z'].every((axis) => Number.isSafeInteger(target[axis])) || !dimension) {
    throw coded('SURVIVAL_TARGET_UNRESOLVED');
  }
  const block = target.block ?? fallbackBlock;
  if (!string(block)) throw coded('SURVIVAL_TARGET_UNRESOLVED');
  return { x: target.x, y: target.y, z: target.z, dimension, block };
}

function targetInsideRegion(target, region) {
  if (!region || !target || !['x', 'y', 'z'].every((axis) => Number.isSafeInteger(target[axis]) &&
    target[axis] >= region.min[axis] && target[axis] <= region.max[axis])) return false;
  if (!region.allowedBlocks.includes(target.block)) return false;
  return region.allowedCells === undefined || region.allowedCells.some((cell) =>
    ['x', 'y', 'z'].every((axis) => target[axis] === cell[axis]));
}

function observedTargetKey(target) {
  return survivalReservationKey('target', target?.reservationKey
    ? { reservationKey: target.reservationKey }
    : { target: reservationTarget(target, target?.block) });
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizedMark(episode, observation, markId) {
  const mark = episode.marks?.[markId];
  if (!mark?.position) throw coded('SURVIVAL_MARK_UNRESOLVED');
  const dimension = canonicalDimension(mark.dimension ?? observation.dimension ?? 'minecraft:overworld');
  if (!dimension) throw coded('SURVIVAL_MARK_UNRESOLVED');
  return {
    id: markId,
    dimension,
    position: clone(mark.position),
    facing: clone(mark.facing ?? { yaw: 0, pitch: 0 }),
    radius: mark.radius ?? 1,
    dwellTicks: mark.dwellTicks ?? 1,
    safeHeadroom: true
  };
}

function plannerObservation(proof, context) {
  const after = proof.after;
  if (!after || typeof after !== 'object') throw coded('SURVIVAL_OBSERVATION_INVALID');
  const version = proof.observationVersion ?? after.observationVersion ?? after.version;
  if (!safeVersion(version)) throw coded('SURVIVAL_OBSERVATION_INVALID');
  const observed = clone(after);
  observed.version = version;
  observed.replanCount = context.replanCount;
  delete observed.authoritative;
  delete observed.actor;
  delete observed.actorId;
  delete observed.goalId;
  delete observed.observationVersion;
  if (!observed.actors) {
    observed.actors = {
      [context.goal.actor]: {
        inventory: clone(after.inventory ?? {}),
        atMark: after.atMark ?? after.nearMark ?? null,
        equipped: clone(after.equipped ?? after.equipment ?? {})
      }
    };
  }
  observed.targets ??= [];
  observed.drops ??= [];
  observed.placedAtMarks ??= {};
  return observed;
}

export function createSurvivalCoordinator(options = {}) {
  requireDependencies(options);
  const { episode, planner, authority, actors, emit, clock, cleanupTimeoutMs = 5_000 } = options;
  const plan = typeof planner === 'function' ? planner : planner.plan.bind(planner);
  const beatMode = episode.schemaVersion === 2;
  const boundaryGoals = new Set(episode.dialogueBoundaries ?? []);
  let state = initialState();
  let queue = Promise.resolve();
  let outbound = Promise.resolve();
  let outboundFailure = null;
  const seenEventIds = new Set();
  const deadlineTimers = new Map();

  function contextFor(goalId) {
    return state.activeGoals.find((context) => context.goal.id === goalId);
  }

  function reservedByAnotherActor(key, actor) {
    const unprefixed = key.startsWith('explicit:') ? key.slice('explicit:'.length) : key;
    return authority.snapshotReservations().some((reservation) => reservation.actorId !== actor &&
      (reservation.reservationKey === unprefixed || reservation.reservationKey === `explicit:${unprefixed}`));
  }

  function clearGoalDeadline(context) {
    const timer = deadlineTimers.get(context.goal.id);
    if (timer) clearTimeout(timer);
    deadlineTimers.delete(context.goal.id);
  }

  function clearAllDeadlines() {
    for (const context of state.activeGoals) clearGoalDeadline(context);
  }

  function scheduleGoalDeadline(context) {
    const timer = setTimeout(() => {
      void enqueue(async () => {
        const active = contextFor(context.goal.id);
        if (state.status === 'running' && active === context && context.phase !== 'completed') {
          await block('GOAL_DEADLINE_EXCEEDED', context);
        }
      });
    }, context.goal.timeoutMs);
    timer.unref?.();
    deadlineTimers.set(context.goal.id, timer);
  }

  function ignore(reason, event = {}) {
    state.ignoredEvents.push({
      reason,
      kind: string(event.kind) ? event.kind : 'invalid',
      attemptId: string(event.attemptId) ? event.attemptId : null,
      commandId: string(event.payload?.commandId) ? event.payload.commandId : null
    });
  }

  function eventIdentityMatches(event) {
    return ['productionId', 'takeId', 'sceneId', 'beatId', 'attemptId', 'cueId']
      .every((field) => event[field] === state.identity[field]);
  }

  function dialogueFence(event) {
    return {
      eventId: event.eventId,
      causalSequence: event.causalSequence,
      beatId: event.beatId,
      cueId: event.cueId,
      payloadBeatId: event.payload?.beatId
    };
  }

  function dialogueFenceMatches(event) {
    const expected = state.expectedDialogue;
    return expected !== null && Object.entries(expected).every(([field, value]) => {
      if (field === 'payloadBeatId') return event.payload?.beatId === value;
      return event[field] === value;
    });
  }

  function coordinatorEvent(kind, payload) {
    state.outputSequence += 1;
    state.eventNumber += 1;
    return Object.freeze({
      kind,
      ...state.identity,
      eventId: `${state.identity.attemptId}:survival-event:${state.eventNumber}`,
      causalSequence: state.outputSequence,
      monotonicTimestamp: clock.now(),
      payload: Object.freeze(clone(payload))
    });
  }

  function emitVerified(kind, payload) {
    const event = coordinatorEvent(kind, payload);
    const committed = queue;
    outbound = outbound
      .then(() => committed)
      .then(() => emit(event))
      .catch((error) => {
        outboundFailure = error;
        void enqueue(async () => {
          if (!['cancelled', 'cleanup_failed'].includes(state.status)) {
            clearAllDeadlines();
            state.status = 'delivery_failed';
            state.lastError = 'SURVIVAL_EMIT_FAILED';
          }
        });
      });
    return event;
  }

  function makeCommand(context, kind, payload) {
    state.commandNumber += 1;
    state.causalSequence += 1;
    const commandId = `${state.identity.attemptId}:survival-command:${state.commandNumber}`;
    return Object.freeze({
      kind,
      ...state.identity,
      eventId: `${commandId}:event`,
      causalSequence: state.causalSequence,
      monotonicTimestamp: clock.now(),
      commandId,
      idempotencyKey: `${state.identity.takeId}/${state.identity.attemptId}/${context.goal.id}/${kind}/${state.commandNumber}`,
      target: Object.freeze({ port: 'actor', actor: context.goal.actor }),
      payload: Object.freeze(clone(payload))
    });
  }

  function releaseLease(context, reason) {
    const receiptId = context.lease?.receiptId;
    if (!receiptId) return;
    authority.release(receiptId, reason);
    context.lease = null;
  }

  function sinkFor(command, context) {
    let eventSequence = 0;
    return Object.freeze({
      createEvent(kind, payload = {}) {
        eventSequence += 1;
        return Object.freeze({
          kind,
          ...state.identity,
          eventId: `${command.commandId}:${kind}:${eventSequence}`,
          causalSequence: eventSequence,
          monotonicTimestamp: clock.now(),
          payload: Object.freeze(clone(payload))
        });
      },
      emit: (event) => handle(event)
    });
  }

  function deliver(context, kind, payload, type) {
    const remaining = context.deadlineAt - clock.now();
    if (type === 'action' && remaining <= 0) throw coded('GOAL_DEADLINE_EXCEEDED');
    const operationBudgetMs = Math.max(1, Math.floor(Math.min(context.goal.timeoutMs, remaining)));
    const boundedPayload = { ...payload, operationBudgetMs };
    const command = makeCommand(context, kind, boundedPayload);
    const sink = sinkFor(command, context);
    state.pendingCommands[command.commandId] = {
      commandId: command.commandId,
      goalId: context.goal.id,
      actor: context.goal.actor,
      kind,
      type,
      minimumObservationVersion: boundedPayload.observationVersion,
      acknowledged: false,
      completed: false,
      observed: false,
      proof: null,
      nextCausalSequence: 1,
      nextEventKind: 'commandAcknowledged',
      reservationKey: boundedPayload.receipt
        ? survivalReservationKey(boundedPayload.receipt.kind, boundedPayload.receipt.payload)
        : null
    };
    context.commandId = command.commandId;
    try {
      Promise.resolve(actors[context.goal.actor].execute(command, sink)).catch((error) => {
        const reason = string(error?.code) ? error.code : (error?.message ?? 'ACTOR_COMMAND_FAILED');
        void sink.emit(sink.createEvent('commandFailed', { commandId: command.commandId, reason }));
      });
    } catch (error) {
      const reason = string(error?.code) ? error.code : (error?.message ?? 'ACTOR_COMMAND_FAILED');
      void sink.emit(sink.createEvent('commandFailed', { commandId: command.commandId, reason }));
    }
    return command;
  }

  function observe(context) {
    context.phase = 'observing';
    deliver(context, 'observeSurvival', {
      actor: context.goal.actor,
      goalId: context.goal.id,
      observationVersion: context.observationVersion
    }, 'observation');
  }

  function receiptInput(context) {
    return {
      productionId: state.identity.productionId,
      takeId: state.identity.takeId,
      attemptId: state.identity.attemptId,
      goalId: context.goal.id,
      actorId: context.goal.actor,
      observationVersion: context.observation.version
    };
  }

  function authorize(context, action) {
    if (!SURVIVAL_ACTIONS.has(action?.name) || action.name === 'observeSurvival') throw coded('SURVIVAL_ACTION_NOT_ALLOWED');
    let payload = clone(action.payload);
    const observation = context.observation;
    const base = receiptInput(context);
    let receipt;
    if (TARGET_ACTIONS.has(action.name)) {
      if (payload.targetId === undefined) {
        payload.resolvedMark = normalizedMark(episode, observation, payload.mark);
      } else {
        const candidate = observation.targets.find((target) => target.id === payload.targetId);
        const region = episode.regions?.[payload.region];
        if (payload.region !== context.goal.region || candidate?.region !== payload.region || !targetInsideRegion(candidate, region)) {
          throw coded('SURVIVAL_TARGET_OUT_OF_REGION');
        }
        const block = context.goal.block ?? context.goal.item;
        payload = {
          actor: context.goal.actor,
          goalId: context.goal.id,
          targetId: candidate?.id,
          region: context.goal.region,
          block
        };
        const target = reservationTarget(candidate, block);
        const candidates = observation.targets
          .filter((entry) => entry.region === context.goal.region && entry.block === block && targetInsideRegion(entry, region) &&
            !context.failedReservationKeys.includes(observedTargetKey(entry)) &&
            !reservedByAnotherActor(observedTargetKey(entry), context.goal.actor))
          .map((entry) => ({ ...clone(entry), block }));
        receipt = authority.issueTargetReceipt({
          ...base,
          candidates,
          payload: {
            targetId: payload.targetId,
            region: payload.region,
            target,
            ...(candidate.reservationKey ? { reservationKey: candidate.reservationKey } : {}),
            volume: { min: clone(region.min), max: clone(region.max) },
            ...(region.allowedCells ? { allowedCells: clone(region.allowedCells) } : {})
          }
        });
      }
    } else if (action.name === 'collectItem') {
      const drop = observation.drops.find((candidate) => candidate.id === payload.dropId || candidate.dropId === payload.dropId);
      const region = episode.regions?.[context.goal.region];
      const stackCount = drop?.count ?? drop?.stack?.count;
      if (!drop || drop.item !== context.goal.item || drop.region !== context.goal.region || !region ||
        (!safeVersion(drop.entityId) && !string(drop.entityId)) || !string(drop.id ?? drop.dropId) ||
        !Number.isSafeInteger(stackCount) || stackCount < 1 || !drop.position ||
        !canonicalDimension(drop.dimension ?? observation.dimension)) throw coded('SURVIVAL_ITEM_UNRESOLVED');
      payload = {
        actor: context.goal.actor, goalId: context.goal.id,
        dropId: drop.id ?? drop.dropId, item: context.goal.item, region: context.goal.region
      };
      receipt = authority.issueItemReceipt({
        ...base,
        payload: {
          entityId: drop.entityId,
          dropId: payload.dropId,
          item: context.goal.item,
          region: context.goal.region,
          dimension: canonicalDimension(drop.dimension ?? observation.dimension),
          position: clone(drop.position),
          volume: { min: clone(region.min), max: clone(region.max) },
          stack: { item: context.goal.item, count: stackCount },
          ...(drop.reservationKey ? { reservationKey: drop.reservationKey } : {})
        }
      });
    } else if (action.name === 'craftRecipe') {
      const markId = context.goal.mark;
      const mark = normalizedMark(episode, observation, markId);
      const specification = recipeSpecification(payload.recipe);
      if (!specification) throw coded('SURVIVAL_RECIPE_UNRESOLVED');
      payload = {
        actor: context.goal.actor, goalId: context.goal.id,
        recipe: payload.recipe, count: payload.count, mark: markId
      };
      const tableMark = observation.placedAtMarks[markId] === 'crafting_table'
        ? mark
        : null;
      receipt = authority.issueRecipeReceipt({
        ...base,
        payload: {
          recipe: payload.recipe,
          count: payload.count,
          mark,
          inputs: clone(specification.inputs),
          output: clone(specification.output),
          ...(tableMark ? { table: { ...clone(tableMark.position), dimension: tableMark.dimension, block: 'crafting_table' } } : {})
        }
      });
    } else if (action.name === 'placeAtMark') {
      const markId = context.goal.mark;
      const mark = normalizedMark(episode, observation, markId);
      payload = {
        actor: context.goal.actor, goalId: context.goal.id,
        item: action.payload.item, mark: markId
      };
      payload.resolvedMark = mark;
      receipt = authority.issueTargetReceipt({
        ...base,
        payload: {
          target: { ...mark.position, dimension: mark.dimension, block: observation.placedAtMarks[payload.mark] ?? 'air' },
          mark: markId,
          item: payload.item
        }
      });
    } else if (action.name === 'equipItem') {
      payload = {
        actor: context.goal.actor, goalId: context.goal.id,
        item: context.goal.item, destination: context.goal.destination
      };
      const inventoryCount = observation.actors?.[context.goal.actor]?.inventory?.[context.goal.item];
      if (!Number.isSafeInteger(inventoryCount) || inventoryCount < 1) throw coded('SURVIVAL_ITEM_UNRESOLVED');
      receipt = authority.issueItemReceipt({
        ...base,
        payload: {
          item: payload.item,
          destination: payload.destination,
          stack: { item: payload.item, count: inventoryCount },
          reservationKey: `equipment:${context.goal.actor}:${payload.destination}`
        }
      });
    }
    if (RECEIPT_ACTIONS.has(action.name) && !receipt && !(action.name === 'moveNearTarget' && payload.targetId === undefined)) {
      throw coded('SURVIVAL_RECEIPT_REQUIRED');
    }
    if (receipt) {
      if (receipt.kind === 'target' && payload.targetId !== undefined && receipt.payload.target?.id !== payload.targetId) {
        throw coded('SURVIVAL_TARGET_SELECTION_MISMATCH');
      }
      const reserved = authority.reserve(receipt, context.goal.actor);
      if (reserved?.ok !== true) throw coded(reserved?.code ?? 'SURVIVAL_RESERVATION_FAILED');
      context.lease = reserved.reservation;
      state.reservationHistory.push(clone(reserved.reservation));
      payload.receipt = receipt;
    }
    payload.actor = context.goal.actor;
    payload.goalId = context.goal.id;
    payload.observationVersion = context.observation.version;
    return { name: action.name, payload, receipt };
  }

  function verifiedCleanup(actor, attemptId, cancellation, quiescence) {
    return cancellation?.authoritative === true && cancellation.acknowledged === true &&
      cancellation.cancelled === true && cancellation.actor === actor &&
      cancellation.targetAttemptId === attemptId && quiescence?.authoritative === true &&
      quiescence.acknowledged === true && quiescence.quiescent === true && quiescence.actor === actor;
  }

  async function cleanupActors(attemptId) {
    const cleanup = Promise.allSettled(episode.actors.map(async (actor) => {
      let cancellation;
      let cancellationFailure;
      try {
        cancellation = await actors[actor].cancel(attemptId);
      } catch (error) {
        cancellationFailure = error;
      }
      let quiescence;
      let quiescenceFailure;
      try {
        quiescence = await actors[actor].awaitQuiescence();
      } catch (error) {
        quiescenceFailure = error;
      }
      if (cancellationFailure || quiescenceFailure) {
        throw cancellationFailure ?? quiescenceFailure;
      }
      if (!verifiedCleanup(actor, attemptId, cancellation, quiescence)) throw coded('SURVIVAL_QUIESCENCE_INVALID');
      return { actor, cancellation, quiescence };
    }));
    let timeout;
    const bounded = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(coded('SURVIVAL_CLEANUP_TIMEOUT')), cleanupTimeoutMs);
      timeout.unref?.();
    });
    let results;
    try {
      results = await Promise.race([cleanup, bounded]);
    } catch (error) {
      state.status = 'cleanup_failed';
      state.lastError = error?.code === 'SURVIVAL_CLEANUP_TIMEOUT' ? error.code : 'SURVIVAL_CLEANUP_FAILED';
      state.cleanupFailures = episode.actors.map((actor) => ({ actor, reason: state.lastError }));
      throw coded(state.lastError);
    } finally {
      clearTimeout(timeout);
    }
    const failures = results.flatMap((result, index) => result.status === 'fulfilled' ? [] : [{
      actor: episode.actors[index],
      reason: result.reason?.code ?? result.reason?.message ?? 'SURVIVAL_CLEANUP_FAILED'
    }]);
    if (failures.length > 0) {
      state.status = 'cleanup_failed';
      state.lastError = 'SURVIVAL_CLEANUP_FAILED';
      state.cleanupFailures = failures;
      throw coded('SURVIVAL_CLEANUP_FAILED');
    }
  }

  async function block(reason, context) {
    if (state.status !== 'running') return;
    clearAllDeadlines();
    for (const active of state.activeGoals) releaseLease(active, 'goal-blocked');
    state.pendingCommands = {};
    state.status = 'blocking_cleanup';
    state.lastError = reason;
    await cleanupActors(state.identity.attemptId);
    state.cleanupVerified = true;
    state.status = 'blocked';
    await emitVerified(beatMode ? 'beatBlocked' : 'goalBlocked', {
      ...(beatMode ? { beatId: state.currentBeatId } : {}),
      goalId: context.goal.id,
      actor: context.goal.actor,
      observationVersion: context.observationVersion,
      reason,
      proof: { authoritative: true, terminal: true }
    });
  }

  async function completeContext(context, decision) {
    if (decision.observationVersion !== context.observation?.version || decision.observationVersion <= context.minimumCompletionVersion) {
      await block('SURVIVAL_COMPLETION_NOT_PROVED', context);
      return;
    }
    clearGoalDeadline(context);
    context.phase = 'completed';
    context.commandId = null;
    if (!state.completedGoalIds.includes(context.goal.id)) state.completedGoalIds.push(context.goal.id);
    await emitVerified('goalCompleted', {
      goalId: context.goal.id,
      actor: context.goal.actor,
      observationVersion: decision.observationVersion,
      proof: {
        authoritative: true,
        completionSatisfied: true,
        reason: decision.reason
      }
    });
  }

  async function advanceGroupIfComplete() {
    if (state.activeGoals.length === 0 || state.activeGoals.some((context) => context.phase !== 'completed')) return;
    if (beatMode) {
      await finishGroup();
      return;
    }
    const boundaryContexts = state.activeGoals.filter((context) => boundaryGoals.has(context.goal.id));
    const pendingBoundaries = boundaryContexts.map((context) => context.goal.id);
    // Buffer later parallel goals before the current cue. Emitting the current
    // goal last may start dialogue and allocate new fence sequence numbers.
    for (const context of [...boundaryContexts].reverse()) {
      await emitVerified('safeDialogueBoundary', {
        goalId: context.goal.id,
        actor: context.goal.actor,
        observationVersion: context.observationVersion,
        proof: { authoritative: true, interruptible: true, criticalSections: 0 }
      });
    }
    if (pendingBoundaries.length > 0) {
      state.pendingBoundaryGoalIds = pendingBoundaries;
      state.status = 'awaiting_dialogue';
      return;
    }
    await finishGroup();
  }

  async function finishBeat() {
    const beat = episode.beats[state.beatIndex];
    state.activeGoals = [];
    state.currentBeatId = null;
    await emitVerified('beatCompleted', {
      beatId: beat.id,
      goalIds: clone(beat.goalIds),
      proof: { authoritative: true, completed: true, criticalSections: 0 }
    });
    state.beatIndex += 1;
    state.status = state.beatIndex >= episode.beats.length ? 'completed' : 'awaiting_dialogue';
    const nextBeat = episode.beats[state.beatIndex];
    if (nextBeat) {
      state.identity = Object.freeze({ ...state.identity, beatId: nextBeat.id, cueId: nextBeat.id });
    }
  }

  async function finishGroup() {
    state.nextGoalIndex = state.groupEndIndex;
    state.activeGoals = [];
    state.pendingBoundaryGoalIds = [];
    if (beatMode && state.nextGoalIndex >= state.beatEndGoalIndex) {
      await finishBeat();
      return;
    }
    if (state.nextGoalIndex >= episode.goals.length) {
      state.status = 'completed';
      return;
    }
    state.status = 'running';
    startGroup();
  }

  async function planReadyGroup() {
    if (state.status !== 'running' || state.activeGoals.some((context) => !['ready', 'completed'].includes(context.phase))) return;
    for (const context of state.activeGoals) {
      if (context.phase === 'completed') continue;
      if (clock.now() >= context.deadlineAt) {
        await block('GOAL_DEADLINE_EXCEEDED', context);
        return;
      }
      let decision;
      try {
        decision = plan({
          goal: context.goal,
          observation: { ...clone(context.observation), replanCount: context.replanCount },
          reservations: authority.snapshotReservations()
        });
        if (!safeVersion(decision?.observationVersion) || decision.observationVersion !== context.observation.version) {
          throw coded('SURVIVAL_DECISION_OBSERVATION_MISMATCH');
        }
        if (decision?.status === 'action' && !SURVIVAL_ACTIONS.has(decision.action?.name)) {
          throw coded('SURVIVAL_ACTION_NOT_ALLOWED');
        }
        if (context.replanCount >= context.goal.maxReplans && decision?.status === 'action') {
          decision = {
            status: 'blocked',
            reason: 'REPLAN_BUDGET_EXHAUSTED',
            observationVersion: context.observation.version
          };
        }
        const trustedDecision = planSurvivalStep({
          goal: context.goal,
          observation: { ...clone(context.observation), replanCount: context.replanCount },
          reservations: authority.snapshotReservations()
        });
        if (decision?.status === 'action' && (trustedDecision.status !== 'action' || !jsonEqual(decision.action, trustedDecision.action))) {
          throw coded('SURVIVAL_ACTION_GOAL_MISMATCH');
        }
        if (decision?.status === 'completed' && trustedDecision.status !== 'completed') {
          throw coded('SURVIVAL_COMPLETION_NOT_PROVED');
        }
      } catch (error) {
        await block(error?.code ?? 'PLANNER_FAILED', context);
        return;
      }
      state.decisionNumber += 1;
      state.causalSequence += 1;
      const recorded = {
        ...state.identity,
        eventId: `${state.identity.attemptId}:planner-decision:${state.decisionNumber}`,
        causalSequence: state.causalSequence,
        monotonicTimestamp: clock.now(),
        goalId: context.goal.id,
        actor: context.goal.actor,
        replanCount: context.replanCount,
        reservations: clone(authority.snapshotReservations()),
        decision: clone(decision),
        ...clone(decision)
      };
      state.decisions.push(recorded);
      if (decision.status === 'completed') {
        await completeContext(context, decision);
        continue;
      }
      if (decision.status === 'blocked') {
        await block(decision.reason, context);
        return;
      }
      try {
        context.authorizedAction = authorize(context, decision.action);
        if (context.lease) recorded.reservationKey = context.lease.reservationKey;
        context.phase = 'reserved';
      } catch (error) {
        await block(error?.code ?? 'SURVIVAL_AUTHORIZATION_FAILED', context);
        return;
      }
    }
    if (state.status !== 'running') return;
    for (const context of state.activeGoals) {
      if (context.phase !== 'reserved') continue;
      if (clock.now() >= context.deadlineAt) {
        await block('GOAL_DEADLINE_EXCEEDED', context);
        return;
      }
      const action = context.authorizedAction;
      // The coordinator owns selection and reservation. Release immediately
      // before dispatch so the actor runtime can atomically acquire the same
      // signed receipt for the duration of the Mineflayer operation.
      releaseLease(context, 'dispatch-transfer');
      context.phase = 'acting';
      try {
        deliver(context, action.name, action.payload, 'action');
      } catch (error) {
        if (error?.code !== 'GOAL_DEADLINE_EXCEEDED') throw error;
        await block(error.code, context);
        return;
      }
    }
    await advanceGroupIfComplete();
  }

  async function finishPending(pending) {
    delete state.pendingCommands[pending.commandId];
    const context = contextFor(pending.goalId);
    if (!context || context.commandId !== pending.commandId) {
      ignore('STALE_COMMAND', { kind: 'observationVerified', payload: { commandId: pending.commandId } });
      return;
    }
    context.commandId = null;
    const proof = pending.proof;
    if (pending.type === 'observation') {
      context.observation = plannerObservation(proof, context);
      const region = episode.regions?.[context.goal.region];
      if (region) {
        context.observation.targets = context.observation.targets.filter((target) =>
          (target.region !== context.goal.region || targetInsideRegion(target, region)) &&
          !context.failedReservationKeys.includes(observedTargetKey(target)));
      }
      context.observationVersion = context.observation.version;
      context.phase = 'ready';
      await planReadyGroup();
      return;
    }
    releaseLease(context, 'action-verified');
    context.observationVersion = proof.observationVersion;
    if (clock.now() >= context.deadlineAt) {
      await block('GOAL_DEADLINE_EXCEEDED', context);
      return;
    }
    observe(context);
  }

  function verifyProof(pending, proof) {
    if (proof?.authoritative !== true || proof.kind !== pending.kind ||
      proof.actor !== pending.actor || proof.goalId !== pending.goalId ||
      !safeVersion(proof.observationVersion)) return { ok: false, reason: 'PROOF_INVALID' };
    if (proof.observationVersion <= pending.minimumObservationVersion) return { ok: false, reason: 'PROOF_STALE' };
    if (pending.type === 'observation' && (proof.after?.authoritative !== true ||
      proof.after.actor !== pending.actor || proof.after.goalId !== pending.goalId ||
      proof.after.observationVersion !== proof.observationVersion)) {
      return { ok: false, reason: 'PROOF_INVALID' };
    }
    return { ok: true };
  }

  async function processEvent(event) {
    if (event?.kind === 'flush') return;
    if (outboundFailure || state.status === 'delivery_failed') {
      ignore('DELIVERY_FAILED', event);
      return;
    }
    if (!state.identity) {
      ignore('NO_ACTIVE_ATTEMPT', event);
      return;
    }
    if (state.status === 'cancelled' || event.attemptId !== state.identity.attemptId) {
      ignore('STALE_ATTEMPT', event);
      return;
    }
    if (!eventIdentityMatches(event)) {
      ignore('WRONG_IDENTITY', event);
      return;
    }
    if (event.kind === 'dialogueCompleted') {
      if (beatMode) {
        const beat = episode.beats[state.beatIndex];
        if (state.status !== 'awaiting_dialogue' || event.payload?.beatId !== beat?.id) {
          ignore('BEAT_NOT_CURRENT', event);
          return;
        }
        if (!Number.isSafeInteger(event.causalSequence) || event.causalSequence <= 0) {
          ignore('CAUSAL_SEQUENCE_INVALID', event);
          return;
        }
        if (!dialogueFenceMatches(event)) {
          ignore('DIALOGUE_FENCE_MISMATCH', event);
          return;
        }
        state.expectedDialogue = null;
        if (event.payload?.proof?.authoritative !== true || event.payload.proof.dialogueCompleted !== true) {
          ignore('DIALOGUE_COMPLETION_PROOF_INVALID', event);
          return;
        }
        state.outputSequence = event.causalSequence;
        state.causalSequence = 0;
        state.currentBeatId = beat.id;
        state.beatEndGoalIndex = state.nextGoalIndex + beat.goalIds.length;
        if (beat.goalIds.length === 0) {
          await finishBeat();
          return;
        }
        state.status = 'running';
        startGroup();
        return;
      }
      if (state.status !== 'awaiting_dialogue' || !state.pendingBoundaryGoalIds.includes(event.payload?.goalId)) {
        ignore('BOUNDARY_NOT_PENDING', event);
        return;
      }
      if (event.payload?.proof?.authoritative !== true || event.payload.proof.dialogueCompleted !== true) {
        ignore('DIALOGUE_COMPLETION_PROOF_INVALID', event);
        return;
      }
      let nextIdentity;
      try {
        nextIdentity = requireIdentity(event.payload.nextIdentity);
      } catch {
        ignore('NEXT_IDENTITY_INVALID', event);
        return;
      }
      if (['productionId', 'takeId', 'sceneId', 'attemptId'].some((field) => nextIdentity[field] !== state.identity[field])) {
        ignore('NEXT_IDENTITY_MISMATCH', event);
        return;
      }
      state.pendingBoundaryGoalIds = state.pendingBoundaryGoalIds.filter((goalId) => goalId !== event.payload.goalId);
      const { causalSequence, ...identityFields } = nextIdentity;
      state.identity = Object.freeze(identityFields);
      state.outputSequence = causalSequence;
      state.causalSequence = 0;
      if (state.pendingBoundaryGoalIds.length === 0) await finishGroup();
      return;
    }
    const pending = state.pendingCommands[event.payload?.commandId];
    if (!pending) {
      ignore('UNKNOWN_COMMAND', event);
      return;
    }
    if (!string(event.eventId)) {
      ignore('EVENT_ID_INVALID', event);
      return;
    }
    if (seenEventIds.has(event.eventId)) {
      ignore('DUPLICATE_EVENT', event);
      return;
    }
    if (!Number.isSafeInteger(event.causalSequence) || event.causalSequence !== pending.nextCausalSequence) {
      ignore('CAUSAL_SEQUENCE_INVALID', event);
      return;
    }
    if (event.kind !== 'commandFailed' && event.kind !== pending.nextEventKind) {
      ignore('EVENT_ORDER_INVALID', event);
      return;
    }
    seenEventIds.add(event.eventId);
    pending.nextCausalSequence += 1;
    if (event.kind === 'commandFailed') {
      delete state.pendingCommands[pending.commandId];
      const context = contextFor(pending.goalId);
      if (!context) {
        ignore('STALE_COMMAND', event);
        return;
      }
      context.commandId = null;
      releaseLease(context, 'command-failed');
      const reason = event.payload.reason ?? 'ACTOR_COMMAND_FAILED';
      if (pending.type === 'action' && TRANSIENT_FAILURES.has(reason)) {
        if (pending.reservationKey && !context.failedReservationKeys.includes(pending.reservationKey)) {
          context.failedReservationKeys.push(pending.reservationKey);
        }
        context.replanCount += 1;
        if (clock.now() >= context.deadlineAt) {
          await block('GOAL_DEADLINE_EXCEEDED', context);
          return;
        }
        observe(context);
      } else {
        await block(reason, context);
      }
      return;
    }
    const barrierField = {
      commandAcknowledged: 'acknowledged',
      commandCompleted: 'completed',
      observationVerified: 'observed'
    }[event.kind];
    if (!barrierField) {
      ignore('UNEXPECTED_EVENT', event);
      return;
    }
    if (barrierField === 'observed') {
      const verification = verifyProof(pending, event.payload.proof);
      if (!verification.ok) {
        ignore(verification.reason, event);
        return;
      }
      pending.proof = clone(event.payload.proof);
    }
    pending[barrierField] = true;
    pending.nextEventKind = barrierField === 'acknowledged'
      ? 'commandCompleted'
      : barrierField === 'completed'
        ? 'observationVerified'
        : null;
    if (pending.acknowledged && pending.completed && pending.observed) await finishPending(pending);
  }

  function startGroup() {
    state.groupEndIndex = Math.min(
      groupEnd(episode.goals, state.nextGoalIndex),
      beatMode ? state.beatEndGoalIndex : episode.goals.length
    );
    state.activeGoals = episode.goals.slice(state.nextGoalIndex, state.groupEndIndex).map((goal) => ({
      goal,
      phase: 'observing',
      replanCount: 0,
      observationVersion: 0,
      observation: null,
      commandId: null,
      authorizedAction: null,
      lease: null,
      activatedAt: clock.now(),
      deadlineAt: 0,
      minimumCompletionVersion: 0,
      failedReservationKeys: []
    }));
    for (const context of state.activeGoals) {
      context.deadlineAt = context.activatedAt + context.goal.timeoutMs;
      scheduleGoalDeadline(context);
      observe(context);
    }
  }

  function enqueue(operation) {
    const work = queue.then(operation);
    queue = work.then(() => undefined, () => undefined);
    return work;
  }

  function start(identity) {
    return enqueue(async () => {
      if (state.status !== 'idle') throw coded('SURVIVAL_ALREADY_STARTED');
      const validated = requireIdentity(identity);
      const { causalSequence, ...identityFields } = validated;
      if (beatMode && (identityFields.beatId !== episode.beats[0].id || identityFields.cueId !== episode.beats[0].id)) {
        throw coded('SURVIVAL_BEAT_IDENTITY_MISMATCH');
      }
      state.identity = Object.freeze(identityFields);
      state.outputSequence = causalSequence;
      state.status = beatMode ? 'awaiting_dialogue' : 'running';
      if (!beatMode) startGroup();
    });
  }

  function rebind(request) {
    return enqueue(async () => {
      if (!['blocked', 'cancelled'].includes(state.status) || state.cleanupVerified !== true ||
        Object.keys(state.pendingCommands).length !== 0 || authority.snapshotReservations().length !== 0) {
        throw coded('SURVIVAL_REBIND_NOT_READY');
      }
      const supplied = clone(request);
      const previousAttemptId = state.identity?.attemptId ?? state.cancelledAttemptId;
      if (supplied?.previousAttemptId !== previousAttemptId ||
        supplied?.proof?.authoritative !== true || supplied.proof.cleanupVerified !== true ||
        supplied.proof.resetVerified !== true) throw coded('SURVIVAL_REBIND_PROOF_INVALID');
      const validated = requireIdentity(supplied.nextIdentity);
      const { causalSequence, ...identityFields } = validated;
      if (identityFields.attemptId === previousAttemptId ||
        (state.identity && ['productionId', 'takeId', 'sceneId'].some((field) => identityFields[field] !== state.identity[field])) ||
        (beatMode && (identityFields.beatId !== episode.beats[0].id || identityFields.cueId !== episode.beats[0].id))) {
        throw coded('SURVIVAL_REBIND_IDENTITY_INVALID');
      }
      state = initialState();
      seenEventIds.clear();
      state.identity = Object.freeze(identityFields);
      state.outputSequence = causalSequence;
      state.status = beatMode ? 'awaiting_dialogue' : 'running';
      if (!beatMode) startGroup();
    });
  }

  function handle(event) {
    return enqueue(() => processEvent(clone(event)));
  }

  function expectDialogue(event) {
    return enqueue(async () => {
      const supplied = clone(event);
      if (!beatMode || supplied?.kind !== 'dialogueCompleted' || !eventIdentityMatches(supplied) ||
        state.status !== 'awaiting_dialogue' || supplied.payload?.beatId !== episode.beats[state.beatIndex]?.id ||
        !Number.isSafeInteger(supplied.causalSequence) || supplied.causalSequence <= 0) {
        throw coded('DIALOGUE_FENCE_INVALID');
      }
      state.expectedDialogue = dialogueFence(supplied);
    });
  }

  function cancel(attemptId) {
    return enqueue(async () => {
      if (!state.identity && state.status === 'idle') {
        if (!string(attemptId)) throw coded('ATTEMPT_MISMATCH');
        state.cancelledAttemptId = attemptId;
        state.cleanupVerified = true;
        state.status = 'cancelled';
        return;
      }
      if (!state.identity || attemptId !== state.identity.attemptId) throw coded('ATTEMPT_MISMATCH');
      if (state.status === 'cancelled' && state.cleanupVerified) return;
      clearAllDeadlines();
      for (const context of state.activeGoals) {
        releaseLease(context, 'cancelled');
        context.phase = 'cancelled';
        context.commandId = null;
      }
      state.pendingCommands = {};
      state.status = 'cancelling';
      await cleanupActors(attemptId);
      state.cleanupVerified = true;
      state.status = 'cancelled';
    });
  }

  return Object.freeze({
    start,
    rebind,
    expectDialogue,
    handle,
    cancel,
    flush: async () => {
      for (;;) {
        const queued = queue;
        await queued;
        const outgoing = outbound;
        await outgoing;
        if (queued === queue && outgoing === outbound) break;
      }
      if (outboundFailure) throw coded('SURVIVAL_EMIT_FAILED', outboundFailure.message);
    },
    snapshot: () => clone(state)
  });
}

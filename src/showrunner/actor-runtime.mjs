import { createPublicKey, randomUUID } from 'node:crypto';

import pathfinderModule from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';

import { IdempotencyLedger } from './protocol.mjs';
import { verifyLineAuthorization } from './approved-bank.mjs';
import {
  canonicalDimension,
  isEquipmentDestination,
  recipeSpecification
} from './survival-contracts.mjs';

const { GoalNear } = pathfinderModule.goals;
const ACTIONS = new Set(['moveToMark', 'lookAt', 'speak', 'observe', 'cancel']);
const SURVIVAL_ACTIONS = new Set([
  'moveNearTarget', 'lookAtTarget', 'digTarget', 'collectItem',
  'craftRecipe', 'placeAtMark', 'equipItem', 'observeSurvival'
]);
const CONTROL_STATES = Object.freeze(['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']);
const TICK_MS = 50;
const SHA256_HEX = /^[a-f0-9]{64}$/iu;

function coded(code, message = code, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function string(value) { return typeof value === 'string' && value.length > 0; }
function point(value) { return value && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z); }
function safeNonnegativeInteger(value) { return Number.isSafeInteger(value) && value >= 0; }

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function cloneFrozen(value, code = 'VALIDATED_VALUE_INVALID') {
  try {
    return deepFreeze(structuredClone(value));
  } catch {
    throw coded(code);
  }
}

function cloneJsonValue(value, ancestors = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || ancestors.has(value)) throw coded('SURVIVAL_OBSERVATION_INVALID');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw coded('SURVIVAL_OBSERVATION_INVALID');
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const result = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw coded('SURVIVAL_OBSERVATION_INVALID');
        result.push(cloneJsonValue(descriptor.value, ancestors));
      }
      if (Reflect.ownKeys(value).some((key) => key !== 'length' && (typeof key !== 'string' || !/^\d+$/u.test(key) || Number(key) >= value.length))) {
        throw coded('SURVIVAL_OBSERVATION_INVALID');
      }
      return result;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw coded('SURVIVAL_OBSERVATION_INVALID');
    const result = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw coded('SURVIVAL_OBSERVATION_INVALID');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw coded('SURVIVAL_OBSERVATION_INVALID');
      result[key] = cloneJsonValue(descriptor.value, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function cloneJsonFrozen(value) {
  return deepFreeze(cloneJsonValue(value));
}

function assertFenced(command) {
  if (command === null || typeof command !== 'object') throw coded('COMMAND_INVALID');
  for (const field of ['productionId', 'takeId', 'sceneId', 'beatId', 'attemptId', 'cueId', 'eventId', 'commandId', 'idempotencyKey']) {
    if (!string(command[field])) throw coded('COMMAND_INVALID');
  }
  if (!Number.isSafeInteger(command.causalSequence) || command.causalSequence <= 0 || !Number.isFinite(command.monotonicTimestamp)) throw coded('COMMAND_INVALID');
}

function safeSpeech(text) {
  return string(text) && text.length <= 256 && !text.startsWith('/') && !/[\p{Cc}\p{Cs}]/u.test(text);
}

function cloneValidatedMark(value) {
  try {
    const mark = structuredClone(value);
    const dimension = canonicalDimension(mark?.dimension);
    if (!mark || !point(mark.position) || !mark.facing || !Number.isFinite(mark.facing.yaw) || !Number.isFinite(mark.facing.pitch) ||
      !dimension || !Number.isFinite(mark.radius) || mark.radius <= 0 ||
      !Number.isInteger(mark.dwellTicks) || mark.dwellTicks < 1 || mark.safeHeadroom !== true) throw coded('VALIDATED_VALUE_INVALID');
    return Object.freeze({
      ...mark,
      dimension,
      position: Object.freeze({ ...mark.position }),
      facing: Object.freeze({ ...mark.facing })
    });
  } catch (error) {
    if (error?.code) throw error;
    throw coded('VALIDATED_VALUE_INVALID');
  }
}

function cloneValidatedPoint(value) {
  try {
    const target = structuredClone(value?.position ?? value);
    if (!point(target)) throw coded('VALIDATED_VALUE_INVALID');
    return Object.freeze({ ...target });
  } catch (error) {
    if (error?.code) throw error;
    throw coded('VALIDATED_VALUE_INVALID');
  }
}

function requireVerifier(verifier, name) {
  if (typeof verifier?.[name] !== 'function') throw coded('TRUSTED_VERIFIER_REQUIRED');
  return verifier[name];
}

function verifierPayload(payload) {
  try {
    return structuredClone(payload);
  } catch {
    throw coded('COMMAND_PAYLOAD_INVALID');
  }
}

function approvalKey(value) {
  try {
    const key = value?.type === 'public' ? value : createPublicKey(typeof value === 'string' ? value.replaceAll('\\n', '\n') : value);
    return key.asymmetricKeyType === 'ed25519' ? key : undefined;
  } catch {
    return undefined;
  }
}

function validateCommand(command, verifier, authorization, activeAttemptId, revokedAttempts, actorId, survivalAuthority) {
  const action = command.kind;
  if (!ACTIONS.has(action) && !SURVIVAL_ACTIONS.has(action)) throw coded('ACTION_NOT_ALLOWED');
  const payload = command.payload;
  if (!payload || typeof payload !== 'object') throw coded('COMMAND_PAYLOAD_INVALID');
  if (action === 'cancel') {
    const targetAttemptId = payload.targetAttemptId;
    if (!string(targetAttemptId) || (targetAttemptId !== activeAttemptId && !revokedAttempts.has(targetAttemptId))) {
      throw coded('ATTEMPT_MISMATCH');
    }
    return Object.freeze({ action, targetAttemptId });
  }
  if (revokedAttempts.has(command.attemptId)) throw coded('ATTEMPT_REVOKED');
  if (activeAttemptId !== null && command.attemptId !== activeAttemptId) throw coded('ATTEMPT_MISMATCH');
  if (action === 'speak') {
    const text = `${payload.text ?? payload.line ?? ''}`;
    const verified = verifyLineAuthorization(payload.authorization, {
      publicKey: authorization.publicKey,
      episodeContentHash: authorization.episodeContentHash,
      cueId: command.cueId,
      authoredLineId: payload.authoredLineId,
      speaker: actorId,
      text
    });
    if (verified.ok !== true) throw coded(verified.code);
    if (!safeSpeech(text)) throw coded('UNSAFE_SPEECH');
    return Object.freeze({ action, text });
  }
  if (action === 'moveToMark') {
    const mark = cloneValidatedMark(requireVerifier(verifier, 'verifyMark')(action, verifierPayload(payload)));
    return Object.freeze({ action, mark });
  }
  if (action === 'lookAt') {
    const target = cloneValidatedPoint(requireVerifier(verifier, 'verifyMark')(action, verifierPayload(payload)));
    return Object.freeze({ action, target });
  }
  if (SURVIVAL_ACTIONS.has(action)) {
    return validateSurvivalCommand(action, command, payload, verifier, survivalAuthority, actorId);
  }
  return Object.freeze({ action });
}

function rawCoordinates(payload) {
  return ['x', 'y', 'z', 'position', 'target', 'coordinates'].some((key) => Object.hasOwn(payload, key));
}

function requireSurvivalIdentity(payload, actorId) {
  if (!string(payload.actor) || payload.actor !== actorId) throw coded('SURVIVAL_ACTOR_MISMATCH');
  if (!string(payload.goalId) || !safeNonnegativeInteger(payload.observationVersion)) throw coded('SURVIVAL_COMMAND_INVALID');
}

function verifySurvivalReceipt(action, command, payload, authority, kind, actorId) {
  if (!authority || typeof authority.verifyReceipt !== 'function') throw coded('SURVIVAL_AUTHORITY_REQUIRED');
  if (!payload.receipt || typeof payload.receipt !== 'object') throw coded('SURVIVAL_RECEIPT_REQUIRED');
  const expected = {
    kind,
    productionId: command.productionId,
    takeId: command.takeId,
    attemptId: command.attemptId,
    goalId: payload.goalId,
    actorId,
    observationVersion: payload.observationVersion
  };
  if (kind === 'target' && string(payload.block)) expected.block = payload.block;
  const result = authority.verifyReceipt(payload.receipt, expected);
  if (result?.ok !== true) throw coded(result?.code ?? 'SURVIVAL_RECEIPT_INVALID');
  return cloneFrozen(result.receipt, 'SURVIVAL_RECEIPT_INVALID');
}

function exactOptional(receiptPayload, supplied, field, code = 'SURVIVAL_RECEIPT_MISMATCH') {
  if (supplied !== undefined && receiptPayload?.[field] !== undefined && receiptPayload[field] !== supplied) throw coded(code);
}

function exactRequired(receiptPayload, supplied, field) {
  if (supplied === undefined || receiptPayload?.[field] !== supplied) throw coded('SURVIVAL_RECEIPT_MISMATCH');
}

function insideVolume(target, volume) {
  if (volume === undefined) return true;
  if (!volume || !point(volume.min) || !point(volume.max)) return false;
  return ['x', 'y', 'z'].every((axis) => Number.isSafeInteger(volume.min[axis]) && Number.isSafeInteger(volume.max[axis]) &&
    volume.min[axis] <= volume.max[axis] && target[axis] >= volume.min[axis] && target[axis] <= volume.max[axis]);
}

function insideAllowedCells(target, allowedCells) {
  if (allowedCells === undefined) return true;
  return Array.isArray(allowedCells) && allowedCells.some((cell) => point(cell) &&
    ['x', 'y', 'z'].every((axis) => Number.isSafeInteger(cell[axis]) && target[axis] === cell[axis]));
}

function validatedSurvivalMark(action, payload, verifier) {
  const supplied = payload.resolvedMark ?? payload.mark;
  if (!supplied || (typeof supplied !== 'object' && !string(supplied))) throw coded('SURVIVAL_MARK_REQUIRED');
  return cloneValidatedMark(requireVerifier(verifier, 'verifyMark')(action, verifierPayload({ ...payload, mark: supplied })));
}

function validateSurvivalCommand(action, command, payload, verifier, authority, actorId) {
  requireSurvivalIdentity(payload, actorId);
  if (rawCoordinates(payload)) throw coded('RAW_COORDINATES_NOT_ALLOWED');
  if (action === 'observeSurvival') return Object.freeze({ action, actor: actorId, goalId: payload.goalId, observationVersion: payload.observationVersion });

  let receipt;
  let mark;
  if (action === 'moveNearTarget' && payload.mark !== undefined && payload.targetId === undefined) {
    mark = validatedSurvivalMark(action, payload, verifier);
  } else if (action === 'moveNearTarget' || action === 'lookAtTarget' || action === 'digTarget' || action === 'placeAtMark') {
    receipt = verifySurvivalReceipt(action, command, payload, authority, 'target', actorId);
  } else if (action === 'collectItem' || action === 'equipItem') {
    receipt = verifySurvivalReceipt(action, command, payload, authority, 'item', actorId);
  } else if (action === 'craftRecipe') {
    receipt = verifySurvivalReceipt(action, command, payload, authority, 'recipe', actorId);
  }

  const receiptPayload = receipt?.payload;
  if (receipt?.kind === 'target') {
    exactOptional(receiptPayload, payload.targetId, 'targetId');
    exactOptional(receiptPayload, payload.region, 'region');
    exactOptional(receiptPayload, payload.mark, 'mark');
    exactOptional(receiptPayload, payload.item, 'item');
    if (!insideVolume(receiptPayload.target, receiptPayload.volume) ||
      !insideAllowedCells(receiptPayload.target, receiptPayload.allowedCells)) throw coded('SURVIVAL_TARGET_OUT_OF_VOLUME');
  }
  if (receipt?.kind === 'item') {
    exactOptional(receiptPayload, payload.dropId, 'dropId');
    exactOptional(receiptPayload, payload.item, 'item');
    exactOptional(receiptPayload, payload.region, 'region');
    exactOptional(receiptPayload, payload.destination, 'destination');
    if (action === 'collectItem') {
      const dimension = canonicalDimension(receiptPayload.dimension);
      if (!dimension || !point(receiptPayload.position) || !insideVolume(receiptPayload.position, receiptPayload.volume) ||
        !receiptPayload.stack || receiptPayload.stack.item !== receiptPayload.item ||
        !Number.isSafeInteger(receiptPayload.stack.count) || receiptPayload.stack.count < 1 ||
        !string(receiptPayload.region)) throw coded('SURVIVAL_RECEIPT_MISMATCH');
    }
  }
  if (receipt?.kind === 'recipe') {
    exactOptional(receiptPayload, payload.recipe, 'recipe');
    exactOptional(receiptPayload, payload.count, 'count');
    if (!receiptPayload.mark || receiptPayload.mark.id !== payload.mark ||
      !canonicalDimension(receiptPayload.mark.dimension) || !point(receiptPayload.mark.position) ||
      receiptPayload.mark.safeHeadroom !== true) throw coded('SURVIVAL_RECEIPT_MISMATCH');
  }
  if ((action === 'moveNearTarget' && receipt) || action === 'lookAtTarget' || action === 'digTarget') exactRequired(receiptPayload, payload.targetId, 'targetId');
  if (action === 'collectItem') {
    exactRequired(receiptPayload, payload.dropId, 'dropId');
    exactRequired(receiptPayload, payload.item, 'item');
    if (!Number.isSafeInteger(receiptPayload.entityId) && !string(receiptPayload.entityId)) throw coded('SURVIVAL_RECEIPT_MISMATCH');
  }
  if (action === 'craftRecipe') {
    exactRequired(receiptPayload, payload.recipe, 'recipe');
    exactRequired(receiptPayload, payload.count, 'count');
    const specification = recipeSpecification(payload.recipe);
    if (!specification || JSON.stringify(receiptPayload.inputs) !== JSON.stringify(specification.inputs) ||
      JSON.stringify(receiptPayload.output) !== JSON.stringify(specification.output)) throw coded('SURVIVAL_RECEIPT_MISMATCH');
  }
  if (action === 'placeAtMark') {
    exactRequired(receiptPayload, payload.mark, 'mark');
    exactRequired(receiptPayload, payload.item, 'item');
  }
  if (action === 'equipItem') {
    exactRequired(receiptPayload, payload.item, 'item');
    exactRequired(receiptPayload, payload.destination, 'destination');
  }
  if (action === 'digTarget' && (!string(payload.targetId) || !string(payload.block))) throw coded('SURVIVAL_COMMAND_INVALID');
  if (action === 'collectItem' && (!string(payload.dropId) || !string(payload.item))) throw coded('SURVIVAL_COMMAND_INVALID');
  if (action === 'craftRecipe' && (!string(payload.recipe) || !Number.isSafeInteger(payload.count) || payload.count < 1 || payload.count > 64)) throw coded('SURVIVAL_COMMAND_INVALID');
  if (action === 'placeAtMark') {
    if (!string(payload.item) || !string(payload.mark)) throw coded('SURVIVAL_COMMAND_INVALID');
    mark = validatedSurvivalMark(action, payload, verifier);
    const target = receipt.payload.target;
    if (mark.dimension !== target.dimension || ['x', 'y', 'z'].some((axis) => mark.position[axis] !== target[axis])) {
      throw coded('SURVIVAL_MARK_TARGET_MISMATCH');
    }
  }
  if (action === 'equipItem' && (!string(payload.item) || !isEquipmentDestination(payload.destination))) throw coded('SURVIVAL_COMMAND_INVALID');

  return Object.freeze({
    action, actor: actorId, goalId: payload.goalId, observationVersion: payload.observationVersion,
    targetId: payload.targetId, dropId: payload.dropId, block: payload.block, item: payload.item,
    recipe: payload.recipe, count: payload.count, destination: payload.destination, markId: typeof payload.mark === 'string' ? payload.mark : undefined,
    mark, receipt
  });
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function degrees(radians) {
  return radians * 180 / Math.PI;
}

function radians(value) {
  return value * Math.PI / 180;
}

function angleDistance(left, right) {
  return Math.abs((((left - right) % 360) + 540) % 360 - 180);
}

function passable(block) {
  return block?.boundingBox === 'empty' || block?.name === 'air' || block?.name === 'cave_air' || block?.name === 'void_air';
}

function validObserverReceipt(receipt, actorId, command, text) {
  return receipt?.authoritative === true && receipt?.observed === true && receipt?.speaker === actorId && receipt?.text === text &&
    (receipt.cueId === undefined || receipt.cueId === command.cueId);
}

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason ?? coded('OPERATION_ABORTED'));
    }, { once: true });
  });
}

function localEvent(command, kind, payload, clock, sequence) {
  return Object.freeze({
    kind,
    productionId: command.productionId,
    takeId: command.takeId,
    sceneId: command.sceneId,
    beatId: command.beatId,
    attemptId: command.attemptId,
    cueId: command.cueId,
    eventId: randomUUID(),
    causalSequence: sequence,
    monotonicTimestamp: clock.now(),
    payload: Object.freeze({ commandId: command.commandId, ...payload })
  });
}

/**
 * Bounded adapter for one non-op Mineflayer actor. Commands use the canonical
 * lower-camel runtime vocabulary. Mark and speech completion require
 * server-observed proof; bot.chat() and Pathfinder resolution alone are not
 * authoritative completion.
 */
export function createActorRuntime({
  bot,
  actorId = bot?.username,
  movements = {},
  emit = () => {},
  clock = performance,
  verifier = {},
  approvalPublicKey = process.env.SHOWRUNNER_APPROVAL_PUBLIC_KEY,
  episodeContentHash,
  speechObserver,
  survivalAuthority,
  survivalObserver,
  operationTimeoutMs = 10_000
} = {}) {
  if (!bot || typeof bot !== 'object') throw coded('BOT_REQUIRED');
  if (!string(actorId)) throw coded('ACTOR_ID_REQUIRED');
  const publicKey = approvalKey(approvalPublicKey);
  if (!publicKey) throw coded('APPROVAL_PUBLIC_KEY_REQUIRED');
  if (!SHA256_HEX.test(episodeContentHash)) throw coded('EPISODE_CONTENT_HASH_REQUIRED');
  if (!Number.isInteger(operationTimeoutMs) || operationTimeoutMs < 1 || operationTimeoutMs > 60_000) throw coded('OPERATION_TIMEOUT_INVALID');
  const trustedVerifier = Object.freeze({ verifyLine: verifier?.verifyLine, verifyMark: verifier?.verifyMark });
  const ledger = new IdempotencyLedger('actor-runtime');
  const pending = new Set();
  const activeReservations = new Map();
  const activeControllers = new Set();
  const revokedAttempts = new Set();
  let closed = false;
  let activeAttemptId = null;
  let generation = 0;
  let localSequence = 0;

  const sleep = typeof clock.sleep === 'function' ? clock.sleep.bind(clock) : defaultSleep;

  function cleanupCall(call) {
    try {
      const result = call();
      if (result && typeof result.catch === 'function') void result.catch(() => {});
    } catch {
      // Cancellation cleanup is best-effort per Mineflayer primitive; one
      // adapter failure must not prevent the remaining fences from running.
    }
  }

  function stopMineflayerActivity({ closeWindow = false } = {}) {
    cleanupCall(() => bot.pathfinder?.stop?.());
    cleanupCall(() => bot.stopDigging?.());
    if (closeWindow && bot.currentWindow) {
      if (typeof bot.currentWindow.close === 'function') cleanupCall(() => bot.currentWindow.close());
      else cleanupCall(() => bot.closeWindow?.(bot.currentWindow));
    }
    cleanupCall(() => bot.clearControlStates?.());
    for (const control of CONTROL_STATES) cleanupCall(() => bot.setControlState?.(control, false));
  }

  function clearMotion(reason = coded('OPERATION_CANCELLED')) {
    generation += 1;
    for (const controller of activeControllers) controller.abort(reason);
    stopMineflayerActivity({ closeWindow: true });
  }

  function releaseReservation(receiptId, reason) {
    if (!activeReservations.delete(receiptId)) return;
    survivalAuthority?.release?.(receiptId, reason);
  }

  function releaseAllReservations(reason) {
    for (const [receiptId, reservation] of activeReservations) {
      if (!reservation.inFlight) releaseReservation(receiptId, reason);
    }
  }

  function reserveReceipt(receipt) {
    if (!receipt) return;
    if (typeof survivalAuthority?.reserve !== 'function' || typeof survivalAuthority?.release !== 'function') throw coded('SURVIVAL_AUTHORITY_REQUIRED');
    const result = survivalAuthority.reserve(receipt, actorId);
    if (result?.ok !== true) throw coded(result?.code ?? 'SURVIVAL_RESERVATION_FAILED');
    activeReservations.set(receipt.receiptId, { inFlight: false });
  }

  function operationStale(token, command) {
    return token !== generation || closed || revokedAttempts.has(command.attemptId);
  }

  function assertOperationActive(token, command, signal) {
    if (operationStale(token, command) || signal?.aborted) {
      throw signal?.reason ?? coded('OPERATION_CANCELLED');
    }
  }

  function targetDimension(validated) {
    const dimension = validated.receipt?.kind === 'target'
      ? validated.receipt.payload?.target?.dimension
      : validated.receipt?.kind === 'item'
        ? validated.receipt.payload?.dimension
        : validated.receipt?.kind === 'recipe'
          ? validated.receipt.payload?.mark?.dimension
          : validated.mark?.dimension;
    return dimension === undefined ? undefined : canonicalDimension(dimension);
  }

  function assertLiveDimension(validated) {
    const expected = targetDimension(validated);
    const live = canonicalDimension(bot.game?.dimension);
    if (!live || (expected !== undefined && live !== expected)) throw coded('SURVIVAL_DIMENSION_MISMATCH');
  }

  function reverifySurvivalReceipt(validated, command) {
    const receipt = validated.receipt;
    if (!receipt) return;
    const expected = {
      receiptId: receipt.receiptId,
      kind: receipt.kind,
      productionId: command.productionId,
      takeId: command.takeId,
      attemptId: command.attemptId,
      goalId: validated.goalId,
      actorId,
      observationVersion: validated.observationVersion
    };
    if (receipt.kind === 'target' && string(validated.block)) expected.block = validated.block;
    const result = survivalAuthority?.verifyReceipt?.(receipt, expected);
    if (result?.ok !== true) throw coded(result?.code ?? 'SURVIVAL_RECEIPT_INVALID');
  }

  function prepareSurvivalEffect(validated, command, token, signal) {
    assertOperationActive(token, command, signal);
    assertLiveDimension(validated);
    reverifySurvivalReceipt(validated, command);
  }

  async function emitEvent(sink, command, kind, payload = {}) {
    let event;
    if (sink && typeof sink.createEvent === 'function') {
      event = sink.createEvent(kind, { commandId: command.commandId, ...payload });
    } else {
      localSequence += 1;
      event = localEvent(command, kind, payload, clock, localSequence);
    }
    if (sink && typeof sink.emit === 'function') await sink.emit(event);
    else await emit(event);
    return event;
  }

  async function safeHeadroom() {
    if (typeof bot.blockAt !== 'function') return false;
    const { x, y, z } = bot.entity?.position ?? {};
    if (![x, y, z].every(Number.isFinite)) return false;
    return passable(bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)))) &&
      passable(bot.blockAt(new Vec3(Math.floor(x), Math.floor(y + 1), Math.floor(z))));
  }

  async function observeMark(mark) {
    const position = bot.entity?.position;
    const withinRadius = point(position) && distance(position, mark.position) <= mark.radius;
    const dimension = canonicalDimension(bot.game?.dimension) === canonicalDimension(mark.dimension);
    const yawTolerance = Number.isFinite(mark.yawToleranceDegrees) ? mark.yawToleranceDegrees : 5;
    const pitchTolerance = Number.isFinite(mark.pitchToleranceDegrees) ? mark.pitchToleranceDegrees : 5;
    const facing = Number.isFinite(bot.entity?.yaw) && Number.isFinite(bot.entity?.pitch) &&
      angleDistance(degrees(bot.entity.yaw), mark.facing.yaw) <= yawTolerance &&
      angleDistance(degrees(bot.entity.pitch), mark.facing.pitch) <= pitchTolerance;
    const headroom = await safeHeadroom();
    return Object.freeze({
      dimension,
      radius: withinRadius,
      facing,
      safeHeadroom: headroom,
      authoritative: dimension && withinRadius && facing && headroom
    });
  }

  async function observe(scope = {}) {
    const mark = scope.mark ?? scope;
    if (!mark?.position) return Object.freeze({ authoritative: false });
    const observation = await observeMark(mark);
    return Object.freeze({ ...observation, dwell: observation.authoritative });
  }

  async function proveMark(command, mark, token, signal) {
    let consecutive = 0;
    while (consecutive < mark.dwellTicks) {
      if (token !== generation || closed || signal.aborted) throw coded('OPERATION_CANCELLED');
      const observation = await observeMark(mark);
      consecutive = observation.authoritative ? consecutive + 1 : 0;
      if (consecutive >= mark.dwellTicks) {
        return Object.freeze({
          kind: 'mark', authoritative: true, actor: actorId, markId: command.payload.markId,
          dimension: mark.dimension, radius: true, facing: true, safeHeadroom: true, dwellTicks: consecutive
        });
      }
      await sleep(TICK_MS, signal);
    }
    throw coded('MARK_PROOF_UNAVAILABLE');
  }

  async function withDeadline(operation, command, work, receiptId) {
    const controller = new AbortController();
    activeControllers.add(controller);
    const reservation = receiptId === undefined ? undefined : activeReservations.get(receiptId);
    if (reservation) reservation.inFlight = true;
    const underlying = Promise.resolve().then(() => work(controller.signal));
    pending.add(underlying);
    void underlying.finally(() => {
      activeControllers.delete(controller);
      pending.delete(underlying);
      if (receiptId !== undefined) releaseReservation(receiptId, controller.signal.aborted ? 'operation-aborted-settled' : 'operation-settled');
    }).catch(() => {});
    let timer;
    const suppliedBudget = command.payload?.operationBudgetMs;
    const timeoutMs = Number.isSafeInteger(suppliedBudget) && suppliedBudget > 0
      ? Math.min(operationTimeoutMs, suppliedBudget)
      : operationTimeoutMs;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = coded('ACTOR_OPERATION_TIMEOUT', operation, { operation, commandId: command.commandId });
        stopMineflayerActivity({ closeWindow: true });
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    try {
      return await Promise.race([underlying, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  function normalizeSurvivalObservation(value, validated, minimumVersion, exactVersion = false) {
    const cloned = cloneJsonFrozen(value);
    const observedActor = cloned?.actor ?? cloned?.actorId;
    const version = cloned?.observationVersion ?? cloned?.version;
    const liveDimension = canonicalDimension(bot.game?.dimension);
    const expectedDimension = targetDimension(validated) ?? liveDimension;
    const observedDimension = canonicalDimension(cloned?.dimension);
    if (cloned?.authoritative !== true || observedActor !== actorId || cloned?.goalId !== validated.goalId ||
      !liveDimension || !observedDimension || observedDimension !== liveDimension || observedDimension !== expectedDimension ||
      !safeNonnegativeInteger(version) || (exactVersion ? version !== minimumVersion : version <= minimumVersion)) {
      throw coded('SURVIVAL_OBSERVATION_INVALID');
    }
    return deepFreeze({ ...cloned, actor: actorId, dimension: observedDimension, observationVersion: version });
  }

  async function survivalObservation(command, validated, phase, signal, token, minimumVersion, exactVersion = false) {
    if (typeof survivalObserver?.observe !== 'function') throw coded('SURVIVAL_OBSERVER_REQUIRED');
    assertOperationActive(token, command, signal);
    const receipt = await survivalObserver.observe({
      bot, actorId, command, action: validated.action, goalId: validated.goalId,
      observationVersion: validated.observationVersion, phase, signal
    });
    assertOperationActive(token, command, signal);
    return normalizeSurvivalObservation(receipt, validated, minimumVersion, exactVersion);
  }

  function observedInventory(observation, item) {
    const value = observation?.inventory?.[item];
    return safeNonnegativeInteger(value) ? value : 0;
  }

  function observedBlock(observation, targetId) {
    return observation?.blocks?.[targetId] ?? observation?.target?.block;
  }

  function observedDrop(observation, dropId) {
    return Array.isArray(observation?.drops) && observation.drops.some((drop) => drop?.id === dropId || drop?.dropId === dropId);
  }

  function observedDropRecord(observation, dropId) {
    return Array.isArray(observation?.drops)
      ? observation.drops.find((drop) => drop?.id === dropId || drop?.dropId === dropId)
      : undefined;
  }

  function assertSurvivalDelta(validated, before, after, expectedOutputCount) {
    if (validated.action === 'moveNearTarget') {
      const target = validated.receipt?.payload?.target;
      const radius = Number.isFinite(validated.receipt?.payload?.radius) ? validated.receipt.payload.radius : 2;
      const arrived = validated.targetId
        ? after.nearTargetId === validated.targetId || (point(after.position) && target && distance(after.position, target) <= radius)
        : after.nearMark === validated.markId || (point(after.position) && validated.mark && distance(after.position, validated.mark.position) <= validated.mark.radius);
      if (!arrived) throw coded('SURVIVAL_DELTA_INVALID');
    } else if (validated.action === 'lookAtTarget') {
      if (after.lookedAtTargetId !== validated.targetId) throw coded('SURVIVAL_DELTA_INVALID');
    } else if (validated.action === 'digTarget') {
      if (observedBlock(before, validated.targetId) !== validated.block || observedBlock(after, validated.targetId) === validated.block) {
        throw coded('SURVIVAL_DELTA_INVALID');
      }
      if (!Array.isArray(after.passableTargets) || !after.passableTargets.includes(validated.targetId)) {
        throw coded('SURVIVAL_REPLACEMENT_NOT_PASSABLE');
      }
    } else if (validated.action === 'collectItem') {
      if (observedInventory(after, validated.item) <= observedInventory(before, validated.item) ||
        !observedDrop(before, validated.dropId) || observedDrop(after, validated.dropId)) throw coded('SURVIVAL_DELTA_INVALID');
    } else if (validated.action === 'craftRecipe') {
      const payload = validated.receipt.payload;
      const outputCount = payload.output.count * validated.count;
      if (payload.output.item !== validated.recipe || expectedOutputCount !== outputCount ||
        observedInventory(after, payload.output.item) - observedInventory(before, payload.output.item) !== outputCount ||
        payload.inputs.some(({ item, count }) => observedInventory(before, item) - observedInventory(after, item) !== count * validated.count)) {
        throw coded('SURVIVAL_DELTA_INVALID');
      }
    } else if (validated.action === 'placeAtMark') {
      if (after?.placedAtMarks?.[validated.markId] !== validated.item ||
        observedInventory(before, validated.item) - observedInventory(after, validated.item) < 1) throw coded('SURVIVAL_DELTA_INVALID');
    } else if (validated.action === 'equipItem') {
      if (after?.equipment?.[validated.destination] !== validated.item) throw coded('SURVIVAL_DELTA_INVALID');
    }
  }

  function survivalProof(validated, before, after) {
    return deepFreeze({
      kind: validated.action,
      authoritative: true,
      actor: actorId,
      goalId: validated.goalId,
      observationVersion: after.observationVersion,
      before,
      after
    });
  }

  function requiredMethod(owner, name, code = 'MINEFLAYER_OPERATION_UNAVAILABLE') {
    if (typeof owner?.[name] !== 'function') throw coded(code, `${name} unavailable`);
    return owner[name].bind(owner);
  }

  function inventoryItem(name) {
    const items = requiredMethod(bot.inventory, 'items', 'MINEFLAYER_INVENTORY_UNAVAILABLE')();
    return items.find((item) => item?.name === name);
  }

  function recipeInputCounts(recipe) {
    let entries;
    if (Array.isArray(recipe?.delta)) {
      entries = recipe.delta
        .filter(({ count }) => Number.isSafeInteger(count) && count < 0)
        .map(({ id, count }) => ({ id, count: -count }));
    } else if (Array.isArray(recipe?.ingredients)) {
      entries = recipe.ingredients.map(({ id, count = 1 }) => ({ id, count: Math.abs(count) }));
    } else if (Array.isArray(recipe?.inShape)) {
      entries = recipe.inShape.flat()
        .filter(({ id }) => id !== -1)
        .map(({ id, count = 1 }) => ({ id, count: Math.abs(count) }));
    } else {
      return undefined;
    }
    const counts = new Map();
    for (const { id, count } of entries) {
      const name = bot.registry?.items?.[id]?.name;
      if (!string(name) || !Number.isSafeInteger(count) || count < 1) return undefined;
      counts.set(name, (counts.get(name) ?? 0) + count);
    }
    return counts;
  }

  function recipeMatchesReceipt(recipe, item, validated) {
    const actualInputs = recipeInputCounts(recipe);
    const signedInputs = validated.receipt.payload.inputs;
    const resultCount = recipe?.result?.count;
    return actualInputs && Number.isSafeInteger(resultCount) && resultCount > 0 &&
      (!Number.isSafeInteger(recipe.result.id) || recipe.result.id === item.id) &&
      actualInputs.size === signedInputs.length &&
      signedInputs.every(({ item: input, count }) => actualInputs.get(input) === count) &&
      validated.receipt.payload.output.item === validated.recipe &&
      validated.receipt.payload.output.count === resultCount;
  }

  function droppedItemName(entity) {
    const dropped = typeof entity?.getDroppedItem === 'function' ? entity.getDroppedItem() : entity?.item;
    return dropped?.name ?? bot.registry?.items?.[dropped?.type]?.name ?? bot.registry?.items?.[dropped?.itemId]?.name;
  }

  async function executeSurvivalAction({ action, validated, command, sink, token }) {
    try {
      if (action === 'observeSurvival') {
        const after = await withDeadline(action, command, (signal) =>
          survivalObservation(command, validated, 'after', signal, token, validated.observationVersion));
        assertOperationActive(token, command);
        await emitEvent(sink, command, 'commandCompleted');
        assertOperationActive(token, command);
        await emitEvent(sink, command, 'observationVerified', { proof: survivalProof(validated, null, after) });
        return;
      }

      const proof = await withDeadline(action, command, async (signal) => {
        assertOperationActive(token, command, signal);
        assertLiveDimension(validated);
        const before = await survivalObservation(command, validated, 'before', signal, token, validated.observationVersion, true);
        assertOperationActive(token, command, signal);
        let expectedOutputCount = 1;

        if (action === 'moveNearTarget') {
          const target = validated.receipt?.payload?.target ?? validated.mark.position;
          const radius = validated.receipt
            ? (Number.isFinite(validated.receipt.payload.radius) ? validated.receipt.payload.radius : 2)
            : validated.mark.radius;
          const nonDigging = Object.assign(Object.create(Object.getPrototypeOf(movements) ?? Object.prototype), movements, { canDig: false });
          prepareSurvivalEffect(validated, command, token, signal);
          bot.pathfinder?.setMovements?.(nonDigging);
          prepareSurvivalEffect(validated, command, token, signal);
          await requiredMethod(bot.pathfinder, 'goto')(new GoalNear(target.x, target.y, target.z, radius));
          assertOperationActive(token, command, signal);
        } else if (action === 'lookAtTarget') {
          const target = validated.receipt.payload.target;
          prepareSurvivalEffect(validated, command, token, signal);
          await requiredMethod(bot, 'lookAt', 'ORIENTATION_CONTROL_REQUIRED')(new Vec3(target.x, target.y, target.z));
          assertOperationActive(token, command, signal);
        } else if (action === 'digTarget') {
          const target = validated.receipt.payload.target;
          const block = requiredMethod(bot, 'blockAt')(new Vec3(target.x, target.y, target.z));
          if (!block || block.name !== validated.block || block.name !== target.block) throw coded('SURVIVAL_TARGET_BLOCK_MISMATCH');
          prepareSurvivalEffect(validated, command, token, signal);
          await requiredMethod(bot, 'dig')(block);
          assertOperationActive(token, command, signal);
          const replacement = requiredMethod(bot, 'blockAt')(new Vec3(target.x, target.y, target.z));
          if (!passable(replacement)) throw coded('SURVIVAL_REPLACEMENT_NOT_PASSABLE');
        } else if (action === 'collectItem') {
          const entityId = validated.receipt.payload.entityId;
          const entity = bot.entities?.[entityId];
          const signed = validated.receipt.payload;
          const dropped = typeof entity?.getDroppedItem === 'function' ? entity.getDroppedItem() : entity?.item;
          const observed = observedDropRecord(before, validated.dropId);
          if (!entity || !point(entity.position) || droppedItemName(entity) !== validated.item ||
            canonicalDimension(bot.game?.dimension) !== canonicalDimension(signed.dimension) ||
            ['x', 'y', 'z'].some((axis) => entity.position[axis] !== signed.position[axis]) ||
            !insideVolume(entity.position, signed.volume) || dropped?.count !== signed.stack.count ||
            !observed || (observed.entityId !== undefined && observed.entityId !== entityId) ||
            observed.item !== signed.item || observed.region !== signed.region ||
            canonicalDimension(observed.dimension) !== canonicalDimension(signed.dimension) ||
            !point(observed.position) || ['x', 'y', 'z'].some((axis) => observed.position[axis] !== signed.position[axis]) ||
            (observed.count ?? observed.stack?.count) !== signed.stack.count) throw coded('SURVIVAL_ITEM_MOVED');
          const nonDigging = Object.assign(Object.create(Object.getPrototypeOf(movements) ?? Object.prototype), movements, { canDig: false });
          prepareSurvivalEffect(validated, command, token, signal);
          bot.pathfinder?.setMovements?.(nonDigging);
          prepareSurvivalEffect(validated, command, token, signal);
          await requiredMethod(bot.pathfinder, 'goto')(new GoalNear(entity.position.x, entity.position.y, entity.position.z, 1));
          assertOperationActive(token, command, signal);
        } else if (action === 'craftRecipe') {
          const item = bot.registry?.itemsByName?.[validated.recipe];
          if (!item || !Number.isSafeInteger(item.id)) throw coded('SURVIVAL_RECIPE_UNAVAILABLE');
          const tablePosition = validated.receipt.payload.table;
          const table = point(tablePosition) ? requiredMethod(bot, 'blockAt')(new Vec3(tablePosition.x, tablePosition.y, tablePosition.z)) : null;
          if (tablePosition && table?.name !== 'crafting_table') throw coded('SURVIVAL_CRAFTING_TABLE_INVALID');
          const recipes = requiredMethod(bot, 'recipesFor')(item.id, null, validated.count, table);
          if (!Array.isArray(recipes) || recipes.length === 0) throw coded('SURVIVAL_RECIPE_UNAVAILABLE');
          const recipe = recipes.find((candidate) => recipeMatchesReceipt(candidate, item, validated));
          if (!recipe) throw coded('SURVIVAL_RECIPE_MISMATCH');
          expectedOutputCount = (safeNonnegativeInteger(recipe.result?.count) && recipe.result.count > 0 ? recipe.result.count : 1) * validated.count;
          prepareSurvivalEffect(validated, command, token, signal);
          await requiredMethod(bot, 'craft')(recipe, validated.count, table);
          assertOperationActive(token, command, signal);
        } else if (action === 'placeAtMark') {
          const item = inventoryItem(validated.item);
          if (!item) throw coded('SURVIVAL_ITEM_MISMATCH');
          const target = validated.receipt.payload.target;
          const targetBlock = requiredMethod(bot, 'blockAt')(new Vec3(target.x, target.y, target.z));
          if (!targetBlock || targetBlock.name !== target.block) throw coded('SURVIVAL_TARGET_BLOCK_MISMATCH');
          if (!passable(targetBlock)) throw coded('SURVIVAL_PLACEMENT_BLOCKED');
          const reference = requiredMethod(bot, 'blockAt')(new Vec3(target.x, target.y - 1, target.z));
          if (!reference || passable(reference)) throw coded('SURVIVAL_PLACEMENT_SUPPORT_INVALID');
          prepareSurvivalEffect(validated, command, token, signal);
          await requiredMethod(bot, 'equip')(item, 'hand');
          assertOperationActive(token, command, signal);
          prepareSurvivalEffect(validated, command, token, signal);
          await requiredMethod(bot, 'placeBlock')(reference, new Vec3(0, 1, 0));
          assertOperationActive(token, command, signal);
        } else if (action === 'equipItem') {
          const item = inventoryItem(validated.item);
          const signedCount = validated.receipt.payload.stack?.count;
          const liveCount = requiredMethod(bot.inventory, 'items', 'MINEFLAYER_INVENTORY_UNAVAILABLE')()
            .filter((candidate) => candidate?.name === validated.item)
            .reduce((total, candidate) => total + (Number.isSafeInteger(candidate.count) ? candidate.count : 0), 0);
          if (!item || !Number.isSafeInteger(signedCount) || liveCount !== signedCount ||
            observedInventory(before, validated.item) !== signedCount) throw coded('SURVIVAL_ITEM_MISMATCH');
          prepareSurvivalEffect(validated, command, token, signal);
          await requiredMethod(bot, 'equip')(item, validated.destination);
          assertOperationActive(token, command, signal);
        }

        assertOperationActive(token, command, signal);
        const after = await survivalObservation(command, validated, 'after', signal, token, before.observationVersion);
        assertOperationActive(token, command, signal);
        assertSurvivalDelta(validated, before, after, expectedOutputCount);
        return survivalProof(validated, before, after);
      }, validated.receipt?.receiptId);
      assertOperationActive(token, command);
      await emitEvent(sink, command, 'commandCompleted');
      assertOperationActive(token, command);
      await emitEvent(sink, command, 'observationVerified', { proof });
    } catch (error) {
      if (operationStale(token, command)) return;
      throw error;
    }
  }

  async function execute(suppliedCommand, sink) {
    const command = cloneFrozen(suppliedCommand, 'COMMAND_INVALID');
    assertFenced(command);
    if (closed) throw coded('RUNTIME_CLOSED');
    const validated = validateCommand(
      command,
      trustedVerifier,
      { publicKey, episodeContentHash },
      activeAttemptId,
      revokedAttempts,
      actorId,
      survivalAuthority
    );
    const { action } = validated;
    if (!ledger.claim(command.idempotencyKey)) return Object.freeze({ duplicate: true });

    if (action === 'cancel') {
      await emitEvent(sink, command, 'commandAcknowledged');
      clearMotion();
      releaseAllReservations('cancelled');
      revokedAttempts.add(validated.targetAttemptId);
      activeAttemptId = null;
      await Promise.allSettled([...pending]);
      await emitEvent(sink, command, 'commandCompleted');
      await emitEvent(sink, command, 'observationVerified', {
        proof: Object.freeze({ kind: 'quiescence', authoritative: true, quiescent: true, targetAttemptId: validated.targetAttemptId })
      });
      return;
    }

    if (activeAttemptId === null) activeAttemptId = command.attemptId;
    const token = generation;

    if (SURVIVAL_ACTIONS.has(action)) {
      reserveReceipt(validated.receipt);
      try {
        await emitEvent(sink, command, 'commandAcknowledged');
        if (operationStale(token, command)) return;
        return await executeSurvivalAction({ action, validated, command, sink, token });
      } finally {
        const reservation = validated.receipt && activeReservations.get(validated.receipt.receiptId);
        if (reservation && !reservation.inFlight) releaseReservation(validated.receipt.receiptId, 'operation-not-started');
      }
    }

    await emitEvent(sink, command, 'commandAcknowledged');

    if (action === 'speak') {
      if (typeof speechObserver?.observe !== 'function') throw coded('SPEECH_OBSERVER_REQUIRED');
      const work = withDeadline('speak', command, async (signal) => {
        bot.chat(validated.text);
        const receipt = await speechObserver.observe({ bot, actorId, command, text: validated.text, signal });
        if (!validObserverReceipt(receipt, actorId, command, validated.text)) throw coded('SPEECH_PROOF_INVALID');
        return Object.freeze({
          kind: 'speech', authoritative: true, observed: true, speaker: actorId,
          cueId: command.cueId, text: validated.text
        });
      });
      const proof = await work;
      if (token !== generation || closed) return;
      await emitEvent(sink, command, 'commandCompleted');
      await emitEvent(sink, command, 'observationVerified', { proof });
      return;
    }

    if (action === 'moveToMark') {
      const work = withDeadline('moveToMark', command, async (signal) => {
        const { mark } = validated;
        const nonDigging = Object.assign(Object.create(Object.getPrototypeOf(movements) ?? Object.prototype), movements, { canDig: false });
        bot.pathfinder?.setMovements?.(nonDigging);
        await bot.pathfinder?.goto?.(new GoalNear(mark.position.x, mark.position.y, mark.position.z, mark.radius));
        if (typeof bot.look !== 'function') throw coded('ORIENTATION_CONTROL_REQUIRED');
        await bot.look(radians(mark.facing.yaw), radians(mark.facing.pitch), true);
        return proveMark(command, mark, token, signal);
      });
      let proof;
      try {
        proof = await work;
      } catch (error) {
        if (token !== generation || closed || revokedAttempts.has(command.attemptId)) return;
        throw error;
      }
      if (token !== generation || closed) return;
      await emitEvent(sink, command, 'commandCompleted');
      await emitEvent(sink, command, 'observationVerified', { proof });
      return;
    }

    if (action === 'lookAt') {
      const work = withDeadline('lookAt', command, async () => bot.lookAt?.(new Vec3(validated.target.x, validated.target.y, validated.target.z)));
      try {
        await work;
      } catch (error) {
        if (token !== generation || closed || revokedAttempts.has(command.attemptId)) return;
        throw error;
      }
      if (token !== generation || closed) return;
      await emitEvent(sink, command, 'commandCompleted');
      await emitEvent(sink, command, 'observationVerified', {
        proof: Object.freeze({ kind: 'look', authoritative: true, actor: actorId, target: validated.target })
      });
      return;
    }

    const proof = await observe(command.payload.scope ?? command.payload);
    if (token !== generation || closed) return;
    await emitEvent(sink, command, 'commandCompleted');
    await emitEvent(sink, command, 'observationVerified', { proof: Object.freeze({ kind: 'observation', ...proof }) });
  }

  return Object.freeze({
    name: actorId,
    execute,
    cancel: async (attemptId) => {
      if (revokedAttempts.has(attemptId) && activeAttemptId === null) {
        return Object.freeze({
          authoritative: true, acknowledged: true, cancelled: true,
          actor: actorId, targetAttemptId: attemptId
        });
      }
      if (activeAttemptId !== null && attemptId !== activeAttemptId) throw coded('ATTEMPT_MISMATCH');
      clearMotion();
      releaseAllReservations('cancelled');
      revokedAttempts.add(attemptId);
      activeAttemptId = null;
      return Object.freeze({
        authoritative: true, acknowledged: true, cancelled: true,
        actor: actorId, targetAttemptId: attemptId
      });
    },
    awaitQuiescence: async () => {
      await Promise.allSettled([...pending]);
      return Object.freeze({ authoritative: true, acknowledged: true, quiescent: pending.size === 0, actor: actorId });
    },
    observe,
    close: () => {
      if (!closed) {
        closed = true;
        clearMotion();
        releaseAllReservations('runtime-closed');
        ledger.close();
      }
    }
  });
}

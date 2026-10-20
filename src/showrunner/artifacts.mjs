import { createHash } from 'node:crypto';
import path from 'node:path';

import { ShowrunnerError } from './errors.mjs';
import { isEquipmentDestination } from './survival-contracts.mjs';

const STATUSES = new Set(['prepared', 'completed', 'aborted', 'rejected', 'accepted']);
const DECISION_STATUSES = new Set(['aborted', 'rejected', 'accepted']);
const TRANSITIONS = Object.freeze({
  prepared: new Set(['prepared', 'completed', 'aborted']),
  completed: new Set(['completed', 'accepted', 'rejected']),
  aborted: new Set(),
  rejected: new Set(),
  accepted: new Set()
});
const CORE_EVIDENCE_FILES = Object.freeze([
  'events.ndjson', 'transcript.json', 'validation.json', 'baseline-report.json', 'capture.json'
]);
const SURVIVAL_EVIDENCE_FILES = Object.freeze([
  'planner-decisions.ndjson', 'survival-observations.ndjson'
]);
const EVIDENCE_SCHEMA_VERSION = 1;
const PLANNER_DECISION_STATUSES = new Set(['action', 'completed', 'blocked']);
const SURVIVAL_OBSERVATION_PHASES = new Set(['before', 'after']);
const SURVIVAL_ACTIONS = new Set([
  'moveNearTarget', 'lookAtTarget', 'digTarget', 'collectItem',
  'craftRecipe', 'placeAtMark', 'equipItem'
]);
const RESERVATION_FIELDS = new Set([
  'receiptId', 'reservationKey', 'kind', 'productionId', 'takeId', 'attemptId',
  'goalId', 'actorId', 'observationVersion', 'expiresAt'
]);
const RESERVATION_KINDS = new Set(['target', 'item', 'recipe']);
const POINT_FIELDS = new Set(['x', 'y', 'z']);
const TARGET_FIELDS = new Set([
  'id', 'region', 'block', 'x', 'y', 'z', 'dimension', 'pathCost', 'distance', 'reservationKey'
]);
const DROP_FIELDS = new Set([
  'id', 'dropId', 'entityId', 'item', 'region', 'reservationKey', 'dimension', 'position', 'count'
]);
const ACTOR_OBSERVATION_FIELDS = new Set(['inventory', 'atMark', 'equipped']);
const EVIDENCE_IDENTITY_FIELDS = Object.freeze([
  'schemaVersion', 'productionId', 'takeId', 'sceneId', 'beatId', 'attemptId', 'cueId',
  'eventId', 'causalSequence', 'monotonicTimestamp', 'goalId', 'actor', 'observationVersion'
]);
const PLANNER_EVIDENCE_FIELDS = new Set([
  ...EVIDENCE_IDENTITY_FIELDS, 'replanCount', 'reservations', 'decision'
]);
const SURVIVAL_EVIDENCE_FIELDS = new Set([
  ...EVIDENCE_IDENTITY_FIELDS, 'phase', 'authoritative', 'dimension', 'position', 'inventory', 'equipment',
  'actors', 'targets', 'drops', 'placedAtMarks', 'blocks', 'passableTargets',
  'nearTargetId', 'lookedAtTargetId', 'nearMark'
]);
const EVIDENCE_FILES = Object.freeze([...CORE_EVIDENCE_FILES, ...SURVIVAL_EVIDENCE_FILES]);
const EVIDENCE_FILE_SET = new Set(EVIDENCE_FILES);
const STATUS_FIELDS = new Set([
  'schemaVersion', 'productionId', 'takeId', 'status', 'version', 'survivalRequired'
]);
const ROOTED_METHODS = Object.freeze([
  'mkdirBeneath',
  'appendFileBeneath',
  'atomicWriteFileBeneath',
  'compareAndSwapFileBeneath',
  'readFileBeneath',
  'readStateSnapshotBeneath',
  'commitDecisionBeneath'
]);
const DIRECTORY_FLAGS = Object.freeze({ directory: true, noFollow: true, recursive: true });
const APPEND_FLAGS = Object.freeze({ append: true, create: true, noFollow: true, sync: true, mode: 0o600 });
const ATOMIC_WRITE_FLAGS = Object.freeze({ create: true, noFollow: true, sameDirectory: true, sync: true, mode: 0o600 });
const READ_FLAGS = Object.freeze({ readOnly: true, noFollow: true });
const STATE_SNAPSHOT_FLAGS = Object.freeze({ readOnly: true, noFollow: true, atomic: true });
const EXCLUSIVE_FLAGS = Object.freeze({ writeOnly: true, create: true, exclusive: true, noFollow: true, sync: true, mode: 0o600 });

function fail(code, message = code, details = {}) {
  throw new ShowrunnerError(code, message, details);
}

function identifier(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || value === '.' || value === '..' ||
      /[\p{Cc}\p{Cs}/\\]/u.test(value)) {
    fail('ARTIFACT_IDENTITY_INVALID', `Invalid ${field}`, { field });
  }
  return value;
}

function jsonSafeClone(value, code, ancestors = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    fail(code, 'Artifact value must contain only finite JSON numbers');
  }
  if (typeof value !== 'object') fail(code, 'Artifact value must be strict JSON data');
  if (ancestors.has(value)) fail(code, 'Artifact value must not contain cycles');

  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if ((array && prototype !== Array.prototype) || (!array && prototype !== Object.prototype && prototype !== null)) {
    fail(code, 'Artifact value must contain only plain objects and arrays');
  }

  ancestors.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) fail(code, 'Artifact value must not contain symbol properties');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (array) {
      const expectedNames = new Set(['length', ...Array.from({ length: value.length }, (_, index) => String(index))]);
      if (Object.keys(descriptors).some((name) => !expectedNames.has(name)) ||
          Array.from({ length: value.length }, (_, index) => descriptors[String(index)]).some((descriptor) =>
            !descriptor || !('value' in descriptor) || descriptor.enumerable !== true)) {
        fail(code, 'Artifact arrays must be dense JSON arrays without extra properties');
      }
      return value.map((entry) => jsonSafeClone(entry, code, ancestors));
    }

    const clone = Object.create(null);
    for (const [name, descriptor] of Object.entries(descriptors)) {
      if (!('value' in descriptor) || descriptor.enumerable !== true) {
        fail(code, 'Artifact objects must contain only enumerable data properties');
      }
      clone[name] = jsonSafeClone(descriptor.value, code, ancestors);
    }
    return clone;
  } catch (cause) {
    if (cause instanceof ShowrunnerError) throw cause;
    fail(code, 'Artifact value must be JSON serializable', { cause: cause?.message });
  } finally {
    ancestors.delete(value);
  }
}

function jsonText(value, code) {
  return JSON.stringify(jsonSafeClone(value, code));
}

function jsonDocument(value, code) {
  return Buffer.from(`${jsonText(value, code)}\n`, 'utf8');
}

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function evidenceString(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    !/[\p{Cc}\p{Cs}/\\]/u.test(value);
}

function safeNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validPoint(value) {
  return hasOnlyKeys(value, POINT_FIELDS) && Object.keys(value).length === POINT_FIELDS.size &&
    ['x', 'y', 'z'].every((axis) => Number.isFinite(value[axis]));
}

function hasOnlyKeys(value, allowed) {
  return plainObject(value) && Object.keys(value).every((key) => allowed.has(key));
}

function exactKeys(value, expected) {
  return hasOnlyKeys(value, expected) && Object.keys(value).length === expected.size;
}

function validStringMap(value, valueValidator) {
  return plainObject(value) && Object.entries(value).every(([key, entry]) =>
    evidenceString(key) && valueValidator(entry));
}

function validInventory(value) {
  return validStringMap(value, safeNonnegativeInteger);
}

function validEquipment(value) {
  return plainObject(value) && Object.entries(value).every(([destination, item]) =>
    isEquipmentDestination(destination) && evidenceString(item));
}

function sameFlatMap(left, right) {
  const leftEntries = Object.entries(left);
  return leftEntries.length === Object.keys(right).length && leftEntries.every(([key, value]) => right[key] === value);
}

function validReservation(value, record) {
  return exactKeys(value, RESERVATION_FIELDS) &&
    ['receiptId', 'reservationKey', 'goalId', 'actorId'].every((field) => evidenceString(value[field])) &&
    RESERVATION_KINDS.has(value.kind) && value.productionId === record.productionId &&
    value.takeId === record.takeId && value.attemptId === record.attemptId &&
    safeNonnegativeInteger(value.observationVersion) && safeNonnegativeInteger(value.expiresAt);
}

function validActionPayload(action, record) {
  const payload = action.payload;
  if (!plainObject(payload) || payload.actor !== record.actor || payload.goalId !== record.goalId) return false;
  const targetFields = new Set(['actor', 'goalId', 'targetId', 'region', 'block']);
  const markMoveFields = new Set(['actor', 'goalId', 'mark']);
  const fieldsByAction = {
    lookAtTarget: targetFields,
    digTarget: targetFields,
    collectItem: new Set(['actor', 'goalId', 'dropId', 'item', 'region']),
    craftRecipe: new Set(['actor', 'goalId', 'recipe', 'count', 'mark']),
    placeAtMark: new Set(['actor', 'goalId', 'item', 'mark']),
    equipItem: new Set(['actor', 'goalId', 'item', 'destination'])
  };
  const expected = action.name === 'moveNearTarget'
    ? (Object.hasOwn(payload, 'targetId') ? targetFields : markMoveFields)
    : fieldsByAction[action.name];
  if (!expected || !exactKeys(payload, expected)) return false;
  if (['moveNearTarget', 'lookAtTarget', 'digTarget'].includes(action.name) && Object.hasOwn(payload, 'targetId')) {
    return ['targetId', 'region', 'block'].every((field) => evidenceString(payload[field]));
  }
  if (action.name === 'moveNearTarget') return evidenceString(payload.mark);
  if (action.name === 'collectItem') return ['dropId', 'item', 'region'].every((field) => evidenceString(payload[field]));
  if (action.name === 'craftRecipe') {
    return evidenceString(payload.recipe) && evidenceString(payload.mark) &&
      Number.isSafeInteger(payload.count) && payload.count > 0 && payload.count <= 64;
  }
  if (action.name === 'placeAtMark') return evidenceString(payload.item) && evidenceString(payload.mark);
  if (action.name === 'equipItem') return evidenceString(payload.item) && isEquipmentDestination(payload.destination);
  return false;
}

function validTargetObservation(value) {
  const required = new Set([...TARGET_FIELDS].filter((field) => field !== 'reservationKey'));
  return hasOnlyKeys(value, TARGET_FIELDS) && [...required].every((field) => Object.hasOwn(value, field)) &&
    ['id', 'region', 'block'].every((field) => evidenceString(value[field])) &&
    (value.reservationKey === undefined || evidenceString(value.reservationKey)) &&
    ['x', 'y', 'z'].every((axis) => Number.isSafeInteger(value[axis])) &&
    typeof value.dimension === 'string' && /^[a-z0-9_.-]+:[a-z0-9_./-]+$/u.test(value.dimension) &&
    Number.isFinite(value.pathCost) && value.pathCost >= 0 && Number.isFinite(value.distance) && value.distance >= 0;
}

function validDropObservation(value) {
  return exactKeys(value, DROP_FIELDS) && ['id', 'dropId', 'item', 'region', 'reservationKey'].every((field) => evidenceString(value[field])) &&
    (Number.isSafeInteger(value.entityId) || evidenceString(value.entityId)) &&
    typeof value.dimension === 'string' && /^[a-z0-9_.-]+:[a-z0-9_./-]+$/u.test(value.dimension) &&
    validPoint(value.position) && Number.isSafeInteger(value.count) && value.count > 0;
}

function validActorObservations(value, record) {
  if (!plainObject(value) || !Object.hasOwn(value, record.actor)) return false;
  for (const [actor, observation] of Object.entries(value)) {
    if (!evidenceString(actor) || !exactKeys(observation, ACTOR_OBSERVATION_FIELDS) ||
        !validInventory(observation.inventory) || !validEquipment(observation.equipped) ||
        (observation.atMark !== null && !evidenceString(observation.atMark))) return false;
  }
  const primary = value[record.actor];
  return sameFlatMap(primary.inventory, record.inventory) && sameFlatMap(primary.equipped, record.equipment) &&
    (record.nearMark === undefined || primary.atMark === record.nearMark);
}

function validateEvidenceIdentity(value, identity, code) {
  if (!plainObject(value) || value.schemaVersion !== EVIDENCE_SCHEMA_VERSION ||
      value.productionId !== identity.productionId || value.takeId !== identity.takeId ||
      !['sceneId', 'beatId', 'attemptId', 'cueId', 'eventId', 'goalId', 'actor'].every((field) =>
        evidenceString(value[field])) ||
      !Number.isSafeInteger(value.causalSequence) || value.causalSequence <= 0 ||
      !Number.isFinite(value.monotonicTimestamp) || value.monotonicTimestamp < 0 ||
      !safeNonnegativeInteger(value.observationVersion)) {
    fail(code);
  }
}

function validatePlannerEvidenceRecord(value, identity) {
  const code = 'PLANNER_DECISION_ARTIFACT_INVALID';
  validateEvidenceIdentity(value, identity, code);
  const decision = value.decision;
  const decisionKeys = decision?.status === 'action'
    ? new Set(['status', 'reason', 'observationVersion', 'action'])
    : new Set(['status', 'reason', 'observationVersion']);
  if (!hasOnlyKeys(value, PLANNER_EVIDENCE_FIELDS) || Object.keys(value).length !== PLANNER_EVIDENCE_FIELDS.size ||
      !safeNonnegativeInteger(value.replanCount) || !Array.isArray(value.reservations) ||
      value.reservations.some((reservation) => !validReservation(reservation, value)) ||
      !plainObject(decision) || !PLANNER_DECISION_STATUSES.has(decision.status) ||
      !hasOnlyKeys(decision, decisionKeys) || Object.keys(decision).length !== decisionKeys.size ||
      !evidenceString(decision.reason) || decision.observationVersion !== value.observationVersion) {
    fail(code);
  }
  if (decision.status === 'action' && (!plainObject(decision.action) ||
      Object.keys(decision.action).length !== 2 || !Object.hasOwn(decision.action, 'name') ||
      !Object.hasOwn(decision.action, 'payload') || !SURVIVAL_ACTIONS.has(decision.action.name) ||
      !validActionPayload(decision.action, value))) {
    fail(code);
  }
  if (decision.status !== 'action' && decision.action !== undefined) fail(code);
  return value;
}

function validateSurvivalEvidenceRecord(value, identity) {
  const code = 'SURVIVAL_OBSERVATION_ARTIFACT_INVALID';
  validateEvidenceIdentity(value, identity, code);
  if (!hasOnlyKeys(value, SURVIVAL_EVIDENCE_FIELDS) || value.authoritative !== true ||
      !SURVIVAL_OBSERVATION_PHASES.has(value.phase) ||
      typeof value.dimension !== 'string' || !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u.test(value.dimension) ||
      !validPoint(value.position) || !validInventory(value.inventory) || !validEquipment(value.equipment) ||
      (value.actors !== undefined && !validActorObservations(value.actors, value)) ||
      (value.targets !== undefined && (!Array.isArray(value.targets) || value.targets.some((target) => !validTargetObservation(target)))) ||
      (value.drops !== undefined && (!Array.isArray(value.drops) || value.drops.some((drop) => !validDropObservation(drop)))) ||
      (value.placedAtMarks !== undefined && !validStringMap(value.placedAtMarks, evidenceString)) ||
      (value.blocks !== undefined && !validStringMap(value.blocks, evidenceString)) ||
      (value.passableTargets !== undefined && (!Array.isArray(value.passableTargets) ||
        new Set(value.passableTargets).size !== value.passableTargets.length || value.passableTargets.some((id) => !evidenceString(id)))) ||
      ['nearTargetId', 'lookedAtTargetId', 'nearMark'].some((field) =>
        value[field] !== undefined && !evidenceString(value[field]))) {
    fail(code);
  }
  return value;
}

function evidenceRecord(value, identity, kind, { bindWriter = false } = {}) {
  const code = kind === 'planner'
    ? 'PLANNER_DECISION_ARTIFACT_INVALID'
    : 'SURVIVAL_OBSERVATION_ARTIFACT_INVALID';
  const record = jsonSafeClone(value, code);
  if (bindWriter) {
    if (record.schemaVersion === undefined) record.schemaVersion = EVIDENCE_SCHEMA_VERSION;
    if (record.productionId === undefined) record.productionId = identity.productionId;
    if (record.takeId === undefined) record.takeId = identity.takeId;
  }
  return kind === 'planner'
    ? validatePlannerEvidenceRecord(record, identity)
    : validateSurvivalEvidenceRecord(record, identity);
}

function parseEvidenceNdjson(data, identity, kind) {
  if (data === undefined) return [];
  const code = kind === 'planner'
    ? 'PLANNER_DECISION_ARTIFACT_INVALID'
    : 'SURVIVAL_OBSERVATION_ARTIFACT_INVALID';
  const text = Buffer.from(data).toString('utf8');
  if (text.length === 0 || !text.endsWith('\n')) fail(code);
  const lines = text.slice(0, -1).split('\n');
  if (lines.some((line) => line.length === 0)) fail(code);
  return lines.map((line) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail(code);
    }
    return evidenceRecord(parsed, identity, kind);
  });
}

function evidenceVersionKey(record) {
  return `${record.attemptId}\u0000${record.goalId}\u0000${record.actor}`;
}

function evidenceFenceKey(record) {
  return [record.productionId, record.takeId, record.sceneId, record.beatId, record.attemptId, record.cueId].join('\u0000');
}

function validateEvidenceStreams(plannerData, observationData, identity, { requireLinkage = false } = {}) {
  const planner = parseEvidenceNdjson(plannerData, identity, 'planner');
  const observations = parseEvidenceNdjson(observationData, identity, 'observation');
  const seenEventIds = new Set();
  const seenCausalSequences = new Set();
  const orderedByFence = new Map();

  for (const records of [planner, observations]) {
    const priorCausalSequences = new Map();
    for (const record of records) {
      if (seenEventIds.has(record.eventId)) fail('EVIDENCE_EVENT_DUPLICATE');
      const fenceKey = evidenceFenceKey(record);
      const causalKey = `${fenceKey}\u0000${record.causalSequence}`;
      const priorCausalSequence = priorCausalSequences.get(fenceKey) ?? 0;
      if (seenCausalSequences.has(causalKey) || record.causalSequence <= priorCausalSequence) {
        fail('EVIDENCE_CAUSAL_ORDER_INVALID');
      }
      seenEventIds.add(record.eventId);
      seenCausalSequences.add(causalKey);
      priorCausalSequences.set(fenceKey, record.causalSequence);
      const ordered = orderedByFence.get(fenceKey) ?? [];
      ordered.push(record);
      orderedByFence.set(fenceKey, ordered);
    }
  }

  for (const ordered of orderedByFence.values()) {
    ordered.sort((left, right) => left.causalSequence - right.causalSequence);
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index].monotonicTimestamp < ordered[index - 1].monotonicTimestamp) {
        fail('EVIDENCE_CAUSAL_ORDER_INVALID');
      }
    }
  }

  const plannerVersions = new Map();
  for (const record of planner) {
    const key = evidenceVersionKey(record);
    const prior = plannerVersions.get(key);
    if (prior !== undefined && record.observationVersion <= prior) fail('EVIDENCE_VERSION_ORDER_INVALID');
    plannerVersions.set(key, record.observationVersion);
  }

  const observationVersions = new Map();
  for (const record of observations) {
    const key = evidenceVersionKey(record);
    const prior = observationVersions.get(key);
    if (prior && (record.observationVersion < prior.version ||
        (record.observationVersion === prior.version && !(prior.phase === 'after' && record.phase === 'before')))) {
      fail('EVIDENCE_VERSION_ORDER_INVALID');
    }
    observationVersions.set(key, { version: record.observationVersion, phase: record.phase });
  }

  if (requireLinkage) {
    for (const decision of planner) {
      const related = observations.filter((observation) =>
        evidenceFenceKey(observation) === evidenceFenceKey(decision) &&
        observation.goalId === decision.goalId && observation.actor === decision.actor);
      const source = related.some((observation) => observation.phase === 'after' &&
        observation.observationVersion === decision.observationVersion &&
        observation.causalSequence < decision.causalSequence &&
        observation.monotonicTimestamp <= decision.monotonicTimestamp);
      if (!source) fail('EVIDENCE_SOURCE_OBSERVATION_MISSING');
      if (decision.decision.status === 'action') {
        const postAction = related.some((observation) => observation.phase === 'after' &&
          observation.observationVersion > decision.observationVersion &&
          observation.causalSequence > decision.causalSequence &&
          observation.monotonicTimestamp >= decision.monotonicTimestamp);
        if (!postAction) fail('EVIDENCE_POST_ACTION_OBSERVATION_MISSING');
      }
    }
  }

  return Object.freeze({ planner, observations });
}

function parseJson(data, code) {
  try {
    return JSON.parse(Buffer.from(data).toString('utf8'));
  } catch (cause) {
    fail(code, 'Artifact JSON is invalid', { cause: cause?.message });
  }
}

function validIdentity(value) {
  return Number.isSafeInteger(value?.dev) && Number.isSafeInteger(value?.ino);
}

function sameIdentity(left, right) {
  return validIdentity(left) && validIdentity(right) && left.dev === right.dev && left.ino === right.ino;
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function assertStatusTransition(current, next) {
  if (!STATUSES.has(next)) fail('TAKE_STATUS_INVALID', `Unknown take status: ${next}`);
  if (current === undefined) {
    if (!['prepared', 'completed', 'aborted'].includes(next)) {
      fail('TAKE_STATUS_TRANSITION_INVALID', `Cannot initialize a take as ${next}`);
    }
    return;
  }
  if (!TRANSITIONS[current]?.has(next)) {
    const code = DECISION_STATUSES.has(current) ? 'FINAL_STATUS_IMMUTABLE' : 'TAKE_STATUS_TRANSITION_INVALID';
    fail(code, `Cannot change take status from ${current} to ${next}`, { current, next });
  }
}

function decisionEvidenceNames(value) {
  if (value.schemaVersion === 1) return Object.keys(value.evidence);
  return value.evidenceFiles;
}

function validEvidenceNames(value) {
  const names = value.schemaVersion === 1 ? Object.keys(value.evidence) : value.evidenceFiles;
  if (!Array.isArray(names) || new Set(names).size !== names.length ||
      names.some((name) => typeof name !== 'string' || !EVIDENCE_FILE_SET.has(name)) ||
      CORE_EVIDENCE_FILES.some((name) => !names.includes(name))) return false;
  const survivalCount = SURVIVAL_EVIDENCE_FILES.filter((name) => names.includes(name)).length;
  return survivalCount === 0 || survivalCount === SURVIVAL_EVIDENCE_FILES.length;
}

function validDecision(value, identity) {
  if (!value || ![1, 2].includes(value.schemaVersion) || value.productionId !== identity.productionId ||
      value.takeId !== identity.takeId || !DECISION_STATUSES.has(value.status) ||
      !Number.isSafeInteger(value.statusVersion) || value.statusVersion < 1) {
    fail('DECISION_ARTIFACT_INVALID');
  }
  if (value.status === 'accepted') {
    if (!value.evidence || typeof value.evidence !== 'object' || Array.isArray(value.evidence)) {
      fail('DECISION_ARTIFACT_INVALID');
    }
    if (!validEvidenceNames(value)) fail('DECISION_ARTIFACT_INVALID');
    const names = decisionEvidenceNames(value);
    if (Object.keys(value.evidence).length !== names.length || Object.keys(value.evidence).some((name) => !names.includes(name))) {
      fail('DECISION_ARTIFACT_INVALID');
    }
    for (const name of names) {
      const evidence = value.evidence[name];
      if (!evidence || !/^[a-f0-9]{64}$/u.test(evidence.sha256) ||
          !Number.isSafeInteger(evidence.size) || evidence.size < 0) fail('DECISION_ARTIFACT_INVALID');
    }
  } else if (value.schemaVersion === 2 && (!Array.isArray(value.evidenceFiles) || value.evidenceFiles.length !== 0 || value.evidence !== null)) {
    fail('DECISION_ARTIFACT_INVALID');
  }
  return value;
}

function validStatus(value, identity) {
  if (!value || value.schemaVersion !== 1 || value.productionId !== identity.productionId ||
      value.takeId !== identity.takeId || !STATUSES.has(value.status) ||
      !Number.isSafeInteger(value.version) || value.version < 1 ||
      (value.survivalRequired !== undefined && typeof value.survivalRequired !== 'boolean') ||
      Object.keys(value).some((key) => !STATUS_FIELDS.has(key))) {
    fail('STATUS_ARTIFACT_INVALID');
  }
  return { ...value, survivalRequired: value.survivalRequired === true };
}

function mapOperationError(error) {
  if (error?.code === 'ESEALED') fail('ARTIFACTS_SEALED');
  if (error?.code === 'ECOMPARE') fail('ARTIFACT_EVIDENCE_CHANGED');
  if (error?.code === 'ESTALE') fail('TAKE_STATUS_CONFLICT');
  throw error;
}

/**
 * Required fsPort boundary for a live artifact host.
 *
 * Every method must atomically traverse from a trusted descriptor for rootPath,
 * reject symlinks in every component, and return descriptor-derived
 * { canonicalRootPath, canonicalPath, rootIdentity }. Missing reads return the
 * same proof with found:false. Mutation methods must atomically enforce
 * guardAbsentRelativePath against the decision file. compareAndSwapFileBeneath
 * must compare the supplied prior status state, version, SHA-256, and byte size
 * under that lock before replacing status.json. readStateSnapshotBeneath must
 * return status.json and decision.json from one atomic, versioned snapshot with
 * rooted proofs for both entries. commitDecisionBeneath must, in one durable
 * transaction, compare the expected completed status, verify every expected
 * evidence digest and size or expected absence, require decision.json to be absent, exclusively
 * create it, and project the matching terminal status.json. It returns a second
 * rooted proof as statusProjection. Snapshot reads and decision commits share
 * the same serialization boundary. An interrupted commit is either wholly
 * absent or wholly visible after reopen. A sequence of pathname
 * realpath/lstat/open calls is not acceptable.
 */
function requireRootedPort(fsPort) {
  if (!fsPort || ROOTED_METHODS.some((name) => typeof fsPort[name] !== 'function')) {
    fail('ROOTED_ARTIFACT_FS_REQUIRED');
  }
  return fsPort;
}

export function createArtifactWriter(root, identityInput, { fsPort: suppliedFsPort, survivalRequired = false } = {}) {
  if (typeof root !== 'string' || root.length === 0 || !path.isAbsolute(root)) fail('ARTIFACT_ROOT_INVALID');
  if (typeof survivalRequired !== 'boolean') fail('ARTIFACT_SURVIVAL_MODE_INVALID');
  const fsPort = requireRootedPort(suppliedFsPort);
  const rootPath = path.resolve(root);
  const identity = Object.freeze({
    productionId: identifier(identityInput?.productionId, 'productionId'),
    takeId: identifier(identityInput?.takeId, 'takeId')
  });
  const relativeDirectory = path.join('showrunner', identity.productionId, identity.takeId);
  const relativePaths = Object.freeze({
    events: path.join(relativeDirectory, 'events.ndjson'),
    plannerDecisions: path.join(relativeDirectory, 'planner-decisions.ndjson'),
    survivalObservations: path.join(relativeDirectory, 'survival-observations.ndjson'),
    transcript: path.join(relativeDirectory, 'transcript.json'),
    validation: path.join(relativeDirectory, 'validation.json'),
    baseline: path.join(relativeDirectory, 'baseline-report.json'),
    capture: path.join(relativeDirectory, 'capture.json'),
    status: path.join(relativeDirectory, 'status.json'),
    decision: path.join(relativeDirectory, 'decision.json')
  });
  const paths = Object.freeze(Object.fromEntries(
    Object.entries(relativePaths).map(([name, relativePath]) => [name, path.join(rootPath, relativePath)])
  ));
  let rootProof;
  let queue = Promise.resolve();

  function validateProof(result, relativePath) {
    const canonicalRootPath = result?.canonicalRootPath;
    const canonicalPath = result?.canonicalPath;
    const rootIdentity = result?.rootIdentity;
    if (typeof canonicalRootPath !== 'string' || !path.isAbsolute(canonicalRootPath) ||
        typeof canonicalPath !== 'string' || !path.isAbsolute(canonicalPath) || !validIdentity(rootIdentity)) {
      fail('ARTIFACT_ROOT_PROOF_INVALID');
    }
    const resolvedRoot = path.resolve(canonicalRootPath);
    const resolvedPath = path.resolve(canonicalPath);
    if (resolvedRoot !== rootPath || resolvedPath !== path.resolve(resolvedRoot, relativePath)) {
      fail('ARTIFACT_ROOT_PROOF_INVALID');
    }
    if (!rootProof) rootProof = Object.freeze({ canonicalRootPath: resolvedRoot, rootIdentity: { ...rootIdentity } });
    else if (rootProof.canonicalRootPath !== resolvedRoot || !sameIdentity(rootProof.rootIdentity, rootIdentity)) {
      fail('ARTIFACT_ROOT_CHANGED');
    }
    return result;
  }

  async function rootedCall(method, relativePath, options = {}) {
    try {
      const result = await fsPort[method]({ rootPath, relativePath, ...options });
      return validateProof(result, relativePath);
    } catch (error) {
      mapOperationError(error);
    }
  }

  const enqueue = (operation) => {
    const result = queue.then(operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };

  function dataFromReadProof(result) {
    if (result.found === false) return undefined;
    if (result.found !== true || (!Buffer.isBuffer(result.data) && typeof result.data !== 'string')) {
      fail('ARTIFACT_READ_PROOF_INVALID');
    }
    const data = Buffer.from(result.data);
    if (!Number.isSafeInteger(result.size) || result.size !== data.byteLength) fail('ARTIFACT_READ_PROOF_INVALID');
    return data;
  }

  async function readRaw(relativePath) {
    const result = await rootedCall('readFileBeneath', relativePath, { flags: READ_FLAGS });
    return dataFromReadProof(result);
  }

  async function readStateSnapshot() {
    let result;
    try {
      result = await fsPort.readStateSnapshotBeneath({
        rootPath,
        statusRelativePath: relativePaths.status,
        decisionRelativePath: relativePaths.decision,
        flags: STATE_SNAPSHOT_FLAGS
      });
    } catch (error) {
      mapOperationError(error);
    }
    if (!Number.isSafeInteger(result?.snapshotVersion) || result.snapshotVersion < 0 ||
        typeof result.canonicalRootPath !== 'string' || !path.isAbsolute(result.canonicalRootPath) ||
        path.resolve(result.canonicalRootPath) !== rootPath ||
        !validIdentity(result.rootIdentity)) {
      fail('ARTIFACT_STATE_SNAPSHOT_INVALID');
    }
    const status = validateProof(result.status, relativePaths.status);
    const decision = validateProof(result.decision, relativePaths.decision);
    if (status.snapshotVersion !== result.snapshotVersion || decision.snapshotVersion !== result.snapshotVersion ||
        path.resolve(status.canonicalRootPath) !== path.resolve(result.canonicalRootPath) ||
        path.resolve(decision.canonicalRootPath) !== path.resolve(result.canonicalRootPath) ||
        !sameIdentity(status.rootIdentity, result.rootIdentity) ||
        !sameIdentity(decision.rootIdentity, result.rootIdentity)) {
      fail('ARTIFACT_STATE_SNAPSHOT_INVALID');
    }
    return Object.freeze({
      snapshotVersion: result.snapshotVersion,
      statusData: dataFromReadProof(status),
      decisionData: dataFromReadProof(decision)
    });
  }

  async function readState() {
    const { statusData, decisionData } = await readStateSnapshot();
    const status = statusData === undefined
      ? undefined
      : Object.freeze(validStatus(parseJson(statusData, 'STATUS_ARTIFACT_INVALID'), identity));
    const terminal = decisionData === undefined
      ? undefined
      : Object.freeze(validDecision(parseJson(decisionData, 'DECISION_ARTIFACT_INVALID'), identity));
    if (terminal) {
      if (!status || status.status !== terminal.status || status.version !== terminal.statusVersion) {
        fail('ARTIFACT_STATE_TAMPERED');
      }
      if (status.survivalRequired && terminal.status === 'accepted' &&
          !SURVIVAL_EVIDENCE_FILES.every((name) => decisionEvidenceNames(terminal).includes(name))) {
        fail('ARTIFACT_STATE_TAMPERED');
      }
    } else if (status && DECISION_STATUSES.has(status.status)) {
      fail('ARTIFACT_STATE_TAMPERED');
    }
    return Object.freeze({ status, statusData, decision: terminal });
  }

  async function assertWritable() {
    const state = await readState();
    if (state.decision) fail('ARTIFACTS_SEALED');
    return state;
  }

  async function ensureDirectory() {
    await rootedCall('mkdirBeneath', relativeDirectory, {
      flags: DIRECTORY_FLAGS,
      guardAbsentRelativePath: relativePaths.decision
    });
  }

  async function atomicWrite(relativePath, data) {
    await ensureDirectory();
    await rootedCall('atomicWriteFileBeneath', relativePath, {
      data,
      flags: ATOMIC_WRITE_FLAGS,
      guardAbsentRelativePath: relativePaths.decision
    });
  }

  function statusExpectation(state) {
    if (!state.status) {
      return Object.freeze({ found: false, status: null, version: 0, sha256: null, size: 0 });
    }
    return Object.freeze({
      found: true,
      status: state.status.status,
      version: state.status.version,
      sha256: sha256(state.statusData),
      size: state.statusData.byteLength
    });
  }

  function nextStatusRecord(status, state) {
    return Object.freeze({
      schemaVersion: 1,
      ...identity,
      status,
      version: (state.status?.version ?? 0) + 1,
      survivalRequired: survivalRequired || state.status?.survivalRequired === true
    });
  }

  async function transitionStatus(status, state) {
    const record = nextStatusRecord(status, state);
    await ensureDirectory();
    await rootedCall('compareAndSwapFileBeneath', relativePaths.status, {
      data: jsonDocument(record, 'STATUS_ARTIFACT_INVALID'),
      flags: ATOMIC_WRITE_FLAGS,
      guardAbsentRelativePath: relativePaths.decision,
      expectedCurrent: statusExpectation(state)
    });
    return record;
  }

  async function evidenceForAcceptance(state) {
    const evidence = {};
    const expectedFiles = {};
    for (const name of CORE_EVIDENCE_FILES) {
      const relativePath = path.join(relativeDirectory, name);
      const data = await readRaw(relativePath);
      if (data === undefined) fail('ACCEPTANCE_EVIDENCE_MISSING', `Missing acceptance evidence: ${name}`, { name });
      evidence[name] = Object.freeze({ sha256: sha256(data), size: data.byteLength });
      expectedFiles[relativePath] = evidence[name];
    }
    const survivalData = [];
    for (const name of SURVIVAL_EVIDENCE_FILES) {
      survivalData.push([name, await readRaw(path.join(relativeDirectory, name))]);
    }
    const survivalFilesPresent = survivalData.filter(([, data]) => data !== undefined).length;
    if (((survivalRequired || state.status?.survivalRequired === true) &&
          survivalFilesPresent !== SURVIVAL_EVIDENCE_FILES.length) ||
        (survivalFilesPresent !== 0 && survivalFilesPresent !== SURVIVAL_EVIDENCE_FILES.length)) {
      fail('ACCEPTANCE_EVIDENCE_MISSING', 'Survival acceptance requires both planner and observation evidence');
    }
    if (survivalFilesPresent === SURVIVAL_EVIDENCE_FILES.length) {
      validateEvidenceStreams(survivalData[0][1], survivalData[1][1], identity, { requireLinkage: true });
    }
    for (const [name, data] of survivalData) {
      const relativePath = path.join(relativeDirectory, name);
      if (data === undefined) {
        expectedFiles[relativePath] = Object.freeze({ found: false });
        continue;
      }
      evidence[name] = Object.freeze({ sha256: sha256(data), size: data.byteLength });
      expectedFiles[relativePath] = evidence[name];
    }
    const capture = parseJson(await readRaw(relativePaths.capture), 'CAPTURE_ARTIFACT_INVALID');
    if (capture?.ok !== true) fail('CAPTURE_VERIFICATION_REQUIRED');
    return {
      evidence: Object.freeze(evidence),
      evidenceFiles: Object.freeze(Object.keys(evidence)),
      expectedFiles: Object.freeze(expectedFiles)
    };
  }

  async function createDecision(status, state) {
    const acceptance = status === 'accepted'
      ? await evidenceForAcceptance(state)
      : { evidence: null, evidenceFiles: Object.freeze([]), expectedFiles: {} };
    const terminalStatus = nextStatusRecord(status, state);
    const record = Object.freeze({
      schemaVersion: 2,
      ...identity,
      status,
      statusVersion: terminalStatus.version,
      evidenceFiles: acceptance.evidenceFiles,
      evidence: acceptance.evidence
    });
    const encoded = jsonDocument(record, 'DECISION_ARTIFACT_INVALID');
    const projection = jsonDocument(terminalStatus, 'STATUS_ARTIFACT_INVALID');
    try {
      await ensureDirectory();
      const created = await rootedCall('commitDecisionBeneath', relativePaths.decision, {
        data: encoded,
        flags: EXCLUSIVE_FLAGS,
        expectedStatus: statusExpectation(state),
        expectedFiles: acceptance.expectedFiles,
        statusProjection: Object.freeze({ relativePath: relativePaths.status, data: projection })
      });
      validateProof(created.statusProjection, relativePaths.status);
    } catch (error) {
      if (error?.code === 'EEXIST' || error?.code === 'ARTIFACTS_SEALED') {
        await readState();
        fail('FINAL_STATUS_IMMUTABLE');
      }
      throw error;
    }
    return record;
  }

  async function verifyDecision() {
    const { decision: terminal } = await readState();
    if (!terminal) return Object.freeze({ ok: false, reason: 'DECISION_NOT_RECORDED' });
    if (terminal.status === 'accepted') {
      const listedNames = decisionEvidenceNames(terminal);
      const namesToVerify = terminal.schemaVersion === 2 ? EVIDENCE_FILES : listedNames;
      const verifiedData = new Map();
      for (const name of namesToVerify) {
        const data = await readRaw(path.join(relativeDirectory, name));
        if (!listedNames.includes(name)) {
          if (data !== undefined) {
            fail('ARTIFACT_EVIDENCE_MISMATCH', `Accepted unlisted evidence appeared: ${name}`, { name });
          }
          continue;
        }
        const expected = terminal.evidence[name];
        if (data === undefined || data.byteLength !== expected.size || sha256(data) !== expected.sha256) {
          fail('ARTIFACT_EVIDENCE_MISMATCH', `Accepted evidence changed: ${name}`, { name });
        }
        verifiedData.set(name, data);
      }
      if (SURVIVAL_EVIDENCE_FILES.every((name) => listedNames.includes(name))) {
        validateEvidenceStreams(
          verifiedData.get(SURVIVAL_EVIDENCE_FILES[0]),
          verifiedData.get(SURVIVAL_EVIDENCE_FILES[1]),
          identity,
          { requireLinkage: true }
        );
      }
    }
    return Object.freeze({ ok: true, status: terminal.status, evidence: terminal.evidence });
  }

  function appendEvidenceRecord(relativePath, value, code, kind) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code);
    const snapshot = jsonSafeClone(value, code);
    return enqueue(async () => {
      await assertWritable();
      const record = evidenceRecord(snapshot, identity, kind, { bindWriter: true });
      const encoded = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
      const currentPlanner = await readRaw(relativePaths.plannerDecisions);
      const currentObservations = await readRaw(relativePaths.survivalObservations);
      const current = kind === 'planner' ? currentPlanner : currentObservations;
      const proposed = Buffer.concat([current ?? Buffer.alloc(0), encoded]);
      validateEvidenceStreams(
        kind === 'planner' ? proposed : currentPlanner,
        kind === 'observation' ? proposed : currentObservations,
        identity
      );
      await ensureDirectory();
      await rootedCall('appendFileBeneath', relativePath, {
        data: encoded,
        flags: APPEND_FLAGS,
        guardAbsentRelativePath: relativePaths.decision
      });
    });
  }

  return Object.freeze({
    directory: path.join(rootPath, relativeDirectory),
    paths,
    relativePaths,

    appendEvent(event) {
      const encoded = Buffer.from(`${jsonText(event, 'EVENT_ARTIFACT_INVALID')}\n`, 'utf8');
      return enqueue(async () => {
        await assertWritable();
        await ensureDirectory();
        await rootedCall('appendFileBeneath', relativePaths.events, {
          data: encoded,
          flags: APPEND_FLAGS,
          guardAbsentRelativePath: relativePaths.decision
        });
      });
    },

    appendPlannerDecision(decision) {
      return appendEvidenceRecord(
        relativePaths.plannerDecisions,
        decision,
        'PLANNER_DECISION_ARTIFACT_INVALID',
        'planner'
      );
    },

    appendSurvivalObservation(observation) {
      return appendEvidenceRecord(
        relativePaths.survivalObservations,
        observation,
        'SURVIVAL_OBSERVATION_ARTIFACT_INVALID',
        'observation'
      );
    },

    writeTranscript(transcript) {
      if (!Array.isArray(transcript)) fail('TRANSCRIPT_ARTIFACT_INVALID');
      const encoded = jsonDocument(transcript, 'TRANSCRIPT_ARTIFACT_INVALID');
      return enqueue(async () => {
        await assertWritable();
        await atomicWrite(relativePaths.transcript, encoded);
      });
    },

    writeValidation(validation) {
      if (validation === null || typeof validation !== 'object' || Array.isArray(validation)) {
        fail('VALIDATION_ARTIFACT_INVALID');
      }
      const encoded = jsonDocument(validation, 'VALIDATION_ARTIFACT_INVALID');
      return enqueue(async () => {
        await assertWritable();
        await atomicWrite(relativePaths.validation, encoded);
      });
    },

    finalize(finalization) {
      if (finalization === null || typeof finalization !== 'object' || Array.isArray(finalization)) {
        fail('TAKE_FINALIZATION_INVALID');
      }
      const snapshot = parseJson(jsonDocument(finalization, 'TAKE_FINALIZATION_INVALID'), 'TAKE_FINALIZATION_INVALID');
      return enqueue(async () => {
        const state = await readState();
        if (state.decision) {
          if (DECISION_STATUSES.has(snapshot.status)) fail('FINAL_STATUS_IMMUTABLE');
          fail('ARTIFACTS_SEALED');
        }
        const current = state.status?.status;
        assertStatusTransition(current, snapshot.status);

        if (snapshot.status === 'completed') {
          if (snapshot.baselineReport?.verified !== true) fail('BASELINE_REPORT_REQUIRED');
          if (snapshot.capture?.ok !== true) fail('CAPTURE_VERIFICATION_REQUIRED');
          if (survivalRequired || state.status?.survivalRequired === true) {
            const plannerData = await readRaw(relativePaths.plannerDecisions);
            const observationData = await readRaw(relativePaths.survivalObservations);
            if (plannerData === undefined || observationData === undefined) {
              fail('ACCEPTANCE_EVIDENCE_MISSING', 'Survival completion requires both planner and observation evidence');
            }
            validateEvidenceStreams(plannerData, observationData, identity, { requireLinkage: true });
          }
          await atomicWrite(relativePaths.baseline, jsonDocument(snapshot.baselineReport, 'BASELINE_REPORT_INVALID'));
          await atomicWrite(relativePaths.capture, jsonDocument(snapshot.capture, 'CAPTURE_ARTIFACT_INVALID'));
          await transitionStatus(snapshot.status, state);
          return Object.freeze({ ...identity, status: snapshot.status });
        }
        if (DECISION_STATUSES.has(snapshot.status)) {
          const terminal = await createDecision(snapshot.status, state);
          return Object.freeze({ ...identity, status: terminal.status });
        }
        await transitionStatus(snapshot.status, state);
        return Object.freeze({ ...identity, status: snapshot.status });
      });
    },

    readStatus() {
      return enqueue(async () => {
        const state = await readState();
        if (state.decision) return Object.freeze({ ...identity, status: state.decision.status });
        return state.status ? Object.freeze({ ...identity, status: state.status.status }) : undefined;
      });
    },

    verify() {
      return enqueue(verifyDecision);
    }
  });
}

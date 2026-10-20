import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as asymmetricSign,
  verify as asymmetricVerify
} from 'node:crypto';
import {
  canonicalDimension,
  isEquipmentDestination,
  recipeSpecification
} from './survival-contracts.mjs';

const RECEIPT_KINDS = new Set(['target', 'item', 'recipe']);
const RECEIPT_FIELDS = new Set([
  'receiptId', 'kind', 'productionId', 'takeId', 'attemptId', 'goalId', 'actorId', 'observationVersion', 'expiresAt', 'payload', 'signature'
]);
const SIGNATURE_FIELDS = new Set(['algorithm', 'keyId', 'value']);
const MIN_RECEIPT_AGE_MS = 100;
const MAX_RECEIPT_AGE_MS = 30_000;
const SHA256_HEX = /^[a-f0-9]{64}$/iu;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

function coded(code, message = code) {
  return Object.assign(new TypeError(message), { code });
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isJsonValue(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry, seen));
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Object.values(value).every((entry) => isJsonValue(entry, seen));
}

function cloneJson(value) {
  if (!isJsonValue(value)) throw coded('RECEIPT_PAYLOAD_INVALID', 'Receipt payload must be JSON-safe');
  return JSON.parse(JSON.stringify(value));
}

function nonemptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function safeNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function normalizePem(value) {
  return typeof value === 'string' ? value.replaceAll('\\n', '\n') : value;
}

function privateSigningKey(value) {
  try {
    const supplied = value?.privateKey ?? value;
    const key = supplied?.type === 'private' ? supplied : createPrivateKey(normalizePem(supplied));
    return key.asymmetricKeyType === 'ed25519' ? key : undefined;
  } catch {
    return undefined;
  }
}

function signatureFor(content, key) {
  const publicKey = createPublicKey(key);
  return {
    algorithm: 'Ed25519',
    keyId: createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex'),
    value: asymmetricSign(null, Buffer.from(stableJson(content)), key).toString('base64url')
  };
}

function canonicalSignature(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).length !== SIGNATURE_FIELDS.size || Object.keys(value).some((key) => !SIGNATURE_FIELDS.has(key)) ||
    value.algorithm !== 'Ed25519' || !SHA256_HEX.test(value.keyId) || !BASE64URL.test(value.value)) return undefined;
  return { algorithm: 'Ed25519', keyId: value.keyId, value: value.value };
}

function targetSchema(value) {
  const dimension = canonicalDimension(value?.dimension);
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    !['x', 'y', 'z'].every((axis) => Number.isSafeInteger(value[axis])) ||
    !nonemptyString(value.block) || !dimension) return undefined;
  return { x: value.x, y: value.y, z: value.z, dimension, block: value.block };
}

function expectedTargetSchema(value) {
  const dimension = canonicalDimension(value?.dimension);
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    !['x', 'y', 'z'].every((axis) => Number.isSafeInteger(value[axis])) ||
    !dimension || (value.block !== undefined && !nonemptyString(value.block))) return undefined;
  return { x: value.x, y: value.y, z: value.z, dimension, ...(value.block === undefined ? {} : { block: value.block }) };
}

function pointSchema(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    ['x', 'y', 'z'].every((axis) => Number.isFinite(value[axis]));
}

function volumeSchema(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && pointSchema(value.min) && pointSchema(value.max) &&
    ['x', 'y', 'z'].every((axis) => value.min[axis] <= value.max[axis]);
}

function stackSchema(value, item) {
  return value && typeof value === 'object' && !Array.isArray(value) && value.item === item &&
    Number.isSafeInteger(value.count) && value.count > 0;
}

function markSchema(value) {
  const dimension = canonicalDimension(value?.dimension);
  return value && typeof value === 'object' && !Array.isArray(value) && nonemptyString(value.id) && dimension &&
    pointSchema(value.position) && value.safeHeadroom === true
    ? { ...cloneJson(value), dimension }
    : undefined;
}

function itemPayloadSchema(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !nonemptyString(payload.item)) return undefined;
  if (payload.destination !== undefined) {
    if (!isEquipmentDestination(payload.destination) || !stackSchema(payload.stack, payload.item)) return undefined;
    return cloneJson(payload);
  }
  const dimension = canonicalDimension(payload.dimension);
  if ((!Number.isSafeInteger(payload.entityId) && !nonemptyString(payload.entityId)) || !nonemptyString(payload.dropId) ||
    !nonemptyString(payload.region) || !dimension || !pointSchema(payload.position) || !volumeSchema(payload.volume) ||
    !['x', 'y', 'z'].every((axis) => payload.position[axis] >= payload.volume.min[axis] && payload.position[axis] <= payload.volume.max[axis]) ||
    !stackSchema(payload.stack, payload.item)) return undefined;
  return { ...cloneJson(payload), dimension };
}

function recipePayloadSchema(payload) {
  const specification = recipeSpecification(payload?.recipe);
  const mark = markSchema(payload?.mark);
  if (!specification || !Number.isSafeInteger(payload.count) || payload.count < 1 || payload.count > 64 || !mark ||
    stableJson(payload.inputs) !== stableJson(specification.inputs) || stableJson(payload.output) !== stableJson(specification.output)) return undefined;
  let table;
  if (payload.table !== undefined) {
    table = targetSchema(payload.table);
    if (!table || table.block !== 'crafting_table' || table.dimension !== mark.dimension ||
      ['x', 'y', 'z'].some((axis) => table[axis] !== mark.position[axis])) return undefined;
  }
  if (specification.requiresTable && !table) return undefined;
  return { ...cloneJson(payload), mark, ...(table ? { table } : {}) };
}

function validateCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) ||
    !Number.isFinite(candidate.pathCost) || candidate.pathCost < 0 ||
    !Number.isFinite(candidate.distance) || candidate.distance < 0 || !targetSchema(candidate)) {
    throw coded('TARGET_CANDIDATE_INVALID', 'Target candidates require finite path cost and distance plus a valid target');
  }
  return { ...candidate, dimension: canonicalDimension(candidate.dimension) };
}

function candidateOrder(left, right) {
  for (const key of ['pathCost', 'distance']) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  const a = targetSchema(left);
  const b = targetSchema(right);
  for (const axis of ['x', 'y', 'z']) if (a[axis] !== b[axis]) return a[axis] - b[axis];
  if (nonemptyString(left.id) && nonemptyString(right.id)) {
    if (left.id < right.id) return -1;
    if (left.id > right.id) return 1;
  }
  return 0;
}

function sortCandidates(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) throw coded('TARGET_CANDIDATE_INVALID', 'Target receipt requires at least one candidate');
  return candidates.map((candidate, index) => ({ candidate: validateCandidate(cloneJson(candidate)), index }))
    .sort((a, b) => candidateOrder(a.candidate, b.candidate) || a.index - b.index)
    .map(({ candidate }) => candidate);
}

function canonicalReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).length !== RECEIPT_FIELDS.size || Object.keys(value).some((key) => !RECEIPT_FIELDS.has(key)) ||
    !nonemptyString(value.receiptId) || !RECEIPT_KINDS.has(value.kind) ||
    !['productionId', 'takeId', 'attemptId', 'goalId', 'actorId'].every((key) => nonemptyString(value[key])) ||
    !safeNonnegativeInteger(value.observationVersion) || !safeNonnegativeInteger(value.expiresAt)) return undefined;
  const signature = canonicalSignature(value.signature);
  try {
    let payload = cloneJson(value.payload);
    if (value.kind === 'target' && (!targetSchema(payload.target) ||
      (payload.candidates !== undefined && (!Array.isArray(payload.candidates) || payload.candidates.some((candidate) => !targetSchema(candidate)))))) return undefined;
    if (value.kind === 'item' && !(payload = itemPayloadSchema(payload))) return undefined;
    if (value.kind === 'recipe' && !(payload = recipePayloadSchema(payload))) return undefined;
    return signature ? {
      receiptId: value.receiptId,
      kind: value.kind,
      productionId: value.productionId,
      takeId: value.takeId,
      attemptId: value.attemptId,
      goalId: value.goalId,
      actorId: value.actorId,
      observationVersion: value.observationVersion,
      expiresAt: value.expiresAt,
      payload,
      signature
    } : undefined;
  } catch {
    return undefined;
  }
}

function payloadFor(kind, input) {
  const payload = cloneJson(input?.payload ?? {});
  if (kind === 'item') {
    const normalized = itemPayloadSchema(payload);
    if (!normalized) throw coded('ITEM_SCHEMA_INVALID', 'Item receipts require a complete signed stack or drop identity');
    return normalized;
  }
  if (kind === 'recipe') {
    const normalized = recipePayloadSchema(payload);
    if (!normalized) throw coded('RECIPE_SCHEMA_INVALID', 'Recipe receipts require a fixed recipe, full mark, inputs, and output');
    return normalized;
  }
  const suppliedCandidates = input?.candidates ?? payload.candidates;
  if (suppliedCandidates !== undefined) {
    const candidates = sortCandidates(suppliedCandidates);
    payload.candidates = candidates;
    payload.target = cloneJson(candidates[0]);
  } else if (input?.target !== undefined) {
    payload.target = cloneJson(input.target);
  }
  const target = targetSchema(payload.target);
  if (!target) throw coded('TARGET_SCHEMA_INVALID', 'Target receipts require integral coordinates, block, and a known dimension');
  payload.target = { ...payload.target, ...target };
  return payload;
}

export function survivalReservationKey(kind, payload) {
  if (nonemptyString(payload?.reservationKey)) return `explicit:${payload.reservationKey}`;
  if (kind === 'target') {
    const target = payload?.target ?? payload?.candidates?.[0];
    const targetDetails = targetSchema(target);
    if (targetDetails) return `target:${targetDetails.dimension}:${targetDetails.x}:${targetDetails.y}:${targetDetails.z}`;
  }
  if (kind === 'item' && (nonemptyString(payload?.entityId) || safeNonnegativeInteger(payload?.entityId))) {
    return `item:${payload.entityId}`;
  }
  if (kind === 'recipe') {
    const mark = payload?.mark ?? payload?.tableMark ?? payload?.position;
    if (mark !== undefined) return `recipe:${stableJson(mark)}`;
  }
  return `${kind}:${stableJson(payload)}`;
}

function reservationKey(receipt) {
  return survivalReservationKey(receipt.kind, receipt.payload);
}

function frozenResult(value) {
  return Object.freeze(value);
}

export function createSurvivalAuthority({ clock, signingKey, maxReceiptAgeMs = 5000 } = {}) {
  const signingPrivateKey = privateSigningKey(signingKey);
  if (!signingPrivateKey) throw coded('SURVIVAL_SIGNING_KEY_REQUIRED', 'An Ed25519 private signing key is required');
  if (!Number.isSafeInteger(maxReceiptAgeMs) || maxReceiptAgeMs < MIN_RECEIPT_AGE_MS || maxReceiptAgeMs > MAX_RECEIPT_AGE_MS) {
    throw coded('RECEIPT_AGE_INVALID', `maxReceiptAgeMs must be an integer from ${MIN_RECEIPT_AGE_MS} to ${MAX_RECEIPT_AGE_MS}`);
  }
  const now = () => {
    const value = typeof clock === 'function' ? clock() : clock?.now?.();
    if (!safeNonnegativeInteger(value)) throw coded('SURVIVAL_CLOCK_INVALID', 'clock must return a nonnegative safe integer');
    return value;
  };
  const publicKey = createPublicKey(signingPrivateKey);
  const expectedKeyId = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  const issuedIds = new Set();
  const reservationsByKey = new Map();
  const reservationsByReceiptId = new Map();
  let nextReceiptId = 1;

  function issue(kind, input = {}) {
    const identity = ['productionId', 'takeId', 'attemptId', 'goalId', 'actorId'];
    if (!identity.every((key) => nonemptyString(input[key])) || !safeNonnegativeInteger(input.observationVersion)) {
      throw coded('RECEIPT_IDENTITY_INVALID', 'Receipt identity is incomplete or invalid');
    }
    const receiptId = input.receiptId ?? `survival-receipt-${nextReceiptId++}`;
    if (!nonemptyString(receiptId) || issuedIds.has(receiptId)) throw coded('RECEIPT_ID_INVALID', 'Receipt ID must be unique and nonempty');
    const issuedAt = now();
    const expiresAt = issuedAt + maxReceiptAgeMs;
    if (!safeNonnegativeInteger(expiresAt)) throw coded('SURVIVAL_CLOCK_INVALID', 'clock cannot represent a safe receipt expiry');
    const content = {
      receiptId,
      kind,
      productionId: input.productionId,
      takeId: input.takeId,
      attemptId: input.attemptId,
      goalId: input.goalId,
      actorId: input.actorId,
      observationVersion: input.observationVersion,
      expiresAt,
      payload: payloadFor(kind, input)
    };
    issuedIds.add(receiptId);
    return deepFreeze({ ...content, signature: signatureFor(content, signingPrivateKey) });
  }

  function issueTargetReceipt(input) {
    return issue('target', input);
  }

  function issueItemReceipt(input) {
    return issue('item', input);
  }

  function issueRecipeReceipt(input) {
    return issue('recipe', input);
  }

  function verifyReceipt(receipt, expected = {}) {
    const canonical = canonicalReceipt(receipt);
    if (!canonical) return frozenResult({ ok: false, code: 'RECEIPT_INVALID' });
    const { signature, ...content } = canonical;
    if (signature.keyId !== expectedKeyId || !asymmetricVerify(null, Buffer.from(stableJson(content)), publicKey, Buffer.from(signature.value, 'base64url'))) {
      return frozenResult({ ok: false, code: 'RECEIPT_SIGNATURE_INVALID' });
    }
    if (now() >= canonical.expiresAt) return frozenResult({ ok: false, code: 'RECEIPT_EXPIRED' });
    if (expected?.observationVersion !== undefined && expected.observationVersion !== canonical.observationVersion) {
      return frozenResult({ ok: false, code: 'RECEIPT_OBSERVATION_MISMATCH' });
    }
    for (const key of ['receiptId', 'kind', 'productionId', 'takeId', 'attemptId', 'goalId', 'actorId']) {
      if (expected?.[key] !== undefined && expected[key] !== canonical[key]) return frozenResult({ ok: false, code: 'RECEIPT_BINDING_MISMATCH' });
    }
    const expectedTarget = expected?.target ?? expected?.payload?.target;
    const expectedBlock = expected?.block ?? expectedTarget?.block;
    if (expectedTarget !== undefined || expectedBlock !== undefined) {
      const target = canonical.kind === 'target' ? targetSchema(canonical.payload.target) : undefined;
      const targetFence = expectedTarget === undefined ? undefined : expectedTargetSchema(expectedTarget);
      if (!target || (expectedTarget !== undefined && !targetFence) || (expectedBlock !== undefined && !nonemptyString(expectedBlock)) ||
        (targetFence && ['x', 'y', 'z', 'dimension'].some((key) => target[key] !== targetFence[key])) ||
        (targetFence?.block !== undefined && target.block !== targetFence.block) ||
        (expectedBlock !== undefined && target.block !== expectedBlock)) return frozenResult({ ok: false, code: 'RECEIPT_TARGET_MISMATCH' });
    }
    return frozenResult({ ok: true, receipt: deepFreeze(cloneJson(canonical)) });
  }

  function reserve(receipt, actorId) {
    const verified = verifyReceipt(receipt, { actorId });
    if (!verified.ok) return verified;
    const key = reservationKey(verified.receipt);
    if (reservationsByKey.has(key) || reservationsByReceiptId.has(verified.receipt.receiptId)) {
      return frozenResult({ ok: false, code: 'RESERVATION_CONFLICT' });
    }
    const reservation = deepFreeze({
      receiptId: verified.receipt.receiptId,
      reservationKey: key,
      kind: verified.receipt.kind,
      productionId: verified.receipt.productionId,
      takeId: verified.receipt.takeId,
      attemptId: verified.receipt.attemptId,
      goalId: verified.receipt.goalId,
      actorId: verified.receipt.actorId,
      observationVersion: verified.receipt.observationVersion,
      expiresAt: verified.receipt.expiresAt
    });
    reservationsByKey.set(key, reservation);
    reservationsByReceiptId.set(reservation.receiptId, reservation);
    return frozenResult({ ok: true, reservation: deepFreeze(cloneJson(reservation)) });
  }

  function release(receiptId, reason = 'released') {
    if (!nonemptyString(receiptId) || !nonemptyString(reason)) return frozenResult({ ok: false, code: 'RESERVATION_RELEASE_INVALID' });
    const reservation = reservationsByReceiptId.get(receiptId);
    if (!reservation) return frozenResult({ ok: false, code: 'RESERVATION_NOT_FOUND' });
    reservationsByReceiptId.delete(receiptId);
    reservationsByKey.delete(reservation.reservationKey);
    return frozenResult({ ok: true, receiptId, reason });
  }

  function snapshotReservations() {
    return deepFreeze([...reservationsByReceiptId.values()]
      .map((reservation) => cloneJson(reservation))
      .sort((a, b) => a.reservationKey.localeCompare(b.reservationKey) || a.receiptId.localeCompare(b.receiptId)));
  }

  return Object.freeze({
    issueTargetReceipt,
    issueItemReceipt,
    issueRecipeReceipt,
    verifyReceipt,
    reserve,
    release,
    snapshotReservations
  });
}

import { randomUUID } from 'node:crypto';

import { ShowrunnerError } from './errors.mjs';

const FENCE_IDENTITY_FIELDS = Object.freeze([
  'productionId',
  'takeId',
  'sceneId',
  'beatId',
  'attemptId',
  'cueId'
]);

const EVENT_IDENTITY_FIELDS = Object.freeze([
  ...FENCE_IDENTITY_FIELDS,
  'eventId',
  'causalSequence',
  'monotonicTimestamp'
]);

const IDENTITY_MISMATCH_REASONS = Object.freeze({
  productionId: 'WRONG_PRODUCTION',
  takeId: 'WRONG_TAKE',
  sceneId: 'WRONG_SCENE',
  beatId: 'WRONG_BEAT',
  attemptId: 'STALE_ATTEMPT',
  cueId: 'WRONG_CUE'
});

const MAX_KIND_LENGTH = 128;

function nonemptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function safeKind(value) {
  return nonemptyString(value) && value.length <= MAX_KIND_LENGTH && !/[\p{Cc}\p{Cs}]/u.test(value);
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validTimestamp(value) {
  return Number.isFinite(value) && value >= 0;
}

function immutable(value) {
  return Object.freeze(value);
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function invalidIdentity(message, details = {}) {
  return new ShowrunnerError('EVENT_IDENTITY_INVALID', message, details);
}

function invalidEnvelope(message, details = {}) {
  return new ShowrunnerError('EVENT_ENVELOPE_INVALID', message, details);
}

function invalidPayload(message, details = {}) {
  return new ShowrunnerError('EVENT_PAYLOAD_INVALID', message, details);
}

function fenceIdentity(identity) {
  if (identity === null || typeof identity !== 'object') {
    throw invalidIdentity('A fence identity is required.');
  }

  const result = {};
  for (const field of FENCE_IDENTITY_FIELDS) {
    if (!nonemptyString(identity[field])) {
      throw invalidIdentity(`Fence identity field ${field} is required.`, { field });
    }
    result[field] = identity[field];
  }
  return immutable(result);
}

function envelopeIdentity(identity) {
  if (identity === null || typeof identity !== 'object') {
    throw invalidEnvelope('An envelope identity is required.');
  }

  try {
    const result = {};
    for (const field of FENCE_IDENTITY_FIELDS) {
      const value = identity[field];
      if (!nonemptyString(value)) {
        throw invalidEnvelope(`Envelope identity field ${field} is required.`, { field });
      }
      result[field] = value;
    }
    const causalSequence = identity.causalSequence;
    if (!positiveSafeInteger(causalSequence)) {
      throw invalidEnvelope('Envelope causalSequence must be a positive safe integer.', { field: 'causalSequence' });
    }
    result.causalSequence = causalSequence;
    return immutable(result);
  } catch (error) {
    if (error instanceof ShowrunnerError) throw error;
    throw invalidEnvelope('Envelope identity is invalid.');
  }
}

function clockTimestamp(clock) {
  try {
    const timestamp = clock?.now?.();
    if (!validTimestamp(timestamp)) {
      throw invalidEnvelope('Envelope clock timestamp must be a finite nonnegative number.', { field: 'monotonicTimestamp' });
    }
    return timestamp;
  } catch (error) {
    if (error instanceof ShowrunnerError) throw error;
    throw invalidEnvelope('Envelope clock is invalid.');
  }
}

function eventIdentity(event) {
  if (event === null || typeof event !== 'object') return undefined;

  try {
    const result = { kind: event.kind };
    for (const field of EVENT_IDENTITY_FIELDS) result[field] = event[field];
    if (FENCE_IDENTITY_FIELDS.some((field) => !nonemptyString(result[field]))) return undefined;
    if (!nonemptyString(result.eventId)) return undefined;
    if (!safeKind(result.kind)) return undefined;
    if (!positiveSafeInteger(result.causalSequence)) return undefined;
    if (!validTimestamp(result.monotonicTimestamp)) return undefined;
    return result;
  } catch {
    return undefined;
  }
}

function rejected(reason, details = {}) {
  return immutable({ accepted: false, reason, ...details });
}

function accepted(record) {
  return immutable({ accepted: true, event: record });
}

function auditRecord(event) {
  return immutable({
    kind: event.kind,
    productionId: event.productionId,
    takeId: event.takeId,
    sceneId: event.sceneId,
    beatId: event.beatId,
    attemptId: event.attemptId,
    cueId: event.cueId,
    eventId: event.eventId,
    causalSequence: event.causalSequence,
    monotonicTimestamp: event.monotonicTimestamp
  });
}

function dataDescriptor(descriptor) {
  return descriptor && Object.hasOwn(descriptor, 'value') && !Object.hasOwn(descriptor, 'get') && !Object.hasOwn(descriptor, 'set');
}

function arrayIndex(key, length) {
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function cloneJsonValue(value, ancestors) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object') throw invalidPayload('Payload must contain only JSON-safe values.');
  if (ancestors.has(value)) throw invalidPayload('Payload cannot contain cycles.');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw invalidPayload('Payload array prototype is invalid.');
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const lengthDescriptor = descriptors.length;
      if (!dataDescriptor(lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
        throw invalidPayload('Payload array length is invalid.');
      }
      const length = lengthDescriptor.value;
      for (const key of Reflect.ownKeys(value)) {
        if (key === 'length') continue;
        if (typeof key !== 'string' || !arrayIndex(key, length)) throw invalidPayload('Payload array has non-JSON properties.');
      }
      const result = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!dataDescriptor(descriptor)) throw invalidPayload('Payload arrays cannot contain holes or accessors.');
        result.push(cloneJsonValue(descriptor.value, ancestors));
      }
      return result;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw invalidPayload('Payload object prototype is invalid.');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw invalidPayload('Payload symbol keys are invalid.');
      const descriptor = descriptors[key];
      if (!dataDescriptor(descriptor) || !descriptor.enumerable) {
        throw invalidPayload('Payload objects must use enumerable data properties.');
      }
      Object.defineProperty(result, key, {
        value: cloneJsonValue(descriptor.value, ancestors), enumerable: true, configurable: true, writable: true
      });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function cloneJsonPayload(payload) {
  try {
    const result = cloneJsonValue(payload, new WeakSet());
    structuredClone(payload);
    return deepFreeze(result);
  } catch (error) {
    if (error instanceof ShowrunnerError) throw error;
    throw invalidPayload('Payload is not JSON-safe.');
  }
}

/**
 * Creates the immutable event values exchanged during a single showrunner take.
 */
export function createEnvelope(kind, identity, payload, clock = performance) {
  if (!safeKind(kind)) throw invalidEnvelope('Envelope kind must be a bounded safe primitive string.', { field: 'kind' });
  const envelopeIdentitySnapshot = envelopeIdentity(identity);
  return immutable({
    kind,
    ...envelopeIdentitySnapshot,
    eventId: randomUUID(),
    monotonicTimestamp: clockTimestamp(clock),
    payload: cloneJsonPayload(payload)
  });
}

/**
 * A replay-key ledger is intentionally an instance per active take. Creating a
 * new ledger for the next take drops the prior take's bounded set of keys.
 */
export class IdempotencyLedger {
  #keys = new Set();
  #active = true;

  constructor(takeId = 'active-take') {
    if (!nonemptyString(takeId)) throw invalidIdentity('A ledger takeId is required.', { field: 'takeId' });
    this.takeId = takeId;
  }

  claim(key) {
    if (!this.#active || !nonemptyString(key) || this.#keys.has(key)) return false;
    this.#keys.add(key);
    return true;
  }

  close() {
    this.#active = false;
    this.#keys.clear();
  }
}

/**
 * Accepts only events for one exact attempt and its next causal sequence.
 */
export class AttemptFence {
  #identity;
  #sequence = 0;
  #revocationReason;
  #seenEventIds = new Set();
  #events = [];
  #idempotencyLedger;

  static start(identity) {
    return new AttemptFence(identity);
  }

  constructor(identity) {
    this.#identity = fenceIdentity(identity);
    this.#idempotencyLedger = new IdempotencyLedger(this.#identity.takeId);
  }

  get identity() {
    return this.#identity;
  }

  get sequence() {
    return this.#sequence;
  }

  get revoked() {
    return this.#revocationReason !== undefined;
  }

  get events() {
    return immutable([...this.#events]);
  }

  get idempotencyLedger() {
    return this.#idempotencyLedger;
  }

  revoke(reason = 'REVOKED') {
    if (this.#revocationReason === undefined) {
      this.#revocationReason = reason;
      this.#seenEventIds.clear();
      this.#idempotencyLedger.close();
    }
    return immutable({ revoked: true, reason: this.#revocationReason });
  }

  accept(event) {
    try {
      return this.#accept(event);
    } catch {
      return rejected('INVALID_EVENT');
    }
  }

  #accept(event) {
    if (this.#revocationReason !== undefined) {
      return rejected('ATTEMPT_REVOKED', { revocationReason: this.#revocationReason });
    }

    const candidate = eventIdentity(event);
    if (!candidate) return rejected('INVALID_EVENT');

    for (const field of FENCE_IDENTITY_FIELDS) {
      if (candidate[field] !== this.#identity[field]) return rejected(IDENTITY_MISMATCH_REASONS[field]);
    }

    if (this.#seenEventIds.has(candidate.eventId)) return rejected('DUPLICATE_EVENT');
    if (candidate.causalSequence !== this.#sequence + 1) return rejected('OUT_OF_ORDER');

    const record = auditRecord(candidate);
    this.#seenEventIds.add(candidate.eventId);
    this.#sequence = candidate.causalSequence;
    this.#events.push(record);
    return accepted(record);
  }
}

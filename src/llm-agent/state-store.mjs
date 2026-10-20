import { randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import path from 'node:path';

import { validateActorState } from './contracts.mjs';

const ACTOR_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const LEASE_OWNER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_LEASE_DURATION_MS = 300_000;
const leaseQueues = new Map();

function invalidActorId(actorId) {
  const error = new Error('actorId must match /^[A-Za-z0-9_-]{1,32}$/');
  error.code = 'LLM_AGENT_STATE_INVALID';
  error.actorId = actorId;
  return error;
}

function invalidState(message) {
  const error = new Error(message);
  error.code = 'LLM_AGENT_STATE_INVALID';
  return error;
}

function writeFailed(cause) {
  const error = new Error('failed to persist actor state', { cause });
  error.code = 'LLM_AGENT_STATE_WRITE_FAILED';
  return error;
}

function leaseError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function validateActorId(actorId) {
  if (typeof actorId !== 'string' || !ACTOR_ID_PATTERN.test(actorId)) throw invalidActorId(actorId);
  return actorId;
}

function normalizeLease(actorId, { ownerId, acquiredAt, expiresAt } = {}) {
  if (typeof ownerId !== 'string' || !LEASE_OWNER_PATTERN.test(ownerId)) {
    throw leaseError('LLM_AGENT_LEASE_INVALID', 'lease ownerId is invalid');
  }
  const acquiredMilliseconds = Date.parse(acquiredAt);
  const expiresMilliseconds = Date.parse(expiresAt);
  if (!Number.isFinite(acquiredMilliseconds) || !Number.isFinite(expiresMilliseconds)
    || expiresMilliseconds <= acquiredMilliseconds
    || expiresMilliseconds - acquiredMilliseconds > MAX_LEASE_DURATION_MS) {
    throw leaseError('LLM_AGENT_LEASE_INVALID', 'lease timestamps are invalid');
  }
  return Object.freeze({ actorId, ownerId, acquiredAt, expiresAt });
}

function parseLease(source, actorId) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw leaseError('LLM_AGENT_LEASE_INVALID', 'runtime lease JSON is invalid', cause);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).sort().join(',') !== 'acquiredAt,actorId,expiresAt,ownerId') {
    throw leaseError('LLM_AGENT_LEASE_INVALID', 'runtime lease fields are invalid');
  }
  if (parsed.actorId !== actorId) throw leaseError('LLM_AGENT_LEASE_INVALID', 'runtime lease actor does not match');
  return normalizeLease(actorId, parsed);
}

async function serializeLease(filePath, operation) {
  const previous = leaseQueues.get(filePath) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  leaseQueues.set(filePath, current);
  try {
    return await current;
  } finally {
    if (leaseQueues.get(filePath) === current) leaseQueues.delete(filePath);
  }
}

export function createActorStateStore({ directory, fsImpl = nodeFs } = {}) {
  const stateDirectory = path.resolve(directory);

  function recordPath(actorId) {
    validateActorId(actorId);
    return path.join(stateDirectory, `${actorId}.json`);
  }

  function leasePath(actorId) {
    validateActorId(actorId);
    return path.join(stateDirectory, `${actorId}.lease.json`);
  }

  async function load(actorId) {
    const filePath = recordPath(actorId);
    let source;
    try {
      source = await fsImpl.readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }

    let parsed;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      throw invalidState(`actor state JSON is invalid: ${error.message}`);
    }

    const validated = validateActorState(parsed);
    if (validated.identity.actorId !== actorId) {
      throw invalidState('actor state identity does not match its actor record');
    }
    return validated;
  }

  async function syncDirectory() {
    let handle;
    try {
      handle = await fsImpl.open(stateDirectory, 'r');
      await handle.sync();
    } catch {
      // Directory syncing is a durability enhancement and is best effort.
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // The completed rename remains the source of truth if close fails.
        }
      }
    }
  }

  async function writeLeaseExclusive(filePath, lease) {
    let handle;
    let created = false;
    try {
      handle = await fsImpl.open(filePath, 'wx', 0o600);
      created = true;
      await handle.writeFile(`${JSON.stringify(lease)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await syncDirectory();
    } catch (error) {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // Preserve the lease creation failure.
        }
      }
      if (created) {
        try {
          await fsImpl.unlink(filePath);
        } catch {
          // Preserve the lease creation failure.
        }
      }
      throw error;
    }
  }

  async function acquireLease(actorId, leaseOptions) {
    const filePath = leasePath(actorId);
    const requested = normalizeLease(actorId, leaseOptions);
    return serializeLease(filePath, async () => {
      await fsImpl.mkdir(stateDirectory, { recursive: true });
      for (;;) {
        try {
          await writeLeaseExclusive(filePath, requested);
          return requested;
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error;
        }

        let existing;
        try {
          existing = parseLease(await fsImpl.readFile(filePath, 'utf8'), actorId);
        } catch (error) {
          if (error?.code === 'ENOENT') continue;
          throw error;
        }
        if (Date.parse(existing.expiresAt) > Date.parse(requested.acquiredAt)) {
          throw leaseError('LLM_AGENT_LEASE_HELD', 'actor runtime lease is already held');
        }

        const stalePath = `${filePath}.stale-${process.pid}-${randomUUID()}`;
        try {
          await fsImpl.rename(filePath, stalePath);
        } catch (error) {
          if (error?.code === 'ENOENT') continue;
          throw error;
        }
        try {
          await writeLeaseExclusive(filePath, requested);
          return requested;
        } catch (error) {
          if (error?.code === 'EEXIST') {
            throw leaseError('LLM_AGENT_LEASE_HELD', 'actor runtime lease was claimed concurrently');
          }
          throw error;
        } finally {
          try {
            await fsImpl.unlink(stalePath);
          } catch {
            // The replacement lease remains authoritative if stale cleanup fails.
          }
        }
      }
    });
  }

  async function releaseLease(actorId, ownerId) {
    const filePath = leasePath(actorId);
    if (typeof ownerId !== 'string' || !LEASE_OWNER_PATTERN.test(ownerId)) {
      throw leaseError('LLM_AGENT_LEASE_INVALID', 'lease ownerId is invalid');
    }
    return serializeLease(filePath, async () => {
      let existing;
      try {
        existing = parseLease(await fsImpl.readFile(filePath, 'utf8'), actorId);
      } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
      }
      if (existing.ownerId !== ownerId) return false;
      try {
        await fsImpl.unlink(filePath);
      } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
      }
      await syncDirectory();
      return true;
    });
  }

  async function save(actorId, state) {
    const filePath = recordPath(actorId);
    const validated = validateActorState(state);
    if (validated.identity.actorId !== actorId) {
      throw invalidState('actor state identity does not match its actor record');
    }

    const temporaryPath = path.resolve(
      `${filePath}.tmp-${process.pid}-${randomUUID()}`
    );
    const serialized = `${JSON.stringify(validated)}\n`;
    let fileHandle;
    try {
      fileHandle = await fsImpl.open(temporaryPath, 'wx', 0o600);
      await fileHandle.writeFile(serialized, 'utf8');
      await fileHandle.sync();
      await fileHandle.close();
      fileHandle = null;
      await fsImpl.rename(temporaryPath, filePath);
      await syncDirectory();
    } catch (cause) {
      if (fileHandle) {
        try {
          await fileHandle.close();
        } catch {
          // Preserve the original write failure.
        }
      }
      try {
        await fsImpl.unlink(temporaryPath);
      } catch {
        // Preserve the original write failure even if cleanup fails.
      }
      throw writeFailed(cause);
    }
  }

  async function reset(actorId) {
    const filePath = recordPath(actorId);
    try {
      await fsImpl.unlink(filePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  return Object.freeze({ load, save, reset, acquireLease, releaseLease });
}

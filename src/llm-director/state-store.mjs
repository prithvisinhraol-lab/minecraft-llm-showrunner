import { randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import path from 'node:path';

import { validateDirectorState } from './contracts.mjs';

const ACTOR_ID = /^[A-Za-z0-9_-]{1,32}$/;
const OWNER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_LEASE_MS = 405_000;
const queues = new Map();

function coded(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function actor(actorId) {
  if (typeof actorId !== 'string' || !ACTOR_ID.test(actorId)) throw coded('LLM_DIRECTOR_STATE_INVALID', 'actorId is invalid');
  return actorId;
}

function lease(actorId, value) {
  if (!value || typeof value !== 'object' || !OWNER_ID.test(value.ownerId ?? '')) {
    throw coded('LLM_DIRECTOR_LEASE_INVALID', 'lease owner is invalid');
  }
  const acquired = Date.parse(value.acquiredAt);
  const expires = Date.parse(value.expiresAt);
  if (!Number.isFinite(acquired) || !Number.isFinite(expires) || expires <= acquired || expires - acquired > MAX_LEASE_MS) {
    throw coded('LLM_DIRECTOR_LEASE_INVALID', 'lease timestamps are invalid');
  }
  return { actorId, ownerId: value.ownerId, acquiredAt: value.acquiredAt, expiresAt: value.expiresAt };
}

async function serial(key, operation) {
  const prior = queues.get(key) ?? Promise.resolve();
  const current = prior.catch(() => {}).then(operation);
  queues.set(key, current);
  try {
    return await current;
  } finally {
    if (queues.get(key) === current) queues.delete(key);
  }
}

export function createDirectorStateStore({ directory, fsImpl = nodeFs } = {}) {
  const root = path.resolve(directory);
  const recordPath = (actorId) => path.join(root, `${actor(actorId)}.json`);
  const leasePath = (actorId) => path.join(root, `${actor(actorId)}.director.lease.json`);

  async function load(actorId) {
    let source;
    try {
      source = await fsImpl.readFile(recordPath(actorId), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(source);
    } catch (cause) {
      throw coded('LLM_DIRECTOR_STATE_INVALID', 'director state JSON is invalid', cause);
    }
    const validated = validateDirectorState(parsed);
    if (validated.identity.actorId !== actorId) throw coded('LLM_DIRECTOR_STATE_INVALID', 'director state actor does not match');
    return validated;
  }

  async function save(actorId, state) {
    const file = recordPath(actorId);
    const validated = validateDirectorState(state);
    if (validated.identity.actorId !== actorId) throw coded('LLM_DIRECTOR_STATE_INVALID', 'director state actor does not match');
    const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
    await fsImpl.mkdir(root, { recursive: true });
    let handle;
    try {
      handle = await fsImpl.open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(validated)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fsImpl.rename(temporary, file);
    } catch (cause) {
      try { await handle?.close(); } catch {}
      try { await fsImpl.unlink(temporary); } catch {}
      throw coded('LLM_DIRECTOR_STATE_WRITE_FAILED', 'failed to persist director state', cause);
    }
  }

  async function reset(actorId) {
    try { await fsImpl.unlink(recordPath(actorId)); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }

  async function readLease(file, actorId) {
    const parsed = JSON.parse(await fsImpl.readFile(file, 'utf8'));
    if (parsed.actorId !== actorId) throw coded('LLM_DIRECTOR_LEASE_INVALID', 'lease actor does not match');
    return lease(actorId, parsed);
  }

  async function acquireLease(actorId, options) {
    const file = leasePath(actorId);
    const requested = lease(actorId, options);
    return serial(file, async () => {
      await fsImpl.mkdir(root, { recursive: true });
      let existing;
      try { existing = await readLease(file, actorId); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      if (existing && Date.parse(existing.expiresAt) > Date.parse(requested.acquiredAt)) {
        throw coded('LLM_DIRECTOR_LEASE_HELD', 'director lease is already held');
      }
      const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
      await fsImpl.writeFile(temporary, `${JSON.stringify(requested)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fsImpl.rename(temporary, file);
      return requested;
    });
  }

  async function releaseLease(actorId, ownerId) {
    const file = leasePath(actorId);
    if (!OWNER_ID.test(ownerId ?? '')) throw coded('LLM_DIRECTOR_LEASE_INVALID', 'lease owner is invalid');
    return serial(file, async () => {
      let existing;
      try { existing = await readLease(file, actorId); } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
      if (existing.ownerId !== ownerId) return false;
      try { await fsImpl.unlink(file); } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
      return true;
    });
  }

  return Object.freeze({ load, save, reset, acquireLease, releaseLease });
}

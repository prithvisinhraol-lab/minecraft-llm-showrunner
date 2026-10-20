import { randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import path from 'node:path';

import { validatePipelineState } from './state.mjs';

const ACTOR_ID = /^[A-Za-z0-9_-]{1,32}$/;
const OWNER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_LEASE_MS = 900_000;
const queues = new Map();

function coded(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function actor(value) {
  if (typeof value !== 'string' || !ACTOR_ID.test(value)) throw coded('PIPELINE_STATE_INVALID', 'actorId is invalid');
  return value;
}

function validateLease(actorId, value) {
  if (!value || typeof value !== 'object' || !OWNER_ID.test(value.ownerId ?? '')) throw coded('PIPELINE_LEASE_INVALID', 'lease owner is invalid');
  const acquired = Date.parse(value.acquiredAt);
  const expires = Date.parse(value.expiresAt);
  if (!Number.isFinite(acquired) || !Number.isFinite(expires) || expires <= acquired || expires - acquired > MAX_LEASE_MS) {
    throw coded('PIPELINE_LEASE_INVALID', 'lease timestamps are invalid');
  }
  return { actorId, ownerId: value.ownerId, acquiredAt: value.acquiredAt, expiresAt: value.expiresAt };
}

async function serial(key, operation) {
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  queues.set(key, current);
  try { return await current; } finally { if (queues.get(key) === current) queues.delete(key); }
}

function regression(previous, next) {
  if (!previous) return false;
  if (next.mission.version < previous.mission.version) return true;
  return Object.keys(next.counters).some((key) => next.counters[key] < previous.counters[key]);
}

export function createPipelineStateStore({ directory, fsImpl = nodeFs } = {}) {
  if (typeof directory !== 'string' || directory.length === 0) throw new TypeError('directory must be a nonempty string');
  const root = path.resolve(directory);
  const recordPath = (actorId) => path.join(root, `${actor(actorId)}.pipeline.json`);
  const leasePath = (actorId) => path.join(root, `${actor(actorId)}.pipeline.lease.json`);

  async function load(actorId) {
    let source;
    try { source = await fsImpl.readFile(recordPath(actorId), 'utf8'); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
    let parsed;
    try { parsed = JSON.parse(source); }
    catch (cause) { throw coded('PIPELINE_STATE_INVALID', 'pipeline state JSON is invalid', cause); }
    if (parsed?.identity?.schemaVersion === 1 && !Object.hasOwn(parsed, 'audit')) parsed.audit = [];
    const validated = validatePipelineState(parsed);
    if (validated.identity.actorId !== actorId) throw coded('PIPELINE_STATE_INVALID', 'pipeline state actor does not match');
    return validated;
  }

  async function atomicWrite(file, value, code) {
    const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
    await fsImpl.mkdir(root, { recursive: true });
    let handle;
    try {
      handle = await fsImpl.open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fsImpl.rename(temporary, file);
      try {
        const directoryHandle = await fsImpl.open(root, 'r');
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      } catch { /* Directory fsync is best effort on platforms that reject it. */ }
    } catch (cause) {
      try { await handle?.close(); } catch {}
      try { await fsImpl.unlink(temporary); } catch {}
      throw coded(code, 'failed to persist pipeline state', cause);
    }
  }

  async function save(actorId, state) {
    const file = recordPath(actorId);
    const validated = validatePipelineState(state);
    if (validated.identity.actorId !== actorId) throw coded('PIPELINE_STATE_INVALID', 'pipeline state actor does not match');
    return serial(file, async () => {
      const previous = await load(actorId);
      if (regression(previous, validated)) throw coded('PIPELINE_STATE_REGRESSION', 'pipeline counters or mission version moved backward');
      await atomicWrite(file, validated, 'PIPELINE_STATE_WRITE_FAILED');
    });
  }

  async function reset(actorId) {
    const file = recordPath(actorId);
    return serial(file, async () => {
      try { await fsImpl.unlink(file); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    });
  }

  async function readLease(file, actorId) {
    let parsed;
    try { parsed = JSON.parse(await fsImpl.readFile(file, 'utf8')); }
    catch (error) { if (error?.code === 'ENOENT') throw error; throw coded('PIPELINE_LEASE_INVALID', 'lease JSON is invalid', error); }
    if (parsed.actorId !== actorId) throw coded('PIPELINE_LEASE_INVALID', 'lease actor does not match');
    return validateLease(actorId, parsed);
  }

  async function acquireLease(actorId, options) {
    const file = leasePath(actorId);
    const requested = validateLease(actor(actorId), options);
    return serial(file, async () => {
      await fsImpl.mkdir(root, { recursive: true });
      let existing;
      try { existing = await readLease(file, actorId); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      if (existing && Date.parse(existing.expiresAt) > Date.parse(requested.acquiredAt)) {
        throw coded('PIPELINE_LEASE_HELD', 'pipeline lease is already held');
      }
      await atomicWrite(file, requested, 'PIPELINE_LEASE_WRITE_FAILED');
      return requested;
    });
  }

  async function releaseLease(actorId, ownerId) {
    const file = leasePath(actorId);
    if (!OWNER_ID.test(ownerId ?? '')) throw coded('PIPELINE_LEASE_INVALID', 'lease owner is invalid');
    return serial(file, async () => {
      let existing;
      try { existing = await readLease(file, actorId); }
      catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
      if (existing.ownerId !== ownerId) return false;
      try { await fsImpl.unlink(file); } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
      return true;
    });
  }

  return Object.freeze({ load, save, reset, acquireLease, releaseLease });
}

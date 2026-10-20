import { randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import path from 'node:path';

import { validateSurvivalDemoState } from './survival-demo-contracts.mjs';

const OWNER = /^[A-Za-z0-9_-]{1,128}$/;
const MAXIMUM_LEASE_MS = 20 * 60 * 1_000;
const queues = new Map();

function coded(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function currentMilliseconds(clock) {
  const value = clock?.now?.();
  if (typeof value !== 'number' || !Number.isFinite(value)) throw coded('SURVIVAL_DEMO_STORE_INVALID', 'clock is invalid');
  return value;
}

function validateOwner(owner) {
  if (typeof owner !== 'string' || !OWNER.test(owner)) throw coded('SURVIVAL_DEMO_LEASE_INVALID', 'lease owner is invalid');
}

function parseLease(source) {
  let value;
  try { value = JSON.parse(source); }
  catch (cause) { throw coded('SURVIVAL_DEMO_LEASE_INVALID', 'lease JSON is invalid', cause); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'acquiredAt,expiresAt,owner'
    || typeof value.owner !== 'string' || !OWNER.test(value.owner)
    || !Number.isFinite(value.acquiredAt) || !Number.isFinite(value.expiresAt)
    || value.expiresAt <= value.acquiredAt || value.expiresAt - value.acquiredAt > MAXIMUM_LEASE_MS) {
    throw coded('SURVIVAL_DEMO_LEASE_INVALID', 'lease fields are invalid');
  }
  return value;
}

async function serialized(key, operation) {
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  queues.set(key, current);
  try { return await current; }
  finally { if (queues.get(key) === current) queues.delete(key); }
}

export function createSurvivalDemoStore({
  directory,
  fsImpl = nodeFs,
  clock = { now: () => Date.now() },
  leaseDurationMs = MAXIMUM_LEASE_MS
} = {}) {
  if (typeof directory !== 'string' || directory.length === 0) throw new TypeError('directory must be a nonempty string');
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1 || leaseDurationMs > MAXIMUM_LEASE_MS) {
    throw new TypeError(`leaseDurationMs must be between 1 and ${MAXIMUM_LEASE_MS}`);
  }
  const root = path.resolve(directory);
  const statePath = path.join(root, 'state.json');
  const leasePath = path.join(root, 'lease.json');

  async function syncDirectory() {
    let handle;
    try {
      handle = await fsImpl.open(root, 'r');
      await handle.sync();
    } catch {
      // The atomic rename remains authoritative if directory fsync is unavailable.
    } finally {
      try { await handle?.close(); } catch {}
    }
  }

  async function load() {
    let source;
    try { source = await fsImpl.readFile(statePath, 'utf8'); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
    try { return validateSurvivalDemoState(JSON.parse(source)); }
    catch (error) {
      if (error?.code === 'SURVIVAL_DEMO_STATE_INVALID') throw error;
      throw coded('SURVIVAL_DEMO_STATE_INVALID', 'persisted state JSON is invalid', error);
    }
  }

  async function save(value) {
    const validated = validateSurvivalDemoState(value);
    await fsImpl.mkdir(root, { recursive: true });
    const temporary = `${statePath}.tmp-${process.pid}-${randomUUID()}`;
    let handle;
    try {
      handle = await fsImpl.open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(validated)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fsImpl.rename(temporary, statePath);
      await syncDirectory();
    } catch (cause) {
      try { await handle?.close(); } catch {}
      try { await fsImpl.unlink(temporary); } catch {}
      throw coded('SURVIVAL_DEMO_STATE_WRITE_FAILED', 'failed to persist survival demo state', cause);
    }
  }

  async function writeLease(value) {
    let handle;
    try {
      handle = await fsImpl.open(leasePath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await syncDirectory();
    } catch (error) {
      try { await handle?.close(); } catch {}
      throw error;
    }
  }

  async function acquireLease(owner) {
    validateOwner(owner);
    return serialized(leasePath, async () => {
      await fsImpl.mkdir(root, { recursive: true });
      const acquiredAt = currentMilliseconds(clock);
      const requested = { owner, acquiredAt, expiresAt: acquiredAt + leaseDurationMs };
      for (;;) {
        try { await writeLease(requested); return true; }
        catch (error) { if (error?.code !== 'EEXIST') throw error; }
        let existing;
        try { existing = parseLease(await fsImpl.readFile(leasePath, 'utf8')); }
        catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
        if (existing.expiresAt > acquiredAt) return false;
        const stale = `${leasePath}.stale-${process.pid}-${randomUUID()}`;
        try { await fsImpl.rename(leasePath, stale); }
        catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
        try {
          await writeLease(requested);
          return true;
        } catch (error) {
          if (error?.code === 'EEXIST') return false;
          throw error;
        } finally {
          try { await fsImpl.unlink(stale); } catch {}
        }
      }
    });
  }

  async function releaseLease(owner) {
    validateOwner(owner);
    return serialized(leasePath, async () => {
      let existing;
      try { existing = parseLease(await fsImpl.readFile(leasePath, 'utf8')); }
      catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
      if (existing.owner !== owner) return false;
      try { await fsImpl.unlink(leasePath); }
      catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
      await syncDirectory();
      return true;
    });
  }

  async function reset() {
    try { await fsImpl.unlink(statePath); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }

  return Object.freeze({ load, save, acquireLease, releaseLease, reset });
}

import { randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import path from 'node:path';

const ACTOR_ID = /^[A-Za-z0-9_-]{1,32}$/;
const CONTRACT_ID = /^[A-Za-z0-9_.:/-]{1,100}$/;

function coded(message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = 'PIPELINE_LIVE_EVIDENCE_INVALID';
  return error;
}

function validateRecord(value) {
  const contractId = value?.contract?.contractId;
  const proofKinds = value?.outcome?.proofKinds;
  if (!CONTRACT_ID.test(contractId ?? '') || value?.outcome?.status !== 'succeeded'
    || !Array.isArray(proofKinds) || proofKinds.length === 0
    || !proofKinds.every((entry) => typeof entry === 'string' && CONTRACT_ID.test(entry))) {
    throw coded('verified outcome record is invalid');
  }
  const facts = Array.isArray(value?.result?.facts) ? value.result.facts : [];
  const inventory = facts.filter((fact) => fact?.predicate === 'inventory_at_least'
    && typeof fact.item === 'string' && CONTRACT_ID.test(fact.item)
    && Number.isSafeInteger(fact.actual) && fact.actual >= 0)
    .map((fact) => ({ item: fact.item, count: fact.actual }));
  return { contractId, status: 'succeeded', proofKinds: [...proofKinds], inventory };
}

function validateEvidence(value, actorId) {
  if (!value || value.source !== 'mineflayer-live' || value.simulated !== false
    || value.provider !== 'codex' || value.actorId !== actorId
    || !Array.isArray(value.contracts) || !Array.isArray(value.inventory)
    || typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt))) {
    throw coded('persisted live evidence is invalid');
  }
  return value;
}

export function createPipelineLiveEvidenceStore({ directory, actorId, fsImpl = nodeFs, clock = { now: () => Date.now() } } = {}) {
  if (typeof directory !== 'string' || directory.length === 0) throw new TypeError('directory must be a nonempty string');
  if (!ACTOR_ID.test(actorId ?? '')) throw new TypeError('actorId is invalid');
  if (!clock || typeof clock.now !== 'function') throw new TypeError('clock.now must be a function');
  const root = path.resolve(directory);
  const file = path.join(root, `${actorId}.pipeline.live-evidence.json`);
  let queue = Promise.resolve();

  async function load() {
    let source;
    try { source = await fsImpl.readFile(file, 'utf8'); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
    try { return structuredClone(validateEvidence(JSON.parse(source), actorId)); }
    catch (cause) { if (cause?.code === 'PIPELINE_LIVE_EVIDENCE_INVALID') throw cause; throw coded('persisted live evidence JSON is invalid', cause); }
  }

  async function atomicWrite(value) {
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
    } catch (cause) {
      try { await handle?.close(); } catch {}
      try { await fsImpl.unlink(temporary); } catch {}
      throw coded('failed to persist live evidence', cause);
    }
  }

  function record(value) {
    const operation = queue.then(async () => {
      const next = validateRecord(value);
      const previous = await load();
      const inventory = new Map((previous?.inventory ?? []).map((entry) => [entry.item, entry.count]));
      for (const entry of next.inventory) inventory.set(entry.item, Math.max(inventory.get(entry.item) ?? 0, entry.count));
      const evidence = {
        source: 'mineflayer-live', simulated: false, provider: 'codex', actorId,
        observedAt: new Date(clock.now()).toISOString(),
        contracts: [...(previous?.contracts ?? []), {
          contractId: next.contractId, status: next.status, proofKinds: next.proofKinds
        }].slice(-5),
        inventory: [...inventory].map(([item, count]) => ({ item, count })).slice(-32)
      };
      await atomicWrite(evidence);
      return structuredClone(evidence);
    });
    queue = operation.catch(() => {});
    return operation;
  }

  function reset() {
    const operation = queue.then(async () => {
      try { await fsImpl.unlink(file); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    });
    queue = operation.catch(() => {});
    return operation;
  }

  return Object.freeze({ load, record, reset });
}

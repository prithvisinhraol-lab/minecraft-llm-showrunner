import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { signApprovedBank, sourceEpisodeHash } from '../src/showrunner/approved-bank.mjs';
import { createActorRuntime } from '../src/showrunner/actor-runtime.mjs';
import { createArtifactWriter } from '../src/showrunner/artifacts.mjs';
import { resetToBaseline } from '../src/showrunner/baseline.mjs';
import { createCaptureSession } from '../src/showrunner/capture.mjs';
import { runCliCommand } from '../src/showrunner/cli.mjs';
import { approveCandidateBank } from '../src/showrunner/rehearsal.mjs';
import { loadEpisode } from '../src/showrunner/schema.mjs';
import { createShowrunner } from '../src/showrunner/state-machine.mjs';

function errorWithCode(code) {
  return Object.assign(new Error(code), { code });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function plannerEvidence(overrides = {}) {
  return {
    sceneId: 'confrontation',
    beatId: 'rival_reveal',
    attemptId: 'attempt-2',
    cueId: 'rival_reveal',
    eventId: 'planner-event-1',
    causalSequence: 1,
    monotonicTimestamp: 100,
    goalId: 'gather-hero-log',
    actor: 'hero',
    observationVersion: 1,
    replanCount: 0,
    reservations: [],
    decision: {
      status: 'action',
      reason: 'TARGET_AVAILABLE',
      observationVersion: 1,
      action: {
        name: 'moveNearTarget',
        payload: {
          actor: 'hero', goalId: 'gather-hero-log', targetId: 'tree-a', region: 'hero-tree', block: 'oak_log'
        }
      }
    },
    ...overrides
  };
}

async function appendLinkedEvidence(writer) {
  await writer.appendSurvivalObservation(survivalEvidence({
    eventId: 'source-observation-event', causalSequence: 1, monotonicTimestamp: 100,
    observationVersion: 1, phase: 'after'
  }));
  await writer.appendPlannerDecision(plannerEvidence({
    eventId: 'planner-event-1', causalSequence: 2, monotonicTimestamp: 101,
    observationVersion: 1
  }));
  await writer.appendSurvivalObservation(survivalEvidence({
    eventId: 'post-action-observation-event', causalSequence: 3, monotonicTimestamp: 102,
    observationVersion: 2, phase: 'after'
  }));
}

function survivalEvidence(overrides = {}) {
  return {
    sceneId: 'confrontation',
    beatId: 'rival_reveal',
    attemptId: 'attempt-2',
    cueId: 'rival_reveal',
    eventId: 'observation-event-1',
    causalSequence: 2,
    monotonicTimestamp: 101,
    goalId: 'gather-hero-log',
    actor: 'hero',
    phase: 'after',
    authoritative: true,
    observationVersion: 1,
    dimension: 'minecraft:overworld',
    position: { x: 1, y: 64, z: 1 },
    inventory: { oak_log: 1 },
    equipment: {},
    ...overrides
  };
}

function rootedArtifactHost(rootPath, operations = []) {
  const canonicalRootPath = path.resolve(rootPath);
  const rootIdentity = Object.freeze({ dev: 41, ino: 73 });
  const files = new Map();
  let queue = Promise.resolve();
  let redirectNext = false;
  let beforeNextDecisionCommit;
  let heldStatusCas;
  let heldStateRead;
  let heldDecisionCommit;
  let interruptAfterNextDecisionCommit = false;
  let stateSnapshotVersion = 0;

  function relative(value) {
    if (typeof value !== 'string' || value.length === 0 || path.isAbsolute(value) ||
        value === '..' || value.startsWith(`..${path.sep}`)) throw errorWithCode('EINVAL');
    return path.normalize(value);
  }

  function proof(relativePath, extra = {}) {
    return {
      canonicalRootPath,
      canonicalPath: path.join(canonicalRootPath, relativePath),
      rootIdentity,
      ...extra
    };
  }

  function serialized(kind, input, operation) {
    assert.equal(input.rootPath, rootPath);
    const relativePath = relative(input.relativePath);
    operations.push({ kind, relativePath, flags: input.flags, guardAbsentRelativePath: input.guardAbsentRelativePath });
    const result = queue.then(() => {
      if (redirectNext) {
        redirectNext = false;
        return {
          ...proof(relativePath),
          canonicalPath: path.join(path.dirname(canonicalRootPath), 'outside', relativePath),
          rootIdentity: { dev: 99, ino: 100 }
        };
      }
      return operation(relativePath);
    });
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  function assertUnsealed(input) {
    if (input.guardAbsentRelativePath && files.has(relative(input.guardAbsentRelativePath))) {
      throw errorWithCode('ESEALED');
    }
  }

  function assertExpectedFile(relativePath, expected) {
    const data = files.get(relativePath);
    if (expected?.found === false) {
      if (data) throw errorWithCode('ESTALE');
      return;
    }
    if (!data || expected?.found !== true || data.byteLength !== expected.size ||
        sha256(data) !== expected.sha256) throw errorWithCode('ESTALE');
    const record = JSON.parse(data.toString('utf8'));
    if (record.status !== expected.status || record.version !== expected.version) throw errorWithCode('ESTALE');
  }

  function runStatusCas(input) {
    return serialized('status-cas', input, (relativePath) => {
      assertUnsealed(input);
      assertExpectedFile(relativePath, input.expectedCurrent);
      files.set(relativePath, Buffer.from(input.data));
      stateSnapshotVersion += 1;
      return proof(relativePath, { size: files.get(relativePath).byteLength });
    });
  }

  function pause(held, operation) {
    held.enter();
    return held.wait.then(operation);
  }

  function snapshotEntry(relativePath) {
    const data = files.get(relativePath);
    return data
      ? proof(relativePath, {
          found: true,
          data: Buffer.from(data),
          size: data.byteLength,
          snapshotVersion: stateSnapshotVersion
        })
      : proof(relativePath, { found: false, snapshotVersion: stateSnapshotVersion });
  }

  function runStateSnapshot(input) {
    assert.equal(input.rootPath, rootPath);
    assert.deepEqual(input.flags, { readOnly: true, noFollow: true, atomic: true });
    const statusRelativePath = relative(input.statusRelativePath);
    const decisionRelativePath = relative(input.decisionRelativePath);
    operations.push({
      kind: 'state-snapshot',
      statusRelativePath,
      decisionRelativePath,
      flags: input.flags
    });
    const result = queue.then(() => {
      const snapshot = {
        canonicalRootPath,
        rootIdentity,
        snapshotVersion: stateSnapshotVersion,
        status: snapshotEntry(statusRelativePath),
        decision: snapshotEntry(decisionRelativePath)
      };
      if (redirectNext) {
        redirectNext = false;
        snapshot.status = {
          ...snapshot.status,
          canonicalPath: path.join(path.dirname(canonicalRootPath), 'outside', statusRelativePath),
          rootIdentity: { dev: 99, ino: 100 }
        };
      }
      return snapshot;
    });
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  return {
    mkdirBeneath(input) {
      return serialized('mkdir', input, (relativePath) => {
        assertUnsealed(input);
        return proof(relativePath);
      });
    },
    appendFileBeneath(input) {
      return serialized('append', input, (relativePath) => {
        assertUnsealed(input);
        const current = files.get(relativePath) ?? Buffer.alloc(0);
        files.set(relativePath, Buffer.concat([current, Buffer.from(input.data)]));
        return proof(relativePath, { size: files.get(relativePath).byteLength });
      });
    },
    atomicWriteFileBeneath(input) {
      return serialized('atomic-write', input, (relativePath) => {
        assertUnsealed(input);
        files.set(relativePath, Buffer.from(input.data));
        return proof(relativePath, { size: files.get(relativePath).byteLength });
      });
    },
    compareAndSwapFileBeneath(input) {
      const nextStatus = JSON.parse(Buffer.from(input.data).toString('utf8')).status;
      if (heldStatusCas?.status === nextStatus) {
        const held = heldStatusCas;
        heldStatusCas = undefined;
        held.enter();
        return held.wait.then(() => runStatusCas(input));
      }
      return runStatusCas(input);
    },
    readFileBeneath(input) {
      const run = () => serialized('read', input, (relativePath) => {
        const data = files.get(relativePath);
        if (!data) return proof(relativePath, { found: false });
        return proof(relativePath, { found: true, data: Buffer.from(data), size: data.byteLength });
      });
      if (heldStateRead && path.basename(relative(input.relativePath)) === 'decision.json') {
        const held = heldStateRead;
        heldStateRead = undefined;
        return pause(held, run);
      }
      return run();
    },
    readStateSnapshotBeneath(input) {
      if (heldStateRead) {
        const held = heldStateRead;
        heldStateRead = undefined;
        return pause(held, () => runStateSnapshot(input));
      }
      return runStateSnapshot(input);
    },
    commitDecisionBeneath(input) {
      const run = () => serialized('decision-transaction', input, (relativePath) => {
        if (files.has(relativePath)) throw errorWithCode('EEXIST');
        const decision = JSON.parse(Buffer.from(input.data).toString('utf8'));
        const statusPath = relative(input.statusProjection.relativePath);
        const projection = JSON.parse(Buffer.from(input.statusProjection.data).toString('utf8'));
        if (decision.status === 'accepted' || decision.status === 'rejected') {
          assert.equal(input.expectedStatus.status, 'completed');
        }
        assert.equal(projection.status, decision.status);
        assert.equal(projection.version, decision.statusVersion);
        assertExpectedFile(statusPath, input.expectedStatus);
        if (beforeNextDecisionCommit) {
          beforeNextDecisionCommit();
          beforeNextDecisionCommit = undefined;
        }
        for (const [expectedPath, expected] of Object.entries(input.expectedFiles ?? {})) {
          const data = files.get(relative(expectedPath));
          if (expected.found === false) {
            if (data !== undefined) throw errorWithCode('ECOMPARE');
            continue;
          }
          if (!data || data.byteLength !== expected.size || sha256(data) !== expected.sha256) {
            throw errorWithCode('ECOMPARE');
          }
        }
        files.set(relativePath, Buffer.from(input.data));
        files.set(statusPath, Buffer.from(input.statusProjection.data));
        stateSnapshotVersion += 1;
        const result = proof(relativePath, {
          size: files.get(relativePath).byteLength,
          statusProjection: proof(statusPath, { size: files.get(statusPath).byteLength })
        });
        if (interruptAfterNextDecisionCommit) {
          interruptAfterNextDecisionCommit = false;
          throw errorWithCode('ETRANSACTION_INTERRUPTED');
        }
        return result;
      });
      if (heldDecisionCommit) {
        const held = heldDecisionCommit;
        heldDecisionCommit = undefined;
        return pause(held, run);
      }
      return run();
    },
    redirectNextOperation() { redirectNext = true; },
    appendBeforeNextDecisionCommit(relativePath, data) {
      beforeNextDecisionCommit = () => {
        const normalized = relative(relativePath);
        files.set(normalized, Buffer.concat([files.get(normalized) ?? Buffer.alloc(0), Buffer.from(data)]));
      };
    },
    holdNextStatusCas(status) {
      let enter;
      let release;
      const entered = new Promise((resolve) => { enter = resolve; });
      const wait = new Promise((resolve) => { release = resolve; });
      heldStatusCas = { status, enter, wait };
      return { entered, release };
    },
    holdNextStateRead() {
      let enter;
      let release;
      const entered = new Promise((resolve) => { enter = resolve; });
      const wait = new Promise((resolve) => { release = resolve; });
      heldStateRead = { enter, wait };
      return { entered, release };
    },
    holdNextDecisionCommit() {
      let enter;
      let release;
      const entered = new Promise((resolve) => { enter = resolve; });
      const wait = new Promise((resolve) => { release = resolve; });
      heldDecisionCommit = { enter, wait };
      return { entered, release };
    },
    interruptAfterNextDecisionCommit() { interruptAfterNextDecisionCommit = true; },
    tamper(relativePath, data) {
      files.set(relative(relativePath), Buffer.from(data));
      stateSnapshotVersion += 1;
    },
    delete(relativePath) {
      files.delete(relative(relativePath));
      stateSnapshotVersion += 1;
    },
    async readText(relativePath) {
      await queue;
      const data = files.get(relative(relativePath));
      if (!data) throw errorWithCode('ENOENT');
      return data.toString('utf8');
    },
    async readJson(relativePath) { return JSON.parse(await this.readText(relativePath)); },
    async fileNames(directory) {
      await queue;
      const prefix = `${relative(directory)}${path.sep}`;
      return [...files.keys()].filter((name) => name.startsWith(prefix)).map((name) => name.slice(prefix.length)).sort();
    }
  };
}

function recordingHost(rootPath, attestation, calls) {
  const rootIdentity = { dev: 7, ino: 10 };
  return {
    async openBeneath({ rootPath: suppliedRoot, relativePath, flags }) {
      assert.equal(suppliedRoot, rootPath);
      assert.deepEqual(flags, { readOnly: true, noFollow: true });
      assert.equal(path.isAbsolute(relativePath), false);
      assert.equal(relativePath.includes('..'), false);
      calls.push(relativePath);

      const isSidecar = relativePath.endsWith('.showrunner.json');
      const canonicalPath = path.join(rootPath, relativePath);
      const identity = { dev: 7, ino: isSidecar ? 12 : 11 };
      const stat = {
        ...identity,
        size: isSidecar ? 256 : 4096,
        startMonotonicTimestamp: 0,
        endMonotonicTimestamp: 10_000,
        isFile: () => true,
        isSymbolicLink: () => false
      };
      return {
        canonicalRootPath: rootPath,
        canonicalPath,
        rootIdentity,
        identity,
        handle: {
          stat: async () => stat,
          readFile: async () => JSON.stringify(attestation.value),
          close: async () => {}
        }
      };
    }
  };
}

const integrationApprovalKeys = generateKeyPairSync('ed25519');

function takeInput() {
  const episode = {
    schemaVersion: 1,
    productionId: 'production-a',
    episode: 'stolen-map',
    actors: {
      hero: { profile: {} },
      rival: { profile: {} }
    },
    set: {
      baselineManifest: {
        resetTimeoutMs: 100,
        actorBaselines: {
          hero: { mark: 'hero_start' },
          rival: { mark: 'rival_start' }
        }
      }
    },
      scene: {
        id: 'confrontation',
        marks: {
          hero_start: { dimension: 'minecraft:overworld', position: { x: 1, y: 64, z: 1 }, facing: { yaw: 0, pitch: 0 }, radius: 1, dwellTicks: 10, safeHeadroom: true },
          rival_start: { dimension: 'minecraft:overworld', position: { x: 3, y: 64, z: 1 }, facing: { yaw: 180, pitch: 0 }, radius: 1, dwellTicks: 10, safeHeadroom: true }
        },
        dialoguePolicy: { maximumWordsPerLine: 18, forbiddenLiterals: [], forbiddenPatterns: [] },
        cues: [
          { id: 'rival_reveal', speaker: 'rival', mark: 'rival_start', approvedVariants: ['rival-approved'], fallbackLine: 'I have the map.', timeoutSeconds: 12 },
          { id: 'hero_reply', speaker: 'hero', mark: 'hero_start', approvedVariants: ['hero-approved'], fallbackLine: 'I will take it back.', timeoutSeconds: 12 }
        ]
      },
      retry: { wholeSceneAttempts: 2 }
  };
  const approvedBank = approveCandidateBank({
    candidates: [
      { id: 'rival-candidate', cueId: 'rival_reveal', speaker: 'rival', text: 'Your map is mine.', hardValidation: { ok: true, violations: [] }, softScores: {} },
      { id: 'hero-candidate', cueId: 'hero_reply', speaker: 'hero', text: 'Not for long.', hardValidation: { ok: true, violations: [] }, softScores: {} }
    ],
    decisions: [
      { candidateId: 'rival-candidate', approved: true, variantId: 'rival-approved', creator: 'Integration Creator' },
      { candidateId: 'hero-candidate', approved: true, variantId: 'hero-approved', creator: 'Integration Creator' }
    ],
    creator: 'Integration Creator',
    provenance: {
      sourceEpisode: episode,
      provider: 'integration-provider', model: 'integration-model', promptTemplateVersion: 'integration-v1',
      promptHash: 'b'.repeat(64), tokens: { input: 10, output: 5 }, latencyMs: 1
    },
    approvalPrivateKey: integrationApprovalKeys.privateKey
  });
  return {
    productionId: 'production-a',
    takeId: 'take-a',
    episode,
    approvedBank,
    selectedLines: {
      rival_reveal: { id: 'rival-approved', text: 'Your map is mine.' },
      hero_reply: { id: 'hero-approved', text: 'Not for long.' }
    }
  };
}

async function createIntegrationRig(t, { firstAttemptFails = false, actualActorRuntimes = false } = {}) {
  const directory = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'showrunner-integration-'));
  const artifactRoot = path.join(directory, 'artifacts');
  const recordingRoot = path.join(directory, 'recordings');
  const recordingPath = path.join(recordingRoot, 'take-a.mkv');
  await nodeFs.mkdir(recordingRoot, { recursive: true });
  t.after(() => nodeFs.rm(directory, { recursive: true, force: true }));

  const priorRecordingRoot = process.env.SHOWRUNNER_RECORDING_DIR;
  process.env.SHOWRUNNER_RECORDING_DIR = recordingRoot;
  t.after(() => {
    if (priorRecordingRoot === undefined) delete process.env.SHOWRUNNER_RECORDING_DIR;
    else process.env.SHOWRUNNER_RECORDING_DIR = priorRecordingRoot;
  });

  const artifactOperations = [];
  const artifactFsPort = rootedArtifactHost(artifactRoot, artifactOperations);
  const writer = createArtifactWriter(artifactRoot, { productionId: 'production-a', takeId: 'take-a' }, {
    fsPort: artifactFsPort
  });
  const background = [];
  const speechCallbacks = new Map();
  const captureCalls = [];
  const attestation = { value: null };
  const rootedRecordingHost = recordingHost(recordingRoot, attestation, captureCalls);
  const captureClock = { value: 100, now() { return this.value; } };
  let captureSession;
  let captureReport;
  let resetReport = { verified: true, attemptId: 'attempt-1' };
  let runner;

  const recordCommand = (command) => {
    return writer.appendEvent({ kind: 'command-issued', command });
  };
  const proofFor = (command, extra = {}) => {
    if (command.kind === 'prepareTake') return { kind: 'preparation', authoritative: true, prepared: true, actors: command.payload.actors };
    if (command.kind === 'armCapture') return { kind: 'captureArm', authoritative: true, armed: true, takeId: 'take-a' };
    if (command.kind === 'moveToMark') {
      return {
        kind: 'mark', authoritative: true, actor: command.target.actor, markId: command.payload.markId,
        dimension: command.payload.mark.dimension, radius: true, facing: true, safeHeadroom: true,
        dwellTicks: command.payload.mark.dwellTicks
      };
    }
    if (command.kind === 'speak') {
      return {
        kind: 'speech', authoritative: true, observed: true, speaker: command.target.actor,
        cueId: command.cueId, text: command.payload.text
      };
    }
    if (command.kind === 'cancel') {
      return { kind: 'quiescence', authoritative: true, quiescent: true, targetAttemptId: command.payload.targetAttemptId };
    }
    if (command.kind === 'cancelTimer') {
      return { kind: 'quiescence', authoritative: true, quiescent: true, resourceKind: 'timer', resourceId: command.payload.timerId };
    }
    if (command.kind === 'cancelCapture') {
      return { kind: 'quiescence', authoritative: true, quiescent: true, resourceKind: 'capture', resourceId: command.payload.captureCommandId };
    }
    if (command.kind === 'stopCapture') {
      return { kind: 'capture', authoritative: true, ...extra };
    }
    if (command.kind === 'resetBaseline') {
      return { kind: 'reset', authoritative: true, verified: true, nextAttempt: extra.nextAttempt };
    }
    return { authoritative: true, ...extra };
  };
  const emitEvent = (command, sink, kind, payload = {}) => sink.emit(sink.createEvent(kind, payload));
  const emitBarrier = async (command, sink, extra = {}) => {
    await emitEvent(command, sink, 'commandAcknowledged', { commandId: command.commandId });
    await emitEvent(command, sink, 'commandCompleted', { commandId: command.commandId });
    await emitEvent(command, sink, 'observationVerified', {
      commandId: command.commandId,
      proof: proofFor(command, extra)
    });
  };
  const schedule = (work) => background.push(Promise.resolve(work));

  const resetActors = ['hero', 'rival'].map((name) => ({
    name,
    async cancel() {},
    async awaitQuiescence() { return { acknowledged: true, quiescent: true }; }
  }));
  const resetController = {
    async restore() {},
    async removeTaggedEntities() {},
    async verify() { return { ok: true, mismatches: [] }; }
  };
  const manifest = {
    actorBaselines: { hero: {}, rival: {} },
    resetTimeoutMs: 100,
    entityCleanupTag: 'showrunner-production-a'
  };

  const actorPort = (name) => ({
    execute(command, sink) {
      schedule(recordCommand(command).then(async () => {
        if (command.kind === 'speak') {
          if (command.attemptId === 'attempt-1' && command.cueId === 'hero_reply' && firstAttemptFails) {
            await writer.appendEvent({ kind: 'command-failed', commandId: command.commandId, reason: 'actor-stuck' });
            await emitEvent(command, sink, 'commandFailed', { commandId: command.commandId, reason: 'actor-stuck' });
            return;
          }
          if (command.attemptId === 'attempt-2') {
            speechCallbacks.set(command.cueId, { command, sink });
            return;
          }
        }
        await emitBarrier(command, sink);
      }));
    },
    name
  });

  const actualActorPort = (name) => {
    let now = 1;
    const bot = {
      username: name,
      entity: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 },
      game: { dimension: 'minecraft:overworld' },
      pathfinder: {
        setMovements() {},
        async goto(goal) { bot.entity.position = { x: goal.x, y: goal.y, z: goal.z }; },
        stop() {}
      },
      chat() {},
      async look(yaw, pitch) { bot.entity.yaw = yaw; bot.entity.pitch = pitch; },
      blockAt() { return { boundingBox: 'empty' }; },
      clearControlStates() {},
      setControlState() {}
    };
    const runtime = createActorRuntime({
      bot,
      actorId: name,
      movements: {},
      clock: { now: () => now++, async sleep() { now += 50; } },
      verifier: { verifyMark(_kind, payload) { return payload.mark; } },
      approvalPublicKey: integrationApprovalKeys.publicKey,
      episodeContentHash: sourceEpisodeHash(takeInput().episode),
      speechObserver: {
        async observe({ actorId, command, text }) {
          return { authoritative: true, observed: true, speaker: actorId, cueId: command.cueId, text };
        }
      }
    });
    return {
      name: runtime.name,
      async execute(command, sink) {
        await recordCommand(command);
        return runtime.execute(command, sink);
      },
      cancel: runtime.cancel,
      awaitQuiescence: runtime.awaitQuiescence,
      close: runtime.close
    };
  };

  const productionPort = {
    execute(command, sink) {
      schedule(recordCommand(command).then(async () => {
        if (command.kind === 'resetBaseline') {
          const revoked = [];
          resetReport = await resetToBaseline({
            attempt: {
              id: command.payload.failedAttemptId,
              revoke: (reason) => revoked.push(reason),
              next: () => ({ id: 'attempt-2', number: 2 })
            },
            actors: resetActors,
            controller: resetController,
            manifest,
            clock: { setTimeout, clearTimeout }
          });
          assert.deepEqual(revoked, ['retry']);
        }
        await emitBarrier(command, sink, command.kind === 'resetBaseline' ? { nextAttempt: resetReport.nextAttempt } : {});
      }));
    }
  };

  const timerPort = {
    execute(command, sink) {
      schedule(recordCommand(command).then(async () => {
        if (['preRoll', 'cueTimeout', 'cleanupTimeout'].includes(command.kind)) {
          await emitEvent(command, sink, 'commandAcknowledged', { commandId: command.commandId });
          await emitEvent(command, sink, 'commandCompleted', { commandId: command.commandId });
          if (command.kind === 'preRoll') {
            captureSession.markTakeStarted();
            await emitEvent(command, sink, 'timerFired', { commandId: command.commandId });
          }
          return;
        }
        await emitBarrier(command, sink, { quiescent: true });
      }));
    }
  };

  const capturePort = {
    execute(command, sink) {
      schedule(recordCommand(command).then(async () => {
        if (command.kind === 'armCapture') {
          captureClock.value = command.attemptId === 'attempt-1' ? 100 : 1000;
          captureSession = createCaptureSession({
            takeId: 'take-a', expectedPath: recordingPath, clock: captureClock, preRollMs: 0
          });
          const ready = captureSession.acknowledgeReady({
            takeId: 'take-a', path: recordingPath, monotonicTimestamp: captureClock.value
          });
          await emitBarrier(command, sink);
          await emitEvent(command, sink, 'captureReady', { takeId: 'take-a', path: recordingPath });
          attestation.value = {
            takeId: 'take-a', path: recordingPath,
            readyMonotonicTimestamp: ready.monotonicTimestamp,
            startMonotonicTimestamp: captureClock.value,
            stopMonotonicTimestamp: 9000
          };
          return;
        }
        if (command.kind === 'stopCapture') {
          captureClock.value = 9000;
          captureSession.requestStop();
          captureSession.acknowledgeStopped({ takeId: 'take-a', path: recordingPath, monotonicTimestamp: 9000 });
          captureReport = await captureSession.verifyArtifact(rootedRecordingHost);
          await emitBarrier(command, sink, {
            ok: true,
            takeId: 'take-a',
            path: recordingPath,
            coverage: { complete: true, startMonotonicTimestamp: 1000, endMonotonicTimestamp: 9000 }
          });
          return;
        }
        await emitBarrier(command, sink, { quiescent: true });
      }));
    }
  };

  runner = createShowrunner({
    actors: actualActorRuntimes
      ? { hero: actualActorPort('hero'), rival: actualActorPort('rival') }
      : { hero: actorPort('hero'), rival: actorPort('rival') },
    production: productionPort,
    timers: timerPort,
    capture: capturePort,
    clock: { now: (() => { let now = 1; return () => now++; })() },
    ids: {
      attempt: ({ number }) => `attempt-${number}`,
      command: ({ attemptId, number }) => `${attemptId}:command:${number}`
    },
    approvalPublicKey: integrationApprovalKeys.publicKey
  });

  async function flush() {
    while (background.length > 0) await background.shift();
    await runner.dispatch({ kind: 'flush' });
  }

  async function completeSpeech(cueId) {
    await flush();
    const pending = speechCallbacks.get(cueId);
    assert.ok(pending, `missing pending speech for ${cueId}`);
    speechCallbacks.delete(cueId);
    await emitBarrier(pending.command, pending.sink);
    await flush();
  }

  return {
    writer,
    artifactRoot,
    artifactFsPort,
    artifactOperations,
    captureCalls,
    rootedRecordingHost,
    async run() {
      await runner.startTake(takeInput());
      await flush();
      assert.equal(runner.snapshot().attemptId, firstAttemptFails ? 'attempt-2' : 'attempt-1');
    },
    async injectLateEvent({ attemptId, cueId }) {
      const snapshot = runner.snapshot();
      const event = {
        kind: 'command-completed',
        productionId: snapshot.productionId,
        takeId: snapshot.takeId,
        sceneId: snapshot.sceneId,
        beatId: cueId,
        attemptId,
        cueId,
        eventId: 'late-attempt-one-event',
        causalSequence: snapshot.causalSequence + 1,
        monotonicTimestamp: 500,
        payload: { commandId: 'attempt-1:late-command' }
      };
      await writer.appendEvent({ kind: 'event-received', event });
      await runner.dispatch(event);
      const rejection = runner.snapshot().ignoredEvents.at(-1);
      await writer.appendEvent({ kind: 'event-rejected', ...rejection });
    },
    async finishAttemptTwo() {
      if (actualActorRuntimes) {
        for (let index = 0; index < 100 && runner.snapshot().state !== 'completed'; index += 1) {
          await flush();
          await new Promise((resolve) => setImmediate(resolve));
        }
      } else {
        await completeSpeech('rival_reveal');
        await completeSpeech('hero_reply');
      }
      const snapshot = runner.snapshot();
      assert.equal(snapshot.state, 'completed');
      assert.equal(captureReport?.ok, true, `capture verification failed: ${JSON.stringify(captureReport)}`);
      await writer.writeTranscript(snapshot.transcript);
      await writer.writeValidation({ approvedBankVerified: true, hardValidationPassed: true });
      await writer.finalize({ status: 'completed', baselineReport: resetReport, capture: captureReport });

      const takeDirectory = path.join('showrunner', 'production-a', 'take-a');
      const events = (await artifactFsPort.readText(path.join(takeDirectory, 'events.ndjson')))
        .trim().split('\n').map((line) => JSON.parse(line));
      return {
        status: snapshot.state,
        transcript: await artifactFsPort.readJson(path.join(takeDirectory, 'transcript.json')),
        events,
        resetReport,
        capture: captureReport,
        discardedAttempts: snapshot.discardedAttempts,
        takeDirectory
      };
    },
    productionHost: {
      async inspectTake({ takeId }) {
        assert.equal(takeId, 'take-a');
        return { status: runner.snapshot().state, capture: captureReport };
      },
      async verifyCapture({ takeId, fsPort }) {
        assert.equal(takeId, 'take-a');
        return captureSession.verifyArtifact(fsPort);
      },
      async accept({ takeId }) {
        assert.equal(takeId, 'take-a');
        await writer.finalize({ status: 'accepted' });
        await runner.dispatch({ kind: 'accept' });
        return { status: runner.snapshot().state };
      },
      async reject({ takeId }) {
        assert.equal(takeId, 'take-a');
        await writer.finalize({ status: 'rejected' });
        await runner.dispatch({ kind: 'reject' });
        return { status: runner.snapshot().state };
      }
    }
  };
}

test('runs, retries, fences a late event, and creates an auditable completed take', async (t) => {
  const production = await createIntegrationRig(t, { firstAttemptFails: true });
  await production.run();
  await production.injectLateEvent({ attemptId: 'attempt-1', cueId: 'rival_reveal' });
  const result = await production.finishAttemptTwo();

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.transcript.map((line) => line.cueId), ['rival_reveal', 'hero_reply']);
  assert.deepEqual(result.transcript.map((line) => line.variantId), ['rival-approved', 'hero-approved']);
  assert.equal(result.transcript.every((line) => line.attemptId === 'attempt-2'), true);
  assert.equal(result.discardedAttempts[0].attemptId, 'attempt-1');
  assert.equal(result.discardedAttempts[0].transcript[0].cueId, 'rival_reveal');
  assert.equal(result.events.some((event) => event.reason === 'STALE_ATTEMPT'), true);
  assert.equal(result.resetReport.verified, true);
  assert.equal(result.capture.ok, true);
  assert.deepEqual(production.captureCalls, ['take-a.mkv', 'take-a.mkv.showrunner.json']);
  assert.deepEqual(await production.artifactFsPort.fileNames(result.takeDirectory), [
    'baseline-report.json', 'capture.json', 'events.ndjson', 'status.json', 'transcript.json', 'validation.json'
  ]);
});

test('composes canonical state-machine commands with the real actor runtimes', async (t) => {
  const production = await createIntegrationRig(t, { actualActorRuntimes: true });
  await production.run();
  const result = await production.finishAttemptTwo();

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.transcript.map((line) => line.speaker), ['rival', 'hero']);
  assert.equal(result.events.some((event) => event.kind === 'command-issued' && event.command.kind === 'moveToMark'), true);
  assert.equal(result.events.some((event) => event.kind === 'command-issued' && event.command.kind === 'speak'), true);
});

test('binds strict Survival evidence identity to its artifact writer', async (t) => {
  const production = await createIntegrationRig(t);

  await production.writer.appendPlannerDecision(plannerEvidence());
  await production.writer.appendSurvivalObservation(survivalEvidence());

  const takeDirectory = path.join('showrunner', 'production-a', 'take-a');
  const storedPlanner = JSON.parse((await production.artifactFsPort.readText(
    path.join(takeDirectory, 'planner-decisions.ndjson')
  )).trim());
  const storedObservation = JSON.parse((await production.artifactFsPort.readText(
    path.join(takeDirectory, 'survival-observations.ndjson')
  )).trim());
  assert.deepEqual(
    [storedPlanner.schemaVersion, storedPlanner.productionId, storedPlanner.takeId],
    [1, 'production-a', 'take-a']
  );
  assert.deepEqual(
    [storedObservation.schemaVersion, storedObservation.productionId, storedObservation.takeId],
    [1, 'production-a', 'take-a']
  );

  await assert.rejects(
    production.writer.appendPlannerDecision(plannerEvidence({
      productionId: 'other-production', eventId: 'planner-event-2', causalSequence: 3, observationVersion: 2,
      decision: { ...plannerEvidence().decision, observationVersion: 2 }
    })),
    { code: 'PLANNER_DECISION_ARTIFACT_INVALID' }
  );
  const missingCue = plannerEvidence({ eventId: 'planner-event-3', causalSequence: 3, observationVersion: 2 });
  delete missingCue.cueId;
  await assert.rejects(
    production.writer.appendPlannerDecision(missingCue),
    { code: 'PLANNER_DECISION_ARTIFACT_INVALID' }
  );
});

test('rejects incomplete authoritative Survival observation records', async (t) => {
  const production = await createIntegrationRig(t);
  const incomplete = survivalEvidence();
  delete incomplete.equipment;

  await assert.rejects(production.writer.appendSurvivalObservation(incomplete), {
    code: 'SURVIVAL_OBSERVATION_ARTIFACT_INVALID'
  });
});

test('rejects incomplete typed planner decision records', async (t) => {
  const production = await createIntegrationRig(t);
  const incomplete = plannerEvidence();
  delete incomplete.decision.action.payload;

  await assert.rejects(production.writer.appendPlannerDecision(incomplete), {
    code: 'PLANNER_DECISION_ARTIFACT_INVALID'
  });
});

test('rejects unknown evidence fields and actions before append', async (t) => {
  const production = await createIntegrationRig(t);
  await assert.rejects(production.writer.appendPlannerDecision(plannerEvidence({ unexpected: true })), {
    code: 'PLANNER_DECISION_ARTIFACT_INVALID'
  });
  await assert.rejects(production.writer.appendPlannerDecision(plannerEvidence({
    decision: {
      status: 'action', reason: 'TARGET_AVAILABLE', observationVersion: 1,
      action: { name: 'teleport', payload: { targetId: 'tree-a' } }
    }
  })), { code: 'PLANNER_DECISION_ARTIFACT_INVALID' });
  await assert.rejects(production.writer.appendPlannerDecision(plannerEvidence({
    eventId: 'planner-observe-survival',
    decision: {
      status: 'action', reason: 'OBSERVATION_REQUIRED', observationVersion: 1,
      action: {
        name: 'observeSurvival',
        payload: { actor: 'hero', goalId: 'gather-hero-log', observationVersion: 1 }
      }
    }
  })), { code: 'PLANNER_DECISION_ARTIFACT_INVALID' });
  await assert.rejects(production.writer.appendSurvivalObservation(survivalEvidence({ unexpected: true })), {
    code: 'SURVIVAL_OBSERVATION_ARTIFACT_INVALID'
  });
});

test('binds planner actions to their outer identity while preserving the full fenced reservation snapshot', async (t) => {
  const production = await createIntegrationRig(t);
  const wrongActor = plannerEvidence();
  wrongActor.decision.action.payload.actor = 'rival';
  await assert.rejects(production.writer.appendPlannerDecision(wrongActor), {
    code: 'PLANNER_DECISION_ARTIFACT_INVALID'
  });

  await assert.rejects(production.writer.appendPlannerDecision(plannerEvidence({
    eventId: 'planner-event-reservation',
    reservations: [{ reservationKey: 'missing-authoritative-fields' }]
  })), { code: 'PLANNER_DECISION_ARTIFACT_INVALID' });

  const competingReservation = {
    receiptId: 'receipt-1', reservationKey: 'target:tree-a', kind: 'target',
    productionId: 'production-a', takeId: 'take-a', attemptId: 'attempt-2',
    goalId: 'gather-rival-log', actorId: 'rival', observationVersion: 7, expiresAt: 200
  };
  await production.writer.appendPlannerDecision(plannerEvidence({ reservations: [competingReservation] }));
  const takeDirectory = path.join('showrunner', 'production-a', 'take-a');
  const stored = JSON.parse((await production.artifactFsPort.readText(
    path.join(takeDirectory, 'planner-decisions.ndjson')
  )).trim());
  assert.deepEqual(stored.reservations, [competingReservation]);

  for (const [field, value] of [
    ['productionId', 'other-production'],
    ['takeId', 'other-take'],
    ['attemptId', 'other-attempt']
  ]) {
    await assert.rejects(production.writer.appendPlannerDecision(plannerEvidence({
      eventId: `planner-reservation-wrong-${field}`,
      reservations: [{ ...competingReservation, [field]: value }]
    })), { code: 'PLANNER_DECISION_ARTIFACT_INVALID' });
  }
});

test('rejects malformed nested Survival observation state before append', async (t) => {
  const production = await createIntegrationRig(t);
  for (const [name, mutate] of [
    ['negative inventory', (record) => { record.inventory.oak_log = -1; }],
    ['non-string equipment', (record) => { record.equipment.hand = 42; }],
    ['extra point field', (record) => { record.position.dimension = 'minecraft:overworld'; }],
    ['malformed target', (record) => { record.targets = [{ id: 'tree-a' }]; }]
  ]) {
    const record = survivalEvidence({ eventId: `malformed-${name}`, causalSequence: 10 });
    mutate(record);
    await assert.rejects(production.writer.appendSurvivalObservation(record), {
      code: 'SURVIVAL_OBSERVATION_ARTIFACT_INVALID'
    });
  }
});

test('rejects duplicate and out-of-order evidence events before append', async (t) => {
  const production = await createIntegrationRig(t);
  await production.writer.appendPlannerDecision(plannerEvidence());
  await production.writer.appendPlannerDecision(plannerEvidence({
    eventId: 'planner-event-2', causalSequence: 2, monotonicTimestamp: 101, observationVersion: 2,
    decision: { ...plannerEvidence().decision, observationVersion: 2 }
  }));

  await assert.rejects(production.writer.appendSurvivalObservation(survivalEvidence({
    eventId: 'planner-event-2', causalSequence: 3, monotonicTimestamp: 102, observationVersion: 2
  })), { code: 'EVIDENCE_EVENT_DUPLICATE' });
  await assert.rejects(production.writer.appendSurvivalObservation(survivalEvidence({
    eventId: 'observation-event-2', causalSequence: 2, monotonicTimestamp: 102, observationVersion: 2
  })), { code: 'EVIDENCE_CAUSAL_ORDER_INVALID' });
  await assert.rejects(production.writer.appendSurvivalObservation(survivalEvidence({
    eventId: 'observation-event-2', causalSequence: 3, monotonicTimestamp: 99, observationVersion: 2
  })), { code: 'EVIDENCE_CAUSAL_ORDER_INVALID' });
});

test('scopes evidence causal sequences to an identity fence while keeping event IDs take-unique', async (t) => {
  const production = await createIntegrationRig(t);
  await production.writer.appendPlannerDecision(plannerEvidence());

  await production.writer.appendSurvivalObservation(survivalEvidence({
    beatId: 'hero_reply', cueId: 'hero_reply', eventId: 'hero-reply-observation-1', causalSequence: 1,
    monotonicTimestamp: 200
  }));
  await production.writer.appendSurvivalObservation(survivalEvidence({
    attemptId: 'attempt-3', beatId: 'rival_reveal', cueId: 'rival_reveal',
    eventId: 'attempt-3-observation-1', causalSequence: 1, monotonicTimestamp: 300
  }));
  await assert.rejects(production.writer.appendSurvivalObservation(survivalEvidence({
    attemptId: 'attempt-3', eventId: 'planner-event-1', causalSequence: 2, monotonicTimestamp: 301,
    observationVersion: 2
  })), { code: 'EVIDENCE_EVENT_DUPLICATE' });
});

test('enforces planner and observation version transitions before append', async (t) => {
  const production = await createIntegrationRig(t);
  await production.writer.appendPlannerDecision(plannerEvidence({ observationVersion: 2,
    decision: { ...plannerEvidence().decision, observationVersion: 2 }
  }));
  await assert.rejects(production.writer.appendPlannerDecision(plannerEvidence({
    eventId: 'planner-event-2', causalSequence: 2, monotonicTimestamp: 101, observationVersion: 2,
    decision: { ...plannerEvidence().decision, observationVersion: 2 }
  })), { code: 'EVIDENCE_VERSION_ORDER_INVALID' });

  await production.writer.appendSurvivalObservation(survivalEvidence({
    eventId: 'observation-event-1', causalSequence: 2, observationVersion: 2, phase: 'after'
  }));
  await assert.rejects(production.writer.appendSurvivalObservation(survivalEvidence({
    eventId: 'observation-event-2', causalSequence: 3, monotonicTimestamp: 102,
    observationVersion: 2, phase: 'after'
  })), { code: 'EVIDENCE_VERSION_ORDER_INVALID' });
  await production.writer.appendSurvivalObservation(survivalEvidence({
    eventId: 'observation-event-2', causalSequence: 3, monotonicTimestamp: 102,
    observationVersion: 2, phase: 'before'
  }));
});

test('acceptance semantically revalidates Survival evidence injected around the writer', async (t) => {
  const production = await createIntegrationRig(t, { firstAttemptFails: true });
  await production.run();
  const result = await production.finishAttemptTwo();
  production.artifactFsPort.tamper(
    path.join(result.takeDirectory, 'planner-decisions.ndjson'),
    `${JSON.stringify({ schemaVersion: 1, ...plannerEvidence() })}\n`
  );
  production.artifactFsPort.tamper(
    path.join(result.takeDirectory, 'survival-observations.ndjson'),
    `${JSON.stringify({ schemaVersion: 1, ...survivalEvidence() })}\n`
  );

  await assert.rejects(production.writer.finalize({ status: 'accepted' }), {
    code: 'PLANNER_DECISION_ARTIFACT_INVALID'
  });
});

test('acceptance requires every planner action to link a prior source and later post-action observation', async (t) => {
  await t.test('missing source', async (t) => {
    const production = await createIntegrationRig(t, { firstAttemptFails: true });
    await production.writer.appendPlannerDecision(plannerEvidence());
    await production.writer.appendSurvivalObservation(survivalEvidence({
      eventId: 'post-only', causalSequence: 2, observationVersion: 2
    }));
    await production.run();
    await production.finishAttemptTwo();
    await assert.rejects(production.writer.finalize({ status: 'accepted' }), {
      code: 'EVIDENCE_SOURCE_OBSERVATION_MISSING'
    });
  });

  await t.test('missing post-action observation', async (t) => {
    const production = await createIntegrationRig(t, { firstAttemptFails: true });
    await production.writer.appendSurvivalObservation(survivalEvidence({
      eventId: 'source-only', causalSequence: 1, observationVersion: 1
    }));
    await production.writer.appendPlannerDecision(plannerEvidence({ causalSequence: 2, monotonicTimestamp: 101 }));
    await production.run();
    await production.finishAttemptTwo();
    await assert.rejects(production.writer.finalize({ status: 'accepted' }), {
      code: 'EVIDENCE_POST_ACTION_OBSERVATION_MISSING'
    });
  });
});

test('survival-required writers refuse completed takes without both linked evidence streams', async () => {
  const root = '/trusted-survival-required-artifacts';
  const fsPort = rootedArtifactHost(root);
  const writer = createArtifactWriter(root, { productionId: 'production-a', takeId: 'take-a' }, {
    fsPort,
    survivalRequired: true
  });
  await writer.appendEvent({ kind: 'prepared' });
  await writer.writeTranscript([]);
  await writer.writeValidation({ approvedBankVerified: true });

  await assert.rejects(writer.finalize({
    status: 'completed', baselineReport: { verified: true }, capture: { ok: true }
  }), { code: 'ACCEPTANCE_EVIDENCE_MISSING' });
});

test('persists the Survival evidence requirement across reopen and refuses a dialogue-only downgrade', async () => {
  const root = '/trusted-durable-survival-artifacts';
  const fsPort = rootedArtifactHost(root);
  const identity = { productionId: 'production-a', takeId: 'take-a' };
  const writer = createArtifactWriter(root, identity, { fsPort, survivalRequired: true });
  await appendLinkedEvidence(writer);
  await writer.appendEvent({ kind: 'completed-evidence' });
  await writer.writeTranscript([]);
  await writer.writeValidation({ approvedBankVerified: true });
  await writer.finalize({
    status: 'completed', baselineReport: { verified: true }, capture: { ok: true }
  });

  const takeDirectory = path.join('showrunner', identity.productionId, identity.takeId);
  const status = await fsPort.readJson(path.join(takeDirectory, 'status.json'));
  assert.equal(status.survivalRequired, true);
  fsPort.delete(path.join(takeDirectory, 'planner-decisions.ndjson'));
  fsPort.delete(path.join(takeDirectory, 'survival-observations.ndjson'));

  const reopened = createArtifactWriter(root, identity, { fsPort });
  await assert.rejects(reopened.finalize({ status: 'accepted' }), {
    code: 'ACCEPTANCE_EVIDENCE_MISSING'
  });
  assert.equal((await reopened.readStatus()).status, 'completed');
});

test('verification semantically revalidates Survival evidence even when forged digests match', async (t) => {
  const production = await createIntegrationRig(t, { firstAttemptFails: true });
  await appendLinkedEvidence(production.writer);
  await production.run();
  const result = await production.finishAttemptTwo();
  await production.writer.finalize({ status: 'accepted' });

  const plannerPath = path.join(result.takeDirectory, 'planner-decisions.ndjson');
  const decisionPath = path.join(result.takeDirectory, 'decision.json');
  const forgedPlanner = Buffer.from('{"schemaVersion":1,"productionId":"production-a","takeId":"take-a"}\n');
  const forgedDecision = await production.artifactFsPort.readJson(decisionPath);
  forgedDecision.evidence['planner-decisions.ndjson'] = {
    sha256: sha256(forgedPlanner),
    size: forgedPlanner.byteLength
  };
  production.artifactFsPort.tamper(plannerPath, forgedPlanner);
  production.artifactFsPort.tamper(decisionPath, `${JSON.stringify(forgedDecision)}\n`);

  const reopened = createArtifactWriter(
    production.artifactRoot,
    { productionId: 'production-a', takeId: 'take-a' },
    { fsPort: production.artifactFsPort }
  );
  await assert.rejects(reopened.verify(), { code: 'PLANNER_DECISION_ARTIFACT_INVALID' });
});

test('serializes NDJSON, atomically replaces JSON documents, and never rewrites a final decision', async (t) => {
  const production = await createIntegrationRig(t, { firstAttemptFails: true });
  await production.run();
  await production.injectLateEvent({ attemptId: 'attempt-1', cueId: 'rival_reveal' });
  const result = await production.finishAttemptTwo();

  await Promise.all(Array.from({ length: 32 }, (_, sequence) => production.writer.appendEvent({ kind: 'concurrent', sequence })));
  const lines = (await production.artifactFsPort.readText(path.join(result.takeDirectory, 'events.ndjson'))).trim().split('\n');
  const concurrent = lines.map((line) => JSON.parse(line)).filter((event) => event.kind === 'concurrent');
  assert.deepEqual(concurrent.map((event) => event.sequence), Array.from({ length: 32 }, (_, index) => index));

  await Promise.all(Array.from({ length: 32 }, (_, sequence) => production.writer.appendPlannerDecision(plannerEvidence({
    goalId: 'concurrent-goal', eventId: `planner-concurrent-${sequence}`, causalSequence: sequence * 3 + 2,
    monotonicTimestamp: 100 + sequence * 3 + 2, observationVersion: sequence * 2 + 1,
    decision: {
      ...plannerEvidence().decision,
      observationVersion: sequence * 2 + 1,
      action: {
        ...plannerEvidence().decision.action,
        payload: { ...plannerEvidence().decision.action.payload, goalId: 'concurrent-goal' }
      }
    }
  }))));
  await Promise.all(Array.from({ length: 32 }, (_, sequence) => [
    production.writer.appendSurvivalObservation(survivalEvidence({
      goalId: 'concurrent-goal', eventId: `observation-source-${sequence}`, causalSequence: sequence * 3 + 1,
      monotonicTimestamp: 100 + sequence * 3 + 1, observationVersion: sequence * 2 + 1
    })),
    production.writer.appendSurvivalObservation(survivalEvidence({
      goalId: 'concurrent-goal', eventId: `observation-post-${sequence}`, causalSequence: sequence * 3 + 3,
      monotonicTimestamp: 100 + sequence * 3 + 3, observationVersion: sequence * 2 + 2
    }))
  ]).flat());
  const plannerDecisions = (await production.artifactFsPort.readText(path.join(result.takeDirectory, 'planner-decisions.ndjson')))
    .trim().split('\n').map((line) => JSON.parse(line));
  const survivalObservations = (await production.artifactFsPort.readText(path.join(result.takeDirectory, 'survival-observations.ndjson')))
    .trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(plannerDecisions.map(({ observationVersion }) => observationVersion),
    Array.from({ length: 32 }, (_, index) => index * 2 + 1));
  assert.deepEqual(survivalObservations.map(({ observationVersion }) => observationVersion),
    Array.from({ length: 64 }, (_, index) => index + 1));

  const cyclic = { goalId: 'cyclic' };
  cyclic.self = cyclic;
  assert.throws(() => production.writer.appendPlannerDecision(cyclic), { code: 'PLANNER_DECISION_ARTIFACT_INVALID' });
  assert.throws(() => production.writer.appendSurvivalObservation(cyclic), { code: 'SURVIVAL_OBSERVATION_ARTIFACT_INVALID' });
  assert.throws(() => production.writer.appendPlannerDecision({ value: Number.NaN }), {
    code: 'PLANNER_DECISION_ARTIFACT_INVALID'
  });
  assert.throws(() => production.writer.appendSurvivalObservation({ value: undefined }), {
    code: 'SURVIVAL_OBSERVATION_ARTIFACT_INVALID'
  });
  let toJsonCalled = false;
  const disguised = {
    toJSON() {
      toJsonCalled = true;
      return { safe: true };
    }
  };
  assert.throws(() => production.writer.appendPlannerDecision(disguised), {
    code: 'PLANNER_DECISION_ARTIFACT_INVALID'
  });
  assert.equal(toJsonCalled, false);

  const atomicWrites = production.artifactOperations.filter((operation) => operation.kind === 'atomic-write');
  assert.equal(atomicWrites.length >= 4, true);
  for (const operation of atomicWrites) {
    assert.deepEqual(operation.flags, {
      create: true, noFollow: true, sameDirectory: true, sync: true, mode: 0o600
    });
  }

  await production.writer.finalize({ status: 'accepted' });
  const reopenedWriter = createArtifactWriter(production.artifactRoot, { productionId: 'production-a', takeId: 'take-a' }, {
    fsPort: production.artifactFsPort
  });
  await assert.rejects(reopenedWriter.finalize({ status: 'rejected' }), { code: 'FINAL_STATUS_IMMUTABLE' });
  const status = await production.artifactFsPort.readJson(path.join(result.takeDirectory, 'status.json'));
  assert.equal(status.status, 'accepted');
});

test('requires a rooted artifact host and rejects an ancestor-swap postcondition', async () => {
  const identity = { productionId: 'production-a', takeId: 'take-a' };
  assert.throws(() => createArtifactWriter('/trusted-artifacts', identity), { code: 'ROOTED_ARTIFACT_FS_REQUIRED' });
  assert.throws(() => createArtifactWriter('/trusted-artifacts', identity, {
    fsPort: { openBeneath: async () => {} }
  }), { code: 'ROOTED_ARTIFACT_FS_REQUIRED' });
  const incompletePort = rootedArtifactHost('/trusted-artifacts');
  delete incompletePort.commitDecisionBeneath;
  assert.throws(() => createArtifactWriter('/trusted-artifacts', identity, { fsPort: incompletePort }), {
    code: 'ROOTED_ARTIFACT_FS_REQUIRED'
  });
  const noSnapshotPort = rootedArtifactHost('/trusted-artifacts');
  delete noSnapshotPort.readStateSnapshotBeneath;
  assert.throws(() => createArtifactWriter('/trusted-artifacts', identity, { fsPort: noSnapshotPort }), {
    code: 'ROOTED_ARTIFACT_FS_REQUIRED'
  });

  const operations = [];
  const fsPort = rootedArtifactHost('/trusted-artifacts', operations);
  const writer = createArtifactWriter('/trusted-artifacts', identity, { fsPort });
  await writer.appendEvent({ kind: 'anchored-write' });
  fsPort.redirectNextOperation();
  await assert.rejects(writer.appendEvent({ kind: 'must-not-escape' }), { code: 'ARTIFACT_ROOT_PROOF_INVALID' });
  assert.deepEqual(await fsPort.fileNames(path.join('showrunner', 'production-a', 'take-a')), ['events.ndjson']);
  assert.doesNotMatch(await fsPort.readText(path.join('showrunner', 'production-a', 'take-a', 'events.ndjson')), /must-not-escape/);
});

test('terminal status without its decision fails closed after reopen', async (t) => {
  const production = await createIntegrationRig(t, { firstAttemptFails: true });
  await production.run();
  await production.injectLateEvent({ attemptId: 'attempt-1', cueId: 'rival_reveal' });
  const result = await production.finishAttemptTwo();
  await production.writer.finalize({ status: 'accepted' });
  production.artifactFsPort.delete(path.join(result.takeDirectory, 'decision.json'));

  const reopened = createArtifactWriter(production.artifactRoot, { productionId: 'production-a', takeId: 'take-a' }, {
    fsPort: production.artifactFsPort
  });
  await assert.rejects(reopened.readStatus(), { code: 'ARTIFACT_STATE_TAMPERED' });
  await assert.rejects(reopened.appendEvent({ kind: 'must-remain-sealed' }), { code: 'ARTIFACT_STATE_TAMPERED' });
});

test('a valid decision that disagrees with terminal status fails closed', async (t) => {
  const production = await createIntegrationRig(t, { firstAttemptFails: true });
  await production.run();
  await production.injectLateEvent({ attemptId: 'attempt-1', cueId: 'rival_reveal' });
  const result = await production.finishAttemptTwo();
  await production.writer.finalize({ status: 'accepted' });
  const decisionPath = path.join(result.takeDirectory, 'decision.json');
  const decision = await production.artifactFsPort.readJson(decisionPath);
  production.artifactFsPort.tamper(decisionPath, `${JSON.stringify({
    ...decision,
    status: 'rejected',
    evidenceFiles: [],
    evidence: null
  })}\n`);

  const reopened = createArtifactWriter(production.artifactRoot, { productionId: 'production-a', takeId: 'take-a' }, {
    fsPort: production.artifactFsPort
  });
  await assert.rejects(reopened.readStatus(), { code: 'ARTIFACT_STATE_TAMPERED' });
  await assert.rejects(reopened.writeValidation({ hardValidationPassed: false }), {
    code: 'ARTIFACT_STATE_TAMPERED'
  });
});

test('atomic status CAS prevents a stale prepared writer from regressing concurrent completion', async () => {
  const root = '/trusted-artifacts';
  const identity = { productionId: 'production-a', takeId: 'take-a' };
  const fsPort = rootedArtifactHost(root);
  const stalePrepared = createArtifactWriter(root, identity, { fsPort });
  const completing = createArtifactWriter(root, identity, { fsPort });
  const held = fsPort.holdNextStatusCas('prepared');
  const staleResult = stalePrepared.finalize({ status: 'prepared' });
  const enteredCas = await Promise.race([
    held.entered.then(() => true),
    staleResult.then(() => false)
  ]);
  assert.equal(enteredCas, true, 'prepared transition must use the rooted status CAS');

  await completing.finalize({
    status: 'completed',
    baselineReport: { verified: true },
    capture: { ok: true }
  });
  held.release();
  await assert.rejects(staleResult, { code: 'TAKE_STATUS_CONFLICT' });
  assert.equal((await completing.readStatus()).status, 'completed');
});

test('atomic state snapshots never mix a read across terminal decision commit', async () => {
  const identity = { productionId: 'production-a', takeId: 'take-a' };

  async function completedTake(root) {
    const fsPort = rootedArtifactHost(root);
    const writer = createArtifactWriter(root, identity, { fsPort });
    await writer.appendEvent({ kind: 'completed-evidence' });
    await writer.writeTranscript([]);
    await writer.writeValidation({ hardValidationPassed: true });
    await writer.finalize({
      status: 'completed',
      baselineReport: { verified: true },
      capture: { ok: true }
    });
    return { fsPort, writer };
  }

  const oldSnapshot = await completedTake('/trusted-artifacts-old-snapshot');
  const oldReader = createArtifactWriter('/trusted-artifacts-old-snapshot', identity, { fsPort: oldSnapshot.fsPort });
  const heldCommit = oldSnapshot.fsPort.holdNextDecisionCommit();
  const pendingOldAcceptance = oldSnapshot.writer.finalize({ status: 'accepted' });
  await heldCommit.entered;
  assert.equal((await oldReader.readStatus()).status, 'completed');
  heldCommit.release();
  await pendingOldAcceptance;

  const newSnapshot = await completedTake('/trusted-artifacts-new-snapshot');
  const newReader = createArtifactWriter('/trusted-artifacts-new-snapshot', identity, { fsPort: newSnapshot.fsPort });
  const heldRead = newSnapshot.fsPort.holdNextStateRead();
  const pendingRead = newReader.readStatus();
  await heldRead.entered;
  await newSnapshot.writer.finalize({ status: 'accepted' });
  heldRead.release();
  assert.equal((await pendingRead).status, 'accepted');
});

test('globally chooses exactly one concurrent terminal decision across stale writers', async (t) => {
  const production = await createIntegrationRig(t, { firstAttemptFails: true });
  await production.run();
  await production.injectLateEvent({ attemptId: 'attempt-1', cueId: 'rival_reveal' });
  const result = await production.finishAttemptTwo();
  const identity = { productionId: 'production-a', takeId: 'take-a' };
  const acceptWriter = createArtifactWriter(production.artifactRoot, identity, { fsPort: production.artifactFsPort });
  const rejectWriter = createArtifactWriter(production.artifactRoot, identity, { fsPort: production.artifactFsPort });
  assert.equal((await acceptWriter.readStatus()).status, 'completed');
  assert.equal((await rejectWriter.readStatus()).status, 'completed');

  const outcomes = await Promise.allSettled([
    acceptWriter.finalize({ status: 'accepted' }),
    rejectWriter.finalize({ status: 'rejected' })
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
  assert.equal(outcomes.find((outcome) => outcome.status === 'rejected').reason.code, 'FINAL_STATUS_IMMUTABLE');

  const decision = await production.artifactFsPort.readJson(path.join(result.takeDirectory, 'decision.json'));
  const projected = await acceptWriter.readStatus();
  assert.equal(projected.status, decision.status);
  const staleChoice = decision.status === 'accepted' ? 'rejected' : 'accepted';
  await assert.rejects(rejectWriter.finalize({ status: staleChoice }), { code: 'FINAL_STATUS_IMMUTABLE' });
});

test('terminal decision transaction wins atomically against a stale completed transition', async (t) => {
  const production = await createIntegrationRig(t, { firstAttemptFails: true });
  await production.run();
  await production.injectLateEvent({ attemptId: 'attempt-1', cueId: 'rival_reveal' });
  const result = await production.finishAttemptTwo();
  const identity = { productionId: 'production-a', takeId: 'take-a' };
  const staleWriter = createArtifactWriter(production.artifactRoot, identity, { fsPort: production.artifactFsPort });
  const acceptingWriter = createArtifactWriter(production.artifactRoot, identity, { fsPort: production.artifactFsPort });
  const held = production.artifactFsPort.holdNextStatusCas('completed');
  const staleResult = staleWriter.finalize({
    status: 'completed',
    baselineReport: result.resetReport,
    capture: result.capture
  });
  const enteredCas = await Promise.race([
    held.entered.then(() => true),
    staleResult.then(() => false)
  ]);
  assert.equal(enteredCas, true, 'completed transition must use the rooted status CAS');

  const accepted = await acceptingWriter.finalize({ status: 'accepted' });
  held.release();
  await assert.rejects(staleResult, { code: 'ARTIFACTS_SEALED' });
  assert.equal(accepted.status, 'accepted');
  assert.equal((await acceptingWriter.readStatus()).status, 'accepted');
  assert.equal((await production.artifactFsPort.readJson(path.join(result.takeDirectory, 'status.json'))).status, 'accepted');
});

test('reopen observes an atomically committed decision after transaction acknowledgement is interrupted', async (t) => {
  const production = await createIntegrationRig(t, { firstAttemptFails: true });
  await production.run();
  await production.injectLateEvent({ attemptId: 'attempt-1', cueId: 'rival_reveal' });
  await production.finishAttemptTwo();
  production.artifactFsPort.interruptAfterNextDecisionCommit();

  await assert.rejects(production.writer.finalize({ status: 'accepted' }), {
    code: 'ETRANSACTION_INTERRUPTED'
  });
  const reopened = createArtifactWriter(production.artifactRoot, { productionId: 'production-a', takeId: 'take-a' }, {
    fsPort: production.artifactFsPort
  });
  assert.equal((await reopened.readStatus()).status, 'accepted');
  assert.equal((await reopened.verify()).ok, true);
  await assert.rejects(reopened.finalize({ status: 'rejected' }), { code: 'FINAL_STATUS_IMMUTABLE' });
});

test('acceptance seals flushed evidence hashes and detects later tampering', async (t) => {
  const secret = 'acceptance-secret-never-written-to-artifacts';
  const priorApprovalKey = process.env.SHOWRUNNER_APPROVAL_KEY;
  process.env.SHOWRUNNER_APPROVAL_KEY = secret;
  t.after(() => {
    if (priorApprovalKey === undefined) delete process.env.SHOWRUNNER_APPROVAL_KEY;
    else process.env.SHOWRUNNER_APPROVAL_KEY = priorApprovalKey;
  });
  const production = await createIntegrationRig(t, { firstAttemptFails: true });
  await production.run();
  await production.injectLateEvent({ attemptId: 'attempt-1', cueId: 'rival_reveal' });
  const result = await production.finishAttemptTwo();
  const finalEvent = { kind: 'acceptance-ready', attemptId: 'attempt-2' };
  const pendingAppend = production.writer.appendEvent(finalEvent);
  const accepted = production.writer.finalize({ status: 'accepted' });
  await Promise.all([pendingAppend, accepted]);

  const decisionPath = path.join(result.takeDirectory, 'decision.json');
  const decision = await production.artifactFsPort.readJson(decisionPath);
  assert.equal(decision.status, 'accepted');
  assert.equal(decision.schemaVersion, 2);
  assert.deepEqual(decision.evidenceFiles, [
    'events.ndjson', 'transcript.json', 'validation.json', 'baseline-report.json', 'capture.json'
  ]);
  assert.deepEqual(Object.keys(decision.evidence).sort(), [
    'baseline-report.json', 'capture.json', 'events.ndjson', 'transcript.json', 'validation.json'
  ]);
  for (const [name, evidence] of Object.entries(decision.evidence)) {
    const contents = Buffer.from(await production.artifactFsPort.readText(path.join(result.takeDirectory, name)));
    assert.deepEqual(evidence, { sha256: sha256(contents), size: contents.byteLength });
    assert.equal(contents.includes(secret), false);
  }
  assert.equal((await production.artifactFsPort.readText(decisionPath)).includes(secret), false);
  assert.match(await production.artifactFsPort.readText(path.join(result.takeDirectory, 'events.ndjson')), /acceptance-ready/);

  await assert.rejects(production.writer.appendEvent({
    kind: 'discarded-dialogue-insertion', attemptId: 'attempt-1', cueId: 'hero_reply'
  }), { code: 'ARTIFACTS_SEALED' });
  await assert.rejects(production.writer.writeTranscript([
    { attemptId: 'attempt-1', cueId: 'hero_reply', variantId: 'discarded' }
  ]), { code: 'ARTIFACTS_SEALED' });
  await assert.rejects(production.writer.writeValidation({ approvedBankVerified: false }), { code: 'ARTIFACTS_SEALED' });
  await assert.rejects(production.writer.appendPlannerDecision({ goalId: 'sealed' }), { code: 'ARTIFACTS_SEALED' });
  await assert.rejects(production.writer.appendSurvivalObservation({ goalId: 'sealed' }), { code: 'ARTIFACTS_SEALED' });
  await assert.rejects(production.writer.finalize({
    status: 'completed', baselineReport: result.resetReport, capture: result.capture
  }), { code: 'ARTIFACTS_SEALED' });

  const reopened = createArtifactWriter(production.artifactRoot, { productionId: 'production-a', takeId: 'take-a' }, {
    fsPort: production.artifactFsPort
  });
  assert.equal((await reopened.readStatus()).status, 'accepted');
  assert.equal((await reopened.verify()).ok, true);
  const statusPath = path.join(result.takeDirectory, 'status.json');
  const statusText = await production.artifactFsPort.readText(statusPath);
  const statusRecord = JSON.parse(statusText);
  production.artifactFsPort.tamper(statusPath, `${JSON.stringify({ ...statusRecord, status: 'rejected' })}\n`);
  const statusTamperedReopen = createArtifactWriter(
    production.artifactRoot,
    { productionId: 'production-a', takeId: 'take-a' },
    { fsPort: production.artifactFsPort }
  );
  await assert.rejects(statusTamperedReopen.readStatus(), { code: 'ARTIFACT_STATE_TAMPERED' });
  production.artifactFsPort.tamper(statusPath, statusText);
  production.artifactFsPort.tamper(path.join(result.takeDirectory, 'transcript.json'), '[{"attemptId":"attempt-1"}]\n');
  const tamperedReopen = createArtifactWriter(production.artifactRoot, { productionId: 'production-a', takeId: 'take-a' }, {
    fsPort: production.artifactFsPort
  });
  await assert.rejects(tamperedReopen.verify(), { code: 'ARTIFACT_EVIDENCE_MISMATCH' });
});

test('reopens and verifies a schema-v1 dialogue-only acceptance decision', async (t) => {
  const production = await createIntegrationRig(t, { firstAttemptFails: true });
  await production.run();
  await production.injectLateEvent({ attemptId: 'attempt-1', cueId: 'rival_reveal' });
  const result = await production.finishAttemptTwo();
  await production.writer.finalize({ status: 'accepted' });

  const decisionPath = path.join(result.takeDirectory, 'decision.json');
  const current = await production.artifactFsPort.readJson(decisionPath);
  const { evidenceFiles: _evidenceFiles, ...legacy } = current;
  production.artifactFsPort.tamper(decisionPath, `${JSON.stringify({ ...legacy, schemaVersion: 1 })}\n`);

  const reopened = createArtifactWriter(
    production.artifactRoot,
    { productionId: 'production-a', takeId: 'take-a' },
    { fsPort: production.artifactFsPort }
  );
  assert.equal((await reopened.readStatus()).status, 'accepted');
  assert.deepEqual(await reopened.verify(), {
    ok: true,
    status: 'accepted',
    evidence: legacy.evidence
  });
});

test('schema-v2 verification rejects known optional evidence created after dialogue-only acceptance', async (t) => {
  const production = await createIntegrationRig(t, { firstAttemptFails: true });
  await production.run();
  await production.injectLateEvent({ attemptId: 'attempt-1', cueId: 'rival_reveal' });
  const result = await production.finishAttemptTwo();
  await production.writer.finalize({ status: 'accepted' });
  production.artifactFsPort.tamper(
    path.join(result.takeDirectory, 'planner-decisions.ndjson'),
    '{"goalId":"post-acceptance-insertion"}\n'
  );

  const reopened = createArtifactWriter(
    production.artifactRoot,
    { productionId: 'production-a', takeId: 'take-a' },
    { fsPort: production.artifactFsPort }
  );
  await assert.rejects(reopened.verify(), { code: 'ARTIFACT_EVIDENCE_MISMATCH' });
});

test('acceptance CAS rejects evidence changed after hashing but before the decision write', async (t) => {
  const production = await createIntegrationRig(t, { firstAttemptFails: true });
  await production.run();
  await production.injectLateEvent({ attemptId: 'attempt-1', cueId: 'rival_reveal' });
  const result = await production.finishAttemptTwo();
  production.artifactFsPort.appendBeforeNextDecisionCommit(
    path.join(result.takeDirectory, 'events.ndjson'),
    '{"kind":"racing-discarded-event","attemptId":"attempt-1"}\n'
  );

  await assert.rejects(production.writer.finalize({ status: 'accepted' }), { code: 'ARTIFACT_EVIDENCE_CHANGED' });
  await assert.rejects(production.artifactFsPort.readText(path.join(result.takeDirectory, 'decision.json')), { code: 'ENOENT' });
  assert.equal((await production.writer.readStatus()).status, 'completed');
});

test('acceptance CAS rejects Survival evidence created after its absence was observed', async (t) => {
  const production = await createIntegrationRig(t, { firstAttemptFails: true });
  await production.run();
  await production.injectLateEvent({ attemptId: 'attempt-1', cueId: 'rival_reveal' });
  const result = await production.finishAttemptTwo();
  production.artifactFsPort.appendBeforeNextDecisionCommit(
    path.join(result.takeDirectory, 'planner-decisions.ndjson'),
    '{"goalId":"racing-survival-goal"}\n'
  );

  await assert.rejects(production.writer.finalize({ status: 'accepted' }), {
    code: 'ARTIFACT_EVIDENCE_CHANGED'
  });
  await assert.rejects(production.artifactFsPort.readText(path.join(result.takeDirectory, 'decision.json')), {
    code: 'ENOENT'
  });
  assert.equal((await production.writer.readStatus()).status, 'completed');
});

test('validates the complete CLI surface and requires rooted capture proof before acceptance', async (t) => {
  const production = await createIntegrationRig(t, { firstAttemptFails: true });
  await production.run();
  await production.injectLateEvent({ attemptId: 'attempt-1', cueId: 'rival_reveal' });
  await production.finishAttemptTwo();

  await assert.rejects(runCliCommand(['run', 'episode.yaml']), { code: 'APPROVED_BANK_REQUIRED' });
  await assert.rejects(runCliCommand(['run', '--bank', 'bank.json']), { code: 'EPISODE_PATH_REQUIRED' });
  await assert.rejects(runCliCommand(['recording-ready', '--take', 'take-a']), { code: 'RECORDING_PATH_REQUIRED' });
  await assert.rejects(runCliCommand(['not-a-command']), { code: 'UNKNOWN_CLI_COMMAND' });
  await assert.rejects(
    runCliCommand(['accept', '--take', 'take-a'], { productionHost: production.productionHost }),
    { code: 'ROOTED_OPEN_REQUIRED' }
  );

  const accepted = await runCliCommand(['accept', '--take', 'take-a'], {
    productionHost: production.productionHost,
    recordingHost: production.rootedRecordingHost,
    stdout: () => {}
  });
  assert.deepEqual(accepted, { status: 'accepted' });
  await assert.rejects(runCliCommand(['reject', '--take', 'take-a'], {
    productionHost: production.productionHost,
    recordingHost: production.rootedRecordingHost
  }), { code: 'TAKE_NOT_COMPLETED' });
});

test('routes rehearsal, run, and capture acknowledgements without exposing the approval key', async (t) => {
  const directory = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'showrunner-cli-'));
  const bankPath = path.join(directory, 'approved.json');
  t.after(() => nodeFs.rm(directory, { recursive: true, force: true }));

  const approvalKeys = generateKeyPairSync('ed25519');
  const approvalPrivateKey = approvalKeys.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const approvalPublicKey = approvalKeys.publicKey.export({ type: 'spki', format: 'pem' });
  const priorApprovalPublicKey = process.env.SHOWRUNNER_APPROVAL_PUBLIC_KEY;
  process.env.SHOWRUNNER_APPROVAL_PUBLIC_KEY = approvalPublicKey;
  t.after(() => {
    if (priorApprovalPublicKey === undefined) delete process.env.SHOWRUNNER_APPROVAL_PUBLIC_KEY;
    else process.env.SHOWRUNNER_APPROVAL_PUBLIC_KEY = priorApprovalPublicKey;
  });

  const episode = await loadEpisode('production/episodes/stolen-map.yaml');
  const episodeHash = sourceEpisodeHash(episode);
  const unsignedBank = {
    schemaVersion: 2,
    creator: 'test-creator',
    sourceEpisodeHash: episodeHash,
    provenance: {
      provider: 'fake-rehearsal', model: 'fake-model', promptTemplateVersion: 'v1', promptHash: 'a'.repeat(64),
      tokens: { input: 10, output: 5 }, latencyMs: 1, sourceEpisodeHash: episodeHash
    },
    variants: episode.scene.cues.map((cue, index) => ({
      id: `approved-${index + 1}`,
      cueId: cue.id,
      speaker: cue.speaker,
      text: cue.fallbackLine,
      hardValidation: { ok: true, violations: [] },
      softScores: {},
      decision: {
        candidateId: `candidate-${index + 1}`, approved: true, variantId: `approved-${index + 1}`, creator: 'test-creator'
      }
    })),
    fallbacks: episode.scene.cues.map((cue, index) => ({
      id: `fallback-${index + 1}`,
      cueId: cue.id,
      speaker: cue.speaker,
      text: cue.fallbackLine,
      hardValidation: { ok: true, violations: [] },
      decision: {
        approved: true, kind: 'authored-fallback', lineId: `fallback-${index + 1}`, creator: 'test-creator'
      }
    }))
  };
  const signature = signApprovedBank(unsignedBank, approvalPrivateKey);
  assert.equal(signature.ok, true);
  await nodeFs.writeFile(bankPath, JSON.stringify(signature.bank));

  const calls = [];
  const productionHost = {
    async rehearse(input) { calls.push({ kind: 'rehearse', input }); return { candidates: [] }; },
    async run(input) { calls.push({ kind: 'run', input }); return { takeId: 'take-from-host' }; },
    async recordingReady(input) { calls.push({ kind: 'recording-ready', input }); return { acknowledged: true }; },
    async recordingStopped(input) { calls.push({ kind: 'recording-stopped', input }); return { acknowledged: true }; }
  };
  const output = [];
  const dependencies = { productionHost, stdout: (line) => output.push(line) };
  await runCliCommand(['rehearse', 'production/episodes/stolen-map.yaml'], dependencies);
  await runCliCommand(['run', 'production/episodes/stolen-map.yaml', '--bank', bankPath], dependencies);
  await runCliCommand(['recording-ready', '--take', 'take-from-host', '--path', '/recordings/take-from-host.mkv'], dependencies);
  await runCliCommand(['recording-stopped', '--take', 'take-from-host', '--path', '/recordings/take-from-host.mkv'], dependencies);

  assert.deepEqual(calls.map((call) => call.kind), ['rehearse', 'run', 'recording-ready', 'recording-stopped']);
  assert.equal(JSON.stringify(calls).includes(approvalPrivateKey), false);
  assert.equal(output.join('\n').includes(approvalPrivateKey), false);
  assert.match(output.join('\n'), /Take ID: take-from-host/);
});

test('importing the CLI has no connection, timer, output, or process-exit side effect', async () => {
  const run = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', "await import('./src/showrunner/cli.mjs')"], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });

  assert.deepEqual(run, { code: 0, stdout: '', stderr: '' });
});

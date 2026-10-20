import assert from 'node:assert/strict';
import test from 'node:test';

import { createCaptureSession } from '../src/showrunner/capture.mjs';

const RECORDING_ROOT = '/recordings';
const RECORDING_PATH = `${RECORDING_ROOT}/take-1.mkv`;

function clockAt(initial = 0) {
  let timestamp = initial;
  return {
    now: () => timestamp,
    set: (next) => { timestamp = next; }
  };
}

function sidecar(overrides = {}) {
  return JSON.stringify({
    takeId: 'take-1',
    path: RECORDING_PATH,
    readyMonotonicTimestamp: 100,
    startMonotonicTimestamp: 3100,
    stopMonotonicTimestamp: 9000,
    ...overrides
  });
}

function fakeFs({
  size = 4096,
  start = 100,
  end = 9000,
  sidecarContents = sidecar(),
  artifactRealPath = RECORDING_PATH,
  sidecarRealPath = `${RECORDING_PATH}.showrunner.json`,
  artifactSymbolicLink = false,
  sidecarSymbolicLink = false,
  replaceArtifactOnOpen = false,
  replaceSidecarOnOpen = false,
  missingArtifact = false,
  rootedArtifactPath = artifactRealPath,
  rootedSidecarPath = sidecarRealPath,
  rootedArtifactIdentity = { dev: 1, ino: 10 },
  rootedSidecarIdentity = { dev: 1, ino: 12 },
  artifactCanonicalRoot = RECORDING_ROOT,
  sidecarCanonicalRoot = RECORDING_ROOT,
  artifactRootIdentity = { dev: 1, ino: 1 },
  sidecarRootIdentity = { dev: 1, ino: 1 },
  failLegacyPathnameAccess = false
} = {}) {
  const sidecarPath = `${RECORDING_PATH}.showrunner.json`;
  const artifact = {
    dev: 1,
    ino: 10,
    size,
    startMonotonicTimestamp: start,
    endMonotonicTimestamp: end,
    isFile: () => true,
    isSymbolicLink: () => artifactSymbolicLink
  };
  const replacedArtifact = { ...artifact, ino: 11 };
  const sidecarStat = {
    dev: 1,
    ino: 12,
    size: Buffer.byteLength(sidecarContents),
    isFile: () => true,
    isSymbolicLink: () => sidecarSymbolicLink
  };
  const replacedSidecar = { ...sidecarStat, ino: 13 };
  const records = new Map([
    [RECORDING_PATH, artifact],
    [sidecarPath, sidecarStat]
  ]);

  function recordFor(filePath) {
    const record = records.get(filePath);
    if (!record || (filePath === RECORDING_PATH && missingArtifact)) {
      const error = new Error('ENOENT');
      error.code = 'ENOENT';
      throw error;
    }
    return record;
  }

  return {
    async realpath(filePath) {
      if (failLegacyPathnameAccess) throw new Error('PATHNAME_ACCESS_FORBIDDEN');
      if (filePath === RECORDING_ROOT) return RECORDING_ROOT;
      recordFor(filePath);
      if (filePath === RECORDING_PATH) return artifactRealPath;
      if (filePath === sidecarPath) return sidecarRealPath;
      return filePath;
    },
    async lstat(filePath) {
      if (failLegacyPathnameAccess) throw new Error('PATHNAME_ACCESS_FORBIDDEN');
      return recordFor(filePath);
    },
    async open(filePath) {
      if (failLegacyPathnameAccess) throw new Error('PATHNAME_ACCESS_FORBIDDEN');
      const record = recordFor(filePath);
      const opened = filePath === RECORDING_PATH && replaceArtifactOnOpen
        ? replacedArtifact
        : filePath === sidecarPath && replaceSidecarOnOpen
          ? replacedSidecar
          : record;
      return {
        async stat() { return opened; },
        async readFile() {
          if (filePath === sidecarPath) return Buffer.from(sidecarContents);
          return Buffer.alloc(0);
        },
        async close() {}
      };
    },
    async openBeneath({ rootPath, relativePath, flags }) {
      assert.equal(rootPath, RECORDING_ROOT);
      assert.deepEqual(flags, { readOnly: true, noFollow: true });
      const filePath = pathFromRelative(relativePath);
      const record = recordFor(filePath);
      const isArtifact = filePath === RECORDING_PATH;
      if (isArtifact ? artifactSymbolicLink : sidecarSymbolicLink) {
        const error = new Error('ELOOP');
        error.code = 'ELOOP';
        throw error;
      }
      const canonicalPath = isArtifact ? rootedArtifactPath : rootedSidecarPath;
      const identity = isArtifact ? rootedArtifactIdentity : rootedSidecarIdentity;
      return {
        canonicalRootPath: isArtifact ? artifactCanonicalRoot : sidecarCanonicalRoot,
        canonicalPath,
        rootIdentity: isArtifact ? artifactRootIdentity : sidecarRootIdentity,
        identity,
        handle: {
          async stat() { return record; },
          async readFile() {
            if (filePath === sidecarPath) return Buffer.from(sidecarContents);
            return Buffer.alloc(0);
          },
          async close() {}
        }
      };
    }
  };
}

function pathFromRelative(relativePath) {
  if (relativePath === 'take-1.mkv') return RECORDING_PATH;
  if (relativePath === 'take-1.mkv.showrunner.json') return `${RECORDING_PATH}.showrunner.json`;
  throw new Error(`unexpected relative path: ${relativePath}`);
}

function configuredCapture(options = {}) {
  const clock = clockAt();
  const capture = createCaptureSession({ takeId: 'take-1', expectedPath: RECORDING_PATH, clock, preRollMs: 3000, ...options });
  return { capture, clock };
}

function completeHandshake(capture, clock) {
  capture.acknowledgeReady({ takeId: 'take-1', path: RECORDING_PATH, monotonicTimestamp: 100 });
  clock.set(3100);
  capture.markTakeStarted();
  capture.requestStop();
  capture.acknowledgeStopped({ takeId: 'take-1', path: RECORDING_PATH, monotonicTimestamp: 9000 });
}

test.beforeEach(() => {
  process.env.SHOWRUNNER_RECORDING_DIR = RECORDING_ROOT;
});

test.afterEach(() => {
  delete process.env.SHOWRUNNER_RECORDING_DIR;
});

test('requires matching readiness before take start and verifies complete recording coverage', async () => {
  const { capture, clock } = configuredCapture();
  completeHandshake(capture, clock);

  assert.deepEqual(
    await capture.verifyArtifact(fakeFs({ failLegacyPathnameAccess: true })),
    { ok: true, path: RECORDING_PATH }
  );
});

test('binds rooted proof to the configured root, exact requested paths, and one stable root identity', async () => {
  const { capture, clock } = configuredCapture();
  completeHandshake(capture, clock);

  assert.deepEqual(await capture.verifyArtifact(fakeFs({
    artifactCanonicalRoot: '/elsewhere', sidecarCanonicalRoot: '/elsewhere',
    rootedArtifactPath: '/elsewhere/take-1.mkv',
    rootedSidecarPath: '/elsewhere/take-1.mkv.showrunner.json',
    sidecarContents: sidecar({ path: '/elsewhere/take-1.mkv' })
  })), { ok: false, reason: 'ARTIFACT_ROOT_MISMATCH' });

  assert.deepEqual(await capture.verifyArtifact(fakeFs({
    rootedArtifactPath: '/recordings/other.mkv',
    sidecarContents: sidecar({ path: '/recordings/other.mkv' })
  })), { ok: false, reason: 'ARTIFACT_PATH_MISMATCH' });

  assert.deepEqual(await capture.verifyArtifact(fakeFs({
    sidecarRootIdentity: { dev: 1, ino: 2 }
  })), { ok: false, reason: 'SIDECAR_ROOT_IDENTITY_MISMATCH' });
});

test('rejects wrong take or path readiness without recording mutable handshake input', () => {
  const { capture, clock } = configuredCapture();
  assert.throws(
    () => capture.acknowledgeReady({ takeId: 'take-2', path: RECORDING_PATH, monotonicTimestamp: 100 }),
    { code: 'WRONG_TAKE' }
  );
  assert.throws(
    () => capture.acknowledgeReady({ takeId: 'take-1', path: `${RECORDING_ROOT}/take-2.mkv`, monotonicTimestamp: 100 }),
    { code: 'WRONG_RECORDING_PATH' }
  );

  const input = { takeId: 'take-1', path: RECORDING_PATH, monotonicTimestamp: 100 };
  const acknowledgement = capture.acknowledgeReady(input);
  input.path = '/outside/attacker.mkv';
  input.monotonicTimestamp = 0;
  assert.equal(Object.isFrozen(acknowledgement), true);
  clock.set(3000);
  assert.throws(() => capture.markTakeStarted(), { code: 'PRE_ROLL_INCOMPLETE' });
  clock.set(3100);
  capture.markTakeStarted();
});

test('requires the configured pre-roll and immutable monotonic stop acknowledgement', () => {
  const { capture, clock } = configuredCapture();
  capture.acknowledgeReady({ takeId: 'take-1', path: RECORDING_PATH, monotonicTimestamp: 100 });
  clock.set(3099);
  assert.throws(() => capture.markTakeStarted(), { code: 'PRE_ROLL_INCOMPLETE' });
  clock.set(3100);
  capture.markTakeStarted();
  capture.requestStop();
  assert.throws(
    () => capture.acknowledgeStopped({ takeId: 'take-1', path: `${RECORDING_ROOT}/different.mkv`, monotonicTimestamp: 9000 }),
    { code: 'WRONG_RECORDING_PATH' }
  );
  assert.throws(
    () => capture.acknowledgeStopped({ takeId: 'take-1', path: RECORDING_PATH, monotonicTimestamp: 3099 }),
    { code: 'NON_MONOTONIC_STOP' }
  );
  const stopped = capture.acknowledgeStopped({ takeId: 'take-1', path: RECORDING_PATH, monotonicTimestamp: 9000 });
  assert.equal(Object.isFrozen(stopped), true);
  assert.throws(() => capture.acknowledgeStopped({ takeId: 'take-1', monotonicTimestamp: 9001 }), { code: 'STOP_ALREADY_ACKNOWLEDGED' });
});

test('fails closed for missing readiness or stop acknowledgement', async () => {
  const { capture, clock } = configuredCapture();
  assert.deepEqual(await capture.verifyArtifact(fakeFs()), { ok: false, reason: 'READY_NOT_ACKNOWLEDGED' });
  capture.acknowledgeReady({ takeId: 'take-1', path: RECORDING_PATH, monotonicTimestamp: 100 });
  clock.set(3100);
  capture.markTakeStarted();
  capture.requestStop();
  assert.deepEqual(await capture.verifyArtifact(fakeFs()), { ok: false, reason: 'STOP_NOT_ACKNOWLEDGED' });
});

test('rejects an unsafe configured path before filesystem access', () => {
  assert.throws(
    () => createCaptureSession({ takeId: 'take-1', expectedPath: '/recordings-other/take-1.mkv', clock: clockAt(), preRollMs: 0 }),
    { code: 'RECORDING_PATH_OUTSIDE_ROOT' }
  );
  assert.throws(
    () => createCaptureSession({ takeId: 'take-1', expectedPath: '/recordings/../outside/take-1.mkv', clock: clockAt(), preRollMs: 0 }),
    { code: 'RECORDING_PATH_OUTSIDE_ROOT' }
  );
});

test('rejects a zero-byte or missing artifact', async () => {
  const { capture, clock } = configuredCapture();
  completeHandshake(capture, clock);
  assert.deepEqual(await capture.verifyArtifact(fakeFs({ size: 0 })), { ok: false, reason: 'ARTIFACT_EMPTY' });
  assert.deepEqual(await capture.verifyArtifact(fakeFs({ missingArtifact: true })), { ok: false, reason: 'ARTIFACT_MISSING' });
});

test('requires the sidecar to attest to the same immutable handshake', async () => {
  const { capture, clock } = configuredCapture();
  completeHandshake(capture, clock);
  assert.deepEqual(
    await capture.verifyArtifact(fakeFs({ sidecarContents: sidecar({ takeId: 'take-2' }) })),
    { ok: false, reason: 'SIDECAR_MISMATCH' }
  );
  assert.deepEqual(
    await capture.verifyArtifact(fakeFs({ sidecarContents: sidecar({ stopMonotonicTimestamp: 9001 }) })),
    { ok: false, reason: 'SIDECAR_MISMATCH' }
  );
});

test('rejects recordings which do not cover the complete acknowledged take', async () => {
  const { capture, clock } = configuredCapture();
  completeHandshake(capture, clock);
  assert.deepEqual(
    await capture.verifyArtifact(fakeFs({ start: 101 })),
    { ok: false, reason: 'ARTIFACT_START_AFTER_READY' }
  );
  assert.deepEqual(
    await capture.verifyArtifact(fakeFs({ end: 8999 })),
    { ok: false, reason: 'ARTIFACT_END_BEFORE_STOP' }
  );
});

test('requires a rooted no-follow open capability instead of pathname verification', async () => {
  const { capture, clock } = configuredCapture();
  completeHandshake(capture, clock);
  const unsafePort = fakeFs();
  delete unsafePort.openBeneath;

  assert.deepEqual(
    await capture.verifyArtifact(unsafePort),
    { ok: false, reason: 'ROOTED_OPEN_REQUIRED' }
  );
});

test('rejects an external descriptor proof after an ancestor-directory swap', async () => {
  const { capture, clock } = configuredCapture();
  completeHandshake(capture, clock);

  assert.deepEqual(
    await capture.verifyArtifact(fakeFs({ rootedArtifactPath: '/outside/take-1.mkv' })),
    { ok: false, reason: 'ARTIFACT_PATH_MISMATCH' }
  );
});

test('rejects symlink and unproven rooted-open results after future artifact paths become real', async () => {
  const { capture, clock } = configuredCapture();
  completeHandshake(capture, clock);
  assert.deepEqual(
    await capture.verifyArtifact(fakeFs({ artifactRealPath: '/outside/take-1.mkv' })),
    { ok: false, reason: 'ARTIFACT_PATH_MISMATCH' }
  );
  assert.deepEqual(
    await capture.verifyArtifact(fakeFs({ artifactSymbolicLink: true })),
    { ok: false, reason: 'ARTIFACT_SYMLINK' }
  );
  assert.deepEqual(
    await capture.verifyArtifact(fakeFs({ rootedArtifactIdentity: { dev: 1, ino: 11 } })),
    { ok: false, reason: 'ARTIFACT_ROOTED_OPEN_UNPROVEN' }
  );
  assert.deepEqual(
    await capture.verifyArtifact(fakeFs({ sidecarRealPath: '/outside/take-1.mkv.showrunner.json' })),
    { ok: false, reason: 'SIDECAR_PATH_MISMATCH' }
  );
  assert.deepEqual(
    await capture.verifyArtifact(fakeFs({ sidecarSymbolicLink: true })),
    { ok: false, reason: 'SIDECAR_SYMLINK' }
  );
  assert.deepEqual(
    await capture.verifyArtifact(fakeFs({ rootedSidecarIdentity: { dev: 1, ino: 13 } })),
    { ok: false, reason: 'SIDECAR_ROOTED_OPEN_UNPROVEN' }
  );
});
